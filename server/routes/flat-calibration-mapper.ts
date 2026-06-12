/**
 * Admin API for the Flat Calibration Mapper UI
 * (client/src/pages/flat-calibration-mapper.tsx).
 *
 *   GET  /api/admin/flat-calibrator/:productTypeId           → models, assets, geometry, manifest summary
 *   POST /api/admin/flat-calibrator/:productTypeId/harvest   → wipe + calibrator harvest (202 async)
 *   POST /api/admin/flat-calibrator/:productTypeId/wipe      → delete Supabase assets only
 *   PUT  /api/admin/flat-calibrator/:productTypeId/geometry  → save layer transforms + optional manifest publish
 */

import { type Express, type Request, type Response } from "express";
import {
  buildHarvestColorsFromProductType,
  calibratorGeometryPath,
  calibratorLayerPaths,
  defaultCalibratorModelEntry,
  harvestFlatCalibration,
  type CalibratorModelEntry,
  type FlatCalibratorGeometry,
  type ViewName,
} from "../flat-calibration";
import {
  downloadFlatCalibrationFile,
  publicFlatCalibrationUrl,
  uploadToFlatCalibrationBucket,
  deleteFlatCalibrationProductAssets,
} from "../supabaseFlatCalibration";

type StorageLike = {
  getProductType(id: number): Promise<any>;
  updateProductType(id: number, patch: Record<string, unknown>): Promise<any>;
  getMerchantByUserId(userId: string): Promise<any>;
};

function parseJsonRecord(raw: unknown): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      return p && typeof p === "object" && !Array.isArray(p) ? p : {};
    } catch {
      return {};
    }
  }
  return {};
}

