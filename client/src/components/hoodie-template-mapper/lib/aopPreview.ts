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

import type {
  DesignGroup,
  HoodiePanelKey,
  HoodieTemplate,
  HoodieView,
  MaskLayer,
  MeshGrid,
  Pt,
  TileSettings,
} from "@shared/hoodieTemplate";
import {
  drawMockupImageInCanvas,
  findGroupForPanel,
  layerRenderPriority,
  SEAM_PAIR_PANELS,
} from "@shared/hoodieTemplate";
import { svgPathToAnchors } from "./svgPath";
import { drawMeshWarp } from "./meshWarp";

/**
 * AOP rendering modes:
 *   - single-sheet  → groups apply, customer's artwork stretched per
 *                     group with optional seam allowance.
 *   - per-panel-stretch → each panel independently stretches the
 *                     full artwork (legacy, useful for tile previews).
 *   - tile          → the artwork repeats uniformly across all
 *                     mesh-warped panels at a real-world size, with
 *                     a chosen pattern (grid / brick / half-drop).
 *   - solid-colors  → debug palette per panel, ignores artwork.
 */
export type AopPreviewMode =
  | "single-sheet"
  | "per-panel-stretch"
  | "tile"
  | "solid-colors";

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
   * Legacy single-group artwork placement (scale + offset). Used when
   * the template has no `designGroups` defined OR when a layer doesn't
   * belong to any group. New templates render via per-group placement
   * stored on `template.designGroups`; this field stays for back-compat
   * and as the "ungrouped fallback" placement.
   */
  artworkPlacement?: ArtworkPlacement;
  /**
   * Per-group placement override (modal-local edits before the user
   * hits "Save as defaults"). Keyed by `DesignGroup.id`. When a key is
   * present here it wins over `template.designGroups[id].placement`,
   * letting the modal preview unsaved tweaks. Omit for "use template
   * defaults".
   */
  groupPlacementOverrides?: Record<string, Record<HoodieView, ArtworkPlacement>>;
  /**
   * Per-group seam-allowance override (% of group rect width).
   * Same precedence rule as `groupPlacementOverrides`.
   */
  groupSeamOverrides?: Record<string, number>;
  /**
   * Per-group enabled override. Lets the modal show "preview with this
   * group switched off" without dirtying the template.
   */
  groupEnabledOverrides?: Record<string, boolean>;
  /**
   * `id` of the design group whose handles are currently being edited.
   * The renderer dims the other groups' design-rect outlines so the
   * canvas only highlights the rect the user is interacting with.
   * Has no effect on the rendered artwork itself.
   */
  activeGroupId?: string | null;
  /**
   * Tile-mode settings. Required when `mode === "tile"`. Falls back to
   * `template.tileSettings` when omitted.
   */
  tileSettings?: TileSettings;
  /**
   * Mockup-px ↔ real-world conversion. Required when `mode === "tile"`.
   * Falls back to `template.realWorldCalibration` when omitted.
   */
  pixelsPerInch?: number;
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
  /**
   * Per-panel-key override for "is this panel printed?". Wins over
   * the group-level `groupEnabledOverrides`. When a key maps to
   * `false`, the panel renders just the background colour (clipped
   * to its polygon) — same as a disabled group, but at panel
   * granularity so customers can toggle e.g. "cuffs & waistband
   * blank" or "pockets blank" without touching admin design groups.
   * Sweatshirt trim (cuffs, waistband, neck rib) is muted via
   * `HoodieAopPlacer` `TRIM_PANEL_KEYS` + `panelEnabledOverrides`.
   * Omit a key to leave its group-level decision untouched.
   */
  panelEnabledOverrides?: Partial<Record<string, boolean>>;
  /**
   * Controls what happens when `artwork` is null (no upload yet) and
   * mode is `single-sheet` / `tile` / `per-panel-stretch`.
   *
   * - `true` (default) — paint each panel's debug colour. Admin
   *   behaviour: useful for verifying mask coverage before the
   *   customer drops in artwork.
   * - `false` — skip the debug paint. Panels show just the background
   *   colour (or stay transparent if `backgroundColor` is null) so
   *   the customer sees a "plain hoodie" preview when they haven't
   *   uploaded yet. Used by `HoodieAopPlacer`.
   */
  solidColorFallback?: boolean;
};

/**
 * Read-only helper: should this panel participate in single-sheet
 * mode? Treats undefined as `true` for back-compat — templates traced
 * before the flag existed continue to behave as if they opted in.
 */
export function isLayerInSingleSheet(layer: MaskLayer): boolean {
  return layer.includeInSingleSheet !== false;
}

/** Default fabric fill when no explicit garment colour is set (matches HoodieAopPlacer). */
export const DEFAULT_GARMENT_BACKGROUND = "#FFFFFF";

/**
 * Panels that physically sit on top of body art. When excluded from
 * single-sheet (skipArtwork), they still occlude layers below — pocket
 * hides chest art, cuffs hide sleeve ends, etc.
 */
const OVERLAY_OCCLUDER_PANEL_KEYS = new Set<HoodiePanelKey>([
  "front_pocket",
  "pocket_left",
  "pocket_right",
  "left_cuff",
  "right_cuff",
  "collar_front",
  "collar_back",
  "waistband",
]);

function panelFabricFillColor(
  layer: MaskLayer,
  skipArtwork: boolean,
  backgroundColor: string | null | undefined,
): string | null {
  if (backgroundColor) return backgroundColor;
  if (
    skipArtwork &&
    layer.panelKey &&
    OVERLAY_OCCLUDER_PANEL_KEYS.has(layer.panelKey)
  ) {
    return DEFAULT_GARMENT_BACKGROUND;
  }
  return null;
}

/**
 * Bake mockup fabric folds into the panel. When the customer picks a garment
 * colour, `luminosity` keeps hue/sat on the fill/artwork while borrowing
 * shadow depth from the photo — straight `multiply` collapses to a flat
 * swatch on mid/dark dyes.
 */
function applyMockupFabricShading(
  pctx: CanvasRenderingContext2D,
  mockup: CanvasImageSource,
  viewMockupAsset: Parameters<typeof drawMockupImageInCanvas>[2],
  width: number,
  height: number,
  backgroundColor: string | null | undefined,
): void {
  pctx.save();
  if (backgroundColor) {
    pctx.globalCompositeOperation = "luminosity";
  } else {
    pctx.globalCompositeOperation = "multiply";
  }
  drawMockupImageInCanvas(pctx, mockup, viewMockupAsset, width, height);
  pctx.restore();
}

