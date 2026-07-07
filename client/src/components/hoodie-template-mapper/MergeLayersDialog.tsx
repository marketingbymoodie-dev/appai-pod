import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PANEL_DISPLAY_LABEL,
  panelsEligibleForView,
  resolveGarmentLayout,
  resolvePlacerEditor,
  type HoodiePanelKey,
  type HoodieView,
} from "@shared/hoodieTemplate";
import { useHoodieMapperStore } from "./store";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: HoodieView;
  layerIds: string[];
};

export default function MergeLayersDialog({ open, onOpenChange, view, layerIds }: Props) {
  const template = useHoodieMapperStore((s) => s.template);
  const actions = useHoodieMapperStore((s) => s.actions);
  const [name, setName] = useState("");
  const [panelKey, setPanelKey] = useState<string>("");
  const [removeSources, setRemoveSources] = useState(true);

  const layers = useMemo(() => {
    const viewLayers = template.views[view]?.layers ?? [];
    const idSet = new Set(layerIds);
    return viewLayers.filter((l) => idSet.has(l.id));
  }, [template, view, layerIds]);

  const defaultName = useMemo(
    () => `Merged ${layers.map((l) => l.name.replace(/ Copy(?: \d+)?$/, "")).join(" + ")}`,
    [layers],
  );

  const placerEditor = resolvePlacerEditor(template);
  const garmentLayout = resolveGarmentLayout(template);
  const eligible = panelsEligibleForView(
    view,
    template.blueprintId,
    placerEditor,
    garmentLayout,
  );

  useEffect(() => {
    if (!open) return;
    setName(defaultName);
    setPanelKey("");
    setRemoveSources(true);
  }, [open, defaultName]);

  const hasExclusion = layers.some((l) => l.isExclusion || l.kind === "exclusion");
  const canMerge = layers.length >= 2 && !hasExclusion;

  function handleMerge() {
    if (!canMerge) return;
    const id = actions.mergeSelectedLayers({
      name: name.trim() || defaultName,
      panelKey: (panelKey || null) as HoodiePanelKey | null,
      removeSources,
    });
    if (id) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Merge layers</DialogTitle>
          <DialogDescription>
            Combines the selected panel outlines into one polygon. Mesh warp is not merged — set up
            mesh again on the new layer if needed. Add a separate exclusion layer for the zip
            afterward.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-300">
            {layers.length === 0 ? (
              <span className="text-slate-500">No layers selected.</span>
            ) : (
              <ul className="list-inside list-disc space-y-0.5">
                {layers.map((l) => (
                  <li key={l.id}>
                    {l.name}
                    {l.panelKey ? (
                      <span className="text-slate-500"> · {PANEL_DISPLAY_LABEL[l.panelKey]}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {hasExclusion && (
            <p className="text-xs text-destructive">
              Exclusion layers cannot be merged — select panel masks only.
            </p>
          )}

          <div className="space-y-2">
            <Label htmlFor="merge-layer-name">New layer name</Label>
            <Input
              id="merge-layer-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="merge-layers-name"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="merge-panel-key">Panel assignment (optional)</Label>
            <select
              id="merge-panel-key"
              className="h-9 w-full rounded border border-input bg-background px-2 text-sm"
              value={panelKey}
              onChange={(e) => setPanelKey(e.target.value)}
              data-testid="merge-layers-panel"
            >
              <option value="">— assign later —</option>
              {eligible.map((k) => (
                <option key={k} value={k}>
                  {PANEL_DISPLAY_LABEL[k]}
                </option>
              ))}
            </select>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={removeSources}
              onCheckedChange={(v) => setRemoveSources(v === true)}
              data-testid="merge-layers-remove-sources"
            />
            Remove source layers after merge
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleMerge} disabled={!canMerge} data-testid="merge-layers-confirm">
            Merge into new layer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
