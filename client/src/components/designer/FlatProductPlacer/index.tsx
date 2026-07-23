import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Eye, EyeOff, ImagePlus, Loader2, RotateCcw, AlertTriangle } from "lucide-react";
import {
  FinePositionNudge,
  mockupDeltaFromScreenNudge,
} from "@/components/designer/placementNudge";
import {
  DEFAULT_ARTWORK_PLACEMENT,
  type ArtworkPlacement,
} from "@/components/hoodie-template-mapper/lib/aopPreview";
import FlatDesignRectOverlay from "./FlatDesignRectOverlay";
import {
  loadFlatImage,
  flatCalibrationSwappedToLandscape,
  orientFlatHarvestPixelsForLandscape,
  resolveFlatBlank,
  resolveFlatViewCalibration,
  resolveCalibratorLayerAdjust,
  type FlatViewName,
} from "./lib/flatAssets";
import { Slider } from "@/components/ui/slider";
import {
  flatArtBox,
  flatCovers,
  flatOverflows,
  flatPlacementRectPx,
  flatPlacementScaleMax,
  flatPrintCanvasLayout,
  flatPrintCanvasPreviewDims,
  getFabricBlendConfig,
  renderFlatView,
  resetFabricBlendConfig,
  setFabricBlendConfig,
  FLAT_SCALE_MIN,
  type FabricBlendConfig,
  type Rect,
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
 *   - Front + back placements are independent unless `linkSides` is on.
 *     When linked, scale matches and offsetX is mirrored (offsetY shared).
 *   - Back defaults OFF, and the Back toggle only appears when the manifest
 *     (and the selected colour's blank) actually has a back view.
 *   - Placement scale is capped at 1.0 (Printify clamps placement scale), so
 *     the UI never implies more coverage than the print file provides.
 */

type ViewName = FlatViewName;

export type FlatProductPlacerState = {
  /** Currently visible view. */
  view: ViewName;
  /** Per-view placement (normalized to the print rect). Independent per view unless linked. */
  placements: Record<ViewName, ArtworkPlacement>;
  /** Per-view enabled flag. Back defaults false. */
  enabled: Record<ViewName, boolean>;
  /**
   * When true (and both views exist), edits to scale/position on either side
   * update the other: same scale + offsetY, mirrored offsetX.
   */
  linkSides: boolean;
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
  /**
   * Upload + persist. Pass `{ force: true }` to re-save after size/colour changes.
   * Returns false when skipped (assets still loading / nothing to do).
   */
  applyIfNeeded: (opts?: { force?: boolean }) => Promise<boolean>;
  hasPendingChanges: () => boolean;
};

export type FlatProductPlacerProps = {
  manifest: FlatCalibrationManifest;
  /** Currently selected colour/model id — picks the blank from `manifest.blanks`. */
  colorId: string;
  /**
   * When print geometry is unchanged but the blank photo swaps (e.g. decor frame
   * colour), keep per-view placements. Defaults to `colorId`.
   */
  placementGeometryKey?: string;
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
  /** Woven fabric procedural texture (tapestry; admin-toggleable). */
  fabricWeave?: boolean;
  /** When size orientation is landscape but manifest was harvested portrait-only. */
  landscapeOrientation?: boolean;
  /** Fallback blank photo when manifest lacks per-orientation blanks (tapestry). */
  blankUrlOverride?: string | null;
  /**
   * Selected size aspect (`3:4`, `4:3`, …). Required when `blankUrlOverride` is a
   * square catalog size blank so the dashed guide matches that size (wall decals).
   */
  catalogSizeAspectRatio?: string | null;
  /**
   * On-demand lifestyle/context action under "Placement ready".
   * `active` = shimmer + clickable; inactive = dimmed, no shimmer.
   */
  lifestyleAction?: {
    onClick: () => void;
    loading?: boolean;
    active?: boolean;
    label: string;
    loadingLabel?: string;
    idleHint?: string;
    error?: string | null;
  } | null;
  /** When set, canvas shows this image (e.g. Printify Context) instead of live placer. */
  canvasOverrideUrl?: string | null;
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
    linkSides: s.linkSides,
  });
}

