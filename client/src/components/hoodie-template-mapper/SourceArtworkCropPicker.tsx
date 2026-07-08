import { useCallback, useEffect, useRef, useState } from "react";
import type { SourceRect } from "@shared/hoodieTemplate";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import { useMapperAssetImage } from "./lib/useMapperAssetImage";

const MIN_CROP_PX = 24;

type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move";

type ImageLayout = {
  naturalW: number;
  naturalH: number;
  offsetX: number;
  offsetY: number;
  scale: number;
};

function resolveSourceRect(
  stored: SourceRect | null | undefined,
  naturalW: number,
  naturalH: number,
): SourceRect {
  if (stored && stored.width > 0 && stored.height > 0) return stored;
  return { x: 0, y: 0, width: naturalW, height: naturalH };
}

function clampSourceRect(rect: SourceRect, maxW: number, maxH: number): SourceRect {
  const width = Math.max(MIN_CROP_PX, Math.min(rect.width, maxW));
  const height = Math.max(MIN_CROP_PX, Math.min(rect.height, maxH));
  const x = Math.max(0, Math.min(rect.x, maxW - width));
  const y = Math.max(0, Math.min(rect.y, maxH - height));
  return { x, y, width, height };
}

function imageRectToDisplay(rect: SourceRect, layout: ImageLayout) {
  return {
    x: layout.offsetX + rect.x * layout.scale,
    y: layout.offsetY + rect.y * layout.scale,
    width: rect.width * layout.scale,
    height: rect.height * layout.scale,
  };
}

function displayPointToImage(
  px: number,
  py: number,
  layout: ImageLayout,
): { x: number; y: number } {
  return {
    x: (px - layout.offsetX) / layout.scale,
    y: (py - layout.offsetY) / layout.scale,
  };
}

function applyHandleDrag(
  handle: HandleId,
  startRect: SourceRect,
  pointer: { x: number; y: number },
  startPointer: { x: number; y: number },
  naturalW: number,
  naturalH: number,
): SourceRect {
  const dx = pointer.x - startPointer.x;
  const dy = pointer.y - startPointer.y;
  let { x, y, width, height } = startRect;

  if (handle === "move") {
    return clampSourceRect({ x: x + dx, y: y + dy, width, height }, naturalW, naturalH);
  }

  if (handle.includes("w")) {
    const nx = x + dx;
    const nw = width - dx;
    if (nw >= MIN_CROP_PX) {
      x = nx;
      width = nw;
    }
  }
  if (handle.includes("e")) {
    width = Math.max(MIN_CROP_PX, width + dx);
  }
  if (handle.includes("n")) {
    const ny = y + dy;
    const nh = height - dy;
    if (nh >= MIN_CROP_PX) {
      y = ny;
      height = nh;
    }
  }
  if (handle.includes("s")) {
    height = Math.max(MIN_CROP_PX, height + dy);
  }

  return clampSourceRect({ x, y, width, height }, naturalW, naturalH);
}

type Props = {
  src: string;
  alt: string;
  sourceRect: SourceRect | null | undefined;
  active?: boolean;
  disabled?: boolean;
  onChange: (rect: SourceRect, opts?: { recordUndo?: boolean }) => void;
};

