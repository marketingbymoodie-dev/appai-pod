import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { Download, Image as ImageIcon, RotateCcw, Sparkles, Upload } from "lucide-react";
import type {
  DesignGroup,
  HoodieView,
  TileSettings,
} from "@shared/hoodieTemplate";
import { defaultDesignGroups } from "@shared/hoodieTemplate";
import { useHoodieMapperStore } from "./store";
import {
  computeGroupRects,
  renderAopPreview,
  renderAopPreviewToCanvas,
  type AopPreviewMode,
  type ArtworkPlacement,
  type DesignRectInfo,
  DEFAULT_ARTWORK_PLACEMENT,
} from "./lib/aopPreview";

/**
 * Live AOP preview modal — drops the customer's artwork onto the hoodie
 * mockup using whatever panel masks the user has traced so far. Lets the
 * user pick between front/back views, switch render modes, toggle
 * exclusions/outlines/labels, and download the result as a PNG.
 *
 * No server roundtrip: artwork picked from disk is loaded into a blob
 * URL, the renderer composites in-browser, and the PNG download uses the
 * canvas's toBlob output. This is intentionally decoupled from the dev
 * API so the user can try arbitrary artworks without server ops.
 */

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const MODE_OPTIONS: Array<{ id: AopPreviewMode; label: string; hint: string }> = [
  {
    id: "single-sheet",
    label: "Single sheet",
    hint: "One design split across panel groups — pet portraits, scenes.",
  },
  {
    id: "tile",
    label: "Repeating",
    hint: "Artwork tiles uniformly at a real-world size — fabric prints.",
  },
  {
    id: "per-panel-stretch",
    label: "Per-panel",
    hint: "Each panel independently stretches the full artwork.",
  },
  {
    id: "solid-colors",
    label: "Solid colors",
    hint: "No artwork — each panel filled with a debug colour to verify masks.",
  },
];

const TILE_PATTERN_OPTIONS: Array<{
  id: TileSettings["pattern"];
  label: string;
}> = [
  { id: "grid", label: "Grid" },
  { id: "brick", label: "Brick offset" },
  { id: "half-drop", label: "Half-drop" },
];

