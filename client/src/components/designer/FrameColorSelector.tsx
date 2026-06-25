import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { resolveStoredColorHex } from "@shared/printifyColorResolver";
import { hasVariantMappingForColor, type VariantMap } from "@shared/variantMapResolve";
import type { FrameColor } from "./types";

interface FrameColorSelectorProps {
  frameColors: FrameColor[];
  selectedFrameColor: string;
  onFrameColorChange: (colorId: string) => void;
  showLabel?: boolean;
  colorLabel?: string;
  /** When set, greys out colors with no `{size}:{color}` variant mapping. */
  variantMap?: VariantMap | null;
  selectedSize?: string;
}

function getDisplayHex(color: FrameColor): string {
  return resolveStoredColorHex(color.name, color.hex).hex;
}

function colorSelectable(
  color: FrameColor,
  variantMap: VariantMap | null | undefined,
): boolean {
  if (color.variantAvailable === false) return false;
  if (!variantMap) return true;
  // Check across all sizes so XL/2XL selection doesn't grey out colors that
  // exist for S/M/L — the mockup server falls back to any matching-color variant.
  return hasVariantMappingForColor(variantMap, color.id);
}

export function FrameColorSelector({
  frameColors,
  selectedFrameColor,
  onFrameColorChange,
  showLabel = true,
  colorLabel = "Color",
  variantMap = null,
  selectedSize,
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
        <SelectContent position="popper" sideOffset={4} className="z-[200]">
          {frameColors.map((color) => {
            const selectable = colorSelectable(color, variantMap);
            return (
              <SelectItem
                key={color.id}
                value={color.id}
                disabled={!selectable}
                title={
                  selectable
                    ? undefined
                    : "This colour is not linked to a Printify variant — re-import or refresh variants in Admin."
                }
                data-testid={`option-frame-${color.id}`}
              >
                <span className={`flex items-center gap-2 ${!selectable ? "opacity-50" : ""}`}>
                  {isColorOption && (
                    <span
                      className="inline-block w-3 h-3 rounded-full border border-border shrink-0"
                      style={{ backgroundColor: getDisplayHex(color) }}
                    />
                  )}
                  {color.name}
                  {!selectable && (
                    <span className="text-[10px] text-muted-foreground">(unavailable)</span>
                  )}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
