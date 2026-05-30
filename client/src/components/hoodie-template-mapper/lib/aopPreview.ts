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
import { drawMeshWarp } from "./meshWarp";

export type AopPreviewMode = "single-sheet" | "per-panel-stretch" | "solid-colors";

/**
 * Customer-facing artwork placement (single-sheet mode only). Lets the
 * user shrink / grow / slide the artwork around inside the union of the
 * print panels — e.g. position a pet portrait so only the hood + chest
 * see it, leaving the sleeves blank.
 *
 * Coordinate convention:
 *   - `scale` is uniform around the centre of the union AABB. 1 = the
 *     artwork is stretched once across the whole AABB (the previous
 *     hard-coded behaviour). 0.5 = artwork covers half the AABB area
 *     in mockup px. 2 = the artwork is stretched to twice the AABB,
 *     so each panel sees a smaller "zoom-in" of the source image.
 *   - `offsetX` / `offsetY` are mockup pixels added to the artwork's
 *     centre after scaling. Positive Y = artwork moves down on the
 *     mockup.
 */
export type ArtworkPlacement = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

export const DEFAULT_ARTWORK_PLACEMENT: ArtworkPlacement = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
};

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
  /**
   * Pre-loaded per-layer source artwork keyed by URL. When a layer's
   * `productionPanelSrc` resolves in this map, that image is warped
   * through the layer's mesh instead of using the global `artwork`.
   * Callers (e.g. AopPreviewModal) preload these before invoking
   * `renderAopPreview` so the renderer stays synchronous.
   */
  layerSources?: Map<string, HTMLImageElement>;
  /**
   * When true (and a per-layer `productionPanelSrc` is loaded for the
   * panel), the layer's calibration artwork wins over the global
   * `artwork`. This is the "verify the mapping looks right" mode —
   * each panel gets its triangulated Printify PNG warped through its
   * mesh, regardless of what the customer uploaded.
   *
   * Default: `false`. The expected end-user flow is "drop in a
   * customer artwork → see it warped onto the hoodie", which means
   * the global `artwork` should win. The mapper's modal toggles this
   * back on when the admin wants to re-check their calibration.
   */
  preferLayerSources?: boolean;
  /**
   * When true, multiply the original mockup pixels over each warped
   * panel. Bakes the fabric shadows / highlights of the photo into the
   * artwork so the AOP looks like real cloth rather than a flat decal.
   * Has no effect on `solid-colors` mode.
   */
  applyShading?: boolean;
  /**
   * Single-sheet artwork placement (scale + offset). Ignored in
   * per-panel-stretch and solid-colors modes. When omitted, defaults
   * to identity (artwork fills the union AABB exactly, equivalent to
   * the original Phase 3 behaviour).
   */
  artworkPlacement?: ArtworkPlacement;
  /**
   * When true, draws a dashed rectangle around the effective design
   * rect on top of the composite. Diagnostic only — lets the admin
   * see where the artwork "lives" while sliding the placement
   * sliders. Off by default.
   */
  showDesignRect?: boolean;
  /**
   * Optional CSS colour painted as a base fill across every print
   * panel before the artwork draws. Lets the admin preview the
   * "dyed fabric" look (e.g. brown body) without having to bake the
   * colour into the artwork PNG. The fill is clipped to each panel's
   * polygon so exclusions still show mockup pixels through. Pass
   * `null` / undefined to disable (panels stay transparent under the
   * artwork — current behaviour).
   */
  backgroundColor?: string | null;
};

/**
 * Read-only helper: should this panel participate in single-sheet
 * mode? Treats undefined as `true` for back-compat — templates traced
 * before the flag existed continue to behave as if they opted in.
 */
export function isLayerInSingleSheet(layer: MaskLayer): boolean {
  return layer.includeInSingleSheet !== false;
}

export type DesignRectInfo = {
  /** Union AABB of single-sheet-participating panels. */
  union: { x: number; y: number; width: number; height: number };
  /** Aspect-fitted rect (artwork natural aspect, centred in union). */
  base: { x: number; y: number; width: number; height: number };
  /** Effective rect after scale + offset — what the artwork samples. */
  effective: { x: number; y: number; width: number; height: number };
  /** Centre of `base` rect — used as the origin for scale + offset. */
  baseCentre: { x: number; y: number };
};

