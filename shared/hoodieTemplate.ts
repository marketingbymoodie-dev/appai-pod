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
/** Printify blueprint 450 (pullover) — front/back/sleeves + kangaroo pocket panel. */
export const PULOVER_HOODIE_BLUEPRINT_ID = 450;
/** Preview-only: pullover front chest placement renders ~5% larger to match Printify. */
export const PULOVER_FRONT_BODY_PREVIEW_PLACEMENT_SCALE = 1.05;
/**
 * Place-on-item print export only: shrink pullover main `front` artwork so the
 * chest print file isn't clipped at the neck / hood seam on Printify.
 * (0.93 × 0.95 ≈ another 5% after the first merchant trim.)
 */
export const PULOVER_FRONT_BODY_PRINT_ARTWORK_SCALE = 0.8835;
/** Printify blueprint 451 (zip) — split front_left / front_right placeholders. */
export const ZIP_HOODIE_BLUEPRINT_ID = 451;
/** Printify blueprint 449 (unisex sweatshirt AOP) — collar + cuffs, no hood. */
export const SWEATSHIRT_BLUEPRINT_ID = 449;
/** Printify blueprint 220 (spun polyester pillow wrap AOP) — two faces, wide print canvas. */
export const PILLOW_WRAP_BLUEPRINT_ID = 220;
/** Printify blueprint 223 (faux suede square pillow AOP) — same two-face wrap layout as bp 220. */
export const FAUX_SUEDE_PILLOW_WRAP_BLUEPRINT_ID = 223;
/** Printify blueprint 2758 (body pillow AOP) — long wrap, front + back faces only. */
export const BODY_PILLOW_WRAP_BLUEPRINT_ID = 2758;
/** Printify blueprint 538 (lumbar pillow AOP) — separate front/back print files. */
export const LUMBAR_PILLOW_WRAP_BLUEPRINT_ID = 538;

/** All Printify blueprint ids that share the pillow wrap editor (front/back faces, no hood/sleeves). */
export const PILLOW_WRAP_BLUEPRINT_IDS: readonly number[] = [
  PILLOW_WRAP_BLUEPRINT_ID,
  FAUX_SUEDE_PILLOW_WRAP_BLUEPRINT_ID,
  LUMBAR_PILLOW_WRAP_BLUEPRINT_ID,
  BODY_PILLOW_WRAP_BLUEPRINT_ID,
];

export type WrapBackMode = "duplicate" | "solid-color";

/** Storefront placer UI — hoodie garment parts vs front/back pillow faces. */
export type PlacerEditor = "hoodie" | "front-back-face";

/** Order-time Printify print_areas — one wide canvas vs separate front/back files. */
export type PrintFileLayout = "wrap-single" | "split-front-back";

/** Garment part layout when placerEditor is hoodie — full hoodie vs sleeves-only jumper. */
export type GarmentLayout = "hoodie" | "jumper-no-hood";

export type HoodiePanelKey =
  | "front"
  | "front_right"
  | "front_left"
  | "front_pocket"
  | "pocket_left"
  | "pocket_right"
  | "left_sleeve"
  | "right_sleeve"
  | "left_cuff"
  | "right_cuff"
  | "collar_front"
  | "collar_back"
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
 * Source-image rotation in degrees (clockwise positive), applied before
 * warping. Stored as an arbitrary number so the user can drag a rotate
 * handle freely; the previous quantised 0/90/180/270 values remain valid
 * data and stay backward-compatible.
 */
export type MeshSourceRotation = number;

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
/** Max mesh columns (mapper slider + engine clamp). Wide panels e.g. collar strips. */
export const MAX_MESH_COLS = 24;
/** Max mesh rows (mapper slider + engine clamp). */
export const MAX_MESH_ROWS = 16;

export type MeshGrid = {
  /** 2..{@link MAX_MESH_COLS} — number of columns in the control grid. */
  cols: number;
  /** 2..{@link MAX_MESH_ROWS} — number of rows. */
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
   * Free-form (any number); UI typically normalises to [-180, 180].
   * Defaults to 0 when omitted (legacy data).
   */
  sourceRotation?: number;
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
  /**
   * In single-sheet AOP mode, controls whether this panel participates
   * in the design (i.e. receives the customer artwork and contributes
   * its bounding box to the union design canvas). Default: undefined
   * → treated as `true` for back-compat with templates traced before
   * this flag existed.
   *
   * Setting this to `false` lets an admin keep the panel polygon
   * around (still useful for per-panel modes, calibration verification,
   * exclusion punching) while pulling it out of the single-sheet
   * composition — e.g. excluding sleeves so a portrait artwork only
   * spans hood + body and the sleeves take the background colour.
   */
  includeInSingleSheet?: boolean;
  /** Free-form admin notes. */
  notes?: string;
};

export type MockupAsset = {
  /** Absolute or app-relative URL to the uploaded mockup PNG. */
  src: string;
  width: number;
  height: number;
  /**
   * Top-left position of the rendered mockup in template pixel space.
   * Masks stay in the original width×height grid; transform only moves/scales
   * the blank photo so it can align with reused zip-hoodie panel maps.
   */
  x?: number;
  y?: number;
  /** Uniform scale applied to (width, height). Defaults to 1. */
  scale?: number;
  /** When false, the canvas exposes drag + corner-resize on the base mockup. */
  transformLocked?: boolean;
};

