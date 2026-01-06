import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { StylePreset } from "./types";

interface StyleSelectorProps {
  stylePresets: StylePreset[];
  selectedStyle: string;
  onStyleChange: (styleId: string) => void;
  showLabel?: boolean;
}

export function StyleSelector({
  stylePresets,
  selectedStyle,
  onStyleChange,
  showLabel = true,
}: StyleSelectorProps) {
  return (
    <div className="space-y-2">
      {showLabel && <Label className="text-sm font-medium">Style</Label>}
      <Select value={selectedStyle} onValueChange={onStyleChange}>
        <SelectTrigger data-testid="select-style" className="h-9">
          <SelectValue placeholder="Choose a style" />
        </SelectTrigger>
        <SelectContent>
          {stylePresets.map((style) => (
            <SelectItem key={style.id} value={style.id}>
              {style.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
