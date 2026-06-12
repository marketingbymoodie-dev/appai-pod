import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import AdminLayout from "@/components/admin-layout";
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
  flatPlacementScaleMax,
  flatPrintCanvasLayout,
  renderFlatView,
  type CalibratorLayerAdjust,
} from "@/components/designer/FlatProductPlacer/lib/flatRender";
import type { FlatViewCalibration } from "@/pages/embed-design";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
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
  productTypeId: number;
  name: string;
  flatCalibrationStatus: string | null;
  onTheFlyTier?: string | null;
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
    maskUrl: assets.mask ?? baseView.maskUrl,
    shadingUrl: assets.shading ?? baseView.shadingUrl,
    shadingMode: baseView.shadingMode === "blank" ? "map" : baseView.shadingMode ?? "map",
  };
}

function drawPinkReference(
  ctx: CanvasRenderingContext2D,
  pink: HTMLImageElement,
  view: FlatViewCalibration,
  blank: HTMLImageElement,
  mask: HTMLImageElement | null,
  layerAdjust: CalibratorModelEntry,
) {
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
}

function drawMaskDebugOverlay(
  ctx: CanvasRenderingContext2D,
  mask: HTMLImageElement,
  view: FlatViewCalibration,
  blank: HTMLImageElement,
  layerAdjust: CalibratorLayerAdjust,
) {
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
}

