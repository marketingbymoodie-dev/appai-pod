/**
 * AOP preview renderer — composites the customer's all-over-print artwork
 * onto a hoodie mockup using the panel masks the user just traced in the
 * Hoodie Template Mapper.
 *
 * This is the bridge that turns hand-traced polygons into a visible
 * "what the customer would actually see" preview, completely independent
 * of the older calibration-driven projection-map pipeline. It powers the
 * Preview AOP modal in the mapper UI and is the foundation that the
 * Phase 4 mesh-warp / Phase 5 production export will build on.
 *
 * Algorithm (single-sheet mode, the default):
 *
 *   1. Output canvas       =  mockup base image (with all the hoodie
 *                              graphics — zipper, shadows, drawstrings —
 *                              already baked in by the source PNG).
 *   2. Off-screen canvas   =  artwork stretched once across the union
 *                              bounding box of every print panel, then
 *                              clipped per-panel to that panel's polygon.
 *                              Every panel sees its slice of the same
 *                              continuous mural.
 *   3. Subtract exclusions  =  destination-out the exclusion polygons
 *                              from the off-screen canvas, so e.g. the
 *                              zipper region or the hood interior keeps
 *                              the original mockup pixels showing.
 *   4. Composite            =  off-screen canvas drawn on top of the
 *                              mockup base.
 *
 * Other modes:
 *   - "per-panel-stretch"  Each panel independently stretches the
 *                          full artwork to fit its own bounding box.
 *                          Useful for panel-tile AOPs (rare).
 *   - "solid-colors"       Paints each panel a distinct color from a
 *                          fixed palette. Lets the user verify mask
 *                          coverage without supplying any artwork.
 */

import type { HoodiePanelKey, HoodieTemplate, HoodieView, MaskLayer, Pt } from "@shared/hoodieTemplate";
import { layerRenderPriority } from "@shared/hoodieTemplate";
import { svgPathToAnchors } from "./svgPath";

export type AopPreviewMode = "single-sheet" | "per-panel-stretch" | "solid-colors";

export type AopPreviewParams = {
  template: HoodieTemplate;
  view: HoodieView;
  /** Mockup base image (the hoodie photo). Required. */
  mockup: HTMLImageElement;
  /**
   * The customer's AOP artwork. Optional — pass `null` to render the
   * mockup with all panels filled with their solid-color debug fills,
   * which is the easiest way to verify mask coverage without artwork.
   */
  artwork: HTMLImageElement | null;
  mode?: AopPreviewMode;
  /** When true (default), exclusion polygons punch the artwork out so the mockup pixels show through. */
  showExclusions?: boolean;
  /** When true, draw mask outlines on top of the composite so the user can see polygon boundaries. */
  showOutlines?: boolean;
  /** When true, also draw a small label at each panel's centroid (debugging mask wiring). */
  showLabels?: boolean;
  /**
   * Output canvas size in mockup pixels. Defaults to the mockup's natural
   * size. The mapper's mockups are 1024×1024 today.
   */
  width?: number;
  height?: number;
};

/**
 * Fixed palette for `solid-colors` mode. Each known panel key gets a
 * distinct readable colour; unknown / unassigned panels fall through to a
 * desaturated grey so the user can see they're missing a panelKey.
 */
const PANEL_COLORS: Record<HoodiePanelKey | "unassigned", string> = {
  front_right: "#fb7185",   // rose
  front_left: "#f97316",    // orange
  front_pocket: "#eab308",  // yellow
  left_sleeve: "#84cc16",   // lime
  right_sleeve: "#22c55e",  // green
  left_cuff: "#14b8a6",     // teal
  right_cuff: "#06b6d4",    // cyan
  left_hood: "#3b82f6",     // blue
  right_hood: "#8b5cf6",    // violet
  waistband: "#ec4899",     // pink
  back: "#a855f7",          // purple
  unassigned: "#64748b",    // slate
};

const PRINT_OUTLINE = "#38bdf8";
const EXCLUSION_OUTLINE = "#ef4444";

type Aabb = { x: number; y: number; width: number; height: number };

