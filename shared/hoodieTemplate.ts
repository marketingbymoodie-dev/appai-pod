/**
 * Shared types for the Hoodie Template Mapper (admin remapping engine).
 *
 * This is the v1 JSON schema that the admin tool reads and writes.
 * It is intentionally complete from the start so subsequent phases can
 * fill in more fields without bumping the version. Phase 1 only writes
 * `views.{front,back}.mockup` and `meta`; later phases add mask layers,
 * mesh data, exclusions, reference overlays, etc.
 *
 * Coordinate conventions:
 *   - Mockup pixel coordinates: origin top-left, +x right, +y down,
 *     measured against `MockupAsset.width` x `MockupAsset.height`.
 *   - `maskPath` uses SVG path "d" syntax in mockup pixel coordinates.
 *   - `mesh.targetPoints` are mockup pixel coordinates (NOT normalized);
 *     source UVs are computed implicitly from the grid and `sourceRect`.
 *
 * Storage:
 *   - Templates live as JSON under tmp/hoodie-templates/templates/<name>.json
 *     (filesystem-backed dev API).
 *   - Mockups uploaded by admins are written to
 *     tmp/hoodie-templates/mockups/<filename>.png and referenced by URL.
 */

export const HOODIE_TEMPLATE_VERSION = "hoodie-template/v1";

export type HoodieView = "front" | "back";

/**
 * Stable canonical panel keys. The admin tool exposes the user-facing
 * subset per view; these keys are the source of truth for the JSON.
 */
export type HoodiePanelKey =
  | "front_right"
  | "front_left"
  | "front_pocket"
  | "left_sleeve"
  | "right_sleeve"
  | "left_cuff"
  | "right_cuff"
  | "left_hood"
  | "right_hood"
  | "waistband"
  | "back";

export type HoodieToolId =
  | "move"
  | "polygon-pen"
  | "magnetic-pen"
  | "mesh-warp"
  | "corner-pin"
  | "rotate"
  | "scale";

export type Pt = { x: number; y: number };

/** SVG path "d=" attribute. */
export type SvgPathD = string;

/** Top-left, top-right, bottom-right, bottom-left in mockup pixel coords. */
export type CornerPins = [Pt, Pt, Pt, Pt];

/**
 * Rectangular sub-region of a source artwork sheet that a mesh samples
 * from. Lets the front-view sleeve mask reference the front-half of the
 * full sleeve artwork, while the back-view sleeve mask references the
 * back-half of the same artwork file.
 *
 * Coordinates are in source-image pixels.
 */
export type SourceRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Quantised source-image rotation applied before warping. Lets a sleeve
 * artwork sheet that ships portrait-oriented be turned 90° to match a
 * landscape sleeve polygon without re-tracing or re-deforming the mesh.
 */
export type MeshSourceRotation = 0 | 90 | 180 | 270;

/**
 * Mesh warp grid for projecting a rectangular slice of a panel artwork
 * onto an irregular hoodie panel polygon. The mesh is regular in source
 * space (`cols × rows` evenly spaced grid points spanning `sourceRect`)
 * and irregular in target space (each grid point's position on the
 * mockup is editable, allowing fabric curvature, sleeve foreshortening,
 * and similar real-world distortions).
 *
 * Source UVs are computed implicitly: for grid point `(col, row)` they
 * are `(col / (cols-1), row / (rows-1))` mapped through `sourceRect`,
 * then rotated/flipped per `sourceRotation`/`sourceFlipX`/`sourceFlipY`.
 * Stored explicitly only the `targetPoints` so the JSON stays compact.
 *
 * Length invariant: `targetPoints.length === cols * rows`.
 */
export type MeshGrid = {
  /** 2..16 — number of columns in the control grid. */
  cols: number;
  /** 2..16 — number of rows. */
  rows: number;
  /**
   * Sub-region of the source artwork the mesh samples. `null` means use
   * the entire artwork as the source rectangle.
   */
  sourceRect: SourceRect | null;
  /** Row-major: index = row * cols + col. Mockup pixel coords. */
  targetPoints: Pt[];
  /**
   * Rotation applied to the source UVs before sampling, in degrees CW.
   * Defaults to 0 when omitted (legacy data).
   */
  sourceRotation?: MeshSourceRotation;
  /** Mirror the source horizontally (after rotation). Default false. */
  sourceFlipX?: boolean;
  /** Mirror the source vertically (after rotation). Default false. */
  sourceFlipY?: boolean;
};

export type Transform2D = {
  x: number;
  y: number;
  /** radians */
  rotation: number;
  scaleX: number;
  scaleY: number;
  skewX: number;
  skewY: number;
};

export const IDENTITY_TRANSFORM_2D: Transform2D = {
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  skewX: 0,
  skewY: 0,
};

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "soft-light"
  | "hard-light"
  | "darken"
  | "lighten";

export type MaskLayerKind = "panel" | "exclusion" | "reference";

