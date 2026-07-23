/**
 * Local canvas renderer for the on-the-fly flat / mesh mockup placer.
 *
 * Given a calibrated blank garment photo + a print-area mask + (optionally) a
 * shading map, it composites the customer's artwork onto the blank so the
 * storefront preview matches what Printify would produce — without a Printify
 * round-trip. The same composite is exported (toBlob/toDataURL) for the cart /
 * checkout shadow-SKU image, so it MUST be pixel-identical to the live canvas.
 *
 * Two tiers (decided server-side in `server/flat-calibration.ts`):
 *   - flat : planar surface → the artwork is blitted into the visible print
 *            rect (a simple scaled draw) then clipped to the mask silhouette.
 *   - mesh : mildly curved surface (e.g. cap front) → the artwork is first
 *            rendered into a flat "print-area" canvas, then warped through the
 *            stored mesh control points via `drawMeshWarp`, then clipped.
 *
 * Two shading modes (per view, also decided server-side):
 *   - "blank" : multiply the blank garment's own (normalized) luminance over
 *               the artwork — gives fabric folds / AO on apparel. Normalized
 *               around the masked mean so dark garments don't crush the art.
 *   - "map"   : multiply the normalized gray-pass shading map over the artwork
 *               — used for white / rigid surfaces whose blank carries little
 *               tonal range but whose render bakes gloss / AO.
 *
 * Coordinate invariant: placement is stored in NORMALIZED print-rect units
 * (`scale` relative to a "cover the rect" baseline, `offsetX/offsetY` as a
 * fraction of the rect's width/height). This keeps the data reusable for the
 * eventual print-file generation (a separate, out-of-scope task) without any
 * mockup-pixel coupling.
 */

import { drawMeshWarp } from "@/components/hoodie-template-mapper/lib/meshWarp";
import type { ArtworkPlacement } from "@/components/hoodie-template-mapper/lib/aopPreview";
import type { MeshGrid, Pt } from "@shared/hoodieTemplate";
import type {
  FlatTier,
  FlatViewCalibration,
} from "@/pages/embed-design";

export type Rect = { x: number; y: number; width: number; height: number };

/** Lowest allowed placement scale. */
export const FLAT_SCALE_MIN = 0.2;
/** Default cap — Printify placement API clamps at 1; baked print files allow more. */
export const FLAT_SCALE_MAX = 1.0;
/** Phone edge-wrap — zoom in to cover side strip + bleed. */
export const FLAT_SCALE_MAX_EDGE_WRAP = 2.0;
/** Framed / decor — zoom in to crop built-in borders past the mat opening. */
export const FLAT_SCALE_MAX_DECOR = 2.5;

export function flatPlacementScaleMax(opts: {
  edgeWrapMode?: boolean;
  decorMode?: boolean;
}): number {
  if (opts.edgeWrapMode) return FLAT_SCALE_MAX_EDGE_WRAP;
  if (opts.decorMode) return FLAT_SCALE_MAX_DECOR;
  return FLAT_SCALE_MAX;
}

/** Floor for the normalized shading multiply so artwork never goes fully black. */
const SHADE_FACTOR_MIN = 0.45;

/** Per-layer nudge from the flat calibrator admin tool (normalized to print canvas). */
export type CalibratorLayerAdjust = {
  offsetX: number;
  offsetY: number;
  scale: number;
};

export type FlatPreviewLayers = {
  blank?: boolean;
  shading?: boolean;
  artwork?: boolean;
};

export function adjustCalibratorDrawRect(
  rect: Rect,
  adj: CalibratorLayerAdjust | undefined,
  canvasW: number,
  canvasH: number,
): Rect {
  if (!adj || (adj.offsetX === 0 && adj.offsetY === 0 && adj.scale === 1)) {
    return rect;
  }
  const w = rect.width * adj.scale;
  const h = rect.height * adj.scale;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return {
    x: cx - w / 2 + adj.offsetX * canvasW,
    y: cy - h / 2 + adj.offsetY * canvasH,
    width: w,
    height: h,
  };
}

export type FlatRenderInput = {
  /** Target canvas — sized to the blank's natural (mockup) dimensions. */
  target: HTMLCanvasElement;
  /** Base garment photo for the selected colour + view. */
  blank: HTMLImageElement;
  /** White-on-transparent print silhouette. `null` → no mask clip. */
  mask: HTMLImageElement | null;
  /** Gray-pass shading map (used only when `view.shadingMode === "map"`). */
  shading: HTMLImageElement | null;
  /** Customer artwork. `null` → render the plain blank. */
  artwork: HTMLImageElement | null;
  view: FlatViewCalibration;
  placement: ArtworkPlacement;
  tier: FlatTier;
  /** When false, skip pixel-read shading normalize (display-only cross-origin art). */
  artworkCorsClean?: boolean;
  /** Phone cases / rigid products — use harvested gray shading map when present. */
  forceShadingMap?: boolean;
  /** Edge-print phone cases — placement uses full print bounds, not safe zone. */
  edgeWrapMode?: boolean;
  /** Framed / decor — placement uses visible mat opening; scale may exceed 1. */
  decorMode?: boolean;
  /** Woven fabric procedural texture (tapestry only unless admin-enabled). */
  fabricWeave?: boolean;
  sizeId?: string;
  /** Crop to back face when the mockup has a side-profile strip (iPhone 14/15). */
  cropToBackFace?: boolean;
  /** Manual per-layer alignment (flat calibrator → storefront). */
  layerAdjust?: {
    blank?: CalibratorLayerAdjust;
    mask?: CalibratorLayerAdjust;
    shading?: CalibratorLayerAdjust;
  };
  /** Calibrator / debug — toggle compositing stages. */
  previewLayers?: FlatPreviewLayers;
};

function imgDims(img: HTMLImageElement): { w: number; h: number } {
  return {
    w: img.naturalWidth || img.width,
    h: img.naturalHeight || img.height,
  };
}

/** True when blank and mask share the same pixel coordinate space (±8%). */
function maskAlignsWithBlank(
  blank: HTMLImageElement,
  mask: HTMLImageElement | null,
  tolerance = 0.08,
): boolean {
  if (!mask) return false;
  const { w: bw, h: bh } = imgDims(blank);
  const { w: mw, h: mh } = imgDims(mask);
  if (bw <= 0 || bh <= 0 || mw <= 0 || mh <= 0) return false;
  return (
    Math.abs(bw - mw) / Math.max(bw, mw) <= tolerance &&
    Math.abs(bh - mh) / Math.max(bh, mh) <= tolerance
  );
}

/**
 * Visible print rect in mockup pixels. Falls back to the full canvas when the
 * server couldn't detect a silhouette (`visibleRectNormalized === null`).
 */
function normalizedRectPx(
  nr: { x: number; y: number; width: number; height: number } | null | undefined,
  canvasW: number,
  canvasH: number,
): Rect | null {
  if (!nr) return null;
  return {
    x: nr.x * canvasW,
    y: nr.y * canvasH,
    width: nr.width * canvasW,
    height: nr.height * canvasH,
  };
}

export function flatVisibleRectPx(
  view: FlatViewCalibration,
  canvasW: number,
  canvasH: number,
): Rect {
  return (
    normalizedRectPx(view.visibleRectNormalized, canvasW, canvasH) ?? {
      x: 0,
      y: 0,
      width: canvasW,
      height: canvasH,
    }
  );
}

/** Full print silhouette from manifest (harvested mask bbox). */
export function flatPrintBoundsRectPx(
  view: FlatViewCalibration,
  canvasW: number,
  canvasH: number,
): Rect | null {
  return normalizedRectPx(
    view.printBoundsNormalized ?? view.visibleRectNormalized,
    canvasW,
    canvasH,
  );
}

function rectsNearlyEqual(a: Rect, b: Rect, eps = 2): boolean {
  return (
    Math.abs(a.x - b.x) <= eps &&
    Math.abs(a.y - b.y) <= eps &&
    Math.abs(a.width - b.width) <= eps &&
    Math.abs(a.height - b.height) <= eps
  );
}

/** Preview canvas width — height follows printFileDims aspect. */
export const FLAT_PRINT_PREVIEW_BASE_PX = 900;