export default function SourceArtworkCropPicker({
  src,
  alt,
  sourceRect,
  active = false,
  disabled = false,
  onChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { previewUrl, img, loading, error } = useMapperAssetImage(src);
  const [layout, setLayout] = useState<ImageLayout | null>(null);
  const dragRef = useRef<{
    handle: HandleId;
    startRect: SourceRect;
    startPointer: { x: number; y: number };
  } | null>(null);
  const pendingRectRef = useRef<SourceRect | null>(null);

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!img) return;
    const cw = el?.clientWidth ?? 0;
    const ch = el?.clientHeight ?? 280;
    if (cw <= 0 || ch <= 0) return;
    const scale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
    const displayW = img.naturalWidth * scale;
    const displayH = img.naturalHeight * scale;
    setLayout({
      naturalW: img.naturalWidth,
      naturalH: img.naturalHeight,
      offsetX: (cw - displayW) / 2,
      offsetY: (ch - displayH) / 2,
      scale,
    });
  }, [img]);

  useEffect(() => {
    if (!img) {
      setLayout(null);
      return;
    }
    const id = requestAnimationFrame(() => measure());
    return () => cancelAnimationFrame(id);
  }, [img, previewUrl, measure]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !img) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [img, measure]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      const el = containerRef.current;
      if (!drag || !layout || !el) return;
      const bounds = el.getBoundingClientRect();
      const pointer = displayPointToImage(
        e.clientX - bounds.left,
        e.clientY - bounds.top,
        layout,
      );
      const start = displayPointToImage(
        drag.startPointer.x - bounds.left,
        drag.startPointer.y - bounds.top,
        layout,
      );
      const next = applyHandleDrag(
        drag.handle,
        drag.startRect,
        pointer,
        start,
        layout.naturalW,
        layout.naturalH,
      );
      pendingRectRef.current = next;
      onChange(next, { recordUndo: false });
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      if (pendingRectRef.current) {
        onChange(pendingRectRef.current, { recordUndo: true });
        pendingRectRef.current = null;
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [layout, onChange]);

  const beginDrag = (handle: HandleId, e: React.PointerEvent) => {
    if (disabled || !layout) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = resolveSourceRect(sourceRect, layout.naturalW, layout.naturalH);
    dragRef.current = {
      handle,
      startRect: rect,
      startPointer: { x: e.clientX, y: e.clientY },
    };
  };

  const rect =
    layout != null
      ? resolveSourceRect(sourceRect, layout.naturalW, layout.naturalH)
      : null;
  const box = layout && rect ? imageRectToDisplay(rect, layout) : null;
  const handleSize = 10;
  const handles: Array<{ id: HandleId; left: number; top: number; cursor: string }> =
    box != null
      ? [
          { id: "nw", left: box.x, top: box.y, cursor: "nwse-resize" },
          { id: "n", left: box.x + box.width / 2, top: box.y, cursor: "ns-resize" },
          { id: "ne", left: box.x + box.width, top: box.y, cursor: "nesw-resize" },
          { id: "e", left: box.x + box.width, top: box.y + box.height / 2, cursor: "ew-resize" },
          { id: "se", left: box.x + box.width, top: box.y + box.height, cursor: "nwse-resize" },
          { id: "s", left: box.x + box.width / 2, top: box.y + box.height, cursor: "ns-resize" },
          { id: "sw", left: box.x, top: box.y + box.height, cursor: "nesw-resize" },
          { id: "w", left: box.x, top: box.y + box.height / 2, cursor: "ew-resize" },
        ]
      : [];

  const resetFull = () => {
    if (!layout) return;
    onChange(
      { x: 0, y: 0, width: layout.naturalW, height: layout.naturalH },
      { recordUndo: true },
    );
  };

  const isFullSheet =
    rect != null &&
    layout != null &&
    rect.x <= 0.5 &&
    rect.y <= 0.5 &&
    Math.abs(rect.width - layout.naturalW) <= 1 &&
    Math.abs(rect.height - layout.naturalH) <= 1;

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        className={`relative h-44 overflow-hidden rounded border bg-slate-950 ${
          active ? "border-fuchsia-400 ring-1 ring-fuchsia-500/40" : "border-slate-800"
        } ${disabled ? "opacity-60" : ""}`}
      >
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-500">
            Loading artwork…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center px-2 text-center text-[10px] text-red-300">
            Could not load artwork preview
            {error ? <span className="mt-1 block text-slate-500">{error}</span> : null}
          </div>
        )}
        {!loading && !error && previewUrl && (
          <img
            src={previewUrl}
            alt={alt}
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
            draggable={false}
          />
        )}

        {box && rect && (
          <>
            {/* Dim outside crop */}
            <div className="pointer-events-none absolute inset-0">
              <div
                className="absolute bg-slate-950/70"
                style={{ left: 0, top: 0, width: "100%", height: Math.max(0, box.y) }}
              />
              <div
                className="absolute bg-slate-950/70"
                style={{
                  left: 0,
                  top: box.y + box.height,
                  width: "100%",
                  height: `calc(100% - ${box.y + box.height}px)`,
                }}
              />
              <div
                className="absolute bg-slate-950/70"
                style={{ left: 0, top: box.y, width: Math.max(0, box.x), height: box.height }}
              />
              <div
                className="absolute bg-slate-950/70"
                style={{
                  left: box.x + box.width,
                  top: box.y,
                  width: `calc(100% - ${box.x + box.width}px)`,
                  height: box.height,
                }}
              />
            </div>

            {/* Crop box */}
            <div
              className="absolute border-2 border-fuchsia-400 bg-fuchsia-400/10"
              style={{
                left: box.x,
                top: box.y,
                width: box.width,
                height: box.height,
                cursor: disabled ? "default" : "move",
              }}
              onPointerDown={(e) => beginDrag("move", e)}
            />

            {!disabled &&
              handles.map((h) => (
                <div
                  key={h.id}
                  className="absolute z-10 rounded-sm border border-white bg-fuchsia-400 shadow"
                  style={{
                    left: h.left - handleSize / 2,
                    top: h.top - handleSize / 2,
                    width: handleSize,
                    height: handleSize,
                    cursor: h.cursor,
                  }}
                  onPointerDown={(e) => beginDrag(h.id, e)}
                />
              ))}
          </>
        )}
      </div>

      {rect && layout && (
        <div className="flex items-center justify-between gap-2 text-[10px] text-slate-500">
          <span>
            Slice {Math.round(rect.x)}, {Math.round(rect.y)} · {Math.round(rect.width)}×
            {Math.round(rect.height)} px
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px] text-slate-400 hover:text-slate-200"
            disabled={disabled || isFullSheet}
            onClick={resetFull}
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            Full sheet
          </Button>
        </div>
      )}
    </div>
  );
}
