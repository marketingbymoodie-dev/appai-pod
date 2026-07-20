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

import {
  resolveFlatBlankColorId,
  resolveFlatPlacementGeometryKey,
  firstUsableBlankKey,
  manifestHasMultipleColorBlanks,
} from "./flatBlankResolve";

export {
  resolveFlatBlankColorId,
  resolveFlatPlacementGeometryKey,
  firstUsableBlankKey,
  manifestHasMultipleColorBlanks,
};

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
  opts?: { landscapeOrientation?: boolean },
): FlatViewCalibration | undefined {
  const base = manifest.views[view];
  if (!base) return undefined;
  const blankKey = findBlankKey(manifest, colorId);
  const override = blankKey ? manifest.geometryByBlank?.[blankKey]?.[view] : undefined;
  let merged: FlatViewCalibration;
  if (!override) {
    merged = base;
  } else {
    merged = {
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
  if (!opts?.landscapeOrientation) return merged;
  const pf = merged.printFileDims;
  if (!pf?.width || !pf?.height || pf.width >= pf.height) return merged;
  return orientFlatViewCalibrationLandscape(merged);
}

export function resolveFlatBlank(
  manifest: FlatCalibrationManifest,
  colorId: string,
): Partial<Record<FlatViewName, string>> {
  const blanks = manifest.blanks || {};
  const hit = colorId ? findBlankKey(manifest, colorId) : null;
  if (hit && flatBlankHasViews(blanks[hit])) return blanks[hit];
  if (colorId) {
    if (!manifestHasMultipleColorBlanks(manifest)) {
      const fallbackKey = firstUsableBlankKey(manifest);
      if (fallbackKey && flatBlankHasViews(blanks[fallbackKey])) return blanks[fallbackKey];
    }
    return {};
  }
  for (const k of Object.keys(blanks)) {
    if (flatBlankHasViews(blanks[k])) return blanks[k];
  }
  return {};
}

function swapNormRect(
  r: { x: number; y: number; width: number; height: number } | null | undefined,
): { x: number; y: number; width: number; height: number } | null | undefined {
  if (!r) return r;
  return { x: r.y, y: r.x, width: r.height, height: r.width };
}

/** Rotate harvested portrait geometry to landscape when size orientation differs. */
export function orientFlatViewCalibrationLandscape(
  calib: FlatViewCalibration,
): FlatViewCalibration {
  const pf = calib.printFileDims;
  return {
    ...calib,
    printFileDims: { width: pf.height, height: pf.width },
    visibleRectNormalized: swapNormRect(calib.visibleRectNormalized) ?? calib.visibleRectNormalized,
    printBoundsNormalized: swapNormRect(calib.printBoundsNormalized) ?? calib.printBoundsNormalized,
    backFaceCropNormalized: swapNormRect(calib.backFaceCropNormalized) ?? calib.backFaceCropNormalized,
    phoneBackNormalized: swapNormRect(calib.phoneBackNormalized) ?? calib.phoneBackNormalized,
    safeZoneNormalized: swapNormRect(calib.safeZoneNormalized) ?? calib.safeZoneNormalized,
    sideProfileSourceCropNormalized:
      swapNormRect(calib.sideProfileSourceCropNormalized) ?? calib.sideProfileSourceCropNormalized,
    mockupDims: calib.mockupDims
      ? { width: calib.mockupDims.height, height: calib.mockupDims.width }
      : calib.mockupDims,
  };
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

function imagePixelSize(img: HTMLImageElement): { w: number; h: number } {
  return { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
}

/** 90° clockwise — used when landscape sizes reuse a portrait harvest mask. */
export async function rotateFlatImage90Cw(img: HTMLImageElement): Promise<HTMLImageElement> {
  const { w, h } = imagePixelSize(img);
  if (w <= 0 || h <= 0) return img;
  const canvas = document.createElement("canvas");
  canvas.width = h;
  canvas.height = w;
  const ctx = canvas.getContext("2d");
  if (!ctx) return img;
  ctx.translate(h, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/png");
  return new Promise((resolve) => {
    const out = new Image();
    out.onload = () => resolve(out);
    out.onerror = () => resolve(img);
    out.src = dataUrl;
  });
}

/**
 * True when landscapeOrientation remapped portrait printFileDims → landscape.
 * Harvest masks are usually square (mockup px) with a tall opaque silhouette —
 * pixel aspect alone cannot detect that, so callers use this geometry check.
 */
export function flatCalibrationSwappedToLandscape(
  manifest: FlatCalibrationManifest,
  colorId: string,
  view: FlatViewName,
  landscapeOrientation: boolean,
): boolean {
  if (!landscapeOrientation) return false;
  const base = resolveFlatViewCalibration(manifest, colorId, view);
  if (!base?.printFileDims?.width || !base.printFileDims.height) return false;
  if (base.printFileDims.width >= base.printFileDims.height) return false;
  const oriented = resolveFlatViewCalibration(manifest, colorId, view, {
    landscapeOrientation: true,
  });
  if (!oriented?.printFileDims) return false;
  return oriented.printFileDims.width > oriented.printFileDims.height;
}

/**
 * When print geometry is swapped to landscape but mask/shading still encode a
 * portrait silhouette (often on a square mockup canvas), rotate 90° so
 * destination-in clip matches the wide placement box. Without this, blank white
 * shows as fixed side bars while art pans underneath.
 */
export async function orientFlatHarvestPixelsForLandscape(
  mask: HTMLImageElement | null,
  shading: HTMLImageElement | null,
): Promise<{ mask: HTMLImageElement | null; shading: HTMLImageElement | null }> {
  if (!mask && !shading) return { mask, shading };
  const [nextMask, nextShading] = await Promise.all([
    mask ? rotateFlatImage90Cw(mask) : Promise.resolve(null),
    shading ? rotateFlatImage90Cw(shading) : Promise.resolve(null),
  ]);
  return { mask: nextMask, shading: nextShading };
}

export async function loadFlatViewAssets(
  manifest: FlatCalibrationManifest,
  colorId: string,
  view: FlatViewName,
  opts?: { landscapeOrientation?: boolean; blankUrlOverride?: string | null },
): Promise<FlatLoadedViewAssets | null> {
  const blank = resolveFlatBlank(manifest, colorId);
  const blankUrl =
    view === "front" && opts?.blankUrlOverride ? opts.blankUrlOverride : blank[view];
  const landscapeOrientation = !!opts?.landscapeOrientation;
  const calib = resolveFlatViewCalibration(manifest, colorId, view, {
    landscapeOrientation,
  });
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
  if (flatCalibrationSwappedToLandscape(manifest, colorId, view, landscapeOrientation)) {
    const oriented = await orientFlatHarvestPixelsForLandscape(m, s);
    return { blank: b, mask: oriented.mask, shading: oriented.shading };
  }
  return { blank: b, mask: m, shading: s };
}
