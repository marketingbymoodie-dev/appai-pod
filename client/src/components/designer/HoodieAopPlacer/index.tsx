import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pipette,
  RotateCcw,
  Upload,
  Loader2,
  Link2,
  Link2Off,
  Eye,
  EyeOff,
  Check,
} from "lucide-react";
import {
  FinePositionNudgeInline,
  mockupDeltaFromScreenNudge,
} from "@/components/designer/placementNudge";
import {
  SLEEVES_PART_ID,
  placerSegmentClass,
  placerSegmentGridClass,
  PlacerToggle,
} from "@/components/designer/placerControlStyles";
import {
  designGroupsForBlueprint,
  isSweatshirtBlueprint,
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
import { API_BASE } from "@/lib/urlBase";
import { safeFetch } from "@/lib/safeFetch";

/**
 * Customer-facing AOP artwork placer.
 *
 * The middle control column mirrors the legacy `PatternCustomizer`'s order
 * so customers see a familiar layout when we swap this in for product 20:
 *
 *   1. Place / Pattern segmented control
 *   2. View row: Front / Back / Hood
 *   3. Artwork Enabled (per-active-group)
 *   4. Background colour + eyedropper + 6 swatches (4 from artwork + B & W)
 *   5. Artwork upload (Replace / Upload artwork)
 *   6. Scale slider (drives the active group)
 *   7. Fine position nudge (↑←→↓)
 *   8. Reset
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
  /**
   * Initial / restored state, when resuming a customer's design. Accepts a
   * partial so callers can seed just one field (e.g. `artworkUrl`) without
   * having to construct the entire state shape — the placer fills in
   * remaining fields from the loaded template's defaults.
   */
  initialState?: Partial<HoodieAopPlacerState> | null;
  onApply?: (result: HoodieAopPlacerApplyResult) => void;
  onChange?: (state: HoodieAopPlacerState) => void;
  /**
   * When `true`, the placer does NOT fire its first auto-apply on open —
   * it just records the opened state as the baseline. Used when resuming a
   * previously-saved design whose cart mockup is already persisted, so
   * re-opening it doesn't trigger a needless re-render + re-upload (and the
   * product-preview "loading" scan that comes with it). Any subsequent
   * customer edit still auto-applies normally.
   */
  skipInitialAutoApply?: boolean;
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
  /** Sweatshirt trim (cuffs/waistband/neck rib) follows front-body placement. */
  trimLinked: boolean;
  /** Left sleeve follows front-body placement when linked. */
  leftSleeveLinked: boolean;
  /** Right sleeve follows front-body placement when linked. */
  rightSleeveLinked: boolean;
  /** Background fill colour (CSS) painted under the artwork. */
  backgroundColor: string;
  /** Tile settings (pattern mode). Falls back to template defaults. */
  tileSettings: TileSettings;
};

/** Panel keys treated as "Trim" by the customer toggle (incl. sweatshirt neck rib). */
const TRIM_PANEL_KEYS = [
  "waistband",
  "left_cuff",
  "right_cuff",
  "collar_front",
  "collar_back",
] as const;
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

/**
 * Stable signature of the *output-affecting* parts of the placer state.
 *
 * Used to skip needless auto-apply uploads: if the current signature
 * matches the last-applied (or restored) one, the rendered mockup hasn't
 * changed so there's nothing to re-upload. Deliberately excludes purely
 * navigational / UI fields (`view`, `activeGroupId`, `hoodLinked`) — those
 * never alter the front+back render that gets uploaded, so switching views
 * or selecting the hood shouldn't trigger a save.
 */
function outputSignature(s: HoodieAopPlacerState): string {
  return JSON.stringify({
    mode: s.mode,
    artworkUrl: s.artworkUrl,
    placements: s.placements,
    enabled: s.enabled,
    trimEnabled: s.trimEnabled,
    pocketsEnabled: s.pocketsEnabled,
    backgroundColor: s.backgroundColor,
    tileSettings: s.tileSettings,
  });
}

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

const SLEEVE_GROUP_IDS = ["left-sleeve", "right-sleeve"] as const;

function isSleevesPart(id: string): boolean {
  return id === SLEEVES_PART_ID;
}

function resolveEditGroupIds(activeGroupId: string): string[] {
  if (isSleevesPart(activeGroupId)) return [...SLEEVE_GROUP_IDS];
  return [activeGroupId];
}

/** Overlay handles attach to one group; sleeves edit both via this anchor. */
function overlayGroupId(activeGroupId: string): string {
  return isSleevesPart(activeGroupId) ? "left-sleeve" : activeGroupId;
}

