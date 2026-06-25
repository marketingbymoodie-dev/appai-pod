import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ProductAdapter, ControlsProps, MockupProps } from "../BaseDesigner";
import { ZoomControls } from "../ZoomControls";
import { SafeZoneMask } from "../SafeZoneMask";
import type { ImageTransform } from "../types";

function FramedPrintControls({
  selectedSize,
  setSelectedSize,
  selectedVariant,
  setSelectedVariant,
  sizes,
  variants,
}: ControlsProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-2">
        <Label className="text-sm font-medium">Print Size</Label>
        <Select value={selectedSize} onValueChange={setSelectedSize}>
          <SelectTrigger data-testid="select-size">
            <SelectValue placeholder="Select size" />
          </SelectTrigger>
          <SelectContent>
            {sizes.map((size) => (
              <SelectItem key={size.id} value={size.id}>
                {size.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">Frame Color</Label>
        <div className="flex gap-2 flex-wrap">
          {variants.map((color) => (
            <button
              key={color.id}
              onClick={() => setSelectedVariant(color.id)}
              className={`w-8 h-8 rounded-full border-2 transition-all ${
                selectedVariant === color.id
                  ? "ring-2 ring-primary ring-offset-2"
                  : "hover:scale-110"
              }`}
              style={{ backgroundColor: color.hex }}
              title={color.name}
              data-testid={`button-frame-${color.id}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function FramedPrintMockup({
  imageUrl,
  transform,
  setTransform,
  printShape,
  canvasConfig,
  showSafeZone,
}: MockupProps) {
  if (!imageUrl) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        Generate a design to see preview
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 w-full p-4">
      <div className="relative mx-auto w-full max-w-sm">
        <div
          className="relative overflow-hidden rounded-md bg-muted"
          style={{
            aspectRatio: canvasConfig ? `${canvasConfig.width}/${canvasConfig.height}` : "4/5",
          }}
        >
          <img
            src={imageUrl}
            alt="Generated artwork"
            className="absolute select-none inset-0 w-full h-full object-contain"
            style={{
              transform: `scale(${transform.scale / 100}) translate(${transform.x - 50}%, ${transform.y - 50}%)`,
              transformOrigin: "center center",
              pointerEvents: "none",
            }}
            draggable={false}
          />
          <SafeZoneMask
            shape={printShape}
            canvasConfig={canvasConfig}
            showMask={showSafeZone}
            className="absolute inset-0"
          />
        </div>
      </div>

      <ZoomControls
        transform={transform}
        onTransformChange={setTransform}
      />
    </div>
  );
}

export const FramedPrintAdapter: ProductAdapter = {
  renderControls: (props) => <FramedPrintControls {...props} />,
  renderMockup: (props) => <FramedPrintMockup {...props} />,
  getDefaultTransform: () => ({ scale: 100, x: 50, y: 50 }),
};
