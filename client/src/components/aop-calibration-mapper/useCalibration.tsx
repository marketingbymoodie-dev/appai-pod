import { useMemo, useReducer } from "react";
import {
  buildMeshFromBounds,
  defaultBoundsForPanel,
  defaultMaskPolygon,
  resampleMesh,
  transformMesh,
} from "./meshUtils";
import {
  type CalibrationState,
  type MeshGrid,
  type PanelState,
  type UV,
  type ViewId,
  type ViewState,
  DEFAULT_PANEL_KEYS,
} from "./types";

function emptyView(): ViewState {
  return { mockupSrc: null, mockupSize: null, panels: {}, panelOrder: [] };
}

export function emptyCalibration(): CalibrationState {
  return {
    version: "aop-mapper/v1",
    productTypeId: 20,
    blueprintId: 451,
    providerId: 10,
    size: "L",
    productType: "zip_hoodie_aop",
    views: { front: emptyView(), back: emptyView() },
    meta: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      label: "untitled-calibration",
    },
  };
}

function defaultPanelState(panelKey: string, mesh: MeshGrid, sourceSize: { width: number; height: number } | null, artworkSrc: string | null, zIndex: number): PanelState {
  return {
    panelKey,
    visible: true,
    locked: false,
    opacity: 0.65,
    zIndex,
    artworkSrc,
    sourceSize,
    mesh,
    mask: { polygon: defaultMaskPolygon(), feather: 0 },
  };
}

type Action =
  | { type: "load"; calibration: CalibrationState }
  | { type: "set-mockup"; view: ViewId; src: string; size: { width: number; height: number } }
  | { type: "add-panel"; view: ViewId; panelKey: string; sourceSize: { width: number; height: number }; artworkSrc: string }
  | { type: "remove-panel"; view: ViewId; panelKey: string }
  | { type: "patch-panel"; view: ViewId; panelKey: string; patch: Partial<PanelState> }
  | { type: "move-mesh-point"; view: ViewId; panelKey: string; index: number; x: number; y: number }
  | { type: "set-mesh-density"; view: ViewId; panelKey: string; cols: number; rows: number }
  | { type: "transform-mesh"; view: ViewId; panelKey: string; opts: { dx?: number; dy?: number; scale?: number; rotation?: number; pivot?: { x: number; y: number } } }
  | { type: "set-mask-polygon"; view: ViewId; panelKey: string; polygon: UV[] }
  | { type: "reorder-panel"; view: ViewId; panelKey: string; newZIndex: number }
  | { type: "set-meta"; meta: Partial<CalibrationState["meta"]> }
  | { type: "set-product-info"; productTypeId?: number | null; blueprintId?: number | null; providerId?: number | null; size?: string | null };

function bump(state: CalibrationState): CalibrationState {
  return { ...state, meta: { ...state.meta, updatedAt: new Date().toISOString() } };
}

