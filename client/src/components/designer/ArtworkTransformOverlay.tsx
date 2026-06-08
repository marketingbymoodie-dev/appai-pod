import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ImageTransform } from "./types";

type Props = {
  containerRef: RefObject<HTMLDivElement | null>;
  transform: ImageTransform;
  onTransformChange: (t: ImageTransform) => void;
  /** Natural dimensions of the artwork image (for aspect-fit math). */
  artworkAspect: number;
};

type Rect = { left: number; top: number; width: number; height: number };

/** Fit artwork rect inside container (object-contain baseline at scale 100). */
function baseFitRect(containerW: number, containerH: number, aspect: number): Rect {
  const containerAspect = containerW / containerH;
  let width: number;
  let height: number;
  if (aspect > containerAspect) {
    width = containerW;
    height = containerW / aspect;
  } else {
    height = containerH;
    width = containerH * aspect;
  }
  return {
    left: (containerW - width) / 2,
    top: (containerH - height) / 2,
    width,
    height,
  };
}

function transformToRect(
  containerW: number,
  containerH: number,
  aspect: number,
  transform: ImageTransform,
): Rect {
  const base = baseFitRect(containerW, containerH, aspect);
  const scale = transform.scale / 100;
  const width = base.width * scale;
  const height = base.height * scale;
  const cx = (transform.x / 100) * containerW;
  const cy = (transform.y / 100) * containerH;
  return {
    left: cx - width / 2,
    top: cy - height / 2,
    width,
    height,
  };
}

function rectToTransform(
  containerW: number,
  containerH: number,
  aspect: number,
  rect: Rect,
): ImageTransform {
  const base = baseFitRect(containerW, containerH, aspect);
  const scale = Math.max(25, Math.min(200, (rect.width / base.width) * 100));
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return {
    scale,
    x: Math.max(0, Math.min(100, (cx / containerW) * 100)),
    y: Math.max(0, Math.min(100, (cy / containerH) * 100)),
  };
}

type DragMode = "move" | "resize-se" | "resize-sw" | "resize-ne" | "resize-nw";

/**
 * Draggable bounding box + corner resize handles for Printify-style artwork
 * placement (maps to scale / x / y transform).
 */
export default function ArtworkTransformOverlay({
  containerRef,
  transform,
  onTransformChange,
  artworkAspect,
}: Props) {
  const [rect, setRect] = useState<Rect | null>(null);
  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    startRect: Rect;
  } | null>(null);

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el || !artworkAspect) return;
    const { width, height } = el.getBoundingClientRect();
    if (width < 1 || height < 1) return;
    setRect(transformToRect(width, height, artworkAspect, transform));
  }, [containerRef, artworkAspect, transform]);

  useEffect(() => {
    measure();
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, containerRef]);

  useEffect(() => {
    measure();
  }, [transform, measure]);

  const onPointerDown = (mode: DragMode) => (e: React.PointerEvent) => {
    if (!rect) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startRect: { ...rect },
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const el = containerRef.current;
    if (!drag || !el) return;
    e.preventDefault();
    e.stopPropagation();
    const { width: cw, height: ch } = el.getBoundingClientRect();
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const sr = drag.startRect;
    let next = { ...sr };

    if (drag.mode === "move") {
      next.left = sr.left + dx;
      next.top = sr.top + dy;
    } else {
      const minSize = 24;
      if (drag.mode === "resize-se") {
        next.width = Math.max(minSize, sr.width + dx);
        next.height = Math.max(minSize, sr.height + dy);
      } else if (drag.mode === "resize-sw") {
        next.width = Math.max(minSize, sr.width - dx);
        next.height = Math.max(minSize, sr.height + dy);
        next.left = sr.left + (sr.width - next.width);
      } else if (drag.mode === "resize-ne") {
        next.width = Math.max(minSize, sr.width + dx);
        next.height = Math.max(minSize, sr.height - dy);
        next.top = sr.top + (sr.height - next.height);
      } else if (drag.mode === "resize-nw") {
        next.width = Math.max(minSize, sr.width - dx);
        next.height = Math.max(minSize, sr.height - dy);
        next.left = sr.left + (sr.width - next.width);
        next.top = sr.top + (sr.height - next.height);
      }
      const aspect = artworkAspect;
      if (aspect > 0) {
        next.height = next.width / aspect;
        if (drag.mode === "resize-nw" || drag.mode === "resize-sw") {
          next.top = sr.top + sr.height - next.height;
        }
        if (drag.mode === "resize-nw" || drag.mode === "resize-ne") {
          next.left = sr.left + sr.width - next.width;
        }
      }
    }

    setRect(next);
    onTransformChange(rectToTransform(cw, ch, artworkAspect, next));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  if (!rect) return null;

  const handleClass =
    "absolute h-3 w-3 rounded-sm border-2 border-primary bg-background shadow-sm z-20";

  return (
    <div
      className="absolute inset-0 z-10 touch-none"
      data-appai-drag-surface
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="absolute border-2 border-dashed border-primary/80 bg-primary/5 cursor-move"
        style={{
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        }}
        onPointerDown={onPointerDown("move")}
      >
        <span
          className={`${handleClass} -left-1.5 -top-1.5 cursor-nwse-resize`}
          onPointerDown={onPointerDown("resize-nw")}
        />
        <span
          className={`${handleClass} -right-1.5 -top-1.5 cursor-nesw-resize`}
          onPointerDown={onPointerDown("resize-ne")}
        />
        <span
          className={`${handleClass} -left-1.5 -bottom-1.5 cursor-nesw-resize`}
          onPointerDown={onPointerDown("resize-sw")}
        />
        <span
          className={`${handleClass} -right-1.5 -bottom-1.5 cursor-nwse-resize`}
          onPointerDown={onPointerDown("resize-se")}
        />
      </div>
    </div>
  );
}
