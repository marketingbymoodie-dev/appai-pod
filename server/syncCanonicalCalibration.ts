/**
 * Copy platform canonical flat calibration onto a merchant product type when missing.
 */
import { productLooksLikeFramedDecor } from "@shared/productVariantOptions";
import {
  isUsableFlatCalibrationManifest,
  merchantManifestFromCanonical,
  resolveCanonicalFlatCalibration,
} from "./canonicalFlatCalibration";
import { getPlatformCatalogEntry } from "./platformCatalogStore";
import { storage } from "./storage";

export function parseFlatCalibrationManifest(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    return isUsableFlatCalibrationManifest(m as any) ? m : null;
  } catch {
    return null;
  }
}

export async function syncProductTypeFromCanonicalCalibration(
  productType: {
    id: number;
    name: string;
    printifyBlueprintId: number | null;
    flatCalibration?: unknown;
  },
  options?: { allowUnpublishedHarvest?: boolean },
): Promise<{ synced: boolean; productType?: Awaited<ReturnType<typeof storage.getProductType>> }> {
  if (!productType.printifyBlueprintId) return { synced: false };
  if (parseFlatCalibrationManifest(productType.flatCalibration)) return { synced: false };

  const catalogEntry = await getPlatformCatalogEntry(productType.printifyBlueprintId);
  if (catalogEntry?.kind !== "flat") return { synced: false };

  const allowUnpublishedHarvest =
    options?.allowUnpublishedHarvest ?? catalogEntry.status !== "published";

  const { manifest, meta } = await resolveCanonicalFlatCalibration(productType.printifyBlueprintId, {
    allowUnpublishedHarvest,
  });
  if (!manifest) {
    console.warn(
      `[flat-calibration] no usable canonical manifest for pt ${productType.id} bp ${productType.printifyBlueprintId} (allowUnpublished=${allowUnpublishedHarvest})`,
    );
    return { synced: false };
  }

  await storage.updateProductType(productType.id, {
    onTheFlyTier: meta?.tier ?? manifest.tier,
    flatCalibrationStatus: "ready",
    flatCalibration: JSON.stringify(
      merchantManifestFromCanonical(manifest, productType.id, productType.name),
    ),
  });

  const updated = await storage.getProductType(productType.id);
  console.log(
    `[flat-calibration] synced canonical calibration onto pt ${productType.id} (${productType.name}) from bp ${productType.printifyBlueprintId}`,
  );
  return { synced: true, productType: updated ?? undefined };
}

/** Ensure flat catalog products have canonical calibration before building designer config. */
/** Copy published platform-catalog AOP metadata onto a merchant product type. */
export async function syncProductTypeFromPlatformCatalogAop(
  productType: {
    id: number;
    printifyBlueprintId: number | null;
    isAllOverPrint?: boolean | null;
    panelMappingTemplate?: string | null;
    flatCalibrationStatus?: string | null;
  },
): Promise<{ synced: boolean; productType?: Awaited<ReturnType<typeof storage.getProductType>> }> {
  if (!productType.printifyBlueprintId) return { synced: false };

  const catalogEntry = await getPlatformCatalogEntry(productType.printifyBlueprintId);
  if (catalogEntry?.kind !== "aop") return { synced: false };
  if (catalogEntry.status !== "published" || !catalogEntry.panelMappingTemplate) {
    return { synced: false };
  }

  const updates: Record<string, unknown> = {};
  if (!productType.isAllOverPrint) updates.isAllOverPrint = true;
  if (productType.panelMappingTemplate !== catalogEntry.panelMappingTemplate) {
    updates.panelMappingTemplate = catalogEntry.panelMappingTemplate;
  }
  if (productType.flatCalibrationStatus !== "unsupported") {
    updates.flatCalibrationStatus = "unsupported";
  }
  if (Object.keys(updates).length === 0) return { synced: false };

  await storage.updateProductType(productType.id, updates);
  const updated = await storage.getProductType(productType.id);
  console.log(
    `[aop-catalog] synced platform AOP metadata onto pt ${productType.id} from bp ${productType.printifyBlueprintId} → ${catalogEntry.panelMappingTemplate}`,
  );
  return { synced: true, productType: updated ?? undefined };
}

export async function prepareProductTypeForDesigner(
  productType: {
    id: number;
    name: string;
    printifyBlueprintId: number | null;
    flatCalibration?: unknown;
    isAllOverPrint?: boolean | null;
    panelMappingTemplate?: string | null;
    flatCalibrationStatus?: string | null;
    designerType?: string | null;
  } | null | undefined,
  options?: { allowUnpublishedHarvest?: boolean },
): Promise<typeof productType> {
  if (!productType) return productType;
  const flatSync = await syncProductTypeFromCanonicalCalibration(productType, options);
  let current = flatSync.productType ?? productType;

  // HFP imports sometimes land as designerType=generic — heal so placer/lifestyle match VFP.
  const dt = String((current as { designerType?: string | null }).designerType || "").toLowerCase();
  if (
    (!dt || dt === "generic") &&
    productLooksLikeFramedDecor({
      designerType: dt,
      name: current.name,
    })
  ) {
    await storage.updateProductType(current.id, { designerType: "framed-print" });
    const healed = await storage.getProductType(current.id);
    if (healed) current = healed;
  }

  const aopSync = await syncProductTypeFromPlatformCatalogAop(current);
  return aopSync.productType ?? current;
}