function reducer(state: CalibrationState, action: Action): CalibrationState {
  switch (action.type) {
    case "load":
      return action.calibration;
    case "set-mockup": {
      const view = state.views[action.view];
      const next: ViewState = { ...view, mockupSrc: action.src, mockupSize: action.size };
      return bump({ ...state, views: { ...state.views, [action.view]: next } });
    }
    case "add-panel": {
      const view = state.views[action.view];
      const w = view.mockupSize?.width ?? 2000;
      const h = view.mockupSize?.height ?? 2000;
      const offsetIdx = view.panelOrder.length;
      const offsetX = ((offsetIdx % 4) - 1.5) * (w * 0.18);
      const offsetY = (Math.floor(offsetIdx / 4) - 1) * (h * 0.18);
      const bounds = defaultBoundsForPanel(w, h, action.sourceSize.width, action.sourceSize.height, { dx: offsetX, dy: offsetY });
      const mesh = buildMeshFromBounds(2, 2, bounds);
      const zIndex = view.panelOrder.length;
      const panel = defaultPanelState(action.panelKey, mesh, action.sourceSize, action.artworkSrc, zIndex);
      const nextPanels = { ...view.panels, [action.panelKey]: panel };
      const nextOrder = view.panelOrder.includes(action.panelKey)
        ? view.panelOrder
        : [...view.panelOrder, action.panelKey];
      return bump({ ...state, views: { ...state.views, [action.view]: { ...view, panels: nextPanels, panelOrder: nextOrder } } });
    }
    case "remove-panel": {
      const view = state.views[action.view];
      const { [action.panelKey]: _removed, ...rest } = view.panels;
      const nextOrder = view.panelOrder.filter((k) => k !== action.panelKey);
      return bump({ ...state, views: { ...state.views, [action.view]: { ...view, panels: rest, panelOrder: nextOrder } } });
    }
    case "patch-panel": {
      const view = state.views[action.view];
      const panel = view.panels[action.panelKey];
      if (!panel) return state;
      if (panel.locked && !("locked" in action.patch) && !("visible" in action.patch) && !("opacity" in action.patch)) return state;
      const nextPanel: PanelState = { ...panel, ...action.patch };
      return bump({ ...state, views: { ...state.views, [action.view]: { ...view, panels: { ...view.panels, [action.panelKey]: nextPanel } } } });
    }
    case "move-mesh-point": {
      const view = state.views[action.view];
      const panel = view.panels[action.panelKey];
      if (!panel || panel.locked) return state;
      const points = [...panel.mesh.points];
      const target = points[action.index];
      if (!target) return state;
      points[action.index] = { ...target, x: action.x, y: action.y };
      const nextPanel: PanelState = { ...panel, mesh: { ...panel.mesh, points } };
      return bump({ ...state, views: { ...state.views, [action.view]: { ...view, panels: { ...view.panels, [action.panelKey]: nextPanel } } } });
    }
    case "set-mesh-density": {
      const view = state.views[action.view];
      const panel = view.panels[action.panelKey];
      if (!panel || panel.locked) return state;
      const newMesh = resampleMesh(panel.mesh, Math.max(1, action.cols), Math.max(1, action.rows));
      const nextPanel: PanelState = { ...panel, mesh: newMesh };
      return bump({ ...state, views: { ...state.views, [action.view]: { ...view, panels: { ...view.panels, [action.panelKey]: nextPanel } } } });
    }
    case "transform-mesh": {
      const view = state.views[action.view];
      const panel = view.panels[action.panelKey];
      if (!panel || panel.locked) return state;
      const next = transformMesh(panel.mesh, action.opts);
      return bump({ ...state, views: { ...state.views, [action.view]: { ...view, panels: { ...view.panels, [action.panelKey]: { ...panel, mesh: next } } } } });
    }
    case "set-mask-polygon": {
      const view = state.views[action.view];
      const panel = view.panels[action.panelKey];
      if (!panel || panel.locked) return state;
      const nextPanel: PanelState = { ...panel, mask: { polygon: action.polygon, feather: panel.mask?.feather ?? 0 } };
      return bump({ ...state, views: { ...state.views, [action.view]: { ...view, panels: { ...view.panels, [action.panelKey]: nextPanel } } } });
    }
    case "reorder-panel": {
      const view = state.views[action.view];
      const panel = view.panels[action.panelKey];
      if (!panel) return state;
      const nextPanel: PanelState = { ...panel, zIndex: action.newZIndex };
      const nextPanels = { ...view.panels, [action.panelKey]: nextPanel };
      const nextOrder = [...view.panelOrder].sort((a, b) => (nextPanels[a]?.zIndex ?? 0) - (nextPanels[b]?.zIndex ?? 0));
      return bump({ ...state, views: { ...state.views, [action.view]: { ...view, panels: nextPanels, panelOrder: nextOrder } } });
    }
    case "set-meta":
      return bump({ ...state, meta: { ...state.meta, ...action.meta } });
    case "set-product-info":
      return bump({
        ...state,
        productTypeId: action.productTypeId ?? state.productTypeId,
        blueprintId: action.blueprintId ?? state.blueprintId,
        providerId: action.providerId ?? state.providerId,
        size: action.size ?? state.size,
      });
    default:
      return state;
  }
}

export function useCalibration() {
  const [state, dispatch] = useReducer(reducer, undefined, emptyCalibration);

  const actions = useMemo(
    () => ({
      load: (calibration: CalibrationState) => dispatch({ type: "load", calibration }),
      setMockup: (view: ViewId, src: string, size: { width: number; height: number }) => dispatch({ type: "set-mockup", view, src, size }),
      addPanel: (view: ViewId, panelKey: string, sourceSize: { width: number; height: number }, artworkSrc: string) =>
        dispatch({ type: "add-panel", view, panelKey, sourceSize, artworkSrc }),
      removePanel: (view: ViewId, panelKey: string) => dispatch({ type: "remove-panel", view, panelKey }),
      patchPanel: (view: ViewId, panelKey: string, patch: Partial<PanelState>) => dispatch({ type: "patch-panel", view, panelKey, patch }),
      moveMeshPoint: (view: ViewId, panelKey: string, index: number, x: number, y: number) =>
        dispatch({ type: "move-mesh-point", view, panelKey, index, x, y }),
      setMeshDensity: (view: ViewId, panelKey: string, cols: number, rows: number) =>
        dispatch({ type: "set-mesh-density", view, panelKey, cols, rows }),
      transformMesh: (view: ViewId, panelKey: string, opts: { dx?: number; dy?: number; scale?: number; rotation?: number; pivot?: { x: number; y: number } }) =>
        dispatch({ type: "transform-mesh", view, panelKey, opts }),
      setMaskPolygon: (view: ViewId, panelKey: string, polygon: UV[]) => dispatch({ type: "set-mask-polygon", view, panelKey, polygon }),
      reorderPanel: (view: ViewId, panelKey: string, newZIndex: number) => dispatch({ type: "reorder-panel", view, panelKey, newZIndex }),
      setMeta: (meta: Partial<CalibrationState["meta"]>) => dispatch({ type: "set-meta", meta }),
      setProductInfo: (info: { productTypeId?: number | null; blueprintId?: number | null; providerId?: number | null; size?: string | null }) =>
        dispatch({ type: "set-product-info", ...info }),
    }),
    [],
  );

  return { state, actions };
}

export type CalibrationActions = ReturnType<typeof useCalibration>["actions"];

/** Helpful narrowing of the panel keys we expect by default. */
export const ALL_PANEL_KEYS = DEFAULT_PANEL_KEYS;

/** A type-safe accessor for the active view's panel state. */
export function getPanel(state: CalibrationState, view: ViewId, panelKey: string): PanelState | undefined {
  return state.views[view].panels[panelKey];
}
