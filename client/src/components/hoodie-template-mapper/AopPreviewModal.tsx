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
import type { HoodieView } from "@shared/hoodieTemplate";
import { useHoodieMapperStore } from "./store";
import {
  renderAopPreview,
  renderAopPreviewToCanvas,
  type AopPreviewMode,
  type ArtworkPlacement,
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
    hint: "Artwork stretched once across all panels — typical AOP look.",
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

export default function AopPreviewModal({ open, onOpenChange }: Props) {
  const template = useHoodieMapperStore((s) => s.template);
  const activeView = useHoodieMapperStore((s) => s.view);
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

  // Single-sheet artwork placement (scale + 2D offset). Defaults to
  // identity = previous "stretch across all panels" behaviour. Lets
  // the admin shrink a portrait down to just the hood / shoulders
  // and slide it into position without re-exporting from Photoshop.
  const [placement, setPlacement] = useState<ArtworkPlacement>(DEFAULT_ARTWORK_PLACEMENT);
  const [showDesignRect, setShowDesignRect] = useState(false);
  const placementIsDefault =
    placement.scale === DEFAULT_ARTWORK_PLACEMENT.scale &&
    placement.offsetX === DEFAULT_ARTWORK_PLACEMENT.offsetX &&
    placement.offsetY === DEFAULT_ARTWORK_PLACEMENT.offsetY;

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
      artworkPlacement: placement,
      showDesignRect,
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
    placement,
    showDesignRect,
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
      artworkPlacement: placement,
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

            {/* Single-sheet placement (scale + offset). Per-panel mode
                doesn't have a unified design rect, so hide there. */}
            {mode === "single-sheet" && artworkImg && (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wide text-slate-400">
                    Placement
                  </span>
                  {!placementIsDefault && (
                    <button
                      type="button"
                      onClick={() => setPlacement(DEFAULT_ARTWORK_PLACEMENT)}
                      className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-200"
                      title="Reset to fill-the-hoodie default"
                    >
                      <RotateCcw className="h-3 w-3" /> Reset
                    </button>
                  )}
                </div>
                <PlacementSlider
                  label="Scale"
                  unit="×"
                  precision={2}
                  value={placement.scale}
                  min={0.1}
                  max={4}
                  step={0.01}
                  onChange={(scale) => setPlacement((p) => ({ ...p, scale }))}
                />
                <PlacementSlider
                  label="Offset X"
                  unit="px"
                  precision={0}
                  value={placement.offsetX}
                  min={-800}
                  max={800}
                  step={1}
                  onChange={(offsetX) => setPlacement((p) => ({ ...p, offsetX }))}
                />
                <PlacementSlider
                  label="Offset Y"
                  unit="px"
                  precision={0}
                  value={placement.offsetY}
                  min={-800}
                  max={800}
                  step={1}
                  onChange={(offsetY) => setPlacement((p) => ({ ...p, offsetY }))}
                />
                <ToggleRow
                  label="Show design rect"
                  checked={showDesignRect}
                  onChange={setShowDesignRect}
                />
                <div className="mt-1 rounded border border-slate-800 bg-slate-950/60 px-2 py-1 text-[10px] text-slate-500">
                  Scale shrinks / grows the design rect around the union centre. Offsets
                  slide it in mockup pixels. Areas outside the rect become transparent —
                  the mockup pixels (or shading) show through.
                </div>
              </div>
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
            <div className="flex max-h-full max-w-full items-center justify-center">
              <canvas
                ref={canvasRef}
                className="max-h-[78vh] max-w-full rounded border border-slate-800 bg-black object-contain shadow-xl"
                data-testid="hoodie-aop-preview-canvas"
              />
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
