import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MockupGuide, MockupGuideType } from "../types/mockupTypes";

const GUIDE_TYPES: MockupGuideType[] = ["line", "curve", "arc", "point"];

type GuideEditorProps = {
  guides: MockupGuide[];
  selectedGuideId: string | null;
  onSelectGuide: (guideId: string) => void;
  onUpdateGuide: (guideId: string, patch: Partial<MockupGuide>) => void;
  onAddGuide: (type: MockupGuideType) => void;
  onDeleteGuide: (guideId: string) => void;
};

function numberFromInput(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function GuideEditor({
  guides,
  selectedGuideId,
  onSelectGuide,
  onUpdateGuide,
  onAddGuide,
  onDeleteGuide,
}: GuideEditorProps) {
  const selectedGuide = guides.find((guide) => guide.id === selectedGuideId) ?? guides[0] ?? null;

  return (
    <div className="space-y-4 rounded-lg border bg-background p-4">
      <div>
        <h3 className="text-sm font-semibold">Guide Editor</h3>
        <p className="text-xs text-muted-foreground">Drag guide points on the canvas, or edit coordinates below.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {GUIDE_TYPES.map((type) => (
          <Button key={type} variant="outline" size="sm" onClick={() => onAddGuide(type)}>
            Add {type}
          </Button>
        ))}
      </div>

      <div className="max-h-36 space-y-2 overflow-auto pr-1">
        {guides.map((guide) => (
          <button
            key={guide.id}
            type="button"
            onClick={() => onSelectGuide(guide.id)}
            className={`w-full rounded-md border px-3 py-2 text-left text-xs ${
              guide.id === selectedGuide?.id ? "border-primary bg-primary/10" : "bg-muted/30"
            }`}
          >
            <div className="font-medium">{guide.name}</div>
            <div className="text-muted-foreground">
              {guide.type} · {guide.points.length} point{guide.points.length === 1 ? "" : "s"}
            </div>
          </button>
        ))}
      </div>

      {selectedGuide ? (
        <div className="space-y-3">
          <Label className="space-y-1 text-xs">
            <span>Name</span>
            <Input value={selectedGuide.name} onChange={(event) => onUpdateGuide(selectedGuide.id, { name: event.target.value })} />
          </Label>

          <div className="grid grid-cols-2 gap-2">
            <Label className="space-y-1 text-xs">
              <span>Type</span>
              <select
                className="h-9 w-full rounded-md border bg-background px-2"
                value={selectedGuide.type}
                onChange={(event) => onUpdateGuide(selectedGuide.id, { type: event.target.value as MockupGuideType })}
              >
                {GUIDE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </Label>
            <Label className="space-y-1 text-xs">
              <span>Opacity</span>
              <Input
                type="number"
                step={0.05}
                value={selectedGuide.opacity}
                onChange={(event) => onUpdateGuide(selectedGuide.id, { opacity: numberFromInput(event.target.value, selectedGuide.opacity) })}
              />
            </Label>
          </div>

          <div className="space-y-2">
            {selectedGuide.points.map((point, index) => (
              <div key={`${selectedGuide.id}-${index}`} className="grid grid-cols-[auto_1fr_1fr] items-end gap-2">
                <span className="pb-2 text-xs text-muted-foreground">P{index + 1}</span>
                <Label className="space-y-1 text-xs">
                  <span>X</span>
                  <Input
                    type="number"
                    value={point.x}
                    onChange={(event) => {
                      const points = selectedGuide.points.map((p, i) =>
                        i === index ? { ...p, x: numberFromInput(event.target.value, p.x) } : p,
                      );
                      onUpdateGuide(selectedGuide.id, { points });
                    }}
                  />
                </Label>
                <Label className="space-y-1 text-xs">
                  <span>Y</span>
                  <Input
                    type="number"
                    value={point.y}
                    onChange={(event) => {
                      const points = selectedGuide.points.map((p, i) =>
                        i === index ? { ...p, y: numberFromInput(event.target.value, p.y) } : p,
                      );
                      onUpdateGuide(selectedGuide.id, { points });
                    }}
                  />
                </Label>
              </div>
            ))}
          </div>

          <Label className="space-y-1 text-xs">
            <span>Notes</span>
            <Input value={selectedGuide.notes ?? ""} onChange={(event) => onUpdateGuide(selectedGuide.id, { notes: event.target.value })} />
          </Label>

          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => onUpdateGuide(selectedGuide.id, { locked: !selectedGuide.locked })}>
              {selectedGuide.locked ? "Unlock" : "Lock"}
            </Button>
            <Button variant="destructive" onClick={() => onDeleteGuide(selectedGuide.id)}>
              Delete
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Add or select a guide to edit it.</p>
      )}
    </div>
  );
}