/** Sleeves are one customer control — scale/nudge apply on both mockup views. */
function viewsForPlacementEdit(activeGroupId: string, currentView: HoodieView): HoodieView[] {
  if (isSleevesPart(activeGroupId)) return ["front", "back"];
  return [currentView];
}

/**
 * Build the customer state from a fetched template + (optional) saved
 * customer state. Inherits the admin's per-group defaults (placement,
 * enabled, locked-ratio) so the placer opens with the layout the admin
 * has dialed in.
 */
function buildInitialState(
  template: HoodieTemplate,
  saved?: Partial<HoodieAopPlacerState> | null,
): HoodieAopPlacerState {
  const groups = template.designGroups ?? designGroupsForBlueprint(template.blueprintId);
  const isSweatshirt = isSweatshirtBlueprint(template.blueprintId);
  const placements: Record<string, Record<HoodieView, ArtworkPlacement>> = {};
  const enabled: Record<string, boolean> = {};
  for (const g of groups) {
    placements[g.id] = {
      front: { ...(g.placement?.front ?? DEFAULT_ARTWORK_PLACEMENT) },
      back: { ...(g.placement?.back ?? DEFAULT_ARTWORK_PLACEMENT) },
    };
    if (isSweatshirt) {
      enabled[g.id] = false;
    } else {
      enabled[g.id] = g.id === "back-body" ? false : g.enabled !== false;
    }
  }
  const base: HoodieAopPlacerState = {
    mode: "place",
    view: "front",
    activeGroupId: "front-body",
    artworkUrl: null,
    placements,
    enabled,
    trimEnabled: !isSweatshirt,
    pocketsEnabled: true,
    hoodLinked: true,
    trimLinked: true,
    leftSleeveLinked: true,
    rightSleeveLinked: true,
    backgroundColor: DEFAULT_BG_COLOR,
    tileSettings: template.tileSettings ?? { pattern: "grid", tileSizeInches: 1.5 },
  };
  if (!saved) return base;
  return {
    ...base,
    ...saved,
    placements: { ...base.placements, ...(saved.placements ?? {}) },
    enabled: { ...base.enabled, ...(saved.enabled ?? {}) },
    tileSettings: { ...base.tileSettings, ...(saved.tileSettings ?? {}) },
    trimLinked: saved.trimLinked ?? base.trimLinked,
    leftSleeveLinked: saved.leftSleeveLinked ?? base.leftSleeveLinked,
    rightSleeveLinked: saved.rightSleeveLinked ?? base.rightSleeveLinked,
  };
}

/** Propagate placement deltas to linked partner groups (front view only). */
function propagateLinkedDeltas(
  state: HoodieAopPlacerState,
  placements: Record<string, Record<HoodieView, ArtworkPlacement>>,
  sourceId: string,
  view: HoodieView,
  prevSource: ArtworkPlacement,
  nextSource: ArtworkPlacement,
): Record<string, Record<HoodieView, ArtworkPlacement>> {
  if (view !== "front") return placements;
  const pairs: Array<[string, string, boolean]> = [
    ["hood", "front-body", state.hoodLinked],
    ["trim", "front-body", state.trimLinked],
  ];
  let result = placements;
  for (const [a, b, linked] of pairs) {
    if (!linked || (sourceId !== a && sourceId !== b)) continue;
    const partner = sourceId === a ? b : a;
    const partnerCur = result[partner]?.front ?? DEFAULT_ARTWORK_PLACEMENT;
    const dx = nextSource.offsetX - prevSource.offsetX;
    const dy = nextSource.offsetY - prevSource.offsetY;
    const ratio = prevSource.scale > 0 ? nextSource.scale / prevSource.scale : 1;
    result = {
      ...result,
      [partner]: {
        ...(result[partner] ?? {}),
        front: {
          scale: partnerCur.scale * ratio,
          offsetX: partnerCur.offsetX + dx,
          offsetY: partnerCur.offsetY + dy,
        },
      } as Record<HoodieView, ArtworkPlacement>,
    };
  }
  return result;
}