export default function AopPreviewModal({ open, onOpenChange }: Props) {
  const template = useHoodieMapperStore((s) => s.template);
  const activeView = useHoodieMapperStore((s) => s.view);
  const actions = useHoodieMapperStore((s) => s.actions);
  const { toast } = useToast();

  const [view, setView] = useState<HoodieView>(activeView);
  const [mode, setMode] = useState<AopPreviewMode>("single-sheet");
  const [showExclusions, setShowExclusions] = useState(true);
  const [showOutlines, setShowOutlines] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [applyShading, setApplyShading] = useState(true);
  // When true, each panel renders its calibration triangulated PNG
  // through the saved mesh — used to verify the mapping looks right
  // before swapping in customer artwork. Default is OFF so the
  // expected end-user flow ("see my artwork on the hoodie") just
  // works without diving through toggles.
  const [preferLayerSources, setPreferLayerSources] = useState(false);

  // Per-group, per-view artwork placement. Modal-local overrides win
  // over template defaults until "Save as defaults" copies them back.
  // Shape: { [groupId]: { front: ArtworkPlacement; back: ArtworkPlacement } }.
  const [groupPlacementOverrides, setGroupPlacementOverrides] = useState<
    Record<string, Record<HoodieView, ArtworkPlacement>>
  >({});
  // Per-group seam allowance overrides (% of group rect width).
  const [seamOverrides, setSeamOverrides] = useState<Record<string, number>>({});
  // Per-group enabled overrides — toggles a group off without
  // dirtying the template.
  const [enabledOverrides, setEnabledOverrides] = useState<Record<string, boolean>>(
    {},
  );
  // Which group's on-canvas handles are currently editable. `null`
  // (or unknown id) = no handles shown. Defaults to the first group
  // with eligible panels in the active view.
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  // Lock-ratio toggle: when on, dragging any group's scale rescales
  // the others to preserve the captured ratios snapshot.
  const [lockRatios, setLockRatios] = useState(false);
  const [lockedRatios, setLockedRatios] = useState<Record<string, number> | null>(
    null,
  );
  // Tile-mode settings (modal-local). Falls back to template's stored
  // defaults via normalizeHoodieTemplate.
  const [tileOverride, setTileOverride] = useState<TileSettings | null>(null);
  const [ppiOverride, setPpiOverride] = useState<number | null>(null);
  const [showDesignRect, setShowDesignRect] = useState(true);

  // Resolved (read-only) helpers — read template defaults whenever an
  // override is missing.
  const designGroups: DesignGroup[] = useMemo(
    () => template.designGroups ?? defaultDesignGroups(),
    [template.designGroups],
  );
  const tileSettings: TileSettings = useMemo(() => {
    if (tileOverride) return tileOverride;
    return template.tileSettings ?? { pattern: "grid", tileSizeInches: 1.5 };
  }, [tileOverride, template.tileSettings]);
  const pixelsPerInch =
    ppiOverride ?? template.realWorldCalibration?.pixelsPerInch ?? 1024 / 24;

  /** Read the effective placement for a group + view (override → template default → identity). */
  const getPlacement = useMemo(
    () => (groupId: string, v: HoodieView): ArtworkPlacement => {
      const ov = groupPlacementOverrides[groupId]?.[v];
      if (ov) return ov;
      const stored = designGroups.find((g) => g.id === groupId)?.placement?.[v];
      return stored ? { ...stored } : { ...DEFAULT_ARTWORK_PLACEMENT };
    },
    [groupPlacementOverrides, designGroups],
  );
  const getSeam = (groupId: string): number => {
    const ov = seamOverrides[groupId];
    if (typeof ov === "number") return ov;
    return designGroups.find((g) => g.id === groupId)?.seamAllowance ?? 0;
  };
  const getEnabled = (groupId: string): boolean => {
    const ov = enabledOverrides[groupId];
    if (typeof ov === "boolean") return ov;
    return designGroups.find((g) => g.id === groupId)?.enabled !== false;
  };

  /**
   * Patch a group's placement for the current view. When lock-ratio
   * is engaged, propagates the same scale-factor change to every
   * other group so the captured ratios stay constant.
   */
  const setGroupPlacement = (
    groupId: string,
    v: HoodieView,
    patch: Partial<ArtworkPlacement>,
  ) => {
    setGroupPlacementOverrides((prev) => {
      const next = { ...prev };
      const current = prev[groupId]?.[v] ?? getPlacement(groupId, v);
      const updated: ArtworkPlacement = { ...current, ...patch };
      const otherView: HoodieView = v === "front" ? "back" : "front";
      next[groupId] = {
        ...(prev[groupId] ?? {
          front: getPlacement(groupId, "front"),
          back: getPlacement(groupId, "back"),
        }),
        [v]: updated,
        [otherView]:
          prev[groupId]?.[otherView] ?? getPlacement(groupId, otherView),
      } as Record<HoodieView, ArtworkPlacement>;

      // Lock-ratio propagation — only when scale changed and ratios
      // were captured for this group.
      if (
        lockRatios &&
        lockedRatios &&
        typeof patch.scale === "number" &&
        lockedRatios[groupId]
      ) {
        const oldScale = lockedRatios[groupId];
        const newScale = patch.scale;
        const factor = newScale / Math.max(0.0001, oldScale);
        for (const g of designGroups) {
          if (g.id === groupId) continue;
          const otherCaptured = lockedRatios[g.id];
          if (typeof otherCaptured !== "number") continue;
          const linkedScale = otherCaptured * factor;
          const baseline =
            prev[g.id]?.[v] ?? getPlacement(g.id, v);
          next[g.id] = {
            ...(prev[g.id] ?? {
              front: getPlacement(g.id, "front"),
              back: getPlacement(g.id, "back"),
            }),
            [v]: { ...baseline, scale: linkedScale },
            [otherView]:
              prev[g.id]?.[otherView] ?? getPlacement(g.id, otherView),
          } as Record<HoodieView, ArtworkPlacement>;
        }
      }
      return next;
    });
  };

  /** Engage / disengage the lock toggle. Engaging captures current scales. */
  const toggleLockRatios = (next: boolean) => {
    if (next) {
      const snapshot: Record<string, number> = {};
      for (const g of designGroups) {
        snapshot[g.id] = getPlacement(g.id, view).scale;
      }
      setLockedRatios(snapshot);
    } else {
      setLockedRatios(null);
    }
    setLockRatios(next);
  };

  /** Re-snapshot ratios while still locked. */
  const recaptureLockedRatios = () => {
    const snapshot: Record<string, number> = {};
    for (const g of designGroups) {
      snapshot[g.id] = getPlacement(g.id, view).scale;
    }
    setLockedRatios(snapshot);
  };

  // Default the active group to the first one that has eligible
  // panels traced in the current view, so the handles immediately
  // show something useful.
  useEffect(() => {
    if (!open || mode !== "single-sheet") return;
    if (activeGroupId && designGroups.some((g) => g.id === activeGroupId)) return;
    const layers = template.views[view]?.layers ?? [];
    const first = designGroups.find((g) =>
      layers.some(
        (l) => l.panelKey && g.panelKeys.includes(l.panelKey) && l.visible && !l.isExclusion,
      ),
    );
    setActiveGroupId(first?.id ?? null);
  }, [open, mode, view, designGroups, template.views, activeGroupId]);

  // Has the modal been edited? Used to enable Save / Reset buttons.
  const hasOverrides =
    Object.keys(groupPlacementOverrides).length > 0 ||
    Object.keys(seamOverrides).length > 0 ||
    Object.keys(enabledOverrides).length > 0 ||
    tileOverride !== null ||
    ppiOverride !== null;

  // Background colour painted under the artwork in every print panel
  // (and ALL of any panel excluded from single-sheet). null = off.
  // Stored as state-only so the admin can experiment with colours
  // without dirtying the template.
  const [backgroundColor, setBackgroundColor] = useState<string | null>(null);

  // Artwork pipeline — file → blob URL → HTMLImageElement.
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
  const [artworkName, setArtworkName] = useState<string | null>(null);
  const [artworkImg, setArtworkImg] = useState<HTMLImageElement | null>(null);
  const [artworkLoading, setArtworkLoading] = useState(false);

  // Mockup pipeline — re-load when view or template changes so we can
  // composite at full resolution (the on-canvas Konva image is scaled).
  const [mockupImg, setMockupImg] = useState<HTMLImageElement | null>(null);
  const mockupSrc = template.views[view]?.mockup?.src ?? null;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Keep modal view in sync if the user changes the toolbar view while it's open.
  useEffect(() => {
    if (open) setView(activeView);
  }, [open, activeView]);

  // Load mockup image whenever the relevant view changes.
  useEffect(() => {
    if (!open || !mockupSrc) {
      setMockupImg(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!cancelled) setMockupImg(img);
    };
    img.onerror = () => {
      if (!cancelled) {
        setMockupImg(null);
        toast({
          title: "Couldn't load mockup",
          description: `Failed to load ${mockupSrc}`,
          variant: "destructive",
        });
      }
    };
    img.src = mockupSrc;
    return () => {
      cancelled = true;
    };
  }, [open, mockupSrc, toast]);

  // Load artwork whenever URL changes.
  useEffect(() => {
    if (!artworkUrl) {
      setArtworkImg(null);
      return;
    }
    let cancelled = false;
    setArtworkLoading(true);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!cancelled) {
        setArtworkImg(img);
        setArtworkLoading(false);
      }
    };
    img.onerror = () => {
      if (!cancelled) {
        setArtworkImg(null);
        setArtworkLoading(false);
        toast({
          title: "Couldn't load artwork",
          description: artworkName ?? artworkUrl,
          variant: "destructive",
        });
      }
    };
    img.src = artworkUrl;
    return () => {
      cancelled = true;
    };
  }, [artworkUrl, artworkName, toast]);

  // Per-layer source artwork preloader. Builds a Map<URL, HTMLImageElement>
  // so the renderer can stay synchronous while still consuming Printify-
  // style production-panel sheets that the user uploads per layer.
  const layerSrcUrls = useMemo(() => {
    const set = new Set<string>();
    for (const v of ["front", "back"] as HoodieView[]) {
      const layers = template.views[v]?.layers ?? [];
      for (const l of layers) {
        if (l.productionPanelSrc) set.add(l.productionPanelSrc);
      }
    }
    return Array.from(set);
  }, [template]);
  const [layerSources, setLayerSources] = useState<Map<string, HTMLImageElement>>(new Map());
  useEffect(() => {
    if (!open) return;
    if (layerSrcUrls.length === 0) {
      setLayerSources(new Map());
      return;
    }
    let cancelled = false;
    const next = new Map<string, HTMLImageElement>();
    let remaining = layerSrcUrls.length;
    layerSrcUrls.forEach((url) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        next.set(url, img);
        remaining -= 1;
        if (remaining === 0 && !cancelled) setLayerSources(new Map(next));
      };
      img.onerror = () => {
        remaining -= 1;
        if (remaining === 0 && !cancelled) setLayerSources(new Map(next));
      };
      img.src = url;
    });
    return () => {
      cancelled = true;
    };
  }, [open, layerSrcUrls]);

  // Re-render the preview canvas whenever any input changes.
  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas || !mockupImg) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    renderAopPreview(ctx, {
      template,
      view,
      mockup: mockupImg,
      artwork: artworkImg,
      mode,
      showExclusions,
      showOutlines,
      showLabels,
      layerSources,
      preferLayerSources,
      applyShading,
      groupPlacementOverrides,
      groupSeamOverrides: seamOverrides,
      groupEnabledOverrides: enabledOverrides,
      activeGroupId,
      tileSettings,
      pixelsPerInch,
      showDesignRect,
      backgroundColor,
    });
  }, [
    open,
    template,
    view,
    mockupImg,
    artworkImg,
    mode,
    showExclusions,
    showOutlines,
    showLabels,
    layerSources,
    preferLayerSources,
    applyShading,
    groupPlacementOverrides,
    seamOverrides,
    enabledOverrides,
    activeGroupId,
    tileSettings,
    pixelsPerInch,
    showDesignRect,
    backgroundColor,
  ]);

  // Layer summary for the footer.
  const summary = useMemo(() => {
    const layers = template.views[view]?.layers ?? [];
    const printed = layers.filter((l) => !l.isExclusion);
    const exclusions = layers.filter((l) => l.isExclusion);
    return {
      total: layers.length,
      printed: printed.length,
      exclusions: exclusions.length,
      assigned: printed.filter((l) => Boolean(l.panelKey)).length,
    };
  }, [template, view]);

  function handleArtworkPick(file: File) {
    if (artworkUrl) URL.revokeObjectURL(artworkUrl);
    const url = URL.createObjectURL(file);
    setArtworkUrl(url);
    setArtworkName(file.name);
  }

  function handleClearArtwork() {
    if (artworkUrl) URL.revokeObjectURL(artworkUrl);
    setArtworkUrl(null);
    setArtworkName(null);
    setArtworkImg(null);
  }

  function handleDownloadPng() {
    if (!mockupImg) return;
    const canvas = renderAopPreviewToCanvas({
      template,
      view,
      mockup: mockupImg,
      artwork: artworkImg,
      mode,
      showExclusions,
      showOutlines,
      showLabels,
      layerSources,
      preferLayerSources,
      applyShading,
      groupPlacementOverrides,
      groupSeamOverrides: seamOverrides,
      groupEnabledOverrides: enabledOverrides,
      tileSettings,
      pixelsPerInch,
      backgroundColor,
      // Never bake the design-rect outline into the saved PNG —
      // it's a UI overlay, not part of the customer artwork.
      showDesignRect: false,
    });
    canvas.toBlob((blob) => {
      if (!blob) {
        toast({ title: "Could not export PNG", variant: "destructive" });
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${template.name}-${view}-aop-preview.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: "Saved preview PNG", description: a.download });
    }, "image/png");
  }

  // Cleanup blob URLs on unmount.
  useEffect(() => {
    return () => {
      if (artworkUrl) URL.revokeObjectURL(artworkUrl);
    };
  }, [artworkUrl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[92vh] max-h-[92vh] w-[min(96vw,1280px)] max-w-none flex-col overflow-hidden border-slate-800 bg-slate-950 p-0 text-slate-200"
        data-testid="hoodie-aop-preview-modal"
      >
        <DialogHeader className="flex-row items-center justify-between border-b border-slate-800 px-4 py-3">
          <div>
            <DialogTitle className="flex items-center gap-2 text-slate-100">
              <Sparkles className="h-4 w-4 text-fuchsia-300" />
              AOP Preview · {template.name}
            </DialogTitle>
            <p className="mt-0.5 text-[11px] text-slate-400">
              Drops AOP artwork onto the hoodie using your traced panel masks. Each panel
              with a saved mesh warps the uploaded artwork through it; panels without a mesh
              fall back to the selected mode.
            </p>
          </div>

          {/* View tabs (front/back) */}
          <div className="flex overflow-hidden rounded border border-slate-700">
            {(["front", "back"] as HoodieView[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide transition ${
                  view === v
                    ? "bg-slate-200 text-slate-900"
                    : "bg-slate-900 text-slate-300 hover:bg-slate-800"
                }`}
                data-testid={`hoodie-preview-view-${v}`}
              >
                {v}
              </button>
            ))}
          </div>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden">
          {/* Left: control rail */}
          <div className="flex w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-slate-800 bg-slate-900/40 p-4">
            {/* Mode picker */}
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">Mode</div>
              <div className="flex flex-col gap-1">
                {MODE_OPTIONS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setMode(m.id)}
                    className={`rounded border px-2 py-1.5 text-left text-[11px] transition ${
                      mode === m.id
                        ? "border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-100"
                        : "border-slate-800 bg-slate-950 text-slate-300 hover:bg-slate-800"
                    }`}
                    data-testid={`hoodie-preview-mode-${m.id}`}
                  >
                    <div className="font-medium">{m.label}</div>
                    <div className="text-[10px] text-slate-500">{m.hint}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Artwork picker */}
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">Artwork</div>
              <Button
                size="sm"
                variant="outline"
                className="w-full justify-start gap-2 text-xs"
                onClick={() => fileInputRef.current?.click()}
                disabled={mode === "solid-colors"}
                data-testid="hoodie-preview-artwork-pick"
              >
                <Upload className="h-3.5 w-3.5" />
                {artworkName ? "Replace artwork" : "Choose AOP artwork"}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleArtworkPick(f);
                  e.target.value = "";
                }}
              />
              {artworkName && (
                <div className="mt-2 flex items-center gap-1 rounded border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] text-slate-300">
                  <ImageIcon className="h-3 w-3 shrink-0 text-slate-500" />
                  <span className="flex-1 truncate" title={artworkName}>
                    {artworkLoading ? "Loading…" : artworkName}
                  </span>
                  <button
                    type="button"
                    onClick={handleClearArtwork}
                    className="text-slate-500 hover:text-slate-200"
                    title="Clear artwork"
                  >
                    ×
                  </button>
                </div>
              )}
              {!artworkName && mode !== "solid-colors" && (
                <div className="mt-2 text-[10px] text-slate-500">
                  No artwork picked — panels with meshes will show their calibration art;
                  others stay empty (mockup pixels show through).
                </div>
              )}
            </div>

            {/* Single-sheet groups — per-group placement, seam, lock-ratio. */}
            {mode === "single-sheet" && artworkImg && (
              <GroupsPanel
                designGroups={designGroups}
                view={view}
                layers={template.views[view]?.layers ?? []}
                activeGroupId={activeGroupId}
                onActiveGroupChange={setActiveGroupId}
                getPlacement={getPlacement}
                getSeam={getSeam}
                getEnabled={getEnabled}
                onPlacementChange={(gid, patch) => setGroupPlacement(gid, view, patch)}
                onSeamChange={(gid, val) =>
                  setSeamOverrides((prev) => ({ ...prev, [gid]: val }))
                }
                onEnabledChange={(gid, val) =>
                  setEnabledOverrides((prev) => ({ ...prev, [gid]: val }))
                }
                lockRatios={lockRatios}
                onLockToggle={toggleLockRatios}
                onRecaptureRatios={recaptureLockedRatios}
                hasOverrides={hasOverrides}
                onSaveDefaults={() => {
                  // Bake current modal state into the template's
                  // designGroups defaults, then clear overrides so the
                  // template + modal are perfectly in sync.
                  const next = designGroups.map((g) => ({
                    ...g,
                    placement: {
                      front: getPlacement(g.id, "front"),
                      back: getPlacement(g.id, "back"),
                    },
                    seamAllowance: getSeam(g.id),
                    enabled: getEnabled(g.id),
                    lockedRatio:
                      lockRatios && lockedRatios && lockedRatios[g.id] !== undefined
                        ? lockedRatios[g.id]
                        : null,
                  }));
                  actions.setDesignGroups(next);
                  setGroupPlacementOverrides({});
                  setSeamOverrides({});
                  setEnabledOverrides({});
                  toast({
                    title: "Defaults saved",
                    description: "Group placements stored on this template.",
                  });
                }}
                onResetOverrides={() => {
                  setGroupPlacementOverrides({});
                  setSeamOverrides({});
                  setEnabledOverrides({});
                }}
                showDesignRect={showDesignRect}
                onShowDesignRectChange={setShowDesignRect}
              />
            )}

            {/* Tile-mode controls — pattern picker + tile size + ppi. */}
            {mode === "tile" && (
              <TilePanel
                tileSettings={tileSettings}
                pixelsPerInch={pixelsPerInch}
                onTileChange={(patch) =>
                  setTileOverride((prev) => ({
                    ...(prev ??
                      template.tileSettings ?? {
                        pattern: "grid",
                        tileSizeInches: 1.5,
                      }),
                    ...patch,
                  }))
                }
                onPpiChange={(v) => setPpiOverride(v)}
                onSaveDefaults={() => {
                  actions.setTileSettings(tileSettings);
                  actions.setRealWorldCalibration({ pixelsPerInch });
                  setTileOverride(null);
                  setPpiOverride(null);
                  toast({
                    title: "Tile defaults saved",
                    description: "Pattern + size + calibration stored on this template.",
                  });
                }}
                onResetOverrides={() => {
                  setTileOverride(null);
                  setPpiOverride(null);
                }}
                hasOverrides={tileOverride !== null || ppiOverride !== null}
              />
            )}

            {/* Background colour picker — base fabric colour. Sits
                under the artwork inside every print panel and fills
                panels excluded from single-sheet entirely. Useful for
                matching Printify's brown / red / etc. base hoodies. */}
            <BackgroundColorPicker value={backgroundColor} onChange={setBackgroundColor} />

            {/* Single-sheet panel inclusion — multi-select that maps
                to MaskLayer.includeInSingleSheet. Lets the admin
                shrink the design canvas to e.g. body+hood only. */}
            {mode === "single-sheet" && (
              <SingleSheetPanelPicker
                layers={template.views[view]?.layers ?? []}
                onToggle={(id, include) =>
                  actions.patchLayer(id, { includeInSingleSheet: include })
                }
                onPreset={(panelKeys) => {
                  const layers = template.views[view]?.layers ?? [];
                  for (const layer of layers) {
                    if (layer.isExclusion) continue;
                    const isOn =
                      panelKeys === "all"
                        ? true
                        : panelKeys === "none"
                          ? false
                          : layer.panelKey
                            ? panelKeys.includes(layer.panelKey)
                            : false;
                    actions.patchLayer(layer.id, { includeInSingleSheet: isOn });
                  }
                }}
              />
            )}

            {/* Toggles */}
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">Display</div>
              <ToggleRow
                label="Punch out exclusions"
                checked={showExclusions}
                onChange={setShowExclusions}
              />
              <ToggleRow
                label="Bake mockup shading"
                checked={applyShading}
                onChange={setApplyShading}
              />
              <ToggleRow label="Mask outlines" checked={showOutlines} onChange={setShowOutlines} />
              <ToggleRow label="Panel labels" checked={showLabels} onChange={setShowLabels} />
              {layerSources.size > 0 && (
                <ToggleRow
                  label="Show calibration art instead"
                  checked={preferLayerSources}
                  onChange={setPreferLayerSources}
                />
              )}
              {layerSources.size > 0 && (
                <div className="mt-1 rounded border border-purple-900/40 bg-purple-950/20 px-2 py-1 text-[10px] text-purple-200">
                  {preferLayerSources ? (
                    <>
                      Showing calibration art (Printify triangles) warped through{" "}
                      {layerSources.size} panel{layerSources.size === 1 ? "" : "s"} — turn this
                      off to project your uploaded artwork instead.
                    </>
                  ) : artworkImg ? (
                    <>
                      Your artwork is being warped through {layerSources.size} mesh
                      {layerSources.size === 1 ? "" : "es"}. Toggle "Show calibration art" to
                      verify the mapping.
                    </>
                  ) : (
                    <>
                      Mesh data ready on {layerSources.size} panel
                      {layerSources.size === 1 ? "" : "s"}. Upload an artwork above to test it
                      through the warps.
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Layer summary */}
            <div className="mt-auto rounded border border-slate-800 bg-slate-950 p-2 text-[10px] text-slate-400">
              <div className="mb-1 font-semibold uppercase tracking-wide text-slate-300">
                {view} layers
              </div>
              <div>
                Print: <span className="text-emerald-300">{summary.printed}</span>
                {" · "}
                Excl: <span className="text-red-300">{summary.exclusions}</span>
              </div>
              <div>
                Panel-assigned:{" "}
                <span className={summary.assigned === summary.printed ? "text-emerald-300" : "text-amber-300"}>
                  {summary.assigned}/{summary.printed}
                </span>
              </div>
              {summary.printed === 0 && (
                <div className="mt-1 text-amber-300">No print layers in this view yet.</div>
              )}
            </div>
          </div>

          {/* Right: preview surface */}
          <div className="relative flex flex-1 items-center justify-center overflow-auto bg-slate-950 p-4">
            <div className="relative flex max-h-full max-w-full items-center justify-center">
              <canvas
                ref={canvasRef}
                className="max-h-[78vh] max-w-full rounded border border-slate-800 bg-black object-contain shadow-xl"
                data-testid="hoodie-aop-preview-canvas"
              />
              {mockupImg && mode === "single-sheet" && artworkImg && activeGroupId && (
                <DesignRectHandlesOverlay
                  canvasRef={canvasRef}
                  template={template}
                  view={view}
                  mockup={mockupImg}
                  artwork={artworkImg}
                  groupId={activeGroupId}
                  placement={getPlacement(activeGroupId, view)}
                  enabledOverrides={enabledOverrides}
                  seamOverrides={seamOverrides}
                  placementOverrides={groupPlacementOverrides}
                  onChange={(next) =>
                    setGroupPlacement(activeGroupId, view, next)
                  }
                />
              )}
            </div>
            {!mockupImg && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm text-slate-300">
                Loading mockup…
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-800 px-4 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownloadPng}
            disabled={!mockupImg}
            data-testid="hoodie-preview-download"
          >
            <Download className="mr-1 h-3.5 w-3.5" />
            Save PNG
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (c: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between py-1 text-[11px]">
      <span className="text-slate-300">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 cursor-pointer accent-fuchsia-500"
      />
    </label>
  );
}

/**
 * Slider + numeric value display row used by the Placement section.
 * `precision` controls decimal places shown next to the label;
 * `unit` is appended after the value.
 */
function PlacementSlider({
  label,
  unit,
  value,
  min,
  max,
  step,
  precision,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  precision: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1 py-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-slate-300">{label}</span>
        <span className="font-mono text-slate-400">
          {value.toFixed(precision)}
          {unit}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  );
}

/**
 * Native colour picker for the AOP background fill. Includes a small
 * preset palette of common Printify base colours so the admin can
 * pick "the brown one" without dialling RGB. Set to null disables
 * the fill (panels show mockup pixels through artwork transparency,
 * which is the original behaviour).
 */
const BG_PRESETS: Array<{ label: string; hex: string }> = [
  { label: "Brown", hex: "#8a4a2a" },
  { label: "Charcoal", hex: "#2f2f2f" },
  { label: "Red", hex: "#a13d2a" },
  { label: "Forest", hex: "#2d4a2a" },
  { label: "Navy", hex: "#1f2c4a" },
  { label: "Cream", hex: "#e8dccd" },
];

function BackgroundColorPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const enabled = value !== null;
  const colour = value ?? "#8a4a2a";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-slate-400">
          Background colour
        </span>
        <label className="flex cursor-pointer items-center gap-1 text-[10px] text-slate-400">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onChange(e.target.checked ? colour : null)}
            className="h-3 w-3 cursor-pointer accent-fuchsia-500"
          />
          on
        </label>
      </div>
      {enabled && (
        <>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={colour}
              onChange={(e) => onChange(e.target.value)}
              className="h-7 w-10 cursor-pointer rounded border border-slate-700 bg-slate-950 p-0"
              title="Pick fabric colour"
            />
            <input
              type="text"
              value={colour}
              onChange={(e) => onChange(e.target.value)}
              className="h-7 flex-1 rounded border border-slate-700 bg-slate-950 px-2 text-[11px] font-mono text-slate-200 focus:border-fuchsia-500 focus:outline-none"
              spellCheck={false}
            />
          </div>
          <div className="mt-1 grid grid-cols-6 gap-1">
            {BG_PRESETS.map((p) => (
              <button
                key={p.hex}
                type="button"
                onClick={() => onChange(p.hex)}
                title={`${p.label} · ${p.hex}`}
                className="h-5 w-full rounded border border-slate-800 transition hover:scale-110 hover:border-slate-500"
                style={{ background: p.hex }}
              />
            ))}
          </div>
          <div className="mt-1 text-[10px] text-slate-500">
            Sits under the artwork inside every print panel — fills transparent regions of
            your art and any panel excluded from single-sheet. Mockup shading multiplies
            on top so it looks like dyed fabric.
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Multi-select picker that drives `MaskLayer.includeInSingleSheet`
 * via the store. Showing this in the AOP modal keeps the test loop
 * tight: tweak panel inclusion and immediately see the design canvas
 * recompute. The persisted flag means the choice survives reloads
 * unless the admin opts back in.
 */
function SingleSheetPanelPicker({
  layers,
  onToggle,
  onPreset,
}: {
  layers: import("@shared/hoodieTemplate").MaskLayer[];
  onToggle: (id: string, include: boolean) => void;
  onPreset: (
    panelKeys:
      | "all"
      | "none"
      | Array<import("@shared/hoodieTemplate").HoodiePanelKey>,
  ) => void;
}) {
  const printLayers = layers.filter((l) => !l.isExclusion);
  if (printLayers.length === 0) return null;
  const inCount = printLayers.filter((l) => l.includeInSingleSheet !== false).length;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-slate-400">
          Single-sheet panels
        </span>
        <span className="text-[10px] text-slate-500">
          {inCount}/{printLayers.length}
        </span>
      </div>
      {/* Quick presets — common compositions the admin reaches for. */}
      <div className="mb-1 grid grid-cols-3 gap-1">
        <button
          type="button"
          onClick={() => onPreset("all")}
          className="rounded border border-slate-800 bg-slate-950 px-1 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
        >
          All
        </button>
        <button
          type="button"
          onClick={() =>
            onPreset(["front_left", "front_right", "left_hood", "right_hood", "back"])
          }
          className="rounded border border-slate-800 bg-slate-950 px-1 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
          title="Front body + hood + back only — sleeves / cuffs / waistband / pocket excluded"
        >
          Body+hood
        </button>
        <button
          type="button"
          onClick={() => onPreset("none")}
          className="rounded border border-slate-800 bg-slate-950 px-1 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
        >
          None
        </button>
      </div>
      <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-slate-800 bg-slate-950/50 p-1">
        {printLayers.map((l) => {
          const include = l.includeInSingleSheet !== false;
          return (
            <li key={l.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-slate-800/60">
                <input
                  type="checkbox"
                  checked={include}
                  onChange={(e) => onToggle(l.id, e.target.checked)}
                  className="h-3 w-3 cursor-pointer accent-fuchsia-500"
                />
                <span className="flex-1 truncate text-slate-300" title={l.name}>
                  {l.name}
                </span>
                {l.panelKey && (
                  <span className="text-[10px] text-slate-500">{l.panelKey}</span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
      <div className="mt-1 text-[10px] text-slate-500">
        Excluded panels still show the background colour (and shading), but no artwork.
        The design canvas shrinks to the bounding box of the included panels only.
      </div>
    </div>
  );
}

/**
 * Interactive overlay that floats above the AOP preview canvas and
 * exposes drag-to-translate + corner-drag-to-resize gestures bound
 * to `ArtworkPlacement`. Aspect ratio is locked — the rect always
 * reflects the artwork's natural shape (computed by
 * `computeDesignRect`), so corner drags only ever scale uniformly,
 * never squish.
 *
 * Coordinate model:
 *   - The overlay is `inset-0` over the canvas's display rect, so a
 *     mockup-px point (mx, my) maps to CSS by `mx / mockupW * 100%`.
 *   - Drag gestures convert pointer-px deltas → mockup-px deltas via
 *     `mockupW / canvas.clientWidth` (and equivalent for Y), so the
 *     interaction stays accurate at any display size.
 *   - Corner drag keeps the *opposite* corner pinned and snaps the
 *     rect's height to the artwork aspect, so the resize feels like
 *     dragging Photoshop's transform handles.
 */
function DesignRectHandlesOverlay({
  canvasRef,
  template,
  view,
  mockup,
  artwork,
  groupId,
  placement,
  placementOverrides,
  seamOverrides,
  enabledOverrides,
  onChange,
}: {
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  template: import("@shared/hoodieTemplate").HoodieTemplate;
  view: HoodieView;
  mockup: HTMLImageElement;
  artwork: HTMLImageElement;
  /** Which design group's rect we're showing handles for. */
  groupId: string;
  /** Effective placement (overrides → defaults) for the active group. */
  placement: ArtworkPlacement;
  /** Modal-local overrides — passed through so computeGroupRects sees them. */
  placementOverrides?: Record<string, Record<HoodieView, ArtworkPlacement>>;
  seamOverrides?: Record<string, number>;
  enabledOverrides?: Record<string, boolean>;
  /** Patch the active group's placement (modal handles lock-ratio propagation). */
  onChange: (next: ArtworkPlacement) => void;
}) {
  const info: DesignRectInfo | null = useMemo(() => {
    const map = computeGroupRects(template, view, artwork, {
      placementOverrides,
      seamOverrides,
      enabledOverrides,
    });
    return map.get(groupId) ?? null;
  }, [
    template,
    view,
    artwork,
    groupId,
    placementOverrides,
    seamOverrides,
    enabledOverrides,
  ]);

  // We need to know the canvas's natural (mockup) size to convert
  // mockup-px positions into % of overlay. The overlay matches the
  // canvas display rect via inset-0, so % of overlay == % of mockup.
  const mockupW = mockup.naturalWidth || mockup.width;
  const mockupH = mockup.naturalHeight || mockup.height;

  // Active drag state. We hold a snapshot of the placement + base
  // rect at gesture start so each pointermove computes deltas
  // against the start, never compounding rounding errors.
  const dragRef = useRef<
    | null
    | {
        mode: "translate" | "scale";
        corner?: "nw" | "ne" | "sw" | "se";
        startClientX: number;
        startClientY: number;
        startPlacement: ArtworkPlacement;
        startInfo: DesignRectInfo;
        canvasRect: DOMRect;
      }
  >(null);

  // Convert pointer client-space delta → mockup-space delta using
  // the canvas's current displayed size. Cached at gesture start.
  const clientToMockup = (
    cx: number,
    cy: number,
    canvasRect: DOMRect,
  ): { x: number; y: number } => {
    const sx = mockupW / canvasRect.width;
    const sy = mockupH / canvasRect.height;
    return {
      x: (cx - canvasRect.left) * sx,
      y: (cy - canvasRect.top) * sy,
    };
  };

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const dxClient = e.clientX - drag.startClientX;
      const dyClient = e.clientY - drag.startClientY;
      const sx = mockupW / drag.canvasRect.width;
      const sy = mockupH / drag.canvasRect.height;
      const dxMock = dxClient * sx;
      const dyMock = dyClient * sy;

      if (drag.mode === "translate") {
        onChange({
          ...drag.startPlacement,
          offsetX: drag.startPlacement.offsetX + dxMock,
          offsetY: drag.startPlacement.offsetY + dyMock,
        });
        return;
      }

      // Scale: keep opposite corner pinned, scale uniformly using
      // whichever axis the pointer moved further along (relative to
      // baseRect's aspect). This makes diagonal drags feel
      // monotonic — pulling out always grows, pushing in always
      // shrinks, regardless of which axis dominates.
      if (drag.mode === "scale") {
        const start = drag.startInfo.effective;
        const aspect = start.width / start.height;
        const corner = drag.corner ?? "se";
        // Pointer position in mockup px right now.
        const m = clientToMockup(e.clientX, e.clientY, drag.canvasRect);
        // Opposite corner (pinned) — derived from the rect at drag
        // start. e.g. dragging "se" pins "nw".
        const pinned = {
          x: corner.includes("e") ? start.x : start.x + start.width,
          y: corner.includes("s") ? start.y : start.y + start.height,
        };
        // Raw new dimensions if we ignored aspect lock.
        const rawW = Math.abs(m.x - pinned.x);
        const rawH = Math.abs(m.y - pinned.y);
        // Lock aspect: pick whichever axis demands the larger rect.
        // Rationale: feels like Photoshop's "shift-resize" — corner
        // tracks the further-out axis, the other follows.
        let newW = rawW;
        let newH = rawH;
        if (rawW / aspect > rawH) {
          newH = rawW / aspect;
        } else {
          newW = rawH * aspect;
        }
        // Minimum size guard — 5% of base rect — so the user can't
        // collapse the artwork to a single pixel by accident.
        const minScale = 0.05;
        const baseW = drag.startInfo.base.width;
        const baseH = drag.startInfo.base.height;
        if (newW / baseW < minScale) {
          newW = baseW * minScale;
          newH = baseH * minScale;
        }
        // Recompute the rect from pinned corner + new dims while
        // preserving the original direction (which side of pinned
        // the active corner is on).
        const signX = corner.includes("e") ? 1 : -1;
        const signY = corner.includes("s") ? 1 : -1;
        const activeX = pinned.x + signX * newW;
        const activeY = pinned.y + signY * newH;
        const newCx = (pinned.x + activeX) / 2;
        const newCy = (pinned.y + activeY) / 2;
        const newScale = newW / baseW;
        onChange({
          scale: newScale,
          offsetX: newCx - drag.startInfo.anchor.x,
          offsetY: newCy - drag.startInfo.anchor.y,
        });
      }
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // onChange is intentionally read fresh from closure each move —
    // we wire it via a stable ref above by re-binding the listener
    // on each change. Using state setter from props is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mockupW, mockupH, onChange]);

  if (!info) return null;

  const startDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    mode: "translate" | "scale",
    corner?: "nw" | "ne" | "sw" | "se",
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const canvas = canvasRef.current;
    if (!canvas) return;
    dragRef.current = {
      mode,
      corner,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPlacement: placement,
      startInfo: info,
      canvasRect: canvas.getBoundingClientRect(),
    };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  // Position the rect overlay in % of the canvas display so it
  // tracks correctly even as the modal resizes / the user scrolls.
  const pctRect = {
    left: (info.effective.x / mockupW) * 100,
    top: (info.effective.y / mockupH) * 100,
    width: (info.effective.width / mockupW) * 100,
    height: (info.effective.height / mockupH) * 100,
  };

  const handleSize = 14; // px — fixed visual size regardless of zoom
  const cornerStyle = (
    corner: "nw" | "ne" | "sw" | "se",
  ): React.CSSProperties => {
    const isE = corner.includes("e");
    const isS = corner.includes("s");
    return {
      position: "absolute",
      width: handleSize,
      height: handleSize,
      [isE ? "right" : "left"]: -handleSize / 2,
      [isS ? "bottom" : "top"]: -handleSize / 2,
      cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
    } as React.CSSProperties;
  };

  return (
    <div
      className="pointer-events-none absolute inset-0"
      data-testid="design-rect-overlay"
    >
      <div
        className="pointer-events-auto absolute select-none"
        style={{
          left: `${pctRect.left}%`,
          top: `${pctRect.top}%`,
          width: `${pctRect.width}%`,
          height: `${pctRect.height}%`,
        }}
      >
        {/* Body — drag to translate. Slightly tinted on hover so the
            user can see it's interactive even when the dashed rect
            (drawn into the canvas itself) is the visual anchor. */}
        <div
          onPointerDown={(e) => startDrag(e, "translate")}
          className="absolute inset-0 cursor-move ring-2 ring-fuchsia-300/70 transition hover:bg-fuchsia-500/5"
          style={{ touchAction: "none" }}
          title="Drag to move artwork"
        />
        {/* Four corner handles — uniform aspect-locked scale. */}
        {(["nw", "ne", "sw", "se"] as const).map((c) => (
          <div
            key={c}
            onPointerDown={(e) => startDrag(e, "scale", c)}
            style={{ ...cornerStyle(c), touchAction: "none" }}
            className="rounded-sm border-2 border-fuchsia-200 bg-fuchsia-500/90 shadow-md hover:scale-110"
            title="Drag corner to resize (aspect locked)"
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Sidebar panel for single-sheet mode — exposes per-group placement,
 * seam allowance, lock-ratio, and the active-group selector. Each
 * group has an accordion row that collapses to its summary stats.
 *
 * Edits stay transient (modal-local) until the admin hits "Save as
 * defaults", which calls back into the store to persist the current
 * values onto `template.designGroups`. Reset clears overrides.
 */
function GroupsPanel({
  designGroups,
  view,
  layers,
  activeGroupId,
  onActiveGroupChange,
  getPlacement,
  getSeam,
  getEnabled,
  onPlacementChange,
  onSeamChange,
  onEnabledChange,
  lockRatios,
  onLockToggle,
  onRecaptureRatios,
  hasOverrides,
  onSaveDefaults,
  onResetOverrides,
  showDesignRect,
  onShowDesignRectChange,
}: {
  designGroups: DesignGroup[];
  view: HoodieView;
  layers: import("@shared/hoodieTemplate").MaskLayer[];
  activeGroupId: string | null;
  onActiveGroupChange: (id: string) => void;
  getPlacement: (groupId: string, v: HoodieView) => ArtworkPlacement;
  getSeam: (groupId: string) => number;
  getEnabled: (groupId: string) => boolean;
  onPlacementChange: (groupId: string, patch: Partial<ArtworkPlacement>) => void;
  onSeamChange: (groupId: string, value: number) => void;
  onEnabledChange: (groupId: string, value: boolean) => void;
  lockRatios: boolean;
  onLockToggle: (next: boolean) => void;
  onRecaptureRatios: () => void;
  hasOverrides: boolean;
  onSaveDefaults: () => void;
  onResetOverrides: () => void;
  showDesignRect: boolean;
  onShowDesignRectChange: (v: boolean) => void;
}) {
  // Filter to groups that have at least one traced layer in this
  // view — empty groups would otherwise clutter the UI with unusable
  // sliders.
  const populatedGroups = useMemo(
    () =>
      designGroups.filter((g) =>
        layers.some(
          (l) =>
            l.panelKey &&
            g.panelKeys.includes(l.panelKey) &&
            l.visible &&
            !l.isExclusion,
        ),
      ),
    [designGroups, layers],
  );

  if (populatedGroups.length === 0) {
    return (
      <div className="rounded border border-amber-900/40 bg-amber-950/30 px-2 py-1.5 text-[10px] text-amber-200">
        No traced panels in this view yet — trace polygons in the mapper to enable
        per-group artwork placement.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-slate-400">
          Groups
        </span>
        <ToggleRow
          label="Show rects"
          checked={showDesignRect}
          onChange={onShowDesignRectChange}
        />
      </div>

      {/* Lock-ratio toggle row */}
      <div className="rounded border border-slate-800 bg-slate-950 px-2 py-1.5">
        <label className="flex cursor-pointer items-center justify-between text-[11px]">
          <span className="text-slate-300">Lock group scale ratios</span>
          <input
            type="checkbox"
            checked={lockRatios}
            onChange={(e) => onLockToggle(e.target.checked)}
            className="h-3.5 w-3.5 cursor-pointer accent-fuchsia-500"
          />
        </label>
        {lockRatios && (
          <div className="mt-1 flex items-center justify-between gap-1 text-[10px] text-slate-500">
            <span>Other groups follow this group's scale.</span>
            <button
              type="button"
              onClick={onRecaptureRatios}
              className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
              title="Re-snapshot current scales as the new locked ratios"
            >
              Recapture
            </button>
          </div>
        )}
      </div>

      {/* Per-group accordion */}
      <div className="space-y-1.5">
        {populatedGroups.map((g) => {
          const isActive = g.id === activeGroupId;
          const placement = getPlacement(g.id, view);
          const seam = getSeam(g.id);
          const enabled = getEnabled(g.id);
          // Heuristic: group has L/R seam pair when its panelKeys
          // include any of the known L+R pair members.
          const hasSeam = g.panelKeys.some(
            (k) =>
              k === "front_left" ||
              k === "left_hood" ||
              k === "pocket_left" ||
              k === "front_right" ||
              k === "right_hood" ||
              k === "pocket_right",
          );
          return (
            <div
              key={g.id}
              className={`rounded border ${
                isActive
                  ? "border-fuchsia-500/70 bg-fuchsia-500/5"
                  : "border-slate-800 bg-slate-950"
              }`}
            >
              <button
                type="button"
                onClick={() => onActiveGroupChange(g.id)}
                className="flex w-full items-center justify-between px-2 py-1.5 text-left"
              >
                <span className="text-[12px] font-medium text-slate-200">
                  {g.name}
                </span>
                <span className="font-mono text-[10px] text-slate-400">
                  ×{placement.scale.toFixed(2)}
                </span>
              </button>
              {isActive && (
                <div className="space-y-1 border-t border-slate-800 px-2 pb-2 pt-1">
                  <ToggleRow
                    label="Enabled"
                    checked={enabled}
                    onChange={(v) => onEnabledChange(g.id, v)}
                  />
                  {enabled && (
                    <>
                      <PlacementSlider
                        label="Scale"
                        unit="×"
                        value={placement.scale}
                        min={0.1}
                        max={3}
                        step={0.01}
                        precision={2}
                        onChange={(scale) =>
                          onPlacementChange(g.id, { scale })
                        }
                      />
                      <PlacementSlider
                        label="Offset X"
                        unit="px"
                        value={placement.offsetX}
                        min={-600}
                        max={600}
                        step={1}
                        precision={0}
                        onChange={(offsetX) =>
                          onPlacementChange(g.id, { offsetX })
                        }
                      />
                      <PlacementSlider
                        label="Offset Y"
                        unit="px"
                        value={placement.offsetY}
                        min={-600}
                        max={600}
                        step={1}
                        precision={0}
                        onChange={(offsetY) =>
                          onPlacementChange(g.id, { offsetY })
                        }
                      />
                      {hasSeam && (
                        <PlacementSlider
                          label="Seam allowance"
                          unit="%"
                          value={seam * 100}
                          min={0}
                          max={15}
                          step={0.5}
                          precision={1}
                          onChange={(v) => onSeamChange(g.id, v / 100)}
                        />
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Save / Reset row */}
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="flex-1 text-[11px]"
          onClick={onSaveDefaults}
          disabled={!hasOverrides}
          data-testid="aop-save-defaults"
        >
          Save defaults
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-[11px]"
          onClick={onResetOverrides}
          disabled={!hasOverrides}
          title="Discard modal edits"
        >
          <RotateCcw className="h-3 w-3" />
        </Button>
      </div>
      <div className="text-[10px] text-slate-500">
        Edits stay in this preview until you click Save defaults — that copies the
        current placements / seams / enable flags onto the template so future
        artworks render the same way.
      </div>
    </div>
  );
}

/**
 * Sidebar panel for repeating-tile mode — pattern picker, tile size
 * slider (in real-world inches), and a real-world calibration entry
 * so the slider's "1.5 inches" is physically accurate. Save defaults
 * persists onto template.tileSettings + realWorldCalibration.
 */
function TilePanel({
  tileSettings,
  pixelsPerInch,
  onTileChange,
  onPpiChange,
  onSaveDefaults,
  onResetOverrides,
  hasOverrides,
}: {
  tileSettings: TileSettings;
  pixelsPerInch: number;
  onTileChange: (patch: Partial<TileSettings>) => void;
  onPpiChange: (v: number) => void;
  onSaveDefaults: () => void;
  onResetOverrides: () => void;
  hasOverrides: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-400">
        Tile pattern
      </div>
      <div className="grid grid-cols-3 gap-1">
        {TILE_PATTERN_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => onTileChange({ pattern: opt.id })}
            className={`rounded border px-1.5 py-1 text-[10px] transition ${
              tileSettings.pattern === opt.id
                ? "border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-100"
                : "border-slate-800 bg-slate-950 text-slate-300 hover:bg-slate-800"
            }`}
            data-testid={`tile-pattern-${opt.id}`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <PlacementSlider
        label="Tile size"
        unit='"'
        value={tileSettings.tileSizeInches}
        min={0.25}
        max={6}
        step={0.05}
        precision={2}
        onChange={(v) => onTileChange({ tileSizeInches: v })}
      />
      <div>
        <label className="flex items-center justify-between text-[11px] text-slate-300">
          <span>Calibration</span>
          <span className="font-mono text-[10px] text-slate-400">
            {pixelsPerInch.toFixed(1)} px/in
          </span>
        </label>
        <input
          type="number"
          value={Math.round(pixelsPerInch * 10) / 10}
          step="0.1"
          min="1"
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v) && v > 0) onPpiChange(v);
          }}
          className="mt-1 h-7 w-full rounded border border-slate-700 bg-slate-950 px-2 text-[11px] font-mono text-slate-200 focus:border-fuchsia-500 focus:outline-none"
        />
        <div className="mt-1 text-[10px] text-slate-500">
          Mockup pixels per real inch. Tile size × this number = on-mockup tile
          width. Default assumes a 1024-px mockup represents 24 inches of fabric.
        </div>
      </div>

      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="flex-1 text-[11px]"
          onClick={onSaveDefaults}
          disabled={!hasOverrides}
          data-testid="tile-save-defaults"
        >
          Save defaults
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-[11px]"
          onClick={onResetOverrides}
          disabled={!hasOverrides}
          title="Discard modal edits"
        >
          <RotateCcw className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