/** Resolved draw rect for a mockup blank (template pixel space). */
export function mockupDrawRect(mockup: MockupAsset): {
  x: number;
  y: number;
  scale: number;
  renderWidth: number;
  renderHeight: number;
} {
  const scale = mockup.scale ?? 1;
  return {
    x: mockup.x ?? 0,
    y: mockup.y ?? 0,
    scale,
    renderWidth: mockup.width * scale,
    renderHeight: mockup.height * scale,
  };
}

/** Draw the base mockup image with any saved transform applied. */
export function drawMockupImage(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  mockup: MockupAsset,
): void {
  const { x, y, renderWidth, renderHeight } = mockupDrawRect(mockup);
  ctx.drawImage(image, x, y, renderWidth, renderHeight);
}

/**
 * Draw a mockup into a fixed-size canvas using the view's saved transform
 * when present. Used by every hoodie AOP renderer path (base layer and
 * per-panel shading multiply) so repositioned/scaled blanks never ghost
 * a second full-canvas copy at (0,0).
 */
export function drawMockupImageInCanvas(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  mockup: MockupAsset | null | undefined,
  width: number,
  height: number,
): void {
  if (mockup) {
    drawMockupImage(ctx, image, mockup);
    return;
  }
  ctx.drawImage(image, 0, 0, width, height);
}

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

/**
 * Customer-facing artwork placement applied to a single design group.
 * Mirrors the renderer's ArtworkPlacement (kept duplicated in client
 * code as well, but the canonical type lives here so the template
 * file can be parsed without touching client modules).
 */
export type GroupPlacement = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

export const DEFAULT_GROUP_PLACEMENT: GroupPlacement = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
};

/** Per-subset UV sampling bias within a design group (% of group design rect). */
export type PanelPlacementBiasPercent = {
  offsetXPercent: number;
  offsetYPercent: number;
};

export const ZERO_PANEL_PLACEMENT_BIAS: PanelPlacementBiasPercent = {
  offsetXPercent: 0,
  offsetYPercent: 0,
};

/** Zip front-body chest vs pocket artwork sampling offsets (admin defaults). */
export type FrontBodyPanelPlacementBias = {
  chest?: PanelPlacementBiasPercent;
  pocket?: PanelPlacementBiasPercent;
};

export const FRONT_CHEST_PANEL_KEYS: HoodiePanelKey[] = ["front_left", "front_right"];
/** Chest + kangaroo pocket panels in the front-body group (zip halves + pullover). */
export const FRONT_POCKET_PANEL_KEYS: HoodiePanelKey[] = [
  "pocket_left",
  "pocket_right",
  "front_pocket",
];

/** All customer-toggle pocket panels (pullover kangaroo + zip halves). */
export const KANGAROO_POCKET_PANEL_KEYS: HoodiePanelKey[] = [
  "front_pocket",
  "pocket_left",
  "pocket_right",
];

export function isKangarooPocketPanelKey(
  panelKey: HoodiePanelKey | null | undefined,
): boolean {
  return !!panelKey && KANGAROO_POCKET_PANEL_KEYS.includes(panelKey);
}

/** Customer Pockets toggle on (explicit true, or unset = on). */
export function shouldRenderKangarooPocketArtwork(
  panelKey: HoodiePanelKey | null | undefined,
  panelOverride: boolean | undefined,
): boolean {
  return isKangarooPocketPanelKey(panelKey) && panelOverride !== false;
}

/**
 * Move `front_pocket` from the always-disabled `trim` group into `front-body`
 * so toggling Pockets on can actually render / export artwork. Idempotent.
 *
 * Also strips duplicate `front_pocket` entries left in `trim` when both groups
 * already list the key (stale persisted templates).
 */
export function migrateFrontPocketOutOfTrimGroup(
  designGroups: DesignGroup[],
): DesignGroup[] {
  const frontBodyIdx = designGroups.findIndex((g) => g.id === "front-body");
  if (frontBodyIdx < 0) return designGroups;

  let groups = designGroups.map((g) => {
    if (g.id === "trim") {
      return { ...g, panelKeys: g.panelKeys.filter((k) => k !== "front_pocket") };
    }
    return g;
  });

  const fb = groups[frontBodyIdx];
  if (!fb.panelKeys.includes("front_pocket")) {
    groups = groups.map((g, i) =>
      i === frontBodyIdx ? { ...g, panelKeys: [...g.panelKeys, "front_pocket"] } : g,
    );
  }

  return groups;
}

export function mergePanelPlacementBiasPercent(
  base?: Partial<PanelPlacementBiasPercent> | null,
  override?: Partial<PanelPlacementBiasPercent> | null,
): PanelPlacementBiasPercent {
  return {
    offsetXPercent: override?.offsetXPercent ?? base?.offsetXPercent ?? 0,
    offsetYPercent: override?.offsetYPercent ?? base?.offsetYPercent ?? 0,
  };
}

export function mergeFrontBodyPanelPlacementBias(
  stored?: FrontBodyPanelPlacementBias | null,
  override?: FrontBodyPanelPlacementBias | null,
): FrontBodyPanelPlacementBias {
  return {
    chest: mergePanelPlacementBiasPercent(stored?.chest, override?.chest),
    pocket: mergePanelPlacementBiasPercent(stored?.pocket, override?.pocket),
  };
}

