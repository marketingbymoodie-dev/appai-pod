import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Redirect, useRoute } from "wouter";
import AdminLayout from "@/components/admin-layout";
import FlatDesignRectOverlay from "@/components/designer/FlatProductPlacer/FlatDesignRectOverlay";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  DEFAULT_ARTWORK_PLACEMENT,
  type ArtworkPlacement,
} from "@/components/hoodie-template-mapper/lib/aopPreview";
import {
  adjustCalibratorDrawRect,
  flatArtBox,
  flatCovers,
  flatOverflows,
  flatPlacementScaleMax,
  flatPrintCanvasLayout,
  flatVisibleRectPx,
  getWeaveConfig,
  renderFlatView,
  resetWeaveConfig,
  setWeaveConfig,
  type CalibratorLayerAdjust,
  type Rect,
  type WeaveConfig,
} from "@/components/designer/FlatProductPlacer/lib/flatRender";
import type { FlatViewCalibration } from "@/pages/embed-design";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";

type LayerId = "blank" | "mask" | "shading" | "pink";

type CalibratorModelEntry = {
  blank: CalibratorLayerAdjust;
  mask: CalibratorLayerAdjust;
  shading: CalibratorLayerAdjust;
  sourceCrop?: { x: number; y: number; width: number; height: number } | null;
};

type ModelAssets = {
  modelId: string;
  name: string;
  assets: {
    pink: string | null;
    blank: string | null;
    mask: string | null;
    shading: string | null;
  };
  geometry: CalibratorModelEntry;
  baseView: FlatViewCalibration | null;
};

type CalibratorState = {
  blueprintId?: number;
  name: string;
  category?: string;
  harvestComplete?: boolean;
  harvestOutcome?: "none" | "ready" | "unsupported" | "failed";
  harvestError?: string;
  modelPickerLabel?: "phone" | "variant" | null;
  edgeWrap?: boolean;
  models: ModelAssets[];
};

const NUDGE = 0.005;
const ART_NUDGE = 0.01;

function defaultEntry(): CalibratorModelEntry {
  return {
    blank: { offsetX: 0, offsetY: 0, scale: 1 },
    mask: { offsetX: 0, offsetY: 0, scale: 1 },
    shading: { offsetX: 0, offsetY: 0, scale: 1 },
    sourceCrop: null,
  };
}

function loadImage(url: string | null): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function loadImageFirst(...urls: (string | null | undefined)[]): Promise<HTMLImageElement | null> {
  for (const url of urls) {
    const img = await loadImage(url ?? null);
    if (img) return img;
  }
  return null;
}

function getWhiteArtwork(): Promise<HTMLImageElement> {
  return new Promise((resolve) => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const cctx = c.getContext("2d");
    if (cctx) {
      cctx.fillStyle = "#ffffff";
      cctx.fillRect(0, 0, 64, 64);
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = c.toDataURL("image/png");
  });
}

let whiteArtPromise: Promise<HTMLImageElement> | null = null;
function loadWhiteArtwork(): Promise<HTMLImageElement> {
  if (!whiteArtPromise) whiteArtPromise = getWhiteArtwork();
  return whiteArtPromise;
}

function buildCalibratorView(
  baseView: FlatViewCalibration | null | undefined,
  assets: ModelAssets["assets"],
): FlatViewCalibration | null {
  if (!baseView?.printFileDims) return null;
  return {
    ...baseView,
    maskUrl: baseView.maskUrl ?? assets.mask ?? null,
    shadingUrl: baseView.shadingUrl ?? assets.shading ?? null,
    shadingMode: baseView.shadingMode === "blank" ? "map" : baseView.shadingMode ?? "map",
  };
}

function mockupCanvasRect(view: FlatViewCalibration, blank: HTMLImageElement): Rect {
  const w = blank.naturalWidth || blank.width || view.mockupDims?.width || 1;
  const h = blank.naturalHeight || blank.height || view.mockupDims?.height || 1;
  return { x: 0, y: 0, width: w, height: h };
}

