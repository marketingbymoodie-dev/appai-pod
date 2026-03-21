import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FrameColor } from "./types";

interface FrameColorSelectorProps {
  frameColors: FrameColor[];
  selectedFrameColor: string;
  onFrameColorChange: (colorId: string) => void;
  showLabel?: boolean;
  colorLabel?: string;
}

export function FrameColorSelector({
  frameColors,
  selectedFrameColor,
  onFrameColorChange,
  showLabel = true,
  colorLabel = "Color",
}: FrameColorSelectorProps) {
  const selected = frameColors.find((c) => c.id === selectedFrameColor);
  const isColorOption = colorLabel !== "Option";

  return (
    <div className="space-y-2">
      {showLabel && <Label>{colorLabel}</Label>}
      <Select value={selectedFrameColor} onValueChange={onFrameColorChange}>
        <SelectTrigger data-testid="select-frame-color" className="h-11">
          <SelectValue placeholder={`Select ${colorLabel.toLowerCase()}`}>
            {selected && (
              <span className="flex items-center gap-2">
                {isColorOption && (
                  <span
                    className="inline-block w-3 h-3 rounded-full border border-border shrink-0"
                    style={{ backgroundColor: selected.hex }}
                  />
                )}
                {selected.name}
              </span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {frameColors.map((color) => (
            <SelectItem
              key={color.id}
              value={color.id}
              data-testid={`option-frame-${color.id}`}
            >
              <span className="flex items-center gap-2">
                {isColorOption && (
                  <span
                    className="inline-block w-3 h-3 rounded-full border border-border shrink-0"
                    style={{ backgroundColor: color.hex }}
                  />
                )}
                {color.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
