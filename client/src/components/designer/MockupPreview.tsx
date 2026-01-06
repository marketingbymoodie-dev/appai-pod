import { useRef, useCallback } from "react";
import { Loader2, Sparkles } from "lucide-react";
import type { PrintSize, FrameColor, ImageTransform } from "./types";

interface MockupPreviewProps {
  imageUrl?: string | null;
  isLoading?: boolean;
  selectedSize?: PrintSize | null;
  selectedFrameColor?: FrameColor | null;
  transform: ImageTransform;
  onTransformChange: (transform: ImageTransform) => void;
  enableDrag?: boolean;
}

export function MockupPreview({
  imageUrl,
  isLoading = false,
  selectedSize,
  selectedFrameColor,
  transform,
  onTransformChange,
  enableDrag = true,
}: MockupPreviewProps) {
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);

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
        x: Math.max(-50, Math.min(150, transform.x + deltaX)),
        y: Math.max(-50, Math.min(150, transform.y + deltaY)),
      });
      dragStartRef.current = { x: e.clientX, y: e.clientY };
    },
    [transform, onTransformChange]
  );

  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false;
    containerRef.current = null;
  }, []);

  return (
    <div
      className={`relative bg-muted rounded-md flex items-center justify-center w-full h-full ${
        imageUrl && enableDrag ? "cursor-move select-none" : ""
      }`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
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
          {isLoading ? (
            <div
              className="flex flex-col items-center gap-2 text-muted-foreground"
              style={{ pointerEvents: "none" }}
            >
              <Loader2 className="h-8 w-8 animate-spin" />
              <span className="text-xs">Creating...</span>
            </div>
          ) : imageUrl ? (
            <img
              src={imageUrl}
              alt="Generated artwork"
              className="select-none absolute"
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
              data-testid="img-generated"
            />
          ) : (
            <div
              className="text-center text-muted-foreground p-4"
              style={{ pointerEvents: "none" }}
            >
              <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-xs">Your artwork will appear here</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