function parseJsonArray(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseManifest(raw: unknown): Record<string, any> | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw as Record<string, any>;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function safeSlug(id: string): string {
  return id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function assetUrls(productTypeId: number, modelId: string, view: ViewName) {
  const safe = safeSlug(modelId);
  const paths = calibratorLayerPaths(productTypeId, safe, view);
  return {
    modelId,
    safe,
    view,
    pink: publicFlatCalibrationUrl(paths.pink),
    blank: publicFlatCalibrationUrl(paths.blank),
    mask: publicFlatCalibrationUrl(paths.mask),
    shading: publicFlatCalibrationUrl(paths.shading),
    paths,
  };
}

async function loadCalibratorGeometry(productTypeId: number): Promise<FlatCalibratorGeometry | null> {
  const buf = await downloadFlatCalibrationFile(calibratorGeometryPath(productTypeId));
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf-8")) as FlatCalibratorGeometry;
  } catch {
    return null;
  }
}

function phoneModelsFromProduct(productType: any): Array<{ id: string; name: string }> {
  const sizes = parseJsonArray(productType.sizes);
  const colors = buildHarvestColorsFromProductType({
    designerType: productType.designerType,
    frameColors: productType.frameColors,
    sizes: productType.sizes,
    variantMap: productType.variantMap,
  });
  if (colors.length > 0) {
    return colors.map((c) => ({ id: c.id, name: c.name || c.id }));
  }
  return sizes
    .filter((s: any) => s?.id)
    .map((s: any) => ({ id: String(s.id), name: String(s.name || s.id) }));
}

export function registerFlatCalibrationMapperRoutes(
  app: Express,
  deps: { storage: StorageLike; isAuthenticated: any },
) {
  const { storage, isAuthenticated } = deps;

  app.get("/api/admin/flat-calibrator/:productTypeId", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const productTypeId = parseInt(req.params.productTypeId, 10);
      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) return res.status(404).json({ error: "Merchant not found" });
      const productType = await storage.getProductType(productTypeId);
      if (!productType || productType.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Product type not found" });
      }

      const manifest = parseManifest(productType.flatCalibration);
      const geometry = (await loadCalibratorGeometry(productTypeId)) ?? manifest?.calibratorGeometry ?? null;
      const models = phoneModelsFromProduct(productType);
      const view: ViewName = "front";

      res.json({
        productTypeId,
        name: productType.name,
        flatCalibrationStatus: productType.flatCalibrationStatus,
        onTheFlyTier: productType.onTheFlyTier,
        edgeWrap: !!manifest?.edgeWrap,
        models: models.map((m) => ({
          modelId: m.id,
          name: m.name,
          assets: assetUrls(productTypeId, m.id, view),
          geometry: geometry?.models?.[m.id]?.[view] ?? defaultCalibratorModelEntry(),
        })),
        geometry,
        manifestSummary: manifest
          ? {
              tier: manifest.tier,
              edgeWrap: manifest.edgeWrap,
              representativeGeometry: manifest.representativeGeometry,
              blankKeys: Object.keys(manifest.blanks || {}),
            }
          : null,
      });
    } catch (e: any) {
      console.error("[flat-calibrator] GET failed:", e);
      res.status(500).json({ error: e?.message || "Failed to load calibrator state" });
    }
  });

  app.post("/api/admin/flat-calibrator/:productTypeId/wipe", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const productTypeId = parseInt(req.params.productTypeId, 10);
      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) return res.status(404).json({ error: "Merchant not found" });
      const productType = await storage.getProductType(productTypeId);
      if (!productType || productType.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Product type not found" });
      }
      const removed = await deleteFlatCalibrationProductAssets(productTypeId);
      await storage.updateProductType(productTypeId, {
        flatCalibrationStatus: "pending",
        flatCalibration: "{}",
      });
      res.json({ ok: true, removed });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Wipe failed" });
    }
  });

  app.post("/api/admin/flat-calibrator/:productTypeId/harvest", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const productTypeId = parseInt(req.params.productTypeId, 10);
      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) return res.status(404).json({ error: "Merchant not found" });
      const productType = await storage.getProductType(productTypeId);
      if (!productType || productType.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Product type not found" });
      }
      if (!merchant.printifyApiToken || !merchant.printifyShopId) {
        return res.status(400).json({ error: "Printify credentials not configured" });
      }
      if (!productType.printifyBlueprintId || !productType.printifyProviderId) {
        return res.status(400).json({ error: "Product missing Printify blueprint/provider" });
      }

      res.status(202).json({ status: "running", productTypeId });

      void (async () => {
        try {
          await storage.updateProductType(productTypeId, { flatCalibrationStatus: "running" });
          const colors = buildHarvestColorsFromProductType({
            designerType: productType.designerType,
            frameColors: productType.frameColors,
            sizes: productType.sizes,
            variantMap: productType.variantMap,
          });
          const result = await harvestFlatCalibration({
            productTypeId,
            name: productType.name,
            blueprintId: productType.printifyBlueprintId,
            providerId: productType.printifyProviderId,
            token: merchant.printifyApiToken,
            shopId: merchant.printifyShopId,
            designerType: productType.designerType,
            sizes: productType.sizes,
            colors: colors.length > 0 ? colors : undefined,
            calibratorMode: true,
            wipeExisting: true,
          });
          await storage.updateProductType(productTypeId, {
            onTheFlyTier: result.tier,
            flatCalibrationStatus: result.status,
            flatCalibration: JSON.stringify(result.manifest),
          });
          console.log(
            `[flat-calibrator] harvest pt ${productTypeId} -> ${result.status}${result.calibratorGeometryUrl ? " geometry uploaded" : ""}`,
          );
        } catch (err) {
          console.error(`[flat-calibrator] harvest failed pt ${productTypeId}:`, err);
          await storage.updateProductType(productTypeId, { flatCalibrationStatus: "failed" }).catch(() => {});
        }
      })();
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Harvest start failed" });
    }
  });

  app.put("/api/admin/flat-calibrator/:productTypeId/geometry", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const productTypeId = parseInt(req.params.productTypeId, 10);
      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) return res.status(404).json({ error: "Merchant not found" });
      const productType = await storage.getProductType(productTypeId);
      if (!productType || productType.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Product type not found" });
      }

      const modelId = String(req.body?.modelId || "");
      const view = (req.body?.view === "back" ? "back" : "front") as ViewName;
      const entry = req.body?.geometry as CalibratorModelEntry | undefined;
      if (!modelId || !entry) {
        return res.status(400).json({ error: "modelId and geometry required" });
      }

      const existing =
        (await loadCalibratorGeometry(productTypeId)) ??
        ({
          productTypeId,
          models: {},
          updatedAt: new Date().toISOString(),
        } as FlatCalibratorGeometry);

      if (!existing.models[modelId]) existing.models[modelId] = {};
      existing.models[modelId]![view] = entry;
      existing.updatedAt = new Date().toISOString();

      const geometryUrl = await uploadToFlatCalibrationBucket(
        calibratorGeometryPath(productTypeId),
        Buffer.from(JSON.stringify(existing, null, 2), "utf-8"),
        "application/json",
      );

      let manifest = parseManifest(productType.flatCalibration) || {};
      manifest.calibratorGeometry = existing;

      if (req.body?.publishToManifest !== false) {
        if (!manifest.geometryByBlank) manifest.geometryByBlank = {};
        if (!manifest.geometryByBlank[modelId]) manifest.geometryByBlank[modelId] = {};
        const baseView = manifest.geometryByBlank[modelId][view] || manifest.views?.[view] || {};
        const adj = entry.blank;
        const phoneBack = baseView.phoneBackNormalized || { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
        manifest.geometryByBlank[modelId][view] = {
          ...baseView,
          phoneBackNormalized: {
            x: +(phoneBack.x + (adj.offsetX || 0)).toFixed(5),
            y: +(phoneBack.y + (adj.offsetY || 0)).toFixed(5),
            width: +(phoneBack.width * (adj.scale || 1)).toFixed(5),
            height: +(phoneBack.height * (adj.scale || 1)).toFixed(5),
          },
          sideProfileSourceCropNormalized: entry.sourceCrop ?? baseView.sideProfileSourceCropNormalized,
        };
        manifest.representativeGeometry = false;
        manifest.edgeWrap = true;
      }

      await storage.updateProductType(productTypeId, {
        flatCalibration: JSON.stringify(manifest),
      });

      res.json({ ok: true, geometryUrl, geometry: existing });
    } catch (e: any) {
      console.error("[flat-calibrator] save geometry failed:", e);
      res.status(500).json({ error: e?.message || "Save failed" });
    }
  });
}