function aabbOf(anchors: Pt[]): Aabb | null {
  if (anchors.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of anchors) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function unionAabb(a: Aabb, b: Aabb): Aabb {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Compute the union AABB of all print-eligible polygons. */
function totalPrintAabb(layers: MaskLayer[]): Aabb | null {
  let total: Aabb | null = null;
  for (const layer of layers) {
    if (layer.isExclusion) continue;
    if (!layer.visible) continue;
    const anchors = svgPathToAnchors(layer.maskPath);
    if (anchors.length < 3) continue;
    const bb = aabbOf(anchors);
    if (!bb) continue;
    total = total ? unionAabb(total, bb) : bb;
  }
  return total;
}

function pathPolygon(ctx: CanvasRenderingContext2D, anchors: Pt[]): void {
  ctx.beginPath();
  ctx.moveTo(anchors[0].x, anchors[0].y);
  for (let i = 1; i < anchors.length; i += 1) {
    ctx.lineTo(anchors[i].x, anchors[i].y);
  }
  ctx.closePath();
}

function colorForLayer(layer: MaskLayer, fallback: string): string {
  if (layer.isExclusion) return EXCLUSION_OUTLINE;
  if (layer.panelKey && layer.panelKey in PANEL_COLORS) {
    return PANEL_COLORS[layer.panelKey as HoodiePanelKey];
  }
  return fallback;
}

function centroid(anchors: Pt[]): Pt {
  let sx = 0;
  let sy = 0;
  for (const p of anchors) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / anchors.length, y: sy / anchors.length };
}

/**
 * Render the AOP preview to `ctx`. Caller is responsible for sizing
 * `ctx.canvas` to `params.width` × `params.height` (defaults to the
 * mockup's natural size). This function clears the canvas before drawing.
 */
export function renderAopPreview(ctx: CanvasRenderingContext2D, params: AopPreviewParams): void {
  const {
    template,
    view,
    mockup,
    artwork,
    mode = "single-sheet",
    showExclusions = true,
    showOutlines = false,
    showLabels = false,
  } = params;

  const W = params.width ?? mockup.naturalWidth ?? mockup.width;
  const H = params.height ?? mockup.naturalHeight ?? mockup.height;
  if (ctx.canvas.width !== W) ctx.canvas.width = W;
  if (ctx.canvas.height !== H) ctx.canvas.height = H;

  // Step 1: Mockup base.
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(mockup, 0, 0, W, H);

  const viewState = template.views[view];
  if (!viewState) return;

  const visible = viewState.layers.filter((l) => l.visible);
  const printLayers = visible.filter((l) => !l.isExclusion);
  const exclusionLayers = visible.filter((l) => l.isExclusion);

  // Sort by anatomical render priority so e.g. the front pocket sits on
  // top of the front-left/right body panels regardless of the order the
  // user traced them in. Within a tier, the user's zIndex still controls
  // ordering (Forward/Back buttons in the Properties panel).
  printLayers.sort((a, b) => layerRenderPriority(a) - layerRenderPriority(b));
  exclusionLayers.sort((a, b) => layerRenderPriority(a) - layerRenderPriority(b));

  // Quick exit: nothing to render.
  if (printLayers.length === 0) {
    if (showOutlines) drawOutlines(ctx, visible);
    if (showLabels) drawLabels(ctx, visible);
    return;
  }

  // Step 2: Build the print layer offscreen.
  const printCanvas = document.createElement("canvas");
  printCanvas.width = W;
  printCanvas.height = H;
  const pctx = printCanvas.getContext("2d");
  if (!pctx) return;

  const useColors = mode === "solid-colors" || !artwork;
  const totalBbox = mode === "single-sheet" && artwork ? totalPrintAabb(printLayers) : null;

  for (const layer of printLayers) {
    const anchors = svgPathToAnchors(layer.maskPath);
    if (anchors.length < 3) continue;

    pctx.save();
    pathPolygon(pctx, anchors);
    pctx.clip();
    pctx.globalAlpha = layer.opacity;

    if (useColors) {
      pctx.fillStyle = colorForLayer(layer, PANEL_COLORS.unassigned);
      pctx.fillRect(0, 0, W, H);
    } else if (artwork) {
      if (mode === "single-sheet" && totalBbox) {
        // Whole artwork stretched once across the entire union of print
        // panels. Each panel sees its slice of the continuous mural.
        pctx.drawImage(artwork, totalBbox.x, totalBbox.y, totalBbox.width, totalBbox.height);
      } else {
        // per-panel-stretch — independent stretch per panel.
        const bb = aabbOf(anchors);
        if (bb) pctx.drawImage(artwork, bb.x, bb.y, bb.width, bb.height);
      }
    }

    pctx.restore();
  }

  // Step 3: Punch out exclusions so mockup pixels show through.
  if (showExclusions && exclusionLayers.length > 0) {
    pctx.save();
    pctx.globalCompositeOperation = "destination-out";
    pctx.fillStyle = "#000"; // colour irrelevant under destination-out, only alpha matters
    for (const layer of exclusionLayers) {
      const anchors = svgPathToAnchors(layer.maskPath);
      if (anchors.length < 3) continue;
      pathPolygon(pctx, anchors);
      pctx.fill();
    }
    pctx.restore();
  }

  // Step 4: Composite print onto mockup.
  ctx.drawImage(printCanvas, 0, 0);

  // Step 5: Optional outlines + labels for debugging.
  if (showOutlines) drawOutlines(ctx, visible);
  if (showLabels) drawLabels(ctx, visible);
}

function drawOutlines(ctx: CanvasRenderingContext2D, layers: MaskLayer[]): void {
  ctx.save();
  ctx.lineWidth = 2;
  for (const layer of layers) {
    const anchors = svgPathToAnchors(layer.maskPath);
    if (anchors.length < 3) continue;
    pathPolygon(ctx, anchors);
    ctx.strokeStyle = layer.isExclusion ? EXCLUSION_OUTLINE : PRINT_OUTLINE;
    if (layer.isExclusion) ctx.setLineDash([8, 6]);
    else ctx.setLineDash([]);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLabels(ctx: CanvasRenderingContext2D, layers: MaskLayer[]): void {
  ctx.save();
  ctx.font = "bold 14px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.65)";
  for (const layer of layers) {
    const anchors = svgPathToAnchors(layer.maskPath);
    if (anchors.length < 3) continue;
    const c = centroid(anchors);
    const text = layer.panelKey
      ? layer.panelKey.replace(/_/g, " ")
      : layer.isExclusion
        ? `excl: ${layer.name}`
        : layer.name;
    ctx.strokeText(text, c.x, c.y);
    ctx.fillStyle = layer.isExclusion ? "#fecaca" : "#e0f2fe";
    ctx.fillText(text, c.x, c.y);
  }
  ctx.restore();
}

/**
 * Convenience helper: render to a fresh offscreen canvas and return it.
 * Used by the "Save PNG" button in the modal so we don't have to read the
 * preview canvas back out of React.
 */
export function renderAopPreviewToCanvas(params: AopPreviewParams): HTMLCanvasElement {
  const W = params.width ?? params.mockup.naturalWidth ?? params.mockup.width;
  const H = params.height ?? params.mockup.naturalHeight ?? params.mockup.height;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  renderAopPreview(ctx, params);
  return canvas;
}
