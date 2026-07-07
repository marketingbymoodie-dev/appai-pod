import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Layer, Line, Rect, Stage } from "react-konva";
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
  findNearestEdgeOnSubpaths,
  svgPathToSubpaths,
  anchorsToSvgPath,
} from "../lib/svgPath";
import MaskLayersOverlay from "./MaskLayersOverlay";
import MeshWarpOverlay from "./MeshWarpOverlay";
import MeshWarpRender from "./MeshWarpRender";
import PenToolOverlay from "./PenToolOverlay";
import AnchorHandlesOverlay from "./AnchorHandlesOverlay";
import ReferenceOverlayLayer from "./ReferenceOverlayLayer";
import MockupBaseLayer from "./MockupBaseLayer";
import MockupCropOverlay from "./MockupCropOverlay";
import { loadMapperAssetImage } from "../lib/mapperAssetImage";
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
  /**
   * Optional explicit canvas size in pixels. If omitted, HoodieCanvas
   * self-measures via its own wrapper ref. Self-measurement is the
   * recommended path because it survives StrictMode / ResizeObserver
   * timing races that have intermittently zeroed-out parent-supplied
   * sizes in dev.
   */
  width?: number;
  height?: number;
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

type ImageLoadResult = { img: HTMLImageElement | null; error: string | null };

function loadHtmlImage(src: string | null | undefined): Promise<ImageLoadResult> {
  if (!src) return Promise.resolve({ img: null, error: null });
  return loadMapperAssetImage(src)
    .then((img) => ({ img, error: null as string | null }))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn("[hoodie-mapper] image load failed", src, message);
      return { img: null, error: message || `Failed to load mockup at ${src}` };
    });
}

type LoadedImageState = {
  img: HTMLImageElement | null;
  loading: boolean;
  error: string | null;
};

