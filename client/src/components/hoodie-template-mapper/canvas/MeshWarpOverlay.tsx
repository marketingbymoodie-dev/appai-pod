import { useEffect, useMemo, useState } from "react";
import { Circle, Group, Line, Shape } from "react-konva";
import Konva from "konva";
import type { MaskLayer, Pt } from "@shared/hoodieTemplate";
import { svgPathToAnchors } from "../lib/svgPath";
import { drawMeshWarp } from "../lib/meshWarp";

/**
 * Mesh-warp editor overlay.
 *
 * Responsibilities:
 *   1. Render the layer's source artwork warped through `layer.mesh` onto
 *      the mockup, optionally clipped by the panel polygon.
 *   2. Visualise the mesh as a grid of cells.
 *   3. When the mesh-warp tool is active and this layer is selected, draw
 *      draggable control-point handles for every grid vertex.
 *
 * "Show full artwork" toggle (driven by `showFullArtwork`):
 *   - off (default): warp is clipped to the polygon mask — i.e. the mask
 *     hides everything outside the panel.
 *   - on: warp draws unclipped so the user can see what slice of the
 *     artwork falls outside the polygon. Useful when picking the right
 *     region of e.g. a sleeve sheet for the front view vs the back view.
 *
 * Painted in mockup-pixel coordinate space — the parent stage applies
 * the zoom/pan transform.
 */

type Props = {
  layer: MaskLayer;
  zoom: number;
  /** True while the mesh-warp tool is active. Gates control-point drag. */
  active: boolean;
  /** True while space is held — disables drag so panning wins. */
  panLocked: boolean;
  showFullArtwork: boolean;
  onDragControlPoint: (index: number, point: Pt) => void;
};

