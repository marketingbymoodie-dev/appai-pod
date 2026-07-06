import { create } from "zustand";
import {
  EMPTY_HOODIE_VIEW,
  emptyHoodieTemplate,
  normalizeHoodieTemplate,
  HOODIE_TEMPLATE_VERSION,
  createDefaultMesh,
  resizeMesh,
  mergeDesignGroupsForBlueprintSwitch,
  isPillowWrapBlueprint,
  defaultPlacerEditorForBlueprint,
  defaultPrintFileLayoutForBlueprint,
  defaultHoodieTypeForBlueprint,
  PILLOW_WRAP_BLUEPRINT_ID,
  PULOVER_HOODIE_BLUEPRINT_ID,
  ZIP_HOODIE_BLUEPRINT_ID,
  type HoodiePanelKey,
  type HoodieTemplate,
  type HoodieToolId,
  type HoodieView,
  type MaskLayer,
  type MeshGrid,
  type MockupAsset,
  type PrintFileLayout,
  type Pt,
  type ReferenceOverlayAsset,
  type SourceRect,
} from "@shared/hoodieTemplate";
import {
  anchorsToSvgPath,
  boundingBox,
  simplifyPath,
  smoothPath,
  svgPathToAnchors,
} from "./lib/svgPath";
import type { CropRect } from "./lib/mockupCrop";

/**
 * Zustand store for the hoodie template mapper. Centralizes the in-memory
 * template, the active view, the active tool, the selected/hover layer,
 * and view-only debug flags. Persisting templates is delegated to the
 * dev API in server/routes/hoodie-template-mapper.ts.
 *
 * Conventions:
 *  - All mutations go through actions on this store; components never
 *    rewrite the template directly.
 *  - When the schema grows (mesh, transforms, exclusions in later phases)
 *    new actions are added here; the JSON schema bumps versions in
 *    `shared/hoodieTemplate.ts`.
 */

export type HoodieMapperDebugFlags = {
  /** Show subtle dotted grid for visual scale reference. */
  showGrid: boolean;
  /** Show panel name labels on top of layers. */
  showPanelLabels: boolean;
  /** Translucent grey fill on hovered/selected mask layers. */
  showHoverHighlight: boolean;
  /** Reference overlay opacity slider mirror (0..1). */
  referenceOverlayOpacity: number;
  /** Diagnostic strip at the bottom of the canvas (stage size, mockup, img state, scale, pos). */
  showCanvasDebug: boolean;
  /**
   * When true (default), draggable polygon anchors render in the move
   * tool. Setting false hides them so the user can focus on artwork
   * placement / mesh warps without the perimeter dots competing for
   * attention. Anchors are always hidden in the mesh-warp tool.
   */
  showAnchors: boolean;
  /**
   * When true (default), every mesh-warped layer in the active view
   * renders its artwork on the main canvas — not just the selected
   * one. The selected layer still gets the editor handles on top.
   * Toggle off to focus on a single layer at a time.
   */
  showAllWarps: boolean;
};

const DEFAULT_DEBUG_FLAGS: HoodieMapperDebugFlags = {
  showGrid: false,
  showPanelLabels: true,
  showHoverHighlight: true,
  referenceOverlayOpacity: 0.5,
  showCanvasDebug: false,
  showAnchors: true,
  showAllWarps: true,
};

/**
 * Pen-tool draft state. Anchors are accumulated in mockup pixel coords as the
 * user clicks. The draft is committed to a real MaskLayer when closed and
 * cleared otherwise. `view` lets us pin the in-progress draft to whichever
 * view was active when drawing started.
 */
export type PenDraft = {
  view: HoodieView;
  anchors: Pt[];
  /** Cursor position in mockup coords; used for the live "next segment" preview line. */
  cursor: Pt | null;
  /** True when the cursor is close enough to anchor[0] to close on click. */
  canClose: boolean;
};

/** Snap radius in mockup pixels. 0 disables snapping (acts as polygon pen). */
export const DEFAULT_MAGNETIC_RADIUS = 24;
/**
 * Magnetic-pen edge tolerance — minimum gradient strength (relative to the
 * frame's strongest edge, 0..1) that counts as "snappable". Lower values
 * snap to weaker edges (more permissive, like Photoshop's high tolerance);
 * higher values demand a stronger edge before snapping (stricter, locks to
 * the silhouette and rejects internal seams). 0.18 is a good default for
 * transparent-background mockups with the alpha-boosted gradient map.
 */
export const DEFAULT_MAGNETIC_TOLERANCE = 0.18;
export const MIN_MASK_ANCHORS = 3;