/** Mirror horizontal offset so left/right stay visually consistent across faces. */
function mirrorLinkedPlacement(source: ArtworkPlacement): ArtworkPlacement {
  return {
    scale: source.scale,
    offsetX: -source.offsetX,
    offsetY: source.offsetY,
  };
}

function otherView(view: ViewName): ViewName {
  return view === "front" ? "back" : "front";
}

function applyPlacementToState(
  prev: FlatProductPlacerState,
  view: ViewName,
  next: ArtworkPlacement,
  availableViews: ViewName[],
): FlatProductPlacerState {
  const placements = { ...prev.placements, [view]: next };
  if (prev.linkSides && availableViews.includes(otherView(view))) {
    placements[otherView(view)] = mirrorLinkedPlacement(next);
  }
  return { ...prev, placements };
}

function buildInitialState(
  availableViews: ViewName[],
  saved?: Partial<FlatProductPlacerState> | null,
): FlatProductPlacerState {
  const canLink = availableViews.includes("front") && availableViews.includes("back");
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
    // Double-sided products default to linked so front/back stay matched.
    linkSides: canLink,
    artworkUrl: saved?.artworkUrl ?? null,
  };
  if (!saved) return base;
  const linkSides =
    typeof saved.linkSides === "boolean" ? saved.linkSides : base.linkSides;
  let placements = { ...base.placements, ...(saved.placements ?? {}) };
  if (linkSides && canLink) {
    const sourceView: ViewName =
      saved.view === "back" && placements.back ? "back" : "front";
    const source = placements[sourceView] ?? DEFAULT_ARTWORK_PLACEMENT;
    placements = {
      ...placements,
      [sourceView]: { ...source },
      [otherView(sourceView)]: mirrorLinkedPlacement(source),
    };
  }
  return {
    ...base,
    ...saved,
    placements,
    enabled: { ...base.enabled, ...(saved.enabled ?? {}) },
    linkSides,
  };
}