/** Resolve chest/pocket UV bias for a panel in the front-body group. */
export function resolveFrontBodyPanelBias(
  group: Pick<DesignGroup, "panelPlacementBias">,
  panelKey: HoodiePanelKey | null | undefined,
  override?: FrontBodyPanelPlacementBias | null,
): PanelPlacementBiasPercent | null {
  if (!panelKey) return null;
  const merged = mergeFrontBodyPanelPlacementBias(group.panelPlacementBias, override);
  if (FRONT_CHEST_PANEL_KEYS.includes(panelKey)) return merged.chest ?? ZERO_PANEL_PLACEMENT_BIAS;
  if (FRONT_POCKET_PANEL_KEYS.includes(panelKey)) return merged.pocket ?? ZERO_PANEL_PLACEMENT_BIAS;
  return null;
}

/**
 * A "design group" bundles related panels (e.g. front_left + front_right
 * = the front body) so they can be scaled/positioned together,
 * independent of other groups. The artwork still comes from the global
 * upload — each group just controls how much of that artwork lands on
 * its panels. A group with an L/R seam pair (front body, hood) can
 * specify a `seamAllowance` so the customer's design doesn't visually
 * cross the physical seam.
 */
export type DesignGroup = {
  id: string;
  /** Human label shown in the UI ("Hood", "Front body", etc.). */
  name: string;
  /**
   * Panel keys that participate in this group. Panels in the same
   * group share one design rect / placement / seam allowance, so they
   * appear as a single coherent surface.
   */
  panelKeys: HoodiePanelKey[];
  /**
   * Per-view placement so the front-body group's offset doesn't
   * follow the user when they tab to back. Hood placements stay
   * independent in Phase 2; Phase 3 will optionally link them for
   * the front↔back wrap.
   */
  placement: Record<HoodieView, GroupPlacement>;
  /**
   * Width of the seam (centre seam between L and R panels of this
   * group), expressed as a percentage of the group's design rect
   * width. The renderer trims this strip out of the artwork's middle
   * so the L and R panels don't visually share pixels across what
   * would be a sewn seam in real life. Range 0..15. Only applied
   * when the group contains a known L/R pair (zip seam for front
   * body, centre seam for hood). 0 = no seam compensation.
   */
  seamAllowance: number;
  /**
   * When the lock-ratio toggle is on, this stores the captured scale
   * for this group at the moment the lock was engaged. Dragging any
   * locked group's scale rescales the others proportionally so the
   * captured ratios are preserved. `null` = not currently locked.
   */
  lockedRatio: number | null;
  /** When false, this group's panels render the background colour only (no artwork). */
  enabled: boolean;
  /**
   * Optional per-subset UV bias for zip front-body panels. Shifts which
   * slice of the shared design rect each chest/pocket panel samples without
   * moving the group's placement handle. Percent of the group's effective
   * design rect width/height.
   */
  panelPlacementBias?: FrontBodyPanelPlacementBias;
};

/**
 * Repeating-tile mode settings — when the AOP mode is `tile`, the
 * artwork tiles uniformly across every panel under the calibrated
 * meshes at a real-world size. Independent of design groups (groups
 * only matter for single-sheet mode).
 */
export type TileSettings = {
  /** Tile pattern arrangement. */
  pattern: "grid" | "brick" | "half-drop";
  /**
   * Real-world size of one tile in inches. The renderer converts this
   * to mockup pixels using `realWorldCalibration.pixelsPerInch`, so
   * the same template can output a "1.5 inch tile" preview that
   * matches what Printify would actually print.
   */
  tileSizeInches: number;
};

export const DEFAULT_TILE_SETTINGS: TileSettings = {
  pattern: "grid",
  tileSizeInches: 1.5,
};

/**
 * Anchor for converting mockup pixels to real-world units. Required
 * for the tile-size slider to be physically meaningful. The admin
 * sets it once based on a known measurement (e.g. "the front-body
 * panel is 22 inches wide on the size L hoodie") and the renderer
 * derives the px/inch ratio from there.
 */
export type RealWorldCalibration = {
  /** How many mockup pixels equal one real-world inch on the hoodie's surface. */
  pixelsPerInch: number;
};

/** Sensible default for a 1024-px-wide mockup of a size-L hoodie body (~24"). */
export const DEFAULT_REAL_WORLD_CALIBRATION: RealWorldCalibration = {
  pixelsPerInch: 1024 / 24,
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
  /**
   * Design groups — collections of panels that scale and translate
   * together in single-sheet mode. Optional for back-compat; older
   * templates fall back to "everything is one group" inside the
   * renderer. Edited in the AOP modal and persisted as defaults.
   */
  designGroups?: DesignGroup[];
  /** Repeating-tile mode settings (independent of designGroups). */
  tileSettings?: TileSettings;
  /** Mockup-px ↔ real-world conversion. Used by the tile-size slider. */
  realWorldCalibration?: RealWorldCalibration;
  /**
   * Pillow wrap templates: customer chooses duplicate art on both faces or
   * solid colour on the back face. Stored on published template as default;
   * customer placer state overrides at runtime.
   */
  wrapBackMode?: WrapBackMode;
  /** Storefront editor controls — hoodie parts vs front/back faces only. */
  placerEditor?: PlacerEditor;
  /** Order fulfillment hint — side-by-side wrap canvas vs split front/back PNGs. */
  printFileLayout?: PrintFileLayout;
  /** Hoodie editor only — full garment (hood/pockets) vs front/back/sleeves without hood. */
  garmentLayout?: GarmentLayout;
};

export const EMPTY_HOODIE_VIEW: HoodieViewState = {
  mockup: null,
  referenceOverlay: null,
  layers: [],
};