export type HoodieMapperState = {
  template: HoodieTemplate;
  view: HoodieView;
  tool: HoodieToolId;
  selectedLayerId: string | null;
  hoverLayerId: string | null;
  debug: HoodieMapperDebugFlags;
  /** In-progress polygon being drawn; null when not actively drawing. */
  penDraft: PenDraft | null;
  /** Magnetic-pen snap radius in mockup pixels. */
  magneticRadius: number;
  /**
   * Magnetic-pen edge-strength tolerance (0..1). See
   * `DEFAULT_MAGNETIC_TOLERANCE`. Higher = pickier (silhouette only),
   * lower = greedier (will snap to faint internal edges too).
   */
  magneticTolerance: number;
  /** Selected anchor index within the selected layer (for keyboard nudges). */
  selectedAnchorIndex: number | null;
  /** Tracks unsaved changes since the last successful save. */
  dirty: boolean;
  /** True while a save/load request is in flight. */
  busy: boolean;
  /**
   * Monotonic counter bumped by `markSaved()`. Components can subscribe to
   * trigger refreshes (e.g. the saved-templates list) without having to
   * receive an event from the save call site directly.
   */
  saveSeq: number;
  /**
   * Mesh-warp editor UI state. Lives outside the persisted template so
   * the toggle doesn't bake into saved JSON.
   */
  meshEdit: MeshEditState;
  /** Interactive mockup crop before masking. */
  mockupCrop: { active: boolean; rect: CropRect | null };
};

/**
 * Mesh-warp editor view state. `showFullArtwork` lets the user briefly
 * see the entire source artwork rectangle outside the panel polygon so
 * they can tell which slice of e.g. a sleeve sheet they're looking at.
 */
export type MeshEditState = {
  showFullArtwork: boolean;
  /** When true, the editor exposes draggable handles for the source rect. */
  cropEditing: boolean;
};

export const DEFAULT_MESH_EDIT_STATE: MeshEditState = {
  showFullArtwork: false,
  cropEditing: false,
};

export type HoodieMapperActions = {
  loadTemplate: (template: HoodieTemplate) => void;
  resetTemplate: (name?: string) => void;
  setView: (view: HoodieView) => void;
  setTool: (tool: HoodieToolId) => void;
  setSelectedLayer: (id: string | null) => void;
  setHoverLayer: (id: string | null) => void;
  setDebug: (patch: Partial<HoodieMapperDebugFlags>) => void;
  setBusy: (busy: boolean) => void;
  markSaved: () => void;
  setMockup: (view: HoodieView, mockup: MockupAsset | null) => void;
  patchMockup: (view: HoodieView, patch: Partial<MockupAsset>) => void;
  startMockupCrop: (rect: CropRect) => void;
  setMockupCropRect: (rect: CropRect) => void;
  cancelMockupCrop: () => void;
  /**
   * Deep-copy all mask layers from one view to another (e.g. identical pillow faces).
   * Optional panelKeyMap remaps assignments (front → back). Returns count copied.
   */
  copyLayersFromView: (
    from: HoodieView,
    to: HoodieView,
    opts?: { panelKeyMap?: Partial<Record<HoodiePanelKey, HoodiePanelKey>>; replaceExisting?: boolean },
  ) => number;
  setReferenceOverlay: (view: HoodieView, overlay: ReferenceOverlayAsset | null) => void;
  setTemplateMeta: (patch: Partial<Pick<HoodieTemplate, "name" | "label" | "hoodieType" | "productTypeId" | "blueprintId" | "size">>) => void;
  /** Replace the full designGroups array (used by AOP modal save-as-defaults). */
  setDesignGroups: (groups: import("@shared/hoodieTemplate").DesignGroup[]) => void;
  /** Patch tile-mode settings (pattern, tile size, etc.). */
  setTileSettings: (patch: Partial<import("@shared/hoodieTemplate").TileSettings>) => void;
  /** Patch the real-world calibration. */
  setRealWorldCalibration: (
    patch: Partial<import("@shared/hoodieTemplate").RealWorldCalibration>,
  ) => void;
  /** Mask layer mutations. */
  upsertLayer: (layer: MaskLayer) => void;
  removeLayer: (id: string) => void;
  patchLayer: (id: string, patch: Partial<MaskLayer>) => void;
  reorderLayer: (id: string, newZIndex: number) => void;
  /**
   * Deep-clone a layer (new id, " Copy" name suffix, slight x/y offset
   * on polygon + mesh so the duplicate is visually distinguishable).
   * Used to fork an already-warped panel into two — e.g. take the
   * existing "Front Pocket" mask and split it into Pocket Left /
   * Pocket Right without redoing the source artwork + mesh setup.
   * Returns the new layer's id, or null if the source wasn't found.
   */
  duplicateLayer: (id: string) => string | null;
  /**
   * Replace the geometry of an existing layer. Re-serializes maskPath from
   * the supplied anchors. Used by anchor edits (drag/insert/delete) and the
   * Simplify/Smooth path-utility buttons.
   */
  setLayerAnchors: (id: string, anchors: Pt[]) => void;
  simplifyLayerPath: (id: string, epsilon: number) => void;
  smoothLayerPath: (id: string, iterations?: number) => void;
  setSelectedAnchorIndex: (index: number | null) => void;
  /** Pen-tool actions. */
  setMagneticRadius: (radius: number) => void;
  setMagneticTolerance: (tolerance: number) => void;
  startPenDraft: (anchors?: Pt[]) => void;
  appendPenAnchor: (point: Pt) => void;
  setPenCursor: (cursor: Pt | null, canClose: boolean) => void;
  popPenAnchor: () => void;
  cancelPenDraft: () => void;
  /**
   * Close the current pen draft into a new MaskLayer on the active view.
   * Returns the created layer id, or null if there were too few anchors.
   */
  closePenDraft: () => string | null;
  /** Mesh-warp actions. */
  setLayerSourcePanel: (id: string, src: string | null) => void;
  initLayerMesh: (id: string, cols?: number, rows?: number) => void;
  resetLayerMesh: (id: string, cols?: number, rows?: number) => void;
  resizeLayerMesh: (id: string, cols: number, rows: number) => void;
  setLayerMeshTargetPoint: (id: string, index: number, point: Pt) => void;
  setLayerMeshSourceRect: (id: string, rect: SourceRect | null) => void;
  /**
   * Patch source-image rotation/flip on a layer's mesh. Affects only the
   * UV sampling of the artwork inside each mesh cell; the mesh shape is
   * untouched. Use for fine-grained artwork orientation tweaks (e.g. a
   * Printify sleeve sheet that ships portrait while the mesh is laid out
   * landscape).
   */
  setLayerMeshSourceTransform: (
    id: string,
    patch: { sourceRotation?: number; sourceFlipX?: boolean; sourceFlipY?: boolean },
  ) => void;
  /**
   * Rigid-body rotate every mesh target point by `deltaDeg` (CW positive)
   * around `anchor` (mockup pixel coords; typically the mesh centroid).
   * The artwork rotates with the mesh because each cell still pulls from
   * the same source UV — so this is the "rotate the whole panel" gesture
   * the on-canvas rotate puck binds to.
   */
  rotateLayerMesh: (id: string, deltaDeg: number, anchor: Pt) => void;
  /**
   * Rigid-body translate the whole panel — mask polygon, mesh target
   * points, and corner pins — by `(dx, dy)` mockup pixels.
   */
  translateLayerMesh: (id: string, dx: number, dy: number) => void;
  /**
   * Uniformly scale the whole panel — mask polygon, mesh target points,
   * and corner pins — by `scale` around `anchor` (mockup pixel coords).
   */
  scaleLayerMesh: (id: string, scale: number, anchor: Pt) => void;
  /** Alias of `translateLayerMesh` — mask and mesh always move together. */
  translateLayerPolygon: (id: string, dx: number, dy: number) => void;
  setMeshEdit: (patch: Partial<MeshEditState>) => void;
};

