import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useHoodieMapperStore } from "./store";

/**
 * Right sidebar: template metadata + reference overlay controls + view-only
 * debug flags. Phase 2+ adds per-layer property panels (transform, mesh,
 * blend mode, opacity, exclusion flag, panel assignment).
 */
export default function RightSidebar() {
  const view = useHoodieMapperStore((s) => s.view);
  const template = useHoodieMapperStore((s) => s.template);
  const debug = useHoodieMapperStore((s) => s.debug);
  const actions = useHoodieMapperStore((s) => s.actions);

  const referenceOverlay = template.views[view].referenceOverlay;

  return (
    <aside
      className="flex h-full w-72 flex-col border-l border-slate-800 bg-slate-900 text-slate-200"
      data-testid="hoodie-right-sidebar"
    >
      <div className="border-b border-slate-800 px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400">
        Properties
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 text-sm">
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
        </Section>

        <Section title="Coming next">
          <ul className="space-y-1 text-[11px] text-slate-400">
            <li>· Polygon &amp; magnetic pen — phases 2&amp;3</li>
            <li>· Mesh warp / corner pin / transforms — phase 4</li>
            <li>· Exclusion masks &amp; customer preview — phase 5</li>
            <li>· Printify export — phase 6</li>
            <li>· Blender texture export — phase 7</li>
          </ul>
        </Section>
      </div>
    </aside>
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
