import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
      <div className="grid grid-cols-3 gap-2">
        {sizes.map((size) => (
          <Button
            key={size.id}
            variant={selectedSize === size.id ? "default" : "outline"}
            className="h-auto py-2 flex flex-col text-xs"
            onClick={() => onSizeChange(size.id)}
            data-testid={`button-size-${size.id}`}
          >
            <span className="font-medium">{size.name}</span>
            {size.aspectRatio && (
              <span className="text-[10px] opacity-70">{size.aspectRatio}</span>
            )}
          </Button>
        ))}
      </div>
    </div>
  );
}
