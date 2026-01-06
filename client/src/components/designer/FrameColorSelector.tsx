import { Label } from "@/components/ui/label";
import type { FrameColor } from "./types";

interface FrameColorSelectorProps {
  frameColors: FrameColor[];
  selectedFrameColor: string;
  onFrameColorChange: (colorId: string) => void;
  showLabel?: boolean;
}

export function FrameColorSelector({
  frameColors,
  selectedFrameColor,
  onFrameColorChange,
  showLabel = true,
}: FrameColorSelectorProps) {
  return (
    <div className="space-y-2">
      {showLabel && <Label className="text-sm font-medium">Frame</Label>}
      <div className="flex gap-2">
        {frameColors.map((color) => (
          <button
            key={color.id}
            className={`w-10 h-10 rounded-md border-2 transition-all ${
              selectedFrameColor === color.id
                ? "border-primary ring-2 ring-primary ring-offset-2"
                : "border-muted"
            }`}
            style={{ backgroundColor: color.hex }}
            onClick={() => onFrameColorChange(color.id)}
            title={color.name}
            data-testid={`button-frame-${color.id}`}
          />
        ))}
      </div>
    </div>
  );
}
