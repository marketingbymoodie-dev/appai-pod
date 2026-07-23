import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

type MockupZoomPreviewProps = {
  imageUrl: string;
  /** When false, neither the expand button nor dialog render. */
  enabled?: boolean;
};

const MIN_SCALE = 1;
const MAX_SCALE = 4;

/**
 * Enlarge / pan-zoom a composite mockup in a dialog.
 * Intended for ProductMockup slides with mockupUrl only — never mount over
 * FlatProductPlacer / HoodieAopPlacer / artwork drag editing.
 */
export function MockupZoomPreview({
  imageUrl,
  enabled = true,
}: MockupZoomPreviewProps) {
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  }>({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });

  const resetView = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    if (!open) resetView();
  }, [open, resetView]);

  useEffect(() => {
    // New mockup URL while open — reset so we don't keep stale pan.
    if (open) resetView();
  }, [imageUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const clampScale = (n: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    setScale((s) => {
      const next = clampScale(s + delta);
      if (next <= MIN_SCALE) setOffset({ x: 0, y: 0 });
      return next;
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (scale <= MIN_SCALE) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      originX: offset.x,
      originY: offset.y,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current.active) return;
    setOffset({
      x: dragRef.current.originX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.originY + (e.clientY - dragRef.current.startY),
    });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  if (!enabled || !imageUrl) return null;

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className="absolute bottom-2 right-2 z-20 flex items-center gap-1 rounded-full bg-black/55 px-2.5 py-1.5 text-[11px] font-medium text-white backdrop-blur-sm transition hover:bg-black/75"
        aria-label="Zoom preview mockup"
        data-testid="button-mockup-zoom-preview"
        title="Zoom preview"
      >
        <Maximize2 className="h-3.5 w-3.5" />
        <span>Zoom</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="fixed inset-2 z-50 flex h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none translate-x-0 translate-y-0 left-2 top-2 flex-col gap-0 overflow-hidden border-0 bg-black/95 p-0 sm:rounded-lg [&>button]:hidden"
          data-testid="dialog-mockup-zoom-preview"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogTitle className="sr-only">Mockup zoom preview</DialogTitle>
          <DialogDescription className="sr-only">
            Scroll or pinch to zoom. Drag to pan when zoomed in. Press Escape to close.
          </DialogDescription>

          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded-md p-2 text-white/90 hover:bg-white/10"
                aria-label="Zoom out"
                onClick={() =>
                  setScale((s) => {
                    const next = clampScale(s - 0.25);
                    if (next <= MIN_SCALE) setOffset({ x: 0, y: 0 });
                    return next;
                  })
                }
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="rounded-md p-2 text-white/90 hover:bg-white/10"
                aria-label="Zoom in"
                onClick={() => setScale((s) => clampScale(s + 0.25))}
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <span className="min-w-[3rem] px-1 text-center text-xs text-white/70">
                {Math.round(scale * 100)}%
              </span>
            </div>
            <button
              type="button"
              className="rounded-md p-2 text-white/90 hover:bg-white/10"
              aria-label="Close zoom preview"
              data-testid="button-close-mockup-zoom"
              onClick={() => setOpen(false)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div
            className="relative min-h-0 flex-1 touch-none overflow-hidden"
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{ cursor: scale > MIN_SCALE ? "grab" : "default" }}
          >
            <img
              src={imageUrl}
              alt="Enlarged product mockup"
              draggable={false}
              className="pointer-events-none absolute left-1/2 top-1/2 max-h-full max-w-full object-contain select-none"
              style={{
                transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})`,
                transformOrigin: "center center",
              }}
              data-testid="img-mockup-zoom-preview"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default MockupZoomPreview;
