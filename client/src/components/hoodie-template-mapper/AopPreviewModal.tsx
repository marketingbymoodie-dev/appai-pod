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
  computeDesignRect,
  renderAopPreview,
  renderAopPreviewToCanvas,
  type AopPreviewMode,
  type ArtworkPlacement,
  type DesignRectInfo,
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
  const actions = useHoodieMapperStore((s) => s.actions);
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
  const [showDesignRect, setShowDesignRect] = useState(true);
  const placementIsDefault =
    placement.scale === DEFAULT_ARTWORK_PLACEMENT.scale &&
    placement.offsetX === DEFAULT_ARTWORK_PLACEMENT.offsetX &&
    placement.offsetY === DEFAULT_ARTWORK_PLACEMENT.offsetY;

  // Background colour painted under the artwork in every print panel
  // (and ALL of any panel excluded from single-sheet). null = off.
  // Stored as state-only so the admin can experiment with colours
  // without dirtying the template.
  const [backgroundColor, setBackgroundColor] = useState<string | null>(null);

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
      backgroundColor,
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
    backgroundColor,
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
      backgroundColor,
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
                <div className="mt-1 text-[10px] text-slate-500">
                  Design rect now adopts your artwork's aspect ratio so portraits stay tall
                  and landscapes stay wide. Drag the artwork on the preview to move; drag a
                  corner to resize uniformly.
                </div>
              </div>
            )}

            {/* Background colour picker — base fabric colour. Sits
                under the artwork inside every print panel and fills
                panels excluded from single-sheet entirely. Useful for
                matching Printify's brown / red / etc. base hoodies. */}
            <BackgroundColorPicker value={backgroundColor} onChange={setBackgroundColor} />

            {/* Single-sheet panel inclusion — multi-select that maps
                to MaskLayer.includeInSingleSheet. Lets the admin
                shrink the design canvas to e.g. body+hood only. */}
            {mode === "single-sheet" && (
              <SingleSheetPanelPicker
                layers={template.views[view]?.layers ?? []}
                onToggle={(id, include) =>
                  actions.patchLayer(id, { includeInSingleSheet: include })
                }
                onPreset={(panelKeys) => {
                  const layers = template.views[view]?.layers ?? [];
                  for (const layer of layers) {
                    if (layer.isExclusion) continue;
                    const isOn =
                      panelKeys === "all"
                        ? true
                        : panelKeys === "none"
                          ? false
                          : layer.panelKey
                            ? panelKeys.includes(layer.panelKey)
                            : false;
                    actions.patchLayer(layer.id, { includeInSingleSheet: isOn });
                  }
                }}
              />
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
            <div className="relative flex max-h-full max-w-full items-center justify-center">
              <canvas
                ref={canvasRef}
                className="max-h-[78vh] max-w-full rounded border border-slate-800 bg-black object-contain shadow-xl"
                data-testid="hoodie-aop-preview-canvas"
              />
              {mockupImg && mode === "single-sheet" && artworkImg && (
                <DesignRectHandlesOverlay
                  canvasRef={canvasRef}
                  template={template}
                  view={view}
                  mockup={mockupImg}
                  artwork={artworkImg}
                  placement={placement}
                  onChange={setPlacement}
                />
              )}
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

/**
 * Native colour picker for the AOP background fill. Includes a small
 * preset palette of common Printify base colours so the admin can
 * pick "the brown one" without dialling RGB. Set to null disables
 * the fill (panels show mockup pixels through artwork transparency,
 * which is the original behaviour).
 */
const BG_PRESETS: Array<{ label: string; hex: string }> = [
  { label: "Brown", hex: "#8a4a2a" },
  { label: "Charcoal", hex: "#2f2f2f" },
  { label: "Red", hex: "#a13d2a" },
  { label: "Forest", hex: "#2d4a2a" },
  { label: "Navy", hex: "#1f2c4a" },
  { label: "Cream", hex: "#e8dccd" },
];

function BackgroundColorPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const enabled = value !== null;
  const colour = value ?? "#8a4a2a";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-slate-400">
          Background colour
        </span>
        <label className="flex cursor-pointer items-center gap-1 text-[10px] text-slate-400">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onChange(e.target.checked ? colour : null)}
            className="h-3 w-3 cursor-pointer accent-fuchsia-500"
          />
          on
        </label>
      </div>
      {enabled && (
        <>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={colour}
              onChange={(e) => onChange(e.target.value)}
              className="h-7 w-10 cursor-pointer rounded border border-slate-700 bg-slate-950 p-0"
              title="Pick fabric colour"
            />
            <input
              type="text"
              value={colour}
              onChange={(e) => onChange(e.target.value)}
              className="h-7 flex-1 rounded border border-slate-700 bg-slate-950 px-2 text-[11px] font-mono text-slate-200 focus:border-fuchsia-500 focus:outline-none"
              spellCheck={false}
            />
          </div>
          <div className="mt-1 grid grid-cols-6 gap-1">
            {BG_PRESETS.map((p) => (
              <button
                key={p.hex}
                type="button"
                onClick={() => onChange(p.hex)}
                title={`${p.label} · ${p.hex}`}
                className="h-5 w-full rounded border border-slate-800 transition hover:scale-110 hover:border-slate-500"
                style={{ background: p.hex }}
              />
            ))}
          </div>
          <div className="mt-1 text-[10px] text-slate-500">
            Sits under the artwork inside every print panel — fills transparent regions of
            your art and any panel excluded from single-sheet. Mockup shading multiplies
            on top so it looks like dyed fabric.
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Multi-select picker that drives `MaskLayer.includeInSingleSheet`
 * via the store. Showing this in the AOP modal keeps the test loop
 * tight: tweak panel inclusion and immediately see the design canvas
 * recompute. The persisted flag means the choice survives reloads
 * unless the admin opts back in.
 */
function SingleSheetPanelPicker({
  layers,
  onToggle,
  onPreset,
}: {
  layers: import("@shared/hoodieTemplate").MaskLayer[];
  onToggle: (id: string, include: boolean) => void;
  onPreset: (
    panelKeys:
      | "all"
      | "none"
      | Array<import("@shared/hoodieTemplate").HoodiePanelKey>,
  ) => void;
}) {
  const printLayers = layers.filter((l) => !l.isExclusion);
  if (printLayers.length === 0) return null;
  const inCount = printLayers.filter((l) => l.includeInSingleSheet !== false).length;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-slate-400">
          Single-sheet panels
        </span>
        <span className="text-[10px] text-slate-500">
          {inCount}/{printLayers.length}
        </span>
      </div>
      {/* Quick presets — common compositions the admin reaches for. */}
      <div className="mb-1 grid grid-cols-3 gap-1">
        <button
          type="button"
          onClick={() => onPreset("all")}
          className="rounded border border-slate-800 bg-slate-950 px-1 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
        >
          All
        </button>
        <button
          type="button"
          onClick={() =>
            onPreset(["front_left", "front_right", "left_hood", "right_hood", "back"])
          }
          className="rounded border border-slate-800 bg-slate-950 px-1 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
          title="Front body + hood + back only — sleeves / cuffs / waistband / pocket excluded"
        >
          Body+hood
        </button>
        <button
          type="button"
          onClick={() => onPreset("none")}
          className="rounded border border-slate-800 bg-slate-950 px-1 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
        >
          None
        </button>
      </div>
      <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-slate-800 bg-slate-950/50 p-1">
        {printLayers.map((l) => {
          const include = l.includeInSingleSheet !== false;
          return (
            <li key={l.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-slate-800/60">
                <input
                  type="checkbox"
                  checked={include}
                  onChange={(e) => onToggle(l.id, e.target.checked)}
                  className="h-3 w-3 cursor-pointer accent-fuchsia-500"
                />
                <span className="flex-1 truncate text-slate-300" title={l.name}>
                  {l.name}
                </span>
                {l.panelKey && (
                  <span className="text-[10px] text-slate-500">{l.panelKey}</span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
      <div className="mt-1 text-[10px] text-slate-500">
        Excluded panels still show the background colour (and shading), but no artwork.
        The design canvas shrinks to the bounding box of the included panels only.
      </div>
    </div>
  );
}

/**
 * Interactive overlay that floats above the AOP preview canvas and
 * exposes drag-to-translate + corner-drag-to-resize gestures bound
 * to `ArtworkPlacement`. Aspect ratio is locked — the rect always
 * reflects the artwork's natural shape (computed by
 * `computeDesignRect`), so corner drags only ever scale uniformly,
 * never squish.
 *
 * Coordinate model:
 *   - The overlay is `inset-0` over the canvas's display rect, so a
 *     mockup-px point (mx, my) maps to CSS by `mx / mockupW * 100%`.
 *   - Drag gestures convert pointer-px deltas → mockup-px deltas via
 *     `mockupW / canvas.clientWidth` (and equivalent for Y), so the
 *     interaction stays accurate at any display size.
 *   - Corner drag keeps the *opposite* corner pinned and snaps the
 *     rect's height to the artwork aspect, so the resize feels like
 *     dragging Photoshop's transform handles.
 */
function DesignRectHandlesOverlay({
  canvasRef,
  template,
  view,
  mockup,
  artwork,
  placement,
  onChange,
}: {
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  template: import("@shared/hoodieTemplate").HoodieTemplate;
  view: HoodieView;
  mockup: HTMLImageElement;
  artwork: HTMLImageElement;
  placement: ArtworkPlacement;
  onChange: (next: ArtworkPlacement) => void;
}) {
  const info: DesignRectInfo | null = useMemo(
    () => computeDesignRect(template, view, artwork, placement),
    [template, view, artwork, placement],
  );

  // We need to know the canvas's natural (mockup) size to convert
  // mockup-px positions into % of overlay. The overlay matches the
  // canvas display rect via inset-0, so % of overlay == % of mockup.
  const mockupW = mockup.naturalWidth || mockup.width;
  const mockupH = mockup.naturalHeight || mockup.height;

  // Active drag state. We hold a snapshot of the placement + base
  // rect at gesture start so each pointermove computes deltas
  // against the start, never compounding rounding errors.
  const dragRef = useRef<
    | null
    | {
        mode: "translate" | "scale";
        corner?: "nw" | "ne" | "sw" | "se";
        startClientX: number;
        startClientY: number;
        startPlacement: ArtworkPlacement;
        startInfo: DesignRectInfo;
        canvasRect: DOMRect;
      }
  >(null);

  // Convert pointer client-space delta → mockup-space delta using
  // the canvas's current displayed size. Cached at gesture start.
  const clientToMockup = (
    cx: number,
    cy: number,
    canvasRect: DOMRect,
  ): { x: number; y: number } => {
    const sx = mockupW / canvasRect.width;
    const sy = mockupH / canvasRect.height;
    return {
      x: (cx - canvasRect.left) * sx,
      y: (cy - canvasRect.top) * sy,
    };
  };

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const dxClient = e.clientX - drag.startClientX;
      const dyClient = e.clientY - drag.startClientY;
      const sx = mockupW / drag.canvasRect.width;
      const sy = mockupH / drag.canvasRect.height;
      const dxMock = dxClient * sx;
      const dyMock = dyClient * sy;

      if (drag.mode === "translate") {
        onChange({
          ...drag.startPlacement,
          offsetX: drag.startPlacement.offsetX + dxMock,
          offsetY: drag.startPlacement.offsetY + dyMock,
        });
        return;
      }

      // Scale: keep opposite corner pinned, scale uniformly using
      // whichever axis the pointer moved further along (relative to
      // baseRect's aspect). This makes diagonal drags feel
      // monotonic — pulling out always grows, pushing in always
      // shrinks, regardless of which axis dominates.
      if (drag.mode === "scale") {
        const start = drag.startInfo.effective;
        const aspect = start.width / start.height;
        const corner = drag.corner ?? "se";
        // Pointer position in mockup px right now.
        const m = clientToMockup(e.clientX, e.clientY, drag.canvasRect);
        // Opposite corner (pinned) — derived from the rect at drag
        // start. e.g. dragging "se" pins "nw".
        const pinned = {
          x: corner.includes("e") ? start.x : start.x + start.width,
          y: corner.includes("s") ? start.y : start.y + start.height,
        };
        // Raw new dimensions if we ignored aspect lock.
        const rawW = Math.abs(m.x - pinned.x);
        const rawH = Math.abs(m.y - pinned.y);
        // Lock aspect: pick whichever axis demands the larger rect.
        // Rationale: feels like Photoshop's "shift-resize" — corner
        // tracks the further-out axis, the other follows.
        let newW = rawW;
        let newH = rawH;
        if (rawW / aspect > rawH) {
          newH = rawW / aspect;
        } else {
          newW = rawH * aspect;
        }
        // Minimum size guard — 5% of base rect — so the user can't
        // collapse the artwork to a single pixel by accident.
        const minScale = 0.05;
        const baseW = drag.startInfo.base.width;
        const baseH = drag.startInfo.base.height;
        if (newW / baseW < minScale) {
          newW = baseW * minScale;
          newH = baseH * minScale;
        }
        // Recompute the rect from pinned corner + new dims while
        // preserving the original direction (which side of pinned
        // the active corner is on).
        const signX = corner.includes("e") ? 1 : -1;
        const signY = corner.includes("s") ? 1 : -1;
        const activeX = pinned.x + signX * newW;
        const activeY = pinned.y + signY * newH;
        const newCx = (pinned.x + activeX) / 2;
        const newCy = (pinned.y + activeY) / 2;
        const newScale = newW / baseW;
        onChange({
          scale: newScale,
          offsetX: newCx - drag.startInfo.baseCentre.x,
          offsetY: newCy - drag.startInfo.baseCentre.y,
        });
      }
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // onChange is intentionally read fresh from closure each move —
    // we wire it via a stable ref above by re-binding the listener
    // on each change. Using state setter from props is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mockupW, mockupH, onChange]);

  if (!info) return null;

  const startDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    mode: "translate" | "scale",
    corner?: "nw" | "ne" | "sw" | "se",
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const canvas = canvasRef.current;
    if (!canvas) return;
    dragRef.current = {
      mode,
      corner,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPlacement: placement,
      startInfo: info,
      canvasRect: canvas.getBoundingClientRect(),
    };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  // Position the rect overlay in % of the canvas display so it
  // tracks correctly even as the modal resizes / the user scrolls.
  const pctRect = {
    left: (info.effective.x / mockupW) * 100,
    top: (info.effective.y / mockupH) * 100,
    width: (info.effective.width / mockupW) * 100,
    height: (info.effective.height / mockupH) * 100,
  };

  const handleSize = 14; // px — fixed visual size regardless of zoom
  const cornerStyle = (
    corner: "nw" | "ne" | "sw" | "se",
  ): React.CSSProperties => {
    const isE = corner.includes("e");
    const isS = corner.includes("s");
    return {
      position: "absolute",
      width: handleSize,
      height: handleSize,
      [isE ? "right" : "left"]: -handleSize / 2,
      [isS ? "bottom" : "top"]: -handleSize / 2,
      cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
    } as React.CSSProperties;
  };

  return (
    <div
      className="pointer-events-none absolute inset-0"
      data-testid="design-rect-overlay"
    >
      <div
        className="pointer-events-auto absolute select-none"
        style={{
          left: `${pctRect.left}%`,
          top: `${pctRect.top}%`,
          width: `${pctRect.width}%`,
          height: `${pctRect.height}%`,
        }}
      >
        {/* Body — drag to translate. Slightly tinted on hover so the
            user can see it's interactive even when the dashed rect
            (drawn into the canvas itself) is the visual anchor. */}
        <div
          onPointerDown={(e) => startDrag(e, "translate")}
          className="absolute inset-0 cursor-move ring-2 ring-fuchsia-300/70 transition hover:bg-fuchsia-500/5"
          style={{ touchAction: "none" }}
          title="Drag to move artwork"
        />
        {/* Four corner handles — uniform aspect-locked scale. */}
        {(["nw", "ne", "sw", "se"] as const).map((c) => (
          <div
            key={c}
            onPointerDown={(e) => startDrag(e, "scale", c)}
            style={{ ...cornerStyle(c), touchAction: "none" }}
            className="rounded-sm border-2 border-fuchsia-200 bg-fuchsia-500/90 shadow-md hover:scale-110"
            title="Drag corner to resize (aspect locked)"
          />
        ))}
      </div>
    </div>
  );
}
