import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ArtworkPanelAsset, MockupPanelPlacement, MockupPanelPreset } from "../types/mockupTypes";

const PANEL_PRESETS: MockupPanelPreset[] = [
  "hood_left_opening",
  "hood_right_opening",
  "front_neckline_collar",
  "front_body_left",
  "front_body_right",
  "back_main",
  "back_hood_left_visible",
  "back_hood_right_visible",
  "sleeve_left_back",
  "sleeve_right_back",
  "front_sleeve_left_main",
  "front_sleeve_left_fold_top",
  "front_sleeve_left_fold_under",
  "front_sleeve_left_cuff",
  "front_sleeve_right_main",
  "front_sleeve_right_fold_top",
  "front_sleeve_right_fold_under",
  "front_sleeve_right_cuff",
  "zipper_mask_area",
  "custom",
];

type PanelControlsProps = {
  panels: MockupPanelPlacement[];
  selectedPanelId: string | null;
  artworkPanels: ArtworkPanelAsset[];
  onSelectPanel: (panelId: string) => void;
  onUpdatePanel: (panelId: string, patch: Partial<MockupPanelPlacement>) => void;
  onAddPanel: (preset: MockupPanelPreset, artworkPanelName: string) => void;
  onDuplicatePanel: (panelId: string) => void;
  onDeletePanel: (panelId: string) => void;
  onNudgeZIndex: (panelId: string, direction: "up" | "down") => void;
  onAssignArtworkToSelected: (artworkPanelName: string) => void;
  onAssignArtworkToVisible: (artworkPanelName: string) => void;
  onUploadMask: (panelId: string, file?: File) => void;
};

function numeric(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function NumberField({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
}) {
  return (
    <Label className="space-y-1 text-xs">
      <span>{label}</span>
      <Input
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => onChange(numeric(event.target.value, value))}
        className="h-9"
      />
    </Label>
  );
}

