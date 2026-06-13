/**
 * Canonical flat/mesh calibration — one harvest per blueprint, shared by all merchants.
 */
import {
  canonicalManifestPath,
  canonicalPublishedMetaPath,
  canonicalStorageKey,
  getCanonicalEntry,
  type CanonicalPublishedMeta,
  type CanonicalProductKind,
} from "@shared/canonicalProducts";
import type { FlatCalibrationManifest, FlatTier } from "./flat-calibration";
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
  const entry = getCanonicalEntry(blueprintId);
  if (!entry) return null;

  if (entry.kind === "aop") {
    return {
      blueprintId,
      version: 1,
      kind: "aop",
      label: entry.label,
      publishedAt: "",
      panelMappingTemplate: entry.panelMappingTemplate,
      manifestPath: "",
      published: !!entry.panelMappingTemplate,
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
    published: true,
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
  const entry = getCanonicalEntry(blueprintId);
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