function useLoadedImage(src: string | null | undefined): LoadedImageState {
  const [state, setState] = useState<LoadedImageState>({ img: null, loading: false, error: null });
  useEffect(() => {
    if (!src) {
      setState({ img: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ img: null, loading: true, error: null });
    loadHtmlImage(src).then((res) => {
      if (cancelled) return;
      setState({ img: res.img, loading: false, error: res.error });
    });
    return () => {
      cancelled = true;
    };
  }, [src]);
  return state;
}

export default function HoodieCanvas({ width: widthProp, height: heightProp }: Props) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  // Self-measured wrapper size. Used when the caller doesn't pass an
  // explicit width/height (the recommended path). We measure with
  // useLayoutEffect + ResizeObserver + window resize + a short rAF chain
  // to handle StrictMode mount/cleanup/mount races and post-paint layout
  // shifts.
  const [measuredSize, setMeasuredSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (widthProp !== undefined && heightProp !== undefined) return;
    function measure() {
      const node = wrapperRef.current;
      if (!node) return;
      const r = node.getBoundingClientRect();
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      setMeasuredSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    }
    measure();
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    window.addEventListener("resize", measure);
    const rafIds: number[] = [];
    let remaining = 8;
    const tick = () => {
      remaining -= 1;
      measure();
      if (remaining > 0) rafIds.push(window.requestAnimationFrame(tick));
    };
    rafIds.push(window.requestAnimationFrame(tick));
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      for (const id of rafIds) window.cancelAnimationFrame(id);
    };
  }, [widthProp, heightProp]);

  const width = widthProp ?? measuredSize.width;
  const height = heightProp ?? measuredSize.height;

  // Store wiring.
  const view = useHoodieMapperStore((s) => s.view);
  const tool = useHoodieMapperStore((s) => s.tool);
  const debug = useHoodieMapperStore((s) => s.debug);
  const layers = useHoodieMapperStore((s) => s.template.views[s.view].layers);
  const selectedLayerId = useHoodieMapperStore((s) => s.selectedLayerId);
  const hoverLayerId = useHoodieMapperStore((s) => s.hoverLayerId);
  const penDraft = useHoodieMapperStore((s) => s.penDraft);
  const magneticRadius = useHoodieMapperStore((s) => s.magneticRadius);
  const magneticTolerance = useHoodieMapperStore((s) => s.magneticTolerance);
  const selectedAnchorIndex = useHoodieMapperStore((s) => s.selectedAnchorIndex);
  const selectedAnchorSubpathIndex = useHoodieMapperStore((s) => s.selectedAnchorSubpathIndex);
  const mockup = useHoodieMapperStore((s) => s.template.views[s.view].mockup);
  const referenceOverlay = useHoodieMapperStore((s) => s.template.views[s.view].referenceOverlay);
  const meshEdit = useHoodieMapperStore((s) => s.meshEdit);
  const mockupCrop = useHoodieMapperStore((s) => s.mockupCrop);
  const actions = useHoodieMapperStore((s) => s.actions);

  const mockupImageState = useLoadedImage(mockup?.src);
  const overlayImageState = useLoadedImage(referenceOverlay?.src);
  const mockupImage = mockupImageState.img;
  const overlayImage = overlayImageState.img;

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
  const selectedSubpaths = useMemo(
    () => (selectedLayer ? svgPathToSubpaths(selectedLayer.maskPath) : []),
    [selectedLayer],
  );
  // While dragging an anchor we don't push every move into the global store
  // (which would re-serialize the path on every frame). Local state buffers
  // the in-flight drag and we commit once on drag end.
  const [dragSubpaths, setDragSubpaths] = useState<Pt[][] | null>(null);

  // Polygon-translate drag state — grab the panel body in Move tool and
  // drag mask + mesh together. `start` is captured on mousedown and
  // `last` is updated on every stage mousemove; on mouseup we commit
  // a single translateLayerMesh() with the cumulative delta.
  const [polyDrag, setPolyDrag] = useState<
    { id: string; start: Pt; last: Pt; baseSubpaths: Pt[][] } | null
  >(null);
  const polyDragOffset = polyDrag
    ? { dx: polyDrag.last.x - polyDrag.start.x, dy: polyDrag.last.y - polyDrag.start.y }
    : null;

  const liveSubpaths: Pt[][] = dragSubpaths
    ? dragSubpaths
    : polyDrag && polyDragOffset
      ? polyDrag.baseSubpaths.map((ring) =>
          ring.map((a) => ({
            x: a.x + polyDragOffset.dx,
            y: a.y + polyDragOffset.dy,
          })),
        )
      : selectedSubpaths;

  // Tracks the last anchor we dropped while in magnetic-pen click-and-drag
  // mode, plus whether the LMB is currently held. Lets mousemove drop new
  // anchors at distance intervals so the user can sweep along an edge
  // freehand instead of clicking every point.
  const dragDropRef = useRef<{ active: boolean; lastDrop: Pt | null }>({
    active: false,
    lastDrop: null,
  });
  // Distance threshold (mockup px) between drag-drops. Scales with the
  // magnetic snap radius so users with a wider snap don't get noisy drops.
  const dragDropThreshold = Math.max(6, Math.round(magneticRadius * 0.7));

  // Stage handlers — pen click + canvas-clear-selection + edge insert.
  const handleStageMouseDown = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      // Skip if clicking through to a child (mask, anchor handle, etc.) that
      // already handled the event.
      if (e.target !== e.target.getStage()) return;
      const evt = e.evt;
      if (evt.button !== 0) return;
      // Spacebar pan owns the click — Konva still fires mousedown on the
      // Stage even when draggable=true, so without this gate the click that
      // initiates a pan also drops an anchor. Spacebar drags should be
      // pan-only.
      if (isPanning || evt.shiftKey) return;
      if (mockupCrop.active) return;
      const mockupPt = pointerToMockup();
      if (!mockupPt) return;

      // Pen tool clicks: append/close.
      if (isPenActive) {
        const draft = penDraft;
        if (!draft || draft.anchors.length === 0) {
          actions.startPenDraft();
          const first = snapPoint(mockupPt);
          actions.appendPenAnchor(first);
          if (tool === "magnetic-pen") {
            dragDropRef.current = { active: true, lastDrop: first };
          }
          return;
        }
        // Close on click near anchor[0] when ≥ MIN_MASK_ANCHORS.
        if (
          draft.anchors.length >= MIN_MASK_ANCHORS &&
          distSq(mockupPt, draft.anchors[0]) <= PEN_CLOSE_RADIUS * PEN_CLOSE_RADIUS
        ) {
          actions.closePenDraft();
          dragDropRef.current = { active: false, lastDrop: null };
          return;
        }
        const dropped = snapPoint(mockupPt);
        actions.appendPenAnchor(dropped);
        if (tool === "magnetic-pen") {
          dragDropRef.current = { active: true, lastDrop: dropped };
        }
        return;
      }

      // Move tool: alt-click on a layer's edge to insert an anchor.
      if (tool === "move" && evt.altKey && selectedLayer) {
        const subpaths = svgPathToSubpaths(selectedLayer.maskPath);
        const ne = findNearestEdgeOnSubpaths(mockupPt, subpaths);
        if (ne && Math.sqrt(ne.distSq) <= EDGE_INSERT_THRESHOLD / scale) {
          const ring = subpaths[ne.subpathIndex] ?? [];
          const insertAt = (ne.segmentIndex + 1) % (ring.length + 1);
          const nextRing = [...ring];
          nextRing.splice(insertAt, 0, ne.point);
          const next = subpaths.map((r, i) => (i === ne.subpathIndex ? nextRing : r));
          actions.setLayerSubpaths(selectedLayer.id, next);
          actions.setSelectedAnchorIndex(insertAt, ne.subpathIndex);
          return;
        }
      }

      // Background click clears selection (in move tool only).
      if (tool === "move") {
        actions.setSelectedLayer(null);
      }
    },
    [actions, isPenActive, isPanning, mockupCrop.active, penDraft, pointerToMockup, scale, selectedLayer, tool],
  );

  // Snap a raw mockup point to the nearest strong edge when the magnetic pen
  // is active. Falls through unchanged otherwise.
  const snapPoint = useCallback(
    (raw: Pt): Pt => {
      if (effectiveSnapRadius <= 0) return raw;
      const snapped = findEdgeSnap(edgeMap, raw, effectiveSnapRadius, magneticTolerance);
      return snapped ?? raw;
    },
    [edgeMap, effectiveSnapRadius, magneticTolerance],
  );

  // Live cursor tracking for pen-tool overlay (closing-hint + snap target).
  const [snapTarget, setSnapTarget] = useState<Pt | null>(null);
  const handleStageMouseMove = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      // Polygon-translate drag: follow the pointer and let liveAnchors
      // re-derive from the new offset. We commit the actual store
      // mutation on mouseup so a single Cmd-Z undo reverts the whole
      // gesture rather than the per-frame deltas.
      const lmbHeld = (e.evt.buttons & 1) === 1;
      if (polyDrag) {
        if (!lmbHeld) {
          // The browser sometimes swallows mouseup (e.g. release outside
          // the stage). If the button has been released by the time we
          // see another move, finalize the drag here.
          const dx = polyDrag.last.x - polyDrag.start.x;
          const dy = polyDrag.last.y - polyDrag.start.y;
          if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
            actions.translateLayerPolygon(polyDrag.id, dx, dy);
          }
          setPolyDrag(null);
        } else {
          const mp = pointerToMockup();
          if (mp) {
            setPolyDrag((cur) => (cur ? { ...cur, last: mp } : cur));
          }
          return;
        }
      }
      if (!isPenActive) {
        setSnapTarget(null);
        return;
      }
      const raw = pointerToMockup();
      if (!raw) return;
      const snapped =
        effectiveSnapRadius > 0
          ? findEdgeSnap(edgeMap, raw, effectiveSnapRadius, magneticTolerance)
          : null;
      const cursor = snapped ?? raw;
      setSnapTarget(snapped);

      // Magnetic pen click-and-drag: while LMB is held, drop additional
      // anchors at fixed mockup-pixel intervals so the user can sweep along
      // an edge freehand. If the LMB has been released by the time we get
      // here (no `1` bit in `evt.buttons`), exit drag mode so the *next*
      // mousedown starts a fresh drop sequence.
      if (!lmbHeld) {
        dragDropRef.current.active = false;
      }
      if (
        tool === "magnetic-pen" &&
        lmbHeld &&
        dragDropRef.current.active &&
        penDraft &&
        penDraft.anchors.length > 0
      ) {
        const last = dragDropRef.current.lastDrop ?? penDraft.anchors[penDraft.anchors.length - 1];
        if (distSq(cursor, last) >= dragDropThreshold * dragDropThreshold) {
          actions.appendPenAnchor(cursor);
          dragDropRef.current.lastDrop = cursor;
        }
      }

      if (penDraft) {
        const canClose =
          penDraft.anchors.length >= MIN_MASK_ANCHORS &&
          distSq(cursor, penDraft.anchors[0]) <= PEN_CLOSE_RADIUS * PEN_CLOSE_RADIUS;
        actions.setPenCursor(cursor, canClose);
      }
    },
    [
      actions,
      dragDropThreshold,
      edgeMap,
      effectiveSnapRadius,
      isPenActive,
      magneticTolerance,
      penDraft,
      pointerToMockup,
      polyDrag,
      tool,
    ],
  );

  const handleStageMouseUp = useCallback(() => {
    dragDropRef.current.active = false;
    if (polyDrag) {
      const dx = polyDrag.last.x - polyDrag.start.x;
      const dy = polyDrag.last.y - polyDrag.start.y;
      if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
        actions.translateLayerPolygon(polyDrag.id, dx, dy);
      }
      setPolyDrag(null);
    }
  }, [actions, polyDrag]);

  const handleStageMouseLeave = useCallback(() => {
    setSnapTarget(null);
    dragDropRef.current.active = false;
    // If the pointer leaves the stage mid-polygon-drag we still want to
    // commit the move so far — releasing the mouse outside the stage
    // would otherwise strand the polygon at the last frame and leak
    // override state.
    if (polyDrag) {
      const dx = polyDrag.last.x - polyDrag.start.x;
      const dy = polyDrag.last.y - polyDrag.start.y;
      if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
        actions.translateLayerPolygon(polyDrag.id, dx, dy);
      }
      setPolyDrag(null);
    }
    if (isPenActive && penDraft) actions.setPenCursor(null, false);
  }, [actions, isPenActive, penDraft, polyDrag]);

  // Track whether the stage is currently mid-drag (left mouse held while
  // spacebar pan is active). Lets us flip the cursor between an open hand
  // ("grab", spacebar held but nothing dragged yet) and a closed hand
  // ("grabbing", actively panning).
  const [isPanDragging, setIsPanDragging] = useState(false);

  // Cursor styling per active tool. While spacebar is held we want the hand
  // cursor regardless of whether the pointer is over a mask, an anchor, or
  // empty mockup — the layer below has listening disabled in that mode so
  // none of the child elements can override us.
  const stageCursor = isPanning
    ? isPanDragging
      ? "grabbing"
      : "grab"
    : polyDrag
      ? "move"
      : isPenActive
        ? "crosshair"
        : tool === "mesh-warp"
          ? "default"
          : tool === "move"
            ? "default"
            : "default";

  return (
    <div ref={wrapperRef} className="relative h-full w-full" data-testid="hoodie-canvas-root">
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
        onDragStart={(e) => {
          if (e.target === e.target.getStage()) setIsPanDragging(true);
        }}
        onDragEnd={(e) => {
          // Konva drag events bubble — only treat the stage's own drag end as
          // a pan commit. Anchor-handle drags would otherwise yank the
          // viewport to the anchor's mockup-pixel coords.
          if (e.target === e.target.getStage()) {
            setPosition({ x: e.target.x(), y: e.target.y() });
            setIsPanDragging(false);
          }
        }}
        onMouseDown={handleStageMouseDown}
        onMouseMove={handleStageMouseMove}
        onMouseUp={handleStageMouseUp}
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
          <ReferenceOverlayLayer
            overlay={referenceOverlay}
            image={overlayImage}
            panLocked={isPanning}
            onChange={(patch) =>
              actions.setReferenceOverlay(view, { ...referenceOverlay, ...patch })
            }
          />
        )}

        {mockupImage && mockupWidth > 0 && mockupHeight > 0 && mockup && (
          <MockupBaseLayer
            mockup={mockup}
            image={mockupImage}
            panLocked={isPanning || mockupCrop.active}
            onChange={(patch) => actions.patchMockup(view, patch)}
          />
        )}

        {mockupCrop.active && mockupCrop.rect && mockupWidth > 0 && mockupHeight > 0 && (
          <MockupCropOverlay
            mockupWidth={mockupWidth}
            mockupHeight={mockupHeight}
            rect={mockupCrop.rect}
            zoom={scale}
            onChange={(rect) => actions.setMockupCropRect(rect)}
          />
        )}

        {/* Saved mask layers + anchor handles + pen draft.
            While the user holds Space (pan mode) we disable listening on
            this entire layer so masks/anchors don't intercept the click —
            the click instead initiates the Stage's drag-pan, even when the
            cursor is on top of a mask region. */}
        <Layer listening={!isPanning}>
          {/* All-mesh composite — paints every other warped layer so the
              user can review the panel set as one image. Render-only,
              no event listeners; the selected layer's full editor is
              drawn next on top so handles stay reachable. Off when the
              workspace flag `showAllWarps` is unchecked. */}
          {debug.showAllWarps &&
            layers
              .filter(
                (l) =>
                  l.id !== selectedLayerId &&
                  l.visible !== false &&
                  l.mesh &&
                  l.productionPanelSrc,
              )
              .map((l) => <MeshWarpRender key={`warp-${l.id}`} layer={l} />)}

          {/* Mesh-warp preview + handles for the selected layer. Drawn
              after the other warps so its handles sit on top, but
              before MaskLayersOverlay so the saved outlines remain
              visible. */}
          {selectedLayer && selectedLayer.mesh && (
            <MeshWarpOverlay
              layer={selectedLayer}
              zoom={scale}
              active={tool === "mesh-warp"}
              panLocked={isPanning}
              showFullArtwork={meshEdit.showFullArtwork}
              onDragControlPoint={(idx, p) =>
                actions.setLayerMeshTargetPoint(selectedLayer.id, idx, p)
              }
              onRotateMesh={(deltaDeg, anchor) =>
                actions.rotateLayerMesh(selectedLayer.id, deltaDeg, anchor)
              }
              onTranslateMesh={(dx, dy) =>
                actions.translateLayerMesh(selectedLayer.id, dx, dy)
              }
              onScaleMesh={(factor, anchor) =>
                actions.scaleLayerMesh(selectedLayer.id, factor, anchor)
              }
            />
          )}

          <MaskLayersOverlay
            layers={layers}
            selectedId={selectedLayerId}
            hoverId={hoverLayerId}
            zoom={scale}
            showPanelLabels={debug.showPanelLabels}
            showHoverHighlight={debug.showHoverHighlight}
            interactive={tool === "move"}
            // While the user is dragging an anchor we keep the live geometry
            // in `dragSubpaths` (avoids per-frame store writes); pass it
            // through here so the polygon outline tracks the dot in real
            // time rather than snapping at drop.
            dragOverride={
              dragSubpaths && selectedLayer
                ? { id: selectedLayer.id, subpaths: dragSubpaths }
                : polyDrag && selectedLayer && polyDragOffset
                  ? {
                      id: selectedLayer.id,
                      subpaths: polyDrag.baseSubpaths.map((ring) =>
                        ring.map((a) => ({
                          x: a.x + polyDragOffset.dx,
                          y: a.y + polyDragOffset.dy,
                        })),
                      ),
                    }
                  : null
            }
            onHover={(id) => actions.setHoverLayer(id)}
            onSelect={(id) => actions.setSelectedLayer(id)}
            onPolygonDragStart={(id, mx, my) => {
              const target = layers.find((l) => l.id === id);
              if (!target) return;
              setPolyDrag({
                id,
                start: { x: mx, y: my },
                last: { x: mx, y: my },
                baseSubpaths: svgPathToSubpaths(target.maskPath),
              });
            }}
            onAltClick={(id, mx, my) => {
              const target = layers.find((l) => l.id === id);
              if (!target) return;
              const subpaths = svgPathToSubpaths(target.maskPath);
              const ne = findNearestEdgeOnSubpaths({ x: mx, y: my }, subpaths);
              if (!ne) return;
              if (Math.sqrt(ne.distSq) > EDGE_INSERT_THRESHOLD / scale) return;
              const ring = subpaths[ne.subpathIndex] ?? [];
              const insertAt = (ne.segmentIndex + 1) % (ring.length + 1);
              const nextRing = [...ring];
              nextRing.splice(insertAt, 0, ne.point);
              const next = subpaths.map((r, i) => (i === ne.subpathIndex ? nextRing : r));
              actions.setSelectedLayer(id);
              actions.setLayerSubpaths(id, next);
              actions.setSelectedAnchorIndex(insertAt, ne.subpathIndex);
            }}
          />

          {/* Draggable anchor handles for the selected layer (move tool only).
              Suppressed when the user has toggled off polygon-anchor display
              (e.g. while focusing on mesh-warp artwork placement). */}
          {tool === "move" &&
            debug.showAnchors &&
            selectedLayer &&
            liveSubpaths.some((ring) => ring.length >= MIN_MASK_ANCHORS) && (
            <AnchorHandlesOverlay
              subpaths={liveSubpaths}
              zoom={scale}
              selectedSubpath={selectedAnchorSubpathIndex}
              selectedIndex={selectedAnchorIndex}
              onSelectAnchor={(subpathIndex, anchorIndex) =>
                actions.setSelectedAnchorIndex(anchorIndex, subpathIndex)
              }
              onDragMove={(subpathIndex, anchorIndex, p) => {
                const base = dragSubpaths ?? selectedSubpaths.map((ring) => ring.map((a) => ({ ...a })));
                const next = base.map((ring, si) =>
                  si === subpathIndex
                    ? ring.map((a, i) => (i === anchorIndex ? p : a))
                    : ring,
                );
                setDragSubpaths(next);
              }}
              onDragEnd={(subpathIndex, anchorIndex, p) => {
                const base = dragSubpaths ?? selectedSubpaths.map((ring) => ring.map((a) => ({ ...a })));
                const next = base.map((ring, si) =>
                  si === subpathIndex
                    ? ring.map((a, i) => (i === anchorIndex ? p : a))
                    : ring,
                );
                actions.setLayerSubpaths(selectedLayer.id, next);
                setDragSubpaths(null);
              }}
              onDeleteAnchor={(subpathIndex, anchorIndex) => {
                const ring = selectedSubpaths[subpathIndex];
                if (!ring || ring.length <= MIN_MASK_ANCHORS) return;
                const next = selectedSubpaths.map((r, si) =>
                  si === subpathIndex ? r.filter((_, i) => i !== anchorIndex) : r,
                );
                actions.setLayerSubpaths(selectedLayer.id, next);
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

        {/* Topmost reference overlay — sits ABOVE mesh-warp + masks so the
            user can crossfade their mesh output against a Printify-rendered
            comparison image via the opacity slider. Below-placement is
            handled earlier in the stack (under the mockup). When unlocked,
            the layer exposes drag + corner-resize handles. */}
        {referenceOverlay && referenceOverlay.placement === "above" && overlayImage && (
          <ReferenceOverlayLayer
            overlay={referenceOverlay}
            image={overlayImage}
            panLocked={isPanning}
            onChange={(patch) =>
              actions.setReferenceOverlay(view, { ...referenceOverlay, ...patch })
            }
          />
        )}
      </Stage>

      {/* HUD: zoom + tool hint + fit button. */}
      <div className="pointer-events-none absolute inset-x-0 top-2 flex items-center justify-between px-3 text-[11px] text-slate-300">
        <div className="pointer-events-auto rounded bg-slate-900/70 px-2 py-1 backdrop-blur">
          {view.toUpperCase()} · {tool} · zoom {Math.round(scale * 100)}%
          {mockup && <span className="ml-2 text-slate-400">{mockup.width}×{mockup.height}</span>}
          {tool === "magnetic-pen" && (
            <span className="ml-2 text-purple-300">
              snap r={magneticRadius}px · tol={magneticTolerance.toFixed(2)}{" "}
              {edgeMap ? "" : "(idle)"}
            </span>
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

      {/* Diagnostic strip — surfaces every piece of state involved in
          image rendering so a silent-black canvas is debuggable. Gated
          on debug.showCanvasDebug (toggle in the RightSidebar) since
          most users don't need it. */}
      {debug.showCanvasDebug && (
        <div className="pointer-events-none absolute inset-x-0 bottom-9 flex justify-center">
          <div className="pointer-events-auto rounded bg-slate-900/80 px-2 py-1 text-[10px] text-slate-300 backdrop-blur">
            stage {Math.round(width)}×{Math.round(height)} · mockup{" "}
            {mockup ? `${mockup.width}×${mockup.height}` : "—"} · img{" "}
            {mockupImageState.loading
              ? "loading"
              : mockupImageState.error
                ? "ERROR"
                : mockupImage
                  ? "loaded"
                  : "—"}{" "}
            · scale {scale.toFixed(2)} · pos ({Math.round(position.x)},{Math.round(position.y)})
          </div>
        </div>
      )}

      {mockupCrop.active && mockupCrop.rect && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded border border-sky-500/40 bg-sky-500/15 px-4 py-2 text-center text-xs text-sky-100">
          <div className="font-medium">Crop mockup — drag the box, then Apply crop in the right sidebar</div>
          <div className="mt-0.5 text-[11px] text-sky-200/80">
            {Math.round(mockupCrop.rect.width)}×{Math.round(mockupCrop.rect.height)} px region selected
          </div>
        </div>
      )}

      {!mockup && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-sm text-slate-400">
          <div className="rounded border border-dashed border-slate-700 px-6 py-4">
            <div className="font-semibold text-slate-200">No {view} mockup loaded yet.</div>
            <div className="mt-1 text-xs">Use the toolbar above to upload a {view} hoodie mockup.</div>
            <div className="mt-1 text-[11px] text-slate-500">Hold space to pan · scroll to zoom.</div>
          </div>
        </div>
      )}

      {mockup && mockupImageState.loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-xs text-slate-400">
          <div className="rounded border border-dashed border-slate-700 bg-slate-900/70 px-4 py-2 backdrop-blur">
            Loading {view} mockup…
          </div>
        </div>
      )}

      {mockup && !mockupImageState.loading && mockupImageState.error && (
        <div className="absolute inset-0 flex items-center justify-center text-center text-xs">
          <div className="max-w-md rounded border border-red-500/40 bg-red-500/10 px-4 py-3 text-red-200">
            <div className="font-semibold text-red-100">Failed to load {view} mockup</div>
            <div className="mt-1 break-all text-[11px] text-red-200/80">{mockup.src}</div>
            <div className="mt-1 text-[11px] text-red-200/60">
              Open DevTools → Network to see the failing request. Common causes: 404 (file
              missing), CORS, or the dev server is restarting.
            </div>
          </div>
        </div>
      )}

      {isPenActive && (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center text-[11px] text-slate-300">
          <div className="rounded bg-slate-900/70 px-3 py-1 backdrop-blur">
            {tool === "magnetic-pen"
              ? "Click to add points · hold LMB and drag along an edge to auto-drop · click first point or Enter to close · Esc cancels · Backspace undoes"
              : "Click to add points · click first point or press Enter to close · Esc to cancel · Backspace to undo"}
          </div>
        </div>
      )}
    </div>
  );
}

// Re-export for type discovery.
export { DEFAULT_MAGNETIC_RADIUS, anchorsToSvgPath };
