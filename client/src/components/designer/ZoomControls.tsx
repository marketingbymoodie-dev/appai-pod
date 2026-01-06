import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { ZoomIn, Crosshair } from "lucide-react";
import type { ImageTransform } from "./types";

interface ZoomControlsProps {
  transform: ImageTransform;
  onTransformChange: (transform: ImageTransform) => void;
  disabled?: boolean;
}

export function ZoomControls({
  transform,
  onTransformChange,
  disabled = false,
}: ZoomControlsProps) {
  const handleScaleChange = (value: number[]) => {
    onTransformChange({ ...transform, scale: value[0] });
  };

  const handleCenter = () => {
    onTransformChange({ ...transform, x: 50, y: 50 });
  };

  const handleReset = () => {
    onTransformChange({ scale: 100, x: 50, y: 50 });
  };

  if (disabled) return null;

  return (
    <div className="flex items-center gap-2 p-2 bg-muted/50 rounded-md">
      <ZoomIn className="h-4 w-4 text-muted-foreground shrink-0" />
      <Slider
        value={[transform.scale]}
        onValueChange={handleScaleChange}
        min={25}
        max={200}
        step={5}
        className="flex-1"
        data-testid="slider-scale"
      />
      <span className="text-xs text-muted-foreground w-10">
        {transform.scale}%
      </span>
      <Button
        variant="outline"
        size="icon"
        onClick={handleCenter}
        title="Center image"
        data-testid="button-center"
      >
        <Crosshair className="h-4 w-4" />
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={handleReset}
        data-testid="button-reset-transform"
      >
        Reset
      </Button>
    </div>
  );
}
