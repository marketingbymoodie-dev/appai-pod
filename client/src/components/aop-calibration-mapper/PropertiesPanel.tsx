import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type { CalibrationState, DebugFlags, ViewId } from "./types";
import type { CalibrationActions } from "./useCalibration";

type Props = {
  state: CalibrationState;
  actions: CalibrationActions;
  view: ViewId;
  selectedPanel: string | null;
  debug: DebugFlags;
  setDebug: (next: Partial<DebugFlags>) => void;
  mode: "select" | "mesh" | "mask";
  setMode: (m: "select" | "mesh" | "mask") => void;
  onSave: (label: string) => void;
  onLoad: (label: string) => void;
  onExportJson: () => void;
  onTestRender: () => void;
  savedCalibrations: Array<{ name: string; updatedAt: string }>;
  saveTarget: string;
  setSaveTarget: (label: string) => void;
};

export default function PropertiesPanel(props: Props) {
  const { state, actions, view, selectedPanel, debug, setDebug, mode, setMode, onSave, onLoad, onExportJson, onTestRender, savedCalibrations, saveTarget, setSaveTarget } = props;
  const panel = selectedPanel ? state.views[view].panels[selectedPanel] : null;

  return (
    <div className="flex h-full w-80 flex-col border-l border-slate-800 bg-slate-900 text-slate-200" data-testid="aop-mapper-properties">
      <div className="border-b border-slate-800 px-3 py-2 text-sm font-semibold">Properties</div>

      <div className="flex-1 overflow-y-auto px-3 py-2 text-sm">
        <Section title="Edit mode">
          <div className="grid grid-cols-3 gap-1">
            {(["select", "mesh", "mask"] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={mode === m ? "default" : "outline"}
                onClick={() => setMode(m)}
                data-testid={`aop-mapper-mode-${m}`}
              >
                {m}
              </Button>
            ))}
          </div>
          <div className="mt-2 text-[11px] text-slate-400">
            Select: drag panels, zoom/pan canvas. Mesh: drag mesh handles. Mask: click canvas to add polygon vertex; drag to move; double-click to delete.
          </div>
        </Section>

        <Section title="Selected panel">
          {!panel && <div className="text-xs text-slate-400">No panel selected.</div>}
          {panel && (
            <div className="space-y-2">
              <div className="text-xs">
                <div className="font-semibold">{panel.panelKey}</div>
                <div className="text-slate-400">
                  source {panel.sourceSize?.width}×{panel.sourceSize?.height} | mesh {panel.mesh.cols}×{panel.mesh.rows} ({panel.mesh.points.length} pts)
                </div>
              </div>
              <LabelRow label={`Opacity ${(panel.opacity * 100).toFixed(0)}%`}>
                <Slider value={[panel.opacity * 100]} min={0} max={100} step={1} onValueChange={([v]) => actions.patchPanel(view, panel.panelKey, { opacity: v / 100 })} />
              </LabelRow>
              <div className="flex items-center justify-between text-xs">
                <span>Visible</span>
                <Switch checked={panel.visible} onCheckedChange={(c) => actions.patchPanel(view, panel.panelKey, { visible: c })} />
              </div>
              <div className="flex items-center justify-between text-xs">
                <span>Locked</span>
                <Switch checked={panel.locked} onCheckedChange={(c) => actions.patchPanel(view, panel.panelKey, { locked: c })} />
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <LabelRow label="Mesh cols">
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    value={panel.mesh.cols}
                    onChange={(e) => {
                      const cols = Math.max(1, Math.min(20, Number(e.target.value)));
                      actions.setMeshDensity(view, panel.panelKey, cols, panel.mesh.rows);
                    }}
                  />
                </LabelRow>
                <LabelRow label="Mesh rows">
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    value={panel.mesh.rows}
                    onChange={(e) => {
                      const rows = Math.max(1, Math.min(20, Number(e.target.value)));
                      actions.setMeshDensity(view, panel.panelKey, panel.mesh.cols, rows);
                    }}
                  />
                </LabelRow>
              </div>
              <div className="grid grid-cols-3 gap-1 text-xs">
                <Button size="sm" variant="outline" onClick={() => actions.transformMesh(view, panel.panelKey, { dx: -10 })}>← 10px</Button>
                <Button size="sm" variant="outline" onClick={() => actions.transformMesh(view, panel.panelKey, { scale: 1.05 })}>scale +5%</Button>
                <Button size="sm" variant="outline" onClick={() => actions.transformMesh(view, panel.panelKey, { dx: 10 })}>10px →</Button>
                <Button size="sm" variant="outline" onClick={() => actions.transformMesh(view, panel.panelKey, { dy: -10 })}>↑ 10px</Button>
                <Button size="sm" variant="outline" onClick={() => actions.transformMesh(view, panel.panelKey, { scale: 1 / 1.05 })}>scale -5%</Button>
                <Button size="sm" variant="outline" onClick={() => actions.transformMesh(view, panel.panelKey, { dy: 10 })}>↓ 10px</Button>
                <Button size="sm" variant="outline" onClick={() => actions.transformMesh(view, panel.panelKey, { rotation: -Math.PI / 90 })}>rot -2°</Button>
                <Button size="sm" variant="outline" onClick={() => actions.transformMesh(view, panel.panelKey, { rotation: Math.PI / 90 })}>rot +2°</Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (!panel.sourceSize || !state.views[view].mockupSize) return;
                    // Reset to a sensible default rectangle.
                    const w = state.views[view].mockupSize!.width;
                    const h = state.views[view].mockupSize!.height;
                    actions.setMeshDensity(view, panel.panelKey, panel.mesh.cols, panel.mesh.rows);
                  }}
                >
                  reset
                </Button>
              </div>
            </div>
          )}
        </Section>

        <Section title="Debug overlays">
          <DebugToggle label="Mesh handles" checked={debug.showMesh} onChange={(c) => setDebug({ showMesh: c })} />
          <DebugToggle label="Mask polygon" checked={debug.showMask} onChange={(c) => setDebug({ showMask: c })} />
          <DebugToggle label="Panel bounds" checked={debug.showPanelBounds} onChange={(c) => setDebug({ showPanelBounds: c })} />
          <DebugToggle label="Onion skin" checked={debug.showOnionSkin} onChange={(c) => setDebug({ showOnionSkin: c })} />
          {debug.showOnionSkin && (
            <LabelRow label={`Onion skin alpha ${Math.round(debug.onionSkinOpacity * 100)}%`}>
              <Slider value={[debug.onionSkinOpacity * 100]} min={0} max={100} step={1} onValueChange={([v]) => setDebug({ onionSkinOpacity: v / 100 })} />
            </LabelRow>
          )}
          <DebugToggle label="High-contrast mockup" checked={debug.highContrast} onChange={(c) => setDebug({ highContrast: c })} />
        </Section>

        <Section title="Save / Load">
          <div className="flex gap-2">
            <Input
              value={saveTarget}
              onChange={(e) => setSaveTarget(e.target.value.replace(/[^a-zA-Z0-9_\-]/g, "_"))}
              placeholder="calibration-name"
              className="text-xs"
            />
            <Button size="sm" onClick={() => onSave(saveTarget)} data-testid="aop-mapper-save">
              Save
            </Button>
          </div>
          <Button size="sm" variant="outline" className="mt-1 w-full" onClick={onExportJson} data-testid="aop-mapper-export-json">
            Download JSON
          </Button>
          <Button size="sm" variant="outline" className="mt-1 w-full" onClick={onTestRender} data-testid="aop-mapper-test-render">
            Test render → PNG
          </Button>
          {savedCalibrations.length > 0 && (
            <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
              {savedCalibrations.map((c) => (
                <Button
                  key={c.name}
                  size="sm"
                  variant="ghost"
                  className="w-full justify-start text-xs"
                  onClick={() => onLoad(c.name)}
                >
                  {c.name} <span className="ml-auto text-[10px] text-slate-400">{c.updatedAt.slice(0, 16).replace("T", " ")}</span>
                </Button>
              ))}
            </div>
          )}
        </Section>

        <Section title="Product info">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <LabelRow label="productTypeId">
              <Input
                type="number"
                value={state.productTypeId ?? 0}
                onChange={(e) => actions.setProductInfo({ productTypeId: Number(e.target.value) || null })}
              />
            </LabelRow>
            <LabelRow label="blueprintId">
              <Input
                type="number"
                value={state.blueprintId ?? 0}
                onChange={(e) => actions.setProductInfo({ blueprintId: Number(e.target.value) || null })}
              />
            </LabelRow>
            <LabelRow label="providerId">
              <Input
                type="number"
                value={state.providerId ?? 0}
                onChange={(e) => actions.setProductInfo({ providerId: Number(e.target.value) || null })}
              />
            </LabelRow>
            <LabelRow label="size">
              <Input
                value={state.size ?? ""}
                onChange={(e) => actions.setProductInfo({ size: e.target.value || null })}
              />
            </LabelRow>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">{title}</div>
      <div>{children}</div>
    </div>
  );
}

function LabelRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-slate-400">{label}</Label>
      <div>{children}</div>
    </div>
  );
}

function DebugToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (c: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