/** Approximate safe back-face guide when harvest stored only one bbox (legacy manifests). */
export function flatEdgeWrapSafeZoneRectPx(outer: Rect, insetFraction = 0.04): Rect {
  const mx = outer.width * insetFraction;
  const my = outer.height * insetFraction;
  return {
    x: outer.x + mx,
    y: outer.y + my,
    width: Math.max(1, outer.width - 2 * mx),
    height: Math.max(1, outer.height - 2 * my),
  };
}

export function flatPrintCanvasPreviewDims(view: FlatViewCalibration): { width: number; height: number } {
  const pfW = view.printFileDims?.width ?? 1;
  const pfH = view.printFileDims?.height ?? 1;
  const w = FLAT_PRINT_PREVIEW_BASE_PX;
  return { width: w, height: Math.max(1, Math.round(w * (pfH / pfW))) };
}

function normRectToPx(nr: NormRect, canvasW: number, canvasH: number): Rect {
  return {
    x: nr.x * canvasW,
    y: nr.y * canvasH,
    width: nr.width * canvasW,
    height: nr.height * canvasH,
  };
}

export type FlatPrintCanvasLayout = {
  previewW: number;
  previewH: number;
  /** Full print canvas (grey box) — placement + outer guide. */
  printCanvas: Rect;
  /** Visible phone silhouette region (mask alpha bounds, centered in print canvas). */
  phoneBack: Rect;
  /** Safe zone (amber dashed guide) — inset inside phoneBack. */
  safeZone: Rect;
  /** Where to draw blank/mask/shading so phoneBack aligns with the silhouette. */
  imageDraw: Rect;
  /** Source crop on uncropped blank/mask assets (side-profile mockups). */
  sourceCrop: Rect | null;
};

function fitAspectCenteredInCanvas(contentAspect: number, canvasAspect: number): NormRect {
  let w: number;
  let h: number;
  if (contentAspect >= canvasAspect) {
    w = 1;
    h = canvasAspect / contentAspect;
  } else {
    h = 1;
    w = contentAspect / canvasAspect;
  }
  return {
    x: (1 - w) / 2,
    y: (1 - h) / 2,
    width: w,
    height: h,
  };
}

/**
 * Printify bleed model: print file = phone back + EQUAL margin on all 4 sides.
 * Solve the unique phone size whose horizontal and vertical margins match:
 *   w + 2m = W,  h + 2m = H,  w/h = aspect  →  h = (H - W) / (1 - aspect)
 * Returns null when no sane solution exists (caller falls back to aspect-fit).
 */
function fitEqualMarginInCanvas(
  contentAspect: number,
  canvasW: number,
  canvasH: number,
): Rect | null {
  if (!(contentAspect > 0) || canvasW <= 0 || canvasH <= 0) return null;
  if (Math.abs(1 - contentAspect) < 1e-4) return null;
  const h = (canvasH - canvasW) / (1 - contentAspect);
  const w = contentAspect * h;
  if (!(w > 0) || !(h > 0) || w > canvasW + 0.5 || h > canvasH + 0.5) return null;
  const m = (canvasW - w) / 2;
  // Reject degenerate solutions (negative bleed or phone under half the box).
  if (m < 0 || w < canvasW * 0.5 || h < canvasH * 0.5) return null;
  return { x: m, y: (canvasH - h) / 2, width: w, height: h };
}

export type FlatPrintCanvasLayoutAssets = {
  mask?: HTMLImageElement | null;
  blank?: HTMLImageElement | null;
};

/** Printify editor grey — bleed area around the phone silhouette. */
const PRINT_CANVAS_GREY = "#d4d4d4";

function resolveEdgeWrapSourceCrop(
  view: FlatViewCalibration,
  img: HTMLImageElement | null,
): Rect | null {
  if (!img) return null;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (iw <= 0 || ih <= 0) return null;

  const mw = view.mockupDims?.width ?? iw;
  const mh = view.mockupDims?.height ?? ih;
  if (view.sideProfileCropped && Math.abs(iw - mw) <= 3 && Math.abs(ih - mh) <= 3) {
    return null;
  }

  const sideSrc = view.sideProfileSourceCropNormalized as NormRect | null | undefined;
  if (sideSrc && sideSrc.width > 0 && sideSrc.width < 0.98) {
    const crop = normalizedRectPx(sideSrc, iw, ih);
    if (crop) return crop;
  }

  if (view.backFaceCropNormalized) {
    const crop = normalizedRectPx(view.backFaceCropNormalized as NormRect, iw, ih);
    if (crop && crop.width < iw * 0.97) return crop;
  }

  const detected = detectEdgeWrapBackFaceFromMask(img);
  if (detected && detected.width < iw * 0.97) return detected;
  return null;
}

/** Map mask alpha bounds into print-canvas preview space (Printify grey-box model). */
function layoutPhoneFromMaskBounds(
  view: FlatViewCalibration,
  bounds: Rect,
  srcW: number,
  srcH: number,
  previewW: number,
  previewH: number,
): { phoneBack: Rect; imageDraw: Rect; safeZone: Rect } {
  const pfW = view.printFileDims?.width ?? previewW;
  const pfH = view.printFileDims?.height ?? previewH;
  const canvasAspect = pfW / Math.max(pfH, 1);
  const boundsAspect = bounds.width / Math.max(bounds.height, 1);

  // Equal bleed margin on all 4 sides (Printify grey-box model); aspect-fit
  // only as a fallback when the mask aspect makes that unsolvable.
  const phoneBack =
    fitEqualMarginInCanvas(boundsAspect, previewW, previewH) ??
    normRectToPx(
      fitAspectCenteredInCanvas(boundsAspect, canvasAspect),
      previewW,
      previewH,
    );

  const relX = bounds.x / Math.max(srcW, 1);
  const relY = bounds.y / Math.max(srcH, 1);
  const relW = bounds.width / Math.max(srcW, 1);
  const relH = bounds.height / Math.max(srcH, 1);

  const imageDraw: Rect = {
    x: phoneBack.x - (relX / Math.max(relW, 1e-6)) * phoneBack.width,
    y: phoneBack.y - (relY / Math.max(relH, 1e-6)) * phoneBack.height,
    width: phoneBack.width / Math.max(relW, 1e-6),
    height: phoneBack.height / Math.max(relH, 1e-6),
  };

  // Stored safe zone is relative to the harvested phoneBack — remap it onto the
  // live phoneBack so the amber guide always tracks the rendered silhouette.
  const storedSafe = view.safeZoneNormalized as NormRect | null | undefined;
  const storedPhone = view.phoneBackNormalized as NormRect | null | undefined;
  let safeZone: Rect;
  if (
    storedSafe && storedSafe.width > 0 && storedSafe.height > 0 &&
    storedPhone && storedPhone.width > 0 && storedPhone.height > 0
  ) {
    const relX = (storedSafe.x - storedPhone.x) / storedPhone.width;
    const relY = (storedSafe.y - storedPhone.y) / storedPhone.height;
    const relW = storedSafe.width / storedPhone.width;
    const relH = storedSafe.height / storedPhone.height;
    safeZone = {
      x: phoneBack.x + relX * phoneBack.width,
      y: phoneBack.y + relY * phoneBack.height,
      width: relW * phoneBack.width,
      height: relH * phoneBack.height,
    };
  } else if (storedSafe && storedSafe.width > 0 && storedSafe.height > 0) {
    safeZone = normRectToPx(storedSafe, previewW, previewH);
  } else {
    safeZone = flatEdgeWrapSafeZoneRectPx(phoneBack);
  }

  return { phoneBack, imageDraw, safeZone };
}

/**
 * Print-canvas-centric layout for edge-wrap phone cases.
 * Centers the mask silhouette (not the PNG rectangle) inside printFileDims.
 */
