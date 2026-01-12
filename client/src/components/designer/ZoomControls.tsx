import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { ZoomIn, Crosshair, Move, ChevronDown, ChevronUp } from "lucide-react";
import type { ImageTransform } from "./types";

interface ZoomControlsProps {
  transform: ImageTransform;
  onTransformChange: (transform: ImageTransform) => void;
  disabled?: boolean;
  showPositionControls?: boolean;
  maxZoom?: number;
}

export function ZoomControls({
  transform,
  onTransformChange,
  disabled = false,
  showPositionControls = true,
  maxZoom = 200,
}: ZoomControlsProps) {
  const [showPosition, setShowPosition] = useState(false);

  const handleScaleChange = (value: number[]) => {
    onTransformChange({ ...transform, scale: value[0] });
  };

  const handleXChange = (value: number[]) => {
    onTransformChange({ ...transform, x: value[0] });
  };

  const handleYChange = (value: number[]) => {
    onTransformChange({ ...transform, y: value[0] });
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

      {showPositionControls && (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowPosition(!showPosition)}
            className="flex items-center gap-1 text-xs text-muted-foreground self-start"
            data-testid="button-toggle-position"
          >
            <Move className="h-3 w-3" />
            Reposition
            {showPosition ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </Button>

          {showPosition && (
            <div className="flex flex-col gap-2 p-2 bg-muted/30 rounded-md">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground w-6">X:</span>
                <Slider
                  value={[transform.x]}
                  onValueChange={handleXChange}
                  min={-50}
                  max={150}
                  step={1}
                  className="flex-1"
                  data-testid="slider-x"
                />
                <span className="text-xs text-muted-foreground w-10 text-right">{Math.round(transform.x)}%</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground w-6">Y:</span>
                <Slider
                  value={[transform.y]}
                  onValueChange={handleYChange}
                  min={-50}
                  max={150}
                  step={1}
                  className="flex-1"
                  data-testid="slider-y"
                />
                <span className="text-xs text-muted-foreground w-10 text-right">{Math.round(transform.y)}%</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
