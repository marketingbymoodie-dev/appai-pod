import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image as KonvaImage, Layer, Line, Rect, Stage } from "react-konva";
import Konva from "konva";
import {
  DEFAULT_MAGNETIC_RADIUS,
  MIN_MASK_ANCHORS,
  useHoodieMapperStore,
} from "../store";
import {
  buildEdgeGradientMap,
  findEdgeSnap,
  type EdgeGradientMap,
} from "./edgeDetection";
import {
  distSq,
  nearestEdge,
  svgPathToAnchors,
  anchorsToSvgPath,
} from "../lib/svgPath";
import MaskLayersOverlay from "./MaskLayersOverlay";
import PenToolOverlay from "./PenToolOverlay";
import AnchorHandlesOverlay from "./AnchorHandlesOverlay";
import type { Pt } from "@shared/hoodieTemplate";

/**
 * Konva-backed canvas for the hoodie template mapper.
 *
 * Phase 2 wires:
 *   - Saved mask layers (rendered with hover + selection highlights).
 *   - Polygon pen + magnetic pen (in-progress draft, snap target indicator).
 *   - Anchor handles for the selected layer (drag to move, alt-click delete,
 *     alt-click on an edge of the layer to insert).
 *   - Magnetic edge gradient map computed once per mockup load.
 *
 * Konva is intentionally confined to this directory so a later PixiJS/WebGL
 * migration won't ripple through consumers.
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
/** Cursor distance to anchor[0] (in mockup pixels) at which clicking closes the loop. */
const PEN_CLOSE_RADIUS = 12;
/** Distance to nearest edge (in mockup px) at which alt-click inserts a new anchor. */
const EDGE_INSERT_THRESHOLD = 14;

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

  // Store wiring.
  const view = useHoodieMapperStore((s) => s.view);
  const tool = useHoodieMapperStore((s) => s.tool);
  const debug = useHoodieMapperStore((s) => s.debug);
  const layers = useHoodieMapperStore((s) => s.template.views[s.view].layers);
  const selectedLayerId = useHoodieMapperStore((s) => s.selectedLayerId);
  const hoverLayerId = useHoodieMapperStore((s) => s.hoverLayerId);
  const penDraft = useHoodieMapperStore((s) => s.penDraft);
  const magneticRadius = useHoodieMapperStore((s) => s.magneticRadius);
  const selectedAnchorIndex = useHoodieMapperStore((s) => s.selectedAnchorIndex);
  const mockup = useHoodieMapperStore((s) => s.template.views[s.view].mockup);
  const referenceOverlay = useHoodieMapperStore((s) => s.template.views[s.view].referenceOverlay);
  const actions = useHoodieMapperStore((s) => s.actions);

  const mockupImage = useLoadedImage(mockup?.src);
  const overlayImage = useLoadedImage(referenceOverlay?.src);

  const mockupWidth = mockup?.width ?? 0;
  const mockupHeight = mockup?.height ?? 0;

  // Build the magnetic edge map exactly once per mockup load (cheap to keep
  // around, expensive to recompute). Disabled when the canvas is tainted
  // (e.g. cross-origin without CORS) — magnetic pen falls back to plain
  // polygon behavior in that case.
  const [edgeMap, setEdgeMap] = useState<EdgeGradientMap | null>(null);
  useEffect(() => {
    if (!mockupImage) {
      setEdgeMap(null);
      return;
    }
    // Defer the heavy Sobel pass off the React render path.
    const handle = window.setTimeout(() => {
      try {
        setEdgeMap(buildEdgeGradientMap(mockupImage));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[hoodie-mapper] edge map failed", err);
        setEdgeMap(null);
      }
    }, 16);
    return () => window.clearTimeout(handle);
  }, [mockupImage]);

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
      const next = Math.max(
        ZOOM_MIN,
        Math.min(ZOOM_MAX, oldScale * (direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)),
      );
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

  // Spacebar pan.
  useEffect(() => {
    function onDown(e: KeyboardEvent) {
      if (e.code === "Space") {
        const target = e.target as HTMLElement | null;
        if (target && /input|textarea|select/i.test(target.tagName)) return;
        e.preventDefault();
        setIsPanning(true);
      }
    }
    function onUp(e: KeyboardEvent) {
      if (e.code === "Space") setIsPanning(false);
    }
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  // Pen-tool keyboard: Enter/Escape/Backspace.
  const isPenActive = tool === "polygon-pen" || tool === "magnetic-pen";
  useEffect(() => {
    if (!isPenActive) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /input|textarea|select/i.test(target.tagName)) return;
      if (e.code === "Enter") {
        e.preventDefault();
        actions.closePenDraft();
      } else if (e.code === "Escape") {
        e.preventDefault();
        actions.cancelPenDraft();
      } else if (e.code === "Backspace") {
        e.preventDefault();
        actions.popPenAnchor();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPenActive, actions]);

  // Convert stage pointer to mockup coordinates.
  const pointerToMockup = useCallback((): Pt | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const p = stage.getPointerPosition();
    if (!p) return null;
    return { x: (p.x - position.x) / scale, y: (p.y - position.y) / scale };
  }, [position.x, position.y, scale]);

  // Effective magnetic radius: 0 for polygon pen, full radius for magnetic pen.
  const effectiveSnapRadius = tool === "magnetic-pen" ? magneticRadius : 0;

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

  // Selected layer for anchor editing.
  const selectedLayer = useMemo(
    () => layers.find((l) => l.id === selectedLayerId) ?? null,
    [layers, selectedLayerId],
  );
  const selectedAnchors = useMemo(
    () => (selectedLayer ? svgPathToAnchors(selectedLayer.maskPath) : []),
    [selectedLayer],
  );
  // While dragging an anchor we don't push every move into the global store
  // (which would re-serialize the path on every frame). Local state buffers
  // the in-flight drag and we commit once on drag end.
  const [dragAnchors, setDragAnchors] = useState<Pt[] | null>(null);
  const liveAnchors = dragAnchors ?? selectedAnchors;

  // Stage handlers — pen click + canvas-clear-selection + edge insert.
  const handleStageMouseDown = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      // Skip if clicking through to a child (mask, anchor handle, etc.) that
      // already handled the event.
      if (e.target !== e.target.getStage()) return;
      const evt = e.evt;
      if (evt.button !== 0) return;
      const mockupPt = pointerToMockup();
      if (!mockupPt) return;

      // Pen tool clicks: append/close.
      if (isPenActive) {
        const draft = penDraft;
        if (!draft || draft.anchors.length === 0) {
          actions.startPenDraft();
          actions.appendPenAnchor(snapPoint(mockupPt));
          return;
        }
        // Close on click near anchor[0] when ≥ MIN_MASK_ANCHORS.
        if (
          draft.anchors.length >= MIN_MASK_ANCHORS &&
          distSq(mockupPt, draft.anchors[0]) <= PEN_CLOSE_RADIUS * PEN_CLOSE_RADIUS
        ) {
          actions.closePenDraft();
          return;
        }
        actions.appendPenAnchor(snapPoint(mockupPt));
        return;
      }

      // Move tool: alt-click on a layer's edge to insert an anchor.
      if (tool === "move" && evt.altKey && selectedLayer) {
        const anchors = svgPathToAnchors(selectedLayer.maskPath);
        const ne = nearestEdge(mockupPt, anchors);
        if (ne && Math.sqrt(ne.distSq) <= EDGE_INSERT_THRESHOLD / scale) {
          const insertAt = (ne.segmentIndex + 1) % (anchors.length + 1);
          const next = [...anchors];
          next.splice(insertAt, 0, ne.point);
          actions.setLayerAnchors(selectedLayer.id, next);
          actions.setSelectedAnchorIndex(insertAt);
          return;
        }
      }

      // Background click clears selection (in move tool only).
      if (tool === "move") {
        actions.setSelectedLayer(null);
      }
    },
    [actions, isPenActive, penDraft, pointerToMockup, scale, selectedLayer, tool],
  );

  // Snap a raw mockup point to the nearest strong edge when the magnetic pen
  // is active. Falls through unchanged otherwise.
  const snapPoint = useCallback(
    (raw: Pt): Pt => {
      if (effectiveSnapRadius <= 0) return raw;
      const snapped = findEdgeSnap(edgeMap, raw, effectiveSnapRadius);
      return snapped ?? raw;
    },
    [edgeMap, effectiveSnapRadius],
  );

  // Live cursor tracking for pen-tool overlay (closing-hint + snap target).
  const [snapTarget, setSnapTarget] = useState<Pt | null>(null);
  const handleStageMouseMove = useCallback(() => {
    if (!isPenActive) {
      setSnapTarget(null);
      return;
    }
    const raw = pointerToMockup();
    if (!raw) return;
    const snapped = effectiveSnapRadius > 0 ? findEdgeSnap(edgeMap, raw, effectiveSnapRadius) : null;
    const cursor = snapped ?? raw;
    setSnapTarget(snapped);
    if (penDraft) {
      const canClose =
        penDraft.anchors.length >= MIN_MASK_ANCHORS &&
        distSq(cursor, penDraft.anchors[0]) <= PEN_CLOSE_RADIUS * PEN_CLOSE_RADIUS;
      actions.setPenCursor(cursor, canClose);
    }
  }, [actions, edgeMap, effectiveSnapRadius, isPenActive, penDraft, pointerToMockup]);

  const handleStageMouseLeave = useCallback(() => {
    setSnapTarget(null);
    if (isPenActive && penDraft) actions.setPenCursor(null, false);
  }, [actions, isPenActive, penDraft]);

  // Cursor styling per active tool.
  const stageCursor = isPanning
    ? "grabbing"
    : isPenActive
      ? "crosshair"
      : tool === "move"
        ? "default"
        : "default";

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
        draggable={isPanning}
        onWheel={onWheel}
        onDragEnd={(e) => setPosition({ x: e.target.x(), y: e.target.y() })}
        onMouseDown={handleStageMouseDown}
        onMouseMove={handleStageMouseMove}
        onMouseLeave={handleStageMouseLeave}
        style={{ cursor: stageCursor, background: WORKSPACE_BG }}
      >
        {/* Page background. */}
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

        {mockupImage && mockupWidth > 0 && mockupHeight > 0 && (
          <Layer listening={false}>
            <KonvaImage image={mockupImage} x={0} y={0} width={mockupWidth} height={mockupHeight} />
          </Layer>
        )}

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

        {/* Saved mask layers + anchor handles + pen draft. */}
        <Layer>
          <MaskLayersOverlay
            layers={layers}
            selectedId={selectedLayerId}
            hoverId={hoverLayerId}
            zoom={scale}
            showPanelLabels={debug.showPanelLabels}
            showHoverHighlight={debug.showHoverHighlight}
            interactive={tool === "move"}
            onHover={(id) => actions.setHoverLayer(id)}
            onSelect={(id) => actions.setSelectedLayer(id)}
            onAltClick={(id, mx, my) => {
              const target = layers.find((l) => l.id === id);
              if (!target) return;
              const anchors = svgPathToAnchors(target.maskPath);
              const ne = nearestEdge({ x: mx, y: my }, anchors);
              if (!ne) return;
              if (Math.sqrt(ne.distSq) > EDGE_INSERT_THRESHOLD / scale) return;
              const insertAt = (ne.segmentIndex + 1) % (anchors.length + 1);
              const next = [...anchors];
              next.splice(insertAt, 0, ne.point);
              actions.setSelectedLayer(id);
              actions.setLayerAnchors(id, next);
              actions.setSelectedAnchorIndex(insertAt);
            }}
          />

          {/* Draggable anchor handles for the selected layer (move tool only). */}
          {tool === "move" && selectedLayer && liveAnchors.length >= MIN_MASK_ANCHORS && (
            <AnchorHandlesOverlay
              anchors={liveAnchors}
              zoom={scale}
              selectedIndex={selectedAnchorIndex}
              onSelectAnchor={(idx) => actions.setSelectedAnchorIndex(idx)}
              onDragMove={(idx, p) => {
                const base = dragAnchors ?? selectedAnchors;
                const next = base.map((a, i) => (i === idx ? p : a));
                setDragAnchors(next);
              }}
              onDragEnd={(idx, p) => {
                const base = dragAnchors ?? selectedAnchors;
                const next = base.map((a, i) => (i === idx ? p : a));
                actions.setLayerAnchors(selectedLayer.id, next);
                setDragAnchors(null);
              }}
              onDeleteAnchor={(idx) => {
                if (selectedAnchors.length <= MIN_MASK_ANCHORS) return;
                const next = selectedAnchors.filter((_, i) => i !== idx);
                actions.setLayerAnchors(selectedLayer.id, next);
              }}
            />
          )}

          {/* In-progress pen draft. */}
          {isPenActive && penDraft && (
            <PenToolOverlay
              draft={penDraft}
              zoom={scale}
              snapTarget={snapTarget}
              snapRadius={effectiveSnapRadius}
            />
          )}
        </Layer>
      </Stage>

      {/* HUD: zoom + tool hint + fit button. */}
      <div className="pointer-events-none absolute inset-x-0 top-2 flex items-center justify-between px-3 text-[11px] text-slate-300">
        <div className="pointer-events-auto rounded bg-slate-900/70 px-2 py-1 backdrop-blur">
          {view.toUpperCase()} · {tool} · zoom {Math.round(scale * 100)}%
          {mockup && <span className="ml-2 text-slate-400">{mockup.width}×{mockup.height}</span>}
          {tool === "magnetic-pen" && (
            <span className="ml-2 text-purple-300">snap r={magneticRadius}px {edgeMap ? "" : "(idle)"}</span>
          )}
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

      {isPenActive && (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center text-[11px] text-slate-300">
          <div className="rounded bg-slate-900/70 px-3 py-1 backdrop-blur">
            Click to add points · click first point or press Enter to close · Esc to cancel · Backspace to undo
          </div>
        </div>
      )}
    </div>
  );
}

// Re-export for type discovery.
export { DEFAULT_MAGNETIC_RADIUS, anchorsToSvgPath };
