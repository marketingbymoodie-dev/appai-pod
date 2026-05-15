import { useState } from "react";
import { Eye, EyeOff, Lock, Unlock, Trash2, ArrowUp, ArrowDown, ImagePlus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import type { CalibrationState, ViewId } from "./types";
import { DEFAULT_PANEL_KEYS } from "./types";
import type { CalibrationActions } from "./useCalibration";
import { fileToImage, loadImageFromUrl } from "./fileLoaders";

type Props = {
  state: CalibrationState;
  actions: CalibrationActions;
  view: ViewId;
  selectedPanel: string | null;
  setSelectedPanel: (panelKey: string | null) => void;
  availableSourcePanels: Array<{ panelKey: string; url: string; width: number | null; height: number | null; source: string }>;
  onLoadStarter: () => void;
};

export default function PanelSidebar({
  state,
  actions,
  view,
  selectedPanel,
  setSelectedPanel,
  availableSourcePanels,
  onLoadStarter,
}: Props) {
  const viewState = state.views[view];
  const ordered = [...viewState.panelOrder].sort(
    (a, b) => (viewState.panels[a]?.zIndex ?? 0) - (viewState.panels[b]?.zIndex ?? 0),
  );
  const [showAddMenu, setShowAddMenu] = useState(false);

  async function handlePanelFile(panelKey: string, file: File) {
    const { src, width, height } = await fileToImage(file);
    actions.addPanel(view, panelKey, { width, height }, src);
    setSelectedPanel(panelKey);
  }

  async function addFromAvailable(panelKey: string) {
    const found = availableSourcePanels.find((p) => p.panelKey === panelKey);
    if (!found) return;
    const meta = await loadImageFromUrl(found.url);
    if (!meta) return;
    actions.addPanel(view, panelKey, { width: meta.width, height: meta.height }, found.url);
    setSelectedPanel(panelKey);
  }

  return (
    <div className="flex h-full w-72 flex-col border-r border-slate-800 bg-slate-900 text-slate-200" data-testid="aop-mapper-panel-sidebar">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <div className="text-sm font-semibold">Panels — {view}</div>
        <Button size="sm" variant="secondary" onClick={onLoadStarter} data-testid="aop-mapper-load-starter">
          Load starter
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        <div className="space-y-1">
          {ordered.length === 0 && (
            <div className="rounded border border-dashed border-slate-700 p-3 text-xs text-slate-400">
              No panels added to this view yet. Use "Load starter" or add a panel below.
            </div>
          )}
          {ordered.map((panelKey) => {
            const panel = viewState.panels[panelKey];
            if (!panel) return null;
            const isSel = panelKey === selectedPanel;
            return (
              <div
                key={panelKey}
                className={`rounded border ${isSel ? "border-orange-500 bg-slate-800/80" : "border-slate-800 bg-slate-900"} p-2`}
                onClick={() => setSelectedPanel(panelKey)}
                data-testid={`aop-mapper-panel-${panelKey}`}
              >
                <div className="flex items-center justify-between">
                  <div className="truncate text-xs font-medium">{panelKey}</div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      onClick={(e) => {
                        e.stopPropagation();
                        actions.patchPanel(view, panelKey, { visible: !panel.visible });
                      }}
                      title={panel.visible ? "Hide" : "Show"}
                    >
                      {panel.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      onClick={(e) => {
                        e.stopPropagation();
                        actions.patchPanel(view, panelKey, { locked: !panel.locked });
                      }}
                      title={panel.locked ? "Unlock" : "Lock"}
                    >
                      {panel.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-red-400 hover:text-red-300"
                      onClick={(e) => {
                        e.stopPropagation();
                        actions.removePanel(view, panelKey);
                        if (selectedPanel === panelKey) setSelectedPanel(null);
                      }}
                      title="Remove"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-400">
                  <span>z {panel.zIndex}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-5 w-5"
                    onClick={(e) => {
                      e.stopPropagation();
                      actions.reorderPanel(view, panelKey, panel.zIndex - 1);
                    }}
                    title="Send back"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-5 w-5"
                    onClick={(e) => {
                      e.stopPropagation();
                      actions.reorderPanel(view, panelKey, panel.zIndex + 1);
                    }}
                    title="Bring forward"
                  >
                    <ArrowUp className="h-3 w-3" />
                  </Button>
                  <span>op {Math.round(panel.opacity * 100)}%</span>
                  <span>{panel.sourceSize?.width ?? "?"}×{panel.sourceSize?.height ?? "?"}</span>
                </div>
                <Slider
                  value={[panel.opacity * 100]}
                  min={0}
                  max={100}
                  step={1}
                  onValueChange={([v]) => actions.patchPanel(view, panelKey, { opacity: v / 100 })}
                  className="mt-1"
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-slate-800 p-2">
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={() => setShowAddMenu(!showAddMenu)}
          data-testid="aop-mapper-add-panel-toggle"
        >
          <ImagePlus className="mr-2 h-4 w-4" /> Add panel
        </Button>
        {showAddMenu && (
          <div className="mt-2 space-y-2">
            <div className="rounded border border-slate-800 bg-slate-950 p-2">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">From local source-panels</div>
              <div className="grid grid-cols-2 gap-1">
                {DEFAULT_PANEL_KEYS.map((key) => {
                  const has = !!availableSourcePanels.find((p) => p.panelKey === key);
                  return (
                    <Button
                      key={key}
                      size="sm"
                      variant="outline"
                      disabled={!has || !!viewState.panels[key]}
                      onClick={() => addFromAvailable(key)}
                      className="justify-start text-xs"
                    >
                      {key}
                    </Button>
                  );
                })}
              </div>
            </div>
            <div className="rounded border border-slate-800 bg-slate-950 p-2">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">Upload custom panel</div>
              <PanelUploadField onUpload={handlePanelFile} disabledKeys={Object.keys(viewState.panels)} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PanelUploadField({
  onUpload,
  disabledKeys,
}: {
  onUpload: (panelKey: string, file: File) => Promise<void>;
  disabledKeys: string[];
}) {
  const [chosenKey, setChosenKey] = useState<string>(
    DEFAULT_PANEL_KEYS.find((k) => !disabledKeys.includes(k)) ?? DEFAULT_PANEL_KEYS[0],
  );
  return (
    <div className="space-y-2 text-xs">
      <select
        className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
        value={chosenKey}
        onChange={(e) => setChosenKey(e.target.value)}
      >
        {DEFAULT_PANEL_KEYS.map((key) => (
          <option key={key} value={key} disabled={disabledKeys.includes(key)}>
            {key}
          </option>
        ))}
      </select>
      <label className="flex cursor-pointer items-center justify-center gap-2 rounded border border-dashed border-slate-700 px-2 py-2 text-slate-300 hover:bg-slate-800">
        <Upload className="h-3.5 w-3.5" />
        Upload PNG
        <input
          type="file"
          accept="image/png,image/jpeg"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUpload(chosenKey, file);
          }}
        />
      </label>
    </div>
  );
}