export type DesignRectInfo = {
  /** Union AABB of single-sheet-participating panels. */
  union: { x: number; y: number; width: number; height: number };
  /** Aspect-fitted rect (artwork natural aspect, centred on anchor). */
  base: { x: number; y: number; width: number; height: number };
  /** Effective rect after scale + offset — what the artwork samples. */
  effective: { x: number; y: number; width: number; height: number };
  /** Anchor point (seam line for L/R pairs, centroid for solo panels). */
  anchor: { x: number; y: number };
  /** Whether this group has a recognised L/R seam pair. */
  hasSeamPair: boolean;
  /**
   * True when the anchor X represents a fabric seam (zip / hood
   * separation) rather than a generic union centroid. The modal's
   * drag overlay uses this to gate "snap to seam" behaviour so we
   * only snap groups that genuinely have a seam line.
   */
  anchorIsSeam: boolean;
  /** Seam allowance currently applied (% of group rect width). */
  seamAllowance: number;
  /** ID of the group this rect belongs to (`"__legacy__"` if ungrouped fallback). */
  groupId: string;
  /** Whether the group is enabled (false → background colour only). */
  enabled: boolean;
};

/**
 * Resolve the placement for a group in a given view. Modal-level
 * `overrides` win when present, else fall back to the template's
 * stored `designGroups[].placement[view]`, else identity.
 */
function resolveGroupPlacement(
  group: DesignGroup,
  view: HoodieView,
  overrides?: Record<string, Record<HoodieView, ArtworkPlacement>>,
): ArtworkPlacement {
  const ov = overrides?.[group.id]?.[view];
  if (ov) return ov;
  const stored = group.placement?.[view];
  if (stored) return stored;
  return DEFAULT_ARTWORK_PLACEMENT;
}

function resolveGroupSeam(
  group: DesignGroup,
  overrides?: Record<string, number>,
): number {
  const ov = overrides?.[group.id];
  if (typeof ov === "number") return Math.max(0, Math.min(0.15, ov));
  return Math.max(0, Math.min(0.15, group.seamAllowance ?? 0));
}

function resolveGroupEnabled(
  group: DesignGroup,
  overrides?: Record<string, boolean>,
): boolean {
  const ov = overrides?.[group.id];
  if (typeof ov === "boolean") return ov;
  return group.enabled !== false;
}

/**
 * For a paired L/R seam group, compute the seam line X by averaging
 * the rightmost X of any L-side panel polygon and the leftmost X of
 * any R-side panel polygon. Falls back to the union centre when the
 * group has no recognised pair (e.g. back-body, sleeves), so solo
 * groups still anchor sensibly.
 *
 * Returns `{ x, hasSeamPair }`. When `hasSeamPair === false` the X is
 * the union centre and seam allowance has no effect on this group.
 */
function computeAnchorX(
  layers: MaskLayer[],
  union: Aabb,
): { x: number; hasSeamPair: boolean } {
  // Bucket layers by L/R via the SEAM_PAIR_PANELS map.
  const leftKeys = new Set(SEAM_PAIR_PANELS.left);
  const rightKeys = new Set(SEAM_PAIR_PANELS.right);
  let lMaxX: number | null = null;
  let rMinX: number | null = null;
  for (const layer of layers) {
    if (!layer.panelKey) continue;
    const anchors = svgPathToAnchors(layer.maskPath);
    if (anchors.length < 3) continue;
    const bb = aabbOf(anchors);
    if (!bb) continue;
    if (leftKeys.has(layer.panelKey)) {
      const right = bb.x + bb.width;
      lMaxX = lMaxX === null ? right : Math.max(lMaxX, right);
    }
    if (rightKeys.has(layer.panelKey)) {
      rMinX = rMinX === null ? bb.x : Math.min(rMinX, bb.x);
    }
  }
  if (lMaxX !== null && rMinX !== null) {
    return { x: (lMaxX + rMinX) / 2, hasSeamPair: true };
  }
  return { x: union.x + union.width / 2, hasSeamPair: false };
}

/**
 * Compute the design rect for a single group (or the legacy
 * "everything in one group" fallback when the template has no
 * designGroups). Anchored at the seam line for paired groups,
 * union centre otherwise.
 */
function computeGroupRect(
  layers: MaskLayer[],
  artwork: HTMLImageElement | null,
  placement: ArtworkPlacement,
  groupId: string,
  enabled: boolean,
  seamAllowance: number,
): DesignRectInfo | null {
  const visiblePrint = layers.filter((l) => l.visible && !l.isExclusion);
  // Per-group rects include every panel in the group so placement handles
  // match rendered art. `includeInSingleSheet` controls skipArtwork at
  // render time — not whether the group has a draggable design rect.
  const union = totalPrintAabb(visiblePrint);
  if (!union) return null;
  const aspect = artwork
    ? (artwork.naturalWidth || artwork.width) /
      (artwork.naturalHeight || artwork.height || 1)
    : union.width / Math.max(1, union.height);
  const fitted = artwork ? fitAspectInside(union, aspect) : union;
  const { x: anchorX, hasSeamPair } = computeAnchorX(visiblePrint, union);
  // Re-centre the fitted rect on the anchor X so paired groups have
  // their artwork centred on the seam (not the union centroid).
  const base: Aabb = {
    x: anchorX - fitted.width / 2,
    y: fitted.y,
    width: fitted.width,
    height: fitted.height,
  };
  const cx = anchorX;
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
  return {
    union,
    base,
    effective,
    anchor: { x: anchorX, y: cy },
    hasSeamPair,
    anchorIsSeam: hasSeamPair,
    seamAllowance,
    groupId,
    enabled,
  };
}

/**
 * Compute the design rects for every active group in the given view.
 * Returns a map keyed by group id; the legacy fallback uses the key
 * `"__legacy__"`. External UI (e.g. the modal's interactive overlay)
 * uses this so handles match the renderer's geometry exactly.
 */