export type MaskLayer = {
  id: string;
  view: HoodieView;
  /** Null for exclusions / reference overlays / unassigned scratch layers. */
  panelKey: HoodiePanelKey | null;
  kind: MaskLayerKind;
  name: string;
  visible: boolean;
  locked: boolean;
  zIndex: number;
  opacity: number;
  blendMode: BlendMode;
  /** SVG path in mockup pixel coords. May be empty for not-yet-drawn layers. */
  maskPath: SvgPathD;
  cornerPins: CornerPins | null;
  mesh: MeshGrid | null;
  transform: Transform2D;
  /** Friendly admin-assigned name for the upstream Printify panel (e.g. "Printify Left Sleeve"). */
  productionPanelAssignment: string | null;
  /** Optional URL to an uploaded production panel SVG/PNG used as preview source. */
  productionPanelSrc: string | null;
  /** True for exclusion masks that block artwork (zipper, hood interior, etc.). */
  isExclusion: boolean;
  /** Free-form admin notes. */
  notes?: string;
};

export type MockupAsset = {
  /** Absolute or app-relative URL to the uploaded mockup PNG. */
  src: string;
  width: number;
  height: number;
};

export type ReferenceOverlayAsset = {
  src: string;
  /** Natural image dimensions (in image pixels). Stays constant. */
  width: number;
  height: number;
  opacity: number;
  visible: boolean;
  /** When false, the canvas exposes drag + corner-resize handles. */
  locked: boolean;
  /** "below" places overlay under masks; "above" places it on top for ghosting. */
  placement: "below" | "above";
  /**
   * Top-left position of the rendered overlay in mockup pixels. Defaults
   * to (0, 0) so legacy uploads stay where they were.
   */
  x?: number;
  y?: number;
  /**
   * Uniform scale applied to (width, height). Defaults to 1. Aspect
   * ratio is locked — the editor only exposes proportional resize
   * handles so the reference image can never be squished.
   */
  scale?: number;
};

export type HoodieViewState = {
  mockup: MockupAsset | null;
  referenceOverlay: ReferenceOverlayAsset | null;
  layers: MaskLayer[];
};

export type HoodieTemplate = {
  version: typeof HOODIE_TEMPLATE_VERSION;
  /** Admin-friendly slug, e.g. "zip-hoodie-aop-L". Unique per template file. */
  name: string;
  /** Human label e.g. "Zip Hoodie AOP — Size L". */
  label: string;
  hoodieType: string;
  productTypeId: number | null;
  blueprintId: number | null;
  size: string | null;
  meta: {
    createdAt: string;
    updatedAt: string;
    /** ID of the editor session that last modified this template (optional). */
    lastEditedBy?: string;
  };
  views: Record<HoodieView, HoodieViewState>;
  /**
   * Cross-view exclusions referenced by mask layers (e.g. "zipper", "hood-interior").
   * Each entry is the canonical id; matching exclusion mask layers carry the id in their name/notes.
   */
  globalExclusions: string[];
};

export const EMPTY_HOODIE_VIEW: HoodieViewState = {
  mockup: null,
  referenceOverlay: null,
  layers: [],
};

export function emptyHoodieTemplate(name: string, label?: string): HoodieTemplate {
  const now = new Date().toISOString();
  return {
    version: HOODIE_TEMPLATE_VERSION,
    name,
    label: label ?? name,
    hoodieType: "zip-hoodie-aop",
    productTypeId: 20,
    blueprintId: 451,
    size: "L",
    meta: { createdAt: now, updatedAt: now },
    views: {
      front: { ...EMPTY_HOODIE_VIEW },
      back: { ...EMPTY_HOODIE_VIEW },
    },
    globalExclusions: [],
  };
}

/**
 * Panel keys that are valid per view. Front/back share sleeves/cuffs/hood/waistband
 * because the admin sees them rotated to that view.
 */
export const PANELS_PER_VIEW: Record<HoodieView, readonly HoodiePanelKey[]> = {
  front: [
    "front_right",
    "front_left",
    "front_pocket",
    "left_sleeve",
    "right_sleeve",
    "left_cuff",
    "right_cuff",
    "left_hood",
    "right_hood",
    "waistband",
  ],
  back: [
    "back",
    "left_sleeve",
    "right_sleeve",
    "left_cuff",
    "right_cuff",
    "left_hood",
    "right_hood",
    "waistband",
  ],
} as const;

export const PANEL_DISPLAY_LABEL: Record<HoodiePanelKey, string> = {
  front_right: "Front Right",
  front_left: "Front Left",
  front_pocket: "Front Pocket",
  left_sleeve: "Left Sleeve",
  right_sleeve: "Right Sleeve",
  left_cuff: "Left Cuff",
  right_cuff: "Right Cuff",
  left_hood: "Left Hood",
  right_hood: "Right Hood",
  waistband: "Waistband",
  back: "Back",
};

