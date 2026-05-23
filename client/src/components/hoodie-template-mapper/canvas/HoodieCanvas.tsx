import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image as KonvaImage, Layer, Line, Rect, Stage } from "react-konva";
import Konva from "konva";
import { useHoodieMapperStore } from "../store";

/**
 * Konva-backed canvas for the hoodie template mapper.
 *
 * Rendering pipeline (phase 1):
 *   1. Background rect (workspace clear color).
 *   2. Optional dotted grid overlay (debug.showGrid).
 *   3. Mockup image for the active view.
 *   4. Reserved layers for: reference overlay, mask layers, tool overlays.
 *      (These are stubbed in phase 1 and filled in phases 2-4.)
 *
 * Konva is intentionally confined to this directory so later phases can
 * swap to PixiJS/WebGL without rewriting consumers (PageShell, Toolbar,
 * Sidebars). Public surface = the React component itself.
 */

type Props = {
  width: number;
  height: number;
};

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 12;
const ZOOM_STEP = 1.12;
const WORKSPACE_BG = "#0b1220";
const WORKSPACE_PAGE_BG = "#1e293b";

function isCrossOrigin(src: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const url = new URL(src, window.location.href);
    return url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function loadHtmlImage(src: string | null | undefined): Promise<HTMLImageElement | null> {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    // Only request CORS for actually cross-origin sources. Setting crossOrigin
    // on same-origin requests can fail when the server doesn't echo CORS headers.
    if (isCrossOrigin(src)) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = (e) => {
      // eslint-disable-next-line no-console
      console.warn("[hoodie-mapper] image load failed", src, e);
      resolve(null);
    };
    img.src = src;
  });
}

