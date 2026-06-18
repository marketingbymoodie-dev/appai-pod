import { API_BASE } from "@/lib/urlBase";
import type { FlatCalibrationManifest, FlatViewCalibration } from "@/pages/embed-design";
import type { CalibratorLayerAdjust, FlatRenderInput } from "./flatRender";

export type FlatViewName = "front" | "back";

export type FlatLoadedViewAssets = {
  blank: HTMLImageElement | null;
  mask: HTMLImageElement | null;
  shading: HTMLImageElement | null;
};

/** Resolve absolute URL (manifest urls are usually Supabase absolutes already). */
export function toAbsFlatAssetUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${API_BASE}${url.startsWith("/") ? "" : "/"}${url}`;
}

export function normalizeFlatColorKey(id: string): string {
  return id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

export function flatBlankHasViews(
  entry: Partial<Record<FlatViewName, string>> | undefined,
): entry is Partial<Record<FlatViewName, string>> {
  return !!(entry?.front || entry?.back);
}

export { resolveFlatBlankColorId, resolveFlatPlacementGeometryKey } from "./flatBlankResolve";

function findBlankKey(manifest: FlatCalibrationManifest, id: string): string | null {
  if (!id) return null;
  if (flatBlankHasViews(manifest.blanks?.[id])) return id;
  const norm = normalizeFlatColorKey(id);
  for (const k of Object.keys(manifest.blanks || {})) {
    if (!flatBlankHasViews(manifest.blanks?.[k])) continue;
    const kn = normalizeFlatColorKey(k);
    if (kn === norm || kn.endsWith(`-${norm}`)) return k;
  }
  return null;
}

/**
 * Pick the blank photo set for `colorId`, with graceful fallback: exact key →
 * normalized-key match → first entry with usable URLs.
 *
 * Empty `{}` entries (failed harvest for that colour) are skipped — treating
 * them as missing avoids blocking fallback and breaking the placer.
 */
/** Per-model geometry overrides (phone cases — camera cutout differs per model). */
export type FlatViewGeometryOverride = Pick<
  FlatViewCalibration,
  | "visibleRectNormalized"
  | "printBoundsNormalized"
  | "backFaceCropNormalized"
  | "phoneBackNormalized"
  | "safeZoneNormalized"
  | "sideProfileCropped"
  | "sideProfileSourceCropNormalized"
  | "printFileDims"
  | "mockupDims"
  | "maskUrl"
  | "shadingUrl"
  | "shadingMode"
>;

export type FlatCalibrationManifestWithGeometry = FlatCalibrationManifest & {
  geometryByBlank?: Record<string, Partial<Record<FlatViewName, FlatViewGeometryOverride>>>;
  calibratorGeometry?: {
    productTypeId: number;
    models: Record<
      string,
      Partial<
        Record<
          FlatViewName,
          {
            blank: CalibratorLayerAdjust;
            mask: CalibratorLayerAdjust;
            shading: CalibratorLayerAdjust;
          }
        >
      >
    >;
    updatedAt: string;
  };
};

/** Layer nudges saved by the flat calibrator admin tool (mask/shading relative to baked blank). */
export function resolveCalibratorLayerAdjust(
  manifest: FlatCalibrationManifestWithGeometry,
  geometryKey: string,
  view: FlatViewName,
): FlatRenderInput["layerAdjust"] | undefined {
  const entry = manifest.calibratorGeometry?.models?.[geometryKey]?.[view];
  if (!entry) return undefined;
  const hasMask =
    entry.mask.offsetX !== 0 || entry.mask.offsetY !== 0 || entry.mask.scale !== 1;
  const hasShade =
    entry.shading.offsetX !== 0 || entry.shading.offsetY !== 0 || entry.shading.scale !== 1;
  const hasBlank =
    entry.blank.offsetX !== 0 || entry.blank.offsetY !== 0 || entry.blank.scale !== 1;
  if (!hasMask && !hasShade && !hasBlank) return undefined;
  return {
    blank: hasBlank ? entry.blank : undefined,
    mask: hasMask ? entry.mask : undefined,
    shading: hasShade ? entry.shading : undefined,
  };
}

/**
 * Merge shared view calibration with optional per-blank-key overrides.
 * Falls back to shared `manifest.views[view]` when no override exists.
 */
export function resolveFlatViewCalibration(
  manifest: FlatCalibrationManifest,
  colorId: string,
  view: FlatViewName,
): FlatViewCalibration | undefined {
  const base = manifest.views[view];
  if (!base) return undefined;
  const blankKey = findBlankKey(manifest, colorId);
  const override = blankKey ? manifest.geometryByBlank?.[blankKey]?.[view] : undefined;
  if (!override) return base;
  return {
    ...base,
    ...override,
    // Null-coalesce geometry fields — partial per-model harvest must not
    // clobber shared base values with null (breaks layout, shading, mask clip).
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

export function resolveFlatBlank(
  manifest: FlatCalibrationManifest,
  colorId: string,
): Partial<Record<FlatViewName, string>> {
  const blanks = manifest.blanks || {};
  const hit = colorId ? findBlankKey(manifest, colorId) : null;
  if (hit && flatBlankHasViews(blanks[hit])) return blanks[hit];
  if (colorId) return {};
  for (const k of Object.keys(blanks)) {
    if (flatBlankHasViews(blanks[k])) return blanks[k];
  }
  return {};
}

export function loadFlatImage(
  url: string,
  opts?: { cors?: boolean },
): Promise<HTMLImageElement | null> {
  const cors = opts?.cors !== false;
  return new Promise((resolve) => {
    const img = new Image();
    if (cors) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = toAbsFlatAssetUrl(url);
  });
}

/** Try CORS first (needed for canvas export); fall back to display-only load. */
export async function loadFlatImageRelaxed(url: string): Promise<HTMLImageElement | null> {
  const withCors = await loadFlatImage(url, { cors: true });
  if (withCors) return withCors;
  return loadFlatImage(url, { cors: false });
}

export async function loadFlatViewAssets(
  manifest: FlatCalibrationManifest,
  colorId: string,
  view: FlatViewName,
): Promise<FlatLoadedViewAssets | null> {
  const blank = resolveFlatBlank(manifest, colorId);
  const blankUrl = blank[view];
  const calib = resolveFlatViewCalibration(manifest, colorId, view);
  if (!blankUrl || !calib) return null;

  const shouldLoadShading =
    !!calib.shadingUrl &&
    (!!manifest.edgeWrap ||
      calib.shadingMode === "map" ||
      !!calib.printBoundsNormalized);

  const [b, m, s] = await Promise.all([
    loadFlatImage(blankUrl),
    calib.maskUrl ? loadFlatImage(calib.maskUrl) : Promise.resolve(null),
    shouldLoadShading ? loadFlatImage(calib.shadingUrl!) : Promise.resolve(null),
  ]);
  if (!b) return null;
  return { blank: b, mask: m, shading: s };
}