function drawPinkReference(
  ctx: CanvasRenderingContext2D,
  pink: HTMLImageElement,
  view: FlatViewCalibration,
  blank: HTMLImageElement,
  mask: HTMLImageElement | null,
  layerAdjust: CalibratorModelEntry,
  edgeWrapMode: boolean,
) {
  if (edgeWrapMode) {
    const layout = flatPrintCanvasLayout(view, { mask, blank });
    const dest = adjustCalibratorDrawRect(
      layout.imageDraw,
      layerAdjust.blank,
      layout.previewW,
      layout.previewH,
    );
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.drawImage(pink, dest.x, dest.y, dest.width, dest.height);
    ctx.restore();
    return;
  }

  const canvas = mockupCanvasRect(view, blank);
  const dest = adjustCalibratorDrawRect(canvas, layerAdjust.blank, canvas.width, canvas.height);
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.drawImage(pink, dest.x, dest.y, dest.width, dest.height);
  ctx.restore();
}

function drawMaskDebugOverlay(
  ctx: CanvasRenderingContext2D,
  mask: HTMLImageElement,
  view: FlatViewCalibration,
  blank: HTMLImageElement,
  layerAdjust: CalibratorLayerAdjust,
  edgeWrapMode: boolean,
) {
  if (edgeWrapMode) {
    const layout = flatPrintCanvasLayout(view, { mask, blank });
    const dest = adjustCalibratorDrawRect(
      layout.imageDraw,
      layerAdjust,
      layout.previewW,
      layout.previewH,
    );
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.drawImage(mask, dest.x, dest.y, dest.width, dest.height);
    ctx.restore();
    return;
  }

  const canvas = mockupCanvasRect(view, blank);
  const dest = adjustCalibratorDrawRect(canvas, layerAdjust, canvas.width, canvas.height);
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.drawImage(mask, dest.x, dest.y, dest.width, dest.height);
  ctx.restore();
}

