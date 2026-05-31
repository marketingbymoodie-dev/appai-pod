import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Image as ImageIcon,
  Pipette,
  RotateCcw,
  Upload,
  Loader2,
} from "lucide-react";
import {
  defaultDesignGroups,
  type DesignGroup,
  type HoodieTemplate,
  type HoodieView,
} from "@shared/hoodieTemplate";
import {
  renderAopPreview,
  DEFAULT_ARTWORK_PLACEMENT,
  type ArtworkPlacement,
} from "@/components/hoodie-template-mapper/lib/aopPreview";
import DesignRectHandlesOverlay from "@/components/hoodie-template-mapper/DesignRectHandlesOverlay";
import { extractArtworkPalette, type PaletteSwatch } from "./extractPalette";

/**
 * Customer-facing AOP artwork placer.
 *
 * Reuses the live preview / mesh-warp pipeline from the admin
 * `AopPreviewModal` but trims it down to the controls a buyer
 * actually needs:
 *
 *   - Front / Back view switch
 *   - "Hood" + "Front body" group pair, **on by default + linked**.
 *     The user can break the link to position each pair independently.
 *   - "Back body" group, **off by default**. Toggle to turn on.
 *   - Background colour picker + eyedropper + 6 swatches sampled from
 *     the artwork (median-cut palette).
 *   - Drag/resize handles via the shared `DesignRectHandlesOverlay`,
 *     with snap behaviour:
 *       * Front + Hood: X-only (zip / hood-opening seams).
 *       * Back: X + Y (no seam — just centre snap on both axes).
 *   - Disabled "Pattern" tab as a placeholder for Stage 4.
 *
 * Stage 2 lives at `/dev/hoodie-placer` so we can iterate on the
 * standalone component before wiring it into `embed-design.tsx` for
 * product 20 (Stage 3).
 *
 * The component is intentionally **uncontrolled** at the page level:
 * it owns its placement / colour state internally and emits an
 * `onApply` event with the final canvas bitmaps + metadata so the
 * Stage 3 wiring can call the same `panelUrls` upload pipeline the
 * legacy `PatternCustomizer` already uses.
 */

export type HoodieAopPlacerProps = {
  /** Server name of the published template, e.g. `unisex-zip-hoodie-aop-L`. */
  templateName: string;
  /** Initial / restored state, when resuming a customer's design. Optional. */
  initialState?: HoodieAopPlacerState | null;
  /**
   * Optional callback invoked when the customer hits "Apply" — Stage 3
   * will hook this up to the storefront's panel-upload pipeline. The
   * payload exposes the live state plus a synchronous render API so
   * the embed page can grab per-view canvases for upload.
   */
  onApply?: (result: HoodieAopPlacerApplyResult) => void;
  /**
   * Optional callback fired on any state change (debounced by React's
   * batch) — Stage 5 will wire this to designState autosave on the
   * generation job. Safe to omit during Stage 2.
   */
  onChange?: (state: HoodieAopPlacerState) => void;
};

/**
 * Persistable customer state. Stage 5 will save this on
 * `generations.designState` so the customer can resume mid-edit.
 */
export type HoodieAopPlacerState = {
  view: HoodieView;
  /** `null` until the customer uploads or picks an artwork. */
  artworkUrl: string | null;
  /** Per-group placement keyed by group id. */
  placements: Record<string, Record<HoodieView, ArtworkPlacement>>;
  /** Per-group enabled flag. Back is `false` by default. */
  enabled: Record<string, boolean>;
  /** Whether the front + hood pair is currently linked. */
  linkFrontHood: boolean;
  /** Background fill colour (CSS) painted under the artwork. */
  backgroundColor: string;
};

export type HoodieAopPlacerApplyResult = {
  state: HoodieAopPlacerState;
  /** Returns a freshly-rendered front-view canvas at full mockup size. */
  renderView: (view: HoodieView) => HTMLCanvasElement | null;
};

type ApiResponse = {
  name: string;
  template: HoodieTemplate;
  mockups: { front?: string | null; back?: string | null };
  cachedAt: number;
};

const DEFAULT_BG_COLOR = "#FFFFFF";

/** Group ids the customer placer surfaces as toggles in the sidebar. */
const CUSTOMER_GROUP_IDS = ["hood", "front-body", "back-body"] as const;

const GROUP_LABELS: Record<string, string> = {
  hood: "Hood",
  "front-body": "Front body",
  "back-body": "Back body",
};