/**
 * Sensible default design groups for the zip-hoodie-aop template.
 * Existing templates without a `designGroups` field fall through to
 * this list at load time so the AOP preview behaves as expected
 * without needing a manual migration step. Five groups, deliberately
 * matching the user's mental model:
 *   - Hood (L+R, paired)
 *   - Front body (L+R + pocket halves, paired) — pocket joins the
 *     front zip seam allowance per the user's request
 *   - Back body (single panel)
 *   - Sleeves (L+R + cuffs)
 *   - Trim (waistband + legacy front_pocket)
 */
export function defaultDesignGroups(): DesignGroup[] {
  const blank: GroupPlacement = { ...DEFAULT_GROUP_PLACEMENT };
  const blankPair: Record<HoodieView, GroupPlacement> = {
    front: { ...blank },
    back: { ...blank },
  };
  return [
    {
      id: "hood",
      name: "Hood",
      panelKeys: ["left_hood", "right_hood"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
    {
      id: "front-body",
      name: "Front body",
      // Pocket halves ride with the front body so the customer's
      // print continues across the pocket / chest boundary using
      // the same zip-seam allowance.
      panelKeys: ["front_left", "front_right", "pocket_left", "pocket_right"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
    {
      id: "back-body",
      name: "Back body",
      panelKeys: ["back"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
    {
      // Sleeves are physically separate fabric tubes, NOT an L/R
      // seam pair — splitting them into independent groups means
      // their union AABBs don't collide across the front torso when
      // both are enabled.
      id: "left-sleeve",
      name: "Left sleeve",
      panelKeys: ["left_sleeve", "left_cuff"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
    {
      id: "right-sleeve",
      name: "Right sleeve",
      panelKeys: ["right_sleeve", "right_cuff"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
    {
      id: "trim",
      name: "Trim",
      panelKeys: ["waistband", "front_pocket"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
  ];
  // Hint to TS that we're definitely returning the right shape.
  void blankPair;
}

/**
 * Design groups for pullover hoodies (Printify bp 450): one continuous
 * `front` body panel under the kangaroo pocket — no zip L/R split.
 */
export function defaultPulloverDesignGroups(): DesignGroup[] {
  const blank: GroupPlacement = { ...DEFAULT_GROUP_PLACEMENT };
  const blankPair: Record<HoodieView, GroupPlacement> = {
    front: { ...blank },
    back: { ...blank },
  };
  return [
    {
      id: "hood",
      name: "Hood",
      panelKeys: ["left_hood", "right_hood"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
    {
      id: "front-body",
      name: "Front body",
      // Kangaroo pocket rides with the front body (like the zip hoodie's
      // pocket halves) so toggling Pockets on actually enables artwork —
      // `trim` is always force-disabled at render time (waistband/cuffs
      // must stay solid), so a pocket left there could never show artwork.
      panelKeys: ["front", "front_pocket"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
    {
      id: "back-body",
      name: "Back body",
      panelKeys: ["back"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
    {
      id: "left-sleeve",
      name: "Left sleeve",
      panelKeys: ["left_sleeve", "left_cuff"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
    {
      id: "right-sleeve",
      name: "Right sleeve",
      panelKeys: ["right_sleeve", "right_cuff"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
    {
      id: "trim",
      name: "Trim",
      panelKeys: ["waistband"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
  ];
  void blankPair;
}

/**
 * Design groups for sweatshirt AOP (Printify bp 449): full front/back body,
 * sleeves (no cuffs — cuffs live in trim), trim (cuffs + waistband + neck rib).
 */
export function defaultSweatshirtDesignGroups(): DesignGroup[] {
  const blank: GroupPlacement = { ...DEFAULT_GROUP_PLACEMENT };
  const blankPair: Record<HoodieView, GroupPlacement> = {
    front: { ...blank },
    back: { ...blank },
  };
  return [
    {
      id: "front-body",
      name: "Front body",
      panelKeys: ["front"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
    {
      id: "back-body",
      name: "Back body",
      panelKeys: ["back"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
    {
      id: "left-sleeve",
      name: "Left sleeve",
      panelKeys: ["left_sleeve"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
    {
      id: "right-sleeve",
      name: "Right sleeve",
      panelKeys: ["right_sleeve"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
    {
      id: "trim",
      name: "Trim",
      panelKeys: ["waistband", "left_cuff", "right_cuff", "collar_front", "collar_back"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
  ];
  void blankPair;
}

/** Sweatshirt trim panel keys — cuffs, waistband, and neck rib. */
export const SWEATSHIRT_TRIM_PANEL_KEYS: readonly HoodiePanelKey[] = [
  "waistband",
  "left_cuff",
  "right_cuff",
  "collar_front",
  "collar_back",
];

/**
 * Normalize design groups for bp 449: strip hood, merge collar into trim,
 * split cuffs out of sleeve groups. Preserves admin placement on matching ids.
 */
export function migrateSweatshirtDesignGroups(groups: DesignGroup[]): DesignGroup[] {
  const defaults = defaultSweatshirtDesignGroups();
  const withoutHood = groups.filter((g) => g.id !== "hood");
  const collar = withoutHood.find((g) => g.id === "collar");
  const filtered = withoutHood.filter((g) => g.id !== "collar");

  const byId = new Map<string, DesignGroup>();
  for (const g of filtered) {
    let panelKeys = [...g.panelKeys];
    if (g.id === "left-sleeve") {
      panelKeys = panelKeys.filter((k) => k !== "left_cuff");
      if (!panelKeys.includes("left_sleeve")) panelKeys = ["left_sleeve"];
    } else if (g.id === "right-sleeve") {
      panelKeys = panelKeys.filter((k) => k !== "right_cuff");
      if (!panelKeys.includes("right_sleeve")) panelKeys = ["right_sleeve"];
    } else if (g.id === "trim") {
      const merged = new Set<HoodiePanelKey>([
        ...panelKeys,
        ...SWEATSHIRT_TRIM_PANEL_KEYS,
        ...(collar?.panelKeys ?? []),
      ]);
      panelKeys = SWEATSHIRT_TRIM_PANEL_KEYS.filter((k) => merged.has(k));
      if (panelKeys.length === 0) panelKeys = [...SWEATSHIRT_TRIM_PANEL_KEYS];
    }
    byId.set(g.id, { ...g, panelKeys });
  }

  return defaults.map((def) => {
    const prev = byId.get(def.id);
    if (!prev) return def;
    return {
      ...def,
      placement: prev.placement,
      seamAllowance: prev.seamAllowance,
      lockedRatio: prev.lockedRatio,
      enabled: prev.enabled,
    };
  });
}

export function isPulloverHoodieBlueprint(blueprintId: number | null | undefined): boolean {
  return blueprintId === PULOVER_HOODIE_BLUEPRINT_ID;
}

export function isZipHoodieBlueprint(blueprintId: number | null | undefined): boolean {
  return blueprintId === ZIP_HOODIE_BLUEPRINT_ID;
}

export function isSweatshirtBlueprint(blueprintId: number | null | undefined): boolean {
  return blueprintId === SWEATSHIRT_BLUEPRINT_ID;
}

export function isPillowWrapBlueprint(blueprintId: number | null | undefined): boolean {
  if (blueprintId == null) return false;
  return PILLOW_WRAP_BLUEPRINT_IDS.includes(blueprintId);
}

type PlacerEditorTemplateLike = Pick<
  HoodieTemplate,
  "placerEditor" | "blueprintId" | "hoodieType" | "designGroups"
>;

export function defaultPlacerEditorForBlueprint(
  blueprintId: number | null | undefined,
): PlacerEditor {
  return isPillowWrapBlueprint(blueprintId) ? "front-back-face" : "hoodie";
}

export function defaultPrintFileLayoutForBlueprint(
  blueprintId: number | null | undefined,
): PrintFileLayout {
  if (
    blueprintId === BODY_PILLOW_WRAP_BLUEPRINT_ID ||
    blueprintId === LUMBAR_PILLOW_WRAP_BLUEPRINT_ID
  ) {
    return "split-front-back";
  }
  if (isPillowWrapBlueprint(blueprintId)) return "wrap-single";
  return "split-front-back";
}

/** Resolve explicit or legacy template signals into a placer editor mode. */
export function resolvePlacerEditor(
  template: PlacerEditorTemplateLike | null | undefined,
): PlacerEditor {
  if (!template) return "hoodie";
  if (template.placerEditor === "hoodie" || template.placerEditor === "front-back-face") {
    return template.placerEditor;
  }
  if (isPillowWrapBlueprint(template.blueprintId)) return "front-back-face";
  if (template.hoodieType === "pillow-wrap-aop") return "front-back-face";
  const groups = template.designGroups;
  if (groups?.length) {
    const ids = new Set(groups.map((g) => g.id));
    if (
      ids.has("front-face") &&
      ids.has("back-face") &&
      !ids.has("front-body") &&
      !ids.has("hood")
    ) {
      return "front-back-face";
    }
  }
  return "hoodie";
}

export function resolvePrintFileLayout(
  template: Pick<HoodieTemplate, "printFileLayout" | "blueprintId" | "placerEditor"> | null | undefined,
): PrintFileLayout {
  if (!template) return "split-front-back";
  if (template.printFileLayout === "wrap-single" || template.printFileLayout === "split-front-back") {
    return template.printFileLayout;
  }
  return defaultPrintFileLayoutForBlueprint(template.blueprintId);
}

/** Storefront/editor front-back-face detection — explicit placerEditor or legacy signals. */
export function isPillowWrapTemplate(template: PlacerEditorTemplateLike | null | undefined): boolean {
  return resolvePlacerEditor(template) === "front-back-face";
}

type GarmentLayoutTemplateLike = Pick<
  HoodieTemplate,
  "garmentLayout" | "blueprintId" | "placerEditor"
>;

export function resolveGarmentLayout(
  template: GarmentLayoutTemplateLike | null | undefined,
): GarmentLayout {
  if (!template) return "hoodie";
  if (template.garmentLayout === "hoodie" || template.garmentLayout === "jumper-no-hood") {
    return template.garmentLayout;
  }
  if (resolvePlacerEditor(template) !== "hoodie") return "hoodie";
  if (isSweatshirtBlueprint(template.blueprintId)) return "jumper-no-hood";
  return "hoodie";
}

/** Storefront jumper UI — front/back/sleeves, no hood/pockets (any blueprint when flagged). */
export function usesJumperNoHoodGarmentUi(
  template: GarmentLayoutTemplateLike | null | undefined,
): boolean {
  if (!template) return false;
  if (resolvePlacerEditor(template) !== "hoodie") return false;
  return resolveGarmentLayout(template) === "jumper-no-hood";
}

/** Front/back/sleeves/trim groups — same structure as bp 449 sweatshirt. */
export function defaultJumperNoHoodDesignGroups(): DesignGroup[] {
  return defaultSweatshirtDesignGroups();
}

export function designGroupsForPlacerEditor(
  placerEditor: PlacerEditor,
  blueprintId: number | null | undefined,
  garmentLayout?: GarmentLayout | null,
): DesignGroup[] {
  if (placerEditor === "front-back-face") return defaultPillowWrapDesignGroups();
  return designGroupsForBlueprint(blueprintId, garmentLayout);
}

function designGroupsLookLikeHoodie(groups: DesignGroup[] | undefined): boolean {
  if (!groups?.length) return false;
  const ids = new Set(groups.map((g) => g.id));
  return ids.has("front-body") || ids.has("hood") || ids.has("left-sleeve");
}

/** Hoodie-only keys hidden for pillow wrap templates. */
const PILLOW_EXCLUDED_PANEL_KEYS: readonly HoodiePanelKey[] = [
  "front_left",
  "front_right",
  "front_pocket",
  "pocket_left",
  "pocket_right",
  "left_sleeve",
  "right_sleeve",
  "left_cuff",
  "right_cuff",
  "collar_front",
  "collar_back",
  "left_hood",
  "right_hood",
  "waistband",
];

export function defaultPillowWrapDesignGroups(): DesignGroup[] {
  const blank: GroupPlacement = { ...DEFAULT_GROUP_PLACEMENT };
  const blankPair: Record<HoodieView, GroupPlacement> = {
    front: { ...blank },
    back: { ...blank },
  };
  void blankPair;
  return [
    {
      id: "front-face",
      name: "Front face",
      panelKeys: ["front"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
    {
      id: "back-face",
      name: "Back face",
      panelKeys: ["back"],
      placement: { front: { ...blank }, back: { ...blank } },
      seamAllowance: 0,
      lockedRatio: null,
      enabled: true,
    },
  ];
}

/** Zip-only panel keys (hidden when authoring bp 450 pullover templates). */
const ZIP_ONLY_FRONT_PANEL_KEYS: readonly HoodiePanelKey[] = [
  "front_left",
  "front_right",
  "pocket_left",
  "pocket_right",
];

/** Hoodie-only keys hidden when authoring bp 449 sweatshirt templates. */
const SWEATSHIRT_EXCLUDED_PANEL_KEYS: readonly HoodiePanelKey[] = [
  "front_left",
  "front_right",
  "front_pocket",
  "pocket_left",
  "pocket_right",
  "left_hood",
  "right_hood",
];

export function designGroupsForBlueprint(
  blueprintId: number | null | undefined,
  garmentLayout?: GarmentLayout | null,
): DesignGroup[] {
  if (isPillowWrapBlueprint(blueprintId)) return defaultPillowWrapDesignGroups();
  const layout =
    garmentLayout ??
    (isSweatshirtBlueprint(blueprintId) ? "jumper-no-hood" : "hoodie");
  if (layout === "jumper-no-hood") return defaultJumperNoHoodDesignGroups();
  if (isPulloverHoodieBlueprint(blueprintId)) return defaultPulloverDesignGroups();
  if (isZipHoodieBlueprint(blueprintId)) return defaultDesignGroups();
  return defaultDesignGroups();
}

/**
 * When switching blueprint in the mapper, refresh group panel lists while
 * preserving customer placement / enable flags where group ids match.
 */
export function mergeDesignGroupsForBlueprintSwitch(
  blueprintId: number,
  existing: DesignGroup[] | undefined,
  garmentLayout?: GarmentLayout | null,
): DesignGroup[] {
  const defaults = designGroupsForBlueprint(blueprintId, garmentLayout);
  if (!existing?.length) return defaults;
  return defaults.map((def) => {
    const prev = existing.find((g) => g.id === def.id);
    if (!prev) return def;
    return {
      ...def,
      placement: prev.placement,
      seamAllowance: prev.seamAllowance,
      lockedRatio: prev.lockedRatio,
      enabled: prev.enabled,
    };
  });
}

/**
 * Panel keys offered in the mapper dropdown for a view, filtered by blueprint.
 * Pullover (450): `front` + pocket; zip (451): L/R split, no `front`.
 */
export function panelsEligibleForView(
  view: HoodieView,
  blueprintId: number | null | undefined,
  placerEditor?: PlacerEditor | null,
  garmentLayout?: GarmentLayout | null,
): readonly HoodiePanelKey[] {
  const all = PANELS_PER_VIEW[view];
  const frontBackFace =
    placerEditor === "front-back-face" ||
    (placerEditor == null && isPillowWrapBlueprint(blueprintId));
  if (frontBackFace) {
    return all.filter((k) => !PILLOW_EXCLUDED_PANEL_KEYS.includes(k));
  }
  const jumperPanels =
    garmentLayout === "jumper-no-hood" || isSweatshirtBlueprint(blueprintId);
  if (jumperPanels) {
    return all.filter((k) => !SWEATSHIRT_EXCLUDED_PANEL_KEYS.includes(k));
  }
  if (view !== "front") return all;
  if (isPulloverHoodieBlueprint(blueprintId)) {
    return all.filter((k) => !ZIP_ONLY_FRONT_PANEL_KEYS.includes(k));
  }
  if (isZipHoodieBlueprint(blueprintId)) {
    return all.filter((k) => k !== "front");
  }
  return all;
}

/**
 * Map an admin panel key to the Printify placeholder `position` string used
 * at order time. Most hoodie keys match 1:1; cuffs, collar, and the pullover
 * kangaroo pocket are exceptions (live bp 450 uses `pocket`, not `front_pocket`).
 */
export function hoodiePanelKeyToPrintifyPosition(panelKey: HoodiePanelKey): string {
  if (panelKey === "left_cuff") return "left_cuff_panel";
  if (panelKey === "right_cuff") return "right_cuff_panel";
  if (panelKey === "collar_front" || panelKey === "collar_back") return "collar";
  // Printify catalog bp 450 names the kangaroo slot `pocket`.
  if (panelKey === "front_pocket") return "pocket";
  return panelKey;
}

/**
 * Look up which design group a given panel belongs to. Returns null
 * for unmatched panels — the renderer treats those as "ungrouped"
 * and falls back to the legacy single-design-rect behaviour.
 */
export function findGroupForPanel(
  groups: DesignGroup[] | undefined,
  panelKey: HoodiePanelKey | null,
): DesignGroup | null {
  if (!groups || !panelKey) return null;
  // Pullover kangaroo pocket must inherit front-body placement, not trim
  // (trim is always customer-disabled even when the key lingers in both groups).
  if (panelKey === "front_pocket") {
    const frontBody = groups.find(
      (g) => g.id === "front-body" && g.panelKeys.includes("front_pocket"),
    );
    if (frontBody) return frontBody;
  }
  for (const g of groups) {
    if (g.panelKeys.includes(panelKey)) return g;
  }
  return null;
}

/**
 * Panel keys recognised as the LEFT / RIGHT halves of a centre-seam
 * pair. Used by the renderer to know which panels in a group
 * contribute to seam-allowance UV insetting.
 */
export const SEAM_PAIR_PANELS: Record<"left" | "right", HoodiePanelKey[]> = {
  left: ["front_left", "left_hood", "pocket_left"],
  right: ["front_right", "right_hood", "pocket_right"],
};

/**
 * Fill in any optional fields a loaded template might be missing
 * (older saves predate `designGroups`, `tileSettings`, etc.). Returns
 * a new shallow-copy with the defaults applied so the loader can
 * pass the result straight into the store. Existing values are
 * preserved — defaults only fill genuinely-undefined fields.
 */
export function normalizeHoodieTemplate(template: HoodieTemplate): HoodieTemplate {
  let designGroups =
    template.designGroups ?? designGroupsForBlueprint(template.blueprintId);
  // Migrate legacy single-Sleeves group → Left/Right sleeve groups.
  // Older templates persisted before this split contained one group
  // covering all four sleeve+cuff panels, which made the design rect
  // explode across the front when both sides were enabled.
  const legacyIdx = designGroups.findIndex((g) => g.id === "sleeves");
  if (legacyIdx >= 0) {
    const legacy = designGroups[legacyIdx];
    const has = (k: HoodiePanelKey) => legacy.panelKeys.includes(k);
    if (
      has("left_sleeve") &&
      has("right_sleeve") &&
      has("left_cuff") &&
      has("right_cuff")
    ) {
      designGroups = [
        ...designGroups.slice(0, legacyIdx),
        {
          ...legacy,
          id: "left-sleeve",
          name: "Left sleeve",
          panelKeys: ["left_sleeve"],
        },
        {
          ...legacy,
          id: "right-sleeve",
          name: "Right sleeve",
          panelKeys: ["right_sleeve"],
        },
        ...designGroups.slice(legacyIdx + 1),
      ];
    }
  }
  // Migrate stale templates where `front_pocket` still lives in the
  // always-disabled `trim` group (pre-fix persisted JSON). Without this,
  // toggling "Pockets" on in the customer placer can never show artwork
  // because `trim` is force-disabled at render time.
  designGroups = migrateFrontPocketOutOfTrimGroup(designGroups);
  const placerEditor = resolvePlacerEditor({ ...template, designGroups });
  const garmentLayout = resolveGarmentLayout({ ...template, designGroups, placerEditor });
  if (usesJumperNoHoodGarmentUi({ ...template, designGroups, placerEditor, garmentLayout })) {
    designGroups = migrateSweatshirtDesignGroups(designGroups);
  } else if (isSweatshirtBlueprint(template.blueprintId)) {
    designGroups = migrateSweatshirtDesignGroups(designGroups);
  }
  if (placerEditor === "front-back-face") {
    const bp = template.blueprintId ?? PILLOW_WRAP_BLUEPRINT_ID;
    if (designGroupsLookLikeHoodie(designGroups) || !designGroups?.some((g) => g.id === "front-face")) {
      designGroups = mergeDesignGroupsForBlueprintSwitch(bp, designGroups);
    }
  } else if (
    garmentLayout === "jumper-no-hood" &&
    (designGroupsLookLikeHoodie(designGroups) || designGroups?.some((g) => g.id === "hood"))
  ) {
    const bp = template.blueprintId ?? SWEATSHIRT_BLUEPRINT_ID;
    designGroups = mergeDesignGroupsForBlueprintSwitch(bp, designGroups, "jumper-no-hood");
    designGroups = migrateSweatshirtDesignGroups(designGroups);
  }
  const printFileLayout = resolvePrintFileLayout({
    ...template,
    placerEditor,
  });
  return {
    ...template,
    placerEditor,
    printFileLayout,
    garmentLayout: placerEditor === "front-back-face" ? undefined : garmentLayout,
    designGroups,
    tileSettings: template.tileSettings ?? { ...DEFAULT_TILE_SETTINGS },
    realWorldCalibration:
      template.realWorldCalibration ?? { ...DEFAULT_REAL_WORLD_CALIBRATION },
  };
}

/** Matches `SAFE_NAME_RE` in `server/routes/hoodie-template-mapper.ts`. */
export const AOP_TEMPLATE_SLUG_RE = /^[a-zA-Z0-9_\-]{1,64}$/;

export function isValidAopTemplateSlug(name: string): boolean {
  return AOP_TEMPLATE_SLUG_RE.test(name);
}

/** Normalize free-text (labels, pasted names) into a mapper slug. */
export function normalizeAopTemplateSlugInput(raw: string): string {
  return raw.trim().replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 64);
}

export function defaultHoodieTypeForBlueprint(blueprintId: number): string {
  if (isPillowWrapBlueprint(blueprintId)) return "pillow-wrap-aop";
  if (isPulloverHoodieBlueprint(blueprintId)) return "pullover-hoodie-aop";
  if (isZipHoodieBlueprint(blueprintId)) return "zip-hoodie-aop";
  return `aop-bp-${blueprintId}`;
}

/** Blank template for a new AOP product — no masks, no mockups, blueprint-aware panel groups. */
export function createFreshAopTemplate(args: {
  name: string;
  label?: string;
  blueprintId: number;
  productTypeId?: number | null;
  hoodieType?: string;
  size?: string | null;
  placerEditor?: PlacerEditor;
  printFileLayout?: PrintFileLayout;
  garmentLayout?: GarmentLayout;
}): HoodieTemplate {
  const now = new Date().toISOString();
  const blueprintId = args.blueprintId;
  const placerEditor = args.placerEditor ?? defaultPlacerEditorForBlueprint(blueprintId);
  const printFileLayout =
    args.printFileLayout ?? defaultPrintFileLayoutForBlueprint(blueprintId);
  const garmentLayout =
    placerEditor === "front-back-face"
      ? undefined
      : args.garmentLayout ??
        (isSweatshirtBlueprint(blueprintId) ? "jumper-no-hood" : "hoodie");
  return normalizeHoodieTemplate({
    version: HOODIE_TEMPLATE_VERSION,
    name: args.name,
    label: args.label ?? args.name,
    hoodieType: args.hoodieType ?? defaultHoodieTypeForBlueprint(blueprintId),
    productTypeId: args.productTypeId ?? null,
    blueprintId,
    size: args.size ?? "L",
    placerEditor,
    printFileLayout,
    garmentLayout,
    meta: { createdAt: now, updatedAt: now },
    views: {
      front: { ...EMPTY_HOODIE_VIEW },
      back: { ...EMPTY_HOODIE_VIEW },
    },
    globalExclusions: [],
    designGroups: designGroupsForPlacerEditor(placerEditor, blueprintId, garmentLayout),
    tileSettings: { ...DEFAULT_TILE_SETTINGS },
    realWorldCalibration: { ...DEFAULT_REAL_WORLD_CALIBRATION },
  });
}

/** Legacy default — zip hoodie L. Prefer {@link createFreshAopTemplate} for new products. */
export function emptyHoodieTemplate(name: string, label?: string): HoodieTemplate {
  return createFreshAopTemplate({
    name,
    label,
    blueprintId: ZIP_HOODIE_BLUEPRINT_ID,
    hoodieType: "zip-hoodie-aop",
    productTypeId: 20,
  });
}

/**
 * Panel keys that are valid per view. Front/back share sleeves/cuffs/hood/waistband
 * because the admin sees them rotated to that view.
 */
export const PANELS_PER_VIEW: Record<HoodieView, readonly HoodiePanelKey[]> = {
  front: [
    "front",
    "front_right",
    "front_left",
    "front_pocket",
    "pocket_left",
    "pocket_right",
    "left_sleeve",
    "right_sleeve",
    "left_cuff",
    "right_cuff",
    "left_hood",
    "right_hood",
    "waistband",
    "collar_front",
    "collar_back",
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
    "collar_back",
  ],
} as const;

export const PANEL_DISPLAY_LABEL: Record<HoodiePanelKey, string> = {
  front: "Front (full body)",
  front_right: "Front Right",
  front_left: "Front Left",
  front_pocket: "Front Pocket (legacy)",
  pocket_left: "Pocket Left",
  pocket_right: "Pocket Right",
  left_sleeve: "Left Sleeve",
  right_sleeve: "Right Sleeve",
  left_cuff: "Left Cuff",
  right_cuff: "Right Cuff",
  collar_front: "Collar (front band)",
  collar_back: "Collar (back / neck opening)",
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
  front: 20,
  front_left: 20,
  front_right: 20,
  left_sleeve: 30,
  right_sleeve: 30,
  left_hood: 40,
  right_hood: 40,
  left_cuff: 50,
  right_cuff: 50,
  collar_back: 52,
  collar_front: 55,
  waistband: 60,
  front_pocket: 70,
  pocket_left: 70,
  pocket_right: 70,
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
  const safeCols = Math.max(2, Math.min(MAX_MESH_COLS, Math.floor(cols)));
  const safeRows = Math.max(2, Math.min(MAX_MESH_ROWS, Math.floor(rows)));
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
  const safeCols = Math.max(2, Math.min(MAX_MESH_COLS, Math.floor(newCols)));
  const safeRows = Math.max(2, Math.min(MAX_MESH_ROWS, Math.floor(newRows)));
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
