import { useRef, useCallback } from "react";
import { Loader2, Sparkles } from "lucide-react";
import type { PrintSize, FrameColor, ImageTransform, PrintShape, DesignerType } from "./types";
import { SafeZoneMask } from "./SafeZoneMask";

interface ProductMockupProps {
  imageUrl?: string | null;
  isLoading?: boolean;
  selectedSize?: PrintSize | null;
  selectedFrameColor?: FrameColor | null;
  transform: ImageTransform;
  onTransformChange: (transform: ImageTransform) => void;
  enableDrag?: boolean;
  printShape?: PrintShape;
  designerType?: DesignerType;
  canvasConfig?: {
    width: number;
    height: number;
    safeZoneMargin: number;
    maxDimension: number;
  };
  showSafeZone?: boolean;
}

export function ProductMockup({
  imageUrl,
  isLoading = false,
  selectedSize,
  selectedFrameColor,
  transform,
  onTransformChange,
  enableDrag = true,
  printShape = "rectangle",
  designerType = "generic",
  canvasConfig,
  showSafeZone = false,
}: ProductMockupProps) {
  console.log("[ProductMockup] designerType:", designerType, "imageUrl:", imageUrl);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!imageUrl || !enableDrag) return;
      e.preventDefault();
      e.stopPropagation();
      isDraggingRef.current = true;
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      containerRef.current = e.currentTarget;
    },
    [imageUrl, enableDrag]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isDraggingRef.current || !containerRef.current) return;
      e.preventDefault();
      e.stopPropagation();

      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      if (dx === 0 && dy === 0) return;

      const deltaX = (dx / rect.width) * 100;
      const deltaY = (dy / rect.height) * 100;

      onTransformChange({
        ...transform,
        // Constrain to 0-100 range to match Printify API expectations
        x: Math.max(0, Math.min(100, transform.x + deltaX)),
        y: Math.max(0, Math.min(100, transform.y + deltaY)),
      });
      dragStartRef.current = { x: e.clientX, y: e.clientY };
    },
    [transform, onTransformChange]
  );

  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false;
    containerRef.current = null;
  }, []);

  const getProductStyles = () => {
    const baseRadius = "0.375rem";
    
    switch (designerType) {
      case "pillow":
        return {
          borderRadius: printShape === "circle" ? "50%" : "0.5rem",
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        };
      case "framed-print":
        return {
          borderRadius: baseRadius,
        };
      case "mug":
        return {
          borderRadius: "0",
        };
      default:
        return {
          borderRadius: baseRadius,
        };
    }
  };

  const renderFramedPrint = () => {
    const getFrameInsets = () => {
      if (!selectedSize) return { outer: "0.75rem", inner: "1rem" };
      const sizeId = selectedSize.id;
      if (sizeId === "11x14") {
        return { outer: "0.5rem", inner: "1.5rem" };
      } else if (["12x16", "16x16"].includes(sizeId)) {
        return { outer: "0.625rem", inner: "1.25rem" };
      }
      return { outer: "0.75rem", inner: "1rem" };
    };

    const frameInsets = getFrameInsets();

    return (
      <>
        <div
          className="absolute rounded-sm flex items-center justify-center"
          style={{
            backgroundColor: selectedFrameColor?.hex || "#1a1a1a",
            pointerEvents: "none",
            inset: frameInsets.outer,
          }}
        >
          <div
            className="absolute bg-white dark:bg-gray-200 rounded-sm flex items-center justify-center overflow-hidden"
            style={{ pointerEvents: "none", inset: frameInsets.inner }}
          >
            {renderImageContent()}
          </div>
        </div>
      </>
    );
  };

  const renderPillow = () => {
    const productStyles = getProductStyles();
    
    return (
      <div
        className="absolute inset-4 flex items-center justify-center overflow-hidden bg-gray-100 dark:bg-gray-800"
        style={{
          ...productStyles,
          pointerEvents: "none",
        }}
      >
        {printShape === "circle" && (
          <div 
            className="absolute inset-0 rounded-full overflow-hidden"
            style={{ 
              clipPath: "circle(50% at 50% 50%)",
            }}
          >
            {renderImageContent()}
          </div>
        )}
        {printShape !== "circle" && renderImageContent()}
        {showSafeZone && canvasConfig && (
          <SafeZoneMask 
            shape={printShape} 
            canvasConfig={canvasConfig}
            showMask={true}
          />
        )}
      </div>
    );
  };

  const renderMug = () => {
    // For mugs/tumblers, render directly without absolute positioning
    // This ensures the image establishes its own height based on aspect ratio
    if (isLoading) {
      return (
        <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground w-full" style={{ aspectRatio: canvasConfig ? `${canvasConfig.width}/${canvasConfig.height}` : "4/3" }}>
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="text-xs">Creating...</span>
        </div>
      );
    }
    
    if (imageUrl) {
      console.log("[ProductMockup] renderMug with URL:", imageUrl);
      return (
        <div className="relative w-full overflow-hidden rounded-md" style={{ aspectRatio: canvasConfig ? `${canvasConfig.width}/${canvasConfig.height}` : "4/3" }}>
          <img
            src={imageUrl}
            alt="Generated artwork"
            className="absolute inset-0 w-full h-full object-cover"
            draggable={false}
            data-testid="img-generated-mug"
            onLoad={() => console.log("[ProductMockup] Mug image loaded successfully")}
            onError={(e) => console.error("[ProductMockup] Mug image failed to load:", e)}
          />
          {showSafeZone && canvasConfig && (
            <SafeZoneMask 
              shape={printShape} 
              canvasConfig={canvasConfig}
              showMask={true}
            />
          )}
        </div>
      );
    }
    
    return (
      <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground w-full" style={{ aspectRatio: canvasConfig ? `${canvasConfig.width}/${canvasConfig.height}` : "4/3" }}>
        <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p className="text-xs">Your artwork will appear here</p>
      </div>
    );
  };

  const renderGeneric = () => {
    return (
      <div
        className="absolute inset-4 flex items-center justify-center overflow-hidden bg-muted rounded-md"
        style={{ pointerEvents: "none" }}
      >
        {renderImageContent()}
        {showSafeZone && canvasConfig && (
          <SafeZoneMask 
            shape={printShape} 
            canvasConfig={canvasConfig}
            showMask={true}
          />
        )}
      </div>
    );
  };

  const renderImageContent = () => {
    if (isLoading) {
      return (
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="text-xs">Creating...</span>
        </div>
      );
    }

    if (imageUrl) {
      console.log("[ProductMockup] Rendering image with URL:", imageUrl, "scale:", transform.scale);
      return (
        <img
          src={imageUrl}
          alt="Generated artwork"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
            pointerEvents: "none",
            borderRadius: printShape === "circle" ? "50%" : undefined,
          }}
          draggable={false}
          data-testid="img-generated"
          onLoad={() => console.log("[ProductMockup] Image loaded successfully")}
          onError={(e) => console.error("[ProductMockup] Image failed to load:", e)}
        />
      );
    }

    return (
      <div className="text-center text-muted-foreground p-4">
        <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p className="text-xs">Your artwork will appear here</p>
      </div>
    );
  };

  const renderProductMockup = () => {
    switch (designerType) {
      case "framed-print":
        return renderFramedPrint();
      case "pillow":
        return renderPillow();
      case "mug":
        return renderMug();
      default:
        return renderGeneric();
    }
  };

  return (
    <div
      className={`relative bg-muted rounded-md w-full flex items-center justify-center ${
        imageUrl && enableDrag ? "cursor-move select-none" : ""
      }`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      data-testid="product-mockup"
    >
      {renderProductMockup()}
    </div>
  );
}
