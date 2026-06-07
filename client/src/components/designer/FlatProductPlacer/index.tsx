import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Loader2, RotateCcw, Check, AlertTriangle } from "lucide-react";
import {
  DEFAULT_ARTWORK_PLACEMENT,
  type ArtworkPlacement,
} from "@/components/hoodie-template-mapper/lib/aopPreview";
import { API_BASE } from "@/lib/urlBase";
import FlatDesignRectOverlay from "./FlatDesignRectOverlay";
import {
  flatArtBox,
  flatCovers,
  flatVisibleRectPx,
  renderFlatView,
  FLAT_SCALE_MAX,
  FLAT_SCALE_MIN,
} from "./lib/flatRender";
import type {
  FlatCalibrationManifest,
  FlatViewCalibration,
} from "@/pages/embed-design";

/**
 * Customer-facing placer for "on-the-fly" flat / mesh products.
 *
 * Structurally modelled on `HoodieAopPlacer`: a left live-canvas + right
 * controls column, a hideable bounding box, a debounced auto-apply that hands
 * a `renderView(view)` callback back to the parent (which uploads the PNG and
 * pins it as the cart / checkout mockup). Unlike the hoodie placer this draws a
 * single design onto a calibrated blank (no panel template, no AOP tiling).
 *
 * Invariants enforced here:
 *   - Front + back are INDEPENDENT placements; switching views never resets
 *     the other view.
 *   - Back defaults OFF, and the Back toggle only appears when the manifest
 *     (and the selected colour's blank) actually has a back view.
 *   - Placement scale is capped at 1.0 (Printify clamps placement scale), so
 *     the UI never implies more coverage than the print file provides.
 */

type ViewName = "front" | "back";

export type FlatProductPlacerState = {
  /** Currently visible view. */
  view: ViewName;
  /** Per-view placement (normalized to the print rect). Independent per view. */
  placements: Record<ViewName, ArtworkPlacement>;
  /** Per-view enabled flag. Back defaults false. */
  enabled: Record<ViewName, boolean>;
  /** The artwork (the customer's generated/uploaded design). */
  artworkUrl: string | null;
};

export type FlatProductPlacerApplyResult = {
  state: FlatProductPlacerState;
  /** Render an enabled view to a fresh full-size canvas, else `null`. */
  renderView: (view: ViewName) => HTMLCanvasElement | null;
};

export type FlatProductPlacerProps = {
  manifest: FlatCalibrationManifest;
  /** Currently selected colour/model id — picks the blank from `manifest.blanks`. */
  colorId: string;
  initialState?: Partial<FlatProductPlacerState> | null;
  onApply?: (result: FlatProductPlacerApplyResult) => void;
  onChange?: (state: FlatProductPlacerState) => void;
  /** Called when blank/mask assets cannot load — parent should fall back to Printify. */
  onAssetsFailed?: (reason: string) => void;
  /** Skip the first auto-apply when resuming an already-saved design. */
  skipInitialAutoApply?: boolean;
};

type LoadedAssets = {
  blank: HTMLImageElement | null;
  mask: HTMLImageElement | null;
  shading: HTMLImageElement | null;
};

const EMPTY_ASSETS: LoadedAssets = { blank: null, mask: null, shading: null };