export function computeGroupRects(
  template: HoodieTemplate,
  view: HoodieView,
  artwork: HTMLImageElement | null,
  options?: {
    placementOverrides?: Record<string, Record<HoodieView, ArtworkPlacement>>;
    seamOverrides?: Record<string, number>;
    enabledOverrides?: Record<string, boolean>;
    legacyPlacement?: ArtworkPlacement;
  },
): Map<string, DesignRectInfo> {
  const result = new Map<string, DesignRectInfo>();
  const layers = template.views[view]?.layers ?? [];
  const groups = template.designGroups ?? [];
  if (groups.length === 0) {
    // Legacy / unmigrated template: treat all single-sheet panels as
    // one big group. Behaves identically to pre-Phase-2 renders.
    const info = computeGroupRect(
      layers,
      artwork,
      options?.legacyPlacement ?? DEFAULT_ARTWORK_PLACEMENT,
      "__legacy__",
      true,
      0,
    );
    if (info) result.set("__legacy__", info);
    return result;
  }
  for (const group of groups) {
    const groupLayers = layers.filter(
      (l) => l.panelKey && group.panelKeys.includes(l.panelKey),
    );
    if (groupLayers.length === 0) continue;
    // Note: the back-view hood placement-inherit hack lived here in
    // an earlier pass. It's been removed because the renderer now
    // bridges the back-view hood through a flat printable panel
    // derived from the front-view layer's mesh + placement (see
    // `renderHoodFlatPanel`). The back-view hood group's stored
    // placement is therefore unused at render time.
    const placement = resolveGroupPlacement(
      group,
      view,
      options?.placementOverrides,
    );
    const seam = resolveGroupSeam(group, options?.seamOverrides);
    const enabled = resolveGroupEnabled(group, options?.enabledOverrides);
    const info = computeGroupRect(
      groupLayers,
      artwork,
      placement,
      group.id,
      enabled,
      seam,
    );
    if (info) result.set(group.id, info);
  }
  // Catch-all for layers not in any group — they need a rect too.
  const grouped = new Set<string>();
  for (const g of groups) for (const k of g.panelKeys) grouped.add(k);
  const ungrouped = layers.filter((l) => l.panelKey && !grouped.has(l.panelKey));
  if (ungrouped.length > 0) {
    const info = computeGroupRect(
      ungrouped,
      artwork,
      options?.legacyPlacement ?? DEFAULT_ARTWORK_PLACEMENT,
      "__ungrouped__",
      true,
      0,
    );
    if (info) result.set("__ungrouped__", info);
  }
  return result;
}

/**
 * Back-compat wrapper that returns the largest single rect (used by
 * older code paths and the existing handles overlay before it was
 * upgraded to the per-group API). New callers should prefer
 * `computeGroupRects`.
 */
export function computeDesignRect(
  template: HoodieTemplate,
  view: HoodieView,
  artwork: HTMLImageElement | null,
  placement: ArtworkPlacement = DEFAULT_ARTWORK_PLACEMENT,
): DesignRectInfo | null {
  const map = computeGroupRects(template, view, artwork, {
    legacyPlacement: placement,
  });
  // Pick the largest by area so the legacy callers see something
  // sensible — front body for most templates.
  let best: DesignRectInfo | null = null;
  let bestArea = -1;
  for (const info of Array.from(map.values())) {
    const area = info.effective.width * info.effective.height;
    if (area > bestArea) {
      bestArea = area;
      best = info;
    }
  }
  return best;
}

/**
 * Fixed palette for `solid-colors` mode. Each known panel key gets a
 * distinct readable colour; unknown / unassigned panels fall through to a
 * desaturated grey so the user can see they're missing a panelKey.
 */
