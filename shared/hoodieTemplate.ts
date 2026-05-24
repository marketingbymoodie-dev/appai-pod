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
 *   - `mesh.points` are mockup pixel coordinates (NOT normalized).
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

export type MeshGrid = {
  cols: number;
  rows: number;
  /** Length must equal (cols+1)*(rows+1). Mockup pixel coords. */
  points: Pt[];
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
  width: number;
  height: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  /** "below" places overlay under masks; "above" places it on top for ghosting. */
  placement: "below" | "above";
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