/**
 * Compute the same design rects the renderer uses, so external UI
 * (e.g. the modal's interactive overlay) can position handles in
 * mockup pixel space without re-implementing the maths. Returns
 * `null` when no print panels participate in single-sheet.
 */
export function computeDesignRect(
  template: HoodieTemplate,
  view: HoodieView,
  artwork: HTMLImageElement | null,
  placement: ArtworkPlacement = DEFAULT_ARTWORK_PLACEMENT,
): DesignRectInfo | null {
  const layers = template.views[view]?.layers ?? [];
  const visiblePrint = layers.filter((l) => l.visible && !l.isExclusion);
  const union = totalPrintAabb(visiblePrint, isLayerInSingleSheet);
  if (!union) return null;
  const base = artwork
    ? fitAspectInside(
        union,
        (artwork.naturalWidth || artwork.width) /
          (artwork.naturalHeight || artwork.height || 1),
      )
    : union;
  const cx = base.x + base.width / 2;
  const cy = base.y + base.height / 2;
  const s = Math.max(0.0001, placement.scale || 1);
  const w = base.width * s;
  const h = base.height * s;
  const effective = {
    x: cx - w / 2 + (placement.offsetX || 0),
    y: cy - h / 2 + (placement.offsetY || 0),
    width: w,
    height: h,
  };
  return { union, base, effective, baseCentre: { x: cx, y: cy } };
}

/**
 * Fixed palette for `solid-colors` mode. Each known panel key gets a
 * distinct readable colour; unknown / unassigned panels fall through to a
 * desaturated grey so the user can see they're missing a panelKey.
 */
