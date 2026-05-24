import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  ChevronUp,
  ChevronDown,
  Trash2,
  Sparkles,
  Wand2,
  Image as ImageIcon,
  Grid3X3,
  RotateCcw,
  Upload,
  Loader2,
} from "lucide-react";
import {
  PANELS_PER_VIEW,
  PANEL_DISPLAY_LABEL,
  type HoodiePanelKey,
  type MaskLayer,
} from "@shared/hoodieTemplate";
import type { HoodieView } from "@shared/hoodieTemplate";
import { useHoodieMapperStore } from "./store";
import { svgPathToAnchors } from "./lib/svgPath";
import { readImageDimensions, uploadReferenceOverlay, uploadSourcePanel } from "./api";

/**
 * Right sidebar: template metadata + tool-aware controls + per-layer
 * properties when a mask is selected. Phase 4 will add transform/mesh
 * controls for the selected layer.
 */
export default function RightSidebar() {
  const view = useHoodieMapperStore((s) => s.view);
  const tool = useHoodieMapperStore((s) => s.tool);
  const template = useHoodieMapperStore((s) => s.template);
  const debug = useHoodieMapperStore((s) => s.debug);
  const magneticRadius = useHoodieMapperStore((s) => s.magneticRadius);
  const magneticTolerance = useHoodieMapperStore((s) => s.magneticTolerance);
  const selectedLayerId = useHoodieMapperStore((s) => s.selectedLayerId);
  const actions = useHoodieMapperStore((s) => s.actions);

  const referenceOverlay = template.views[view].referenceOverlay;
  const layers = template.views[view].layers;
  const selectedLayer = useMemo(
    () => layers.find((l) => l.id === selectedLayerId) ?? null,
    [layers, selectedLayerId],
  );

  return (
    <aside
      className="flex h-full w-72 flex-col border-l border-slate-800 bg-slate-900 text-slate-200"
      data-testid="hoodie-right-sidebar"
    >
      <div className="border-b border-slate-800 px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400">
        Properties
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 text-sm">
        {selectedLayer ? (
          <SelectedLayerSection layer={selectedLayer} />
        ) : (
          <div className="mb-5 rounded border border-dashed border-slate-700 px-3 py-3 text-[11px] text-slate-500">
            No layer selected. Use the Polygon or Magnetic Pen (P / M) to draw a mask, or click an existing mask to edit it.
          </div>
        )}

        {tool === "magnetic-pen" && (
          <Section title="Magnetic pen">
            <div className="text-[11px] text-slate-400">
              Snap radius — distance (in mockup pixels) the magnet searches around the cursor.
              Set to 0 to behave like the polygon pen.
            </div>
            <Field label={`Snap radius ${magneticRadius}px`}>
              <Slider
                value={[magneticRadius]}
                min={0}
                max={120}
                step={1}
                onValueChange={([v]) => actions.setMagneticRadius(v)}
              />
            </Field>
            <div className="mt-3 text-[11px] text-slate-400">
              Edge tolerance — how strong an edge has to be (relative to the
              strongest edge in the image) before the magnet locks onto it.
              <span className="text-slate-500"> Lower = greedier (snaps to faint internal seams);
              higher = pickier (silhouette only).</span>
            </div>
            <Field label={`Tolerance ${magneticTolerance.toFixed(2)} (${tolerancePresetLabel(magneticTolerance)})`}>
              <Slider
                value={[Math.round(magneticTolerance * 100)]}
                min={0}
                max={60}
                step={1}
                onValueChange={([v]) => actions.setMagneticTolerance(v / 100)}
              />
            </Field>
            <div className="flex flex-wrap gap-1 pt-1">
              {[
                { label: "Greedy", value: 0.05 },
                { label: "Default", value: 0.18 },
                { label: "Strict", value: 0.32 },
                { label: "Silhouette only", value: 0.45 },
              ].map((p) => (
                <Button
                  key={p.label}
                  size="sm"
                  variant={Math.abs(magneticTolerance - p.value) < 0.01 ? "default" : "outline"}
                  className="h-6 px-2 text-[10px]"
                  onClick={() => actions.setMagneticTolerance(p.value)}
                  data-testid={`hoodie-tolerance-${p.label.replace(/\s+/g, "-").toLowerCase()}`}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <div className="mt-2 text-[11px] text-slate-500">
              Tip: magnetic snap reads pixel data from the mockup once it loads. Cross-origin mockups without CORS
              fall back to plain polygon behavior. On transparent-background mockups, raise tolerance until anchors
              stop drifting onto internal seams.
            </div>
          </Section>
        )}

        <Section title="Template">
          <Field label="Slug">
            <Input
              value={template.name}
              onChange={(e) =>
                actions.setTemplateMeta({ name: e.target.value.replace(/[^a-zA-Z0-9_\-]/g, "_") })
              }
              className="h-8 text-xs"
            />
          </Field>
          <Field label="Label">
            <Input
              value={template.label}
              onChange={(e) => actions.setTemplateMeta({ label: e.target.value })}
              className="h-8 text-xs"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="hoodieType">
              <Input
                value={template.hoodieType}
                onChange={(e) => actions.setTemplateMeta({ hoodieType: e.target.value })}
                className="h-8 text-xs"
              />
            </Field>
            <Field label="size">
              <Input
                value={template.size ?? ""}
                onChange={(e) => actions.setTemplateMeta({ size: e.target.value || null })}
                className="h-8 text-xs"
              />
            </Field>
            <Field label="productTypeId">
              <Input
                type="number"
                value={template.productTypeId ?? 0}
                onChange={(e) =>
                  actions.setTemplateMeta({ productTypeId: Number(e.target.value) || null })
                }
                className="h-8 text-xs"
              />
            </Field>
            <Field label="blueprintId">
              <Input
                type="number"
                value={template.blueprintId ?? 0}
                onChange={(e) =>
                  actions.setTemplateMeta({ blueprintId: Number(e.target.value) || null })
                }
                className="h-8 text-xs"
              />
            </Field>
          </div>
        </Section>

        <Section title={`Reference overlay (${view})`}>
          <div className="text-[11px] text-slate-400">
            Optional. Drop in a finished Printify mockup so you can align the empty mask shapes
            to it. Reference overlays are hint-only and never exported.
          </div>
          {referenceOverlay ? (
            <div className="space-y-2 rounded border border-slate-800 bg-slate-950 p-2 text-[11px]">
              <div className="text-slate-300">
                {referenceOverlay.width}×{referenceOverlay.height}px ·{" "}
                <span className="text-slate-500">{referenceOverlay.placement}</span>
              </div>
              <Field label={`Opacity ${(referenceOverlay.opacity * 100).toFixed(0)}%`}>
                <Slider
                  value={[referenceOverlay.opacity * 100]}
                  min={0}
                  max={100}
                  step={1}
                  onValueChange={([v]) =>
                    actions.setReferenceOverlay(view, { ...referenceOverlay, opacity: v / 100 })
                  }
                />
              </Field>
              <ToggleRow
                label="Visible"
                checked={referenceOverlay.visible}
                onChange={(c) => actions.setReferenceOverlay(view, { ...referenceOverlay, visible: c })}
              />
              <ToggleRow
                label="Locked"
                checked={referenceOverlay.locked}
                onChange={(c) => actions.setReferenceOverlay(view, { ...referenceOverlay, locked: c })}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 text-[11px]"
                  onClick={() =>
                    actions.setReferenceOverlay(view, {
                      ...referenceOverlay,
                      placement: referenceOverlay.placement === "above" ? "below" : "above",
                    })
                  }
                >
                  Toggle above/below
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-[11px] text-red-300 hover:text-red-200"
                  onClick={() => actions.setReferenceOverlay(view, null)}
                >
                  Clear
                </Button>
              </div>
              <ReferenceOverlayUpload templateName={template.name} view={view} replace />
            </div>
          ) : (
            <ReferenceOverlayUpload templateName={template.name} view={view} />
          )}
        </Section>

        <Section title="Workspace">
          <ToggleRow
            label="Show grid"
            checked={debug.showGrid}
            onChange={(c) => actions.setDebug({ showGrid: c })}
          />
          <ToggleRow
            label="Show panel labels"
            checked={debug.showPanelLabels}
            onChange={(c) => actions.setDebug({ showPanelLabels: c })}
          />
          <ToggleRow
            label="Hover highlight"
            checked={debug.showHoverHighlight}
            onChange={(c) => actions.setDebug({ showHoverHighlight: c })}
          />
          <ToggleRow
            label="Show polygon anchors"
            checked={debug.showAnchors}
            onChange={(c) => actions.setDebug({ showAnchors: c })}
          />
          <ToggleRow
            label="Canvas debug strip"
            checked={debug.showCanvasDebug}
            onChange={(c) => actions.setDebug({ showCanvasDebug: c })}
          />
        </Section>

        <Section title="Coming next">
          <ul className="space-y-1 text-[11px] text-slate-400">
            <li>· Reference overlay upload &amp; onion skin — phase 3</li>
            <li>· Mesh warp / corner pin / transforms — phase 4</li>
            <li>· Exclusion-aware customer preview — phase 5</li>
            <li>· Printify export — phase 6</li>
            <li>· Blender texture export — phase 7</li>
          </ul>
        </Section>
      </div>
    </aside>
  );
}

function SelectedLayerSection({ layer }: { layer: MaskLayer }) {
  const view = useHoodieMapperStore((s) => s.view);
  const layers = useHoodieMapperStore((s) => s.template.views[s.view].layers);
  const actions = useHoodieMapperStore((s) => s.actions);

  const eligible = PANELS_PER_VIEW[view];
  const anchors = useMemo(() => svgPathToAnchors(layer.maskPath), [layer.maskPath]);
  const sortedZ = useMemo(() => [...layers].sort((a, b) => a.zIndex - b.zIndex), [layers]);
  const indexInZ = sortedZ.findIndex((l) => l.id === layer.id);
  const canMoveUp = indexInZ < sortedZ.length - 1;
  const canMoveDown = indexInZ > 0;

  function moveZ(delta: number) {
    const target = sortedZ[indexInZ + delta];
    if (!target) return;
    actions.reorderLayer(layer.id, target.zIndex);
    actions.reorderLayer(target.id, layer.zIndex);
  }

  return (
    <Section title={`Layer · ${layer.name}`}>
      <Field label="Name">
        <Input
          value={layer.name}
          onChange={(e) => actions.patchLayer(layer.id, { name: e.target.value })}
          className="h-8 text-xs"
        />
      </Field>
      <Field label="Panel assignment">
        <select
          className="h-8 w-full rounded border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200"
          value={layer.panelKey ?? ""}
          onChange={(e) =>
            actions.patchLayer(layer.id, {
              panelKey: (e.target.value || null) as HoodiePanelKey | null,
            })
          }
        >
          <option value="">— unassigned —</option>
          {eligible.map((k) => (
            <option key={k} value={k}>
              {PANEL_DISPLAY_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label={`Opacity ${(layer.opacity * 100).toFixed(0)}%`}>
        <Slider
          value={[layer.opacity * 100]}
          min={0}
          max={100}
          step={1}
          onValueChange={([v]) => actions.patchLayer(layer.id, { opacity: v / 100 })}
        />
      </Field>
      <ToggleRow
        label="Exclusion mask (zipper / hood interior / etc.)"
        checked={layer.isExclusion}
        onChange={(c) =>
          actions.patchLayer(layer.id, { isExclusion: c, kind: c ? "exclusion" : "panel" })
        }
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-[11px]"
          disabled={!canMoveUp}
          onClick={() => moveZ(1)}
        >
          <ChevronUp className="mr-1 h-3.5 w-3.5" /> Forward
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-[11px]"
          disabled={!canMoveDown}
          onClick={() => moveZ(-1)}
        >
          <ChevronDown className="mr-1 h-3.5 w-3.5" /> Back
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-[11px] text-red-300 hover:text-red-200"
          onClick={() => actions.removeLayer(layer.id)}
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
        </Button>
      </div>

      <div className="mt-2 rounded border border-slate-800 bg-slate-950 p-2 text-[11px] text-slate-400">
        <div className="mb-1 font-semibold text-slate-300">Path</div>
        <div>{anchors.length} anchors · z {layer.zIndex}</div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            onClick={() => actions.simplifyLayerPath(layer.id, 1.5)}
            title="Douglas–Peucker (epsilon 1.5px)"
          >
            <Wand2 className="mr-1 h-3.5 w-3.5" /> Simplify
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            onClick={() => actions.simplifyLayerPath(layer.id, 4)}
            title="Douglas–Peucker (epsilon 4px) — heavier"
          >
            <Wand2 className="mr-1 h-3.5 w-3.5" /> Simplify×
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            onClick={() => actions.smoothLayerPath(layer.id, 1)}
            title="Chaikin smoothing — adds anchors and rounds corners"
          >
            <Sparkles className="mr-1 h-3.5 w-3.5" /> Smooth
          </Button>
        </div>
        <div className="mt-2 text-[11px] text-slate-500">
          Drag anchor dots on the canvas to reshape · Alt-click an anchor to delete · Alt-click on the layer fill to insert.
        </div>
      </div>

      <SourceArtworkSection layer={layer} />
      <MeshWarpSection layer={layer} />
    </Section>
  );
}

/**
 * Per-view reference overlay uploader. Pick a Printify-rendered mockup for
 * this view and it'll show as a crossfadeable overlay on the canvas — handy
 * for comparing your mesh-warp output against the actual Printify render.
 */
function ReferenceOverlayUpload({
  templateName,
  view,
  replace = false,
}: {
  templateName: string;
  view: HoodieView;
  replace?: boolean;
}) {
  const actions = useHoodieMapperStore((s) => s.actions);
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleUpload(file: File) {
    setBusy(true);
    try {
      const { width, height } = await readImageDimensions(file);
      const { url } = await uploadReferenceOverlay(templateName, view, file);
      actions.setReferenceOverlay(view, {
        src: url,
        width,
        height,
        opacity: 0.6,
        visible: true,
        locked: false,
        placement: "above",
      });
      toast({ title: `Loaded ${view} reference overlay`, description: `${width}×${height}px` });
    } catch (err: any) {
      toast({
        title: "Upload failed",
        description: err?.message || String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className={`${replace ? "mt-2 h-7 w-full" : "h-8 w-full"} text-[11px]`}
        onClick={() => fileRef.current?.click()}
        disabled={busy}
      >
        {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />}
        {replace ? "Replace reference image" : `Upload ${view} reference image`}
      </Button>
      {!replace && (
        <p className="mt-1 text-[10px] text-slate-500">
          Drop a Printify-rendered mockup of this view here. Use the opacity slider to crossfade
          against your mesh-warp output.
        </p>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUpload(f);
          e.target.value = "";
        }}
      />
    </>
  );
}

/**
 * Source-panel artwork uploader for a single layer. Filename derives from
 * the active template + this layer's panelKey so front and back masks for
 * the same panel share a single upload (Printify ships one artwork sheet
 * per panel and the mesh source-rect picks the right slice for each view).
 */
function SourceArtworkSection({ layer }: { layer: MaskLayer }) {
  const templateName = useHoodieMapperStore((s) => s.template.name);
  const actions = useHoodieMapperStore((s) => s.actions);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  async function handleUpload(file: File) {
    setBusy(true);
    try {
      const panelKey = layer.panelKey ?? `mask-${layer.id}`;
      const { url } = await uploadSourcePanel(templateName, panelKey, file);
      actions.setLayerSourcePanel(layer.id, url);
      toast({ title: "Source artwork uploaded", description: url });
    } catch (err: any) {
      toast({
        title: "Upload failed",
        description: err?.message || String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded border border-fuchsia-900/40 bg-fuchsia-950/20 p-2">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-fuchsia-300">
        <ImageIcon className="h-3.5 w-3.5" /> Source artwork
      </div>
      <div className="text-[11px] text-slate-400">
        The Printify panel sheet that this mask samples. Front/back masks of the same panel can
        share one upload — pick the visible slice with the mesh.
      </div>
      {layer.productionPanelSrc ? (
        <div className="mt-2 space-y-2">
          <div className="overflow-hidden rounded border border-slate-800 bg-slate-950">
            <img
              src={layer.productionPanelSrc}
              alt={`Source for ${layer.name}`}
              className="block max-h-32 w-full object-contain bg-slate-900"
            />
          </div>
          <div className="break-all text-[10px] text-slate-500">{layer.productionPanelSrc}</div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 flex-1 text-[11px]"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />}
              Replace
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px] text-red-300 hover:text-red-200"
              onClick={() => actions.setLayerSourcePanel(layer.id, null)}
              disabled={busy}
            >
              Clear
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="mt-2 h-8 w-full text-[11px]"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />}
          Upload artwork
        </Button>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUpload(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/**
 * Mesh density / reset / show-full-artwork toggle. Only useful once the
 * layer has a closed polygon — otherwise creating a mesh has no shape to
 * snap to.
 */
function MeshWarpSection({ layer }: { layer: MaskLayer }) {
  const tool = useHoodieMapperStore((s) => s.tool);
  const meshEdit = useHoodieMapperStore((s) => s.meshEdit);
  const actions = useHoodieMapperStore((s) => s.actions);
  const anchors = useMemo(() => svgPathToAnchors(layer.maskPath), [layer.maskPath]);
  const canInit = anchors.length >= 3;
  const mesh = layer.mesh;

  return (
    <div className="mt-3 rounded border border-purple-900/40 bg-purple-950/20 p-2">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-purple-300">
        <Grid3X3 className="h-3.5 w-3.5" /> Mesh warp
      </div>
      {!mesh ? (
        <div className="space-y-2 text-[11px] text-slate-400">
          <div>
            Initialise a control grid covering this panel. Drag the dots to follow fabric
            curvature — switch to the <span className="text-purple-200">Mesh Warp (W)</span> tool
            to grab the handles.
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-full text-[11px]"
            disabled={!canInit}
            onClick={() => actions.initLayerMesh(layer.id, 4, 4)}
          >
            <Grid3X3 className="mr-1 h-3.5 w-3.5" />
            Initialise 4×4 mesh
          </Button>
          {!canInit && (
            <div className="text-[10px] text-amber-300">
              Trace a closed polygon first (≥3 anchors).
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2 text-[11px] text-slate-400">
          <div className="grid grid-cols-2 gap-2">
            <Field label={`Cols ${mesh.cols}`}>
              <Slider
                value={[mesh.cols]}
                min={2}
                max={12}
                step={1}
                onValueChange={([v]) => actions.resizeLayerMesh(layer.id, v, mesh.rows)}
              />
            </Field>
            <Field label={`Rows ${mesh.rows}`}>
              <Slider
                value={[mesh.rows]}
                min={2}
                max={12}
                step={1}
                onValueChange={([v]) => actions.resizeLayerMesh(layer.id, mesh.cols, v)}
              />
            </Field>
          </div>
          <ToggleRow
            label="Show full artwork (ignore mask)"
            checked={meshEdit.showFullArtwork}
            onChange={(c) => actions.setMeshEdit({ showFullArtwork: c })}
          />
          <div className="text-[10px] text-slate-500">
            Toggle on to see the artwork beyond the polygon — useful for picking which slice of a
            sleeve sheet matches the front vs back view. Toggle off and the mask hides everything
            outside the panel.
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 flex-1 text-[11px]"
              onClick={() => actions.resetLayerMesh(layer.id, mesh.cols, mesh.rows)}
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reset to bbox
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-[11px] text-red-300 hover:text-red-200"
              onClick={() => actions.patchLayer(layer.id, { mesh: null })}
            >
              Remove
            </Button>
          </div>
          <div className="text-[10px] text-slate-500">
            {tool === "mesh-warp"
              ? "Drag any purple dot to deform the grid. Saved with the template."
              : "Switch to the Mesh Warp (W) tool to drag control points."}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-slate-400">{label}</Label>
      <div>{children}</div>
    </div>
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
    <div className="flex items-center justify-between py-1 text-xs">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * Friendly label for the magnetic-pen tolerance value, mirroring the preset
 * names users see in the quick-pick row underneath the slider.
 */
function tolerancePresetLabel(t: number): string {
  if (t < 0.1) return "greedy";
  if (t < 0.25) return "default";
  if (t < 0.4) return "strict";
  return "silhouette only";
}