export default function FlatCalibrationMapperPage() {
  const [, params] = useRoute("/admin/platform/flat-calibrator/:blueprintId");
  const blueprintId = params?.blueprintId ? parseInt(params.blueprintId, 10) : NaN;
  const calibratorQueryKey = Number.isFinite(blueprintId)
    ? [`/api/platform/flat-calibrator/${blueprintId}`]
    : ["flat-calibrator-invalid"];

  const { data: platformStatus, isLoading: platformLoading } = useQuery<{ isPlatformAdmin: boolean }>({
    queryKey: ["/api/platform/admin/status"],
  });

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [activeLayer, setActiveLayer] = useState<LayerId | "stack">("stack");
  const [geometry, setGeometry] = useState<CalibratorModelEntry>(defaultEntry());
  const [showPink, setShowPink] = useState(false);
  const [showBlank, setShowBlank] = useState(true);
  const [showShading, setShowShading] = useState(true);
  const [showMask, setShowMask] = useState(false);
  const [testArtUrl, setTestArtUrl] = useState<string | null>(null);
  const [testArtImg, setTestArtImg] = useState<HTMLImageElement | null>(null);
  const [artPlacement, setArtPlacement] = useState<ArtworkPlacement>({
    ...DEFAULT_ARTWORK_PLACEMENT,
  });
  const [harvestPhase, setHarvestPhase] = useState<"idle" | "running" | "complete">("idle");
  const [weavePreview, setWeavePreview] = useState(false);
  const [weaveCfg, setWeaveCfgState] = useState<WeaveConfig>(() => getWeaveConfig());

  const patchWeave = useCallback((patch: Partial<WeaveConfig>) => {
    setWeaveCfgState(setWeaveConfig(patch));
  }, []);

  const { data, isLoading, refetch } = useQuery<CalibratorState>({
    queryKey: calibratorQueryKey,
    enabled: Number.isFinite(blueprintId) && !!platformStatus?.isPlatformAdmin,
    refetchInterval: harvestPhase === "running" ? 15_000 : false,
  });

  const models = data?.models ?? [];
  const selectedModel = models.find((m) => m.modelId === selectedModelId) ?? models[0];
  const edgeWrapMode = !!data?.edgeWrap;
  const artScaleMax = flatPlacementScaleMax({ edgeWrapMode });
  const showModelPicker = models.length > 1;
  const modelPickerLabel =
    data?.modelPickerLabel === "phone"
      ? "Phone model"
      : data?.modelPickerLabel === "variant"
        ? "Variant"
        : "Model";

  useEffect(() => {
    if (data?.harvestComplete && harvestPhase === "running") {
      setHarvestPhase("complete");
      toast({
        title: "Harvest complete",
        description: "Assets are ready — align layers and save, then publish from Platform Catalog.",
      });
    } else if (data?.harvestComplete && harvestPhase === "idle") {
      setHarvestPhase("complete");
    } else if (
      harvestPhase === "running" &&
      (data?.harvestOutcome === "failed" || data?.harvestOutcome === "unsupported")
    ) {
      setHarvestPhase("idle");
      toast({
        title: data.harvestOutcome === "unsupported" ? "Not a flat product" : "Harvest failed",
        description: data.harvestError || "Flat calibration assets could not be harvested.",
        variant: "destructive",
      });
    }
  }, [data?.harvestComplete, data?.harvestOutcome, data?.harvestError, harvestPhase, toast]);

  useEffect(() => {
    if (models.length > 0 && !selectedModelId) {
      setSelectedModelId(models[0].modelId);
    }
  }, [models, selectedModelId]);

  useEffect(() => {
    if (selectedModel?.geometry) {
      const g = structuredClone(selectedModel.geometry);
      g.blank.scale = 1;
      g.mask.scale = 1;
      g.shading.scale = 1;
      setGeometry(g);
    }
  }, [selectedModel?.modelId, selectedModel?.geometry]);

  useEffect(() => {
    if (!testArtUrl) {
      setTestArtImg(null);
      return;
    }
    let cancelled = false;
    void loadImage(testArtUrl).then((img) => {
      if (!cancelled) setTestArtImg(img);
    });
    return () => {
      cancelled = true;
    };
  }, [testArtUrl]);

  const calibratorView = useMemo(
    () => (selectedModel ? buildCalibratorView(selectedModel.baseView, selectedModel.assets) : null),
    [selectedModel],
  );

  const printLayout = useMemo(() => {
    if (!calibratorView) return null;
    if (edgeWrapMode) return flatPrintCanvasLayout(calibratorView);
    const mockupW = calibratorView.mockupDims?.width ?? 900;
    const pfW = calibratorView.printFileDims?.width ?? 1;
    const pfH = calibratorView.printFileDims?.height ?? 1;
    const mockupH = calibratorView.mockupDims?.height ?? Math.max(1, Math.round(mockupW * (pfH / pfW)));
    const visible = flatVisibleRectPx(calibratorView, mockupW, mockupH);
    return {
      previewW: mockupW,
      previewH: mockupH,
      printCanvas: visible,
      phoneBack: visible,
      safeZone: visible,
      imageDraw: { x: 0, y: 0, width: mockupW, height: mockupH },
      sourceCrop: null,
    };
  }, [calibratorView, edgeWrapMode]);

  const artCoversPrintArea = useMemo(() => {
    if (!testArtImg || !printLayout) return true;
    const box = flatArtBox(
      printLayout.printCanvas,
      artPlacement,
      testArtImg.naturalWidth || testArtImg.width,
      testArtImg.naturalHeight || testArtImg.height,
    );
    if (edgeWrapMode) return flatCovers(printLayout.printCanvas, box);
    return !flatOverflows(printLayout.printCanvas, box);
  }, [testArtImg, printLayout, artPlacement, edgeWrapMode]);

  const layerAdjust = useCallback(
    (layer: LayerId | "stack"): CalibratorLayerAdjust => {
      if (layer === "stack" || layer === "pink") return geometry.blank;
      return geometry[layer];
    },
    [geometry],
  );

  const patchLayer = useCallback(
    (layer: LayerId | "stack", patch: Partial<CalibratorLayerAdjust>) => {
      const { scale: _scale, ...offsetOnly } = patch;
      setGeometry((prev) => {
        const next = structuredClone(prev);
        const apply = (key: keyof CalibratorModelEntry) => {
          if (key === "sourceCrop") return;
          const cur = next[key] as CalibratorLayerAdjust;
          next[key] = { ...cur, ...offsetOnly, scale: 1 };
        };
        if (layer === "stack") {
          apply("blank");
          apply("mask");
          apply("shading");
        } else if (layer !== "pink") {
          apply(layer);
        }
        return next;
      });
    },
    [],
  );

  const lockedLayerAdjust = useMemo(
    () => ({
      blank: { ...geometry.blank, scale: 1 },
      mask: { ...geometry.mask, scale: 1 },
      shading: { ...geometry.shading, scale: 1 },
    }),
    [geometry],
  );

  const patchArt = useCallback((patch: Partial<ArtworkPlacement>) => {
    setArtPlacement((prev) => ({ ...prev, ...patch }));
  }, []);

  const renderPreview = useCallback(async () => {
    const canvas = canvasRef.current;
    const model = selectedModel;
    if (!canvas || !model) return;

    const view = buildCalibratorView(model.baseView, model.assets);
    if (!view) {
      canvas.width = 420;
      canvas.height = 280;
      const ctx = canvas.getContext("2d");
      ctx?.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const [blankImg, shadeImg, pinkImg, maskImg, artImg] = await Promise.all([
      loadImageFirst(model.assets.blank),
      loadImageFirst(model.assets.shading, view.shadingUrl),
      loadImageFirst(model.assets.pink),
      loadImageFirst(model.assets.mask, view.maskUrl),
      loadImage(testArtUrl),
    ]);

    if (!blankImg) return;

    const layerOnlyPink = activeLayer === "pink" && showPink;
    const layerOnlyMask = activeLayer === "mask" && showMask && !showBlank && !showShading && !artImg;

    const previewW = edgeWrapMode
      ? flatPrintCanvasLayout(view, { mask: maskImg, blank: blankImg }).previewW
      : mockupCanvasRect(view, blankImg).width;
    const previewH = edgeWrapMode
      ? flatPrintCanvasLayout(view, { mask: maskImg, blank: blankImg }).previewH
      : mockupCanvasRect(view, blankImg).height;

    if (layerOnlyPink && pinkImg) {
      canvas.width = previewW;
      canvas.height = previewH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = edgeWrapMode ? "#d4d4d4" : "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawPinkReference(ctx, pinkImg, view, blankImg, maskImg, geometry, edgeWrapMode);
    } else if (layerOnlyMask && maskImg) {
      canvas.width = previewW;
      canvas.height = previewH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = edgeWrapMode ? "#d4d4d4" : "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawMaskDebugOverlay(ctx, maskImg, view, blankImg, geometry.mask, edgeWrapMode);
    } else {
      const shadingOnly =
        activeLayer === "shading" && showShading && !showBlank && !artImg && shadeImg;
      const previewArt = artImg ?? (shadingOnly ? await loadWhiteArtwork() : null);
      const previewPlacement: ArtworkPlacement = artImg
        ? artPlacement
        : { offsetX: 0, offsetY: 0, scale: artScaleMax };

      renderFlatView({
        target: canvas,
        blank: blankImg,
        mask: maskImg,
        shading: shadeImg,
        artwork: previewArt,
        view,
        placement: previewPlacement,
        tier: "flat",
        edgeWrapMode,
        decorMode: weavePreview && !edgeWrapMode,
        forceShadingMap: edgeWrapMode,
        artworkCorsClean: true,
        layerAdjust: lockedLayerAdjust,
        previewLayers: {
          blank: showBlank,
          shading: showShading,
          artwork: !!previewArt,
        },
      });

      const ctx = canvas.getContext("2d");
      if (ctx) {
        if (showPink && pinkImg && activeLayer !== "pink") {
          drawPinkReference(ctx, pinkImg, view, blankImg, maskImg, geometry, edgeWrapMode);
        }
        if (showMask && maskImg && activeLayer !== "mask") {
          drawMaskDebugOverlay(ctx, maskImg, view, blankImg, geometry.mask, edgeWrapMode);
        }
      }
    }
  }, [
    selectedModel,
    geometry,
    showBlank,
    showShading,
    showMask,
    showPink,
    testArtUrl,
    artPlacement,
    activeLayer,
    edgeWrapMode,
    artScaleMax,
    lockedLayerAdjust,
    weavePreview,
    weaveCfg,
  ]);

  useEffect(() => {
    void renderPreview();
  }, [renderPreview]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/platform/flat-calibrator/${blueprintId}/geometry`, {
        modelId: selectedModelId,
        view: "front",
        geometry,
        publishToManifest: true,
        version: 1,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Saved",
        description: "Alignment saved to canonical library draft manifest.",
      });
      queryClient.invalidateQueries({ queryKey: calibratorQueryKey });
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const harvestMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/platform/canonical/${blueprintId}/harvest`, { version: 1 });
      return res.json();
    },
    onSuccess: () => {
      setHarvestPhase("running");
      toast({
        title: "Harvest started",
        description: "Running in background — this page will update when assets are ready (~15–30 min for phone cases).",
      });
      void refetch();
    },
    onError: (e: Error) => toast({ title: "Harvest failed", description: e.message, variant: "destructive" }),
  });

  const wipeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/platform/canonical/${blueprintId}/wipe`, { version: 1 });
      return res.json();
    },
    onSuccess: (body: { removed?: number }) => {
      setHarvestPhase("idle");
      toast({ title: "Assets wiped", description: `Removed ${body.removed ?? 0} file(s) from Supabase.` });
      queryClient.invalidateQueries({ queryKey: calibratorQueryKey });
    },
    onError: (e: Error) => toast({ title: "Wipe failed", description: e.message, variant: "destructive" }),
  });

  if (platformLoading) {
    return (
      <AdminLayout>
        <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking access…
        </div>
      </AdminLayout>
    );
  }

  if (!platformStatus?.isPlatformAdmin) {
    return <Redirect to="/admin" />;
  }

  if (!Number.isFinite(blueprintId)) {
    return (
      <AdminLayout>
        <div className="p-6 text-sm text-muted-foreground">
          Invalid blueprint. Open from{" "}
          <Link href="/admin/platform/catalog" className="text-primary underline">
            Platform Catalog
          </Link>
          .
        </div>
      </AdminLayout>
    );
  }

  const activeAdj = layerAdjust(activeLayer === "stack" ? "stack" : activeLayer);
  const isHarvesting = harvestPhase === "running";
  const isHarvested = harvestPhase === "complete";

  return (
    <AdminLayout>
      <div className="flex h-[calc(100vh-4rem)] flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold">Platform Flat Calibrator</h1>
            <p className="text-xs text-muted-foreground">
              Blueprint {blueprintId}: {data?.name ?? "…"} — shared canonical library (operator only).
            </p>
            <Link href="/admin/platform/catalog" className="text-xs text-primary underline">
              ← Back to platform catalog
            </Link>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
              <RefreshCw className="mr-1 h-3 w-3" /> Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => wipeMutation.mutate()}
              disabled={wipeMutation.isPending}
            >
              <Trash2 className="mr-1 h-3 w-3" /> Wipe assets
            </Button>
            <Button
              size="sm"
              variant={isHarvested ? "outline" : "default"}
              className={isHarvested ? "border-green-600 text-green-700" : undefined}
              onClick={() => harvestMutation.mutate()}
              disabled={isHarvesting || harvestMutation.isPending}
            >
              {isHarvesting ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Harvesting…
                </>
              ) : isHarvested ? (
                <>
                  <Check className="mr-1 h-3 w-3" />
                  Harvested
                </>
              ) : (
                <>
                  <RefreshCw className="mr-1 h-3 w-3" />
                  Wipe + harvest
                </>
              )}
            </Button>
            <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !selectedModelId}>
              <Save className="mr-1 h-3 w-3" /> Save alignment
            </Button>
          </div>
        </div>

        {(data?.harvestOutcome === "failed" || data?.harvestOutcome === "unsupported") && data.harvestError && (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {data.harvestError}
            {/\(AOP\)/i.test(data.name ?? "") && (
              <>
                {" "}
                Re-tag this blueprint as <strong>AOP</strong> in Operator Catalog.
              </>
            )}
          </p>
        )}

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading calibrator…
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row lg:overflow-hidden">
            <div className="w-full shrink-0 space-y-3 overflow-y-auto lg:w-72 lg:max-h-full">
              {showModelPicker && (
                <div>
                  <Label className="text-xs">{modelPickerLabel}</Label>
                  <select
                    className="mt-1 w-full rounded border bg-background px-2 py-1.5 text-sm"
                    value={selectedModelId}
                    onChange={(e) => setSelectedModelId(e.target.value)}
                  >
                    {models.map((m) => (
                      <option key={m.modelId} value={m.modelId}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {isHarvesting && (
                <p className="flex items-center gap-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Harvesting assets… checking every 15s
                </p>
              )}

              <div className="space-y-2 rounded border p-2">
                <div className="text-xs font-medium">Visible layers</div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Pink reference (magenta mockup)</Label>
                  <Switch checked={showPink} onCheckedChange={setShowPink} />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Blank</Label>
                  <Switch checked={showBlank} onCheckedChange={setShowBlank} />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Shading</Label>
                  <Switch checked={showShading} onCheckedChange={setShowShading} />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Mask overlay</Label>
                  <Switch checked={showMask} onCheckedChange={setShowMask} />
                </div>
              </div>

              <div>
                <Label className="text-xs">Edit layer</Label>
                <select
                  className="mt-1 w-full rounded border bg-background px-2 py-1.5 text-sm"
                  value={activeLayer}
                  onChange={(e) => setActiveLayer(e.target.value as LayerId | "stack")}
                >
                  <option value="stack">All layers (stack)</option>
                  <option value="blank">Blank only</option>
                  <option value="shading">Shading only</option>
                  <option value="mask">Mask only</option>
                  <option value="pink">Pink reference only</option>
                </select>
              </div>

              <div className="space-y-2 rounded border p-2">
                <Label className="text-xs font-medium">Layer alignment</Label>
                <div className="grid grid-cols-3 gap-1">
                  <div />
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => patchLayer(activeLayer, { offsetY: activeAdj.offsetY - NUDGE })}
                  >
                    <ArrowUp className="h-3 w-3" />
                  </Button>
                  <div />
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => patchLayer(activeLayer, { offsetX: activeAdj.offsetX - NUDGE })}
                  >
                    <ArrowLeft className="h-3 w-3" />
                  </Button>
                  <div className="flex h-8 items-center justify-center text-[10px] text-muted-foreground">nudge</div>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => patchLayer(activeLayer, { offsetX: activeAdj.offsetX + NUDGE })}
                  >
                    <ArrowRight className="h-3 w-3" />
                  </Button>
                  <div />
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => patchLayer(activeLayer, { offsetY: activeAdj.offsetY + NUDGE })}
                  >
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                  <div />
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Nudge blank, mask, and shading together (or pick a single layer). Scale is fixed — use
                  test artwork controls to check print coverage.
                </p>
              </div>

              <div className="space-y-2 rounded border p-2">
                <Label className="text-xs font-medium">Test artwork</Label>
                <Input
                  className="h-8 text-xs"
                  placeholder="https://…"
                  value={testArtUrl ?? ""}
                  onChange={(e) => setTestArtUrl(e.target.value || null)}
                />
                {testArtUrl && (
                  <>
                    <div className="grid grid-cols-3 gap-1">
                      <div />
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => patchArt({ offsetY: artPlacement.offsetY - ART_NUDGE })}
                      >
                        <ArrowUp className="h-3 w-3" />
                      </Button>
                      <div />
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => patchArt({ offsetX: artPlacement.offsetX - ART_NUDGE })}
                      >
                        <ArrowLeft className="h-3 w-3" />
                      </Button>
                      <div className="flex h-8 items-center justify-center text-[10px] text-muted-foreground">
                        art
                      </div>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => patchArt({ offsetX: artPlacement.offsetX + ART_NUDGE })}
                      >
                        <ArrowRight className="h-3 w-3" />
                      </Button>
                      <div />
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => patchArt({ offsetY: artPlacement.offsetY + ART_NUDGE })}
                      >
                        <ArrowDown className="h-3 w-3" />
                      </Button>
                      <div />
                    </div>
                    <div>
                      <Label className="text-xs">
                        Art scale {Math.round(artPlacement.scale * 100)}%
                      </Label>
                      <Slider
                        min={Math.round(flatPlacementScaleMax({ edgeWrapMode }) * 0.2 * 100)}
                        max={Math.round(artScaleMax * 100)}
                        step={1}
                        value={[Math.round(artPlacement.scale * 100)]}
                        onValueChange={([v]) => patchArt({ scale: v / 100 })}
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 w-full text-xs"
                      onClick={() => setArtPlacement({ ...DEFAULT_ARTWORK_PLACEMENT })}
                    >
                      Reset art placement
                    </Button>
                  </>
                )}
                {testArtUrl && !artCoversPrintArea && (
                  <div className="flex items-start gap-2 rounded border border-amber-400/50 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      {edgeWrapMode
                        ? "Art doesn't fully cover the print canvas — scale up or reposition so the design reaches all four edges of the blue outline."
                        : "Art extends past the printable area — scale down or reposition so edges stay inside the dashed outline (mask will trim overflow)."}
                    </span>
                  </div>
                )}
              </div>

              {!edgeWrapMode && (
                <div className="space-y-3 rounded border p-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium">Weave texture (decor)</Label>
                    <Switch checked={weavePreview} onCheckedChange={setWeavePreview} />
                  </div>
                  {weavePreview && (
                    <>
                      {!testArtUrl && (
                        <p className="rounded border border-amber-400/50 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                          Weave is applied to the artwork — paste a test artwork URL above to see it.
                        </p>
                      )}
                      <div>
                        <Label className="text-xs">
                          Horizontal thread height {weaveCfg.weftMin}–{weaveCfg.weftMax}px
                        </Label>
                        <Slider
                          min={2}
                          max={40}
                          step={1}
                          value={[weaveCfg.weftMin, weaveCfg.weftMax]}
                          onValueChange={([lo, hi]) => patchWeave({ weftMin: lo, weftMax: hi })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">
                          Vertical thread width {weaveCfg.warpMin}–{weaveCfg.warpMax}px
                        </Label>
                        <Slider
                          min={2}
                          max={40}
                          step={1}
                          value={[weaveCfg.warpMin, weaveCfg.warpMax]}
                          onValueChange={([lo, hi]) => patchWeave({ warpMin: lo, warpMax: hi })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">
                          Pattern size ×{weaveCfg.scale.toFixed(2)}
                        </Label>
                        <Slider
                          min={25}
                          max={400}
                          step={5}
                          value={[Math.round(weaveCfg.scale * 100)]}
                          onValueChange={([v]) => patchWeave({ scale: v / 100 })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Thread irregularity {weaveCfg.slub}</Label>
                        <Slider
                          min={0}
                          max={60}
                          step={1}
                          value={[weaveCfg.slub]}
                          onValueChange={([v]) => patchWeave({ slub: v })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Cell noise {weaveCfg.cellNoise}</Label>
                        <Slider
                          min={0}
                          max={40}
                          step={1}
                          value={[weaveCfg.cellNoise]}
                          onValueChange={([v]) => patchWeave({ cellNoise: v })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">
                          Groove darkness {128 - weaveCfg.grooveTone}
                        </Label>
                        <Slider
                          min={0}
                          max={126}
                          step={2}
                          value={[128 - weaveCfg.grooveTone]}
                          onValueChange={([v]) => patchWeave({ grooveTone: 128 - v })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">
                          Ridge brightness {weaveCfg.ridgeTone - 128}
                        </Label>
                        <Slider
                          min={0}
                          max={127}
                          step={1}
                          value={[weaveCfg.ridgeTone - 128]}
                          onValueChange={([v]) => patchWeave({ ridgeTone: 128 + v })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">
                          Texture strength {Math.round(weaveCfg.overlayAlpha * 100)}%
                        </Label>
                        <Slider
                          min={0}
                          max={100}
                          step={5}
                          value={[Math.round(weaveCfg.overlayAlpha * 100)]}
                          onValueChange={([v]) => patchWeave({ overlayAlpha: v / 100 })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">
                          Darkening {Math.round(weaveCfg.multiplyAlpha * 100)}%
                        </Label>
                        <Slider
                          min={0}
                          max={100}
                          step={5}
                          value={[Math.round(weaveCfg.multiplyAlpha * 100)]}
                          onValueChange={([v]) => patchWeave({ multiplyAlpha: v / 100 })}
                        />
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 w-full text-xs"
                        onClick={() => setWeaveCfgState(resetWeaveConfig())}
                      >
                        Reset weave to defaults
                      </Button>
                      <p className="text-[10px] text-muted-foreground">
                        Tuning values are saved in this browser only — customers keep the shipped
                        defaults. When it looks right, send me these numbers and I&apos;ll bake them
                        in as the new defaults.
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-zinc-100 p-3">
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
                <div className="relative inline-block max-h-[min(58vh,calc(100vh-18rem))] max-w-full overflow-hidden rounded shadow leading-none">
                  <canvas
                    ref={canvasRef}
                    className="block h-auto max-h-[min(58vh,calc(100vh-18rem))] w-auto max-w-full"
                  />
                  {testArtImg && calibratorView && printLayout && (
                    <FlatDesignRectOverlay
                      canvasRef={canvasRef}
                      view={calibratorView}
                      artwork={testArtImg}
                      placement={artPlacement}
                      edgeWrapMode={edgeWrapMode}
                      showInnerGuide={!edgeWrapMode}
                      showOuterGuide={edgeWrapMode}
                      innerGuideRect={edgeWrapMode ? null : printLayout.printCanvas}
                      outerGuideRect={edgeWrapMode ? printLayout.printCanvas : null}
                      placementRect={printLayout.printCanvas}
                      scaleMax={artScaleMax}
                      onChange={setArtPlacement}
                    />
                  )}
                </div>
              </div>
              <p className="mt-2 shrink-0 max-w-md self-center text-center text-[11px] text-muted-foreground">
                {edgeWrapMode
                  ? "Blue dashed = print canvas — scale artwork until it covers all four edges. Drag handles or use sidebar nudge. Blank redraws cameras and rounded case lip on top of art."
                  : "Dashed outline = printable area on the mockup — artwork is clipped to the harvested mask. Nudge blank, mask, and shading layers if registration is off."}
              </p>
              {selectedModel && !selectedModel.assets.blank && (
                <p className="mt-1 text-xs text-amber-700">
                  No blank asset for this model — run Wipe + harvest first.
                </p>
              )}
              {selectedModel && !selectedModel.baseView && (
                <p className="mt-1 text-xs text-amber-700">
                  No harvest geometry for this model — run Wipe + harvest, then align and save.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