export default function FlatCalibrationMapperPage() {
  const productTypeId = 19;
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
  const [artPlacement, setArtPlacement] = useState<ArtworkPlacement>({
    ...DEFAULT_ARTWORK_PLACEMENT,
  });

  const { data, isLoading, refetch } = useQuery<CalibratorState>({
    queryKey: [`/api/admin/flat-calibrator/${productTypeId}`],
    refetchInterval: (q) => {
      const st = q.state.data?.flatCalibrationStatus;
      return st === "running" ? 4000 : false;
    },
  });

  const models = data?.models ?? [];
  const selectedModel = models.find((m) => m.modelId === selectedModelId) ?? models[0];
  const artScaleMax = flatPlacementScaleMax({ edgeWrapMode: true });

  useEffect(() => {
    if (models.length > 0 && !selectedModelId) {
      setSelectedModelId(models[0].modelId);
    }
  }, [models, selectedModelId]);

  useEffect(() => {
    if (selectedModel?.geometry) setGeometry(structuredClone(selectedModel.geometry));
  }, [selectedModel?.modelId, selectedModel?.geometry]);

  const layerAdjust = useCallback(
    (layer: LayerId | "stack"): CalibratorLayerAdjust => {
      if (layer === "stack" || layer === "pink") return geometry.blank;
      return geometry[layer];
    },
    [geometry],
  );

  const patchLayer = useCallback(
    (layer: LayerId | "stack", patch: Partial<CalibratorLayerAdjust>) => {
      setGeometry((prev) => {
        const next = structuredClone(prev);
        const apply = (key: keyof CalibratorModelEntry) => {
          if (key === "sourceCrop") return;
          const cur = next[key] as CalibratorLayerAdjust;
          next[key] = { ...cur, ...patch };
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
      loadImage(model.assets.blank),
      loadImage(model.assets.shading),
      loadImage(model.assets.pink),
      loadImage(model.assets.mask),
      loadImage(testArtUrl),
    ]);

    if (!blankImg) return;

    const layerOnlyPink = activeLayer === "pink" && showPink;
    const layerOnlyMask = activeLayer === "mask" && showMask && !showBlank && !showShading && !artImg;

    if (layerOnlyPink && pinkImg) {
      const layout = flatPrintCanvasLayout(view, { mask: maskImg, blank: blankImg });
      canvas.width = layout.previewW;
      canvas.height = layout.previewH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#d4d4d4";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawPinkReference(ctx, pinkImg, view, blankImg, maskImg, geometry);
    } else if (layerOnlyMask && maskImg) {
      const layout = flatPrintCanvasLayout(view, { mask: maskImg, blank: blankImg });
      canvas.width = layout.previewW;
      canvas.height = layout.previewH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#d4d4d4";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawMaskDebugOverlay(ctx, maskImg, view, blankImg, geometry.mask);
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
        tier: (data?.onTheFlyTier as "flat" | "mesh") ?? "flat",
        edgeWrapMode: true,
        forceShadingMap: true,
        artworkCorsClean: true,
        layerAdjust: {
          blank: geometry.blank,
          mask: geometry.mask,
          shading: geometry.shading,
        },
        previewLayers: {
          blank: showBlank,
          shading: showShading,
          artwork: !!previewArt,
        },
      });

      const ctx = canvas.getContext("2d");
      if (ctx) {
        if (showPink && pinkImg && activeLayer !== "pink") {
          drawPinkReference(ctx, pinkImg, view, blankImg, maskImg, geometry);
        }
        if (showMask && maskImg && activeLayer !== "mask") {
          drawMaskDebugOverlay(ctx, maskImg, view, blankImg, geometry.mask);
        }

        ctx.strokeStyle = "#2563eb";
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
        ctx.setLineDash([]);
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
    data?.onTheFlyTier,
    artScaleMax,
  ]);

  useEffect(() => {
    void renderPreview();
  }, [renderPreview]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/admin/flat-calibrator/${productTypeId}/geometry`, {
        modelId: selectedModelId,
        view: "front",
        geometry,
        publishToManifest: true,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Saved",
        description: "Alignment saved — blank baked into geometry; mask/shading offsets stored.",
      });
      queryClient.invalidateQueries({ queryKey: [`/api/admin/flat-calibrator/${productTypeId}`] });
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const harvestMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/flat-calibrator/${productTypeId}/harvest`);
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Calibrator harvest started",
        description: "Wiping old assets and re-fetching pink/blank/mask/shading from Printify (~30–60 min).",
      });
      queryClient.invalidateQueries({ queryKey: [`/api/admin/flat-calibrator/${productTypeId}`] });
    },
    onError: (e: Error) => toast({ title: "Harvest failed", description: e.message, variant: "destructive" }),
  });

  const wipeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/flat-calibrator/${productTypeId}/wipe`);
      return res.json();
    },
    onSuccess: (body: { removed?: number }) => {
      toast({ title: "Assets wiped", description: `Removed ${body.removed ?? 0} file(s) from Supabase.` });
      queryClient.invalidateQueries({ queryKey: [`/api/admin/flat-calibrator/${productTypeId}`] });
    },
    onError: (e: Error) => toast({ title: "Wipe failed", description: e.message, variant: "destructive" }),
  });

  const activeAdj = layerAdjust(activeLayer === "stack" ? "stack" : activeLayer);
  const isRunning = data?.flatCalibrationStatus === "running";

  return (
    <AdminLayout>
      <div className="flex h-[calc(100vh-4rem)] flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold">Flat Calibration Mapper</h1>
            <p className="text-xs text-muted-foreground">
              Product {productTypeId}: {data?.name ?? "…"} — WYSIWYG preview matches storefront compositing.
            </p>
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
              onClick={() => harvestMutation.mutate()}
              disabled={harvestMutation.isPending || isRunning}
            >
              {isRunning ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3 w-3" />
              )}
              {isRunning ? "Harvesting…" : "Wipe + harvest"}
            </Button>
            <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !selectedModelId}>
              <Save className="mr-1 h-3 w-3" /> Save alignment
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading calibrator…
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
            <div className="w-full shrink-0 space-y-3 overflow-y-auto lg:w-72 lg:max-h-full">
              <div>
                <Label className="text-xs">Phone model</Label>
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
                <div>
                  <Label className="text-xs">Layer scale {(activeAdj.scale * 100).toFixed(0)}%</Label>
                  <Slider
                    min={50}
                    max={150}
                    step={1}
                    value={[Math.round(activeAdj.scale * 100)]}
                    onValueChange={([v]) => patchLayer(activeLayer, { scale: v / 100 })}
                  />
                </div>
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
                        min={Math.round(flatPlacementScaleMax({ edgeWrapMode: true }) * 0.2 * 100)}
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
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-lg border bg-zinc-100 p-4">
              <canvas ref={canvasRef} className="max-h-full max-w-full rounded shadow" />
              <p className="mt-2 max-w-md text-center text-[11px] text-muted-foreground">
                Preview uses the same compositor as the storefront: blank and art are mask-clipped (rounded
                corners + camera cutout), shading applies after art. Blue dashed = print canvas.
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