export function flatPrintCanvasLayout(
  view: FlatViewCalibration,
  assets?: FlatPrintCanvasLayoutAssets,
): FlatPrintCanvasLayout {
  const { width: previewW, height: previewH } = flatPrintCanvasPreviewDims(view);
  const printCanvas: Rect = { x: 0, y: 0, width: previewW, height: previewH };

  const mask = assets?.mask ?? null;
  const blank = assets?.blank ?? null;
  const maskAligned = mask && blank ? maskAlignsWithBlank(blank, mask) : false;

  // Live mask layout only when mask + blank share coordinates. Per-model cropped
  // blanks use stored phoneBack/safeZone from geometryByBlank instead.
  if (mask && maskAligned) {
    const iw = mask.naturalWidth || mask.width;
    const ih = mask.naturalHeight || mask.height;
    const sourceCrop = resolveEdgeWrapSourceCrop(view, mask);
    const srcW = sourceCrop?.width ?? iw;
    const srcH = sourceCrop?.height ?? ih;

    let bounds = flatImageAlphaBounds(mask);
    if (bounds && sourceCrop) {
      const x = Math.max(sourceCrop.x, bounds.x);
      const y = Math.max(sourceCrop.y, bounds.y);
      const r = Math.min(sourceCrop.x + sourceCrop.width, bounds.x + bounds.width);
      const b = Math.min(sourceCrop.y + sourceCrop.height, bounds.y + bounds.height);
      bounds = {
        x: x - sourceCrop.x,
        y: y - sourceCrop.y,
        width: Math.max(1, r - x),
        height: Math.max(1, b - y),
      };
    }

    if (bounds && bounds.width > 4 && bounds.height > 4) {
      const laid = layoutPhoneFromMaskBounds(view, bounds, srcW, srcH, previewW, previewH);
      return {
        previewW,
        previewH,
        printCanvas,
        phoneBack: laid.phoneBack,
        safeZone: laid.safeZone,
        imageDraw: laid.imageDraw,
        sourceCrop,
      };
    }
  }

  const storedPhone = view.phoneBackNormalized as NormRect | null | undefined;
  const storedSafe = view.safeZoneNormalized as NormRect | null | undefined;
  const phoneBack = storedPhone
    ? normRectToPx(storedPhone, previewW, previewH)
    : printCanvas;
  const safeZone = storedSafe
    ? normRectToPx(storedSafe, previewW, previewH)
    : flatEdgeWrapSafeZoneRectPx(phoneBack);

  const sourceCrop = resolveEdgeWrapSourceCrop(view, blank ?? mask);
  let imageDraw = phoneBack;
  if (blank && sourceCrop) {
    const iw = blank.naturalWidth || blank.width;
    const ih = blank.naturalHeight || blank.height;
    const relX = sourceCrop.x / Math.max(iw, 1);
    const relY = sourceCrop.y / Math.max(ih, 1);
    const relW = sourceCrop.width / Math.max(iw, 1);
    const relH = sourceCrop.height / Math.max(ih, 1);
    imageDraw = {
      x: phoneBack.x - (relX / Math.max(relW, 1e-6)) * phoneBack.width,
      y: phoneBack.y - (relY / Math.max(relH, 1e-6)) * phoneBack.height,
      width: phoneBack.width / Math.max(relW, 1e-6),
      height: phoneBack.height / Math.max(relH, 1e-6),
    };
  }

  return {
    previewW,
    previewH,
    printCanvas,
    phoneBack,
    safeZone,
    imageDraw,
    sourceCrop,
  };
}

export { PRINT_CANVAS_GREY };

/**
 * Coordinate system for placement + print-file bake.
 * Edge-wrap: full print canvas. Apparel: visible print rect on mockup.
 */
export function flatPlacementRectPx(
  view: FlatViewCalibration,
  mask: HTMLImageElement | null,
  canvasW: number,
  canvasH: number,
  opts: { edgeWrapMode?: boolean; decorMode?: boolean },
): Rect {
  if (opts.edgeWrapMode) {
    return flatPrintCanvasLayout(view).printCanvas;
  }
  return flatVisibleRectPx(view, canvasW, canvasH);
}

/** Edge-wrap overlay guides: outer = print canvas, inner = safe zone. */
export function flatEdgeWrapGuideRects(view: FlatViewCalibration): { inner: Rect; outer: Rect } {
  const layout = flatPrintCanvasLayout(view);
  return { inner: layout.safeZone, outer: layout.printCanvas };
}

/** @deprecated Legacy viewport crop — use flatPrintCanvasLayout. */
export type FlatEdgeWrapViewportLayout = {
  backFace: Rect;
  placementRect: Rect;
  guides: { inner: Rect; outer: Rect };
};

/** @deprecated Use flatPrintCanvasLayout — kept for legacy manifest fallback. */
export function flatEdgeWrapViewportLayout(
  view: FlatViewCalibration,
  _mask: HTMLImageElement | null,
  _canvasW: number,
  _canvasH: number,
): FlatEdgeWrapViewportLayout | null {
  const layout = flatPrintCanvasLayout(view);
  return {
    backFace: layout.phoneBack,
    placementRect: layout.printCanvas,
    guides: { inner: layout.safeZone, outer: layout.printCanvas },
  };
}

/**
 * Artwork bounding box (mockup px) for a given placement. Baseline (scale=1)
 * = the smallest uniform scale that fully COVERS the rect, so reducing scale
 * reveals garment at the edges (the coverage warning's trigger).
 */
export function flatArtBox(
  rect: Rect,
  placement: ArtworkPlacement,
  artW: number,
  artH: number,
): Rect {
  const aspectSafeW = artW > 0 ? artW : 1;
  const aspectSafeH = artH > 0 ? artH : 1;
  const cover = Math.max(rect.width / aspectSafeW, rect.height / aspectSafeH);
  const k = cover * placement.scale;
  const drawW = aspectSafeW * k;
  const drawH = aspectSafeH * k;
  const cx = rect.x + rect.width * (0.5 + placement.offsetX);
  const cy = rect.y + rect.height * (0.5 + placement.offsetY);
  return { x: cx - drawW / 2, y: cy - drawH / 2, width: drawW, height: drawH };
}

/** True when the artwork box fully covers the print rect (no garment edges). */
export function flatCovers(rect: Rect, box: Rect): boolean {
  const eps = 0.5;
  return (
    box.x <= rect.x + eps &&
    box.y <= rect.y + eps &&
    box.x + box.width >= rect.x + rect.width - eps &&
    box.y + box.height >= rect.y + rect.height - eps
  );
}

/** True when artwork extends past the print rect — mask clip will trim edges. */
export function flatOverflows(rect: Rect, box: Rect): boolean {
  const eps = 1;
  return (
    box.x < rect.x - eps ||
    box.y < rect.y - eps ||
    box.x + box.width > rect.x + rect.width + eps ||
    box.y + box.height > rect.y + rect.height + eps
  );
}

/**
 * Edge-wrap products: artwork must extend past the safe back-face zone so edges
 * receive print. True when any edge of the artwork box stops short of the safe zone.
 */
export function flatInsufficientSafeZoneCoverage(safeZone: Rect, box: Rect): boolean {
  const bleed = 1.5;
  return (
    box.x > safeZone.x + bleed ||
    box.y > safeZone.y + bleed ||
    box.x + box.width < safeZone.x + safeZone.width - bleed ||
    box.y + box.height < safeZone.y + safeZone.height - bleed
  );
}

/** @deprecated Use flatInsufficientSafeZoneCoverage */
export function flatInsufficientEdgeWrap(rect: Rect, box: Rect): boolean {
  return flatInsufficientSafeZoneCoverage(rect, box);
}

/**
 * Alpha bounding box of a mask / image (mockup px). Returns `null` when the
 * image is empty or pixel reads fail (tainted canvas).
 */
export function flatImageAlphaBounds(
  img: HTMLImageElement,
  alphaThreshold = 10,
): Rect | null {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (w <= 0 || h <= 0) return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] > alphaThreshold) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX) return null;
    return {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };
  } catch {
    return null;
  }
}

type NormRect = { x: number; y: number; width: number; height: number };

/** Side-profile phone models (14/15+) — fallback when mask valley detection is ambiguous. */
export function looksLikeSideProfilePhoneModel(sizeId: string): boolean {
  const n = sizeId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    /iphone-(1[4-9]|[2-9][0-9])/.test(n) ||
    /-(14|15|16|17)(-pro|-plus|-pro-max|-max|-air)?(\b|$)/.test(n)
  );
}

function backFaceRectFromMaskAlpha(
  data: Uint8ClampedArray,
  imgW: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): Rect {
  const bw = maxX - minX + 1;
  const colFill = new Float32Array(bw);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (data[(y * imgW + x) * 4 + 3] > 10) colFill[x - minX]++;
    }
  }
  const maxFill = Math.max(...colFill, 1);

  // Side strip lives in the right ~25% — scan there for a column-density valley.
  const scanStart = Math.floor(bw * 0.55);
  let splitCol: number | null = null;
  let minVal = Infinity;
  for (let i = scanStart; i < bw - 2; i++) {
    const v = colFill[i];
    if (v < minVal) {
      minVal = v;
      splitCol = i;
    }
  }

  let backWidth = bw;
  if (splitCol !== null && splitCol > scanStart) {
    let before = 0;
    let after = 0;
    for (let i = 0; i < splitCol; i++) before += colFill[i];
    for (let i = splitCol; i < bw; i++) after += colFill[i];
    if (after >= maxFill * 2 && before > after * 1.15 && splitCol < Math.floor(bw * 0.93)) {
      backWidth = splitCol;
    }
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(1, backWidth),
    height: maxY - minY + 1,
  };
}