/** Resolve absolute URL (manifest urls are usually Supabase absolutes already). */
function toAbs(url: string): string {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${API_BASE}${url.startsWith("/") ? "" : "/"}${url}`;
}

function normalizeColorKey(id: string): string {
  return id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

/**
 * Pick the blank photo set for `colorId`, with graceful fallback: exact key →
 * normalized-key match (server lowercases/strips when keying) → first entry.
 */
function resolveBlank(
  manifest: FlatCalibrationManifest,
  colorId: string,
): Partial<Record<ViewName, string>> {
  const blanks = manifest.blanks || {};
  if (colorId && blanks[colorId]) return blanks[colorId];
  if (colorId) {
    const norm = normalizeColorKey(colorId);
    for (const k of Object.keys(blanks)) {
      if (normalizeColorKey(k) === norm) return blanks[k];
    }
  }
  const first = Object.keys(blanks)[0];
  return first ? blanks[first] : {};
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = toAbs(url);
  });
}

function outputSignature(s: FlatProductPlacerState): string {
  return JSON.stringify({
    artworkUrl: s.artworkUrl,
    placements: s.placements,
    enabled: s.enabled,
  });
}

function buildInitialState(
  availableViews: ViewName[],
  saved?: Partial<FlatProductPlacerState> | null,
): FlatProductPlacerState {
  const base: FlatProductPlacerState = {
    view: "front",
    placements: {
      front: { ...DEFAULT_ARTWORK_PLACEMENT },
      back: { ...DEFAULT_ARTWORK_PLACEMENT },
    },
    enabled: {
      front: availableViews.includes("front"),
      back: false,
    },
    artworkUrl: saved?.artworkUrl ?? null,
  };
  if (!saved) return base;
  return {
    ...base,
    ...saved,
    placements: { ...base.placements, ...(saved.placements ?? {}) },
    enabled: { ...base.enabled, ...(saved.enabled ?? {}) },
  };
}

export default function FlatProductPlacer({
  manifest,
  colorId,
  initialState,
  onApply,
  onChange,
  onAssetsFailed,
  skipInitialAutoApply = false,
}: FlatProductPlacerProps) {
  const blank = useMemo(() => resolveBlank(manifest, colorId), [manifest, colorId]);

  const availableViews = useMemo<ViewName[]>(() => {
    const views: ViewName[] = [];
    (["front", "back"] as ViewName[]).forEach((v) => {
      if (manifest.views[v] && blank[v]) views.push(v);
    });
    return views;
  }, [manifest, blank]);

  const [assets, setAssets] = useState<Record<ViewName, LoadedAssets>>({
    front: EMPTY_ASSETS,
    back: EMPTY_ASSETS,
  });
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [assetError, setAssetError] = useState<string | null>(null);

  // ---------- Preload blank / mask / shading for every available view ----------
  useEffect(() => {
    let cancelled = false;
    setAssetsLoading(true);
    setAssetError(null);
    (async () => {
      const next: Record<ViewName, LoadedAssets> = {
        front: EMPTY_ASSETS,
        back: EMPTY_ASSETS,
      };
      for (const v of availableViews) {
        const calib = manifest.views[v]!;
        const blankUrl = blank[v];
        if (!blankUrl) continue;
        const [b, m, s] = await Promise.all([
          loadImage(blankUrl),
          calib.maskUrl ? loadImage(calib.maskUrl) : Promise.resolve(null),
          calib.shadingMode === "map" && calib.shadingUrl
            ? loadImage(calib.shadingUrl)
            : Promise.resolve(null),
        ]);
        next[v] = { blank: b, mask: m, shading: s };
      }
      if (cancelled) return;
      setAssets(next);
      const anyBlank = availableViews.some((v) => next[v].blank);
      const err = anyBlank ? null : "Could not load product images";
      setAssetError(err);
      setAssetsLoading(false);
      if (err) onAssetsFailed?.(err);
    })();
    return () => {
      cancelled = true;
    };
  }, [availableViews, manifest, blank, onAssetsFailed]);

  useEffect(() => {
    if (!assetsLoading && availableViews.length === 0) {
      onAssetsFailed?.("No printable views available");
    }
  }, [assetsLoading, availableViews.length, onAssetsFailed]);

  // ---------- Customer state ----------
  const [state, setState] = useState<FlatProductPlacerState | null>(null);
  const baselineSignatureRef = useRef<string | null>(null);
  const seededAsResumeRef = useRef(false);

  useEffect(() => {
    setState((prev) => {
      if (prev) return prev;
      seededAsResumeRef.current = !!(
        initialState &&
        Object.keys(initialState).some((k) => k !== "artworkUrl")
      );
      return buildInitialState(availableViews, initialState);
    });
    // initialState consumed once on first seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableViews]);

  useEffect(() => {
    if (state) onChange?.(state);
  }, [state, onChange]);

  // ---------- Artwork loading ----------
  const [artworkImg, setArtworkImg] = useState<HTMLImageElement | null>(null);
  const [artworkLoading, setArtworkLoading] = useState(false);
  useEffect(() => {
    const url = state?.artworkUrl ?? null;
    if (!url) {
      setArtworkImg(null);
      return;
    }
    let cancelled = false;
    setArtworkLoading(true);
    loadImage(url).then((img) => {
      if (cancelled) return;
      setArtworkImg(img);
      setArtworkLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [state?.artworkUrl]);

  // ---------- Bounding-box visibility ----------
  const [overlayVisible, setOverlayVisible] = useState(true);

  // ---------- Auto-apply status ----------
  const [autoApplyStatus, setAutoApplyStatus] = useState<
    "idle" | "pending" | "saving" | "saved" | "error"
  >("idle");

  // ---------- Core render helper ----------
  const renderInto = useCallback(
    (canvas: HTMLCanvasElement, v: ViewName, forApply: boolean): boolean => {
      if (!state) return false;
      const a = assets[v];
      const calib: FlatViewCalibration | undefined = manifest.views[v];
      if (!a?.blank || !calib) return false;
      const enabled = !!state.enabled[v];
      // For apply, a disabled view contributes nothing.
      if (forApply && !enabled) return false;
      try {
        renderFlatView({
          target: canvas,
          blank: a.blank,
          mask: a.mask,
          shading: a.shading,
          artwork: enabled ? artworkImg : null,
          view: calib,
          placement: state.placements[v],
          tier: manifest.tier,
        });
        return true;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[FlatProductPlacer] render failed:", e);
        return false;
      }
    },
    [state, assets, manifest, artworkImg],
  );

  // ---------- Live canvas ----------
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!state) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderInto(canvas, state.view, false);
  }, [state, assets, artworkImg, renderInto]);

  // ---------- Apply hand-off ----------
  const renderViewToCanvas = useCallback(
    (v: ViewName): HTMLCanvasElement | null => {
      const c = document.createElement("canvas");
      const ok = renderInto(c, v, true);
      return ok ? c : null;
    },
    [renderInto],
  );

  // ---------- Debounced auto-apply (mirrors HoodieAopPlacer) ----------
  useEffect(() => {
    if (!onApply) return;
    if (!state || !artworkImg) return;
    if (assetsLoading) return;

    const sig = outputSignature(state);

    if (baselineSignatureRef.current === null) {
      baselineSignatureRef.current = sig;
      if (skipInitialAutoApply || seededAsResumeRef.current) {
        setAutoApplyStatus("saved");
        return;
      }
    } else if (sig === baselineSignatureRef.current) {
      setAutoApplyStatus((s) => (s === "pending" || s === "saving" ? "saved" : s));
      return;
    }

    setAutoApplyStatus("pending");
    const t = window.setTimeout(() => {
      setAutoApplyStatus("saving");
      try {
        onApply({ state, renderView: renderViewToCanvas });
        baselineSignatureRef.current = sig;
        window.setTimeout(() => setAutoApplyStatus("saved"), 800);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[FlatProductPlacer] auto-apply error:", e);
        setAutoApplyStatus("error");
      }
    }, 1500);
    return () => window.clearTimeout(t);
  }, [
    state,
    artworkImg,
    assetsLoading,
    onApply,
    renderViewToCanvas,
    skipInitialAutoApply,
  ]);

  // ---------- Mutators ----------
  const setView = useCallback((view: ViewName) => {
    setState((prev) => (prev ? { ...prev, view } : prev));
  }, []);

  const setEnabled = useCallback((view: ViewName, on: boolean) => {
    setState((prev) =>
      prev ? { ...prev, enabled: { ...prev.enabled, [view]: on } } : prev,
    );
  }, []);

  const updatePlacement = useCallback(
    (view: ViewName, next: ArtworkPlacement) => {
      setState((prev) =>
        prev
          ? { ...prev, placements: { ...prev.placements, [view]: next } }
          : prev,
      );
    },
    [],
  );

  const setScale = useCallback(
    (view: ViewName, scale: number) => {
      setState((prev) => {
        if (!prev) return prev;
        const cur = prev.placements[view] ?? DEFAULT_ARTWORK_PLACEMENT;
        return {
          ...prev,
          placements: { ...prev.placements, [view]: { ...cur, scale } },
        };
      });
    },
    [],
  );

  const resetView = useCallback((view: ViewName) => {
    setState((prev) =>
      prev
        ? {
            ...prev,
            placements: {
              ...prev.placements,
              [view]: { ...DEFAULT_ARTWORK_PLACEMENT },
            },
          }
        : prev,
    );
  }, []);

  // ---------- Render guards ----------
  if (!state || assetsLoading) {
    return (
      <div className="flex h-[400px] items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading preview…
      </div>
    );
  }
  if (assetError || availableViews.length === 0) {
    return (
      <div className="flex h-[400px] flex-col items-center justify-center gap-2 rounded border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
        <div className="font-medium">Couldn't load product preview</div>
        <div className="text-xs opacity-80">
          {assetError ?? "No printable views available"}
        </div>
      </div>
    );
  }

  const calib = manifest.views[state.view];
  const viewAssets = assets[state.view];
  const placement = state.placements[state.view] ?? DEFAULT_ARTWORK_PLACEMENT;
  const viewEnabled = !!state.enabled[state.view];

  // Coverage check for the current view (warn when garment edges may show).
  let coverageOk = true;
  if (calib && artworkImg && viewEnabled) {
    const W = viewAssets.blank?.naturalWidth || calib.mockupDims?.width || 1;
    const H = viewAssets.blank?.naturalHeight || calib.mockupDims?.height || 1;
    const rect = flatVisibleRectPx(calib, W, H);
    const box = flatArtBox(
      rect,
      placement,
      artworkImg.naturalWidth,
      artworkImg.naturalHeight,
    );
    coverageOk = flatCovers(rect, box);
  }

  const showOverlay =
    overlayVisible &&
    viewEnabled &&
    !!artworkImg &&
    !!calib &&
    !!viewAssets.blank;

  return (
    <div className="flex w-full flex-col gap-4 lg:flex-row">
      {/* Left: live canvas + overlay */}
      <div className="relative flex-1 overflow-hidden rounded-lg border border-border bg-card">
        <div
          className="relative flex max-h-[55vh] items-center justify-center bg-zinc-100 p-3 lg:max-h-none lg:aspect-square lg:p-4"
          onClick={() => setOverlayVisible((v) => !v)}
          data-testid="flat-placer-canvas-area"
        >
          <div className="relative max-h-full max-w-full">
            <canvas
              ref={canvasRef}
              className="max-h-[50vh] max-w-full rounded object-contain lg:max-h-[78vh]"
              data-testid="flat-placer-canvas"
            />
            {showOverlay && calib && viewAssets.blank && artworkImg && (
              <FlatDesignRectOverlay
                canvasRef={canvasRef}
                view={calib}
                artwork={artworkImg}
                placement={placement}
                onChange={(next) => updatePlacement(state.view, next)}
              />
            )}
            {!artworkImg && !artworkLoading && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-xs text-muted-foreground">
                Create a design to preview it on the product →
              </div>
            )}
            {artworkLoading && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Loading artwork…
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right: controls */}
      <div className="w-full shrink-0 space-y-4 lg:w-80">
        {/* View row: Front always; Back only when available */}
        {availableViews.length > 1 && (
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              View
            </div>
            <div className="grid grid-cols-2 gap-1">
              {availableViews.map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  aria-pressed={state.view === v}
                  className={`rounded px-2 py-1.5 text-xs font-semibold transition ${
                    state.view === v
                      ? "bg-primary text-primary-foreground"
                      : "bg-card text-card-foreground hover:bg-muted border border-border"
                  }`}
                >
                  {v === "front" ? "Front" : "Back"}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Artwork enabled — per current view */}
        <div className="flex items-center justify-between rounded border border-border bg-muted/40 px-3 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Print on {state.view === "front" ? "front" : "back"}
          </span>
          <Toggle
            checked={viewEnabled}
            onChange={(on) => setEnabled(state.view, on)}
          />
        </div>

        {/* Scale slider (capped at 1.0) */}
        {viewEnabled && (
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
              <span className="text-muted-foreground/80">
                {Math.round(placement.scale * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={FLAT_SCALE_MIN}
              max={FLAT_SCALE_MAX}
              step={0.01}
              value={placement.scale}
              onChange={(e) => setScale(state.view, Number(e.target.value))}
              className="w-full"
              style={{ accentColor: "hsl(var(--primary))" }}
              aria-label="Artwork scale"
            />
          </div>
        )}

        {/* Coverage warning */}
        {viewEnabled && artworkImg && !coverageOk && (
          <div className="flex items-start gap-2 rounded border border-amber-400/50 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Your artwork doesn't fully cover the print area — the garment may
              show around the edges. Scale up or reposition to fill it.
            </span>
          </div>
        )}

        {/* Reset current view */}
        {viewEnabled && (
          <button
            onClick={() => resetView(state.view)}
            className="flex w-full items-center justify-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <RotateCcw className="h-3 w-3" /> Reset {state.view}
          </button>
        )}

        {/* Auto-save indicator */}
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

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
        checked ? "bg-primary" : "bg-muted-foreground/30"
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
