import { useEffect, useMemo, useRef } from "react";

/** Screen-pixel snap radius for centering artwork on the print-area axes. */
const SNAP_SCREEN_PX = 10;
import type { ArtworkPlacement } from "@/components/hoodie-template-mapper/lib/aopPreview";
import {
  flatArtBox,
  flatPlacementRectPx,
  flatVisibleRectPx,
  FLAT_SCALE_MIN,
  type Rect,
} from "./lib/flatRender";
import type { FlatViewCalibration } from "@/pages/embed-design";

/**
 * Self-contained drag/resize overlay for the flat-product placer.
 *
 * Mirrors the UX of the hoodie `DesignRectHandlesOverlay` (corner handles +
 * drag-to-move, aspect locked) but works directly off the flat manifest's
 * visible-print-rect instead of a hoodie template. It also paints a faint
 * dashed guide for the printable area so customers can see when their artwork
 * doesn't fully cover it.
 *
 * Placement is stored normalized to the print rect (offset = fraction of rect
 * width/height; scale relative to the "cover" baseline) so it stays reusable
 * for print-file generation. Pointer math converts CSS-pixel deltas → mockup
 * px → normalized units, so it's accurate at any display size.
 */
export type FlatDesignRectOverlayProps = {
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  view: FlatViewCalibration;
  artwork: HTMLImageElement;
  placement: ArtworkPlacement;
  /** Phone cases / rigid edge-wrap products (not apparel). */
  edgeWrapMode?: boolean;
  /** Safe visible back-face guide in mockup px (edge-wrap inner dashed line). */
  innerGuideRect?: Rect | null;
  /** Full print canvas guide in mockup px (edge-wrap outer dashed line). */
  outerGuideRect?: Rect | null;
  /** Placement coordinate rect in mockup px (defaults to visible print rect). */
  placementRect?: Rect | null;
  /** Max placement scale (decor / edge-wrap allow zoom past 100%). */
  scaleMax?: number;
  /** Amber safe-zone guide (edge-wrap inner line). Default true. */
  showInnerGuide?: boolean;
  /** Blue print-canvas guide (edge-wrap outer line). Default auto when distinct from inner. */
  showOuterGuide?: boolean;
  onChange: (next: ArtworkPlacement) => void;
  /** Fired on drag/resize so the canvas backdrop can ignore the trailing click. */
  onDragActivity?: () => void;
};