export function PanelControls({
  panels,
  selectedPanelId,
  artworkPanels,
  onSelectPanel,
  onUpdatePanel,
  onAddPanel,
  onDuplicatePanel,
  onDeletePanel,
  onNudgeZIndex,
  onAssignArtworkToSelected,
  onAssignArtworkToVisible,
  onUploadMask,
}: PanelControlsProps) {
  const selectedPanel = panels.find((panel) => panel.id === selectedPanelId) ?? panels[0] ?? null;
  const firstArtworkName = artworkPanels[0]?.name ?? "";

  return (
    <div className="space-y-4 rounded-lg border bg-background p-4">
      <div>
        <h3 className="text-sm font-semibold">Panel Controls</h3>
        <p className="text-xs text-muted-foreground">Drag on canvas, or edit exact transform values here.</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <select
          className="h-10 rounded-md border bg-background px-2 text-sm"
          defaultValue="hood_left_opening"
          id="new-panel-preset"
        >
          {PANEL_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {preset}
            </option>
          ))}
        </select>
        <select className="h-10 rounded-md border bg-background px-2 text-sm" defaultValue={firstArtworkName} id="new-panel-artwork">
          <option value="">No artwork</option>
          {artworkPanels.map((asset) => (
            <option key={asset.name} value={asset.name}>
              {asset.name}
            </option>
          ))}
        </select>
        <Button
          className="col-span-2"
          variant="outline"
          onClick={() => {
            const preset = (document.getElementById("new-panel-preset") as HTMLSelectElement | null)?.value as MockupPanelPreset;
            const artworkPanelName = (document.getElementById("new-panel-artwork") as HTMLSelectElement | null)?.value || firstArtworkName;
            onAddPanel(preset || "custom", artworkPanelName);
          }}
        >
          Add Panel
        </Button>
      </div>

      <div className="max-h-44 space-y-2 overflow-auto pr-1">
        {panels
          .slice()
          .sort((a, b) => b.zIndex - a.zIndex)
          .map((panel) => (
            <button
              key={panel.id}
              type="button"
              onClick={() => onSelectPanel(panel.id)}
              className={`w-full rounded-md border px-3 py-2 text-left text-xs ${
                panel.id === selectedPanel?.id ? "border-primary bg-primary/10" : "bg-muted/30"
              }`}
            >
              <div className="font-medium">{panel.name}</div>
              <div className="text-muted-foreground">
                {panel.preset} · z{panel.zIndex} · {panel.artworkPanelName || "no artwork"}
              </div>
            </button>
          ))}
      </div>

      {selectedPanel ? (
        <div className="space-y-3">
          <Label className="space-y-1 text-xs">
            <span>Name</span>
            <Input value={selectedPanel.name} onChange={(event) => onUpdatePanel(selectedPanel.id, { name: event.target.value })} />
          </Label>

          {artworkPanels.length > 0 ? (
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" onClick={() => onAssignArtworkToSelected(firstArtworkName)}>
                Assign First Artwork
              </Button>
              <Button variant="outline" size="sm" onClick={() => onAssignArtworkToVisible(firstArtworkName)}>
                Assign To Visible
              </Button>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <Label className="space-y-1 text-xs">
              <span>Artwork panel</span>
              <select
                className="h-9 w-full rounded-md border bg-background px-2"
                value={selectedPanel.artworkPanelName}
                onChange={(event) => onUpdatePanel(selectedPanel.id, { artworkPanelName: event.target.value })}
              >
                <option value="">None</option>
                {artworkPanels.map((asset) => (
                  <option key={asset.name} value={asset.name}>
                    {asset.name}
                  </option>
                ))}
              </select>
            </Label>
            <Label className="space-y-1 text-xs">
              <span>Preset</span>
              <select
                className="h-9 w-full rounded-md border bg-background px-2"
                value={selectedPanel.preset}
                onChange={(event) => onUpdatePanel(selectedPanel.id, { preset: event.target.value as MockupPanelPreset })}
              >
                {PANEL_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {preset}
                  </option>
                ))}
              </select>
            </Label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <NumberField label="X" value={selectedPanel.x} onChange={(x) => onUpdatePanel(selectedPanel.id, { x })} />
            <NumberField label="Y" value={selectedPanel.y} onChange={(y) => onUpdatePanel(selectedPanel.id, { y })} />
            <NumberField label="Width" value={selectedPanel.width} onChange={(width) => onUpdatePanel(selectedPanel.id, { width })} />
            <NumberField label="Height" value={selectedPanel.height} onChange={(height) => onUpdatePanel(selectedPanel.id, { height })} />
            <NumberField label="Rotation" value={selectedPanel.rotation} onChange={(rotation) => onUpdatePanel(selectedPanel.id, { rotation })} />
            <NumberField label="Opacity" value={selectedPanel.opacity} step={0.05} onChange={(opacity) => onUpdatePanel(selectedPanel.id, { opacity })} />
            <NumberField label="Scale X" value={selectedPanel.scaleX} step={0.05} onChange={(scaleX) => onUpdatePanel(selectedPanel.id, { scaleX })} />
            <NumberField label="Scale Y" value={selectedPanel.scaleY} step={0.05} onChange={(scaleY) => onUpdatePanel(selectedPanel.id, { scaleY })} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Label className="space-y-1 text-xs">
              <span>Panel bg color</span>
              <Input
                type="color"
                value={selectedPanel.bgColor && /^#[0-9a-fA-F]{6}$/.test(selectedPanel.bgColor) ? selectedPanel.bgColor : "#ffffff"}
                onChange={(event) => onUpdatePanel(selectedPanel.id, { bgColor: event.target.value })}
              />
            </Label>
            <NumberField
              label="Bg opacity"
              value={selectedPanel.bgOpacity ?? 1}
              step={0.05}
              onChange={(bgOpacity) => onUpdatePanel(selectedPanel.id, { bgOpacity })}
            />
            <Button variant="outline" size="sm" onClick={() => onUpdatePanel(selectedPanel.id, { bgColor: undefined })}>
              Clear Bg
            </Button>
            <Label className="space-y-1 text-xs">
              <span>Panel mask</span>
              <Input type="file" accept="image/*" onChange={(event) => onUploadMask(selectedPanel.id, event.target.files?.[0])} />
            </Label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => onUpdatePanel(selectedPanel.id, { locked: !selectedPanel.locked })}>
              {selectedPanel.locked ? "Unlock" : "Lock"}
            </Button>
            <Button variant="outline" onClick={() => onUpdatePanel(selectedPanel.id, { visible: !selectedPanel.visible })}>
              {selectedPanel.visible ? "Hide" : "Show"}
            </Button>
            <Button variant="outline" onClick={() => onNudgeZIndex(selectedPanel.id, "up")}>
              Z Up
            </Button>
            <Button variant="outline" onClick={() => onNudgeZIndex(selectedPanel.id, "down")}>
              Z Down
            </Button>
            <Button variant="outline" onClick={() => onDuplicatePanel(selectedPanel.id)}>
              Duplicate
            </Button>
            <Button variant="destructive" onClick={() => onDeletePanel(selectedPanel.id)}>
              Delete
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Add or select a panel to edit it.</p>
      )}
    </div>
  );
}
