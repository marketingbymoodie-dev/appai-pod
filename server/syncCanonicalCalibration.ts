/**
 * Copy platform canonical flat calibration onto a merchant product type when missing.
 */
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
  if (!manifest) return { synced: false };

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