export default function HoodieAopPlacer({
  templateName,
  initialState,
  onApply,
  onChange,
  skipInitialAutoApply = false,
}: HoodieAopPlacerProps) {
  // ---------- Template fetch ----------
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    // IMPORTANT: must be an absolute URL via API_BASE — in the Shopify
    // storefront iframe, a relative `/api/...` resolves to the *shop* domain
    // (e.g. appai-2.myshopify.com), not our Railway app, and 404s. The
    // dev playground used a relative URL and worked because it runs on
    // the app's own origin; the embed needs API_BASE.
    const fetchUrl = `${API_BASE}/api/storefront/hoodie-template/${encodeURIComponent(templateName)}`;
    // Diagnostic: log the resolved URL so we can verify in storefront-iframe
    // console output what the placer is actually hitting (cross-origin
    // iframe network traffic is sometimes invisible to the parent page's
    // devtools network tab — console logs are still aggregated).
    // eslint-disable-next-line no-console
    console.log("[HoodieAopPlacer] fetching template:", fetchUrl, {
      API_BASE,
      templateName,
      origin: typeof window !== "undefined" ? window.location.origin : null,
    });

    // Robustness: AbortController + 12-second timeout per attempt + 1 retry.
    // Without this a transient hang (Supabase cold start, App Proxy stall,
    // browser connection-pool exhaustion) leaves the placer stuck on
    // "Loading template..." forever. With it the worst case is ~24s before
    // the user sees an actionable error.
    const FETCH_TIMEOUT_MS = 12_000;
    const MAX_ATTEMPTS = 2;

    const attempt = async (n: number): Promise<void> => {
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort("timeout"), FETCH_TIMEOUT_MS);
      try {
        // eslint-disable-next-line no-console
        if (n > 1) console.log("[HoodieAopPlacer] template retry attempt:", n);
        // CRITICAL: Use safeFetch (XHR in storefront iframe). Shopify's
        // service worker on the storefront domain intercepts window.fetch()
        // and never resolves it for App Proxy paths — XHR bypasses the SW.
        // See client/src/lib/safeFetch.ts.
        const r = await safeFetch(fetchUrl, { signal: ctrl.signal, cache: "no-store" });
        // eslint-disable-next-line no-console
        console.log("[HoodieAopPlacer] template response:", r.status, r.headers.get("content-type"));
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        const j: ApiResponse = await r.json();
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.log("[HoodieAopPlacer] template loaded:", j.name, "groups=", (j.template?.designGroups ?? []).length);
        setData(j);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const msg = (e as { message?: string })?.message || String(e);
        const aborted = (e as { name?: string })?.name === "AbortError" || /aborted|timeout/i.test(msg);
        // eslint-disable-next-line no-console
        console.warn(
          `[HoodieAopPlacer] template fetch attempt ${n}/${MAX_ATTEMPTS} failed:`,
          aborted ? "aborted/timeout" : msg,
        );
        if (n < MAX_ATTEMPTS) {
          // brief backoff before retry
          await new Promise((res) => setTimeout(res, 500));
          if (cancelled) return;
          return attempt(n + 1);
        }
        // eslint-disable-next-line no-console
        console.error("[HoodieAopPlacer] template fetch FAILED after retries:", msg);
        setLoadError(aborted ? "Template request timed out" : msg);
        setLoading(false);
      } finally {
        window.clearTimeout(timer);
      }
    };

    void attempt(1);

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

  // ---------- Bounding-box overlay visibility ----------
  // Default visible. Tapping the canvas backdrop (anywhere outside the
  // rect) toggles it; clicking the rect itself stops propagation so the
  // box stays visible while dragging/resizing. There's also an Eye/EyeOff
  // toggle next to "Artwork scale" for explicit control.
  const [overlayVisible, setOverlayVisible] = useState(true);

  // ---------- Auto-apply (debounced) ----------
  // We removed the "Apply to product" button — the cart/checkout preview
  // is kept in sync automatically. `onApply` fires ~1.5 s after the last
  // state change so a customer dragging/scaling doesn't trigger dozens
  // of uploads. We surface the status as a small indicator next to the
  // controls so the customer knows their changes are being saved.
  //
  // Note: this is a *local* render upload (front + back PNG → Supabase),
  // not a Printify mockup call. Printify mockup generation is deferred to
  // Stage 5 because it needs per-panel print files we don't compute yet.
  const [autoApplyStatus, setAutoApplyStatus] = useState<
    "idle" | "pending" | "saving" | "saved" | "error"
  >("idle");

  // Baseline output signature. The first time the placer has both state and
  // artwork ready, we record the current signature as the baseline (and,
  // when `skipInitialAutoApply` is set, do NOT fire an apply for it). After
  // that, the auto-apply effect only fires when the signature diverges from
  // the baseline — so re-opening an unchanged saved design, or just
  // switching views, never triggers a pointless re-render + re-upload (and
  // its product-preview loading scan).
  const baselineSignatureRef = useRef<string | null>(null);

  // Set true at first state-seed when initialState carried a saved placement
  // (i.e. we're resuming a previously-saved design). Used to suppress the
  // initial auto-apply regardless of the parent prop's render timing.
  const seededAsResumeRef = useRef(false);

  useEffect(() => {
    if (!data) return;
    setState((prev) => {
      // First load → seed from template + optional saved state.
      if (!prev) {
        // Detect a *resume*: the parent passes initialState as
        // `{ ...savedPlacerState, artworkUrl }`, so any key beyond
        // `artworkUrl` means we restored a real saved placement. Capturing it
        // here — at the exact moment the placement is restored — is more
        // reliable than the `skipInitialAutoApply` prop, which depends on the
        // parent's async state being settled by the placer's first ready
        // cycle. If we resumed, the saved mockup already exists, so the
        // initial auto-apply (and its grey scanning animation) must be
        // suppressed.
        seededAsResumeRef.current = !!(
          initialState &&
          Object.keys(initialState).some((k) => k !== "artworkUrl")
        );
        return buildInitialState(data.template, initialState);
      }
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
      activeGroupId:
        state.mode === "place" && artworkImg
          ? overlayGroupId(state.activeGroupId)
          : null,
      backgroundColor: state.backgroundColor,
      tileSettings: state.tileSettings,
      pixelsPerInch: data.template.realWorldCalibration?.pixelsPerInch,
    });
  }, [data, state, mockups, artworkImg]);

  // ---------- Helpers ----------

  const applyLinkedPlacements = (
    placerState: HoodieAopPlacerState,
    placements: Record<string, Record<HoodieView, ArtworkPlacement>>,
    sourceId: string,
    view: HoodieView,
    prevSource: ArtworkPlacement,
    nextSource: ArtworkPlacement,
  ): Record<string, Record<HoodieView, ArtworkPlacement>> => {
    return propagateLinkedDeltas(placerState, placements, sourceId, view, prevSource, nextSource);
  };

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
      if (prev.activeGroupId === SLEEVES_PART_ID) {
        return { ...prev, view };
      }
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

  const onPartButton = useCallback((groupId: string) => {
    setState((prev) => {
      if (!prev) return prev;
      if (groupId === SLEEVES_PART_ID) {
        return { ...prev, view: "front", activeGroupId: SLEEVES_PART_ID };
      }
      const view: HoodieView = groupId === "back-body" ? "back" : "front";
      return { ...prev, view, activeGroupId: groupId };
    });
  }, []);

  const setTrimEnabled = useCallback((on: boolean) => {
    setState((prev) => {
      if (!prev) return prev;
      const frontPl = prev.placements["front-body"]?.front ?? DEFAULT_ARTWORK_PLACEMENT;
      return {
        ...prev,
        trimEnabled: on,
        enabled: { ...prev.enabled, trim: on },
        placements:
          on && prev.trimLinked
            ? {
                ...prev.placements,
                trim: {
                  ...(prev.placements.trim ?? {}),
                  front: { ...frontPl },
                } as Record<HoodieView, ArtworkPlacement>,
              }
            : prev.placements,
      };
    });
  }, []);

  const setEnabled = useCallback((groupId: string, on: boolean) => {
    setState((prev) => {
      if (!prev) return prev;
      const ids = resolveEditGroupIds(groupId);
      const enabled = { ...prev.enabled };
      for (const id of ids) enabled[id] = on;
      return { ...prev, enabled };
    });
  }, []);

  const setBgColor = useCallback((hex: string) => {
    setState((prev) => (prev ? { ...prev, backgroundColor: hex } : prev));
  }, []);

  const updateActiveGroupPlacement = useCallback(
    (view: HoodieView, next: ArtworkPlacement) => {
      setState((prev) => {
        if (!prev) return prev;
        const ids = resolveEditGroupIds(prev.activeGroupId);
        const primaryId = overlayGroupId(prev.activeGroupId);
        const views = viewsForPlacementEdit(prev.activeGroupId, view);
        const prevPrimary =
          prev.placements[primaryId]?.[view] ?? DEFAULT_ARTWORK_PLACEMENT;
        let placements = { ...prev.placements };
        for (const id of ids) {
          const perView: Partial<Record<HoodieView, ArtworkPlacement>> = {
            ...(placements[id] ?? {}),
          };
          for (const v of views) {
            if (v === view) {
              perView[v] = { ...next };
            } else if (isSleevesPart(prev.activeGroupId)) {
              const curV = prev.placements[id]?.[v] ?? DEFAULT_ARTWORK_PLACEMENT;
              perView[v] = { ...curV, scale: next.scale };
            }
          }
          placements = {
            ...placements,
            [id]: perView as Record<HoodieView, ArtworkPlacement>,
          };
        }
        placements = applyLinkedPlacements(
          prev,
          placements,
          primaryId,
          view,
          prevPrimary,
          next,
        );
        return { ...prev, placements };
      });
    },
    [],
  );

  const setActiveScale = useCallback((view: HoodieView, scale: number) => {
    setState((prev) => {
      if (!prev) return prev;
      const ids = resolveEditGroupIds(prev.activeGroupId);
      const primaryId = overlayGroupId(prev.activeGroupId);
      const views = viewsForPlacementEdit(prev.activeGroupId, view);
      const cur = prev.placements[primaryId]?.[view] ?? DEFAULT_ARTWORK_PLACEMENT;
      const next: ArtworkPlacement = { ...cur, scale };
      let placements = { ...prev.placements };
      for (const id of ids) {
        const perView: Partial<Record<HoodieView, ArtworkPlacement>> = {
          ...(placements[id] ?? {}),
        };
        for (const v of views) {
          const curV = prev.placements[id]?.[v] ?? DEFAULT_ARTWORK_PLACEMENT;
          perView[v] = { ...curV, scale };
        }
        placements = {
          ...placements,
          [id]: perView as Record<HoodieView, ArtworkPlacement>,
        };
      }
      placements = applyLinkedPlacements(prev, placements, primaryId, view, cur, next);
      return { ...prev, placements };
    });
  }, []);

  const nudgePlacement = useCallback(
    (axis: "x" | "y", direction: 1 | -1) => {
      if (!state) return;
      const canvas = canvasRef.current;
      const mockupEl = mockups[state.view];
      if (!canvas || !mockupEl) return;
      const cr = canvas.getBoundingClientRect();
      const mW = mockupEl.naturalWidth || mockupEl.width;
      const mH = mockupEl.naturalHeight || mockupEl.height;
      const deltaMock = mockupDeltaFromScreenNudge(axis, direction, cr, mW, mH);
      const editId = overlayGroupId(state.activeGroupId);
      const cur =
        state.placements[editId]?.[state.view] ?? DEFAULT_ARTWORK_PLACEMENT;
      updateActiveGroupPlacement(state.view, {
        ...cur,
        offsetX: cur.offsetX + (axis === "x" ? deltaMock : 0),
        offsetY: cur.offsetY + (axis === "y" ? deltaMock : 0),
      });
    },
    [state, mockups, updateActiveGroupPlacement],
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

  const resetActivePart = useCallback(() => {
    if (!data) return;
    const groups =
      data.template.designGroups ?? designGroupsForBlueprint(data.template.blueprintId);
    setState((prev) => {
      if (!prev) return prev;
      const ids = resolveEditGroupIds(prev.activeGroupId);
      const placements = { ...prev.placements };
      for (const id of ids) {
        const g = groups.find((x) => x.id === id);
        placements[id] = {
          front: { ...(g?.placement?.front ?? DEFAULT_ARTWORK_PLACEMENT) },
          back: { ...(g?.placement?.back ?? DEFAULT_ARTWORK_PLACEMENT) },
        };
      }
      return { ...prev, placements };
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

  // Debounced auto-apply: a *meaningful* change to placer state schedules
  // an apply 1.5 s later, collapsing rapid edits into a single upload.
  useEffect(() => {
    if (!onApply) return;
    if (!state || !data || !artworkImg) return;

    const sig = outputSignature(state);

    // First ready cycle → establish the baseline.
    if (baselineSignatureRef.current === null) {
      baselineSignatureRef.current = sig;
      // Skip the initial apply when resuming a saved design. We trust EITHER
      // the parent prop OR our own mount-time detection (seededAsResumeRef),
      // so a render-timing gap on the prop can't cause a spurious re-render.
      if (skipInitialAutoApply || seededAsResumeRef.current) {
        // Resuming a saved design whose mockup is already persisted — show
        // it as saved and don't re-upload until the customer changes
        // something. This is what prevents the "open, then reload with the
        // scanning box" behaviour.
        setAutoApplyStatus("saved");
        return;
      }
      // Fresh design (no saved mockup yet) → fall through and apply once so
      // the cart/checkout image gets generated.
    } else if (sig === baselineSignatureRef.current) {
      // Nothing that affects the rendered mockup has changed (e.g. the
      // customer just switched Front/Back/Hood).
      setAutoApplyStatus((s) => (s === "pending" || s === "saving" ? "saved" : s));
      return;
    }

    setAutoApplyStatus("pending");
    const t = window.setTimeout(() => {
      setAutoApplyStatus("saving");
      try {
        onApply({ state, renderView: renderViewToCanvas });
        baselineSignatureRef.current = sig;
        // Optimistic — the parent's upload runs async; we flip to
        // "saved" after a short visual delay so the customer sees
        // confirmation. If the parent reports a real failure it'd
        // surface via the parent's mockupError state, not here.
        window.setTimeout(() => setAutoApplyStatus("saved"), 800);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[HoodieAopPlacer] auto-apply error:", e);
        setAutoApplyStatus("error");
      }
    }, 1500);
    return () => window.clearTimeout(t);
  }, [state, data, artworkImg, onApply, renderViewToCanvas, skipInitialAutoApply]);

  // ---------- Render guards ----------
  if (loading || !state) {
    return (
      <div className="flex h-[400px] items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading template…
      </div>
    );
  }
  if (loadError || !data) {
    return (
      <div className="flex h-[400px] flex-col items-center justify-center gap-2 rounded border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
        <div className="font-medium">Couldn't load template</div>
        <div className="text-xs opacity-80">{loadError ?? "unknown error"}</div>
      </div>
    );
  }

  // ---------- Derived UI state ----------
  const groups: DesignGroup[] =
    data.template.designGroups ?? designGroupsForBlueprint(data.template.blueprintId);
  const editGroupId = overlayGroupId(state.activeGroupId);
  const activeGroup = isSleevesPart(state.activeGroupId)
    ? { id: SLEEVES_PART_ID, name: "Sleeves" }
    : groups.find((g) => g.id === state.activeGroupId);
  const mockup = mockups[state.view];
  const placement =
    state.placements[editGroupId]?.[state.view] ?? DEFAULT_ARTWORK_PLACEMENT;
  const activePartEnabled = isSleevesPart(state.activeGroupId)
    ? !!state.enabled["left-sleeve"]
    : !!state.enabled[state.activeGroupId];
  const showOverlay =
    !!mockup &&
    !!artworkImg &&
    state.mode === "place" &&
    activePartEnabled &&
    // Hood handles only render on front view (back hood inherits via the
    // flat-panel bridge, no draggable equivalent).
    !(state.view === "back" && state.activeGroupId === "hood");
  const snapMode: "seam" | "x" | "y" | "both" | "none" =
    state.activeGroupId === "back-body" || state.activeGroupId === "collar"
      ? "both"
      : "seam";

  const isSweatshirt = isSweatshirtBlueprint(data.template.blueprintId);
  const hasHoodGroup = !isSweatshirt && groups.some((g) => g.id === "hood");
  const hasCollarGroup = !isSweatshirt && groups.some((g) => g.id === "collar");
  const hasTrimGroup = groups.some((g) => g.id === "trim");
  const hasSleeves =
    groups.some((g) => g.id === "left-sleeve") &&
    groups.some((g) => g.id === "right-sleeve");
  const hasPocketPanels =
    !isSweatshirt &&
    groups.some((g) =>
      g.panelKeys.some((k) => (POCKET_PANEL_KEYS as readonly string[]).includes(k)),
    );
  const viewButtonCount = 2 + (hasHoodGroup ? 1 : 0) + (hasCollarGroup ? 1 : 0);
  const viewGridClass = isSweatshirt
    ? "grid-cols-2"
    : viewButtonCount >= 4
      ? "grid-cols-4"
      : viewButtonCount === 3
        ? "grid-cols-3"
        : "grid-cols-2";
  const bodyViewActive =
    state.activeGroupId !== "hood" &&
    state.activeGroupId !== "collar" &&
    state.activeGroupId !== SLEEVES_PART_ID;

  const hoodSelected = state.activeGroupId === "hood";
  const hoodTooltip = state.hoodLinked
    ? hoodSelected
      ? "Hood linked to front — click again to unlink"
      : "Hood is linked to the front body. Click to edit independently."
    : "Hood unlinked — click again to relink to front body.";

  const placePartGroups: Array<{ id: string; name: string }> = [];
  for (const id of ["front-body", "back-body"] as const) {
    const g = groups.find((x) => x.id === id);
    if (g) placePartGroups.push({ id: g.id, name: g.name });
  }
  if (hasSleeves) {
    placePartGroups.push({ id: SLEEVES_PART_ID, name: "Sleeves" });
  }

  // Six swatches: 4 from artwork, plus black + white.
  const swatches: PaletteSwatch[] = [
    ...palette.slice(0, ARTWORK_PALETTE_COUNT),
    ...FIXED_PALETTE,
  ];

  return (
    <div className="flex w-full flex-col gap-4 lg:flex-row">
      {/* Left: live mockup with overlay */}
      <div className="relative flex-1 overflow-hidden rounded-lg border border-border bg-card">
        <div
          className="relative flex max-h-[55vh] items-center justify-center bg-zinc-100 p-3 lg:max-h-none lg:aspect-square lg:p-4"
          onClick={() => {
            // Tap on the canvas backdrop / mockup toggles the bounding box.
            // The rect itself stops propagation so dragging/resizing works.
            if (state.mode !== "place") return;
            setOverlayVisible((v) => !v);
          }}
          data-testid="hoodie-aop-canvas-area"
        >
          <div className="relative max-h-full max-w-full">
            <canvas
              ref={canvasRef}
              className="max-h-[50vh] max-w-full rounded object-contain lg:max-h-[78vh]"
              data-testid="hoodie-aop-placer-canvas"
            />
            {showOverlay && overlayVisible && mockup && artworkImg && (
              <DesignRectHandlesOverlay
                canvasRef={canvasRef}
                template={data.template}
                view={state.view}
                mockup={mockup}
                artwork={artworkImg}
                groupId={editGroupId}
                placement={placement}
                placementOverrides={state.placements}
                enabledOverrides={state.enabled}
                snapMode={snapMode}
                onChange={(next) => updateActiveGroupPlacement(state.view, next)}
              />
            )}
            {!artworkImg && !artworkLoading && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-xs text-muted-foreground">
                Upload an artwork to start placing it →
              </div>
            )}
            {artworkLoading && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Loading artwork…
              </div>
            )}
          </div>
        </div>
        {state.mode === "place" && artworkImg && activePartEnabled && (
          <FinePositionNudgeInline
            className="border-t border-border bg-card px-3 py-2"
            onNudge={nudgePlacement}
          />
        )}
      </div>

      {/* Right: controls (mirrors legacy customizer's middle-column order) */}
      <div className="w-full shrink-0 space-y-4 overflow-y-auto overscroll-contain lg:max-h-[min(88vh,960px)] lg:w-80">
        {/* Pattern / Place segmented toggle */}
        <div className="grid grid-cols-2 overflow-hidden rounded-md border border-border bg-card">
          {(["pattern", "place"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-3 py-2 text-xs font-semibold ${placerSegmentGridClass(state.mode === m)}`}
            >
              {m === "pattern" ? "Pattern" : "Place on item"}
            </button>
          ))}
        </div>

        {/* View row: Front / Back / optional Hood or Collar group */}
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            View
          </div>
          <div className={`grid ${viewGridClass} gap-1`}>
            {(["front", "back"] as HoodieView[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                aria-pressed={state.view === v && bodyViewActive}
                className={`rounded px-2 py-1.5 text-xs font-semibold border ${placerSegmentClass(
                  state.view === v && bodyViewActive,
                )}`}
              >
                {v === "front" ? "Front" : "Back"}
              </button>
            ))}
            {hasHoodGroup && (
              <button
                onClick={onHoodButton}
                title={hoodTooltip}
                aria-label={hoodTooltip}
                aria-pressed={hoodSelected}
                className={`relative flex items-center justify-center gap-1 rounded px-2 py-1.5 text-xs font-semibold border ${placerSegmentClass(
                  hoodSelected,
                )}`}
              >
                {state.hoodLinked ? (
                  <Link2 className="h-3 w-3" />
                ) : (
                  <Link2Off className="h-3 w-3" />
                )}
                Hood
              </button>
            )}
            {hasCollarGroup && (
              <button
                onClick={() => onPartButton("collar")}
                aria-pressed={state.activeGroupId === "collar"}
                className={`rounded px-2 py-1.5 text-xs font-semibold border ${placerSegmentClass(
                  state.activeGroupId === "collar",
                )}`}
              >
                Collar
              </button>
            )}
          </div>
          {hoodSelected && (
            <div className="mt-1 text-[10px] text-muted-foreground">{hoodTooltip}</div>
          )}
        </div>

        {/* Place mode: pick which part to scale / enable */}
        {state.mode === "place" && placePartGroups.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Part
            </div>
            <div className="flex flex-wrap gap-1">
              {placePartGroups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => onPartButton(g.id)}
                  aria-pressed={state.activeGroupId === g.id}
                  className={`rounded px-2 py-1.5 text-xs font-semibold border ${placerSegmentClass(
                    state.activeGroupId === g.id,
                  )}`}
                >
                  {g.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Trim (+ optional Pockets) — both Pattern and Place modes */}
        {(hasTrimGroup || hasPocketPanels) && (
          <div className="space-y-1.5">
            {hasTrimGroup && (
              <div className="flex items-center justify-between rounded border border-border bg-muted/40 px-3 py-2">
                <span
                  className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                  title="Cuffs, waistband, and neck rib — when off they fill with the background colour"
                >
                  Trim
                </span>
                <PlacerToggle
                  checked={state.trimEnabled}
                  onChange={setTrimEnabled}
                  aria-label="Trim on artwork"
                />
              </div>
            )}
            {hasPocketPanels && (
              <div className="flex items-center justify-between rounded border border-border bg-muted/40 px-3 py-2">
                <span
                  className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                  title="Kangaroo pocket and pocket halves — when off they fill with the background colour"
                >
                  Pockets
                </span>
                <PlacerToggle
                  checked={state.pocketsEnabled}
                  onChange={(on) =>
                    setState((prev) => (prev ? { ...prev, pocketsEnabled: on } : prev))
                  }
                  aria-label="Pockets on artwork"
                />
              </div>
            )}
          </div>
        )}

        {/* Artwork enabled — toggles the active group (place mode only) */}
        {state.mode === "place" && (
          <div className="flex items-center justify-between rounded border border-border bg-muted/40 px-3 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Artwork enabled
            </span>
            <PlacerToggle
              checked={activePartEnabled}
              onChange={(on) => setEnabled(state.activeGroupId, on)}
              aria-label="Artwork enabled"
            />
          </div>
        )}

        {/* Background colour */}
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Background
          </div>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={state.backgroundColor}
              onChange={(e) => setBgColor(e.target.value)}
              className="h-8 w-10 cursor-pointer rounded border border-border bg-card"
              aria-label="Background colour"
            />
            <input
              type="text"
              value={state.backgroundColor}
              onChange={(e) => setBgColor(e.target.value)}
              className="h-8 flex-1 rounded border border-border bg-card px-2 text-xs text-card-foreground"
              spellCheck={false}
            />
            {typeof window !== "undefined" && "EyeDropper" in window && (
              <button
                onClick={triggerEyedropper}
                className="flex h-8 w-8 items-center justify-center rounded border border-border bg-card text-card-foreground hover:bg-muted"
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
                    ? "border-primary ring-2 ring-primary/40"
                    : "border-border hover:border-foreground/40"
                }`}
                style={{ backgroundColor: s.hex }}
              />
            ))}
          </div>
        </div>

        {/* Artwork upload (separate row since legacy assumes art is already chosen) */}
        <Section title="Artwork">
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded border border-dashed border-border bg-muted/40 p-3 text-xs font-semibold text-foreground hover:border-primary/60 hover:bg-muted">
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
            <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span className="flex items-center gap-2">
                Artwork scale
                {artworkImg && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOverlayVisible((v) => !v);
                    }}
                    title={overlayVisible ? "Hide bounding box" : "Show bounding box"}
                    aria-label={overlayVisible ? "Hide bounding box" : "Show bounding box"}
                    className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {overlayVisible ? (
                      <Eye className="h-3.5 w-3.5" />
                    ) : (
                      <EyeOff className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
              </span>
              <span className="text-muted-foreground/80">{Math.round(placement.scale * 100)}%</span>
            </div>
            <input
              type="range"
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={0.01}
              value={placement.scale}
              onChange={(e) =>
                setActiveScale(state.view, Number(e.target.value))
              }
              className="w-full"
              style={{ accentColor: "hsl(var(--primary))" }}
              aria-label="Artwork scale"
            />
            <div className="mt-1 text-[10px] text-muted-foreground/80">
              Adjusting <span className="text-foreground">{activeGroup?.name ?? state.activeGroupId}</span>
              {hasHoodGroup &&
                state.hoodLinked &&
                (state.activeGroupId === "hood" || state.activeGroupId === "front-body") && (
                <> • linked with {state.activeGroupId === "hood" ? "front body" : "hood"}</>
              )}
              {state.trimLinked && state.trimEnabled && (state.activeGroupId === "trim" || state.activeGroupId === "front-body") && (
                <> • trim linked to front body</>
              )}
            </div>
          </div>
        )}

        {/* PATTERN mode: tile-size slider + pattern style */}
        {state.mode === "pattern" && (
          <>
            <div>
              <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <span>Tile size</span>
                <span className="text-muted-foreground/80">
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
                className="w-full"
                style={{ accentColor: "hsl(var(--primary))" }}
                aria-label="Tile size"
              />
            </div>
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Pattern
              </div>
              <div className="grid grid-cols-3 overflow-hidden rounded-md border border-border">
                {TILE_PATTERN_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => setTileSettings({ pattern: opt.id })}
                    className={`px-2 py-1.5 text-xs font-semibold ${placerSegmentGridClass(
                      state.tileSettings.pattern === opt.id,
                    )}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Reset active part to admin default placement */}
        <button
          onClick={resetActivePart}
          className="flex w-full items-center justify-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          title="Reset the selected part to its default centred placement"
        >
          <RotateCcw className="h-3 w-3" /> Reset
        </button>

        {/* Auto-save indicator (replaces the old "Apply to product" button —
            the cart preview is now kept in sync automatically, debounced
            ~1.5 s after the customer's last change). */}
        {onApply && artworkImg && (
          <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
            {autoApplyStatus === "saving" || autoApplyStatus === "pending" ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>Saving design…</span>
              </>
            ) : autoApplyStatus === "saved" ? (
              <>
                <Check className="h-3 w-3 text-green-600" />
                <span>Design saved</span>
              </>
            ) : autoApplyStatus === "error" ? (
              <span className="text-destructive">Couldn't save — try again</span>
            ) : (
              <span className="opacity-60">Design syncs automatically</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}