function useLoadedImage(src: string | null | undefined): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadHtmlImage(src ?? null).then((loaded) => {
      if (!cancelled) setImg(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [src]);
  return img;
}

export default function HoodieCanvas({ width, height }: Props) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  const view = useHoodieMapperStore((s) => s.view);
  const debug = useHoodieMapperStore((s) => s.debug);
  const mockup = useHoodieMapperStore((s) => s.template.views[s.view].mockup);
  const referenceOverlay = useHoodieMapperStore((s) => s.template.views[s.view].referenceOverlay);

  const mockupImage = useLoadedImage(mockup?.src);
  const overlayImage = useLoadedImage(referenceOverlay?.src);

  const mockupWidth = mockup?.width ?? 0;
  const mockupHeight = mockup?.height ?? 0;

  const fitToScreen = useCallback(() => {
    if (!mockupWidth || !mockupHeight || !width || !height) {
      setScale(1);
      setPosition({ x: 0, y: 0 });
      return;
    }
    const padding = 60;
    const sx = (width - padding * 2) / mockupWidth;
    const sy = (height - padding * 2) / mockupHeight;
    const next = Math.max(ZOOM_MIN, Math.min(sx, sy));
    setScale(next);
    setPosition({
      x: (width - mockupWidth * next) / 2,
      y: (height - mockupHeight * next) / 2,
    });
  }, [mockupWidth, mockupHeight, width, height]);

  // Auto-fit when mockup changes or container size changes (only if no mockup loaded yet,
  // we still center the empty workspace).
  useEffect(() => {
    fitToScreen();
  }, [fitToScreen, mockup?.src, view]);

  const onWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const stage = stageRef.current;
      if (!stage) return;
      const oldScale = scale;
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const direction = e.evt.deltaY > 0 ? -1 : 1;
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, oldScale * (direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
      const mockupCoord = {
        x: (pointer.x - position.x) / oldScale,
        y: (pointer.y - position.y) / oldScale,
      };
      const newPos = {
        x: pointer.x - mockupCoord.x * next,
        y: pointer.y - mockupCoord.y * next,
      };
      setScale(next);
      setPosition(newPos);
    },
    [scale, position.x, position.y],
  );

  // Spacebar / middle-mouse pan via stage drag. We let Konva handle the drag math.
  const stageDraggable = isPanning;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent, down: boolean) => {
      if (e.code === "Space") {
        const target = e.target as HTMLElement | null;
        if (target && /input|textarea|select/i.test(target.tagName)) return;
        e.preventDefault();
        setIsPanning(down);
      }
    };
    const onDown = (e: KeyboardEvent) => handleKey(e, true);
    const onUp = (e: KeyboardEvent) => handleKey(e, false);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  const grid = useMemo(() => {
    if (!debug.showGrid || !mockupWidth || !mockupHeight) return null;
    const step = Math.max(50, Math.round(Math.min(mockupWidth, mockupHeight) / 24));
    const lines: Array<{ key: string; points: number[] }> = [];
    for (let x = 0; x <= mockupWidth; x += step) {
      lines.push({ key: `vx-${x}`, points: [x, 0, x, mockupHeight] });
    }
    for (let y = 0; y <= mockupHeight; y += step) {
      lines.push({ key: `hz-${y}`, points: [0, y, mockupWidth, y] });
    }
    return lines;
  }, [debug.showGrid, mockupWidth, mockupHeight]);

  return (
    <div className="relative h-full w-full" data-testid="hoodie-canvas-root">
      <Stage
        ref={stageRef}
        width={Math.max(1, width)}
        height={Math.max(1, height)}
        scaleX={scale}
        scaleY={scale}
        x={position.x}
        y={position.y}
        draggable={stageDraggable}
        onWheel={onWheel}
        onDragEnd={(e) => setPosition({ x: e.target.x(), y: e.target.y() })}
        style={{ cursor: stageDraggable ? "grabbing" : "default", background: WORKSPACE_BG }}
      >
        {/* Page background — only visible if mockup loaded. */}
        <Layer listening={false}>
          {mockupWidth > 0 && mockupHeight > 0 && (
            <Rect
              x={0}
              y={0}
              width={mockupWidth}
              height={mockupHeight}
              fill={WORKSPACE_PAGE_BG}
              shadowColor="#000"
              shadowBlur={20 / scale}
              shadowOpacity={0.4}
              shadowOffsetY={6 / scale}
            />
          )}
          {grid?.map((line) => (
            <Line
              key={line.key}
              points={line.points}
              stroke="rgba(148, 163, 184, 0.12)"
              strokeWidth={1 / scale}
            />
          ))}
        </Layer>

        {/* Reference overlay below the mockup if placement is "below". */}
        {referenceOverlay && referenceOverlay.placement === "below" && overlayImage && (
          <Layer listening={false}>
            <KonvaImage
              image={overlayImage}
              x={0}
              y={0}
              width={referenceOverlay.width}
              height={referenceOverlay.height}
              opacity={referenceOverlay.visible ? referenceOverlay.opacity : 0}
            />
          </Layer>
        )}

        {/* Mockup. */}
        {mockupImage && mockupWidth > 0 && mockupHeight > 0 && (
          <Layer listening={false}>
            <KonvaImage
              image={mockupImage}
              x={0}
              y={0}
              width={mockupWidth}
              height={mockupHeight}
            />
          </Layer>
        )}

        {/* Reference overlay above the mockup. */}
        {referenceOverlay && referenceOverlay.placement === "above" && overlayImage && (
          <Layer listening={false}>
            <KonvaImage
              image={overlayImage}
              x={0}
              y={0}
              width={referenceOverlay.width}
              height={referenceOverlay.height}
              opacity={referenceOverlay.visible ? referenceOverlay.opacity : 0}
            />
          </Layer>
        )}

        {/*
          Phase 2+ layer slot: mask layers with hover/selection highlight, polygon pen,
          mesh handles, etc. Intentionally empty in phase 1.
        */}
      </Stage>

      {/* HUD: zoom indicator + fit button. */}
      <div className="pointer-events-none absolute inset-x-0 top-2 flex items-center justify-between px-3 text-[11px] text-slate-300">
        <div className="pointer-events-auto rounded bg-slate-900/70 px-2 py-1 backdrop-blur">
          {view.toUpperCase()} · zoom {Math.round(scale * 100)}%
          {mockup && <span className="ml-2 text-slate-400">{mockup.width}×{mockup.height}</span>}
        </div>
        <button
          type="button"
          className="pointer-events-auto rounded border border-slate-700 bg-slate-900/70 px-2 py-1 text-[11px] hover:bg-slate-800"
          onClick={fitToScreen}
          data-testid="hoodie-canvas-fit"
        >
          Fit to screen
        </button>
      </div>

      {!mockup && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-sm text-slate-400">
          <div className="rounded border border-dashed border-slate-700 px-6 py-4">
            <div className="font-semibold text-slate-200">No {view} mockup loaded yet.</div>
            <div className="mt-1 text-xs">Use the toolbar above to upload a {view} hoodie mockup.</div>
            <div className="mt-1 text-[11px] text-slate-500">Hold space to pan · scroll to zoom.</div>
          </div>
        </div>
      )}
    </div>
  );
}
