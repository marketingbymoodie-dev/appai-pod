import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type CalibratorLayerAdjust = {
  offsetX: number;
  offsetY: number;
  scale: number;
};

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
};

type CalibratorState = {
  productTypeId: number;
  name: string;
  flatCalibrationStatus: string | null;
  models: ModelAssets[];
};

const PRINT_GREY = "#d4d4d4";
const NUDGE = 0.005;

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

function layerRect(
  cw: number,
  ch: number,
  adj: CalibratorLayerAdjust,
): { x: number; y: number; width: number; height: number } {
  const baseW = cw * 0.72;
  const baseH = ch * 0.88;
  const w = baseW * adj.scale;
  const h = baseH * adj.scale;
  const x = (cw - w) / 2 + adj.offsetX * cw;
  const y = (ch - h) / 2 + adj.offsetY * ch;
  return { x, y, width: w, height: h };
}

export default function FlatCalibrationMapperPage() {
  const productTypeId = 19;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [activeLayer, setActiveLayer] = useState<LayerId | "stack">("stack");
  const [geometry, setGeometry] = useState<CalibratorModelEntry>(defaultEntry());
  const [showPink, setShowPink] = useState(true);
  const [showBlank, setShowBlank] = useState(true);
  const [showShading, setShowShading] = useState(true);
  const [showMask, setShowMask] = useState(false);
  const [testArtUrl, setTestArtUrl] = useState<string | null>(null);
  const [artPlacement, setArtPlacement] = useState({ offsetX: 0, offsetY: 0, scale: 1 });

  const { data, isLoading, refetch } = useQuery<CalibratorState>({
    queryKey: [`/api/admin/flat-calibrator/${productTypeId}`],
    refetchInterval: (q) => {
      const st = q.state.data?.flatCalibrationStatus;
      return st === "running" ? 4000 : false;
    },
  });

  const models = data?.models ?? [];
  const selectedModel = models.find((m) => m.modelId === selectedModelId) ?? models[0];

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
      if (layer === "stack") return geometry.blank;
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
        } else {
          apply(layer);
        }
        return next;
      });
    },
    [],
  );

  const renderPreview = useCallback(async () => {
    const canvas = canvasRef.current;
    const model = selectedModel;
    if (!canvas || !model) return;

    const cw = 420;
    const ch = Math.round(cw * (2220 / 1311));
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = PRINT_GREY;
    ctx.fillRect(0, 0, cw, ch);

    const [blankImg, shadeImg, pinkImg, maskImg, artImg] = await Promise.all([
      loadImage(model.assets.blank),
      loadImage(model.assets.shading),
      loadImage(model.assets.pink),
      loadImage(model.assets.mask),
      loadImage(testArtUrl),
    ]);

    const blankR = layerRect(cw, ch, geometry.blank);
    const shadeR = layerRect(cw, ch, geometry.shading);
    const pinkR = layerRect(cw, ch, geometry.blank);

    if (showBlank && blankImg) {
      ctx.drawImage(blankImg, blankR.x, blankR.y, blankR.width, blankR.height);
    }

    if (artImg) {
      const artR = layerRect(cw, ch, {
        offsetX: geometry.blank.offsetX + artPlacement.offsetX,
        offsetY: geometry.blank.offsetY + artPlacement.offsetY,
        scale: geometry.blank.scale * artPlacement.scale,
      });
      ctx.drawImage(artImg, artR.x, artR.y, artR.width, artR.height);
    }

    if (showShading && shadeImg) {
      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = 0.85;
      ctx.drawImage(shadeImg, shadeR.x, shadeR.y, shadeR.width, shadeR.height);
      ctx.restore();
    }

    if (showMask && maskImg) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.drawImage(maskImg, blankR.x, blankR.y, blankR.width, blankR.height);
      ctx.restore();
    }

    if (showPink && pinkImg) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.drawImage(pinkImg, pinkR.x, pinkR.y, pinkR.width, pinkR.height);
      ctx.restore();
    }

    ctx.strokeStyle = "#2563eb";
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(2, 2, cw - 4, ch - 4);
    ctx.setLineDash([]);
  }, [selectedModel, geometry, showBlank, showShading, showMask, showPink, testArtUrl, artPlacement]);

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
      toast({ title: "Saved", description: "Layer alignment saved to geometry.json and manifest." });
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
        description: "Wiping old assets and re-fetching pink/blank/mask/shading from Printify (~5–15 min).",
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
              Product {productTypeId}: {data?.name ?? "…"} — align blank, mask, and shading layers per phone model.
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
            <div className="w-full shrink-0 space-y-3 lg:w-64">
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

              <div className="space-y-2">
                <Label className="text-xs">Fine position</Label>
                <div className="grid grid-cols-3 gap-1">
                  <div />
                  <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => patchLayer(activeLayer, { offsetY: activeAdj.offsetY - NUDGE })}>
                    <ArrowUp className="h-3 w-3" />
                  </Button>
                  <div />
                  <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => patchLayer(activeLayer, { offsetX: activeAdj.offsetX - NUDGE })}>
                    <ArrowLeft className="h-3 w-3" />
                  </Button>
                  <div className="flex h-8 items-center justify-center text-[10px] text-muted-foreground">nudge</div>
                  <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => patchLayer(activeLayer, { offsetX: activeAdj.offsetX + NUDGE })}>
                    <ArrowRight className="h-3 w-3" />
                  </Button>
                  <div />
                  <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => patchLayer(activeLayer, { offsetY: activeAdj.offsetY + NUDGE })}>
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                  <div />
                </div>
                <div>
                  <Label className="text-xs">Scale {(activeAdj.scale * 100).toFixed(0)}%</Label>
                  <Slider
                    min={50}
                    max={150}
                    step={1}
                    value={[Math.round(activeAdj.scale * 100)]}
                    onValueChange={([v]) => patchLayer(activeLayer, { scale: v / 100 })}
                  />
                </div>
              </div>

              <div>
                <Label className="text-xs">Test artwork URL</Label>
                <Input
                  className="mt-1 h-8 text-xs"
                  placeholder="https://…"
                  value={testArtUrl ?? ""}
                  onChange={(e) => setTestArtUrl(e.target.value || null)}
                />
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-lg border bg-zinc-100 p-4">
              <canvas ref={canvasRef} className="max-h-full max-w-full rounded shadow" />
              <p className="mt-2 text-[11px] text-muted-foreground">
                Blue dashed = print canvas. Toggle pink reference to compare against Printify magenta mockup.
              </p>
              {selectedModel && !selectedModel.assets.blank && (
                <p className="mt-1 text-xs text-amber-700">
                  No blank asset for this model — run Wipe + harvest first.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
