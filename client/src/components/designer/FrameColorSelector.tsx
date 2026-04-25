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

const COLOR_HEX_BY_NAME: Record<string, string> = {
  cardinal: "#8C1D40",
  "heather green": "#6B8E6B",
  "heather yellow gold": "#D9A441",
  "soft pink": "#F7B6C8",
  "heather sand dune": "#C8B99A",
};

function getDisplayHex(color: FrameColor): string {
  const name = (color.name || "").trim().toLowerCase();
  if (!color.hex || color.hex.toLowerCase() === "#888888") {
    return COLOR_HEX_BY_NAME[name] || color.hex || "#888888";
  }
  return color.hex;
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
      {showLabel && <Label className="uppercase">{colorLabel}</Label>}
      <Select value={selectedFrameColor} onValueChange={onFrameColorChange}>
        <SelectTrigger data-testid="select-frame-color" className="h-11">
          <SelectValue placeholder={`Select ${colorLabel.toLowerCase()}`}>
            {selected && (
              <span className="flex items-center gap-2">
                {isColorOption && (
                  <span
                    className="inline-block w-3 h-3 rounded-full border border-border shrink-0"
                    style={{ backgroundColor: getDisplayHex(selected) }}
                  />
                )}
                {selected.name}
              </span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-64 overflow-y-auto">
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
                    style={{ backgroundColor: getDisplayHex(color) }}
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
