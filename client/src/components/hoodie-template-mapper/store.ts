import { create } from "zustand";
import {
  EMPTY_HOODIE_VIEW,
  emptyHoodieTemplate,
  HOODIE_TEMPLATE_VERSION,
  type HoodieTemplate,
  type HoodieToolId,
  type HoodieView,
  type MaskLayer,
  type MockupAsset,
  type ReferenceOverlayAsset,
} from "@shared/hoodieTemplate";

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
};

const DEFAULT_DEBUG_FLAGS: HoodieMapperDebugFlags = {
  showGrid: false,
  showPanelLabels: true,
  showHoverHighlight: true,
  referenceOverlayOpacity: 0.5,
};

export type HoodieMapperState = {
  template: HoodieTemplate;
  view: HoodieView;
  tool: HoodieToolId;
  selectedLayerId: string | null;
  hoverLayerId: string | null;
  debug: HoodieMapperDebugFlags;
  /** Tracks unsaved changes since the last successful save. */
  dirty: boolean;
  /** True while a save/load request is in flight. */
  busy: boolean;
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
  setReferenceOverlay: (view: HoodieView, overlay: ReferenceOverlayAsset | null) => void;
  setTemplateMeta: (patch: Partial<Pick<HoodieTemplate, "name" | "label" | "hoodieType" | "productTypeId" | "blueprintId" | "size">>) => void;
  /** Phase 2+ actions; added here as no-op-safe stubs so consumers stay stable. */
  upsertLayer: (layer: MaskLayer) => void;
  removeLayer: (id: string) => void;
  patchLayer: (id: string, patch: Partial<MaskLayer>) => void;
  reorderLayer: (id: string, newZIndex: number) => void;
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

export const useHoodieMapperStore = create<Store>((set) => ({
  template: emptyHoodieTemplate(STARTER_TEMPLATE_NAME, "Zip Hoodie AOP — Size L"),
  view: "front",
  tool: "move",
  selectedLayerId: null,
  hoverLayerId: null,
  debug: { ...DEFAULT_DEBUG_FLAGS },
  dirty: false,
  busy: false,
  actions: {
    loadTemplate: (template) =>
      set(() => ({
        template,
        selectedLayerId: null,
        hoverLayerId: null,
        dirty: false,
      })),
    resetTemplate: (name) =>
      set(() => ({
        template: emptyHoodieTemplate(name ?? STARTER_TEMPLATE_NAME),
        selectedLayerId: null,
        hoverLayerId: null,
        dirty: false,
      })),
    setView: (view) => set(() => ({ view, selectedLayerId: null, hoverLayerId: null })),
    setTool: (tool) => set(() => ({ tool })),
    setSelectedLayer: (id) => set(() => ({ selectedLayerId: id })),
    setHoverLayer: (id) => set(() => ({ hoverLayerId: id })),
    setDebug: (patch) => set((s) => ({ debug: { ...s.debug, ...patch } })),
    setBusy: (busy) => set(() => ({ busy })),
    markSaved: () => set(() => ({ dirty: false })),
    setMockup: (view, mockup) =>
      set((s) => ({
        template: patchView(s.template, view, { mockup }),
        dirty: true,
      })),
    setReferenceOverlay: (view, overlay) =>
      set((s) => ({
        template: patchView(s.template, view, { referenceOverlay: overlay }),
        dirty: true,
      })),
    setTemplateMeta: (patch) =>
      set((s) => ({
        template: bumpUpdatedAt({ ...s.template, ...patch }),
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
  },
}));

export const HOODIE_MAPPER_VERSION = HOODIE_TEMPLATE_VERSION;
