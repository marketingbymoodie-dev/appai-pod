import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ProductAdapter, ControlsProps, MockupProps } from "../BaseDesigner";
import { ZoomControls } from "../ZoomControls";
import { SafeZoneMask } from "../SafeZoneMask";
import type { ImageTransform } from "../types";

function PillowControls({
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
        <Label className="text-sm font-medium">Pillow Size</Label>
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

      {variants.length > 0 && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">Style</Label>
          <div className="flex gap-2 flex-wrap">
            {variants.map((variant) => (
              <button
                key={variant.id}
                onClick={() => setSelectedVariant(variant.id)}
                className={`px-3 py-1.5 rounded-md border text-sm transition-all ${
                  selectedVariant === variant.id
                    ? "ring-2 ring-primary ring-offset-2 bg-primary text-primary-foreground"
                    : "bg-muted hover:bg-muted/80"
                }`}
                style={variant.hex ? { backgroundColor: variant.hex } : undefined}
                title={variant.name}
                data-testid={`button-variant-${variant.id}`}
              >
                {variant.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PillowMockup({
  imageUrl,
  transform,
  setTransform,
  printShape,
  canvasConfig,
  selectedVariant,
  variants,
  showSafeZone,
}: MockupProps) {
  const isCircular = printShape === "circle";
  const isSquare = printShape === "square" || canvasConfig.width === canvasConfig.height;
  
  const currentVariant = variants.find(v => v.id === selectedVariant);
  const pillowBackground = currentVariant?.hex || "#f5f5f5";

  if (!imageUrl) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        Generate a design to see preview
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 w-full p-4">
      <div className="relative mx-auto">
        <div 
          className={`relative ${isCircular ? 'rounded-full' : 'rounded-lg'}`}
          style={{
            boxShadow: "0 8px 32px rgba(0,0,0,0.15)",
            overflow: "hidden",
            width: isSquare ? "300px" : canvasConfig.width > canvasConfig.height ? "360px" : "280px",
            aspectRatio: `${canvasConfig.width}/${canvasConfig.height}`,
            backgroundColor: pillowBackground,
          }}
        >
          <div 
            className="absolute inset-0"
            style={{
              background: "linear-gradient(135deg, rgba(255,255,255,0.1) 0%, transparent 50%, rgba(0,0,0,0.1) 100%)",
              pointerEvents: "none",
              zIndex: 2,
            }}
          />
          
          <div 
            className={`relative w-full h-full ${isCircular ? 'rounded-full' : ''}`}
            style={{
              overflow: "hidden",
              position: "relative",
            }}
          >
            <img
              src={imageUrl}
              alt="Pillow design"
              className="absolute select-none"
              style={{
                width: `${transform.scale}%`,
                height: `${transform.scale}%`,
                objectFit: "cover",
                left: `${transform.x}%`,
                top: `${transform.y}%`,
                transform: "translate(-50%, -50%)",
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
          
          <div 
            className={`absolute inset-0 pointer-events-none ${isCircular ? 'rounded-full' : 'rounded-lg'}`}
            style={{
              border: "3px solid rgba(200,200,200,0.3)",
              boxShadow: "inset 0 2px 10px rgba(0,0,0,0.1)",
            }}
          />
        </div>
      </div>

      <div className="text-center">
        <span className="text-xs text-muted-foreground">
          {isCircular ? "Round Pillow" : isSquare ? "Square Pillow" : "Rectangular Pillow"}
          {currentVariant ? ` - ${currentVariant.name}` : ""}
        </span>
      </div>

      <ZoomControls
        transform={transform}
        onTransformChange={setTransform}
      />
    </div>
  );
}

export const PillowAdapter: ProductAdapter = {
  renderControls: (props) => <PillowControls {...props} />,
  renderMockup: (props) => <PillowMockup {...props} />,
  getDefaultTransform: () => ({ scale: 100, x: 50, y: 50 }),
};
