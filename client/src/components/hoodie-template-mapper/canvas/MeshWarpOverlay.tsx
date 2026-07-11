import { useEffect, useMemo, useRef, useState } from "react";
import { Circle, Group, Line, Shape, Text } from "react-konva";
import Konva from "konva";
import type { MaskLayer, Pt } from "@shared/hoodieTemplate";
import { svgPathToSubpaths, clipCanvasToMaskSubpaths, flattenSubpathPoints } from "../lib/svgPath";
import { drawMeshWarp } from "../lib/meshWarp";
import { useMapperAssetImage } from "../lib/useMapperAssetImage";

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
   * Rigid-body rotate the mesh by `deltaDeg` (CW positive) around
   * `anchor`. Called continuously during a rotate-puck drag so the
   * mesh + warp update live.
   */
  onRotateMesh: (deltaDeg: number, anchor: Pt) => void;
  /**
   * Rigid-body translate every mesh target point by (dx, dy) mockup
   * pixels. Bound to the centroid drag handle.
   */
  onTranslateMesh: (dx: number, dy: number) => void;
  /**
   * Uniformly scale every mesh target point by `factor` around `anchor`.
   * Called incrementally during a corner-puck drag so the warp grows
   * / shrinks live.
   */
  onScaleMesh: (factor: number, anchor: Pt) => void;
};

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
/** Visual radius of the centroid "move" puck in screen px. */
const MOVE_HANDLE_RADIUS_PX = 9;
const MOVE_HANDLE_FILL = "#1e1b4b";
const MOVE_HANDLE_STROKE = "#fde047";
const MOVE_HANDLE_HOVER_STROKE = "#facc15";
/** Visual radius of the AABB corner "resize" puck in screen px. */
const SCALE_HANDLE_RADIUS_PX = 9;
const SCALE_HANDLE_FILL = "#1e1b4b";
const SCALE_HANDLE_STROKE = "#34d399";
const SCALE_HANDLE_HOVER_STROKE = "#6ee7b7";