export default function FlatDesignRectOverlay({
  canvasRef,
  view,
  artwork,
  placement,
  edgeWrapMode = false,
  innerGuideRect = null,
  outerGuideRect = null,
  placementRect = null,
  scaleMax = 1,
  showInnerGuide = true,
  showOuterGuide,
  onChange,
  onDragActivity,
}: FlatDesignRectOverlayProps) {
  const latestPlacementRef = useRef(placement);
  useEffect(() => {
    latestPlacementRef.current = placement;
  }, [placement]);

  const dragRef = useRef<
    | null
    | {
        mode: "translate" | "scale";
        startClientX: number;
        startClientY: number;
        startPlacement: ArtworkPlacement;
        canvasRect: DOMRect;
        rect: Rect;
        center: { x: number; y: number };
      }
  >(null);

  // Mockup-px dimensions of the canvas (set by the renderer).
  const mockupW = canvasRef.current?.width || view.mockupDims?.width || 1;
  const mockupH = canvasRef.current?.height || view.mockupDims?.height || 1;

  const artW = artwork.naturalWidth || artwork.width;
  const artH = artwork.naturalHeight || artwork.height;

  const rect = useMemo(() => {
    if (placementRect) return placementRect;
    if (edgeWrapMode && outerGuideRect) return outerGuideRect;
    return flatVisibleRectPx(view, mockupW, mockupH);
  }, [placementRect, edgeWrapMode, outerGuideRect, view, mockupW, mockupH]);

  const safeGuideRect = useMemo(() => {
    if (edgeWrapMode && innerGuideRect) return innerGuideRect;
    return rect;
  }, [edgeWrapMode, innerGuideRect, rect]);
  const box = useMemo(
    () => flatArtBox(rect, placement, artW, artH),
    [rect, placement, artW, artH],
  );

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      onDragActivity?.();
      const sx = mockupW / drag.canvasRect.width;
      const sy = mockupH / drag.canvasRect.height;

      if (drag.mode === "translate") {
        const dxMock = (e.clientX - drag.startClientX) * sx;
        const dyMock = (e.clientY - drag.startClientY) * sy;
        const dOffX = drag.rect.width > 0 ? dxMock / drag.rect.width : 0;
        const dOffY = drag.rect.height > 0 ? dyMock / drag.rect.height : 0;
        const clamp = (v: number) => Math.max(-0.75, Math.min(0.75, v));
        const next = {
          ...drag.startPlacement,
          offsetX: clamp(drag.startPlacement.offsetX + dOffX),
          offsetY: clamp(drag.startPlacement.offsetY + dOffY),
        };
        latestPlacementRef.current = next;
        onChange(next);
        return;
      }

      // Scale around the box centre (matches the slider). Aspect is locked, so
      // derive the uniform scale from the pointer's distance to the centre.
      const mx = (e.clientX - drag.canvasRect.left) * sx;
      const my = (e.clientY - drag.canvasRect.top) * sy;
      const halfW = Math.abs(mx - drag.center.x);
      const halfH = Math.abs(my - drag.center.y);
      const cover = Math.max(
        drag.rect.width / Math.max(1, artW),
        drag.rect.height / Math.max(1, artH),
      );
      const baseW = (artW * cover) / 2;
      const baseH = (artH * cover) / 2;
      // Pick whichever axis the pointer pushed proportionally further.
      const scaleFromW = baseW > 0 ? halfW / baseW : drag.startPlacement.scale;
      const scaleFromH = baseH > 0 ? halfH / baseH : drag.startPlacement.scale;
      let next = Math.max(scaleFromW, scaleFromH);
      next = Math.max(FLAT_SCALE_MIN, Math.min(scaleMax, next));
      onChange({ ...drag.startPlacement, scale: next });
    }
    function onUp() {
      const drag = dragRef.current;
      if (drag?.mode === "translate") {
        const cur = latestPlacementRef.current;
        const currentBox = flatArtBox(drag.rect, cur, artW, artH);
        const snapX = SNAP_SCREEN_PX * (mockupW / drag.canvasRect.width);
        const snapY = SNAP_SCREEN_PX * (mockupH / drag.canvasRect.height);
        const rectCx = drag.rect.x + drag.rect.width / 2;
        const rectCy = drag.rect.y + drag.rect.height / 2;
        const boxCx = currentBox.x + currentBox.width / 2;
        const boxCy = currentBox.y + currentBox.height / 2;
        let offsetX = cur.offsetX;
        let offsetY = cur.offsetY;
        if (Math.abs(boxCx - rectCx) <= snapX) offsetX = 0;
        if (Math.abs(boxCy - rectCy) <= snapY) offsetY = 0;
        if (offsetX !== cur.offsetX || offsetY !== cur.offsetY) {
          const snapped = { ...cur, offsetX, offsetY };
          latestPlacementRef.current = snapped;
          onChange(snapped);
        }
      }
      dragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // onChange is read fresh from closure each move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mockupW, mockupH, artW, artH, onChange, scaleMax]);

  const startDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    mode: "translate" | "scale",
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const canvas = canvasRef.current;
    if (!canvas) return;
    dragRef.current = {
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPlacement: placement,
      canvasRect: canvas.getBoundingClientRect(),
      rect,
      center: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const pct = (r: Rect) => ({
    left: (r.x / mockupW) * 100,
    top: (r.y / mockupH) * 100,
    width: (r.width / mockupW) * 100,
    height: (r.height / mockupH) * 100,
  });
  const rectPct = pct(rect);
  const boxPct = pct(box);
  const outerPct = outerGuideRect ? pct(outerGuideRect) : null;
  const innerPct = pct(safeGuideRect);
  const guidesOverlap =
    outerPct &&
    Math.abs(innerPct.left - outerPct.left) < 0.5 &&
    Math.abs(innerPct.top - outerPct.top) < 0.5 &&
    Math.abs(innerPct.width - outerPct.width) < 0.5 &&
    Math.abs(innerPct.height - outerPct.height) < 0.5;
  const showOuterGuideLine =
    showOuterGuide ??
    (edgeWrapMode && !!outerPct && !guidesOverlap);

  const handleSize = 14;
  const cornerStyle = (
    corner: "nw" | "ne" | "sw" | "se",
  ): React.CSSProperties => {
    const isE = corner.includes("e");
    const isS = corner.includes("s");
    return {
      position: "absolute",
      width: handleSize,
      height: handleSize,
      [isE ? "right" : "left"]: -handleSize / 2,
      [isS ? "bottom" : "top"]: -handleSize / 2,
      cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
    } as React.CSSProperties;
  };

  return (
    <div
      className="pointer-events-none absolute inset-0"
      data-testid="flat-rect-overlay"
    >
      {/* Full print canvas (edge-wrap outer guide). */}
      {showOuterGuideLine && outerPct && (
        <div
          className="pointer-events-none absolute border-2 border-dashed border-sky-400/95"
          style={{
            left: `${outerPct!.left}%`,
            top: `${outerPct!.top}%`,
            width: `${outerPct!.width}%`,
            height: `${outerPct!.height}%`,
            boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
          }}
          title="Full print area — artwork must cover this outline (includes edge bleed and side wrap)"
        />
      )}

      {showInnerGuide && (edgeWrapMode ? safeGuideRect : rect) && (
      <div
        className={`pointer-events-none absolute border-2 border-dashed ${
          edgeWrapMode
            ? "border-amber-300/95"
            : "border-white/70 mix-blend-difference"
        }`}
        style={{
          left: `${innerPct.left}%`,
          top: `${innerPct.top}%`,
          width: `${innerPct.width}%`,
          height: `${innerPct.height}%`,
          ...(edgeWrapMode ? { boxShadow: "0 0 0 1px rgba(0,0,0,0.35)" } : {}),
        }}
        title={
          edgeWrapMode
            ? "Safe visible back face — extend artwork past this line for edge printing"
            : "Printable area"
        }
      />
      )}

      {/* Artwork bounding box with drag + corner-resize handles. */}
      <div
        className="pointer-events-auto absolute select-none"
        style={{
          left: `${boxPct.left}%`,
          top: `${boxPct.top}%`,
          width: `${boxPct.width}%`,
          height: `${boxPct.height}%`,
        }}
        // Stop clicks from toggling the canvas backdrop; drag/resize uses
        // window pointerup (must not stopPropagation on pointerup or capture
        // retargeting prevents the global listener from ending the gesture).
        onClick={(e) => e.stopPropagation()}
      >
        <div
          onPointerDown={(e) => startDrag(e, "translate")}
          className="absolute inset-0 cursor-move ring-2 ring-primary/70 transition hover:bg-primary/5"
          style={{ touchAction: "none" }}
          title="Drag to move artwork"
        />
        {(["nw", "ne", "sw", "se"] as const).map((c) => (
          <div
            key={c}
            onPointerDown={(e) => startDrag(e, "scale")}
            style={{ ...cornerStyle(c), touchAction: "none" }}
            className="rounded-sm border-2 border-primary/40 bg-primary shadow-md hover:scale-110"
            title="Drag corner to resize (aspect locked, max 100%)"
          />
        ))}
      </div>
    </div>
  );
}
