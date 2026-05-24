import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ChevronUp, ChevronDown, Trash2, Sparkles, Wand2 } from "lucide-react";
import {
  PANELS_PER_VIEW,
  PANEL_DISPLAY_LABEL,
  type HoodiePanelKey,
  type MaskLayer,
} from "@shared/hoodieTemplate";
import { useHoodieMapperStore } from "./store";
import { svgPathToAnchors } from "./lib/svgPath";

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
            <div className="text-[11px] text-slate-500">
              Tip: magnetic snap reads pixel data from the mockup once it loads. Cross-origin mockups without CORS
              fall back to plain polygon behavior.
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
            </div>
          ) : (
            <div className="rounded border border-dashed border-slate-700 px-3 py-3 text-[11px] text-slate-500">
              Reference overlay upload arrives in phase 3 alongside the magnetic pen.
            </div>
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
    </Section>
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
