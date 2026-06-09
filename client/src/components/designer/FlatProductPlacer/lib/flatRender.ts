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
  sizeId?: string;
  /** Crop to back face when the mockup has a side-profile strip (iPhone 14/15). */
  cropToBackFace?: boolean;
};

function imgDims(img: HTMLImageElement): { w: number; h: number } {
  return {
    w: img.naturalWidth || img.width,
    h: img.naturalHeight || img.height,
  };
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
export function flatEdgeWrapSafeZoneRectPx(outer: Rect, insetFraction = 0.08): Rect {
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
  /** Phone back draw region (blank + mask). */
  phoneBack: Rect;
  /** Safe zone (amber dashed guide). */
  safeZone: Rect;
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

export type FlatPrintCanvasLayoutAssets = {
  mask?: HTMLImageElement | null;
  blank?: HTMLImageElement | null;
};

/**
 * Print-canvas-centric layout for edge-wrap phone cases.
 * Phone back is aspect-fit and centered inside printFileDims (Printify grey box).
 */
export function flatPrintCanvasLayout(
  view: FlatViewCalibration,
  assets?: FlatPrintCanvasLayoutAssets,
): FlatPrintCanvasLayout {
  const { width: previewW, height: previewH } = flatPrintCanvasPreviewDims(view);
  const printCanvas: Rect = { x: 0, y: 0, width: previewW, height: previewH };

  const pfW = view.printFileDims?.width ?? previewW;
  const pfH = view.printFileDims?.height ?? previewH;
  const canvasAspect = pfW / Math.max(pfH, 1);

  const maskW = assets?.mask?.naturalWidth || view.mockupDims?.width || previewW;
  const maskH = assets?.mask?.naturalHeight || view.mockupDims?.height || previewH;

  let sourceCrop: Rect | null = null;
  let contentW = maskW;
  let contentH = maskH;

  if (assets?.mask) {
    const back = detectEdgeWrapBackFaceFromMask(assets.mask);
    if (back && back.width < maskW * 0.92) {
      sourceCrop = back;
      contentW = back.width;
      contentH = back.height;
    } else if (view.sideProfileCropped) {
      contentW = maskW;
      contentH = maskH;
    }
  } else if (view.sideProfileCropped && view.backFaceCropNormalized) {
    sourceCrop = normalizedRectPx(view.backFaceCropNormalized as NormRect, maskW, maskH);
    if (sourceCrop) {
      contentW = sourceCrop.width;
      contentH = sourceCrop.height;
    }
  }

  const contentAspect = contentW / Math.max(contentH, 1);
  const phoneBackNorm = fitAspectCenteredInCanvas(contentAspect, canvasAspect);
  const phoneBack = normRectToPx(phoneBackNorm, previewW, previewH);

  const backNorm = view.backFaceCropNormalized as NormRect | null | undefined;
  const safeNorm = view.visibleRectNormalized as NormRect | null | undefined;
  let safeZone: Rect;
  if (backNorm && safeNorm && backNorm.width > 0 && backNorm.height > 0) {
    const relX = (safeNorm.x - backNorm.x) / backNorm.width;
    const relY = (safeNorm.y - backNorm.y) / backNorm.height;
    const relW = safeNorm.width / backNorm.width;
    const relH = safeNorm.height / backNorm.height;
    safeZone = {
      x: phoneBack.x + relX * phoneBack.width,
      y: phoneBack.y + relY * phoneBack.height,
      width: relW * phoneBack.width,
      height: relH * phoneBack.height,
    };
  } else {
    safeZone = flatEdgeWrapSafeZoneRectPx(phoneBack);
  }

  return {
    previewW,
    previewH,
    printCanvas,
    phoneBack,
    safeZone,
    sourceCrop,
  };
}

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
  const scanStart = Math.floor(bw * 0.72);
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
    if (after >= maxFill * 2 && before > after * 1.15) {
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
 * Multiply a normalized shading layer over the artwork layer, restricted to
 * the artwork's own alpha so transparent (garment) pixels stay untouched.
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
): void {
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
  } = input;
  const { w: W, h: H } = imgDims(blank);
  if (W <= 0 || H <= 0) return;

  if (edgeWrapMode) {
    const layout = flatPrintCanvasLayout(view, { mask, blank });
    const outW = layout.previewW;
    const outH = layout.previewH;
    const phoneBack = layout.phoneBack;
    const crop = layout.sourceCrop;

    const drawAsset = (
      ctx: CanvasRenderingContext2D,
      img: HTMLImageElement,
      iw: number,
      ih: number,
    ) => {
      if (crop) {
        ctx.drawImage(
          img,
          crop.x,
          crop.y,
          crop.width,
          crop.height,
          phoneBack.x,
          phoneBack.y,
          phoneBack.width,
          phoneBack.height,
        );
      } else {
        ctx.drawImage(img, 0, 0, iw, ih, phoneBack.x, phoneBack.y, phoneBack.width, phoneBack.height);
      }
    };

    target.width = outW;
    target.height = outH;
    const ctx = target.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, outW, outH);
    drawAsset(ctx, blank, W, H);

    if (!artwork) return;
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
      const mw = mask.naturalWidth || mask.width;
      const mh = mask.naturalHeight || mask.height;
      actx.globalCompositeOperation = "destination-in";
      drawAsset(actx, mask, mw, mh);
      actx.globalCompositeOperation = "source-over";
    }

    const shadeMode: "blank" | "map" =
      view.shadingMode === "map" || (forceShadingMap && shading) ? "map" : view.shadingMode;

    const shadeBlankCanvas = document.createElement("canvas");
    shadeBlankCanvas.width = outW;
    shadeBlankCanvas.height = outH;
    const sbCtx = shadeBlankCanvas.getContext("2d");
    if (sbCtx) drawAsset(sbCtx, blank, W, H);

    let shadeMapImg: HTMLImageElement | HTMLCanvasElement | null = shading;
    if (shading) {
      const sw = shading.naturalWidth || shading.width;
      const sh = shading.naturalHeight || shading.height;
      const sc = document.createElement("canvas");
      sc.width = outW;
      sc.height = outH;
      const scx = sc.getContext("2d");
      if (scx) {
        drawAsset(scx, shading, sw, sh);
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
    );

    ctx.drawImage(art, 0, 0);
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

  if (mask) {
    actx.globalCompositeOperation = "destination-in";
    actx.drawImage(mask, 0, 0, W, H);
    actx.globalCompositeOperation = "source-over";
  }

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
  );

  ctx.drawImage(art, 0, 0);
}