/**
 * Anatomical render order for hoodie panels. Pieces that physically sit
 * on top of others on the garment must draw on top in the renderer too —
 * otherwise a kangaroo pocket gets covered by the front-left body panel,
 * cuffs disappear under sleeves, etc.
 *
 * Higher number = drawn later (on top). The mapper canvas, the AOP
 * preview, and any future production renderer all share this ordering.
 *
 * The user's per-layer `zIndex` is still respected as a tiebreaker WITHIN
 * the same anatomical tier — the Forward/Back buttons in the Properties
 * panel let you rearrange e.g. two overlapping shadow passes on the same
 * Front Left panel — but they will not push a body panel above the
 * pocket. That ordering is structurally correct so it shouldn't be a
 * per-layer chore.
 */
export const PANEL_RENDER_ORDER: Record<HoodiePanelKey, number> = {
  back: 10,
  front_left: 20,
  front_right: 20,
  left_sleeve: 30,
  right_sleeve: 30,
  left_hood: 40,
  right_hood: 40,
  left_cuff: 50,
  right_cuff: 50,
  waistband: 60,
  front_pocket: 70,
};

/** Tier used when a layer has no panelKey assigned yet. Sits in the middle so unassigned scratch layers don't all collapse to the bottom of the stack. */
const UNASSIGNED_RENDER_TIER = 35;

/**
 * Generate a default rectangular mesh that fills `bounds` (mockup pixels).
 * Used to initialise a layer's mesh on the first switch to the mesh-warp
 * tool — the user can then drag interior control points to deform the
 * grid against fabric curvature.
 */
export function createDefaultMesh(
  bounds: { x: number; y: number; width: number; height: number },
  cols = 4,
  rows = 4,
  sourceRect: SourceRect | null = null,
): MeshGrid {
  const safeCols = Math.max(2, Math.min(16, Math.floor(cols)));
  const safeRows = Math.max(2, Math.min(16, Math.floor(rows)));
  const targetPoints: Pt[] = [];
  for (let r = 0; r < safeRows; r += 1) {
    const v = r / (safeRows - 1);
    for (let c = 0; c < safeCols; c += 1) {
      const u = c / (safeCols - 1);
      targetPoints.push({
        x: bounds.x + u * bounds.width,
        y: bounds.y + v * bounds.height,
      });
    }
  }
  return { cols: safeCols, rows: safeRows, sourceRect, targetPoints };
}

/**
 * Resize an existing mesh to a new (cols, rows) shape, preserving the
 * deformation as much as possible by bilinearly resampling the target
 * positions of the old grid into the new grid.
 *
 * Falls back to a default rectangular mesh if the old mesh is empty or
 * malformed.
 */
export function resizeMesh(
  mesh: MeshGrid,
  newCols: number,
  newRows: number,
  fallbackBounds: { x: number; y: number; width: number; height: number },
): MeshGrid {
  const safeCols = Math.max(2, Math.min(16, Math.floor(newCols)));
  const safeRows = Math.max(2, Math.min(16, Math.floor(newRows)));
  const old = mesh.targetPoints;
  if (
    old.length !== mesh.cols * mesh.rows ||
    mesh.cols < 2 ||
    mesh.rows < 2
  ) {
    return createDefaultMesh(fallbackBounds, safeCols, safeRows, mesh.sourceRect);
  }
  const targetPoints: Pt[] = [];
  for (let r = 0; r < safeRows; r += 1) {
    const v = r / (safeRows - 1);
    const yIdx = v * (mesh.rows - 1);
    const y0 = Math.floor(yIdx);
    const y1 = Math.min(mesh.rows - 1, y0 + 1);
    const ty = yIdx - y0;
    for (let c = 0; c < safeCols; c += 1) {
      const u = c / (safeCols - 1);
      const xIdx = u * (mesh.cols - 1);
      const x0 = Math.floor(xIdx);
      const x1 = Math.min(mesh.cols - 1, x0 + 1);
      const tx = xIdx - x0;
      const tl = old[y0 * mesh.cols + x0];
      const tr = old[y0 * mesh.cols + x1];
      const bl = old[y1 * mesh.cols + x0];
      const br = old[y1 * mesh.cols + x1];
      const top = { x: tl.x + (tr.x - tl.x) * tx, y: tl.y + (tr.y - tl.y) * tx };
      const bot = { x: bl.x + (br.x - bl.x) * tx, y: bl.y + (br.y - bl.y) * tx };
      targetPoints.push({
        x: top.x + (bot.x - top.x) * ty,
        y: top.y + (bot.y - top.y) * ty,
      });
    }
  }
  return { cols: safeCols, rows: safeRows, sourceRect: mesh.sourceRect, targetPoints };
}

/**
 * Combined render priority for a mask layer. Sorts ascending: lower
 * priority draws first (background), higher priority draws on top.
 *
 * Combines an anatomical tier (per panelKey) with the user's per-layer
 * zIndex so the Forward/Back buttons still have a useful within-tier
 * effect. Multiplying tier by 1000 means user zIndex (small integers)
 * never crosses tier boundaries.
 */
export function layerRenderPriority(layer: MaskLayer): number {
  const tier = layer.panelKey
    ? (PANEL_RENDER_ORDER[layer.panelKey] ?? UNASSIGNED_RENDER_TIER)
    : UNASSIGNED_RENDER_TIER;
  return tier * 1000 + layer.zIndex;
}