/**
 * Detect the flat back panel on phone mockups that include a perspective side
 * strip. Column-density valley detection — row-median width spans back+side.
 */
export function detectEdgeWrapBackFaceFromMask(mask: HTMLImageElement): Rect | null {
  const w = mask.naturalWidth || mask.width;
  const h = mask.naturalHeight || mask.height;
  if (w <= 0 || h <= 0) return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  let data: Uint8ClampedArray;
  try {
    ctx.drawImage(mask, 0, 0, w, h);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return null;

  return backFaceRectFromMaskAlpha(data, w, minX, minY, maxX, maxY);
}

/** Back-face crop rect in mockup px (excludes side-profile strip when present). */
export function flatBackFaceCropRectPx(
  view: FlatViewCalibration,
  mask: HTMLImageElement | null,
  canvasW: number,
  canvasH: number,
): Rect | null {
  const fromMask = mask ? detectEdgeWrapBackFaceFromMask(mask) : null;
  const stored = normalizedRectPx(
    view.backFaceCropNormalized as NormRect | null | undefined,
    canvasW,
    canvasH,
  );
  if (fromMask) return fromMask;
  return stored;
}

export function offsetRectByCrop(rect: Rect, crop: Rect): Rect {
  return {
    x: rect.x - crop.x,
    y: rect.y - crop.y,
    width: rect.width,
    height: rect.height,
  };
}

/** Crop a rendered mockup canvas to a sub-rect (used for phone back-face previews). */
export function cropCanvasToRect(source: HTMLCanvasElement, crop: Rect): void {
  const w = Math.max(1, Math.round(crop.width));
  const h = Math.max(1, Math.round(crop.height));
  const sx = Math.max(0, Math.round(crop.x));
  const sy = Math.max(0, Math.round(crop.y));
  const ctx = source.getContext("2d");
  if (!ctx || source.width <= 0 || source.height <= 0) return;
  const imageData = ctx.getImageData(sx, sy, w, h);
  source.width = w;
  source.height = h;
  ctx.putImageData(imageData, 0, 0);
}

/**
 * True when the harvested mask includes a perspective side strip (iPhone 14/15
 * style). Back-only mockups (e.g. iPhone 11) return false — no viewport crop.
 */
export function flatEdgeWrapHasSideProfileStrip(
  view: FlatViewCalibration,
  mask: HTMLImageElement | null,
  canvasW: number,
  canvasH: number,
  sizeId?: string,
): boolean {
  const maskBbox =
    mask ? flatImageAlphaBounds(mask) : normalizedRectPx(view.printBoundsNormalized, canvasW, canvasH);
  const back = flatBackFaceCropRectPx(view, mask, canvasW, canvasH);
  if (!back || !maskBbox) {
    return !!(sizeId && looksLikeSideProfilePhoneModel(sizeId));
  }
  const stripRight = maskBbox.x + maskBbox.width - (back.x + back.width);
  if (stripRight >= Math.max(10, maskBbox.width * 0.04)) return true;
  if (back.width < maskBbox.width * 0.88) return true;
  return !!(sizeId && looksLikeSideProfilePhoneModel(sizeId));
}

function drawImageRegion(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  src: Rect,
  destW: number,
  destH: number,
): void {
  ctx.drawImage(img, src.x, src.y, src.width, src.height, 0, 0, destW, destH);
}

function regionToCanvas(
  img: HTMLImageElement,
  region: Rect,
  outW: number,
  outH: number,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = outW;
  c.height = outH;
  const cx = c.getContext("2d");
  if (cx) drawImageRegion(cx, img, region, outW, outH);
  return c;
}

/** Full printable unwrap bounds in print-canvas preview space. */
export function flatPrintBoundsPx(view: FlatViewCalibration): Rect {
  return flatPrintCanvasLayout(view).printCanvas;
}

/** @deprecated Prefer `edgeWrapMode` prop — shading map alone mis-classifies apparel. */
export function flatIsEdgeWrapView(view: FlatViewCalibration): boolean {
  return view.shadingMode === "map";
}

/**
 * Build a complete `MeshGrid` (mockup-px target points) from the manifest's
 * mesh nodes. Returns `null` when the grid is incomplete (we then fall back to
 * a flat blit), so we never warp through a malformed mesh.
 */
function buildMeshGrid(
  view: FlatViewCalibration,
  scaleX: number,
  scaleY: number,
  source: Rect,
): MeshGrid | null {
  const grid = view.meshGrid;
  const nodes = view.meshNodes;
  if (!grid || !nodes || nodes.length === 0) return null;
  const { cols, rows } = grid;
  if (cols < 2 || rows < 2) return null;
  const targetPoints: Pt[] = new Array(cols * rows);
  let filled = 0;
  for (const n of nodes) {
    if (n.row < 0 || n.row >= rows || n.col < 0 || n.col >= cols) continue;
    const idx = n.row * cols + n.col;
    if (!targetPoints[idx]) filled += 1;
    targetPoints[idx] = { x: n.px.x * scaleX, y: n.px.y * scaleY };
  }
  // Require a complete grid — partial grids produce torn warps. Mesh products
  // with missing nodes gracefully fall back to the flat blit path.
  if (filled !== cols * rows) return null;
  return {
    cols,
    rows,
    sourceRect: { x: source.x, y: source.y, width: source.width, height: source.height },
    targetPoints,
  };
}

/**
 * Normalize a grayscale shading layer in place into a multiply factor map:
 * `factor = clamp(luminance / maskedMean, MIN, 1)`. Mean → 1 (neutral), so
 * only relative shadows darken the artwork. Restricted to `artLayer`'s alpha
 * so we don't measure the studio background. Throws on tainted canvases — the
 * caller falls back to a gentler blend.
 */
function normalizeShadeInPlace(
  shadeCtx: CanvasRenderingContext2D,
  artCtx: CanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  const shade = shadeCtx.getImageData(0, 0, w, h);
  const art = artCtx.getImageData(0, 0, w, h);
  const sd = shade.data;
  const ad = art.data;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < ad.length; i += 4) {
    if (ad[i + 3] > 10) {
      sum += 0.299 * sd[i] + 0.587 * sd[i + 1] + 0.114 * sd[i + 2];
      n += 1;
    }
  }
  const mean = n > 0 ? sum / n : 128;
  const safeMean = mean > 1 ? mean : 1;
  for (let i = 0; i < sd.length; i += 4) {
    const lum = 0.299 * sd[i] + 0.587 * sd[i + 1] + 0.114 * sd[i + 2];
    let factor = lum / safeMean;
    if (factor > 1) factor = 1;
    if (factor < SHADE_FACTOR_MIN) factor = SHADE_FACTOR_MIN;
    const g = Math.round(factor * 255);
    sd[i] = g;
    sd[i + 1] = g;
    sd[i + 2] = g;
    sd[i + 3] = 255;
  }
  shadeCtx.putImageData(shade, 0, 0);
}

/**
 * Phone-case grey-map shading: overlay for overall form plus a specular pass so
 * bright areas in the Printify grey pass read as plastic sheen (multiply
 * normalize clamps highlights away).
 */