export default function MeshWarpOverlay({
  layer,
  zoom,
  active,
  panLocked,
  showFullArtwork,
  onDragControlPoint,
  onRotateMesh,
  onTranslateMesh,
  onScaleMesh,
}: Props) {
  const { img, loading, error } = useMapperAssetImage(layer.productionPanelSrc);
  const mesh = layer.mesh;
  const subpaths = useMemo(() => svgPathToSubpaths(layer.maskPath), [layer.maskPath]);
  const [rotateHover, setRotateHover] = useState(false);
  const [moveHover, setMoveHover] = useState(false);
  const [scaleHover, setScaleHover] = useState(false);
  /** Cumulative angle (deg) accumulated during a single rotate drag. */
  const [liveAngleDeg, setLiveAngleDeg] = useState<number | null>(null);
  /** Cumulative scale factor accumulated during a single resize drag. */
  const [liveScale, setLiveScale] = useState<number | null>(null);
  /** Last screen-space angle of the rotate puck during a drag — used to
   * compute incremental rotation deltas. */
  const lastRotateAngleRef = useRef<number | null>(null);
  /** Last position of the centroid puck during a translate drag. */
  const lastTranslatePosRef = useRef<Pt | null>(null);
  /** Last distance (mockup px) from anchor → scale puck during a resize
   * drag. Used to derive an incremental scale factor each frame. */
  const lastScaleDistanceRef = useRef<number | null>(null);

  const polyRings = useMemo(
    () => subpaths.filter((ring) => ring.length >= 3).map((ring) => flattenSubpathPoints(ring)),
    [subpaths],
  );

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
  // Anchor for rigid mesh rotation = the mesh centroid. The rotate puck
  // sits a constant screen distance directly above. Because rotation is
  // baked into the target points (the artwork rotates *with* the mesh),
  // the puck doesn't track an angle visually — it's just the grab point
  // for the rotate gesture, and the centroid dot is the grab point for
  // the translate gesture.
  const rotateAnchor: Pt = { x: meshAabb.cx, y: meshAabb.cy };
  const handleLengthMockup =
    (meshAabb.cy - meshAabb.minY) + ROTATE_HANDLE_SCREEN_OFFSET_PX / Math.max(0.0001, zoom);
  const rotateHandlePos: Pt = {
    x: rotateAnchor.x,
    y: rotateAnchor.y - handleLengthMockup,
  };
  const rotateRadiusMockup = ROTATE_HANDLE_RADIUS_PX / Math.max(0.0001, zoom);
  const moveRadiusMockup = MOVE_HANDLE_RADIUS_PX / Math.max(0.0001, zoom);
  const scaleRadiusMockup = SCALE_HANDLE_RADIUS_PX / Math.max(0.0001, zoom);
  const rotationDisplay = liveAngleDeg ?? 0;
  // Resize puck sits at the bottom-right of the mesh AABB, slightly
  // offset outward so it doesn't overlap with the corner control point.
  // The diagonal direction is intuitive (drag away = bigger).
  const scaleHandlePos: Pt = {
    x: meshAabb.maxX + 12 / Math.max(0.0001, zoom),
    y: meshAabb.maxY + 12 / Math.max(0.0001, zoom),
  };
  const scaleHandleInitDistance = Math.hypot(
    scaleHandlePos.x - rotateAnchor.x,
    scaleHandlePos.y - rotateAnchor.y,
  );

  // sceneFunc closure must capture mesh + img by value (which it does
  // each render). React re-renders whenever any of these change.
  const drawWarp = (ctx: Konva.Context) => {
    const c2d = (ctx as unknown as { _context?: CanvasRenderingContext2D })._context;
    if (!c2d || !img) return;
    c2d.save();
    if (!showFullArtwork) {
      clipCanvasToMaskSubpaths(c2d, subpaths);
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
      {polyRings.map((points, idx) => (
        <Line
          key={`mesh-poly-${idx}`}
          points={points}
          closed
          stroke={showFullArtwork ? "rgba(56, 189, 248, 0.9)" : "rgba(56, 189, 248, 0.25)"}
          strokeWidth={Math.max(1, 1.5 / zoom)}
          dash={showFullArtwork ? [6 / zoom, 4 / zoom] : undefined}
          listening={false}
        />
      ))}

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

      {/* Rigid-body transform handles. Visible whenever the mesh-warp
          tool is active.

          * Purple puck (above): drag to rotate the entire mesh + warped
            artwork around the centroid. Shift = snap delta to 15°.
          * Yellow puck (centroid): drag to translate the mesh on the
            mockup so the panel lands exactly where Printify will print.

          Per-vertex deformation work is preserved by both gestures —
          they just rotate / translate every target point as a unit. */}
      {active && !panLocked && (
        <Group>
          <Line
            points={[rotateAnchor.x, rotateAnchor.y, rotateHandlePos.x, rotateHandlePos.y]}
            stroke={ROTATE_HANDLE_LINE_COLOR}
            strokeWidth={Math.max(1, 1.2 / zoom)}
            dash={[6 / zoom, 4 / zoom]}
            listening={false}
          />

          {/* Centroid → drag-to-translate the whole mesh. */}
          <Circle
            x={rotateAnchor.x}
            y={rotateAnchor.y}
            radius={moveRadiusMockup}
            hitStrokeWidth={(MOVE_HANDLE_RADIUS_PX + 6) / zoom}
            fill={MOVE_HANDLE_FILL}
            stroke={moveHover ? MOVE_HANDLE_HOVER_STROKE : MOVE_HANDLE_STROKE}
            strokeWidth={Math.max(1, 1.5 / zoom)}
            draggable
            onMouseEnter={(e) => {
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = "move";
              setMoveHover(true);
            }}
            onMouseLeave={(e) => {
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = "default";
              setMoveHover(false);
            }}
            onDragStart={(e) => {
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = "grabbing";
              const node = e.target;
              lastTranslatePosRef.current = { x: node.x(), y: node.y() };
            }}
            onDragMove={(e) => {
              const node = e.target;
              const cur = { x: node.x(), y: node.y() };
              const last = lastTranslatePosRef.current ?? cur;
              const dx = cur.x - last.x;
              const dy = cur.y - last.y;
              if (dx !== 0 || dy !== 0) {
                onTranslateMesh(dx, dy);
                lastTranslatePosRef.current = cur;
              }
            }}
            onDragEnd={(e) => {
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = "default";
              lastTranslatePosRef.current = null;
              // Re-render snaps the puck back to the new centroid.
            }}
          />

          {/* Rotate puck → drag to rigidly rotate the mesh. */}
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
              const node = e.target;
              const dx = node.x() - rotateAnchor.x;
              const dy = node.y() - rotateAnchor.y;
              lastRotateAngleRef.current = Math.atan2(dx, -dy) * (180 / Math.PI);
              setLiveAngleDeg(0);
            }}
            onDragMove={(e) => {
              const node = e.target;
              const dx = node.x() - rotateAnchor.x;
              const dy = node.y() - rotateAnchor.y;
              if (dx === 0 && dy === 0) return;
              let curAngle = Math.atan2(dx, -dy) * (180 / Math.PI);
              const evt = e.evt as MouseEvent | TouchEvent | undefined;
              const shift =
                evt && "shiftKey" in evt
                  ? (evt as MouseEvent).shiftKey
                  : false;
              if (shift) {
                curAngle = Math.round(curAngle / 15) * 15;
              }
              const last = lastRotateAngleRef.current ?? curAngle;
              // Wrap delta into [-180, 180] so a swing past the seam
              // doesn't blow up into ±300°.
              let delta = curAngle - last;
              if (delta > 180) delta -= 360;
              if (delta < -180) delta += 360;
              if (delta !== 0) {
                onRotateMesh(delta, rotateAnchor);
                lastRotateAngleRef.current = curAngle;
                setLiveAngleDeg((prev) => (prev ?? 0) + delta);
              }
            }}
            onDragEnd={(e) => {
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = "default";
              const node = e.target;
              // Snap puck back to the canonical "above centroid" spot
              // so the next drag starts cleanly.
              node.position(rotateHandlePos);
              lastRotateAngleRef.current = null;
              setLiveAngleDeg(null);
            }}
          />

          {/* Live angle readout while rotating. */}
          {liveAngleDeg !== null && (
            <Text
              x={rotateHandlePos.x + 12 / zoom}
              y={rotateHandlePos.y - 8 / zoom}
              text={`${rotationDisplay >= 0 ? "+" : ""}${rotationDisplay.toFixed(1)}°`}
              fontSize={12 / zoom}
              fill="#f0abfc"
              fontStyle="bold"
              listening={false}
            />
          )}

          {/* Resize puck → drag outward / inward to uniformly scale the
              whole mesh around the centroid. Uniform scale only — both
              X and Y multiply by the same factor so the panel ratio is
              preserved (no stretching). */}
          <Circle
            x={scaleHandlePos.x}
            y={scaleHandlePos.y}
            radius={scaleRadiusMockup}
            hitStrokeWidth={(SCALE_HANDLE_RADIUS_PX + 6) / zoom}
            fill={SCALE_HANDLE_FILL}
            stroke={scaleHover ? SCALE_HANDLE_HOVER_STROKE : SCALE_HANDLE_STROKE}
            strokeWidth={Math.max(1, 1.5 / zoom)}
            draggable
            onMouseEnter={(e) => {
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = "nwse-resize";
              setScaleHover(true);
            }}
            onMouseLeave={(e) => {
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = "default";
              setScaleHover(false);
            }}
            onDragStart={(e) => {
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = "nwse-resize";
              const node = e.target;
              const dx = node.x() - rotateAnchor.x;
              const dy = node.y() - rotateAnchor.y;
              const dist = Math.hypot(dx, dy);
              lastScaleDistanceRef.current = dist > 0 ? dist : scaleHandleInitDistance;
              setLiveScale(1);
            }}
            onDragMove={(e) => {
              const node = e.target;
              const dx = node.x() - rotateAnchor.x;
              const dy = node.y() - rotateAnchor.y;
              const dist = Math.hypot(dx, dy);
              if (dist <= 0) return;
              const last = lastScaleDistanceRef.current ?? dist;
              if (last <= 0) return;
              const delta = dist / last;
              if (Number.isFinite(delta) && delta > 0 && Math.abs(delta - 1) > 0.001) {
                onScaleMesh(delta, rotateAnchor);
                lastScaleDistanceRef.current = dist;
                setLiveScale((prev) => (prev ?? 1) * delta);
              }
            }}
            onDragEnd={(e) => {
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = "default";
              const node = e.target;
              // Snap puck back to the canonical AABB-corner spot so the
              // next drag starts from a known reference point.
              node.position(scaleHandlePos);
              lastScaleDistanceRef.current = null;
              setLiveScale(null);
            }}
          />
          {/* Live scale readout while resizing. */}
          {liveScale !== null && (
            <Text
              x={scaleHandlePos.x + 12 / zoom}
              y={scaleHandlePos.y - 8 / zoom}
              text={`×${liveScale.toFixed(2)}`}
              fontSize={12 / zoom}
              fill="#6ee7b7"
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