function isCrossOrigin(src: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const url = new URL(src, window.location.href);
    return url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function useSourceImage(src: string | null | undefined): {
  img: HTMLImageElement | null;
  loading: boolean;
  error: string | null;
} {
  const [state, setState] = useState<{
    img: HTMLImageElement | null;
    loading: boolean;
    error: string | null;
  }>({ img: null, loading: false, error: null });
  useEffect(() => {
    if (!src) {
      setState({ img: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ img: null, loading: true, error: null });
    const img = new Image();
    if (isCrossOrigin(src)) img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!cancelled) setState({ img, loading: false, error: null });
    };
    img.onerror = () => {
      if (!cancelled) setState({ img: null, loading: false, error: `Failed to load ${src}` });
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);
  return state;
}

const HANDLE_RADIUS_PX = 5;
const HANDLE_HIT_RADIUS_PX = 11;
const GRID_LINE_COLOR = "rgba(192, 132, 252, 0.55)";
const GRID_LINE_COLOR_FAINT = "rgba(192, 132, 252, 0.25)";
const HANDLE_COLOR = "#c084fc";
const HANDLE_HOVER_COLOR = "#f0abfc";
const HANDLE_STROKE = "#1e1b4b";

export default function MeshWarpOverlay({
  layer,
  zoom,
  active,
  panLocked,
  showFullArtwork,
  onDragControlPoint,
}: Props) {
  const { img, loading, error } = useSourceImage(layer.productionPanelSrc);
  const mesh = layer.mesh;
  const polygon = useMemo(() => svgPathToAnchors(layer.maskPath), [layer.maskPath]);

  const polyPoints = useMemo(() => {
    const flat: number[] = [];
    for (const p of polygon) flat.push(p.x, p.y);
    return flat;
  }, [polygon]);

  if (!mesh) return null;
  if (mesh.targetPoints.length !== mesh.cols * mesh.rows) return null;

  // Grid line geometry — connect each row and column of control points.
  const horizontalLines: number[][] = [];
  for (let r = 0; r < mesh.rows; r += 1) {
    const row: number[] = [];
    for (let c = 0; c < mesh.cols; c += 1) {
      const p = mesh.targetPoints[r * mesh.cols + c];
      row.push(p.x, p.y);
    }
    horizontalLines.push(row);
  }
  const verticalLines: number[][] = [];
  for (let c = 0; c < mesh.cols; c += 1) {
    const col: number[] = [];
    for (let r = 0; r < mesh.rows; r += 1) {
      const p = mesh.targetPoints[r * mesh.cols + c];
      col.push(p.x, p.y);
    }
    verticalLines.push(col);
  }

  const cellLineWidth = Math.max(0.5, 1 / zoom);
  const handleRadius = HANDLE_RADIUS_PX / zoom;

  // sceneFunc closure must capture mesh + img by value (which it does
  // each render). React re-renders whenever any of these change.
  const drawWarp = (ctx: Konva.Context) => {
    const c2d = (ctx as unknown as { _context?: CanvasRenderingContext2D })._context;
    if (!c2d || !img) return;
    c2d.save();
    if (!showFullArtwork && polygon.length >= 3) {
      c2d.beginPath();
      c2d.moveTo(polygon[0].x, polygon[0].y);
      for (let i = 1; i < polygon.length; i += 1) c2d.lineTo(polygon[i].x, polygon[i].y);
      c2d.closePath();
      c2d.clip();
    }
    try {
      drawMeshWarp(c2d, img, img.naturalWidth, img.naturalHeight, mesh, {
        globalAlpha: showFullArtwork ? 0.7 : layer.opacity,
      });
    } finally {
      c2d.restore();
    }
  };

  return (
    <Group listening={active && !panLocked}>
      {/* Warped artwork — non-interactive, behind the editor handles. */}
      {img && (
        <Shape
          sceneFunc={(ctx) => drawWarp(ctx)}
          listening={false}
          // Konva needs a hit-test path or it will skip drawing if
          // perfectDrawEnabled and the shape is treated as zero-size.
          // sceneFunc draws everything; hit area is irrelevant since
          // listening=false.
          perfectDrawEnabled={false}
        />
      )}

      {/* Polygon outline ghost — keeps the mask boundary visible even
          when "Show full artwork" is on. */}
      {polygon.length >= 3 && (
        <Line
          points={polyPoints}
          closed
          stroke={showFullArtwork ? "rgba(56, 189, 248, 0.9)" : "rgba(56, 189, 248, 0.25)"}
          strokeWidth={Math.max(1, 1.5 / zoom)}
          dash={showFullArtwork ? [6 / zoom, 4 / zoom] : undefined}
          listening={false}
        />
      )}

      {/* Mesh grid lines. */}
      <Group listening={false}>
        {horizontalLines.map((pts, i) => (
          <Line
            key={`h-${i}`}
            points={pts}
            stroke={active ? GRID_LINE_COLOR : GRID_LINE_COLOR_FAINT}
            strokeWidth={cellLineWidth}
          />
        ))}
        {verticalLines.map((pts, i) => (
          <Line
            key={`v-${i}`}
            points={pts}
            stroke={active ? GRID_LINE_COLOR : GRID_LINE_COLOR_FAINT}
            strokeWidth={cellLineWidth}
          />
        ))}
      </Group>

      {/* Draggable control-point handles. Only listen when the mesh-warp
          tool is the active tool and the user isn't panning. */}
      {active && !panLocked && (
        <Group>
          {mesh.targetPoints.map((p, i) => (
            <Circle
              key={i}
              x={p.x}
              y={p.y}
              radius={handleRadius}
              hitStrokeWidth={HANDLE_HIT_RADIUS_PX / zoom}
              fill={HANDLE_COLOR}
              stroke={HANDLE_STROKE}
              strokeWidth={Math.max(0.5, 1 / zoom)}
              draggable
              onMouseEnter={(e) => {
                const stage = e.target.getStage();
                if (stage) stage.container().style.cursor = "grab";
                e.target.fill(HANDLE_HOVER_COLOR);
              }}
              onMouseLeave={(e) => {
                const stage = e.target.getStage();
                if (stage) stage.container().style.cursor = "default";
                e.target.fill(HANDLE_COLOR);
              }}
              onDragMove={(e) => {
                const node = e.target;
                onDragControlPoint(i, { x: node.x(), y: node.y() });
              }}
              onDragEnd={(e) => {
                const node = e.target;
                onDragControlPoint(i, { x: node.x(), y: node.y() });
              }}
            />
          ))}
        </Group>
      )}

      {/* Loading / error state is signalled in the right-sidebar; the
          overlay just shows mesh + polygon when no image yet. */}
      {void loading}
      {void error}
    </Group>
  );
}