function applyPhoneCaseMapShading(
  artCanvas: HTMLCanvasElement,
  artCtx: CanvasRenderingContext2D,
  shading: HTMLImageElement | HTMLCanvasElement,
  w: number,
  h: number,
): void {
  const shade = document.createElement("canvas");
  shade.width = w;
  shade.height = h;
  const sctx = shade.getContext("2d");
  if (!sctx) return;

  sctx.drawImage(shading, 0, 0, w, h);
  sctx.globalCompositeOperation = "destination-in";
  sctx.drawImage(artCanvas, 0, 0);
  sctx.globalCompositeOperation = "source-over";

  artCtx.save();
  artCtx.globalCompositeOperation = "overlay";
  artCtx.globalAlpha = 0.88;
  artCtx.drawImage(shade, 0, 0);

  try {
    const data = sctx.getImageData(0, 0, w, h);
    const spec = document.createElement("canvas");
    spec.width = w;
    spec.height = h;
    const spCtx = spec.getContext("2d");
    if (spCtx) {
      const out = spCtx.createImageData(w, h);
      let sum = 0;
      let n = 0;
      const lumAt = (i: number) =>
        0.299 * data.data[i] + 0.587 * data.data[i + 1] + 0.114 * data.data[i + 2];
      for (let i = 0; i < data.data.length; i += 4) {
        if (data.data[i + 3] > 10) {
          sum += lumAt(i);
          n += 1;
        }
      }
      const mean = n > 0 ? sum / n : 140;
      const threshold = mean + 14;
      for (let i = 0; i < data.data.length; i += 4) {
        if (data.data[i + 3] < 10) continue;
        const l = lumAt(i);
        if (l > threshold) {
          const t = Math.min(1, (l - threshold) / Math.max(1, 255 - threshold));
          const v = Math.round(200 + t * 55);
          out.data[i] = v;
          out.data[i + 1] = v;
          out.data[i + 2] = v;
          out.data[i + 3] = Math.round(t * 160);
        }
      }
      spCtx.putImageData(out, 0, 0);
      artCtx.globalCompositeOperation = "screen";
      artCtx.globalAlpha = 1;
      artCtx.drawImage(spec, 0, 0);
    }
  } catch {
    artCtx.globalCompositeOperation = "soft-light";
    artCtx.globalAlpha = 0.35;
    artCtx.drawImage(shade, 0, 0);
  }
  artCtx.restore();
}

/**
 * Multiply a normalized shading layer over the artwork layer, restricted to
 * the artwork's own alpha so transparent (garment) pixels stay untouched.
 *
 * When `fabricWeave` is set (tapestry): simple coloured blank multiply only —
 * no procedural weave grid. Printify's photo mockup is available on demand.
 */
function applyShading(
  artCanvas: HTMLCanvasElement,
  artCtx: CanvasRenderingContext2D,
  mode: "blank" | "map",
  blank: HTMLImageElement,
  shading: HTMLImageElement | null,
  w: number,
  h: number,
  artworkCorsClean: boolean,
  opts?: { phoneCaseMap?: boolean; fabricWeave?: boolean },
): void {
  if (opts?.fabricWeave) {
    applySimpleBlankMultiply(artCanvas, artCtx, blank, w, h);
    return;
  }

  if (mode === "map" && shading && opts?.phoneCaseMap) {
    applyPhoneCaseMapShading(artCanvas, artCtx, shading, w, h);
    return;
  }

  const shade = document.createElement("canvas");
  shade.width = w;
  shade.height = h;
  const sctx = shade.getContext("2d");
  if (!sctx) return;

  if (mode === "map" && shading) {
    sctx.drawImage(shading, 0, 0, w, h);
  } else {
    // Garment's own luminance.
    sctx.filter = "grayscale(1)";
    sctx.drawImage(blank, 0, 0, w, h);
    sctx.filter = "none";
  }

  let normalized = artworkCorsClean;
  if (artworkCorsClean) {
    try {
      normalizeShadeInPlace(sctx, artCtx, w, h);
    } catch {
      // Tainted canvas (cross-origin artwork without CORS) — skip the pixel
      // normalize and apply the raw layer gently below.
      normalized = false;
    }
  }

  // Restrict the shading to the artwork alpha so we don't paint garment areas.
  sctx.globalCompositeOperation = "destination-in";
  sctx.drawImage(artCanvas, 0, 0);
  sctx.globalCompositeOperation = "source-over";

  artCtx.save();
  if (normalized) {
    artCtx.globalCompositeOperation = "multiply";
    artCtx.drawImage(shade, 0, 0);
  } else {
    // Fallback: soft-light treats mid-gray as neutral without needing pixel
    // reads, at reduced strength so we never crush the artwork.
    artCtx.globalCompositeOperation = "soft-light";
    artCtx.globalAlpha = 0.6;
    artCtx.drawImage(shade, 0, 0);
  }
  artCtx.restore();
}

/** Solidified clip masks, cached per mask image + output size (render-time cost ~0). */
const solidMaskCache = new WeakMap<HTMLImageElement, { key: string; canvas: HTMLCanvasElement }>();

/**
 * Close pinhole noise in a harvested print mask before destination-in clipping.
 * Dilates by unioning offset draws (fills holes ≤ ~4px), then re-stamps the
 * result to saturate semi-transparent alpha. Pure draw calls — no getImageData.
 */
function solidifyMaskForClip(
  mask: HTMLImageElement,
  w: number,
  h: number,
): HTMLCanvasElement {
  const key = `${w}x${h}`;
  const cached = solidMaskCache.get(mask);
  if (cached && cached.key === key) return cached.canvas;

  const union = document.createElement("canvas");
  union.width = w;
  union.height = h;
  const uctx = union.getContext("2d");
  if (!uctx) return union;
  // Union of offset stamps — closes gaps smaller than the offset radius.
  const r = 2;
  for (let dy = -r; dy <= r; dy += r) {
    for (let dx = -r; dx <= r; dx += r) {
      uctx.drawImage(mask, dx, dy, w, h);
    }
  }

  const solid = document.createElement("canvas");
  solid.width = w;
  solid.height = h;
  const sctx = solid.getContext("2d");
  if (!sctx) return union;
  // Re-stamping saturates alpha: a' = 1-(1-a)^4 → speckly 0.5 alpha becomes ~0.94.
  for (let i = 0; i < 4; i++) sctx.drawImage(union, 0, 0);

  solidMaskCache.set(mask, { key, canvas: solid });
  return solid;
}

/**
 * Clip the offscreen artwork layer to the printable area.
 * Prefer the pixel mask when present; otherwise hard-clip to `rect` (wall-decal
 * catalog blanks skip the shared harvest mask but still need side/top trim).
 */
export function clipFlatArtToPrintArea(
  actx: CanvasRenderingContext2D,
  opts: {
    mask: HTMLImageElement | null;
    rect: Rect;
    canvasW: number;
    canvasH: number;
    fabricWeave?: boolean;
  },
): "mask" | "rect" {
  const { mask, rect, canvasW, canvasH, fabricWeave } = opts;
  actx.globalCompositeOperation = "destination-in";
  if (mask) {
    if (fabricWeave) {
      actx.drawImage(solidifyMaskForClip(mask, canvasW, canvasH), 0, 0);
    } else {
      actx.drawImage(mask, 0, 0, canvasW, canvasH);
    }
    actx.globalCompositeOperation = "source-over";
    return "mask";
  }
  actx.fillStyle = "#fff";
  actx.fillRect(rect.x, rect.y, rect.width, rect.height);
  actx.globalCompositeOperation = "source-over";
  return "rect";
}

// ---------------------------------------------------------------------------
// Fabric weave texture — tunable config
// ---------------------------------------------------------------------------

export type WeaveConfig = {
  /** Horizontal (weft) yarn thickness range, px in the tile. */
  weftMin: number;
  weftMax: number;
  /** Vertical (warp) yarn thickness range, px in the tile. */
  warpMin: number;
  warpMax: number;
  /** Pattern scale multiplier on the rendered mockup (bigger = coarser). */
  scale: number;
  /** Per-yarn brightness variation (slub / thread irregularity), 0–60. */
  slub: number;
  /** Extra per-cell brightness wobble, 0–40. */
  cellNoise: number;
  /** Groove tone 0–128 — lower = darker crosshatch lines. */
  grooveTone: number;
  /** Thread highlight tone 128–255 — higher = shinier ridges. */
  ridgeTone: number;
  /** Overlay pass strength 0–1 (texture contrast). */
  overlayAlpha: number;
  /** Multiply pass strength 0–1 (overall darkening). */
  multiplyAlpha: number;
};

// Tuned against Printify woven tapestry mockups (bp 1649) — coarse knot grid,
// strong micro-contrast in both lights and darks (2026-07).
export const DEFAULT_WEAVE_CONFIG: WeaveConfig = {
  weftMin: 4,
  weftMax: 8,
  warpMin: 6,
  warpMax: 11,
  scale: 0.95,
  slub: 70,
  cellNoise: 22,
  grooveTone: 62,
  ridgeTone: 198,
  overlayAlpha: 0.62,
  multiplyAlpha: 0.72,
};