const FlatProductPlacer = forwardRef<FlatProductPlacerHandle, FlatProductPlacerProps>(
  function FlatProductPlacer(
    {
      manifest,
      colorId,
      placementGeometryKey,
      artworkSourceUrl,
      initialState,
      onApply,
      onChange,
      onApplyStatusChange,
      onAssetsFailed,
      skipInitialAutoApply = false,
      edgeWrapMode = false,
      decorMode = false,
      fabricWeave = false,
      landscapeOrientation = false,
      blankUrlOverride = null,
      catalogSizeAspectRatio = null,
      lifestyleAction = null,
      canvasOverrideUrl = null,
    },
    ref,
  ) {
  const geometryKey = placementGeometryKey ?? colorId;
  const refitCatalogSizeGuide = !!blankUrlOverride && !!catalogSizeAspectRatio;
  const calibOpts = useMemo(
    () => ({
      landscapeOrientation,
      sizeAspectRatio: catalogSizeAspectRatio,
      refitCatalogSizeGuide,
    }),
    [landscapeOrientation, catalogSizeAspectRatio, refitCatalogSizeGuide],
  );
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
        // Use colorId (e.g. 20x30:white) for mask/geometry — size-only geometryKey
        // misses decorPerSize geometryByBlank and falls back to the shared 11×14 mask.
        const calib = resolveFlatViewCalibration(manifest, colorId, v, calibOpts);
        const blankUrl =
          v === "front" && blankUrlOverride ? blankUrlOverride : blank[v];
        if (!calib || !blankUrl) continue;
        const [b, m, s] = await Promise.all([
          loadFlatImage(blankUrl),
          !refitCatalogSizeGuide && calib.maskUrl
            ? loadFlatImage(calib.maskUrl)
            : Promise.resolve(null),
          calib.shadingUrl &&
          (edgeWrapMode ||
            calib.shadingMode === "map" ||
            !!calib.printBoundsNormalized)
            ? loadFlatImage(calib.shadingUrl)
            : Promise.resolve(null),
        ]);
        if (
          !refitCatalogSizeGuide &&
          flatCalibrationSwappedToLandscape(manifest, colorId, v, landscapeOrientation)
        ) {
          const oriented = await orientFlatHarvestPixelsForLandscape(m, s);
          next[v] = { blank: b, mask: oriented.mask, shading: oriented.shading };
        } else {
          next[v] = { blank: b, mask: m, shading: s };
        }
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
  }, [availableViews, manifest, blank, colorId, edgeWrapMode, onAssetsFailed, geometryKey, calibOpts, blankUrlOverride]);

  useEffect(() => {
    if (!assetsLoading && availableViews.length === 0) {
      onAssetsFailed?.("No printable views available");
    }
  }, [assetsLoading, availableViews.length, onAssetsFailed]);

  // ---------- Customer state ----------
  const [state, setState] = useState<FlatProductPlacerState | null>(null);
  const lastAppliedSignatureRef = useRef<string | null>(null);
  const lastAppliedColorRef = useRef<string | null>(null);
  const prevGeometryKeyRef = useRef<string | null>(null);
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

  // Reset placement when print geometry changes (size/model), not blank colour alone.
  useEffect(() => {
    if (prevGeometryKeyRef.current === null) {
      prevGeometryKeyRef.current = geometryKey;
      return;
    }
    if (prevGeometryKeyRef.current === geometryKey) return;
    prevGeometryKeyRef.current = geometryKey;
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
  }, [geometryKey, availableViews]);

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

  // ---------- TEMP tapestry blend knobs (browser-local until baked) ----------
  const [blendCfg, setBlendCfgState] = useState<FabricBlendConfig>(() =>
    getFabricBlendConfig(),
  );
  const patchBlend = useCallback((patch: Partial<FabricBlendConfig>) => {
    setBlendCfgState(setFabricBlendConfig(patch));
  }, []);

  // ---------- Core render helper ----------
  const scaleMax = flatPlacementScaleMax({ edgeWrapMode, decorMode });

  const renderInto = useCallback(
    (canvas: HTMLCanvasElement, v: ViewName, forApply: boolean): boolean => {
      if (!state) return false;
      const a = assets[v];
      const calib = resolveFlatViewCalibration(manifest, colorId, v, calibOpts);
      if (!a?.blank || !calib) return false;
      const enabled = !!state.enabled[v];
      try {
        // Read live blend knobs (blendCfg in deps forces re-render on slider change).
        void blendCfg;
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
          fabricWeave,
          cropToBackFace: false,
          sizeId: colorId,
          layerAdjust: resolveCalibratorLayerAdjust(manifest, colorId, v),
        });
        return true;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[FlatProductPlacer] render failed:", e);
        return false;
      }
    },
    [
      state,
      assets,
      manifest,
      colorId,
      artworkImg,
      artworkCorsClean,
      edgeWrapMode,
      decorMode,
      fabricWeave,
      calibOpts,
      blendCfg,
    ],
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

  const applyIfNeeded = useCallback(async (opts?: { force?: boolean }): Promise<boolean> => {
    if (!onApply || !state || !artworkImg || assetsLoading) return false;
    if (!opts?.force && !hasPendingChanges()) return false;

    setApplyStatus("saving");
    try {
      await Promise.resolve(
        onApply({ state, renderView: renderViewToCanvas }),
      );
      lastAppliedSignatureRef.current = outputSignature(state);
      lastAppliedColorRef.current = colorId;
      setApplyStatus("saved");
      return true;
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

  const setLinkSides = useCallback(
    (on: boolean) => {
      setState((prev) => {
        if (!prev) return prev;
        if (!on) return { ...prev, linkSides: false };
        const source = prev.placements[prev.view] ?? DEFAULT_ARTWORK_PLACEMENT;
        const placements = {
          ...prev.placements,
          [prev.view]: { ...source },
          [otherView(prev.view)]: mirrorLinkedPlacement(source),
        };
        return { ...prev, linkSides: true, placements };
      });
    },
    [],
  );

  const updatePlacement = useCallback(
    (view: ViewName, next: ArtworkPlacement) => {
      setState((prev) =>
        prev ? applyPlacementToState(prev, view, next, availableViews) : prev,
      );
    },
    [availableViews],
  );

  const setScale = useCallback(
    (view: ViewName, scale: number) => {
      setState((prev) => {
        if (!prev) return prev;
        const cur = prev.placements[view] ?? DEFAULT_ARTWORK_PLACEMENT;
        return applyPlacementToState(
          prev,
          view,
          { ...cur, scale },
          availableViews,
        );
      });
    },
    [availableViews],
  );

  const resetView = useCallback(
    (view: ViewName) => {
      setState((prev) => {
        if (!prev) return prev;
        return applyPlacementToState(
          prev,
          view,
          { ...DEFAULT_ARTWORK_PLACEMENT },
          availableViews,
        );
      });
    },
    [availableViews],
  );

  const nudgePlacement = useCallback(
    (view: ViewName, axis: "x" | "y", direction: 1 | -1) => {
      setState((prev) => {
        if (!prev) return prev;
        const cal = resolveFlatViewCalibration(manifest, colorId, view, calibOpts);
        const va = assets[view];
        const canvas = canvasRef.current;
        if (!cal || !va.blank || !canvas) return prev;
        const mW = edgeWrapMode
          ? flatPrintCanvasPreviewDims(cal).width
          : va.blank.naturalWidth || cal.mockupDims?.width || 1;
        const mH = edgeWrapMode
          ? flatPrintCanvasPreviewDims(cal).height
          : va.blank.naturalHeight || cal.mockupDims?.height || 1;
        const pRect = flatPlacementRectPx(cal, va.mask, mW, mH, {
          edgeWrapMode,
          decorMode,
        });
        const cr = canvas.getBoundingClientRect();
        const deltaMock = mockupDeltaFromScreenNudge(
          axis,
          direction,
          cr,
          mW,
          mH,
        );
        const dOff =
          axis === "x"
            ? deltaMock / Math.max(1, pRect.width)
            : deltaMock / Math.max(1, pRect.height);
        const cur = prev.placements[view] ?? DEFAULT_ARTWORK_PLACEMENT;
        const clamp = (v: number) => Math.max(-0.75, Math.min(0.75, v));
        const next: ArtworkPlacement = {
          ...cur,
          offsetX:
            axis === "x" ? clamp(cur.offsetX + dOff) : cur.offsetX,
          offsetY:
            axis === "y" ? clamp(cur.offsetY + dOff) : cur.offsetY,
        };
        return applyPlacementToState(prev, view, next, availableViews);
      });
    },
    [manifest, colorId, assets, edgeWrapMode, decorMode, availableViews, calibOpts],
  );

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

  const calib = resolveFlatViewCalibration(manifest, colorId, state.view, calibOpts);
  const viewAssets = assets[state.view];
  const placement = state.placements[state.view] ?? DEFAULT_ARTWORK_PLACEMENT;
  const viewEnabled = !!state.enabled[state.view];

  const mockupW =
    viewAssets.blank?.naturalWidth || calib?.mockupDims?.width || 1;
  const mockupH =
    viewAssets.blank?.naturalHeight || calib?.mockupDims?.height || 1;

  const printCanvasLayout =
    edgeWrapMode && calib
      ? flatPrintCanvasLayout(calib, { mask: viewAssets.mask, blank: viewAssets.blank })
      : null;
  const displayMockupW = printCanvasLayout?.previewW ?? mockupW;
  const displayMockupH = printCanvasLayout?.previewH ?? mockupH;

  const placementRect =
    edgeWrapMode && calib
      ? printCanvasLayout!.printCanvas
      : calib
        ? flatPlacementRectPx(calib, viewAssets.mask, mockupW, mockupH, {
            edgeWrapMode,
            decorMode,
          })
        : null;

  const displayEdgeGuides =
    edgeWrapMode && calib
      ? { inner: printCanvasLayout!.safeZone, outer: printCanvasLayout!.printCanvas }
      : null;

  // Coverage warnings differ by product type.
  type CoverageWarning = "none" | "trim" | "edge-gap";
  let coverageWarning: CoverageWarning = "none";
  if (calib && artworkImg && viewEnabled && placementRect) {
    const box = flatArtBox(
      placementRect,
      placement,
      artworkImg.naturalWidth,
      artworkImg.naturalHeight,
    );
    if (edgeWrapMode) {
      if (!flatCovers(placementRect, box)) {
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
      {/* Live canvas + overlay (or lifestyle/context override) */}
      <div className="relative flex-1 overflow-hidden rounded-lg border border-border bg-card">
        <div
          className={
            // Phone cases are tall — square crop clips the bottom.
            // Framed decor (esp. landscape 36×24) must not use lg:aspect-square either.
            edgeWrapMode
              ? "relative flex max-h-[85vh] min-h-[360px] items-center justify-center bg-zinc-100 p-2 lg:max-h-[90vh] lg:p-3"
              : decorMode
                ? "relative flex max-h-[55vh] items-center justify-center bg-zinc-100 p-3 lg:max-h-[85vh] lg:p-4"
                : "relative flex max-h-[55vh] items-center justify-center bg-zinc-100 p-3 lg:max-h-none lg:aspect-square lg:p-4"
          }
          onClick={() => {
            if (canvasOverrideUrl) return;
            if (canvasDragRef.current) {
              canvasDragRef.current = false;
              return;
            }
            setOverlayVisible((v) => !v);
          }}
          data-testid="flat-placer-canvas-area"
        >
          <div className="relative flex max-h-full max-w-full items-center justify-center overflow-hidden">
            <canvas
              ref={canvasRef}
              className={
                canvasOverrideUrl
                  ? "hidden"
                  : edgeWrapMode
                    ? "block max-h-[80vh] max-w-full h-auto w-auto rounded lg:max-h-[88vh]"
                    : decorMode
                      ? "block max-h-[50vh] max-w-full h-auto w-auto rounded lg:max-h-[82vh]"
                      : "block max-h-[50vh] max-w-full h-auto w-auto rounded lg:max-h-[78vh]"
              }
              data-testid="flat-placer-canvas"
            />
            {canvasOverrideUrl ? (
              <img
                src={canvasOverrideUrl}
                alt="Lifestyle context"
                className={
                  decorMode
                    ? "block max-h-[50vh] max-w-full h-auto w-auto rounded object-contain lg:max-h-[82vh]"
                    : "block max-h-[50vh] max-w-full h-auto w-auto rounded object-contain lg:max-h-[78vh]"
                }
                data-testid="flat-placer-context-preview"
              />
            ) : (
              showOverlay &&
              calib &&
              viewAssets.blank &&
              artworkImg && (
                <FlatDesignRectOverlay
                  canvasRef={canvasRef}
                  view={calib}
                  artwork={artworkImg}
                  placement={placement}
                  edgeWrapMode={edgeWrapMode}
                  innerGuideRect={displayEdgeGuides?.inner ?? null}
                  outerGuideRect={displayEdgeGuides?.outer ?? null}
                  placementRect={placementRect}
                  scaleMax={scaleMax}
                  onChange={(next) => updatePlacement(state.view, next)}
                  onDragActivity={() => {
                    canvasDragRef.current = true;
                  }}
                />
              )
            )}
            {!canvasOverrideUrl && !artworkImg && !artworkLoading && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-xs text-muted-foreground">
                Create a design to preview it on the product →
              </div>
            )}
            {!canvasOverrideUrl && artworkLoading && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Loading artwork…
              </div>
            )}
            {!canvasOverrideUrl && assetsLoading && hasDisplayableAssets && (
              <div className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded bg-background/80 px-2 py-1 text-[10px] text-muted-foreground shadow-sm">
                <Loader2 className="h-3 w-3 animate-spin" /> Updating colour…
              </div>
            )}
            {canvasOverrideUrl && (
              <div className="pointer-events-none absolute left-2 top-2 rounded bg-background/85 px-2 py-1 text-[10px] font-medium text-foreground shadow-sm">
                Context
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
                {availableViews.length > 1 && (
                  <label
                    className="flex cursor-pointer items-center gap-1.5 normal-case tracking-normal text-muted-foreground"
                    title="Keep front and back scale matched, with mirrored left/right placement"
                  >
                    <input
                      type="checkbox"
                      checked={!!state.linkSides}
                      onChange={(e) => setLinkSides(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-border accent-[hsl(var(--primary))]"
                      aria-label="Link sides"
                    />
                    <span className="text-[11px] font-medium">Link sides</span>
                  </label>
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
                Blue dashed line = full print canvas (Printify grey box). Amber
                line = safe visible back face. Scale artwork to cover the blue
                outline on all four sides.
              </p>
            )}
            <div className="mt-2">
              <FinePositionNudge
                onNudge={(axis, dir) => nudgePlacement(state.view, axis, dir)}
                hint="Drag the artwork box to move freely — it snaps to center within 10px. Tap the mockup backdrop to show or hide the bounding box. Right-click a nudge arrow for the opposite direction."
              />
            </div>
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
              reposition the design to fill to the dashed outline if you want
              full coverage.
            </span>
          </div>
        )}

        {viewEnabled && artworkImg && coverageWarning === "edge-gap" && edgeWrapMode && (
          <div className="flex items-start gap-2 rounded border border-amber-400/50 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Artwork doesn&apos;t fully cover the print canvas — scale up or
              reposition so the design reaches all four edges of the blue
              outline. Uncovered edges may not print.
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

        {lifestyleAction && (
          <div className="flex flex-col gap-1 pt-1">
            <button
              type="button"
              onClick={() => {
                if (!lifestyleAction.active || lifestyleAction.loading) return;
                lifestyleAction.onClick();
              }}
              disabled={!lifestyleAction.active || !!lifestyleAction.loading}
              data-testid="button-lifestyle-shot-placer"
              className={`flex w-full items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-semibold transition-opacity ${
                lifestyleAction.active && !lifestyleAction.loading
                  ? "border-foreground/80 bg-foreground text-background"
                  : "border-border bg-muted text-muted-foreground opacity-45 cursor-not-allowed"
              }`}
            >
              {lifestyleAction.loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
              ) : (
                <ImagePlus className="h-3.5 w-3.5 shrink-0" />
              )}
              <span
                className={
                  lifestyleAction.active && !lifestyleAction.loading
                    ? "shimmer-text-white"
                    : undefined
                }
              >
                {lifestyleAction.loading
                  ? lifestyleAction.loadingLabel || "Generating…"
                  : lifestyleAction.label}
              </span>
            </button>
            {lifestyleAction.error ? (
              <p className="text-center text-[11px] text-destructive" data-testid="text-lifestyle-shot-error-placer">
                {lifestyleAction.error}
              </p>
            ) : !lifestyleAction.active && !lifestyleAction.loading ? (
              <p className="text-center text-[10px] text-muted-foreground">
                {lifestyleAction.idleHint ||
                  "Finish placement (or generate artwork) to enable Lifestyle Shot"}
              </p>
            ) : null}
          </div>
        )}

        {fabricWeave && (
          <div
            className="mt-2 space-y-2 rounded-md border border-dashed border-amber-500/60 bg-amber-50/60 p-3"
            data-testid="panel-fabric-blend-temp"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-900">
                TEMP — tapestry blend
              </p>
              <button
                type="button"
                className="text-[10px] text-amber-900/80 underline-offset-2 hover:underline"
                onClick={() => setBlendCfgState(resetFabricBlendConfig())}
              >
                Reset
              </button>
            </div>
            <p className="text-[10px] text-amber-900/70">
              Tune Artwork vs Printify, then send me the numbers (or Copy) to bake as merchant defaults.
            </p>
            {(
              [
                {
                  key: "transparency" as const,
                  label: "Transparency",
                  min: 0,
                  max: 100,
                  step: 1,
                  value: Math.round(blendCfg.transparency * 100),
                  format: (v: number) => `${v}%`,
                  toPatch: (v: number) => ({ transparency: v / 100 }),
                },
                {
                  key: "cream" as const,
                  label: "Cream tint",
                  min: 0,
                  max: 100,
                  step: 1,
                  value: Math.round(blendCfg.cream * 100),
                  format: (v: number) => `${v}%`,
                  toPatch: (v: number) => ({ cream: v / 100 }),
                },
                {
                  key: "darkening" as const,
                  label: "Darkening",
                  min: 0,
                  max: 100,
                  step: 1,
                  value: Math.round(blendCfg.darkening * 100),
                  format: (v: number) => `${v}%`,
                  toPatch: (v: number) => ({ darkening: v / 100 }),
                },
                {
                  key: "vibrance" as const,
                  label: "Vibrance",
                  min: 0,
                  max: 200,
                  step: 5,
                  value: Math.round(blendCfg.vibrance * 100),
                  format: (v: number) => `${v}%`,
                  toPatch: (v: number) => ({ vibrance: v / 100 }),
                },
                {
                  key: "grain" as const,
                  label: "Grain",
                  min: 0,
                  max: 100,
                  step: 1,
                  value: Math.round(blendCfg.grain * 100),
                  format: (v: number) => `${v}%`,
                  toPatch: (v: number) => ({ grain: v / 100 }),
                },
                {
                  key: "speckle" as const,
                  label: "Speckle",
                  min: 0,
                  max: 100,
                  step: 1,
                  value: Math.round(blendCfg.speckle * 100),
                  format: (v: number) => `${v}%`,
                  toPatch: (v: number) => ({ speckle: v / 100 }),
                },
                {
                  key: "linealX" as const,
                  label: "Lineal X (spacing)",
                  min: 2,
                  max: 24,
                  step: 1,
                  value: Math.round(blendCfg.linealX),
                  format: (v: number) => `${v}px`,
                  toPatch: (v: number) => ({ linealX: v }),
                },
                {
                  key: "linealY" as const,
                  label: "Lineal Y (spacing)",
                  min: 2,
                  max: 24,
                  step: 1,
                  value: Math.round(blendCfg.linealY),
                  format: (v: number) => `${v}px`,
                  toPatch: (v: number) => ({ linealY: v }),
                },
                {
                  key: "linealAlpha" as const,
                  label: "Lineal strength",
                  min: 0,
                  max: 100,
                  step: 1,
                  value: Math.round(blendCfg.linealAlpha * 100),
                  format: (v: number) => `${v}%`,
                  toPatch: (v: number) => ({ linealAlpha: v / 100 }),
                },
              ] as const
            ).map((row) => (
              <div key={row.key} className="space-y-1">
                <div className="flex justify-between text-[11px] text-amber-950">
                  <span>{row.label}</span>
                  <span className="tabular-nums opacity-80">{row.format(row.value)}</span>
                </div>
                <Slider
                  min={row.min}
                  max={row.max}
                  step={row.step}
                  value={[row.value]}
                  onValueChange={([v]) => patchBlend(row.toPatch(v))}
                />
              </div>
            ))}
            <button
              type="button"
              className="w-full rounded border border-amber-700/40 bg-white/70 px-2 py-1.5 text-[11px] font-medium text-amber-950 hover:bg-white"
              onClick={() => {
                const json = JSON.stringify(blendCfg, null, 2);
                void navigator.clipboard?.writeText(json);
              }}
            >
              Copy values
            </button>
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
