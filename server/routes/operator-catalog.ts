/**
 * Operator catalog: browse full Printify catalog and tag products (Flat / AOP / API).
 */

import { type Express, type Response } from "express";
import { requirePlatformAdmin } from "../platformAdmin";
import {
  clearPlatformCatalogTag,
  getPlatformCatalogTagsForBlueprints,
  listPlatformCatalog,
  upsertPlatformCatalogTag,
  type PlatformCatalogKind,
} from "../platformCatalogStore";
import { detectPrintifyAllOverPrint } from "../printify-aop-detection";
import { shouldBlockFlatCatalogTag } from "@shared/productLayoutPolicy";

type StorageLike = {
  getMerchantByUserId(userId: string): Promise<any>;
};

export function registerOperatorCatalogRoutes(
  app: Express,
  deps: { storage: StorageLike; isAuthenticated: any },
) {
  const { storage, isAuthenticated } = deps;

  app.get("/api/platform/operator-catalog/tags", isAuthenticated, async (req: any, res: Response) => {
    if (!requirePlatformAdmin(req, res)) return;
    const tags = await listPlatformCatalog();
    res.json({ tags });
  });

  app.put("/api/platform/operator-catalog/:blueprintId/tag", isAuthenticated, async (req: any, res: Response) => {
    if (!requirePlatformAdmin(req, res)) return;
    try {
      const blueprintId = parseInt(req.params.blueprintId, 10);
      const { kind, label, brand, category, panelMappingTemplate, notes, storefrontMockupMode, fulfillmentLayout, forceFlatHarvest } =
        req.body ?? {};
      const allowed: PlatformCatalogKind[] = ["flat", "aop", "printify", "blocked"];
      if (!allowed.includes(kind)) {
        return res.status(400).json({ error: "kind must be flat, aop, printify, or blocked" });
      }
      if (!label || typeof label !== "string") {
        return res.status(400).json({ error: "label is required" });
      }

      if (
        kind === "flat" &&
        shouldBlockFlatCatalogTag({ name: label, blueprintId, forceFlatHarvest: !!forceFlatHarvest })
      ) {
        return res.status(400).json({
          error:
            "This product is all-over print (AOP). Tag as AOP, or enable “Force flat harvest” to use flat mockups with a folded print layout.",
          code: "AOP_NOT_FLAT",
        });
      }

      const row = await upsertPlatformCatalogTag({
        printifyBlueprintId: blueprintId,
        label,
        brand: brand ?? null,
        kind,
        category: category ?? null,
        panelMappingTemplate: kind === "aop" ? panelMappingTemplate ?? null : null,
        storefrontMockupMode: storefrontMockupMode ?? null,
        fulfillmentLayout: fulfillmentLayout ?? null,
        forceFlatHarvest: forceFlatHarvest ?? null,
        notes: notes ?? null,
      });

      res.json({ tag: row });
    } catch (e: any) {
      console.error("[operator-catalog] tag failed:", e);
      res.status(500).json({ error: e?.message || "Failed to save tag" });
    }
  });

  app.delete("/api/platform/operator-catalog/:blueprintId/tag", isAuthenticated, async (req: any, res: Response) => {
    if (!requirePlatformAdmin(req, res)) return;
    try {
      const blueprintId = parseInt(req.params.blueprintId, 10);
      await clearPlatformCatalogTag(blueprintId);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Failed to clear tag" });
    }
  });

  /** Merge Printify catalog list with DB tags (client sends blueprint ids or fetches printify separately). */
  app.post("/api/platform/operator-catalog/merge-tags", isAuthenticated, async (req: any, res: Response) => {
    if (!requirePlatformAdmin(req, res)) return;
    const ids = Array.isArray(req.body?.blueprintIds)
      ? req.body.blueprintIds.map(Number).filter((n: number) => Number.isFinite(n))
      : [];
    const map = await getPlatformCatalogTagsForBlueprints(ids);
    res.json({
      tags: Object.fromEntries([...map.entries()].map(([k, v]) => [String(k), v])),
    });
  });
}
