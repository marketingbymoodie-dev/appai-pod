import { useRef, useCallback } from "react";
import { Loader2, Sparkles } from "lucide-react";
import type { PrintSize, FrameColor, ImageTransform, PrintShape, DesignerType } from "./types";
import { SafeZoneMask } from "./SafeZoneMask";

interface ProductMockupProps {
  imageUrl?: string | null;
  /** Composite mockup URL (e.g. Printify). When provided in storefront mode,
   *  this is shown instead of the raw artwork overlaid on a blank. */
  mockupUrl?: string | null;
  isLoading?: boolean;
  /** Which phase of loading is active, used for stage-specific spinner text. */
  loadingStage?: "generating" | "mockups" | null;
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
  blankImageUrl?: string | null;
  /** The product's aspect ratio string, e.g. "3:4" or "2:1". Used to detect
   *  landscape products that need a scale-up to fill the container. */
  aspectRatio?: string;
}

export function ProductMockup({
  imageUrl,
  mockupUrl,
  isLoading = false,
  loadingStage,
  selectedSize,
  selectedFrameColor,
  transform,
  onTransformChange,
  enableDrag = true,
  printShape = "rectangle",
  designerType = "generic",
  canvasConfig,
  showSafeZone = false,
  blankImageUrl,
  aspectRatio,
}: ProductMockupProps) {
  // When a composite mockup URL is available (e.g. Printify mockup after generation),
  // display it as a full-bleed image instead of the raw artwork overlaid on a blank.
  const displayUrl = mockupUrl ?? imageUrl;
  // Debug: log to window to ensure we can see it
  if (typeof window !== 'undefined') {
    (window as any).__productMockupDebug = { designerType, imageUrl, isLoading };
  }
  console.log("[ProductMockup] RENDER designerType:", designerType, "imageUrl:", imageUrl, "isLoading:", isLoading);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);

  /**
   * Determine whether the product is landscape (wider than tall).
   * Used to decide whether to scale-up the blank image to fill the container.
   * Examples: body pillow "2:1" → landscape; phone case "3:4" → portrait.
   */
  const isLandscape = (() => {
    if (aspectRatio) {
      const [w, h] = aspectRatio.split(":").map(Number);
      if (w > 0 && h > 0) return w > h;
    }
    return false;
  })();

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
    // Skip the CSS frame overlay when:
    // - Displaying a Printify composite mockup (already has frame baked in)
    // - Displaying the blank product image (may already have frame)
    // Only show the CSS frame when the user's generated artwork is being displayed.
    const showFrameOverlay = !mockupUrl && !!imageUrl;

    if (!showFrameOverlay) {
      return (
        <div className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-md">
          {renderImageContent()}
        </div>
      );
    }

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
    // For mugs/tumblers, use the shared renderImageContent like other types
    // but with simplified absolute positioning
    return (
      <div className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-md">
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
      // During mockup generation, show artwork underneath with an overlay so
      // the user can see their design immediately while mockups are being fetched.
      if (loadingStage === "mockups" && imageUrl) {
        const scaleVal = transform.scale / 100;
        const xOffset = transform.x - 50;
        const yOffset = transform.y - 50;
        return (
          <>
            <img
              src={imageUrl}
              alt="Generated artwork"
              className="absolute inset-0 w-full h-full object-cover"
              style={{
                pointerEvents: "none",
                borderRadius: printShape === "circle" ? "50%" : undefined,
                transform: `scale(${scaleVal}) translate(${xOffset}%, ${yOffset}%)`,
                transformOrigin: "center center",
              }}
              draggable={false}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40">
              <Loader2 className="h-10 w-10 animate-spin text-white" />
              <span className="text-2xl animate-pulse font-semibold text-white mt-3 drop-shadow">Creating Mockups...</span>
            </div>
          </>
        );
      }
      // During artwork generation (no artwork available yet)
      return (
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-10 w-10 animate-spin" />
          <span className="text-2xl animate-pulse font-semibold">
            {loadingStage === "generating" ? "Generating Art..." : "Creating..."}
          </span>
        </div>
      );
    }

    // When a composite mockup URL exists, render it as a full-bleed product photo.
    // This replaces the raw-artwork-on-blank view with the actual Printify mockup.
    if (mockupUrl) {
      console.log("[ProductMockup] Rendering composite mockup URL:", mockupUrl.substring(0, 80));
      return (
        <img
          src={mockupUrl}
          alt="Product mockup"
          className="absolute inset-0 w-full h-full object-cover"
          style={{ pointerEvents: "none" }}
          draggable={false}
          data-testid="img-mockup"
          onLoad={() => console.log("[ProductMockup] Mockup loaded successfully")}
          onError={(e) => console.error("[ProductMockup] Mockup failed to load:", e)}
        />
      );
    }

    if (displayUrl) {
      // Apply CSS transform to give immediate visual feedback when user adjusts zoom/position.
      // scale: user's zoom level (100 = 1:1, 150 = 50% larger, etc.)
      // x/y: 0–100 positioning offset mapped to translate (0 = far left/top, 100 = far right/bottom)
      const scaleVal = transform.scale / 100;
      const xOffset = transform.x - 50; // -50..50 range
      const yOffset = transform.y - 50; // -50..50 range
      return (
        <img
          src={displayUrl}
          alt="Generated artwork"
          className="absolute inset-0 w-full h-full object-cover"
          style={{
            pointerEvents: "none",
            borderRadius: printShape === "circle" ? "50%" : undefined,
            transform: `scale(${scaleVal}) translate(${xOffset}%, ${yOffset}%)`,
            transformOrigin: "center center",
          }}
          draggable={false}
          data-testid="img-generated"
          onLoad={() => console.log("[ProductMockup] Image loaded successfully")}
          onError={(e) => console.error("[ProductMockup] Image failed to load:", e)}
        />
      );
    }

    if (blankImageUrl) {
      // Mug/tumbler: the blank product photo is a tall portrait shot of the tumbler
      // but the container aspect ratio is wide (wrap-around print area). Using
      // object-cover would zoom in and cut off the top/bottom of the tumbler.
      // Instead use object-contain so the full product is visible, with the
      // container background colour filling any remaining space.
      if (designerType === "mug") {
        return (
          <img
            src={blankImageUrl}
            alt="Product blank"
            className="absolute inset-0 w-full h-full object-contain"
            style={{ pointerEvents: "none", opacity: 0.92 }}
            draggable={false}
            data-testid="img-blank"
          />
        );
      }

      // For landscape/wide products (e.g. body pillow, aspect ratio wider than tall),
      // the blank photo often has side bars because the photo is shot in a square or
      // portrait orientation. We apply a subtle scale-up (110%) to fill those bars.
      // For portrait/square products (phone case, poster) object-cover alone is sufficient.
      const blankScale = isLandscape ? "scale(1.1)" : undefined;
      return (
        <img
          src={blankImageUrl}
          alt="Product blank"
          className="absolute inset-0 w-full h-full object-cover"
          style={{
            pointerEvents: "none",
            opacity: 0.92,
            transform: blankScale,
            transformOrigin: "center center",
          }}
          draggable={false}
          data-testid="img-blank"
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

  const isDragActive = !!displayUrl && enableDrag && !mockupUrl;

  return (
    <div
      className={`relative bg-muted rounded-md w-full h-full ${
        isDragActive ? "cursor-move select-none" : ""
      }`}
      style={{ touchAction: isDragActive ? "none" : "pan-y" }}
      {...(isDragActive ? {
        onMouseDown: handleMouseDown,
        onMouseMove: handleMouseMove,
        onMouseUp: handleMouseUp,
        onMouseLeave: handleMouseUp,
      } : {})}
      data-testid="product-mockup"
    >
      {renderProductMockup()}
    </div>
  );
}
