import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PrintSize } from "./types";

interface SizeSelectorProps {
  sizes: PrintSize[];
  selectedSize: string;
  onSizeChange: (sizeId: string) => void;
  showLabel?: boolean;
}

export function SizeSelector({
  sizes,
  selectedSize,
  onSizeChange,
  showLabel = true,
}: SizeSelectorProps) {
  return (
    <div className="space-y-2">
      {showLabel && <Label className="text-sm font-medium">Size</Label>}
      <Select value={selectedSize} onValueChange={onSizeChange}>
        <SelectTrigger data-testid="select-size">
          <SelectValue placeholder="Select a size" />
        </SelectTrigger>
        <SelectContent>
          {sizes.map((size) => (
            <SelectItem
              key={size.id}
              value={size.id}
              data-testid={`option-size-${size.id}`}
            >
              {size.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
