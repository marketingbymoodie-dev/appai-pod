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
  prices?: Record<string, number>;
}

export function SizeSelector({
  sizes,
  selectedSize,
  onSizeChange,
  showLabel = true,
  prices,
}: SizeSelectorProps) {
  return (
    <div className="space-y-2">
      {showLabel && <Label>Size</Label>}
      <Select value={selectedSize} onValueChange={onSizeChange}>
        <SelectTrigger data-testid="select-size" className="h-11">
          <SelectValue placeholder="Select a size" />
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-64 overflow-y-auto">
          {sizes.map((size) => (
            <SelectItem
              key={size.id}
              value={size.id}
              data-testid={`option-size-${size.id}`}
            >
              {size.name}{prices?.[size.id] ? ` - $${(prices[size.id] / 100).toFixed(2)}` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