/** Bump when defaults change so stale admin localStorage does not keep a fine weave. */
const WEAVE_STORAGE_KEY = "appai:weaveConfig:v3";

let activeWeaveConfig: WeaveConfig | null = null;

function loadStoredWeaveConfig(): WeaveConfig {
  try {
    const raw = window.localStorage.getItem(WEAVE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return { ...DEFAULT_WEAVE_CONFIG, ...parsed };
      }
    }
  } catch {
    // Storage unavailable (partitioned iframe / privacy mode) — use defaults.
  }
  return { ...DEFAULT_WEAVE_CONFIG };
}

export function getWeaveConfig(): WeaveConfig {
  if (!activeWeaveConfig) activeWeaveConfig = loadStoredWeaveConfig();
  return activeWeaveConfig;
}

/** Update weave settings (admin tuning panel). Persists per-browser and
 *  invalidates the cached tile so the next render uses the new values. */
export function setWeaveConfig(patch: Partial<WeaveConfig>): WeaveConfig {
  activeWeaveConfig = { ...getWeaveConfig(), ...patch };
  fabricWeaveTile = null;
  try {
    window.localStorage.setItem(WEAVE_STORAGE_KEY, JSON.stringify(activeWeaveConfig));
  } catch {
    // Persistence is best-effort; in-memory config still applies this session.
  }
  return activeWeaveConfig;
}

