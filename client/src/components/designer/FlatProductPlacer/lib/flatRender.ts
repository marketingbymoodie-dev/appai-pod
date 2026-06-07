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

/** Lowest allowed placement scale. Cap is 1.0 (Printify clamps placement). */
export const FLAT_SCALE_MIN = 0.2;
/** Hard cap — never imply more coverage than the print file provides. */
export const FLAT_SCALE_MAX = 1.0;

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
export function flatVisibleRectPx(
  view: FlatViewCalibration,
  canvasW: number,
  canvasH: number,
): Rect {
  const vr = view.visibleRectNormalized;
  if (!vr) return { x: 0, y: 0, width: canvasW, height: canvasH };
  return {
    x: vr.x * canvasW,
    y: vr.y * canvasH,
    width: vr.width * canvasW,
    height: vr.height * canvasH,
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

  let normalized = true;
  try {
    normalizeShadeInPlace(sctx, artCtx, w, h);
  } catch {
    // Tainted canvas (cross-origin artwork without CORS) — skip the pixel
    // normalize and apply the raw layer gently below.
    normalized = false;
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
  const { target, blank, mask, shading, artwork, view, placement, tier } = input;
  const { w: W, h: H } = imgDims(blank);
  if (W <= 0 || H <= 0) return;

  target.width = W;
  target.height = H;
  const ctx = target.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(blank, 0, 0, W, H);
  if (!artwork) return;

  const { w: artW, h: artH } = imgDims(artwork);
  if (artW <= 0 || artH <= 0) return;

  const rect = flatVisibleRectPx(view, W, H);

  // Artwork layer (full canvas; clipped to mask afterwards).
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

    // Render the placed artwork into a flat "print-area" canvas, then warp the
    // whole thing through the mesh. The mesh nodes span the full placeholder
    // (xn/yn 0..1), so the source rect is the entire print canvas.
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
    // Flat blit: scale the artwork into the visible rect (cover baseline).
    const box = flatArtBox(rect, placement, artW, artH);
    actx.drawImage(artwork, box.x, box.y, box.width, box.height);
  }

  // Clip strictly to the printable silhouette.
  if (mask) {
    actx.globalCompositeOperation = "destination-in";
    actx.drawImage(mask, 0, 0, W, H);
    actx.globalCompositeOperation = "source-over";
  }

  // Shading multiply (normalized).
  applyShading(art, actx, view.shadingMode, blank, shading, W, H);

  ctx.drawImage(art, 0, 0);
}
