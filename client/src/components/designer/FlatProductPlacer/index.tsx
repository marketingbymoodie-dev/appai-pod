import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Eye, EyeOff, Loader2, RotateCcw, AlertTriangle } from "lucide-react";
import {
  DEFAULT_ARTWORK_PLACEMENT,
  type ArtworkPlacement,
} from "@/components/hoodie-template-mapper/lib/aopPreview";
import FlatDesignRectOverlay from "./FlatDesignRectOverlay";
import {
  loadFlatImage,
  resolveFlatBlank,
  resolveFlatViewCalibration,
  type FlatViewName,
} from "./lib/flatAssets";
import {
  flatArtBox,
  flatCovers,
  flatEdgeWrapGuideRects,
  flatInsufficientSafeZoneCoverage,
  flatOverflows,
  flatPlacementRectPx,
  flatPlacementScaleMax,
  flatPrintBoundsPx,
  flatVisibleRectPx,
  renderFlatView,
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

type ViewName = FlatViewName;

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

/** Explicit persist lifecycle — parent flushes on ATC / leave editor / page hide. */
export type FlatApplyStatus = "idle" | "saving" | "saved" | "error";

export type FlatProductPlacerHandle = {
  /** Upload + persist when placement or colour changed since last apply. */
  applyIfNeeded: () => Promise<void>;
  hasPendingChanges: () => boolean;
};

export type FlatProductPlacerProps = {
  manifest: FlatCalibrationManifest;
  /** Currently selected colour/model id — picks the blank from `manifest.blanks`. */
  colorId: string;
  /** Authoritative artwork URL — always wins over saved `initialState.artworkUrl`. */
  artworkSourceUrl: string;
  initialState?: Partial<FlatProductPlacerState> | null;
  onApply?: (result: FlatProductPlacerApplyResult) => void | Promise<void>;
  onChange?: (state: FlatProductPlacerState) => void;
  /** Fired when an explicit persist starts / finishes (for ATC gating). */
  onApplyStatusChange?: (status: FlatApplyStatus) => void;
  /** Called when blank/mask assets cannot load — parent should fall back to Printify. */
  onAssetsFailed?: (reason: string) => void;
  /** Skip the first auto-apply when resuming an already-saved design. */
  skipInitialAutoApply?: boolean;
  /** Phone cases / rigid edge-wrap products — not apparel with a shading map. */
  edgeWrapMode?: boolean;
  /** Framed posters / decor — mat-based placement, zoom past 100%. */
  decorMode?: boolean;
};

type LoadedAssets = {
  blank: HTMLImageElement | null;
  mask: HTMLImageElement | null;
  shading: HTMLImageElement | null;
};

const EMPTY_ASSETS: LoadedAssets = { blank: null, mask: null, shading: null };

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

const FlatProductPlacer = forwardRef<FlatProductPlacerHandle, FlatProductPlacerProps>(
  function FlatProductPlacer(
    {
      manifest,
      colorId,
      artworkSourceUrl,
      initialState,
      onApply,
      onChange,
      onApplyStatusChange,
      onAssetsFailed,
      skipInitialAutoApply = false,
      edgeWrapMode = false,
      decorMode = false,
    },
    ref,
  ) {
  const blank = useMemo(() => resolveFlatBlank(manifest, colorId), [manifest, colorId]);

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
    const hasExistingAssets = availableViews.some((v) => assets[v].blank);
    if (!hasExistingAssets) setAssetsLoading(true);
    setAssetError(null);
    (async () => {
      const next: Record<ViewName, LoadedAssets> = {
        front: EMPTY_ASSETS,
        back: EMPTY_ASSETS,
      };
      for (const v of availableViews) {
        const calib = resolveFlatViewCalibration(manifest, colorId, v);
        const blankUrl = blank[v];
        if (!calib || !blankUrl) continue;
        const [b, m, s] = await Promise.all([
          loadFlatImage(blankUrl),
          calib.maskUrl ? loadFlatImage(calib.maskUrl) : Promise.resolve(null),
          calib.shadingUrl &&
          (calib.shadingMode === "map" || calib.printBoundsNormalized)
            ? loadFlatImage(calib.shadingUrl)
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keep prior assets visible during colour swap
  }, [availableViews, manifest, blank, colorId, onAssetsFailed]);

  useEffect(() => {
    if (!assetsLoading && availableViews.length === 0) {
      onAssetsFailed?.("No printable views available");
    }
  }, [assetsLoading, availableViews.length, onAssetsFailed]);

  // ---------- Customer state ----------
  const [state, setState] = useState<FlatProductPlacerState | null>(null);
  const lastAppliedSignatureRef = useRef<string | null>(null);
  const lastAppliedColorRef = useRef<string | null>(null);
  const prevColorIdRef = useRef<string | null>(null);
  const seededAsResumeRef = useRef(false);
  const resumeBaselineSeededRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const canvasDragRef = useRef(false);

  useEffect(() => {
    setState((prev) => {
      const saved: Partial<FlatProductPlacerState> = {
        ...(initialState ?? {}),
        artworkUrl: artworkSourceUrl || initialState?.artworkUrl || null,
      };
      if (!prev) {
        seededAsResumeRef.current = !!(
          saved &&
          Object.keys(saved).some((k) => k !== "artworkUrl")
        );
        return buildInitialState(availableViews, saved);
      }
      if (artworkSourceUrl && prev.artworkUrl !== artworkSourceUrl) {
        return { ...prev, artworkUrl: artworkSourceUrl };
      }
      return prev;
    });
    // initialState consumed on first seed; artworkSourceUrl kept in sync after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableViews, artworkSourceUrl]);

  useEffect(() => {
    if (state) onChangeRef.current?.(state);
  }, [state]);

  // Reset placement when the blank model/colour changes — geometry differs per key.
  useEffect(() => {
    if (prevColorIdRef.current === null) {
      prevColorIdRef.current = colorId;
      return;
    }
    if (prevColorIdRef.current === colorId) return;
    prevColorIdRef.current = colorId;
    lastAppliedSignatureRef.current = null;
    resumeBaselineSeededRef.current = false;
    setState((prev) => {
      if (!prev) return prev;
      const placements = { ...prev.placements };
      for (const v of availableViews) {
        placements[v] = { ...DEFAULT_ARTWORK_PLACEMENT };
      }
      return { ...prev, placements };
    });
  }, [colorId, availableViews]);

  // ---------- Artwork loading (always from artworkSourceUrl) ----------
  const [artworkImg, setArtworkImg] = useState<HTMLImageElement | null>(null);
  const [artworkLoading, setArtworkLoading] = useState(false);
  const [artworkCorsClean, setArtworkCorsClean] = useState(true);
  useEffect(() => {
    const url = artworkSourceUrl?.trim() || null;
    if (!url) {
      setArtworkImg(null);
      setArtworkCorsClean(true);
      setArtworkLoading(false);
      return;
    }
    let cancelled = false;
    setArtworkLoading(true);
    void (async () => {
      const withCors = await loadFlatImage(url, { cors: true });
      if (cancelled) return;
      if (withCors) {
        setArtworkCorsClean(true);
        setArtworkImg(withCors);
        setArtworkLoading(false);
        return;
      }
      const displayOnly = await loadFlatImage(url, { cors: false });
      if (cancelled) return;
      if (displayOnly) {
        setArtworkCorsClean(false);
        setArtworkImg(displayOnly);
      }
      setArtworkLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [artworkSourceUrl]);

  // ---------- Bounding-box visibility ----------
  const [overlayVisible, setOverlayVisible] = useState(true);

  // ---------- Persist status (explicit flush only) ----------
  const [applyStatus, setApplyStatus] = useState<FlatApplyStatus>("idle");

  useEffect(() => {
    onApplyStatusChange?.(applyStatus);
  }, [applyStatus, onApplyStatusChange]);

  // ---------- Core render helper ----------
  const scaleMax = flatPlacementScaleMax({ edgeWrapMode, decorMode });

  const renderInto = useCallback(
    (canvas: HTMLCanvasElement, v: ViewName, forApply: boolean): boolean => {
      if (!state) return false;
      const a = assets[v];
      const calib = resolveFlatViewCalibration(manifest, colorId, v);
      if (!a?.blank || !calib) return false;
      const enabled = !!state.enabled[v];
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
          artworkCorsClean,
          forceShadingMap: edgeWrapMode,
          edgeWrapMode,
          decorMode,
        });
        return true;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[FlatProductPlacer] render failed:", e);
        return false;
      }
    },
    [state, assets, manifest, colorId, artworkImg, artworkCorsClean, edgeWrapMode, decorMode],
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

  const hasPendingChanges = useCallback((): boolean => {
    if (!state || !artworkImg) return false;
    if (lastAppliedSignatureRef.current === null) return true;
    if (lastAppliedColorRef.current !== colorId) return true;
    return outputSignature(state) !== lastAppliedSignatureRef.current;
  }, [state, artworkImg, colorId]);

  const applyIfNeeded = useCallback(async () => {
    if (!onApply || !state || !artworkImg || assetsLoading) return;
    if (!hasPendingChanges()) return;

    setApplyStatus("saving");
    try {
      await Promise.resolve(
        onApply({ state, renderView: renderViewToCanvas }),
      );
      lastAppliedSignatureRef.current = outputSignature(state);
      lastAppliedColorRef.current = colorId;
      setApplyStatus("saved");
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[FlatProductPlacer] apply error:", e);
      setApplyStatus("error");
      throw e;
    }
  }, [
    onApply,
    state,
    artworkImg,
    assetsLoading,
    hasPendingChanges,
    renderViewToCanvas,
    colorId,
  ]);

  useImperativeHandle(
    ref,
    () => ({ applyIfNeeded, hasPendingChanges }),
    [applyIfNeeded, hasPendingChanges],
  );

  // Seed baseline when resuming a saved design (no upload on open).
  useEffect(() => {
    if (!state || !artworkImg || assetsLoading || resumeBaselineSeededRef.current) return;
    if (!(skipInitialAutoApply || seededAsResumeRef.current)) return;
    lastAppliedSignatureRef.current = outputSignature(state);
    lastAppliedColorRef.current = colorId;
    resumeBaselineSeededRef.current = true;
    setApplyStatus("saved");
  }, [state, artworkImg, assetsLoading, skipInitialAutoApply, colorId]);

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

  const hasDisplayableAssets = availableViews.some((v) => assets[v].blank);

  // ---------- Render guards ----------
  if (!state || (assetsLoading && !hasDisplayableAssets)) {
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

  const calib = resolveFlatViewCalibration(manifest, colorId, state.view);
  const viewAssets = assets[state.view];
  const placement = state.placements[state.view] ?? DEFAULT_ARTWORK_PLACEMENT;
  const viewEnabled = !!state.enabled[state.view];

  const mockupW =
    viewAssets.blank?.naturalWidth || calib?.mockupDims?.width || 1;
  const mockupH =
    viewAssets.blank?.naturalHeight || calib?.mockupDims?.height || 1;
  const edgeGuides =
    edgeWrapMode && calib
      ? flatEdgeWrapGuideRects(calib, viewAssets.mask, mockupW, mockupH)
      : null;
  const placementRect =
    calib
      ? flatPlacementRectPx(calib, viewAssets.mask, mockupW, mockupH, {
          edgeWrapMode,
          decorMode,
        })
      : null;

  // Coverage warnings differ by product type.
  type CoverageWarning = "none" | "trim" | "edge-gap";
  let coverageWarning: CoverageWarning = "none";
  if (calib && artworkImg && viewEnabled && placementRect) {
    const printBounds =
      edgeGuides?.outer ??
      flatPrintBoundsPx(calib, viewAssets.mask, mockupW, mockupH);
    const safeZone = edgeGuides?.inner ?? flatVisibleRectPx(calib, mockupW, mockupH);
    const box = flatArtBox(
      placementRect,
      placement,
      artworkImg.naturalWidth,
      artworkImg.naturalHeight,
    );
    if (edgeWrapMode) {
      if (
        !flatCovers(printBounds, box) ||
        flatInsufficientSafeZoneCoverage(safeZone, box)
      ) {
        coverageWarning = "edge-gap";
      }
    } else if (decorMode) {
      if (!flatCovers(placementRect, box)) {
        coverageWarning = "edge-gap";
      }
    } else if (flatOverflows(placementRect, box)) {
      coverageWarning = "trim";
    }
  }

  const showOverlay =
    overlayVisible &&
    viewEnabled &&
    !!artworkImg &&
    !!calib &&
    !!viewAssets.blank;

  // Layout mirrors HoodieAopPlacer: canvas flex-1 + controls lg:w-80 inside
  // the page's left 2/3 (col-span-2 of the wide 3-column embed grid).
  return (
    <div className="flex w-full flex-col gap-4 lg:flex-row">
      {/* Live canvas + overlay */}
      <div className="relative flex-1 overflow-hidden rounded-lg border border-border bg-card">
        <div
          className="relative flex max-h-[55vh] items-center justify-center bg-zinc-100 p-3 lg:max-h-none lg:aspect-square lg:p-4"
          onClick={() => {
            if (canvasDragRef.current) {
              canvasDragRef.current = false;
              return;
            }
            setOverlayVisible((v) => !v);
          }}
          data-testid="flat-placer-canvas-area"
        >
          <div className="relative max-h-full max-w-full">
            <canvas
              ref={canvasRef}
              className="block max-h-[50vh] max-w-full h-auto w-auto rounded lg:max-h-[78vh]"
              data-testid="flat-placer-canvas"
            />
            {showOverlay && calib && viewAssets.blank && artworkImg && (
              <FlatDesignRectOverlay
                canvasRef={canvasRef}
                view={calib}
                artwork={artworkImg}
                placement={placement}
                edgeWrapMode={edgeWrapMode}
                innerGuideRect={edgeGuides?.inner ?? null}
                outerGuideRect={edgeGuides?.outer ?? null}
                placementRect={placementRect}
                scaleMax={scaleMax}
                onChange={(next) => updatePlacement(state.view, next)}
                onDragActivity={() => {
                  canvasDragRef.current = true;
                }}
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
            {assetsLoading && hasDisplayableAssets && (
              <div className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded bg-background/80 px-2 py-1 text-[10px] text-muted-foreground shadow-sm">
                <Loader2 className="h-3 w-3 animate-spin" /> Updating colour…
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Placement controls (middle column width — mirrors HoodieAopPlacer) */}
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
              max={scaleMax}
              step={0.01}
              value={placement.scale}
              onChange={(e) => setScale(state.view, Number(e.target.value))}
              className="w-full"
              style={{ accentColor: "hsl(var(--primary))" }}
              aria-label="Artwork scale"
            />
            {decorMode && !edgeWrapMode && (
              <p className="text-[10px] text-muted-foreground leading-snug">
                Scale above 100% to zoom in and crop built-in borders. The dashed
                line is the mat opening — keep important details inside it.
              </p>
            )}
            {edgeWrapMode && (
              <p className="text-[10px] text-muted-foreground leading-snug">
                Amber dashed line = safe visible back face. Blue outer line = full
                print canvas (includes edge bleed and side wrap). Scale artwork to
                cover the blue outline and extend past the amber line.
              </p>
            )}
          </div>
        )}

        {viewEnabled && artworkImg && coverageWarning === "trim" && (
          <div className="flex items-start gap-2 rounded border border-amber-400/50 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Artwork extends past the printable area — edges will be trimmed by
              the product mask. Scale down or reposition to keep important details
              visible.
            </span>
          </div>
        )}

        {viewEnabled && artworkImg && coverageWarning === "edge-gap" && decorMode && !edgeWrapMode && (
          <div className="flex items-start gap-2 rounded border border-amber-400/50 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Artwork doesn&apos;t fully cover the mat opening — scale up or
              reposition so the design fills the dashed outline.
            </span>
          </div>
        )}

        {viewEnabled && artworkImg && coverageWarning === "edge-gap" && edgeWrapMode && (
          <div className="flex items-start gap-2 rounded border border-amber-400/50 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Artwork doesn&apos;t fully cover the print area — scale up or
              reposition so the design covers the blue outline and extends past
              the amber safe-zone line for edge printing.
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

        {/* Persist hint — uploads happen on add-to-cart / leave editor */}
        {onApply && artworkImg && (
          <div className="flex items-center justify-center gap-1.5 text-center text-[11px] text-muted-foreground">
            {applyStatus === "saving" ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>Saving design…</span>
              </>
            ) : applyStatus === "error" ? (
              <span className="text-destructive">Couldn't save — try add to cart again</span>
            ) : hasPendingChanges() ? (
              <span className="opacity-80">
                Unsaved changes — saved when you add to cart or leave the editor
              </span>
            ) : (
              <span className="opacity-60">Placement ready</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default FlatProductPlacer;

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