export function resetWeaveConfig(): WeaveConfig {
  activeWeaveConfig = { ...DEFAULT_WEAVE_CONFIG };
  fabricWeaveTile = null;
  try {
    window.localStorage.removeItem(WEAVE_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
  return activeWeaveConfig;
}

/** Cached weave tile — regenerated when the config changes. */
let fabricWeaveTile: HTMLCanvasElement | null = null;

/** Deterministic PRNG so the weave looks identical on every render/session. */
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Irregular plain-weave tile centred on neutral gray for overlay blending:
 * values above 128 lift thread tops (visible in dark art), values below 128
 * cut grooves (visible in light art). Yarn thickness and brightness vary per
 * thread (linen-style slubs) so it reads as woven fabric, not a printed grid.
 */
function getFabricWeaveTile(cfg: WeaveConfig): HTMLCanvasElement {
  if (fabricWeaveTile) return fabricWeaveTile;
  const size = 160;
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const ctx = tile.getContext("2d");
  if (!ctx) return tile;

  const rand = makeLcg(0x5eed);

  // Irregular yarn bands; last band absorbs the remainder so the tile wraps.
  const makeBands = (minW: number, maxW: number) => {
    const lo = Math.max(2, Math.round(Math.min(minW, maxW)));
    const hi = Math.max(lo, Math.round(Math.max(minW, maxW)));
    const bands: { start: number; width: number; tone: number }[] = [];
    let pos = 0;
    while (pos < size) {
      let w = lo + Math.floor(rand() * (hi - lo + 1));
      if (size - pos < lo || pos + w > size) w = size - pos;
      // Per-yarn brightness wobble — slub/thickness variation along the cloth.
      bands.push({ start: pos, width: w, tone: (rand() - 0.5) * cfg.slub });
      pos += w;
    }
    return bands;
  };
  const rows = makeBands(cfg.weftMin, cfg.weftMax); // horizontal yarns
  const cols = makeBands(cfg.warpMin, cfg.warpMax); // vertical yarns

  const gray = (v: number) => {
    const c = Math.max(0, Math.min(255, Math.round(v)));
    return `rgb(${c},${c},${c})`;
  };

  for (let ri = 0; ri < rows.length; ri++) {
    for (let ci = 0; ci < cols.length; ci++) {
      const row = rows[ri];
      const col = cols[ci];
      const x = col.start;
      const y = row.start;
      const warpOnTop = (ri + ci) % 2 === 0;
      const slub = (row.tone + col.tone) / 2 + (rand() - 0.5) * cfg.cellNoise;

      // Yarn body: raised yarn catches light, recessed yarn sits lower.
      ctx.fillStyle = gray((warpOnTop ? 146 : 118) + slub);
      ctx.fillRect(x, y, col.width, row.width);

      // Bright ridge along the raised yarn — jittered so ridges don't align.
      ctx.fillStyle = gray(cfg.ridgeTone + slub);
      if (warpOnTop) {
        const ry = y + 1 + Math.floor(rand() * Math.max(1, row.width - 2));
        ctx.fillRect(x + 1, ry, Math.max(1, col.width - 2), 1);
      } else {
        const rx = x + 1 + Math.floor(rand() * Math.max(1, col.width - 2));
        ctx.fillRect(rx, y + 1, 1, Math.max(1, row.width - 2));
      }

      // Deep grooves between yarns — darkness varies per cell.
      ctx.fillStyle = gray(cfg.grooveTone + (rand() - 0.5) * 24);
      if (warpOnTop) {
        ctx.fillRect(x, y, 1, row.width);
        ctx.fillRect(x + col.width - 1, y, 1, row.width);
      } else {
        ctx.fillRect(x, y, col.width, 1);
        ctx.fillRect(x, y + row.width - 1, col.width, 1);
      }
    }
  }

  fabricWeaveTile = tile;
  return tile;
}

/** Real tapestry blank × art — no procedural weave / no blur stack. */
function applySimpleBlankMultiply(
  artCanvas: HTMLCanvasElement,
  artCtx: CanvasRenderingContext2D,
  blank: HTMLImageElement,
  w: number,
  h: number,
): void {
  const cloth = document.createElement("canvas");
  cloth.width = w;
  cloth.height = h;
  const cctx = cloth.getContext("2d");
  if (!cctx) return;
  cctx.drawImage(blank, 0, 0, w, h);
  cctx.globalCompositeOperation = "destination-in";
  cctx.drawImage(artCanvas, 0, 0);
  cctx.globalCompositeOperation = "source-over";

  artCtx.save();
  artCtx.globalCompositeOperation = "multiply";
  artCtx.drawImage(cloth, 0, 0);
  artCtx.restore();
}

/**
 * Emboss art with a tiled warp/weft pattern. Two passes:
 * overlay (texture contrast — highlights in shadow, grooves in light) then
 * multiply (overall fabric darkening to match Printify renders).
 * Instant: one cached tile, no network, no getImageData.
 *
 * `strengthScale` damps both passes when blank multiply already supplies body shading.
 */
function applyProceduralFabricWeave(
  artCanvas: HTMLCanvasElement,
  artCtx: CanvasRenderingContext2D,
  w: number,
  h: number,
  opts?: { strengthScale?: number },
): void {
  const cfg = getWeaveConfig();
  const strength = Math.max(0, Math.min(1, opts?.strengthScale ?? 1));
  if (strength <= 0) return;

  const tile = getFabricWeaveTile(cfg);
  const weave = document.createElement("canvas");
  weave.width = w;
  weave.height = h;
  const wctx = weave.getContext("2d");
  if (!wctx) return;

  const scale = Math.max(0.25, cfg.scale);
  const pattern = wctx.createPattern(tile, "repeat");
  if (!pattern) return;
  wctx.save();
  wctx.scale(scale, scale);
  wctx.fillStyle = pattern;
  wctx.fillRect(0, 0, w / scale + 1, h / scale + 1);
  wctx.restore();

  wctx.globalCompositeOperation = "destination-in";
  wctx.drawImage(artCanvas, 0, 0);
  wctx.globalCompositeOperation = "source-over";

  artCtx.save();
  // Pass 1: overlay — yarn ridges/grooves visible in both light and dark art.
  artCtx.globalCompositeOperation = "overlay";
  artCtx.globalAlpha = Math.max(0, Math.min(1, cfg.overlayAlpha * strength));
  artCtx.drawImage(weave, 0, 0);
  // Pass 2: hard-light — Printify-like knot micro-contrast (breaks up flats).
  artCtx.globalCompositeOperation = "hard-light";
  artCtx.globalAlpha = Math.max(0, Math.min(1, 0.35 * strength));
  artCtx.drawImage(weave, 0, 0);
  // Pass 3: multiply — fabric absorbs light, matching Printify's heavier blend.
  artCtx.globalCompositeOperation = "multiply";
  artCtx.globalAlpha = Math.max(0, Math.min(1, cfg.multiplyAlpha * strength));
  artCtx.drawImage(weave, 0, 0);
  artCtx.restore();
}

function scaleRectAroundCenter(rect: Rect, scale: number): Rect {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const w = rect.width * scale;
  const h = rect.height * scale;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

type DrawAssetScaledFn = (
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dest: Rect,
  opts?: { refW?: number; refH?: number; useCrop?: boolean },
) => void;

/** Draw harvested mask into output space (same mapping as clipMaskToDest). */
function drawEdgeWrapMaskAt(
  ctx: CanvasRenderingContext2D,
  mask: HTMLImageElement,
  dest: Rect,
  view: FlatViewCalibration,
  maskAligned: boolean,
  crop: Rect | null | undefined,
  drawAssetScaled: DrawAssetScaledFn,
): void {
  if (maskAligned) {
    drawAssetScaled(ctx, mask, dest, { useCrop: true });
  } else {
    const mw = mask.naturalWidth || mask.width;
    const mh = mask.naturalHeight || mask.height;
    const maskCrop = resolveEdgeWrapSourceCrop(view, mask);
    if (maskCrop && mw > 0 && mh > 0) {
      ctx.drawImage(
        mask,
        maskCrop.x,
        maskCrop.y,
        maskCrop.width,
        maskCrop.height,
        dest.x,
        dest.y,
        dest.width,
        dest.height,
      );
    } else if (mw > 0 && mh > 0) {
      ctx.drawImage(mask, 0, 0, mw, mh, dest.x, dest.y, dest.width, dest.height);
    }
  }
}

/**
 * Mask pixels that are transparent but not connected to the canvas border
 * (camera cutouts), plus a thin outer rim ring. Avoids square phoneBack rects.
 */
function buildBlankHardwarePunchMask(
  outW: number,
  outH: number,
  mask: HTMLImageElement,
  maskDraw: Rect,
  view: FlatViewCalibration,
  maskAligned: boolean,
  crop: Rect | null | undefined,
  drawAssetScaled: DrawAssetScaledFn,
): HTMLCanvasElement | null {
  const alphaCanvas = document.createElement("canvas");
  alphaCanvas.width = outW;
  alphaCanvas.height = outH;
  const actx = alphaCanvas.getContext("2d");
  if (!actx) return null;
  drawEdgeWrapMaskAt(actx, mask, maskDraw, view, maskAligned, crop, drawAssetScaled);

  let data: ImageData;
  try {
    data = actx.getImageData(0, 0, outW, outH);
  } catch {
    return null;
  }

  const n = outW * outH;
  const isTransparent = (idx: number) => data.data[idx * 4 + 3] <= 10;
  const exterior = new Uint8Array(n);
  const queue: number[] = [];
  const pushIfExterior = (x: number, y: number) => {
    if (x < 0 || x >= outW || y < 0 || y >= outH) return;
    const idx = y * outW + x;
    if (exterior[idx] || !isTransparent(idx)) return;
    exterior[idx] = 1;
    queue.push(idx);
  };
  for (let x = 0; x < outW; x++) {
    pushIfExterior(x, 0);
    pushIfExterior(x, outH - 1);
  }
  for (let y = 0; y < outH; y++) {
    pushIfExterior(0, y);
    pushIfExterior(outW - 1, y);
  }
  while (queue.length > 0) {
    const idx = queue.pop()!;
    const x = idx % outW;
    const y = (idx / outW) | 0;
    pushIfExterior(x - 1, y);
    pushIfExterior(x + 1, y);
    pushIfExterior(x, y - 1);
    pushIfExterior(x, y + 1);
  }

  const punchMask = document.createElement("canvas");
  punchMask.width = outW;
  punchMask.height = outH;
  const pmCtx = punchMask.getContext("2d");
  if (!pmCtx) return null;
  const punchData = pmCtx.createImageData(outW, outH);
  for (let idx = 0; idx < n; idx++) {
    if (isTransparent(idx) && !exterior[idx]) {
      const o = idx * 4;
      punchData.data[o] = 255;
      punchData.data[o + 1] = 255;
      punchData.data[o + 2] = 255;
      punchData.data[o + 3] = 255;
    }
  }
  pmCtx.putImageData(punchData, 0, 0);

  // Thin outer rim — case bevel over artwork. Keep tiny so corners don't look like
  // missing art where plastic reflections should read instead.
  const outerDraw = scaleRectAroundCenter(maskDraw, 1.003);
  pmCtx.globalCompositeOperation = "source-over";
  pmCtx.fillStyle = "#ffffff";
  drawEdgeWrapMaskAt(pmCtx, mask, outerDraw, view, maskAligned, crop, drawAssetScaled);
  pmCtx.globalCompositeOperation = "destination-out";
  drawEdgeWrapMaskAt(pmCtx, mask, maskDraw, view, maskAligned, crop, drawAssetScaled);

  return punchMask;
}

/**
 * Redraw blank on top of art for camera cutouts and the outer case lip.
 * Printable mask regions stay art-only; holes + rim show the blank photo again.
 */
function compositeBlankHardwareOnTop(
  ctx: CanvasRenderingContext2D,
  layout: FlatPrintCanvasLayout,
  blank: HTMLImageElement,
  mask: HTMLImageElement,
  blankDraw: Rect,
  maskDraw: Rect,
  view: FlatViewCalibration,
  maskAligned: boolean,
  crop: Rect | null | undefined,
  maskRefW: number,
  maskRefH: number,
  blankRefW: number,
  blankRefH: number,
  drawAssetScaled: DrawAssetScaledFn,
): void {
  const outW = layout.previewW;
  const outH = layout.previewH;

  const punchMask = buildBlankHardwarePunchMask(
    outW,
    outH,
    mask,
    maskDraw,
    view,
    maskAligned,
    crop,
    drawAssetScaled,
  );
  if (!punchMask) return;

  const hwLayer = document.createElement("canvas");
  hwLayer.width = outW;
  hwLayer.height = outH;
  const hwCtx = hwLayer.getContext("2d");
  if (!hwCtx) return;
  drawAssetScaled(hwCtx, blank, blankDraw, {
    refW: maskAligned ? maskRefW : blankRefW,
    refH: maskAligned ? maskRefH : blankRefH,
    useCrop: !!crop,
  });
  hwCtx.globalCompositeOperation = "destination-in";
  hwCtx.drawImage(punchMask, 0, 0);
  ctx.drawImage(hwLayer, 0, 0);
}

/**
 * Composite `input` onto `input.target`. Always paints the blank base; if
 * artwork is present, draws it (flat blit or mesh warp), clips to the mask,
 * applies shading, and composites over the blank. Throws nothing it can avoid
 * — callers should still try/catch and fall back to the Printify flow.
 */
export function renderFlatView(input: FlatRenderInput): void {
  const {
    target,
    blank,
    mask,
    shading,
    artwork,
    view,
    placement,
    tier,
    artworkCorsClean = true,
    forceShadingMap = false,
    edgeWrapMode = false,
    decorMode = false,
    fabricWeave = false,
    layerAdjust,
    previewLayers,
  } = input;
  const { w: W, h: H } = imgDims(blank);
  if (W <= 0 || H <= 0) return;

  if (edgeWrapMode) {
    const layout = flatPrintCanvasLayout(view, { mask, blank });
    const outW = layout.previewW;
    const outH = layout.previewH;
    const crop = layout.sourceCrop;
    const baseDraw = layout.imageDraw;
    const blankDraw = adjustCalibratorDrawRect(baseDraw, layerAdjust?.blank, outW, outH);
    const maskDraw = adjustCalibratorDrawRect(baseDraw, layerAdjust?.mask, outW, outH);
    const shadeDraw = adjustCalibratorDrawRect(baseDraw, layerAdjust?.shading, outW, outH);
    const maskAligned = maskAlignsWithBlank(blank, mask);

    const maskRefW = mask ? (mask.naturalWidth || mask.width) : W;
    const maskRefH = mask ? (mask.naturalHeight || mask.height) : H;

    const drawAssetScaled = (
      ctx: CanvasRenderingContext2D,
      img: HTMLImageElement,
      dest: Rect,
      opts?: { refW?: number; refH?: number; useCrop?: boolean },
    ) => {
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      if (iw <= 0 || ih <= 0) return;
      const refW = opts?.refW ?? maskRefW;
      const refH = opts?.refH ?? maskRefH;
      const useCrop = opts?.useCrop ?? !!crop;
      const sx = refW > 0 ? iw / refW : 1;
      const sy = refH > 0 ? ih / refH : 1;
      if (useCrop && crop) {
        ctx.drawImage(
          img,
          crop.x * sx,
          crop.y * sy,
          crop.width * sx,
          crop.height * sy,
          dest.x,
          dest.y,
          dest.width,
          dest.height,
        );
      } else {
        ctx.drawImage(img, 0, 0, iw, ih, dest.x, dest.y, dest.width, dest.height);
      }
    };

    const clipMaskToDest = (ctx: CanvasRenderingContext2D, dest: Rect) => {
      if (!mask) return;
      ctx.globalCompositeOperation = "destination-in";
      if (maskAligned) {
        drawAssetScaled(ctx, mask, dest, { useCrop: true });
      } else {
        const mw = mask.naturalWidth || mask.width;
        const mh = mask.naturalHeight || mask.height;
        const maskCrop = resolveEdgeWrapSourceCrop(view, mask);
        if (maskCrop && mw > 0 && mh > 0) {
          ctx.drawImage(
            mask,
            maskCrop.x,
            maskCrop.y,
            maskCrop.width,
            maskCrop.height,
            dest.x,
            dest.y,
            dest.width,
            dest.height,
          );
        } else if (mw > 0 && mh > 0) {
          ctx.drawImage(mask, 0, 0, mw, mh, dest.x, dest.y, dest.width, dest.height);
        }
      }
      ctx.globalCompositeOperation = "source-over";
    };

    const showBlankLayer = previewLayers?.blank !== false;
    const showShadingLayer = previewLayers?.shading !== false;
    const showArtLayer = previewLayers?.artwork !== false && !!artwork;

    target.width = outW;
    target.height = outH;
    const ctx = target.getContext("2d");
    if (!ctx) return;

    // Step 1: Grey print-canvas fill (the "Printify grey box" bleed area).
    ctx.clearRect(0, 0, outW, outH);
    ctx.fillStyle = PRINT_CANVAS_GREY;
    ctx.fillRect(0, 0, outW, outH);

    // Step 2: Blank phone photo, clipped to the phone silhouette so the JPEG
    // white background never bleeds over the grey margins.
    if (showBlankLayer) {
      const blankLayer = document.createElement("canvas");
      blankLayer.width = outW;
      blankLayer.height = outH;
      const blCtx = blankLayer.getContext("2d");
      if (blCtx) {
        drawAssetScaled(blCtx, blank, blankDraw, {
          refW: maskAligned ? maskRefW : W,
          refH: maskAligned ? maskRefH : H,
          useCrop: !!crop,
        });
        clipMaskToDest(blCtx, maskDraw);
      }
      ctx.drawImage(blankLayer, 0, 0);
    }

    const punchBlankHardware = () => {
      if (!showBlankLayer || !mask) return;
      compositeBlankHardwareOnTop(
        ctx,
        layout,
        blank,
        mask,
        blankDraw,
        maskDraw,
        view,
        maskAligned,
        crop,
        maskRefW,
        maskRefH,
        W,
        H,
        drawAssetScaled,
      );
    };

    if (!showArtLayer || !artwork) {
      punchBlankHardware();
      return;
    }
    const { w: artW, h: artH } = imgDims(artwork);
    if (artW <= 0 || artH <= 0) return;

    const rect = layout.printCanvas;
    const art = document.createElement("canvas");
    art.width = outW;
    art.height = outH;
    const actx = art.getContext("2d");
    if (!actx) return;

    const box = flatArtBox(rect, placement, artW, artH);
    actx.drawImage(artwork, box.x, box.y, box.width, box.height);

    if (mask) {
      clipMaskToDest(actx, maskDraw);
    } else {
      const pb = layout.phoneBack;
      actx.save();
      actx.beginPath();
      actx.rect(pb.x, pb.y, pb.width, pb.height);
      actx.clip();
      actx.globalCompositeOperation = "destination-in";
      actx.fillStyle = "#fff";
      actx.fillRect(pb.x, pb.y, pb.width, pb.height);
      actx.restore();
    }

    if (showShadingLayer) {
      const shadeMode: "blank" | "map" =
        view.shadingMode === "map" || (forceShadingMap && shading) ? "map" : view.shadingMode;

      // Shading blank: same position as the clipped blank layer so luminance
      // normalization samples the correct phone surface, not white margins.
      const shadeBlankCanvas = document.createElement("canvas");
      shadeBlankCanvas.width = outW;
      shadeBlankCanvas.height = outH;
      const sbCtx = shadeBlankCanvas.getContext("2d");
      if (sbCtx) {
        drawAssetScaled(sbCtx, blank, blankDraw, {
          refW: maskAligned ? maskRefW : W,
          refH: maskAligned ? maskRefH : H,
          useCrop: !!crop,
        });
        clipMaskToDest(sbCtx, maskDraw);
      }

      let shadeMapImg: HTMLImageElement | HTMLCanvasElement | null = shading;
      if (shading) {
        const sc = document.createElement("canvas");
        sc.width = outW;
        sc.height = outH;
        const scx = sc.getContext("2d");
        if (scx) {
          drawAssetScaled(scx, shading, shadeDraw, {
            refW: maskAligned ? maskRefW : W,
            refH: maskAligned ? maskRefH : H,
            useCrop: !!crop,
          });
          clipMaskToDest(scx, maskDraw);
          shadeMapImg = sc;
        }
      }

      applyShading(
        art,
        actx,
        shadeMode,
        shadeBlankCanvas as unknown as HTMLImageElement,
        shadeMapImg as HTMLImageElement | null,
        outW,
        outH,
        artworkCorsClean,
        {
          phoneCaseMap: shadeMode === "map" && !!shadeMapImg,
          fabricWeave: fabricWeave && !edgeWrapMode,
        },
      );
    }

    ctx.drawImage(art, 0, 0);
    punchBlankHardware();
    return;
  }

  target.width = W;
  target.height = H;
  const ctx = target.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(blank, 0, 0, W, H);
  if (!artwork) return;

  const { w: artW, h: artH } = imgDims(artwork);
  if (artW <= 0 || artH <= 0) return;

  const rect = flatPlacementRectPx(view, mask, W, H, { edgeWrapMode, decorMode });

  const art = document.createElement("canvas");
  art.width = W;
  art.height = H;
  const actx = art.getContext("2d");
  if (!actx) return;

  let drewMesh = false;
  if (tier === "mesh" && view.meshNodes && view.meshNodes.length > 0) {
    const md = view.mockupDims;
    const scaleX = md && md.width > 0 ? W / md.width : 1;
    const scaleY = md && md.height > 0 ? H / md.height : 1;

    const printW = Math.max(2, Math.round(view.printFileDims.width));
    const printH = Math.max(2, Math.round(view.printFileDims.height));
    const printCanvas = document.createElement("canvas");
    printCanvas.width = printW;
    printCanvas.height = printH;
    const pctx = printCanvas.getContext("2d");
    const printRect: Rect = { x: 0, y: 0, width: printW, height: printH };
    const mesh = buildMeshGrid(view, scaleX, scaleY, printRect);
    if (pctx && mesh) {
      const box = flatArtBox(printRect, placement, artW, artH);
      pctx.drawImage(artwork, box.x, box.y, box.width, box.height);
      drawMeshWarp(actx, printCanvas, printW, printH, mesh, { inflateSeams: true });
      drewMesh = true;
    }
  }

  if (!drewMesh) {
    const box = flatArtBox(rect, placement, artW, artH);
    actx.drawImage(artwork, box.x, box.y, box.width, box.height);
  }

  clipFlatArtToPrintArea(actx, {
    mask,
    rect,
    canvasW: W,
    canvasH: H,
    fabricWeave: fabricWeave && !edgeWrapMode,
  });

  const shadeMode: "blank" | "map" =
    view.shadingMode === "map" || (forceShadingMap && shading) ? "map" : view.shadingMode;
  applyShading(
    art,
    actx,
    shadeMode,
    blank,
    shading,
    W,
    H,
    artworkCorsClean,
    {
      phoneCaseMap: shadeMode === "map" && !!shading && !!edgeWrapMode,
      fabricWeave: fabricWeave && !edgeWrapMode,
    },
  );

  ctx.drawImage(art, 0, 0);
}