/**
 * Default state seed. Hood + front body on, back off, hood/front
 * linked. Identity placement on every group.
 */
function buildDefaultState(): HoodieAopPlacerState {
  const placements: Record<string, Record<HoodieView, ArtworkPlacement>> = {};
  const enabled: Record<string, boolean> = {};
  for (const g of defaultDesignGroups()) {
    placements[g.id] = {
      front: { ...DEFAULT_ARTWORK_PLACEMENT },
      back: { ...DEFAULT_ARTWORK_PLACEMENT },
    };
    enabled[g.id] = g.id === "back-body" ? false : g.id !== "trim";
    // Trim and the sleeves can stay on — they pick up the artwork
    // via the legacy ungrouped fallback. The sidebar UI just hides
    // them to keep the customer-facing surface simple.
  }
  return {
    view: "front",
    artworkUrl: null,
    placements,
    enabled,
    linkFrontHood: true,
    backgroundColor: DEFAULT_BG_COLOR,
  };
}

export default function HoodieAopPlacer({
  templateName,
  initialState,
  onApply,
  onChange,
}: HoodieAopPlacerProps) {
  // ---------- Template fetch ----------
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetch(`/api/storefront/hoodie-template/${encodeURIComponent(templateName)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        return r.json();
      })
      .then((j: ApiResponse) => {
        if (cancelled) return;
        setData(j);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e?.message || String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [templateName]);

  // ---------- Mockup + artwork preloading ----------
  const [mockups, setMockups] = useState<Record<HoodieView, HTMLImageElement | null>>(
    { front: null, back: null },
  );
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    const next: Record<HoodieView, HTMLImageElement | null> = { front: null, back: null };
    let remaining = 0;
    (["front", "back"] as HoodieView[]).forEach((v) => {
      const url = data.mockups[v];
      if (!url) return;
      remaining += 1;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        next[v] = img;
        remaining -= 1;
        if (remaining === 0 && !cancelled) setMockups({ ...next });
      };
      img.onerror = () => {
        remaining -= 1;
        if (remaining === 0 && !cancelled) setMockups({ ...next });
      };
      img.src = url;
    });
    return () => {
      cancelled = true;
    };
  }, [data]);

  // ---------- Customer state ----------
  const [state, setState] = useState<HoodieAopPlacerState>(
    () => initialState ?? buildDefaultState(),
  );

  // Apply incoming initialState if it changes (e.g. resume edit).
  useEffect(() => {
    if (initialState) setState(initialState);
  }, [initialState]);

  // Notify parent of state changes.
  useEffect(() => {
    onChange?.(state);
  }, [state, onChange]);

  const [artworkImg, setArtworkImg] = useState<HTMLImageElement | null>(null);
  const [artworkLoading, setArtworkLoading] = useState(false);
  const [palette, setPalette] = useState<PaletteSwatch[]>([]);
  useEffect(() => {
    if (!state.artworkUrl) {
      setArtworkImg(null);
      setPalette([]);
      return;
    }
    let cancelled = false;
    setArtworkLoading(true);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      setArtworkImg(img);
      setArtworkLoading(false);
      // Palette extraction is sync but not free — defer to next tick
      // so we don't block the render-after-load animation.
      requestAnimationFrame(() => {
        if (cancelled) return;
        try {
          setPalette(extractArtworkPalette(img, 6));
        } catch {
          setPalette([]);
        }
      });
    };
    img.onerror = () => {
      if (!cancelled) {
        setArtworkImg(null);
        setArtworkLoading(false);
        setPalette([]);
      }
    };
    img.src = state.artworkUrl;
    return () => {
      cancelled = true;
    };
  }, [state.artworkUrl]);

  // ---------- Active group selection ----------
  // The drag overlay needs a single active group. We pick the first
  // enabled customer group, preferring the hood/front pair so the
  // most likely target is selected by default.
  const [activeGroupId, setActiveGroupId] = useState<string>("front-body");
  useEffect(() => {
    // If the active group gets disabled, hop to the next enabled
    // customer-visible group so the overlay stays meaningful.
    if (!state.enabled[activeGroupId]) {
      const fallback = CUSTOMER_GROUP_IDS.find((id) => state.enabled[id]);
      if (fallback && fallback !== activeGroupId) {
        setActiveGroupId(fallback);
      }
    }
  }, [state.enabled, activeGroupId]);

  // ---------- Canvas rendering ----------
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!data) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const mockup = mockups[state.view];
    if (!mockup) return;
    canvas.width = mockup.naturalWidth || mockup.width;
    canvas.height = mockup.naturalHeight || mockup.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    renderAopPreview(ctx, {
      template: data.template,
      view: state.view,
      mockup,
      artwork: artworkImg,
      mode: "single-sheet",
      showExclusions: true,
      showOutlines: false,
      showLabels: false,
      applyShading: true,
      groupPlacementOverrides: state.placements,
      groupEnabledOverrides: state.enabled,
      activeGroupId: artworkImg ? activeGroupId : null,
      backgroundColor: state.backgroundColor,
    });
  }, [data, mockups, state, artworkImg, activeGroupId]);

  // ---------- Helpers ----------
  const updatePlacement = useCallback(
    (groupId: string, view: HoodieView, next: ArtworkPlacement) => {
      setState((prev) => {
        const placements: Record<string, Record<HoodieView, ArtworkPlacement>> = {
          ...prev.placements,
          [groupId]: { ...(prev.placements[groupId] ?? {}), [view]: next } as Record<
            HoodieView,
            ArtworkPlacement
          >,
        };
        // Front/hood link: when linked, scale + offset propagate
        // between the pair on the *current* view only. Back-view
        // placements stay independent so customers can park the
        // back artwork where they want it without front edits
        // dragging it around.
        if (
          prev.linkFrontHood &&
          (groupId === "hood" || groupId === "front-body")
        ) {
          const partner = groupId === "hood" ? "front-body" : "hood";
          const partnerPrev =
            prev.placements[partner]?.[view] ?? { ...DEFAULT_ARTWORK_PLACEMENT };
          placements[partner] = {
            ...(prev.placements[partner] ?? {}),
            [view]: {
              ...partnerPrev,
              scale: next.scale,
              offsetX: next.offsetX,
              offsetY: next.offsetY,
            },
          } as Record<HoodieView, ArtworkPlacement>;
        }
        return { ...prev, placements };
      });
    },
    [],
  );

  const setEnabled = useCallback((groupId: string, on: boolean) => {
    setState((prev) => ({
      ...prev,
      enabled: { ...prev.enabled, [groupId]: on },
    }));
  }, []);

  const setView = useCallback((v: HoodieView) => {
    setState((prev) => ({ ...prev, view: v }));
  }, []);

  const setBgColor = useCallback((hex: string) => {
    setState((prev) => ({ ...prev, backgroundColor: hex }));
  }, []);

  const toggleLink = useCallback(() => {
    setState((prev) => {
      // When re-linking, snap the partner's current placement to
      // the active one so the customer sees the pair "click together"
      // visually instead of a confusing pop.
      const next = { ...prev, linkFrontHood: !prev.linkFrontHood };
      if (next.linkFrontHood) {
        const v = prev.view;
        const source =
          activeGroupId === "hood" || activeGroupId === "front-body"
            ? activeGroupId
            : "front-body";
        const target = source === "hood" ? "front-body" : "hood";
        const sourceP = prev.placements[source]?.[v] ?? DEFAULT_ARTWORK_PLACEMENT;
        next.placements = {
          ...prev.placements,
          [target]: {
            ...(prev.placements[target] ?? {}),
            [v]: { ...sourceP },
          } as Record<HoodieView, ArtworkPlacement>,
        };
      }
      return next;
    });
  }, [activeGroupId]);

  const handleArtworkUpload = (file: File) => {
    const url = URL.createObjectURL(file);
    setState((prev) => {
      // Revoke any previous blob URL we created so we don't leak
      // memory across uploads.
      if (prev.artworkUrl?.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(prev.artworkUrl);
        } catch {
          /* ignore */
        }
      }
      return { ...prev, artworkUrl: url };
    });
  };

  const resetPlacement = useCallback(() => {
    setState((prev) => {
      const placements: Record<string, Record<HoodieView, ArtworkPlacement>> = {};
      for (const id of Object.keys(prev.placements)) {
        placements[id] = {
          front: { ...DEFAULT_ARTWORK_PLACEMENT },
          back: { ...DEFAULT_ARTWORK_PLACEMENT },
        };
      }
      return { ...prev, placements };
    });
  }, []);

  const triggerEyedropper = useCallback(async () => {
    const W = window as any;
    if (!W.EyeDropper) return;
    try {
      const ed = new W.EyeDropper();
      const r = await ed.open();
      if (r?.sRGBHex) setBgColor(r.sRGBHex);
    } catch {
      /* user cancelled — ignore */
    }
  }, [setBgColor]);

  // ---------- Snap mode for active group ----------
  const snapMode: "seam" | "x" | "y" | "both" | "none" = useMemo(() => {
    if (activeGroupId === "back-body") return "both";
    return "seam";
  }, [activeGroupId]);

  // ---------- Apply hand-off (Stage 3 will subscribe) ----------
  const renderViewToCanvas = useCallback(
    (v: HoodieView): HTMLCanvasElement | null => {
      if (!data) return null;
      const mockup = mockups[v];
      if (!mockup) return null;
      const c = document.createElement("canvas");
      c.width = mockup.naturalWidth || mockup.width;
      c.height = mockup.naturalHeight || mockup.height;
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      renderAopPreview(ctx, {
        template: data.template,
        view: v,
        mockup,
        artwork: artworkImg,
        mode: "single-sheet",
        showExclusions: true,
        applyShading: true,
        groupPlacementOverrides: state.placements,
        groupEnabledOverrides: state.enabled,
        backgroundColor: state.backgroundColor,
      });
      return c;
    },
    [data, mockups, artworkImg, state],
  );

  const handleApply = useCallback(() => {
    onApply?.({
      state,
      renderView: renderViewToCanvas,
    });
  }, [onApply, state, renderViewToCanvas]);

  // ---------- Render ----------
  if (loading) {
    return (
      <div className="flex h-[400px] items-center justify-center text-sm text-slate-400">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading template…
      </div>
    );
  }
  if (loadError || !data) {
    return (
      <div className="flex h-[400px] flex-col items-center justify-center gap-2 rounded border border-rose-700/50 bg-rose-950/40 p-6 text-sm text-rose-200">
        <div className="font-medium">Couldn't load template</div>
        <div className="text-xs text-rose-300/80">{loadError ?? "unknown error"}</div>
      </div>
    );
  }

  const groups: DesignGroup[] =
    data.template.designGroups ?? defaultDesignGroups();
  const visibleGroups = CUSTOMER_GROUP_IDS.map((id) =>
    groups.find((g) => g.id === id),
  ).filter((g): g is DesignGroup => Boolean(g));
  const mockup = mockups[state.view];
  const showOverlay =
    !!mockup &&
    !!artworkImg &&
    state.enabled[activeGroupId] &&
    !(state.view === "back" && activeGroupId === "hood");
  const placement =
    state.placements[activeGroupId]?.[state.view] ?? DEFAULT_ARTWORK_PLACEMENT;

  return (
    <div className="flex w-full flex-col gap-4 lg:flex-row">
      {/* Left: live mockup with overlay */}
      <div className="relative flex-1 overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
        <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
          <div role="tablist" className="flex gap-1">
            {(["front", "back"] as HoodieView[]).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={state.view === v}
                onClick={() => setView(v)}
                className={`rounded px-3 py-1 text-xs font-medium transition ${
                  state.view === v
                    ? "bg-fuchsia-600 text-white"
                    : "bg-slate-900 text-slate-300 hover:bg-slate-800"
                }`}
              >
                {v === "front" ? "Front" : "Back"}
              </button>
            ))}
            <button
              disabled
              className="rounded px-3 py-1 text-xs font-medium text-slate-500 cursor-not-allowed"
              title="Repeating-pattern mode coming soon"
            >
              Pattern (soon)
            </button>
          </div>
          <button
            onClick={resetPlacement}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
          >
            <RotateCcw className="h-3 w-3" /> Reset placement
          </button>
        </div>
        <div className="relative flex aspect-square items-center justify-center bg-black p-4">
          <div className="relative max-h-full max-w-full">
            <canvas
              ref={canvasRef}
              className="max-h-[70vh] max-w-full rounded object-contain"
              data-testid="hoodie-aop-placer-canvas"
            />
            {showOverlay && mockup && artworkImg && (
              <DesignRectHandlesOverlay
                canvasRef={canvasRef}
                template={data.template}
                view={state.view}
                mockup={mockup}
                artwork={artworkImg}
                groupId={activeGroupId}
                placement={placement}
                placementOverrides={state.placements}
                enabledOverrides={state.enabled}
                snapMode={snapMode}
                onChange={(next) =>
                  updatePlacement(activeGroupId, state.view, next)
                }
              />
            )}
            {!artworkImg && !artworkLoading && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-xs text-slate-400">
                Upload an artwork on the right to start placing it →
              </div>
            )}
            {artworkLoading && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-slate-400">
                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Loading artwork…
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right: controls */}
      <div className="w-full shrink-0 space-y-4 lg:w-80">
        {/* Artwork upload */}
        <Section title="Artwork">
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded border border-dashed border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-200 hover:border-fuchsia-500/60 hover:bg-slate-900">
            <Upload className="h-4 w-4" />
            {state.artworkUrl ? "Replace artwork" : "Upload artwork"}
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleArtworkUpload(f);
                e.target.value = "";
              }}
            />
          </label>
          {state.artworkUrl && (
            <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-400">
              <ImageIcon className="h-3 w-3" />
              <span className="truncate">Loaded</span>
            </div>
          )}
        </Section>

        {/* Background colour */}
        <Section title="Background colour">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={state.backgroundColor}
              onChange={(e) => setBgColor(e.target.value)}
              className="h-8 w-10 cursor-pointer rounded border border-slate-700 bg-slate-900"
              aria-label="Background colour"
            />
            <input
              type="text"
              value={state.backgroundColor}
              onChange={(e) => setBgColor(e.target.value)}
              className="h-8 flex-1 rounded border border-slate-700 bg-slate-900 px-2 text-xs text-slate-200"
              spellCheck={false}
            />
            {typeof window !== "undefined" && "EyeDropper" in window && (
              <button
                onClick={triggerEyedropper}
                className="flex h-8 w-8 items-center justify-center rounded border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
                title="Pick a colour from anywhere on screen"
                aria-label="Eyedropper"
              >
                <Pipette className="h-4 w-4" />
              </button>
            )}
          </div>
          {palette.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
                Suggested from artwork
              </div>
              <div className="flex flex-wrap gap-1.5">
                {palette.map((s) => (
                  <button
                    key={s.hex}
                    onClick={() => setBgColor(s.hex)}
                    title={s.hex}
                    aria-label={`Use ${s.hex} as background`}
                    className={`h-6 w-6 rounded border-2 transition ${
                      state.backgroundColor.toUpperCase() === s.hex.toUpperCase()
                        ? "border-fuchsia-400 ring-2 ring-fuchsia-500/40"
                        : "border-slate-700 hover:border-slate-500"
                    }`}
                    style={{ backgroundColor: s.hex }}
                  />
                ))}
              </div>
            </div>
          )}
        </Section>

        {/* Group toggles */}
        <Section title="Panels">
          <div className="space-y-2">
            {visibleGroups.map((g) => {
              const on = !!state.enabled[g.id];
              const isActive = activeGroupId === g.id;
              const showLink = g.id === "hood" || g.id === "front-body";
              return (
                <div
                  key={g.id}
                  className={`rounded border p-2 transition ${
                    isActive
                      ? "border-fuchsia-500/60 bg-fuchsia-950/20"
                      : "border-slate-800 bg-slate-900/50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={() => on && setActiveGroupId(g.id)}
                      disabled={!on}
                      className="flex-1 text-left text-xs font-medium text-slate-200 disabled:text-slate-500"
                    >
                      {GROUP_LABELS[g.id] ?? g.name}
                    </button>
                    <label className="flex cursor-pointer items-center gap-1 text-[10px] text-slate-400">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => setEnabled(g.id, e.target.checked)}
                      />
                      On
                    </label>
                  </div>
                  {showLink && (
                    <label className="mt-1 flex cursor-pointer items-center gap-1 text-[10px] text-slate-400">
                      <input
                        type="checkbox"
                        checked={state.linkFrontHood}
                        onChange={toggleLink}
                      />
                      Link with {g.id === "hood" ? "front body" : "hood"}
                    </label>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-2 text-[10px] leading-snug text-slate-500">
            Click a panel name to make its drag-handle active. Hood + front body
            stay locked together by default — uncheck "Link" to move them
            separately.
          </div>
        </Section>

        {onApply && (
          <button
            onClick={handleApply}
            disabled={!artworkImg}
            className="w-full rounded bg-fuchsia-600 px-3 py-2 text-sm font-medium text-white shadow hover:bg-fuchsia-500 disabled:opacity-50"
          >
            Apply to product
          </button>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900/30 p-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-300">
        {title}
      </div>
      {children}
    </div>
  );
}
