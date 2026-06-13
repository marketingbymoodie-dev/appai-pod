/**
 * Platform-operator API: canonical product library harvest, publish, and calibrator.
 * Gated by OWNER_SHOP_DOMAIN / PLATFORM_ADMIN_SHOP_DOMAINS (dev: always allowed).
 */

import { type Express, type Response } from "express";
import {
  canonicalStorageKey,
  getCanonicalEntry,
  getCanonicalRegistry,
} from "@shared/canonicalProducts";
import {
  getCanonicalPublishState,
  loadCanonicalManifest,
  publishCanonicalManifest,
} from "../canonicalFlatCalibration";
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
import { isPlatformAdminRequest, requirePlatformAdmin } from "../platformAdmin";
import {
  deleteFlatCalibrationAssetsByPrefix,
  downloadFlatCalibrationFile,
  publicFlatCalibrationUrl,
  uploadToFlatCalibrationBucket,
} from "../supabaseFlatCalibration";

type StorageLike = {
  getProductTypesByMerchant(merchantId: string): Promise<any[]>;
  getMerchantByUserId(userId: string): Promise<any>;
  getMerchantByShop(shop: string): Promise<any>;
};

const DEFAULT_CANONICAL_VERSION = 1;

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

async function loadGeometryJson(path: string): Promise<FlatCalibratorGeometry | null> {
  const buf = await downloadFlatCalibrationFile(path);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf-8")) as FlatCalibratorGeometry;
  } catch {
    return null;
  }
}