type Store = HoodieMapperState & { actions: HoodieMapperActions };

const STARTER_TEMPLATE_NAME = "zip-hoodie-aop-L";

function bumpUpdatedAt(template: HoodieTemplate): HoodieTemplate {
  return {
    ...template,
    meta: { ...template.meta, updatedAt: new Date().toISOString() },
  };
}

function patchView(
  template: HoodieTemplate,
  view: HoodieView,
  patch: Partial<HoodieTemplate["views"][HoodieView]>,
): HoodieTemplate {
  const current = template.views[view] ?? EMPTY_HOODIE_VIEW;
  return bumpUpdatedAt({
    ...template,
    views: {
      ...template.views,
      [view]: { ...current, ...patch },
    },
  });
}

function newLayerId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `lyr_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `lyr_${Math.random().toString(36).slice(2, 10)}`;
}

function findLayerById(template: HoodieTemplate, id: string): { view: HoodieView; layer: MaskLayer } | null {
  for (const v of ["front", "back"] as HoodieView[]) {
    const layer = template.views[v]?.layers.find((l) => l.id === id);
    if (layer) return { view: v, layer };
  }
  return null;
}

function highestZIndexFor(template: HoodieTemplate, view: HoodieView): number {
  const layers = template.views[view]?.layers ?? [];
  if (layers.length === 0) return 0;
  return layers.reduce((max, l) => (l.zIndex > max ? l.zIndex : max), 0);
}

function defaultMaskLayer(view: HoodieView, anchors: Pt[], template: HoodieTemplate): MaskLayer {
  const id = newLayerId();
  const z = highestZIndexFor(template, view) + 1;
  return {
    id,
    view,
    panelKey: null,
    kind: "panel",
    name: `Mask ${z}`,
    visible: true,
    locked: false,
    zIndex: z,
    opacity: 1,
    blendMode: "normal",
    maskPath: anchorsToSvgPath(anchors),
    cornerPins: null,
    mesh: null,
    transform: {
      x: 0,
      y: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      skewX: 0,
      skewY: 0,
    },
    productionPanelAssignment: null,
    productionPanelSrc: null,
    isExclusion: false,
  };
}

/**
 * Helper used by anchor-editing actions: rebuild the SVG path for `id` from
 * a fresh anchor list. The enclosing helper signature mirrors patchLayer so
 * callers don't need to think about which view the layer lives on.
 */
function applyAnchorsTo(
  template: HoodieTemplate,
  id: string,
  anchors: Pt[],
): HoodieTemplate {
  if (anchors.length < MIN_MASK_ANCHORS) return template;
  const found = findLayerById(template, id);
  if (!found) return template;
  const view = template.views[found.view];
  const layers = view.layers.map((l) =>
    l.id === id ? { ...l, maskPath: anchorsToSvgPath(anchors) } : l,
  );
  return patchView(template, found.view, { layers });
}

/** Apply a point-wise map to mask polygon + mesh geometry on one layer. */
function mapLayerPanelPoints(layer: MaskLayer, mapPoint: (p: Pt) => Pt): MaskLayer {
  const anchors = svgPathToAnchors(layer.maskPath);
  const mappedAnchors = anchors.map(mapPoint);
  const maskPath =
    mappedAnchors.length >= 2 ? anchorsToSvgPath(mappedAnchors) : layer.maskPath;

  if (!layer.mesh) {
    return { ...layer, maskPath };
  }

  const targetPoints = layer.mesh.targetPoints.map(mapPoint);
  const cornerPins = layer.cornerPins
    ? (layer.cornerPins.map(mapPoint) as typeof layer.cornerPins)
    : layer.cornerPins;
  return { ...layer, maskPath, mesh: { ...layer.mesh, targetPoints }, cornerPins };
}

function applyPanelPointMap(
  template: HoodieTemplate,
  id: string,
  mapPoint: (p: Pt) => Pt,
): HoodieTemplate | null {
  const found = findLayerById(template, id);
  if (!found) return null;
  const layers = template.views[found.view].layers.map((l) =>
    l.id === id ? mapLayerPanelPoints(l, mapPoint) : l,
  );
  return patchView(template, found.view, { layers });
}

export const useHoodieMapperStore = create<Store>((set, get) => ({
  template: emptyHoodieTemplate(STARTER_TEMPLATE_NAME, "Zip Hoodie AOP — Size L"),
  view: "front",
  tool: "move",
  selectedLayerId: null,
  hoverLayerId: null,
  debug: { ...DEFAULT_DEBUG_FLAGS },
  penDraft: null,
  magneticRadius: DEFAULT_MAGNETIC_RADIUS,
  magneticTolerance: DEFAULT_MAGNETIC_TOLERANCE,
  meshEdit: { ...DEFAULT_MESH_EDIT_STATE },
  mockupCrop: { active: false, rect: null },
  selectedAnchorIndex: null,
  dirty: false,
  busy: false,
  saveSeq: 0,
  actions: {
    loadTemplate: (template) =>
      set(() => ({
        template: normalizeHoodieTemplate(template),
        selectedLayerId: null,
        hoverLayerId: null,
        penDraft: null,
        selectedAnchorIndex: null,
        mockupCrop: { active: false, rect: null },
        dirty: false,
      })),
    resetTemplate: (name) =>
      set(() => ({
        template: emptyHoodieTemplate(name ?? STARTER_TEMPLATE_NAME),
        selectedLayerId: null,
        hoverLayerId: null,
        penDraft: null,
        selectedAnchorIndex: null,
        mockupCrop: { active: false, rect: null },
        dirty: false,
      })),
    setView: (view) =>
      set(() => ({
        view,
        selectedLayerId: null,
        hoverLayerId: null,
        penDraft: null,
        selectedAnchorIndex: null,
      })),
    setTool: (tool) =>
      set((s) => ({
        tool,
        // Cancel any in-progress pen draft when switching to a non-pen tool.
        penDraft: tool === "polygon-pen" || tool === "magnetic-pen" ? s.penDraft : null,
      })),
    setSelectedLayer: (id) => set(() => ({ selectedLayerId: id, selectedAnchorIndex: null })),
    setHoverLayer: (id) => set(() => ({ hoverLayerId: id })),
    setDebug: (patch) => set((s) => ({ debug: { ...s.debug, ...patch } })),
    setBusy: (busy) => set(() => ({ busy })),
    markSaved: () => set((s) => ({ dirty: false, saveSeq: s.saveSeq + 1 })),
    setMockup: (view, mockup) =>
      set((s) => ({
        template: patchView(s.template, view, {
          mockup: mockup
            ? {
                ...mockup,
                x: mockup.x ?? 0,
                y: mockup.y ?? 0,
                scale: mockup.scale ?? 1,
                transformLocked: mockup.transformLocked ?? false,
              }
            : null,
        }),
        dirty: true,
      })),
    patchMockup: (view, patch) =>
      set((s) => {
        const current = s.template.views[view]?.mockup;
        if (!current) return s;
        return {
          template: patchView(s.template, view, { mockup: { ...current, ...patch } }),
          dirty: true,
        };
      }),
    startMockupCrop: (rect) =>
      set(() => ({
        mockupCrop: { active: true, rect },
        tool: "move",
        selectedLayerId: null,
      })),
    setMockupCropRect: (rect) =>
      set((s) => ({
        mockupCrop: s.mockupCrop.active ? { active: true, rect } : s.mockupCrop,
      })),
    cancelMockupCrop: () => set(() => ({ mockupCrop: { active: false, rect: null } })),
    copyLayersFromView: (from, to, opts) => {
      const sourceLayers = get().template.views[from]?.layers ?? [];
      if (sourceLayers.length === 0) return 0;
      const panelKeyMap = opts?.panelKeyMap ?? {};
      const replaceExisting = opts?.replaceExisting ?? false;

      const cloned: MaskLayer[] = sourceLayers.map((src, idx) => {
        const newId = newLayerId();
        const mappedKey =
          src.panelKey && panelKeyMap[src.panelKey] ? panelKeyMap[src.panelKey]! : src.panelKey;
        return {
          ...src,
          id: newId,
          view: to,
          panelKey: mappedKey,
          maskPath: src.maskPath,
          mesh: src.mesh
            ? {
                ...src.mesh,
                targetPoints: src.mesh.targetPoints.map((p) => ({ x: p.x, y: p.y })),
              }
            : src.mesh,
          cornerPins: src.cornerPins
            ? (src.cornerPins.map((p) => ({ x: p.x, y: p.y })) as typeof src.cornerPins)
            : src.cornerPins,
          zIndex: idx + 1,
        };
      });

      set((s) => {
        const dest = s.template.views[to] ?? EMPTY_HOODIE_VIEW;
        const layers = replaceExisting ? cloned : [...dest.layers, ...cloned];
        return {
          template: patchView(s.template, to, { layers }),
          view: to,
          selectedLayerId: cloned[0]?.id ?? null,
          dirty: true,
        };
      });
      return cloned.length;
    },
    setReferenceOverlay: (view, overlay) =>
      set((s) => ({
        template: patchView(s.template, view, { referenceOverlay: overlay }),
        dirty: true,
      })),
    setTemplateMeta: (patch) =>
      set((s) => {
        let next: HoodieTemplate = { ...s.template, ...patch };
        if (patch.blueprintId != null && patch.blueprintId !== s.template.blueprintId) {
          next = {
            ...next,
            designGroups: mergeDesignGroupsForBlueprintSwitch(
              patch.blueprintId,
              s.template.designGroups,
            ),
            placerEditor: defaultPlacerEditorForBlueprint(patch.blueprintId),
            printFileLayout: defaultPrintFileLayoutForBlueprint(patch.blueprintId),
          };
          if (patch.blueprintId === PULOVER_HOODIE_BLUEPRINT_ID && next.hoodieType === "zip-hoodie-aop") {
            next = { ...next, hoodieType: "pullover-hoodie-aop" };
          } else if (patch.blueprintId === ZIP_HOODIE_BLUEPRINT_ID && next.hoodieType === "pullover-hoodie-aop") {
            next = { ...next, hoodieType: "zip-hoodie-aop" };
          } else if (isPillowWrapBlueprint(patch.blueprintId)) {
            next = { ...next, hoodieType: "pillow-wrap-aop" };
          } else if (next.placerEditor === "hoodie") {
            next = { ...next, hoodieType: defaultHoodieTypeForBlueprint(patch.blueprintId) };
          }
        }
        if (patch.placerEditor != null && patch.placerEditor !== s.template.placerEditor) {
          const bp = next.blueprintId ?? ZIP_HOODIE_BLUEPRINT_ID;
          if (patch.placerEditor === "front-back-face") {
            next = {
              ...next,
              placerEditor: "front-back-face",
              designGroups: mergeDesignGroupsForBlueprintSwitch(
                isPillowWrapBlueprint(bp) ? bp : PILLOW_WRAP_BLUEPRINT_ID,
                s.template.designGroups,
              ),
              hoodieType: "pillow-wrap-aop",
            };
          } else {
            next = {
              ...next,
              placerEditor: "hoodie",
              designGroups: mergeDesignGroupsForBlueprintSwitch(bp, s.template.designGroups),
              hoodieType: defaultHoodieTypeForBlueprint(bp),
            };
          }
        }
        if (patch.printFileLayout != null) {
          next = { ...next, printFileLayout: patch.printFileLayout as PrintFileLayout };
        }
        return {
          template: bumpUpdatedAt(next),
          dirty: true,
        };
      }),
    setDesignGroups: (groups) =>
      set((s) => ({
        template: bumpUpdatedAt({ ...s.template, designGroups: groups }),
        dirty: true,
      })),
    setTileSettings: (patch) =>
      set((s) => ({
        template: bumpUpdatedAt({
          ...s.template,
          tileSettings: { ...(s.template.tileSettings ?? { pattern: "grid", tileSizeInches: 1.5 }), ...patch },
        }),
        dirty: true,
      })),
    setRealWorldCalibration: (patch) =>
      set((s) => ({
        template: bumpUpdatedAt({
          ...s.template,
          realWorldCalibration: {
            ...(s.template.realWorldCalibration ?? { pixelsPerInch: 1024 / 24 }),
            ...patch,
          },
        }),
        dirty: true,
      })),
    upsertLayer: (layer) =>
      set((s) => {
        const view = s.template.views[layer.view] ?? EMPTY_HOODIE_VIEW;
        const existsIdx = view.layers.findIndex((l) => l.id === layer.id);
        const layers = existsIdx >= 0
          ? view.layers.map((l, i) => (i === existsIdx ? { ...l, ...layer } : l))
          : [...view.layers, layer];
        return {
          template: patchView(s.template, layer.view, { layers }),
          selectedLayerId: layer.id,
          dirty: true,
        };
      }),
    removeLayer: (id) =>
      set((s) => {
        let updated = s.template;
        for (const v of ["front", "back"] as HoodieView[]) {
          const view = updated.views[v];
          if (!view) continue;
          if (view.layers.some((l) => l.id === id)) {
            updated = patchView(updated, v, { layers: view.layers.filter((l) => l.id !== id) });
          }
        }
        const nextSelected = s.selectedLayerId === id ? null : s.selectedLayerId;
        return { template: updated, selectedLayerId: nextSelected, dirty: true };
      }),
    duplicateLayer: (id) => {
      const found = findLayerById(get().template, id);
      if (!found) return null;
      const src = found.layer;
      const newId = newLayerId();
      // Duplicate at IDENTICAL coordinates — no offset. The user moves
      // the polygon to its new location by dragging it (Move tool) or
      // via the polygon-translate gesture. Putting the dupe exactly on
      // top of the source means nothing drifts or gets accidentally
      // mis-aligned; the LeftSidebar layer list shows both entries
      // and the new layer is auto-selected so it's already in focus.
      const baseName = src.name.replace(/ Copy(?: \d+)?$/, "");
      const dupedName = `${baseName} Copy`;
      const duped: MaskLayer = {
        ...src,
        id: newId,
        name: dupedName,
        // Deep-copy the path string and the mesh so future mutations
        // don't accidentally alias source <-> duplicate.
        maskPath: src.maskPath,
        mesh: src.mesh
          ? {
              ...src.mesh,
              targetPoints: src.mesh.targetPoints.map((p) => ({ x: p.x, y: p.y })),
            }
          : src.mesh,
        cornerPins: src.cornerPins
          ? (src.cornerPins.map((p) => ({ x: p.x, y: p.y })) as typeof src.cornerPins)
          : src.cornerPins,
        // Force highest zIndex in the view so the dupe sits on top of
        // its source — clicks land on the dupe, not the original.
        zIndex: Math.max(
          0,
          ...get().template.views[found.view].layers.map((l) => l.zIndex ?? 0),
        ) + 1,
      };
      set((s) => {
        const view = s.template.views[found.view] ?? EMPTY_HOODIE_VIEW;
        return {
          template: patchView(s.template, found.view, {
            layers: [...view.layers, duped],
          }),
          selectedLayerId: newId,
          dirty: true,
        };
      });
      return newId;
    },
    patchLayer: (id, patch) =>
      set((s) => {
        let updated = s.template;
        for (const v of ["front", "back"] as HoodieView[]) {
          const view = updated.views[v];
          if (!view) continue;
          const idx = view.layers.findIndex((l) => l.id === id);
          if (idx < 0) continue;
          const layers = view.layers.map((l, i) => (i === idx ? { ...l, ...patch } : l));
          updated = patchView(updated, v, { layers });
        }
        return { template: updated, dirty: true };
      }),
    reorderLayer: (id, newZIndex) =>
      set((s) => {
        let updated = s.template;
        for (const v of ["front", "back"] as HoodieView[]) {
          const view = updated.views[v];
          if (!view) continue;
          if (!view.layers.some((l) => l.id === id)) continue;
          const layers = view.layers.map((l) => (l.id === id ? { ...l, zIndex: newZIndex } : l));
          updated = patchView(updated, v, { layers });
        }
        return { template: updated, dirty: true };
      }),
    setLayerAnchors: (id, anchors) =>
      set((s) => ({
        template: applyAnchorsTo(s.template, id, anchors),
        dirty: true,
      })),
    simplifyLayerPath: (id, epsilon) =>
      set((s) => {
        const found = findLayerById(s.template, id);
        if (!found) return {} as Partial<Store>;
        const anchors = svgPathToAnchors(found.layer.maskPath);
        const next = simplifyPath(anchors, epsilon);
        if (next.length < MIN_MASK_ANCHORS) return {} as Partial<Store>;
        return { template: applyAnchorsTo(s.template, id, next), dirty: true };
      }),
    smoothLayerPath: (id, iterations = 1) =>
      set((s) => {
        const found = findLayerById(s.template, id);
        if (!found) return {} as Partial<Store>;
        const anchors = svgPathToAnchors(found.layer.maskPath);
        const next = smoothPath(anchors, iterations);
        if (next.length < MIN_MASK_ANCHORS) return {} as Partial<Store>;
        return { template: applyAnchorsTo(s.template, id, next), dirty: true };
      }),
    setSelectedAnchorIndex: (index) => set(() => ({ selectedAnchorIndex: index })),
    setMagneticRadius: (radius) =>
      set(() => ({ magneticRadius: Math.max(0, Math.min(200, Math.round(radius))) })),
    setMagneticTolerance: (tolerance) =>
      set(() => ({
        magneticTolerance: Math.max(0, Math.min(1, Number.isFinite(tolerance) ? tolerance : 0)),
      })),
    startPenDraft: (anchors) =>
      set((s) => ({
        penDraft: { view: s.view, anchors: anchors ? [...anchors] : [], cursor: null, canClose: false },
        selectedLayerId: null,
        selectedAnchorIndex: null,
      })),
    appendPenAnchor: (point) =>
      set((s) => {
        const draft = s.penDraft ?? { view: s.view, anchors: [], cursor: null, canClose: false };
        return {
          penDraft: { ...draft, view: draft.view ?? s.view, anchors: [...draft.anchors, point] },
        };
      }),
    setPenCursor: (cursor, canClose) =>
      set((s) => {
        if (!s.penDraft) return {} as Partial<Store>;
        return { penDraft: { ...s.penDraft, cursor, canClose } };
      }),
    popPenAnchor: () =>
      set((s) => {
        if (!s.penDraft || s.penDraft.anchors.length === 0) return {} as Partial<Store>;
        return {
          penDraft: { ...s.penDraft, anchors: s.penDraft.anchors.slice(0, -1) },
        };
      }),
    cancelPenDraft: () => set(() => ({ penDraft: null })),
    closePenDraft: () => {
      const s = get();
      const draft = s.penDraft;
      if (!draft || draft.anchors.length < MIN_MASK_ANCHORS) return null;
      const layer = defaultMaskLayer(draft.view, draft.anchors, s.template);
      const view = s.template.views[draft.view];
      const layers = [...view.layers, layer];
      set(() => ({
        template: patchView(s.template, draft.view, { layers }),
        penDraft: null,
        selectedLayerId: layer.id,
        selectedAnchorIndex: null,
        dirty: true,
      }));
      return layer.id;
    },
    setLayerSourcePanel: (id, src) =>
      set((s) => {
        const found = findLayerById(s.template, id);
        if (!found) return {} as Partial<Store>;
        const layers = s.template.views[found.view].layers.map((l) =>
          l.id === id ? { ...l, productionPanelSrc: src } : l,
        );
        return {
          template: patchView(s.template, found.view, { layers }),
          dirty: true,
        };
      }),
    initLayerMesh: (id, cols = 4, rows = 4) =>
      set((s) => {
        const found = findLayerById(s.template, id);
        if (!found) return {} as Partial<Store>;
        const anchors = svgPathToAnchors(found.layer.maskPath);
        const bb = boundingBox(anchors);
        if (!bb) return {} as Partial<Store>;
        const mesh: MeshGrid = createDefaultMesh(
          { x: bb.minX, y: bb.minY, width: bb.maxX - bb.minX, height: bb.maxY - bb.minY },
          cols,
          rows,
          found.layer.mesh?.sourceRect ?? null,
        );
        const layers = s.template.views[found.view].layers.map((l) =>
          l.id === id ? { ...l, mesh } : l,
        );
        return {
          template: patchView(s.template, found.view, { layers }),
          dirty: true,
        };
      }),
    resetLayerMesh: (id, cols, rows) =>
      set((s) => {
        const found = findLayerById(s.template, id);
        if (!found) return {} as Partial<Store>;
        const anchors = svgPathToAnchors(found.layer.maskPath);
        const bb = boundingBox(anchors);
        if (!bb) return {} as Partial<Store>;
        const c = cols ?? found.layer.mesh?.cols ?? 4;
        const r = rows ?? found.layer.mesh?.rows ?? 4;
        const mesh: MeshGrid = createDefaultMesh(
          { x: bb.minX, y: bb.minY, width: bb.maxX - bb.minX, height: bb.maxY - bb.minY },
          c,
          r,
          found.layer.mesh?.sourceRect ?? null,
        );
        const layers = s.template.views[found.view].layers.map((l) =>
          l.id === id ? { ...l, mesh } : l,
        );
        return {
          template: patchView(s.template, found.view, { layers }),
          dirty: true,
        };
      }),
    resizeLayerMesh: (id, cols, rows) =>
      set((s) => {
        const found = findLayerById(s.template, id);
        if (!found) return {} as Partial<Store>;
        const layer = found.layer;
        const anchors = svgPathToAnchors(layer.maskPath);
        const bb = boundingBox(anchors);
        if (!bb) return {} as Partial<Store>;
        const fallback = {
          x: bb.minX,
          y: bb.minY,
          width: bb.maxX - bb.minX,
          height: bb.maxY - bb.minY,
        };
        const next = layer.mesh
          ? resizeMesh(layer.mesh, cols, rows, fallback)
          : createDefaultMesh(fallback, cols, rows, null);
        const layers = s.template.views[found.view].layers.map((l) =>
          l.id === id ? { ...l, mesh: next } : l,
        );
        return {
          template: patchView(s.template, found.view, { layers }),
          dirty: true,
        };
      }),
    setLayerMeshTargetPoint: (id, index, point) =>
      set((s) => {
        const found = findLayerById(s.template, id);
        if (!found || !found.layer.mesh) return {} as Partial<Store>;
        const mesh = found.layer.mesh;
        if (index < 0 || index >= mesh.targetPoints.length) return {} as Partial<Store>;
        const targetPoints = mesh.targetPoints.map((p, i) =>
          i === index ? { x: point.x, y: point.y } : p,
        );
        const layers = s.template.views[found.view].layers.map((l) =>
          l.id === id ? { ...l, mesh: { ...mesh, targetPoints } } : l,
        );
        return {
          template: patchView(s.template, found.view, { layers }),
          dirty: true,
        };
      }),
    setLayerMeshSourceRect: (id, rect) =>
      set((s) => {
        const found = findLayerById(s.template, id);
        if (!found || !found.layer.mesh) return {} as Partial<Store>;
        const layers = s.template.views[found.view].layers.map((l) =>
          l.id === id && l.mesh ? { ...l, mesh: { ...l.mesh, sourceRect: rect } } : l,
        );
        return {
          template: patchView(s.template, found.view, { layers }),
          dirty: true,
        };
      }),
    setLayerMeshSourceTransform: (id, patch) =>
      set((s) => {
        const found = findLayerById(s.template, id);
        if (!found || !found.layer.mesh) return {} as Partial<Store>;
        const layers = s.template.views[found.view].layers.map((l) => {
          if (l.id !== id || !l.mesh) return l;
          return {
            ...l,
            mesh: {
              ...l.mesh,
              ...(patch.sourceRotation !== undefined ? { sourceRotation: patch.sourceRotation } : {}),
              ...(patch.sourceFlipX !== undefined ? { sourceFlipX: patch.sourceFlipX } : {}),
              ...(patch.sourceFlipY !== undefined ? { sourceFlipY: patch.sourceFlipY } : {}),
            },
          };
        });
        return {
          template: patchView(s.template, found.view, { layers }),
          dirty: true,
        };
      }),
    rotateLayerMesh: (id, deltaDeg, anchor) =>
      set((s) => {
        const found = findLayerById(s.template, id);
        if (!found || !found.layer.mesh) return {} as Partial<Store>;
        if (!Number.isFinite(deltaDeg) || deltaDeg === 0) return {} as Partial<Store>;
        const rad = (deltaDeg * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const rot = (p: Pt): Pt => {
          const dx = p.x - anchor.x;
          const dy = p.y - anchor.y;
          return {
            x: anchor.x + dx * cos - dy * sin,
            y: anchor.y + dx * sin + dy * cos,
          };
        };
        // Mesh + corner pins rotate together; mask polygon stays put
        // (rotation is artwork-only — use panel move/scale to reposition
        // the traced boundary with the mesh).
        const layers = s.template.views[found.view].layers.map((l) => {
          if (l.id !== id || !l.mesh) return l;
          const targetPoints = l.mesh.targetPoints.map(rot);
          const cornerPins = l.cornerPins
            ? (l.cornerPins.map(rot) as typeof l.cornerPins)
            : l.cornerPins;
          return { ...l, mesh: { ...l.mesh, targetPoints }, cornerPins };
        });
        return {
          template: patchView(s.template, found.view, { layers }),
          dirty: true,
        };
      }),
    translateLayerMesh: (id, dx, dy) =>
      set((s) => {
        if ((!Number.isFinite(dx) || !Number.isFinite(dy)) || (dx === 0 && dy === 0)) {
          return {} as Partial<Store>;
        }
        const trans = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy });
        const next = applyPanelPointMap(s.template, id, trans);
        if (!next) return {} as Partial<Store>;
        return { template: next, dirty: true };
      }),
    scaleLayerMesh: (id, scale, anchor) =>
      set((s) => {
        if (!Number.isFinite(scale) || scale <= 0 || scale === 1) {
          return {} as Partial<Store>;
        }
        const sc = (p: Pt): Pt => ({
          x: anchor.x + (p.x - anchor.x) * scale,
          y: anchor.y + (p.y - anchor.y) * scale,
        });
        const next = applyPanelPointMap(s.template, id, sc);
        if (!next) return {} as Partial<Store>;
        return { template: next, dirty: true };
      }),
    translateLayerPolygon: (id, dx, dy) => get().actions.translateLayerMesh(id, dx, dy),
    setMeshEdit: (patch) =>
      set((s) => ({ meshEdit: { ...s.meshEdit, ...patch } })),
  },
}));

export const HOODIE_MAPPER_VERSION = HOODIE_TEMPLATE_VERSION;
