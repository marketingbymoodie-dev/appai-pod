/**
 * Canonical flat/mesh calibration — one harvest per blueprint, shared by all merchants.
 */
import {
  canonicalManifestPath,
  canonicalPublishedMetaPath,
  canonicalStorageKey,
  type CanonicalPublishedMeta,
} from "@shared/canonicalProducts";
import type { FlatCalibrationManifest, FlatTier } from "./flat-calibration";

export const DEFAULT_CANONICAL_VERSION = 1;

/** True when a manifest has enough data for on-the-fly storefront mockups. */
export function isUsableFlatCalibrationManifest(m: FlatCalibrationManifest | null | undefined): boolean {
  if (!m || (m.tier !== "flat" && m.tier !== "mesh")) return false;
  if (!m.views || Object.keys(m.views).length === 0) return false;
  return Object.values(m.blanks || {}).some(
    (perView: unknown) => !!(perView as { front?: unknown; back?: unknown })?.front ||
      !!(perView as { front?: unknown; back?: unknown })?.back,
  );
}

export type ResolvedCanonicalFlat = {
  meta: CanonicalPublishedMeta | null;
  manifest: FlatCalibrationManifest | null;
};

/**
 * Load platform canonical calibration for a flat catalog blueprint.
 * Published meta is preferred; operators may use an unpublished harvest (v1) for pre-launch testing.
 */
export async function resolveCanonicalFlatCalibration(
  blueprintId: number,
  options?: { allowUnpublishedHarvest?: boolean },
): Promise<ResolvedCanonicalFlat> {
  const publishedMeta = await loadCanonicalPublishedMeta(blueprintId);
  if (publishedMeta) {
    const manifest = await loadCanonicalManifest(blueprintId, publishedMeta.version);
    if (isUsableFlatCalibrationManifest(manifest)) {
      return { meta: publishedMeta, manifest: manifest! };
    }
  }

  if (options?.allowUnpublishedHarvest) {
    for (let version = DEFAULT_CANONICAL_VERSION; version <= DEFAULT_CANONICAL_VERSION + 2; version++) {
      const manifest = await loadCanonicalManifest(blueprintId, version);
      if (isUsableFlatCalibrationManifest(manifest)) {
        return {
          meta: publishedMeta ?? {
            blueprintId,
            version,
            kind: "flat",
            label: "",
            tier: manifest!.tier,
            publishedAt: "",
          },
          manifest: manifest!,
        };
      }
    }
  }

  return { meta: publishedMeta, manifest: null };
}
import {
  getPlatformCatalogEntry,
  markPlatformCatalogPublished,
} from "./platformCatalogStore";
import {
  downloadFlatCalibrationFile,
  publicFlatCalibrationUrl,
  uploadToFlatCalibrationBucket,
} from "./supabaseFlatCalibration";

export type CanonicalPublishState = CanonicalPublishedMeta & {
  manifestPath: string;
  published: boolean;
};

export async function loadCanonicalPublishedMeta(
  blueprintId: number,
): Promise<CanonicalPublishedMeta | null> {
  const buf = await downloadFlatCalibrationFile(canonicalPublishedMetaPath(blueprintId));
  if (!buf) return null;
  try {
    const parsed = JSON.parse(buf.toString("utf-8")) as CanonicalPublishedMeta;
    if (parsed?.blueprintId !== blueprintId || !parsed.version) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function loadCanonicalManifest(
  blueprintId: number,
  version: number,
): Promise<FlatCalibrationManifest | null> {
  const buf = await downloadFlatCalibrationFile(canonicalManifestPath(blueprintId, version));
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf-8")) as FlatCalibrationManifest;
  } catch {
    return null;
  }
}

export async function getCanonicalPublishState(
  blueprintId: number,
): Promise<CanonicalPublishState | null> {
  const entry = await getPlatformCatalogEntry(blueprintId);
  if (!entry || entry.kind === "blocked" || entry.kind === "printify") return null;

  if (entry.kind === "aop") {
    return {
      blueprintId,
      version: 1,
      kind: "aop",
      label: entry.label,
      publishedAt: entry.status === "published" ? entry.updatedAt?.toISOString() ?? "" : "",
      panelMappingTemplate: entry.panelMappingTemplate ?? undefined,
      manifestPath: "",
      published: entry.status === "published" && !!entry.panelMappingTemplate,
    };
  }

  const meta = await loadCanonicalPublishedMeta(blueprintId);
  if (!meta) {
    return {
      blueprintId,
      version: 0,
      kind: "flat",
      label: entry.label,
      publishedAt: "",
      manifestPath: canonicalManifestPath(blueprintId, 1),
      published: false,
    };
  }

  return {
    ...meta,
    manifestPath: canonicalManifestPath(blueprintId, meta.version),
    published: entry.status === "published",
  };
}

/** Clone canonical manifest for a merchant product type (URLs stay on shared paths). */
export function merchantManifestFromCanonical(
  manifest: FlatCalibrationManifest,
  merchantProductTypeId: number,
  merchantName: string,
): FlatCalibrationManifest {
  return {
    ...manifest,
    productTypeId: merchantProductTypeId,
    name: merchantName,
  };
}

export async function publishCanonicalManifest(args: {
  blueprintId: number;
  version: number;
  manifest: FlatCalibrationManifest;
  tier: FlatTier;
  label: string;
}): Promise<CanonicalPublishedMeta> {
  const { blueprintId, version, manifest, tier, label } = args;
  const entry = await getPlatformCatalogEntry(blueprintId);
  if (!entry || entry.kind !== "flat") {
    throw new Error(`Blueprint ${blueprintId} is not a flat canonical product`);
  }
  if (tier !== "flat" && tier !== "mesh") {
    throw new Error(`Cannot publish canonical calibration with tier ${tier}`);
  }

  const stamped: FlatCalibrationManifest = {
    ...manifest,
    blueprintId,
    canonicalVersion: version,
    generatedAt: new Date().toISOString(),
  };

  await uploadToFlatCalibrationBucket(
    canonicalManifestPath(blueprintId, version),
    Buffer.from(JSON.stringify(stamped, null, 2), "utf-8"),
    "application/json",
  );

  const meta: CanonicalPublishedMeta = {
    blueprintId,
    version,
    kind: "flat",
    label,
    tier,
    publishedAt: new Date().toISOString(),
  };

  await uploadToFlatCalibrationBucket(
    canonicalPublishedMetaPath(blueprintId),
    Buffer.from(JSON.stringify(meta, null, 2), "utf-8"),
    "application/json",
  );

  await markPlatformCatalogPublished(blueprintId);

  return meta;
}

export function canonicalCalibratorGeometryPath(blueprintId: number, version: number): string {
  return `${canonicalStorageKey(blueprintId, version)}/calibrator/geometry.json`;
}

export function canonicalCalibratorLayerPaths(
  blueprintId: number,
  version: number,
  safe: string,
  view: "front" | "back",
) {
  const base = `${canonicalStorageKey(blueprintId, version)}/calibrator/${safe}`;
  const suffix = view === "front" ? "" : `-${view}`;
  return {
    pink: `${base}-pink${suffix}.jpg`,
    blank: `${base}-blank${suffix}.jpg`,
    mask: `${base}-mask${suffix}.png`,
    shading: `${base}-shading${suffix}.jpg`,
  };
}

export function canonicalAssetPublicUrl(path: string): string | null {
  return publicFlatCalibrationUrl(path);
}
