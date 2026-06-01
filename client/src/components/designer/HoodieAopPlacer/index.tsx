import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pipette, RotateCcw, Upload, Loader2, Link2, Link2Off } from "lucide-react";
import {
  defaultDesignGroups,
  type DesignGroup,
  type HoodieTemplate,
  type HoodieView,
  type TileSettings,
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
 * The middle control column mirrors the legacy `PatternCustomizer`'s order
 * so customers see a familiar layout when we swap this in for product 20:
 *
 *   1. Place / Pattern segmented control
 *   2. Scale slider (drives the active group)
 *   3. View row: Front / Back / Hood
 *   4. Artwork Enabled (per-active-group)
 *   5. Background colour + eyedropper + 6 swatches (4 from artwork + B & W)
 *   6. Reset
 *
 * View row notes:
 *   - `Front` and `Back` switch the canvas view.
 *   - `Hood` is **not** a separate view (the hood is rendered on both Front
 *     and Back). Tapping `Hood` selects the hood group as the active scale /
 *     enable target and toggles its link state with the front body. While
 *     linked, hood placement mirrors front-body placement (admin default).
 *     Unlinked, the customer can drag/scale the hood independently.
 *
 * Snap behaviour (3 px):
 *   - Front / Hood (seam-anchored)  → X-only.
 *   - Back (centroid-anchored)      → X + Y.
 *
 * Stage 2 lives at `/dev/hoodie-placer` so we can iterate before wiring it
 * into `embed-design.tsx` for product 20 (Stage 3).
 */

export type HoodieAopPlacerProps = {
  /** Server name of the published template, e.g. `unisex-zip-hoodie-aop-L`. */
  templateName: string;
  /** Initial / restored state, when resuming a customer's design. Optional. */
  initialState?: HoodieAopPlacerState | null;
  onApply?: (result: HoodieAopPlacerApplyResult) => void;
  onChange?: (state: HoodieAopPlacerState) => void;
};

/**
 * Persistable customer state. Stage 5 will save this on
 * `generations.designState` so the customer can resume mid-edit.
 */
export type HoodieAopPlacerState = {
  /** "place" = single-sheet drag/scale, "pattern" = repeating tile. */
  mode: "place" | "pattern";
  /** Currently visible view (Front / Back). */
  view: HoodieView;
  /** Currently active design group — what Scale & Enabled act on. */
  activeGroupId: string;
  /** `null` until the customer uploads or picks an artwork. */
  artworkUrl: string | null;
  /** Per-group placement keyed by group id. */
  placements: Record<string, Record<HoodieView, ArtworkPlacement>>;
  /** Per-group enabled flag. */
  enabled: Record<string, boolean>;
  /**
   * Customer-level "Trim on/off" — fills cuffs + waistband with just the
   * background colour (no artwork) when `false`. Cuffs live inside the
   * sleeve groups in the admin schema, so this is implemented as a
   * panel-key override at render time rather than a group toggle.
   */
  trimEnabled: boolean;
  /**
   * Customer-level "Pockets on/off" — fills the kangaroo pocket and the
   * pocket halves with background only when `false`. Same panel-key
   * override mechanism as `trimEnabled`.
   */
  pocketsEnabled: boolean;
  /** Whether the hood group's placement is linked to the front body. */
  hoodLinked: boolean;
  /** Background fill colour (CSS) painted under the artwork. */
  backgroundColor: string;
  /** Tile settings (pattern mode). Falls back to template defaults. */
  tileSettings: TileSettings;
};

/** Panel keys treated as "Trim" by the customer toggle. */
const TRIM_PANEL_KEYS = ["waistband", "left_cuff", "right_cuff"] as const;
/** Panel keys treated as "Pockets" by the customer toggle. */
const POCKET_PANEL_KEYS = ["pocket_left", "pocket_right", "front_pocket"] as const;

/**
 * Build the `panelEnabledOverrides` map the renderer expects from the
 * placer's customer-level Trim / Pockets toggles. Only emits explicit
 * `false` values when a toggle is off — leaves untouched panels alone
 * so the renderer can fall back to its group-level decisions.
 */
function buildPanelOverrides(
  state: HoodieAopPlacerState,
): Partial<Record<string, boolean>> {
  const out: Partial<Record<string, boolean>> = {};
  if (!state.trimEnabled) {
    for (const k of TRIM_PANEL_KEYS) out[k] = false;
  }
  if (!state.pocketsEnabled) {
    for (const k of POCKET_PANEL_KEYS) out[k] = false;
  }
  return out;
}

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
const ARTWORK_PALETTE_COUNT = 4;
const FIXED_PALETTE: PaletteSwatch[] = [
  { hex: "#000000", weight: 0 },
  { hex: "#FFFFFF", weight: 0 },
];

const SCALE_MIN = 0.2;
const SCALE_MAX = 2.5;
const TILE_SIZE_MIN = 0.5;
const TILE_SIZE_MAX = 8;

const TILE_PATTERN_OPTIONS: Array<{
  id: TileSettings["pattern"];
  label: string;
}> = [
  { id: "grid", label: "Grid" },
  { id: "brick", label: "Brick" },
  { id: "half-drop", label: "Offset" },
];

/**
 * Build the customer state from a fetched template + (optional) saved
 * customer state. Inherits the admin's per-group defaults (placement,
 * enabled, locked-ratio) so the placer opens with the layout the admin
 * has dialed in.
 */
function buildInitialState(
  template: HoodieTemplate,
  saved?: HoodieAopPlacerState | null,
): HoodieAopPlacerState {
  const groups = template.designGroups ?? defaultDesignGroups();
  const placements: Record<string, Record<HoodieView, ArtworkPlacement>> = {};
  const enabled: Record<string, boolean> = {};
  for (const g of groups) {
    placements[g.id] = {
      front: { ...(g.placement?.front ?? DEFAULT_ARTWORK_PLACEMENT) },
      back: { ...(g.placement?.back ?? DEFAULT_ARTWORK_PLACEMENT) },
    };
    // Admin's default. Customer can flip these via "Artwork enabled".
    enabled[g.id] = g.id === "back-body" ? false : g.enabled !== false;
  }
  const base: HoodieAopPlacerState = {
    mode: "place",
    view: "front",
    activeGroupId: "front-body",
    artworkUrl: null,
    placements,
    enabled,
    trimEnabled: true,
    pocketsEnabled: true,
    hoodLinked: true,
    backgroundColor: DEFAULT_BG_COLOR,
    tileSettings: template.tileSettings ?? { pattern: "grid", tileSizeInches: 1.5 },
  };
  if (!saved) return base;
  // Merge saved customer state onto the template defaults so any new groups
  // the admin adds later still appear, while customer customisations win.
  return {
    ...base,
    ...saved,
    placements: { ...base.placements, ...(saved.placements ?? {}) },
    enabled: { ...base.enabled, ...(saved.enabled ?? {}) },
    tileSettings: { ...base.tileSettings, ...(saved.tileSettings ?? {}) },
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

  // ---------- Mockup preloading ----------
  const [mockups, setMockups] = useState<Record<HoodieView, HTMLImageElement | null>>({
    front: null,
    back: null,
  });
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

  // ---------- Customer state (derived once template is in) ----------
  const [state, setState] = useState<HoodieAopPlacerState | null>(null);
  useEffect(() => {
    if (!data) return;
    setState((prev) => {
      // First load → seed from template + optional saved state.
      if (!prev) return buildInitialState(data.template, initialState);
      return prev;
    });
    // initialState is intentionally only consumed on first seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Notify parent of state changes.
  useEffect(() => {
    if (state) onChange?.(state);
  }, [state, onChange]);

  const [artworkImg, setArtworkImg] = useState<HTMLImageElement | null>(null);
  const [artworkLoading, setArtworkLoading] = useState(false);
  const [palette, setPalette] = useState<PaletteSwatch[]>([]);
  useEffect(() => {
    const url = state?.artworkUrl ?? null;
    if (!url) {
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
      requestAnimationFrame(() => {
        if (cancelled) return;
        try {
          setPalette(extractArtworkPalette(img, ARTWORK_PALETTE_COUNT));
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
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [state?.artworkUrl]);

  // ---------- Canvas rendering ----------
  // The renderer reads `state.placements` directly — each group keeps its
  // own admin-saved placement at all times. The hood-link state only
  // determines how *future* edits propagate (delta-based, see
  // `propagateLinkedDelta`), so at render time we don't synthesise any
  // overrides for "linked". This preserves admin-tuned hood scale /
  // offset values that are deliberately different from front-body.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!data || !state) return;
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
      mode: state.mode === "pattern" ? "tile" : "single-sheet",
      showExclusions: true,
      applyShading: true,
      // Customer placer wants "no artwork = plain hoodie", not the
      // admin debug-colour fill that the renderer defaults to.
      solidColorFallback: false,
      groupPlacementOverrides: state.placements,
      groupEnabledOverrides: state.enabled,
      panelEnabledOverrides: buildPanelOverrides(state),
      activeGroupId: state.mode === "place" && artworkImg ? state.activeGroupId : null,
      backgroundColor: state.backgroundColor,
      tileSettings: state.tileSettings,
      pixelsPerInch: data.template.realWorldCalibration?.pixelsPerInch,
    });
  }, [data, state, mockups, artworkImg]);

  // ---------- Helpers ----------

  /**
   * Propagate a placement change from `groupId` to its hood-link partner
   * when linked. Uses **deltas** (translation) and **ratios** (scale) so
   * the admin's saved offset and scale relationship is preserved.
   *
   * Example: admin saves hood scale=1.25 (anchored 91 px down on the hood
   * panels) and front-body scale=1.00 (anchored on the chest). Linked
   * means dragging front-body 30 px right also moves hood 30 px right,
   * and scaling front-body to 1.20 scales hood to 1.50 (×1.25 ratio
   * preserved). Hood does NOT inherit front-body's absolute placement.
   */
  function propagateLinkedDelta(
    placements: Record<string, Record<HoodieView, ArtworkPlacement>>,
    sourceId: string,
    view: HoodieView,
    prevSource: ArtworkPlacement,
    nextSource: ArtworkPlacement,
  ): Record<string, Record<HoodieView, ArtworkPlacement>> {
    if (sourceId !== "hood" && sourceId !== "front-body") return placements;
    if (view !== "front") return placements;
    const partner = sourceId === "hood" ? "front-body" : "hood";
    const partnerCur = placements[partner]?.front ?? DEFAULT_ARTWORK_PLACEMENT;
    const dx = nextSource.offsetX - prevSource.offsetX;
    const dy = nextSource.offsetY - prevSource.offsetY;
    const ratio = prevSource.scale > 0 ? nextSource.scale / prevSource.scale : 1;
    return {
      ...placements,
      [partner]: {
        ...(placements[partner] ?? {}),
        front: {
          scale: partnerCur.scale * ratio,
          offsetX: partnerCur.offsetX + dx,
          offsetY: partnerCur.offsetY + dy,
        },
      } as Record<HoodieView, ArtworkPlacement>,
    };
  }

  const updatePlacement = useCallback(
    (groupId: string, view: HoodieView, next: ArtworkPlacement) => {
      setState((prev) => {
        if (!prev) return prev;
        const prevForGroup = prev.placements[groupId]?.[view] ?? DEFAULT_ARTWORK_PLACEMENT;
        let placements: Record<string, Record<HoodieView, ArtworkPlacement>> = {
          ...prev.placements,
          [groupId]: {
            ...(prev.placements[groupId] ?? {}),
            [view]: next,
          } as Record<HoodieView, ArtworkPlacement>,
        };
        if (prev.hoodLinked) {
          placements = propagateLinkedDelta(
            placements,
            groupId,
            view,
            prevForGroup,
            next,
          );
        }
        return { ...prev, placements };
      });
    },
    [],
  );

  const setMode = useCallback((mode: "place" | "pattern") => {
    setState((prev) => (prev ? { ...prev, mode } : prev));
  }, []);

  /**
   * View-row button handler. Each button always sets BOTH the visible
   * view and the active group to a deterministic value, so the customer
   * never gets stuck unable to switch back to e.g. front-body after
   * picking hood (previous bug: clicking Front while hood was active
   * preserved hood as the active group, leaving no path back).
   */
  const setView = useCallback((view: HoodieView) => {
    setState((prev) => {
      if (!prev) return prev;
      const activeGroupId = view === "back" ? "back-body" : "front-body";
      return { ...prev, view, activeGroupId };
    });
  }, []);

  /**
   * Hood button handler. Tap-and-tap-again pattern surfaced through the
   * tooltip:
   *   - 1st tap (when hood not active): select hood as the active group
   *     so the Scale slider drives it. View clamps to front because the
   *     hood drag handles only render on the front view (the back hood
   *     inherits via the flat-panel bridge — no draggable equivalent).
   *   - 2nd tap (already on hood): toggle the link with front-body.
   *     Linked = future edits propagate as deltas + ratios; the original
   *     admin-tuned hood placement stays intact.
   */
  const onHoodButton = useCallback(() => {
    setState((prev) => {
      if (!prev) return prev;
      const view: HoodieView = "front";
      if (prev.activeGroupId !== "hood") {
        return { ...prev, view, activeGroupId: "hood" };
      }
      return { ...prev, view, hoodLinked: !prev.hoodLinked };
    });
  }, []);

  const setEnabled = useCallback((groupId: string, on: boolean) => {
    setState((prev) =>
      prev ? { ...prev, enabled: { ...prev.enabled, [groupId]: on } } : prev,
    );
  }, []);

  const setBgColor = useCallback((hex: string) => {
    setState((prev) => (prev ? { ...prev, backgroundColor: hex } : prev));
  }, []);

  const setActiveScale = useCallback(
    (groupId: string, view: HoodieView, scale: number) => {
      setState((prev) => {
        if (!prev) return prev;
        const cur = prev.placements[groupId]?.[view] ?? DEFAULT_ARTWORK_PLACEMENT;
        const next: ArtworkPlacement = { ...cur, scale };
        let placements: Record<string, Record<HoodieView, ArtworkPlacement>> = {
          ...prev.placements,
          [groupId]: {
            ...(prev.placements[groupId] ?? {}),
            [view]: next,
          } as Record<HoodieView, ArtworkPlacement>,
        };
        if (prev.hoodLinked) {
          placements = propagateLinkedDelta(placements, groupId, view, cur, next);
        }
        return { ...prev, placements };
      });
    },
    [],
  );

  const handleArtworkUpload = (file: File) => {
    const url = URL.createObjectURL(file);
    setState((prev) => {
      if (!prev) return prev;
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

  const resetAll = useCallback(() => {
    if (!data) return;
    setState((prev) => {
      if (!prev) return prev;
      const fresh = buildInitialState(data.template, null);
      // Preserve the things customers expect to survive a reset:
      // their uploaded artwork, BG colour, mode, view, tile settings.
      return {
        ...fresh,
        artworkUrl: prev.artworkUrl,
        backgroundColor: prev.backgroundColor,
        mode: prev.mode,
        view: prev.view,
        tileSettings: prev.tileSettings,
      };
    });
  }, [data]);

  const setTileSettings = useCallback((patch: Partial<TileSettings>) => {
    setState((prev) =>
      prev ? { ...prev, tileSettings: { ...prev.tileSettings, ...patch } } : prev,
    );
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

  // ---------- Apply hand-off (Stage 3 will subscribe) ----------
  const renderViewToCanvas = useCallback(
    (v: HoodieView): HTMLCanvasElement | null => {
      if (!data || !state) return null;
      const mockup = mockups[v];
      if (!mockup) return null;
      const c = document.createElement("canvas");
      c.width = mockup.naturalWidth || mockup.width;
      c.height = mockup.naturalHeight || mockup.height;
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      // Each group keeps its own admin-tuned placement (hood-link only
      // affects how *future* edits propagate); pass `state.placements`
      // through verbatim so export matches the live preview pixel-for-pixel.
      renderAopPreview(ctx, {
        template: data.template,
        view: v,
        mockup,
        artwork: artworkImg,
        mode: state.mode === "pattern" ? "tile" : "single-sheet",
        showExclusions: true,
        applyShading: true,
        solidColorFallback: false,
        groupPlacementOverrides: state.placements,
        groupEnabledOverrides: state.enabled,
        panelEnabledOverrides: buildPanelOverrides(state),
        backgroundColor: state.backgroundColor,
        tileSettings: state.tileSettings,
        pixelsPerInch: data.template.realWorldCalibration?.pixelsPerInch,
      });
      return c;
    },
    [data, state, mockups, artworkImg],
  );

  const handleApply = useCallback(() => {
    if (!state) return;
    onApply?.({ state, renderView: renderViewToCanvas });
  }, [onApply, state, renderViewToCanvas]);

  // ---------- Render guards ----------
  if (loading || !state) {
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

  // ---------- Derived UI state ----------
  const groups: DesignGroup[] = data.template.designGroups ?? defaultDesignGroups();
  const activeGroup = groups.find((g) => g.id === state.activeGroupId);
  const mockup = mockups[state.view];
  const placement =
    state.placements[state.activeGroupId]?.[state.view] ?? DEFAULT_ARTWORK_PLACEMENT;
  const showOverlay =
    !!mockup &&
    !!artworkImg &&
    state.mode === "place" &&
    !!state.enabled[state.activeGroupId] &&
    // Hood handles only render on front view (back hood inherits via the
    // flat-panel bridge, no draggable equivalent).
    !(state.view === "back" && state.activeGroupId === "hood");
  const snapMode: "seam" | "x" | "y" | "both" | "none" =
    state.activeGroupId === "back-body" ? "both" : "seam";

  // Hood button: clicking the active hood group toggles link state. While
  // hood is active and unlinked, the customer can drag/scale it freely.
  const hoodSelected = state.activeGroupId === "hood";
  const hoodTooltip = state.hoodLinked
    ? hoodSelected
      ? "Hood linked to front — click again to unlink"
      : "Hood is linked to the front body. Click to edit independently."
    : "Hood unlinked — click again to relink to front body.";

  // Six swatches: 4 from artwork, plus black + white.
  const swatches: PaletteSwatch[] = [
    ...palette.slice(0, ARTWORK_PALETTE_COUNT),
    ...FIXED_PALETTE,
  ];

  return (
    <div className="flex w-full flex-col gap-4 lg:flex-row">
      {/* Left: live mockup with overlay */}
      <div className="relative flex-1 overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
        <div className="relative flex aspect-square items-center justify-center bg-black p-4">
          <div className="relative max-h-full max-w-full">
            <canvas
              ref={canvasRef}
              className="max-h-[78vh] max-w-full rounded object-contain"
              data-testid="hoodie-aop-placer-canvas"
            />
            {showOverlay && mockup && artworkImg && (
              <DesignRectHandlesOverlay
                canvasRef={canvasRef}
                template={data.template}
                view={state.view}
                mockup={mockup}
                artwork={artworkImg}
                groupId={state.activeGroupId}
                placement={placement}
                placementOverrides={state.placements}
                enabledOverrides={state.enabled}
                snapMode={snapMode}
                onChange={(next) =>
                  updatePlacement(state.activeGroupId, state.view, next)
                }
              />
            )}
            {!artworkImg && !artworkLoading && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-xs text-slate-400">
                Upload an artwork to start placing it →
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

      {/* Right: controls (mirrors legacy customizer's middle-column order) */}
      <div className="w-full shrink-0 space-y-4 lg:w-80">
        {/* Pattern / Place segmented toggle */}
        <div className="grid grid-cols-2 overflow-hidden rounded-md border border-slate-700 bg-slate-900">
          {(["pattern", "place"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-3 py-2 text-xs font-medium transition ${
                state.mode === m
                  ? "bg-slate-100 text-slate-900"
                  : "text-slate-300 hover:bg-slate-800"
              }`}
            >
              {m === "pattern" ? "Pattern" : "Place on item"}
            </button>
          ))}
        </div>

        {/* Artwork upload (separate row since legacy assumes art is already chosen) */}
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
        </Section>

        {/* PLACE mode: Scale slider drives active group */}
        {state.mode === "place" && (
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-300">
              <span>Artwork scale</span>
              <span className="text-slate-400">{Math.round(placement.scale * 100)}%</span>
            </div>
            <input
              type="range"
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={0.01}
              value={placement.scale}
              onChange={(e) =>
                setActiveScale(state.activeGroupId, state.view, Number(e.target.value))
              }
              className="w-full accent-fuchsia-500"
              aria-label="Artwork scale"
            />
            <div className="mt-1 text-[10px] text-slate-500">
              Adjusting <span className="text-slate-300">{activeGroup?.name ?? state.activeGroupId}</span>
              {state.hoodLinked && (state.activeGroupId === "hood" || state.activeGroupId === "front-body") && (
                <> • linked with {state.activeGroupId === "hood" ? "front body" : "hood"}</>
              )}
            </div>
          </div>
        )}

        {/* PATTERN mode: tile-size slider + pattern style */}
        {state.mode === "pattern" && (
          <>
            <div>
              <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-300">
                <span>Tile size</span>
                <span className="text-slate-400">
                  {state.tileSettings.tileSizeInches.toFixed(1)}″
                </span>
              </div>
              <input
                type="range"
                min={TILE_SIZE_MIN}
                max={TILE_SIZE_MAX}
                step={0.1}
                value={state.tileSettings.tileSizeInches}
                onChange={(e) =>
                  setTileSettings({ tileSizeInches: Number(e.target.value) })
                }
                className="w-full accent-fuchsia-500"
                aria-label="Tile size"
              />
            </div>
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-300">
                Pattern
              </div>
              <div className="grid grid-cols-3 overflow-hidden rounded-md border border-slate-700">
                {TILE_PATTERN_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => setTileSettings({ pattern: opt.id })}
                    className={`px-2 py-1.5 text-xs font-medium transition ${
                      state.tileSettings.pattern === opt.id
                        ? "bg-fuchsia-600 text-white"
                        : "bg-slate-900 text-slate-300 hover:bg-slate-800"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* View row: Front / Back / Hood (Hood is link toggle) */}
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-300">
            View
          </div>
          <div className="grid grid-cols-3 gap-1">
            {(["front", "back"] as HoodieView[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                aria-pressed={state.view === v && state.activeGroupId !== "hood"}
                className={`rounded px-2 py-1.5 text-xs font-medium transition ${
                  state.view === v && state.activeGroupId !== "hood"
                    ? "bg-slate-100 text-slate-900"
                    : "bg-slate-900 text-slate-300 hover:bg-slate-800"
                }`}
              >
                {v === "front" ? "Front" : "Back"}
              </button>
            ))}
            <button
              onClick={onHoodButton}
              title={hoodTooltip}
              aria-label={hoodTooltip}
              aria-pressed={hoodSelected}
              className={`relative flex items-center justify-center gap-1 rounded px-2 py-1.5 text-xs font-medium transition ${
                hoodSelected
                  ? "bg-fuchsia-600 text-white"
                  : "bg-slate-900 text-slate-300 hover:bg-slate-800"
              }`}
            >
              {state.hoodLinked ? (
                <Link2 className="h-3 w-3" />
              ) : (
                <Link2Off className="h-3 w-3" />
              )}
              Hood
            </button>
          </div>
          {hoodSelected && (
            <div className="mt-1 text-[10px] text-slate-400">{hoodTooltip}</div>
          )}
        </div>

        {/* Artwork enabled — toggles the active group (place mode only) */}
        {state.mode === "place" && (
          <div className="flex items-center justify-between rounded border border-slate-800 bg-slate-900/40 px-3 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
              Artwork enabled
            </span>
            <Toggle
              checked={!!state.enabled[state.activeGroupId]}
              onChange={(on) => setEnabled(state.activeGroupId, on)}
            />
          </div>
        )}

        {/* Trim & Pockets — Pattern mode only. In Place mode the
            customer can already disable groups via "Artwork enabled",
            and these panels are usually full-art anyway. */}
        {state.mode === "pattern" && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between rounded border border-slate-800 bg-slate-900/40 px-3 py-2">
              <span
                className="text-[11px] font-semibold uppercase tracking-wide text-slate-300"
                title="Cuffs and waistband — when off they fill with the background colour"
              >
                Trim
              </span>
              <Toggle
                checked={state.trimEnabled}
                onChange={(on) =>
                  setState((prev) => (prev ? { ...prev, trimEnabled: on } : prev))
                }
              />
            </div>
            <div className="flex items-center justify-between rounded border border-slate-800 bg-slate-900/40 px-3 py-2">
              <span
                className="text-[11px] font-semibold uppercase tracking-wide text-slate-300"
                title="Kangaroo pocket and pocket halves — when off they fill with the background colour"
              >
                Pockets
              </span>
              <Toggle
                checked={state.pocketsEnabled}
                onChange={(on) =>
                  setState((prev) => (prev ? { ...prev, pocketsEnabled: on } : prev))
                }
              />
            </div>
          </div>
        )}

        {/* Background colour */}
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-300">
            Background
          </div>
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
          <div className="mt-2 flex flex-wrap gap-1.5">
            {swatches.map((s) => (
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

        {/* Reset */}
        <button
          onClick={resetAll}
          className="flex w-full items-center justify-center gap-1 text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline"
        >
          <RotateCcw className="h-3 w-3" /> Reset
        </button>

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
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-300">
        {title}
      </div>
      {children}
    </div>
  );
}

/**
 * Minimal switch primitive — keeps the placer self-contained without dragging
 * in shadcn's Switch (which we'd prefer to wire later through the embed shell
 * once we have full theming context).
 */
function Toggle({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
        checked ? "bg-fuchsia-600" : "bg-slate-700"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