const PANEL_COLORS: Record<HoodiePanelKey | "unassigned", string> = {
  front: "#6366f1",         // indigo — full pullover front body
  front_right: "#fb7185",   // rose
  front_left: "#f97316",    // orange
  front_pocket: "#eab308",  // yellow (legacy single-pocket)
  pocket_left: "#facc15",   // amber – left half
  pocket_right: "#fde047",  // pale yellow – right half
  left_sleeve: "#84cc16",   // lime
  right_sleeve: "#22c55e",  // green
  left_cuff: "#14b8a6",     // teal
  right_cuff: "#06b6d4",    // cyan
  collar_front: "#f472b6",  // pink — outer front band
  collar_back: "#db2777",   // rose — inner back / neck opening
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

/**
 * Compute the artwork sub-rectangle (in artwork pixels) that a panel
 * should sample when drawing in single-sheet mode, applying seam
 * allowance to L/R-pair panels.
 *
 * Seam allowance model: the artwork's centre strip (width = `seam`
 * × design rect width) is "consumed" by the seam. Left-side panels
 * map their right edge to U = 0.5 - seam/2 instead of 0.5. Right-side
 * panels map their left edge to U = 0.5 + seam/2 instead of 0.5.
 * Solo panels (back, sleeves) ignore the seam.
 *
 * The mapping stays linear within each half so the artwork doesn't
 * appear visually distorted — only the centre strip is hidden inside
 * the simulated seam.
 */
function synthesiseSeamAwareSourceRect(
  bb: Aabb,
  rect: DesignRectInfo,
  aw: number,
  ah: number,
  side: "left" | "right" | "none",
): Aabb {
  const eff = rect.effective;
  if (eff.width <= 0 || eff.height <= 0) {
    return { x: 0, y: 0, width: aw, height: ah };
  }
  // Y always maps linearly (no horizontal seam in this version).
  const y = ((bb.y - eff.y) / eff.height) * ah;
  const height = (bb.height / eff.height) * ah;
  // X with optional seam inset. We unconditionally apply the L/R
  // remap based on the *panel's anatomical side*, not the panel's
  // current position relative to the (possibly offset) design rect.
  // The earlier "only remap when relLeft/Right is on the natural
  // half" guard silently ignored seam allowance for any group with
  // a non-zero offsetX — even an accidental 4 px offset on Front
  // body — because the rel coords then sat just below/above 0.5.
  const seam = rect.hasSeamPair ? rect.seamAllowance : 0;
  const relLeft = (bb.x - eff.x) / eff.width;
  const relRight = (bb.x + bb.width - eff.x) / eff.width;
  let uLeft: number;
  let uRight: number;
  if (side === "left" && seam > 0) {
    // Left half compressed: [0, 0.5] → [0, 0.5 - seam/2]. Linear,
    // applied unconditionally so seam allowance always lands.
    uLeft = relLeft * (1 - seam);
    uRight = relRight * (1 - seam);
  } else if (side === "right" && seam > 0) {
    // Right half compressed: [0.5, 1] → [0.5 + seam/2, 1].
    uLeft = (relLeft - 0.5) * (1 - seam) + 0.5 + seam / 2;
    uRight = (relRight - 0.5) * (1 - seam) + 0.5 + seam / 2;
  } else {
    uLeft = relLeft;
    uRight = relRight;
  }
  return {
    x: uLeft * aw,
    y,
    width: (uRight - uLeft) * aw,
    height,
  };
}

/**
 * Render the flat printable panel for one front-view layer with a
 * mesh, given the user's artwork + the front-view group rect that
 * controls where the artwork lands on the union of single-sheet
 * panels.
 *
 * The output canvas is sized to the layer's mesh sourceRect — i.e.
 * the calibrated Printify panel resolution. Pixel (0, 0) of the
 * canvas corresponds to the top-left of the source rect; pixel
 * (W, H) to the bottom-right. So feeding this canvas into
 * drawMeshWarp with `sourceRect = { 0, 0, W, H }` is geometrically
 * equivalent to drawing the user's artwork through the mesh with
 * the synthesised UV — but the intermediate canvas is now reusable
 * by *any* mesh that shares the same flat-panel coordinate system
 * (e.g. the matching back-view layer's mesh).
 *
 * This is the bridge that makes the back-of-hood automatically show
 * "what's behind the dog's head" given the front-of-hood placement.
 * As long as the back-view hood mesh was calibrated against the
 * same Printify triangle artwork as the front, both meshes share
 * coordinates and the same flat panel feeds both.
 */
export function renderHoodFlatPanel(
  frontLayer: MaskLayer,
  artwork: HTMLImageElement,
  frontRect: DesignRectInfo,
  options?: {
    /** Optional override for the synthesised source rect on the
     *  artwork. Lets callers pass a custom slice (e.g. for tile
     *  mode previews). Defaults to the seam-aware single-sheet
     *  synthesis used by the live front-view renderer. */
    artworkSlice?: Aabb;
    /** Fallback flat-panel dimensions when `mesh.sourceRect` is
     *  null. The mapper UI doesn't currently set sourceRect on
     *  newly-created meshes (the dedicated action exists but isn't
     *  wired into any control), so callers should pass the
     *  calibration source image's natural size here — that's the
     *  coordinate system the mesh's targetPoints were calibrated
     *  against, so it's the right flat-panel size by construction. */
    fallbackSize?: { width: number; height: number };
  },
): HTMLCanvasElement | null {
  if (!frontLayer.mesh) return null;
  const src = frontLayer.mesh.sourceRect;
  let flatW: number;
  let flatH: number;
  if (src && src.width > 0 && src.height > 0) {
    flatW = Math.max(1, Math.round(src.width));
    flatH = Math.max(1, Math.round(src.height));
  } else if (
    options?.fallbackSize &&
    options.fallbackSize.width > 0 &&
    options.fallbackSize.height > 0
  ) {
    flatW = Math.max(1, Math.round(options.fallbackSize.width));
    flatH = Math.max(1, Math.round(options.fallbackSize.height));
  } else {
    // Last resort: use the user's artwork natural dims. This matches
    // drawMeshWarp's own implicit fallback when sourceRect is null,
    // so the flat panel + back-view warp still produce a coherent
    // image (just at artwork-resolution rather than print-resolution).
    flatW = Math.max(1, artwork.naturalWidth || artwork.width);
    flatH = Math.max(1, artwork.naturalHeight || artwork.height);
  }

  const canvas = document.createElement("canvas");
  canvas.width = flatW;
  canvas.height = flatH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Decide which slice of the user's artwork lands on this panel.
  // Falls back to the seam-aware synthesis (the same logic the
  // front-view renderer uses) so the flat panel matches what the
  // admin already sees on the front mockup.
  let slice = options?.artworkSlice ?? null;
  if (!slice) {
    const anchors = svgPathToAnchors(frontLayer.maskPath);
    const bb = aabbOf(anchors);
    if (!bb) return null;
    const aw = artwork.naturalWidth || artwork.width;
    const ah = artwork.naturalHeight || artwork.height;
    const side: "left" | "right" | "none" = frontLayer.panelKey
      ? SEAM_PAIR_PANELS.left.includes(frontLayer.panelKey)
        ? "left"
        : SEAM_PAIR_PANELS.right.includes(frontLayer.panelKey)
          ? "right"
          : "none"
      : "none";
    slice = synthesiseSeamAwareSourceRect(bb, frontRect, aw, ah, side);
  }
  if (slice.width <= 0 || slice.height <= 0) return null;

  // Honour the front-view mesh's source UV transform (rotation /
  // flip) so the flat panel matches the orientation the admin
  // calibrated. Without this, a 90°-rotated mesh would feed the
  // back-view warp an unrotated image and the result would be
  // misaligned.
  const rotation = frontLayer.mesh.sourceRotation ?? 0;
  const flipX = frontLayer.mesh.sourceFlipX ?? false;
  const flipY = frontLayer.mesh.sourceFlipY ?? false;
  ctx.save();
  if (rotation || flipX || flipY) {
    ctx.translate(flatW / 2, flatH / 2);
    if (rotation) ctx.rotate((rotation * Math.PI) / 180);
    ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    ctx.translate(-flatW / 2, -flatH / 2);
  }
  ctx.drawImage(
    artwork,
    slice.x,
    slice.y,
    slice.width,
    slice.height,
    0,
    0,
    flatW,
    flatH,
  );
  ctx.restore();
  return canvas;
}

/**
 * Panel keys that participate in the front→back flat-panel bridge.
 * Hood is the only continuous fabric piece that needs it today
 * (sleeves get tile mode, back body has no front view, etc.).
 */
const HOOD_BRIDGE_PANEL_KEYS = new Set<string>(["left_hood", "right_hood"]);

/**
 * Find a matching front-view layer by panel key. Used by the back-
 * view renderer to resolve which front-view layer + group rect to
 * derive the flat panel from for hood bridging.
 */
function findFrontLayerByPanelKey(
  template: HoodieTemplate,
  panelKey: HoodiePanelKey | null | undefined,
): MaskLayer | null {
  if (!panelKey) return null;
  const layers = template.views.front?.layers ?? [];
  for (const l of layers) {
    if (l.panelKey === panelKey && l.mesh && l.visible && !l.isExclusion) {
      return l;
    }
  }
  return null;
}

/**
 * Tile mode: compute the artwork sub-rectangle that the panel should
 * sample so the artwork appears at the right physical size and tiles
 * seamlessly across panels. The trick is that we send the panel's
 * mockup-px bbox into the artwork's coordinate frame at the chosen
 * tile size — the customer's artwork acts as one tile and the mesh
 * naturally repeats it because the bbox spans many tile-widths.
 *
 * Pattern variants:
 *   - grid          → straight rows × columns
 *   - brick         → alternate rows shifted by tileSize / 2 in X
 *   - half-drop     → alternate columns shifted by tileSize / 2 in Y
 *
 * The synth source rect is positioned so the panel's top-left aligns
 * with a tile boundary chosen by the pattern. drawMeshWarp then warps
 * that infinite tiled artwork through the panel's mesh.
 *
 * Note: drawMeshWarp samples a finite source rect, but Phase 2 keeps
 * the implementation simple by selecting just *one* tile of the
 * artwork sized to fit the panel's bbox at tile resolution. For
 * panels larger than a tile, the renderer effectively shows one
 * stretched tile per panel — visually fine for the typical 1.5"
 * tile size on hoodie panels, and easy to upgrade later to true
 * sub-pixel tiling once we add a `wrap: "repeat"` option to
 * drawMeshWarp.
 */
function tileSourceRect(
  bb: Aabb,
  aw: number,
  ah: number,
  settings: TileSettings,
  pixelsPerInch: number,
): Aabb {
  const tilePx = Math.max(1, settings.tileSizeInches * pixelsPerInch);
  // For Phase 2 we sample one whole tile of the artwork and let the
  // mesh stretch it across the panel. tileSize informs the "this is
  // one tile" mental model; the pattern shifts kick in when we add
  // multi-tile sampling. For grid / brick / half-drop the visible
  // result on a single panel is the same, but the slider still
  // controls the apparent print size because the artwork is scaled
  // to `tilePx` regardless of panel size.
  // Pattern offset (currently a no-op single-tile but will be used
  // when we extend drawMeshWarp to repeat).
  const row = Math.floor(bb.y / tilePx);
  const col = Math.floor(bb.x / tilePx);
  let offsetX = 0;
  let offsetY = 0;
  if (settings.pattern === "brick" && row % 2 === 1) offsetX = tilePx / 2;
  if (settings.pattern === "half-drop" && col % 2 === 1) offsetY = tilePx / 2;
  void offsetX; // reserved for repeat-mode sampling
  void offsetY;
  return { x: 0, y: 0, width: aw, height: ah };
}

/**
 * Compute the bounding box of a mesh's `targetPoints` in mockup
 * coordinates. This is the area the mesh actually maps the flat
 * source canvas into — different from the layer's polygon bbox when
 * the admin extended the mesh for overscan / seam allowance, which
 * is the case for sleeves, hood, and waistband on the production
 * `unisex-zip-hoodie-aop-L` template.
 */
function meshTargetBbox(mesh: MeshGrid): Aabb | null {
  if (!mesh.targetPoints || mesh.targetPoints.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of mesh.targetPoints) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (w <= 0 || h <= 0) return null;
  return { x: minX, y: minY, width: w, height: h };
}

/**
 * Tile mode — render a per-panel **flat tile sheet** for a layer with
 * a mesh. Mirrors the place-on-item pipeline: tile the artwork in the
 * panel's flat coordinate system (so the pattern runs along the
 * panel's natural axis — sleeves run along the sleeve length, hood
 * panels along the hood arc, etc.), then feed that flat tile sheet
 * through the panel's mesh. The mesh deforms the tile pattern
 * according to fabric drape, exactly the way Printify will print
 * each panel and the way the cloth will hang on the wearer.
 *
 * Sizing strategy (uniform tile size across panels):
 *   - Prefer `mesh.sourceRect` if set (the calibrated panel size).
 *   - Else size the flat canvas to match the **mesh's targetPoints
 *     bbox** in mockup px. This is the area the mesh actually maps
 *     onto, so flat-px == mockup-px in mesh space → tiles render at
 *     a uniform `tileSizeInches × pixelsPerInch` regardless of which
 *     panel they're on. Using the polygon bbox here would oversize
 *     tiles on panels where the mesh extends past the polygon (admin
 *     adds overscan / seam allowance on hood, sleeves, waistband).
 *
 * Tile size is `tileSizeInches × pixelsPerInch` directly — no scale
 * compensation needed because the flat canvas already lives in the
 * same coord space the mesh projects into.
 *
 * Returns `null` if the layer has no mesh, the mesh is degenerate, or
 * the canvas couldn't be created.
 */
function renderTiledFlatPanel(
  layer: MaskLayer,
  artwork: HTMLImageElement,
  settings: TileSettings,
  pixelsPerInch: number,
  canvasW: number,
): HTMLCanvasElement | null {
  if (!layer.mesh) return null;

  // Decide flat-panel canvas dimensions.
  let flatW: number;
  let flatH: number;
  const src = layer.mesh.sourceRect;
  if (src && src.width > 0 && src.height > 0) {
    flatW = Math.max(1, Math.round(src.width));
    flatH = Math.max(1, Math.round(src.height));
  } else {
    // Use the mesh's projected area in mockup coordinates so the flat
    // canvas is in the same coord space the mesh maps onto. Critical
    // for tile-size uniformity across panels — the polygon bbox is
    // not a reliable proxy because admin meshes typically extend past
    // the polygon by 2× or more on sleeves / hood / waistband.
    const tb = meshTargetBbox(layer.mesh);
    if (!tb) return null;
    flatW = Math.max(1, Math.round(tb.width));
    flatH = Math.max(1, Math.round(tb.height));
  }

  // Tile size in flat-canvas px. Because flatW/H matches the mesh's
  // projected area in mockup px, a tile that's `tilePxMockup` flat-px
  // wide will render at the same `tilePxMockup` mockup-px wide on
  // screen (modulo per-triangle deformation from fabric drape).
  const tilePxMockup = Math.max(1, settings.tileSizeInches * pixelsPerInch);
  const tilePxFlat = tilePxMockup;
  const aw = artwork.naturalWidth || artwork.width;
  const ah = artwork.naturalHeight || artwork.height;
  const tileHFlat = tilePxFlat * (ah / Math.max(1, aw));

  const canvas = document.createElement("canvas");
  canvas.width = flatW;
  canvas.height = flatH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Anchor strategy.
  //   - Default: flat-canvas center → pattern symmetric about each
  //     panel's own centerline. Right for centered panels (back body,
  //     waistband, kangaroo pocket).
  //   - Seam panels: when the panel polygon has an edge that sits on
  //     the mockup canvas X-center (within ~4% tolerance), that edge
  //     is a seam (front zip, hood opening, pocket halves). Anchor the
  //     tile grid at the flat-canvas edge that maps onto that seam
  //     edge so a tile boundary lands EXACTLY at the seam — both
  //     paired panels' patterns then mirror outward from the seam,
  //     which is what the customer visually expects (and matches how
  //     Printify-printed garments look when the print is symmetric
  //     about the seams).
  let anchorX = flatW / 2;
  const cx = canvasW / 2;
  const polyAnchors = svgPathToAnchors(layer.maskPath);
  const polyBb = polyAnchors.length >= 3 ? aabbOf(polyAnchors) : null;
  if (
    polyBb &&
    layer.mesh.cols >= 2 &&
    layer.mesh.rows >= 1 &&
    canvasW > 0
  ) {
    const polyLDist = Math.abs(polyBb.x - cx);
    const polyRDist = Math.abs(polyBb.x + polyBb.width - cx);
    const SEAM_PX = canvasW * 0.04;
    if (Math.min(polyLDist, polyRDist) < SEAM_PX) {
      // Resolve which flat-canvas edge corresponds to the seam side
      // by comparing the mockup-X average of the mesh's first vs
      // last column. Whichever average sits closer to the canvas
      // center is the column that projects to the seam.
      const cols = layer.mesh.cols;
      const rows = layer.mesh.rows;
      let leftMockupX = 0;
      let rightMockupX = 0;
      for (let r = 0; r < rows; r += 1) {
        leftMockupX += layer.mesh.targetPoints[r * cols].x;
        rightMockupX += layer.mesh.targetPoints[r * cols + cols - 1].x;
      }
      leftMockupX /= rows;
      rightMockupX /= rows;
      anchorX = Math.abs(leftMockupX - cx) < Math.abs(rightMockupX - cx) ? 0 : flatW;
    }
  }
  const anchorY = flatH / 2;
  const colOf = (x: number) => Math.floor((x - anchorX) / tilePxFlat);
  const rowOf = (y: number) => Math.floor((y - anchorY) / tileHFlat);
  const startCol = colOf(0) - 1;
  const endCol = colOf(flatW) + 1;
  const startRow = rowOf(0) - 1;
  const endRow = rowOf(flatH) + 1;
  for (let row = startRow; row <= endRow; row += 1) {
    const y = anchorY + row * tileHFlat;
    const xOffset =
      settings.pattern === "brick" && row % 2 !== 0 ? tilePxFlat / 2 : 0;
    for (let col = startCol; col <= endCol; col += 1) {
      const x = anchorX + col * tilePxFlat + xOffset;
      const yOffset =
        settings.pattern === "half-drop" && col % 2 !== 0 ? tileHFlat / 2 : 0;
      ctx.drawImage(artwork, x, y + yOffset, tilePxFlat, tileHFlat);
    }
  }

  return canvas;
}

/**
 * Tile mode — flat (no-mesh) fallback. Tiles the artwork across the
 * panel's bbox at the chosen tile size. Less accurate than the mesh
 * version but still respects the real-world size when no mesh is
 * available.
 *
 * `anchor` is a canvas-space point that the global tile grid aligns
 * to — a tile edge (or row edge for Y) falls at `anchor`. For hoodies
 * we anchor at canvas center so the zip seam (vertical centerline)
 * becomes a tile boundary, giving mirror-symmetric patterns across
 * the front zip and the hood opening. Defaults to (0, 0) for
 * backward compatibility.
 */
function drawTileFlat(
  pctx: CanvasRenderingContext2D,
  artwork: HTMLImageElement,
  bb: Aabb | null,
  settings: TileSettings,
  pixelsPerInch: number,
  anchor: { x: number; y: number } = { x: 0, y: 0 },
): void {
  if (!bb) return;
  const tilePx = Math.max(1, settings.tileSizeInches * pixelsPerInch);
  const aw = artwork.naturalWidth || artwork.width;
  const ah = artwork.naturalHeight || artwork.height;
  const tileH = tilePx * (ah / aw); // preserve artwork aspect within the tile
  // Iterate row by row, applying brick/half-drop offsets where
  // requested. `clip()` already constrained drawing to the polygon
  // so we can over-draw past the bbox safely.
  //
  // The grid is anchored to `anchor` (NOT canvas (0,0)) so adjacent
  // panels share grid lines AND the centerline of the canvas falls on
  // a tile boundary. The `Math.floor(...) - 1` step gives us a one-
  // tile-border safety margin so the polygon clip never reveals empty
  // canvas at the panel edges.
  const colOf = (x: number) => Math.floor((x - anchor.x) / tilePx);
  const rowOf = (y: number) => Math.floor((y - anchor.y) / tileH);
  const startCol = colOf(bb.x) - 1;
  const endCol = colOf(bb.x + bb.width) + 1;
  const startRow = rowOf(bb.y) - 1;
  const endRow = rowOf(bb.y + bb.height) + 1;
  for (let row = startRow; row <= endRow; row += 1) {
    const y = anchor.y + row * tileH;
    const xOffset = settings.pattern === "brick" && row % 2 !== 0 ? tilePx / 2 : 0;
    for (let col = startCol; col <= endCol; col += 1) {
      const x = anchor.x + col * tilePx + xOffset;
      const yOffset =
        settings.pattern === "half-drop" && col % 2 !== 0 ? tileH / 2 : 0;
      pctx.drawImage(artwork, x, y + yOffset, tilePx, tileH);
    }
  }
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

  const viewState = template.views[view];

  // Step 1: Mockup base (optional x/y/scale alignment).
  ctx.clearRect(0, 0, W, H);
  const viewMockupAsset = viewState?.mockup ?? null;
  drawMockupImageInCanvas(ctx, mockup, viewMockupAsset, W, H);

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

  // `useColors` controls whether each panel paints the debug colour fill
  // instead of artwork. Solid-colors mode is the explicit "show me the
  // mask palette" mode. Missing artwork normally also shows debug fills
  // so the admin can verify mask coverage; the customer-facing placer
  // opts out with `solidColorFallback: false` so a freshly-loaded
  // template renders as a plain (background-tinted) hoodie.
  const solidColorFallback = params.solidColorFallback !== false;
  const useColors = mode === "solid-colors" || (!artwork && solidColorFallback);
  // Per-group design rects — the new core. Each group computes its
  // own anchor + base + effective rect from its panels' polygons.
  // The legacy single-rect path lives as a fallback inside
  // computeGroupRects when the template has no `designGroups`.
  const groupRects =
    mode === "single-sheet"
      ? computeGroupRects(template, view, artwork, {
          placementOverrides: params.groupPlacementOverrides,
          seamOverrides: params.groupSeamOverrides,
          enabledOverrides: params.groupEnabledOverrides,
          legacyPlacement: artworkPlacement,
        })
      : new Map<string, DesignRectInfo>();
  // Helper: which design rect should this layer sample from?
  const rectForLayer = (layer: MaskLayer): DesignRectInfo | null => {
    const group = findGroupForPanel(template.designGroups, layer.panelKey);
    if (group) return groupRects.get(group.id) ?? null;
    return groupRects.get("__legacy__") ?? groupRects.get("__ungrouped__") ?? null;
  };

  // Lazily-computed front-view group rects. Only the back-view hood
  // bridge needs them, so we avoid the (small but pointless) cost of
  // running computeGroupRects twice for non-back renders or for
  // templates without hood layers.
  let frontRectsCache: Map<string, DesignRectInfo> | null = null;
  const getFrontRects = (): Map<string, DesignRectInfo> => {
    if (frontRectsCache) return frontRectsCache;
    if (view === "front") {
      frontRectsCache = groupRects;
    } else {
      frontRectsCache =
        mode === "single-sheet"
          ? computeGroupRects(template, "front", artwork, {
              placementOverrides: params.groupPlacementOverrides,
              seamOverrides: params.groupSeamOverrides,
              enabledOverrides: params.groupEnabledOverrides,
              legacyPlacement: artworkPlacement,
            })
          : new Map<string, DesignRectInfo>();
    }
    return frontRectsCache;
  };
  const frontRectForPanel = (
    panelKey: HoodiePanelKey | null | undefined,
  ): DesignRectInfo | null => {
    if (!panelKey) return null;
    const group = findGroupForPanel(template.designGroups, panelKey);
    if (!group) return null;
    return getFrontRects().get(group.id) ?? null;
  };
  // Helper: is this panel the L or R half of a recognised seam pair?
  // Used to bias the synthSrc UV when seam allowance > 0.
  const seamSideForLayer = (layer: MaskLayer): "left" | "right" | "none" => {
    if (!layer.panelKey) return "none";
    if (SEAM_PAIR_PANELS.left.includes(layer.panelKey)) return "left";
    if (SEAM_PAIR_PANELS.right.includes(layer.panelKey)) return "right";
    return "none";
  };
  // Tile mode resolution: respect explicit params, else fall back to
  // template defaults seeded by normalizeHoodieTemplate.
  const tileSettings = params.tileSettings ?? template.tileSettings ?? null;
  const ppi =
    params.pixelsPerInch ??
    template.realWorldCalibration?.pixelsPerInch ??
    1024 / 24;

  for (const layer of printLayers) {
    const anchors = svgPathToAnchors(layer.maskPath);
    if (anchors.length < 3) continue;

    pctx.save();
    pathPolygon(pctx, anchors);
    pctx.clip();
    pctx.globalAlpha = layer.opacity;

    // Whether this panel actually receives artwork. When false, the
    // panel keeps just the background colour (or stays empty if no
    // bg) — exactly the "exclude sleeves from the design" use case.
    //
    // Signals that mute a panel, in priority order:
    //   1. `panelEnabledOverrides[panelKey] === false` — customer-
    //      level toggle (e.g. "cuffs & waistband off"). Always wins.
    //   2. The layer's design group is disabled (group-level toggle).
    //
    // `includeInSingleSheet === false` only opts a panel out of the
    // legacy whole-garment union — it still warps from its design
    // group's placement when that group is enabled (sleeves, trim, etc.).
    //
    // Per-panel-stretch ignores group/panel toggles (every panel
    // unconditionally takes the full artwork).
    const layerRect = rectForLayer(layer);
    const groupEnabled = layerRect ? layerRect.enabled : true;
    const panelOverride =
      layer.panelKey && params.panelEnabledOverrides
        ? params.panelEnabledOverrides[layer.panelKey]
        : undefined;
    const panelMutedByCustomer = panelOverride === false;
    const skipArtwork =
      panelMutedByCustomer ||
      (mode === "single-sheet" && !groupEnabled) ||
      (mode === "tile" && !groupEnabled);

    // Overlay panels (pocket, cuffs, waistband) sit above body/sleeve art in
    // the same print canvas — clear the clip before fill so muted panels
    // fully occlude artwork drawn earlier in the loop.
    if (
      skipArtwork &&
      panelMutedByCustomer &&
      backgroundColor &&
      layer.panelKey &&
      OVERLAY_OCCLUDER_PANEL_KEYS.has(layer.panelKey)
    ) {
      pctx.save();
      pathPolygon(pctx, anchors);
      pctx.clip();
      pctx.clearRect(0, 0, W, H);
      pctx.restore();
    }

    // Background colour fill — sits UNDER the artwork inside each
    // panel's polygon. Explicit `backgroundColor` fills every panel;
    // overlay panels (pocket, cuffs, waistband) auto-fill white when
    // excluded so body art does not bleed through the pocket zone.
    const fabricFill = panelFabricFillColor(layer, skipArtwork, backgroundColor);
    if (fabricFill && !useColors) {
      pctx.fillStyle = fabricFill;
      pctx.fillRect(0, 0, W, H);
    }

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
    } else if (
      view === "back" &&
      mode === "single-sheet" &&
      artwork &&
      layer.mesh &&
      layer.panelKey &&
      HOOD_BRIDGE_PANEL_KEYS.has(layer.panelKey)
    ) {
      // Hood flat-panel bridge: the back-of-hood is anatomically the
      // continuation of the front-of-hood (one fabric piece). We
      // build the flat printable panel from the FRONT-view layer's
      // mesh + the user's front-view placement, then warp THAT
      // through this back-view layer's mesh. Because both meshes
      // share calibration coordinates (admin used the same Printify
      // triangle artwork on both views), `sourceRect = full panel`
      // is the correct override.
      const frontLayer = findFrontLayerByPanelKey(template, layer.panelKey);
      const frontRect = frontRectForPanel(layer.panelKey);
      let drewBridge = false;
      if (frontLayer && frontRect && frontLayer.mesh) {
        // Resolve the calibration art image so we can size the flat
        // panel even when the mesh's sourceRect is null (which it
        // currently always is — the setLayerMeshSourceRect action
        // exists in the store but isn't wired to any UI). Prefer
        // the FRONT layer's calibration source; if it's missing
        // for some reason, fall back to the BACK layer's (admin
        // calibrated both views with the same Printify triangle
        // artwork, so dims match either way).
        const frontCalib =
          frontLayer.productionPanelSrc && layerSources
            ? layerSources.get(frontLayer.productionPanelSrc) ?? null
            : null;
        const backCalib =
          layer.productionPanelSrc && layerSources
            ? layerSources.get(layer.productionPanelSrc) ?? null
            : null;
        const calibImg = frontCalib ?? backCalib;
        const fallbackSize = calibImg
          ? {
              width: calibImg.naturalWidth || calibImg.width,
              height: calibImg.naturalHeight || calibImg.height,
            }
          : undefined;
        const flat = renderHoodFlatPanel(frontLayer, artwork, frontRect, {
          fallbackSize,
        });
        if (flat) {
          drawMeshWarp(pctx, flat, flat.width, flat.height, {
            ...layer.mesh,
            sourceRect: { x: 0, y: 0, width: flat.width, height: flat.height },
            // The flat panel already bakes in the front mesh's source
            // UV transform, so reset these on the back warp to avoid
            // double-applying.
            sourceRotation: 0,
            sourceFlipX: false,
            sourceFlipY: false,
          });
          drewBridge = true;
        }
      }
      if (!drewBridge && layerSrc) {
        // Bridge couldn't run (no front mesh / no front rect) →
        // fall back to calibration art so the admin still sees
        // SOMETHING and isn't confused by a blank back hood.
        drawMeshWarp(
          pctx,
          layerSrc,
          layerSrc.naturalWidth || layerSrc.width,
          layerSrc.naturalHeight || layerSrc.height,
          layer.mesh,
        );
      }
    } else if (mode === "tile" && tileSettings && artwork) {
      // Tile (repeating-pattern) mode.
      //
      // Mesh path (preferred): build a per-panel **flat tile sheet**
      // — tile the artwork in the panel's flat coordinate system so
      // the pattern runs along the panel's natural axis (sleeves
      // along the sleeve, hood along the hood arc, etc.) — then
      // warp that sheet through the panel's mesh. This mirrors how
      // Printify actually prints each panel and gives the customer
      // a preview that matches what they'll receive: the pattern
      // follows the panel's grain, gets fabric drape from the mesh,
      // and tiles uniformly within each panel.
      //
      // The grid is anchored at the flat-canvas center so each
      // panel's tile pattern is symmetric about its own centerline
      // — a deliberate mirror of how the mockup-coord version
      // anchors at canvas center. Cross-panel grid alignment isn't
      // attempted because Printify prints each panel from its own
      // flat tile sheet (no continuity at seams in the real garment).
      //
      // Fallback (no mesh): the legacy mockup-coord tile draw —
      // anchored at canvas center to keep the zip / hood-opening
      // symmetric.
      const bb = aabbOf(anchors);
      let drewTile = false;
      if (layer.mesh) {
        const flatTile = renderTiledFlatPanel(
          layer,
          artwork,
          tileSettings,
          ppi,
          W,
        );
        if (flatTile) {
          drawMeshWarp(pctx, flatTile, flatTile.width, flatTile.height, {
            ...layer.mesh,
            sourceRect: {
              x: 0,
              y: 0,
              width: flatTile.width,
              height: flatTile.height,
            },
            // Tile pattern is omnidirectional and already lives in
            // the panel's flat coord system — reset the calibration's
            // source UV transform so the mesh samples it as-is.
            sourceRotation: 0,
            sourceFlipX: false,
            sourceFlipY: false,
          });
          drewTile = true;
        }
      }
      if (!drewTile) {
        drawTileFlat(pctx, artwork, bb, tileSettings, ppi, {
          x: W / 2,
          y: H / 2,
        });
      }
      // Reference unused helper symbol so the import stays valid
      // for any future tile-mesh hybrid path.
      void tileSourceRect;
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
        layerRect &&
        layerRect.effective.width > 0 &&
        layerRect.effective.height > 0
      ) {
        const bb = aabbOf(anchors);
        if (bb) {
          synthSrc = synthesiseSeamAwareSourceRect(
            bb,
            layerRect,
            aw,
            ah,
            seamSideForLayer(layer),
          );
        }
      } else {
        // per-panel-stretch — every panel reads the full artwork.
        synthSrc = { x: 0, y: 0, width: aw, height: ah };
      }
      if (synthSrc) {
        drawMeshWarp(pctx, artwork, aw, ah, { ...layer.mesh, sourceRect: synthSrc });
      }
    } else if (artwork) {
      // No mesh on this layer — fall back to a flat stretched draw.
      if (mode === "tile" && tileSettings) {
        drawTileFlat(pctx, artwork, aabbOf(anchors), tileSettings, ppi);
      } else if (mode === "single-sheet" && layerRect) {
        // Apply seam allowance via UV inset by computing the slice
        // of the artwork the panel reads, then drawing that slice
        // stretched into the panel's bbox.
        const bb = aabbOf(anchors);
        if (bb) {
          const aw = artwork.naturalWidth || artwork.width;
          const ah = artwork.naturalHeight || artwork.height;
          const slice = synthesiseSeamAwareSourceRect(
            bb,
            layerRect,
            aw,
            ah,
            seamSideForLayer(layer),
          );
          pctx.drawImage(
            artwork,
            slice.x,
            slice.y,
            slice.width,
            slice.height,
            bb.x,
            bb.y,
            bb.width,
            bb.height,
          );
        }
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

    // Shading: bake mockup fabric folds into the panel fill + artwork.
    if (applyShading && !useColors) {
      applyMockupFabricShading(
        pctx,
        mockup,
        viewMockupAsset,
        W,
        H,
        backgroundColor,
      );
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
  // Step 6: Design-rect overlays — one dashed outline per group, the
  // active group highlighted brighter so the user knows which one
  // their handles edit.
  if (showDesignRect && mode === "single-sheet") {
    const activeId = params.activeGroupId ?? null;
    for (const info of Array.from(groupRects.values())) {
      const isActive = info.groupId === activeId;
      drawDesignRect(ctx, info, isActive);
    }
  }
}

function drawDesignRect(
  ctx: CanvasRenderingContext2D,
  info: DesignRectInfo,
  active: boolean,
): void {
  ctx.save();
  ctx.lineWidth = active ? 2 : 1.25;
  ctx.setLineDash([10, 6]);
  ctx.globalAlpha = active ? 1 : 0.45;
  ctx.strokeStyle = active ? "#f0abfc" : "#a78bfa";
  ctx.strokeRect(
    info.effective.x,
    info.effective.y,
    info.effective.width,
    info.effective.height,
  );
  // Centre crosshair on the anchor (seam line for paired groups,
  // panel centre otherwise).
  ctx.setLineDash([]);
  ctx.lineWidth = active ? 1.5 : 1;
  ctx.beginPath();
  ctx.moveTo(info.anchor.x - 12, info.anchor.y);
  ctx.lineTo(info.anchor.x + 12, info.anchor.y);
  ctx.moveTo(info.anchor.x, info.anchor.y - 12);
  ctx.lineTo(info.anchor.x, info.anchor.y + 12);
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
