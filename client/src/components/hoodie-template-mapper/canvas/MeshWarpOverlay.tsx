import { useEffect, useMemo, useState } from "react";
import { Circle, Group, Line, Shape, Text } from "react-konva";
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
  /**
   * Update the mesh's source rotation (degrees CW). Called continuously
   * during a drag of the on-canvas rotate handle so the warp updates
   * live.
   */
  onRotate: (rotationDeg: number) => void;
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

/** Offset of the rotate-handle puck above the mesh AABB top, in screen px. */
const ROTATE_HANDLE_SCREEN_OFFSET_PX = 40;
/** Visual radius of the rotate puck in screen px (constant under zoom). */
const ROTATE_HANDLE_RADIUS_PX = 11;
const ROTATE_HANDLE_FILL = "#1e1b4b";
const ROTATE_HANDLE_STROKE = "#c084fc";
const ROTATE_HANDLE_HOVER_STROKE = "#f0abfc";
const ROTATE_HANDLE_LINE_COLOR = "rgba(192, 132, 252, 0.7)";

/**
 * Normalise an angle in degrees to the half-open range [-180, 180), so
 * the displayed value never jumps between e.g. 359 and 0 across the
 * dial origin.
 */
function normaliseAngleDeg(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

export default function MeshWarpOverlay({
  layer,
  zoom,
  active,
  panLocked,
  showFullArtwork,
  onDragControlPoint,
  onRotate,
}: Props) {
  const { img, loading, error } = useSourceImage(layer.productionPanelSrc);
  const mesh = layer.mesh;
  const polygon = useMemo(() => svgPathToAnchors(layer.maskPath), [layer.maskPath]);
  const [rotateHover, setRotateHover] = useState(false);
  const [liveAngleDeg, setLiveAngleDeg] = useState<number | null>(null);

  const polyPoints = useMemo(() => {
    const flat: number[] = [];
    for (const p of polygon) flat.push(p.x, p.y);
    return flat;
  }, [polygon]);

  // Centroid + AABB of the mesh in mockup coords. Computed unconditionally
  // so this hook isn't skipped when mesh is null (rules of hooks).
  const meshAabb = useMemo(() => {
    if (!mesh || mesh.targetPoints.length === 0) {
      return { minX: 0, minY: 0, maxX: 0, maxY: 0, cx: 0, cy: 0 };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let sumX = 0;
    let sumY = 0;
    for (const p of mesh.targetPoints) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      sumX += p.x;
      sumY += p.y;
    }
    const n = mesh.targetPoints.length;
    return {
      minX,
      minY,
      maxX,
      maxY,
      cx: sumX / n,
      cy: sumY / n,
    };
  }, [mesh]);

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

  // Anchor + handle position for the on-canvas rotate puck. The handle
  // rotates around the mesh centroid like a clock hand: at 0° it sits
  // directly above; positive angles swing it CW. The line length in
  // mockup space is computed so the puck stays a fixed screen distance
  // from the mesh's top regardless of zoom.
  const rotateAnchor: Pt = { x: meshAabb.cx, y: meshAabb.cy };
  const handleLengthMockup =
    (meshAabb.cy - meshAabb.minY) + ROTATE_HANDLE_SCREEN_OFFSET_PX / Math.max(0.0001, zoom);
  const currentRotation = mesh.sourceRotation ?? 0;
  const rotationDisplay =
    liveAngleDeg !== null ? liveAngleDeg : normaliseAngleDeg(currentRotation);
  const rotRad = (currentRotation * Math.PI) / 180;
  const rotateHandlePos: Pt = {
    x: rotateAnchor.x + handleLengthMockup * Math.sin(rotRad),
    y: rotateAnchor.y - handleLengthMockup * Math.cos(rotRad),
  };
  const rotateRadiusMockup = ROTATE_HANDLE_RADIUS_PX / Math.max(0.0001, zoom);

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

      {/* Free-form rotation handle. Visible whenever the mesh-warp tool
          is active. Drag the puck around the mesh centroid to rotate
          the source artwork to any angle; hold Shift to snap to 15°.

          The handle sits directly above the centroid at rotation = 0
          and swings CW with the rotation, like a clock hand — so the
          position itself communicates the current angle at a glance. */}
      {active && !panLocked && (
        <Group>
          <Line
            points={[rotateAnchor.x, rotateAnchor.y, rotateHandlePos.x, rotateHandlePos.y]}
            stroke={ROTATE_HANDLE_LINE_COLOR}
            strokeWidth={Math.max(1, 1.2 / zoom)}
            dash={[6 / zoom, 4 / zoom]}
            listening={false}
          />
          <Circle
            x={rotateAnchor.x}
            y={rotateAnchor.y}
            radius={Math.max(2, 3 / zoom)}
            fill={ROTATE_HANDLE_LINE_COLOR}
            listening={false}
          />
          <Circle
            x={rotateHandlePos.x}
            y={rotateHandlePos.y}
            radius={rotateRadiusMockup}
            hitStrokeWidth={(ROTATE_HANDLE_RADIUS_PX + 6) / zoom}
            fill={ROTATE_HANDLE_FILL}
            stroke={rotateHover ? ROTATE_HANDLE_HOVER_STROKE : ROTATE_HANDLE_STROKE}
            strokeWidth={Math.max(1, 1.5 / zoom)}
            draggable
            onMouseEnter={(e) => {
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = "grab";
              setRotateHover(true);
            }}
            onMouseLeave={(e) => {
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = "default";
              setRotateHover(false);
            }}
            onDragStart={(e) => {
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = "grabbing";
            }}
            onDragMove={(e) => {
              const node = e.target;
              // Compute angle from anchor → drag position. Screen y is
              // down, so atan2(dx, -dy) gives a CW-from-up angle in
              // radians — exactly what positive rotationDeg encodes.
              const dx = node.x() - rotateAnchor.x;
              const dy = node.y() - rotateAnchor.y;
              if (dx === 0 && dy === 0) return;
              let angleDeg = Math.atan2(dx, -dy) * (180 / Math.PI);
              const evt = e.evt as MouseEvent | TouchEvent | undefined;
              const shift =
                evt && "shiftKey" in evt
                  ? (evt as MouseEvent).shiftKey
                  : false;
              if (shift) {
                angleDeg = Math.round(angleDeg / 15) * 15;
              }
              setLiveAngleDeg(normaliseAngleDeg(angleDeg));
              onRotate(angleDeg);
            }}
            onDragEnd={(e) => {
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = "default";
              const node = e.target;
              // Reset the node to the canonical handle position so the
              // next drag starts from the geometrically correct spot.
              node.position(rotateHandlePos);
              setLiveAngleDeg(null);
            }}
            onDblClick={() => {
              // Quick reset: double-clicking the rotate puck zeros the
              // rotation. Handy when a sleeve drift gets out of hand.
              onRotate(0);
              setLiveAngleDeg(null);
            }}
          />
          {/* Angle readout — shown while hovering or dragging the
              rotate puck so the user can dial in a precise value. */}
          {(rotateHover || liveAngleDeg !== null) && (
            <Text
              x={rotateHandlePos.x + (12 / zoom)}
              y={rotateHandlePos.y - (8 / zoom)}
              text={`${rotationDisplay.toFixed(rotateHover && liveAngleDeg === null ? 0 : 1)}°`}
              fontSize={12 / zoom}
              fill="#f0abfc"
              fontStyle="bold"
              listening={false}
            />
          )}
        </Group>
      )}

      {/* Loading / error state is signalled in the right-sidebar; the
          overlay just shows mesh + polygon when no image yet. */}
      {void loading}
      {void error}
    </Group>
  );
}