function mergeViewCalibration(
  manifest: Record<string, any> | null,
  modelId: string,
  view: ViewName,
): Record<string, any> | null {
  if (!manifest) return null;
  const base = manifest?.views?.[view];
  if (!base) return null;
  const override = manifest?.geometryByBlank?.[modelId]?.[view];
  if (!override) return { ...base };
  return {
    ...base,
    ...override,
    visibleRectNormalized: override.visibleRectNormalized ?? base.visibleRectNormalized,
    printBoundsNormalized: override.printBoundsNormalized ?? base.printBoundsNormalized,
    backFaceCropNormalized: override.backFaceCropNormalized ?? base.backFaceCropNormalized,
    phoneBackNormalized: override.phoneBackNormalized ?? base.phoneBackNormalized,
    safeZoneNormalized: override.safeZoneNormalized ?? base.safeZoneNormalized,
    sideProfileCropped: override.sideProfileCropped ?? base.sideProfileCropped,
    sideProfileSourceCropNormalized:
      override.sideProfileSourceCropNormalized ?? base.sideProfileSourceCropNormalized,
    mockupDims: override.mockupDims ?? base.mockupDims,
    printFileDims: override.printFileDims ?? base.printFileDims,
    maskUrl: override.maskUrl ?? base.maskUrl,
    shadingUrl: override.shadingUrl ?? base.shadingUrl,
    shadingMode: override.shadingMode ?? base.shadingMode,
    meshNodes: base.meshNodes,
    meshGrid: base.meshGrid,
    planarityScore: base.planarityScore,
    coverage: base.coverage,
  };
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

function assetUrlsForStorage(storageKey: string, modelId: string, view: ViewName) {
  const safe = modelId.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const paths = calibratorLayerPaths(storageKey, safe, view);
  return {
    pink: publicFlatCalibrationUrl(paths.pink),
    blank: publicFlatCalibrationUrl(paths.blank),
    mask: publicFlatCalibrationUrl(paths.mask),
    shading: publicFlatCalibrationUrl(paths.shading),
  };
}

async function resolvePlatformPrintifyCreds(
  storage: StorageLike,
  req: any,
): Promise<{ token: string; shopId: string; merchant: any } | null> {
  const userId = req.user?.claims?.sub;
  let merchant = userId ? await storage.getMerchantByUserId(userId) : null;
  const ownerShop = process.env.OWNER_SHOP_DOMAIN?.trim();
  if (ownerShop) {
    const ownerMerchant = await storage.getMerchantByShop(ownerShop);
    if (ownerMerchant?.printifyApiToken && ownerMerchant?.printifyShopId) {
      merchant = ownerMerchant;
    }
  }
  const token = merchant?.printifyApiToken || process.env.PRINTIFY_API_TOKEN || "";
  const shopId = merchant?.printifyShopId || process.env.PRINTIFY_SHOP_ID || "";
  if (!token || !shopId || !merchant) return null;
  return { token, shopId, merchant };
}

async function findReferenceProduct(
  storage: StorageLike,
  merchantId: string,
  blueprintId: number,
): Promise<any | null> {
  const types = await storage.getProductTypesByMerchant(merchantId);
  return types.find((pt) => Number(pt.printifyBlueprintId) === blueprintId) ?? null;
}

export function registerPlatformCalibrationRoutes(
  app: Express,
  deps: { storage: StorageLike; isAuthenticated: any },
) {
  const { storage, isAuthenticated } = deps;

  app.get("/api/platform/admin/status", isAuthenticated, (req: any, res: Response) => {
    res.json({ isPlatformAdmin: isPlatformAdminRequest(req) });
  });

  app.get("/api/admin/catalog/allowed-blueprints", isAuthenticated, async (_req: any, res: Response) => {
    const entries = getCanonicalRegistry();
    const blueprints = await Promise.all(
      entries.map(async (e) => ({
        ...e,
        publish: await getCanonicalPublishState(e.blueprintId),
      })),
    );
    res.json({ blueprints });
  });

  app.get("/api/platform/canonical/products", isAuthenticated, async (req: any, res: Response) => {
    if (!requirePlatformAdmin(req, res)) return;
    const entries = getCanonicalRegistry();
    const products = await Promise.all(
      entries.map(async (e) => ({
        ...e,
        publish: await getCanonicalPublishState(e.blueprintId),
      })),
    );
    res.json({ products });
  });

  app.get("/api/platform/flat-calibrator/:blueprintId", isAuthenticated, async (req: any, res: Response) => {
    if (!requirePlatformAdmin(req, res)) return;
    try {
      const blueprintId = parseInt(req.params.blueprintId, 10);
      const version = parseInt(String(req.query.version || DEFAULT_CANONICAL_VERSION), 10);
      const entry = getCanonicalEntry(blueprintId);
      if (!entry || entry.kind !== "flat") {
        return res.status(404).json({ error: "Blueprint not in flat canonical registry" });
      }

      const storageKey = canonicalStorageKey(blueprintId, version);
      const manifest = await loadCanonicalManifest(blueprintId, version);
      const geometry =
        (await loadGeometryJson(calibratorGeometryPath(storageKey))) ??
        manifest?.calibratorGeometry ??
        null;

      const creds = await resolvePlatformPrintifyCreds(storage, req);
      let models: Array<{ id: string; name: string }> = [];
      if (creds) {
        const ref = await findReferenceProduct(storage, creds.merchant.id, blueprintId);
        if (ref) models = phoneModelsFromProduct(ref);
      }
      if (models.length === 0 && manifest?.blanks) {
        models = Object.keys(manifest.blanks).map((id) => ({ id, name: id }));
      }

      const view: ViewName = "front";
      res.json({
        blueprintId,
        version,
        storageKey,
        name: entry.label,
        edgeWrap: !!manifest?.edgeWrap,
        models: models.map((m) => ({
          ...m,
          assets: assetUrlsForStorage(storageKey, m.id, view),
          geometry: geometry?.models?.[m.id]?.[view] ?? defaultCalibratorModelEntry(),
          baseView: mergeViewCalibration(manifest as any, m.id, view),
        })),
      });
    } catch (e) {
      console.error("[platform-calibrator] GET failed:", e);
      res.status(500).json({ error: "Failed to load calibrator state" });
    }
  });

  app.post("/api/platform/canonical/:blueprintId/harvest", isAuthenticated, async (req: any, res: Response) => {
    if (!requirePlatformAdmin(req, res)) return;
    try {
      const blueprintId = parseInt(req.params.blueprintId, 10);
      const version = parseInt(String(req.body?.version || DEFAULT_CANONICAL_VERSION), 10);
      const entry = getCanonicalEntry(blueprintId);
      if (!entry || entry.kind !== "flat") {
        return res.status(404).json({ error: "Blueprint not in flat canonical registry" });
      }

      const creds = await resolvePlatformPrintifyCreds(storage, req);
      if (!creds) {
        return res.status(400).json({ error: "Platform Printify credentials not configured" });
      }

      const ref = await findReferenceProduct(storage, creds.merchant.id, blueprintId);
      if (!ref?.printifyProviderId) {
        return res.status(400).json({
          error:
            "Import this blueprint on your operator shop first (reference product needed for variant map)",
        });
      }

      res.status(202).json({ status: "running", blueprintId, version });

      void (async () => {
        try {
          const colors = buildHarvestColorsFromProductType({
            designerType: ref.designerType,
            frameColors: ref.frameColors,
            sizes: ref.sizes,
            variantMap: ref.variantMap,
          });
          const storageKey = canonicalStorageKey(blueprintId, version);
          const result = await harvestFlatCalibration({
            productTypeId: 0,
            name: entry.label,
            blueprintId,
            providerId: ref.printifyProviderId,
            token: creds.token,
            shopId: creds.shopId,
            designerType: ref.designerType,
            sizes: ref.sizes,
            colors: colors.length > 0 ? colors : undefined,
            calibratorMode: true,
            wipeExisting: true,
            storageKey,
          });
          if (result.manifest) {
            await uploadToFlatCalibrationBucket(
              `${storageKey}/manifest.json`,
              Buffer.from(JSON.stringify({ ...result.manifest, canonicalVersion: version }, null, 2), "utf-8"),
              "application/json",
            );
          }
          console.log(
            `[platform-canonical] harvest bp ${blueprintId} v${version} -> ${result.status} tier=${result.tier}`,
          );
        } catch (err) {
          console.error(`[platform-canonical] harvest failed bp ${blueprintId}:`, err);
        }
      })();
    } catch (e) {
      console.error("[platform-canonical] harvest start failed:", e);
      res.status(500).json({ error: "Failed to start harvest" });
    }
  });

  app.post("/api/platform/canonical/:blueprintId/publish", isAuthenticated, async (req: any, res: Response) => {
    if (!requirePlatformAdmin(req, res)) return;
    try {
      const blueprintId = parseInt(req.params.blueprintId, 10);
      const version = parseInt(String(req.body?.version || DEFAULT_CANONICAL_VERSION), 10);
      const entry = getCanonicalEntry(blueprintId);
      if (!entry || entry.kind !== "flat") {
        return res.status(404).json({ error: "Blueprint not in flat canonical registry" });
      }

      const manifest = await loadCanonicalManifest(blueprintId, version);
      if (!manifest || !manifest.views || Object.keys(manifest.views).length === 0) {
        return res.status(400).json({ error: "No harvested manifest found — run harvest first" });
      }

      const meta = await publishCanonicalManifest({
        blueprintId,
        version,
        manifest,
        tier: manifest.tier,
        label: entry.label,
      });

      res.json({ ok: true, published: meta });
    } catch (e: any) {
      console.error("[platform-canonical] publish failed:", e);
      res.status(500).json({ error: e?.message || "Publish failed" });
    }
  });

  app.put("/api/platform/flat-calibrator/:blueprintId/geometry", isAuthenticated, async (req: any, res: Response) => {
    if (!requirePlatformAdmin(req, res)) return;
    try {
      const blueprintId = parseInt(req.params.blueprintId, 10);
      const version = parseInt(String(req.body?.version || DEFAULT_CANONICAL_VERSION), 10);
      const { modelId, geometry, publishToManifest } = req.body ?? {};
      if (!modelId || !geometry) {
        return res.status(400).json({ error: "modelId and geometry required" });
      }

      const storageKey = canonicalStorageKey(blueprintId, version);
      const existing =
        (await loadGeometryJson(calibratorGeometryPath(storageKey))) ??
        ({ productTypeId: 0, models: {}, updatedAt: new Date().toISOString() } as FlatCalibratorGeometry);

      const view: ViewName = "front";
      if (!existing.models[modelId]) existing.models[modelId] = {};
      existing.models[modelId]![view] = geometry as CalibratorModelEntry;
      existing.updatedAt = new Date().toISOString();

      await uploadToFlatCalibrationBucket(
        calibratorGeometryPath(storageKey),
        Buffer.from(JSON.stringify(existing, null, 2), "utf-8"),
        "application/json",
      );

      if (publishToManifest) {
        const manifest =
          (await loadCanonicalManifest(blueprintId, version)) ?? {
            productTypeId: 0,
            name: getCanonicalEntry(blueprintId)?.label ?? "",
            blueprintId,
            providerId: 0,
            tier: "flat" as const,
            views: {},
            blanks: {},
            generatedAt: new Date().toISOString(),
          };

        manifest.calibratorGeometry = existing;
        manifest.generatedAt = new Date().toISOString();

        await uploadToFlatCalibrationBucket(
          `${storageKey}/manifest.json`,
          Buffer.from(JSON.stringify({ ...manifest, canonicalVersion: version }, null, 2), "utf-8"),
          "application/json",
        );
      }

      res.json({ ok: true });
    } catch (e) {
      console.error("[platform-calibrator] save geometry failed:", e);
      res.status(500).json({ error: "Failed to save geometry" });
    }
  });

  app.post("/api/platform/canonical/:blueprintId/wipe", isAuthenticated, async (req: any, res: Response) => {
    if (!requirePlatformAdmin(req, res)) return;
    try {
      const blueprintId = parseInt(req.params.blueprintId, 10);
      const version = parseInt(String(req.body?.version || DEFAULT_CANONICAL_VERSION), 10);
      const removed = await deleteFlatCalibrationAssetsByPrefix(canonicalStorageKey(blueprintId, version));
      res.json({ ok: true, removed });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Wipe failed" });
    }
  });
}