const PANEL_COLORS: Record<HoodiePanelKey | "unassigned", string> = {
  front_right: "#fb7185",   // rose
  front_left: "#f97316",    // orange
  front_pocket: "#eab308",  // yellow (legacy single-pocket)
  pocket_left: "#facc15",   // amber – left half
  pocket_right: "#fde047",  // pale yellow – right half
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

/**
 * Compute the union AABB of print-eligible polygons. When `filter` is
 * provided, only matching layers contribute — used to restrict the
 * single-sheet design canvas to the panels the admin wants in their
 * composition (e.g. exclude sleeves).
 */
function totalPrintAabb(layers: MaskLayer[], filter?: (l: MaskLayer) => boolean): Aabb | null {
  let total: Aabb | null = null;
  for (const layer of layers) {
    if (layer.isExclusion) continue;
    if (!layer.visible) continue;
    if (filter && !filter(layer)) continue;
    const anchors = svgPathToAnchors(layer.maskPath);
    if (anchors.length < 3) continue;
    const bb = aabbOf(anchors);
    if (!bb) continue;
    total = total ? unionAabb(total, bb) : bb;
  }
  return total;
}

/**
 * Fit a rectangle of the given `aspect` (width / height) inside `union`,
 * preserving aspect ratio and centring it. Returns the largest such
 * rectangle that's fully contained — same convention as CSS
 * `object-fit: contain`. Used so the design rect adopts the artwork's
 * natural shape instead of the union's shape, which prevents portraits
 * being squished into a square or landscapes being squished tall.
 */
function fitAspectInside(union: Aabb, aspect: number): Aabb {
  if (!Number.isFinite(aspect) || aspect <= 0) return union;
  let w = union.width;
  let h = w / aspect;
  if (h > union.height) {
    h = union.height;
    w = h * aspect;
  }
  return {
    x: union.x + (union.width - w) / 2,
    y: union.y + (union.height - h) / 2,
    width: w,
    height: h,
  };
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
    layerSources,
    preferLayerSources = false,
    applyShading = false,
    artworkPlacement = DEFAULT_ARTWORK_PLACEMENT,
    showDesignRect = false,
    backgroundColor = null,
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
  // Union AABB of single-sheet-participating panels only — the
  // "design canvas" the user composes into when artworkPlacement is
  // identity. Layers with includeInSingleSheet === false drop out,
  // which lets the admin shrink the canvas to e.g. body+hood and
  // leave sleeves as background-colour-only.
  const totalBbox =
    mode === "single-sheet"
      ? totalPrintAabb(printLayers, isLayerInSingleSheet)
      : null;
  // Base rect: the design canvas adopts the artwork's natural aspect
  // ratio so portraits stay tall and landscapes stay wide. When no
  // artwork is loaded (admin previewing the empty template), fall
  // back to the union AABB shape directly.
  const baseRect: Aabb | null =
    totalBbox && artwork
      ? fitAspectInside(
          totalBbox,
          (artwork.naturalWidth || artwork.width) /
            (artwork.naturalHeight || artwork.height || 1),
        )
      : totalBbox;
  // Apply scale + offset around the base rect's centre.
  const effectiveDesignRect: Aabb | null = baseRect
    ? (() => {
        const cx = baseRect.x + baseRect.width / 2;
        const cy = baseRect.y + baseRect.height / 2;
        const s = Math.max(0.0001, artworkPlacement.scale || 1);
        const w = baseRect.width * s;
        const h = baseRect.height * s;
        return {
          x: cx - w / 2 + (artworkPlacement.offsetX || 0),
          y: cy - h / 2 + (artworkPlacement.offsetY || 0),
          width: w,
          height: h,
        };
      })()
    : null;

  for (const layer of printLayers) {
    const anchors = svgPathToAnchors(layer.maskPath);
    if (anchors.length < 3) continue;

    pctx.save();
    pathPolygon(pctx, anchors);
    pctx.clip();
    pctx.globalAlpha = layer.opacity;

    // Background colour fill — sits UNDER the artwork inside each
    // panel's polygon, so transparent regions of the artwork (and
    // panels intentionally excluded from single-sheet via
    // includeInSingleSheet === false) show as dyed fabric instead of
    // showing the original mockup pixels. Skipped in solid-colors
    // mode because that mode owns the colour scheme.
    if (backgroundColor && !useColors) {
      pctx.fillStyle = backgroundColor;
      pctx.fillRect(0, 0, W, H);
    }

    // Whether this panel actually receives artwork in single-sheet
    // mode. When false, the panel keeps just the background colour
    // (or stays empty if no bg) — exactly the "exclude sleeves from
    // the design" use case.
    const inSingleSheet = isLayerInSingleSheet(layer);
    const skipArtwork = mode === "single-sheet" && !inSingleSheet;

    // Source resolution priority — match user mental model:
    //   1. solid-colors mode → debug fill, ignore artwork.
    //   2. preferLayerSources mode → if this panel has a calibration
    //      PNG loaded, warp THAT through the mesh (verifies mapping).
    //   3. Default behaviour: customer artwork (`artwork`) wins. If the
    //      panel has a saved mesh, the artwork gets warped through it
    //      with a synthesised sourceRect — the panel's slice of the
    //      union (single-sheet) or the whole artwork (per-panel). If
    //      no mesh, fall back to a flat stretched draw.
    //   4. No customer artwork → fall back to calibration source if
    //      available, else nothing (mockup pixels show through).
    const layerSrc =
      layer.productionPanelSrc && layerSources
        ? layerSources.get(layer.productionPanelSrc) ?? null
        : null;

    if (useColors) {
      pctx.fillStyle = colorForLayer(layer, PANEL_COLORS.unassigned);
      pctx.fillRect(0, 0, W, H);
    } else if (skipArtwork) {
      // Excluded from single-sheet — bg colour (already painted) is
      // all we draw. Still want the shading multiply to apply, so
      // fall through to that step below by intentionally drawing
      // nothing here.
    } else if (preferLayerSources && layer.mesh && layerSrc) {
      // Calibration verification: warp the panel's triangulated PNG
      // through the saved mesh. This is the OLD default — kept behind
      // a flag so admins can sanity-check their meshes.
      drawMeshWarp(
        pctx,
        layerSrc,
        layerSrc.naturalWidth || layerSrc.width,
        layerSrc.naturalHeight || layerSrc.height,
        layer.mesh,
      );
    } else if (artwork && layer.mesh) {
      // Customer artwork warped through the saved mesh. We synthesise
      // a `sourceRect` so the mesh reads from the right slice of the
      // customer's image — sourceRotation / sourceFlip / targetPoints
      // are all preserved from the original calibration.
      const aw = artwork.naturalWidth || artwork.width;
      const ah = artwork.naturalHeight || artwork.height;
      let synthSrc;
      if (
        mode === "single-sheet" &&
        effectiveDesignRect &&
        effectiveDesignRect.width > 0 &&
        effectiveDesignRect.height > 0
      ) {
        const bb = aabbOf(anchors);
        if (bb) {
          // The panel's slice of the design rect, expressed as a
          // sub-rectangle of the artwork image. When the user shrinks
          // the design rect, panels outside it produce sub-rects with
          // negative origins / past-image extents — drawMeshWarp will
          // happily sample those (giving transparent pixels), which
          // is the natural "no artwork here" behaviour we want.
          synthSrc = {
            x: ((bb.x - effectiveDesignRect.x) / effectiveDesignRect.width) * aw,
            y: ((bb.y - effectiveDesignRect.y) / effectiveDesignRect.height) * ah,
            width: (bb.width / effectiveDesignRect.width) * aw,
            height: (bb.height / effectiveDesignRect.height) * ah,
          };
        }
      } else {
        // per-panel-stretch — every panel reads the full artwork.
        synthSrc = { x: 0, y: 0, width: aw, height: ah };
      }
      if (synthSrc) {
        drawMeshWarp(pctx, artwork, aw, ah, { ...layer.mesh, sourceRect: synthSrc });
      }
    } else if (artwork) {
      // No mesh on this layer — fall back to a flat stretched draw,
      // same behaviour as Phase 3.
      if (mode === "single-sheet" && effectiveDesignRect) {
        pctx.drawImage(
          artwork,
          effectiveDesignRect.x,
          effectiveDesignRect.y,
          effectiveDesignRect.width,
          effectiveDesignRect.height,
        );
      } else {
        const bb = aabbOf(anchors);
        if (bb) pctx.drawImage(artwork, bb.x, bb.y, bb.width, bb.height);
      }
    } else if (layer.mesh && layerSrc) {
      // No customer artwork uploaded → render the calibration source
      // through the mesh so the admin still sees something useful.
      drawMeshWarp(
        pctx,
        layerSrc,
        layerSrc.naturalWidth || layerSrc.width,
        layerSrc.naturalHeight || layerSrc.height,
        layer.mesh,
      );
    }

    // Shading multiply: bake the original mockup's fabric shadows over
    // the warped artwork so the AOP looks like real cloth, not a flat
    // decal. Skipped in solid-colors mode (debug). Still inside the
    // polygon clip so other panels are untouched.
    if (applyShading && !useColors) {
      pctx.save();
      pctx.globalCompositeOperation = "multiply";
      pctx.drawImage(mockup, 0, 0, W, H);
      pctx.restore();
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
  // Step 6: Design-rect overlay — dashed magenta outline + handles
  // showing where the artwork is currently anchored. Helps the user
  // make sense of "I shrunk the dog face but where does it actually
  // sit on the mockup?"
  if (showDesignRect && mode === "single-sheet" && effectiveDesignRect) {
    drawDesignRect(ctx, effectiveDesignRect);
  }
}

function drawDesignRect(ctx: CanvasRenderingContext2D, rect: Aabb): void {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 6]);
  ctx.strokeStyle = "#f0abfc"; // fuchsia-300 to match modal accents
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  // Centre crosshair so a hard-zoomed user can see the artwork's
  // anchor point even when the dashed rect is offscreen.
  ctx.setLineDash([]);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy);
  ctx.lineTo(cx + 12, cy);
  ctx.moveTo(cx, cy - 12);
  ctx.lineTo(cx, cy + 12);
  ctx.stroke();
  ctx.restore();
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
