import type React from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { ZoomIn, Crosshair } from "lucide-react";
import type { ImageTransform } from "./types";

interface ZoomControlsProps {
  transform: ImageTransform;
  onTransformChange: (transform: ImageTransform) => void;
  disabled?: boolean;
  maxZoom?: number;
  extraActions?: React.ReactNode;
  /** When false, hides the drag/resize hint (e.g. Printify composite mockup view). */
  showDragHint?: boolean;
}

export function ZoomControls({
  transform,
  onTransformChange,
  disabled = false,
  maxZoom = 200,
  extraActions,
  showDragHint = true,
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
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 p-2 bg-muted/50 rounded-md">
        <ZoomIn className="h-4 w-4 text-muted-foreground shrink-0" />
        <Slider
          value={[transform.scale]}
          onValueChange={handleScaleChange}
          min={25}
          max={maxZoom}
          step={5}
          className="flex-1"
          data-testid="slider-scale"
        />
        <span className="text-xs text-muted-foreground w-14 text-right">
          Zoom: {transform.scale}%
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

      {extraActions ? (
        <div className="flex items-center gap-2 flex-wrap">{extraActions}</div>
      ) : null}
      {showDragHint ? (
        <p className="text-[10px] text-muted-foreground">
          Drag the artwork box on the preview to reposition; use corners to resize.
        </p>
      ) : null}
    </div>
  );
}
