import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Circle,
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Rect,
  Shape,
  Stage,
  Text,
} from "react-konva";
import Konva from "konva";
import { applyPanelTransformToMesh, drawMeshWarp, meshIndex, meshOutline, warpUVThroughMesh } from "./meshUtils";
import type {
  CalibrationState,
  DebugFlags,
  DetectionImport,
  PanelState,
  PanelTransform,
  UV,
  ViewId,
} from "./types";
import type { CalibrationActions } from "./useCalibration";

type EditorMode = "select" | "mesh" | "mask";

type MockupCanvasProps = {
  state: CalibrationState;
  actions: CalibrationActions;
  view: ViewId;
  selectedPanel: string | null;
  setSelectedPanel: (panelKey: string | null) => void;
  mode: EditorMode;
  debug: DebugFlags;
  width: number;
  height: number;
  detections?: Record<string, DetectionImport>;
};

function loadImage(src: string | null | undefined): Promise<HTMLImageElement | null> {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function useLoadedImage(src: string | null | undefined): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadImage(src ?? null).then((loaded) => {
      if (!cancelled) setImg(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [src]);
  return img;
}

function PanelMesh({
  panel,
  image,
  highlighted,
  previewMode,
  opacity,
}: {
  panel: PanelState;
  image: HTMLImageElement | null;
  highlighted: boolean;
  previewMode: DebugFlags["renderPreviewMode"];
  opacity: number;
}) {
  const sceneFunc = useCallback(
    (ctx: Konva.Context, _shape: Konva.Shape) => {
      const sourceSize = panel.sourceSize ?? (image ? { width: image.width, height: image.height } : null);
      if (!image || !sourceSize) {
        // Draw an outline only.
        ctx.beginPath();
        const pts = panel.mesh.points;
        ctx.moveTo(pts[0].x, pts[0].y);
        for (const p of pts) ctx.lineTo(p.x, p.y);
        ctx.closePath();
        ctx.strokeStyle = highlighted ? "#f97316" : "#94a3b8";
        ctx.lineWidth = 2;
        ctx.stroke();
        return;
      }
      const canvasCtx = ctx as unknown as CanvasRenderingContext2D;
      if (previewMode === "source") {
        const bounds = meshBounds(panel);
        canvasCtx.save();
        canvasCtx.globalAlpha = opacity;
        canvasCtx.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height);
        canvasCtx.restore();
        return;
      }
      if (previewMode === "difference") {
        canvasCtx.save();
        canvasCtx.globalCompositeOperation = "difference";
        drawMeshWarp(canvasCtx, image, sourceSize, panel.mesh, {
          opacity,
          mask: null,
        });
        canvasCtx.restore();
        return;
      }
      drawMeshWarp(canvasCtx, image, sourceSize, panel.mesh, {
        opacity,
        mask: previewMode === "clipped" ? panel.mask?.polygon ?? null : null,
      });
    },
    [panel, image, highlighted, previewMode, opacity],
  );

  return <Shape listening={false} sceneFunc={sceneFunc} />;
}

function meshBounds(panel: PanelState) {
  const xs = panel.mesh.points.map((p) => p.x);
  const ys = panel.mesh.points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function PanelBoundsOverlay({ panel, color }: { panel: PanelState; color: string }) {
  const cols = panel.mesh.cols;
  const rows = panel.mesh.rows;
  const pts = panel.mesh.points;
  const corners = [
    pts[0],
    pts[cols],
    pts[(rows + 1) * (cols + 1) - 1],
    pts[rows * (cols + 1)],
  ];
  return (
    <Line
      listening={false}
      points={corners.flatMap((c) => [c.x, c.y])}
      closed
      stroke={color}
      strokeWidth={2}
      dash={[6, 6]}
    />
  );
}

function PanelHitArea({ panel }: { panel: PanelState }) {
  return (
    <Line
      points={meshOutline(panel.mesh).flatMap((p) => [p.x, p.y])}
      closed
      fill="rgba(255,255,255,0.01)"
      strokeEnabled={false}
      listening
    />
  );
}

function MeshHandles({
  panel,
  view,
  panelKey,
  selected,
  actions,
  zoom,
  editable,
  showIntersections,
}: {
  panel: PanelState;
  view: ViewId;
  panelKey: string;
  selected: boolean;
  actions: CalibrationActions;
  zoom: number;
  editable: boolean;
  showIntersections: boolean;
}) {
  const cols = panel.mesh.cols;
  const rows = panel.mesh.rows;
  const handleSize = Math.max(4, 8 / zoom);
  const meshLines: number[][] = [];
  for (let r = 0; r <= rows; r++) {
    const row: number[] = [];
    for (let c = 0; c <= cols; c++) {
      const p = panel.mesh.points[meshIndex(panel.mesh, c, r)];
      row.push(p.x, p.y);
    }
    meshLines.push(row);
  }
  for (let c = 0; c <= cols; c++) {
    const col: number[] = [];
    for (let r = 0; r <= rows; r++) {
      const p = panel.mesh.points[meshIndex(panel.mesh, c, r)];
      col.push(p.x, p.y);
    }
    meshLines.push(col);
  }

  return (
    <Group>
      {meshLines.map((pts, i) => (
        <Line key={i} listening={false} points={pts} stroke={selected ? "#0ea5e9" : "#64748b"} strokeWidth={1 / zoom} opacity={0.7} />
      ))}
      {selected && showIntersections &&
        panel.mesh.points.map((p, i) => (
          <Circle
            key={`grid-${i}`}
            x={p.x}
            y={p.y}
            radius={Math.max(2, 3.5 / zoom)}
            fill="#bae6fd"
            opacity={0.65}
            listening={false}
          />
        ))}
      {selected && editable && !panel.locked &&
        panel.mesh.points.map((p, i) => {
          const r = Math.max(0, Math.floor(i / (cols + 1)));
          const c = i - r * (cols + 1);
          const isCorner = (c === 0 || c === cols) && (r === 0 || r === rows);
          const isEdge = (!isCorner) && (c === 0 || c === cols || r === 0 || r === rows);
          const fill = isCorner ? "#f97316" : isEdge ? "#22c55e" : "#0ea5e9";
          return (
            <Circle
              key={`h-${i}`}
              x={p.x}
              y={p.y}
              radius={handleSize}
              fill={fill}
              stroke="#0f172a"
              strokeWidth={1 / zoom}
              draggable
              onMouseEnter={(e) => {
                const stage = e.target.getStage();
                if (stage) stage.container().style.cursor = "grab";
              }}
              onMouseLeave={(e) => {
                const stage = e.target.getStage();
                if (stage) stage.container().style.cursor = "default";
              }}
              onDragStart={(e) => {
                const stage = e.target.getStage();
                if (stage) stage.container().style.cursor = "grabbing";
              }}
              onDragMove={(e) => {
                const node = e.target;
                actions.moveMeshPoint(view, panelKey, i, node.x(), node.y());
              }}
              onDragEnd={(e) => {
                const node = e.target;
                actions.moveMeshPoint(view, panelKey, i, node.x(), node.y());
                const stage = e.target.getStage();
                if (stage) stage.container().style.cursor = "grab";
              }}
            />
          );
        })}
    </Group>
  );
}

function MeshDistortionHeatmap({ panel, zoom }: { panel: PanelState; zoom: number }) {
  const cells: Array<{ points: number[]; fill: string; ratio: number }> = [];
  for (let r = 0; r < panel.mesh.rows; r++) {
    for (let c = 0; c < panel.mesh.cols; c++) {
      const tl = panel.mesh.points[meshIndex(panel.mesh, c, r)];
      const tr = panel.mesh.points[meshIndex(panel.mesh, c + 1, r)];
      const br = panel.mesh.points[meshIndex(panel.mesh, c + 1, r + 1)];
      const bl = panel.mesh.points[meshIndex(panel.mesh, c, r + 1)];
      const top = dist(tl, tr);
      const bottom = dist(bl, br);
      const left = dist(tl, bl);
      const right = dist(tr, br);
      const horizontalRatio = Math.max(top, bottom) / Math.max(1, Math.min(top, bottom));
      const verticalRatio = Math.max(left, right) / Math.max(1, Math.min(left, right));
      const ratio = Math.max(horizontalRatio, verticalRatio);
      const fill = ratio > 1.8 ? "rgba(239,68,68,0.28)" : ratio > 1.25 ? "rgba(234,179,8,0.24)" : "rgba(34,197,94,0.18)";
      cells.push({ points: [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y], fill, ratio });
    }
  }
  return (
    <Group listening={false}>
      {cells.map((cell, idx) => (
        <Line
          key={idx}
          points={cell.points}
          closed
          fill={cell.fill}
          stroke={cell.ratio > 1.8 ? "#ef4444" : cell.ratio > 1.25 ? "#eab308" : "#22c55e"}
          strokeWidth={0.75 / zoom}
          opacity={0.95}
        />
      ))}
    </Group>
  );
}

function MeshCellHoverOverlay({
  panel,
  zoom,
}: {
  panel: PanelState;
  zoom: number;
}) {
  const [hoveredCell, setHoveredCell] = useState<number | null>(null);
  const cells: number[][] = [];
  for (let r = 0; r < panel.mesh.rows; r++) {
    for (let c = 0; c < panel.mesh.cols; c++) {
      const tl = panel.mesh.points[meshIndex(panel.mesh, c, r)];
      const tr = panel.mesh.points[meshIndex(panel.mesh, c + 1, r)];
      const br = panel.mesh.points[meshIndex(panel.mesh, c + 1, r + 1)];
      const bl = panel.mesh.points[meshIndex(panel.mesh, c, r + 1)];
      cells.push([tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
    }
  }
  return (
    <Group>
      {cells.map((points, idx) => (
        <Line
          key={idx}
          points={points}
          closed
          fill={hoveredCell === idx ? "rgba(14,165,233,0.18)" : "rgba(255,255,255,0.001)"}
          stroke={hoveredCell === idx ? "#38bdf8" : "transparent"}
          strokeWidth={hoveredCell === idx ? 2 / zoom : 0}
          onMouseEnter={(e) => {
            setHoveredCell(idx);
            const stage = e.target.getStage();
            if (stage) stage.container().style.cursor = "crosshair";
          }}
          onMouseLeave={(e) => {
            setHoveredCell(null);
            const stage = e.target.getStage();
            if (stage) stage.container().style.cursor = "default";
          }}
        />
      ))}
    </Group>
  );
}

function MaskEdgeHoverOverlay({
  panel,
  warped,
  zoom,
}: {
  panel: PanelState;
  warped: Array<{ x: number; y: number }>;
  zoom: number;
}) {
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);
  if (warped.length < 2 || panel.locked) return null;
  return (
    <Group>
      {warped.map((p, i) => {
        const next = warped[(i + 1) % warped.length];
        if (!next || (i === warped.length - 1 && warped.length < 3)) return null;
        return (
          <Line
            key={i}
            points={[p.x, p.y, next.x, next.y]}
            stroke={hoveredEdge === i ? "#f0abfc" : "rgba(255,255,255,0.001)"}
            strokeWidth={hoveredEdge === i ? 4 / zoom : 10 / zoom}
            lineCap="round"
            onMouseEnter={(e) => {
              setHoveredEdge(i);
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = "crosshair";
            }}
            onMouseLeave={(e) => {
              setHoveredEdge(null);
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = "default";
            }}
          />
        );
      })}
    </Group>
  );
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function DetectionOverlay({
  panel,
  detection,
  debug,
  zoom,
}: {
  panel: PanelState;
  detection: DetectionImport;
  debug: DebugFlags;
  zoom: number;
}) {
  const heatCells = useMemo(() => {
    if (!debug.showDetectionConfidenceHeatmap) return [] as Array<{ points: number[]; fill: string }>;
    const cols = detection.suggestedMesh.cols;
    const rows = detection.suggestedMesh.rows;
    const idxFor = (c: number, r: number) => r * (cols + 1) + c;
    const pts = detection.suggestedMesh.points;
    if (pts.length !== (cols + 1) * (rows + 1)) return [];
    const result: Array<{ points: number[]; fill: string }> = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tl = pts[idxFor(c, r)];
        const tr = pts[idxFor(c + 1, r)];
        const br = pts[idxFor(c + 1, r + 1)];
        const bl = pts[idxFor(c, r + 1)];
        const conf = ((tl.confidence ?? 0) + (tr.confidence ?? 0) + (br.confidence ?? 0) + (bl.confidence ?? 0)) / 4;
        const fill =
          conf > 0.75
            ? "rgba(34,197,94,0.32)"
            : conf > 0.45
              ? "rgba(234,179,8,0.32)"
              : conf > 0.2
                ? "rgba(249,115,22,0.32)"
                : "rgba(220,38,38,0.32)";
        result.push({ points: [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y], fill });
      }
    }
    return result;
  }, [debug.showDetectionConfidenceHeatmap, detection.suggestedMesh]);

  return (
    <Group listening={false}>
      {heatCells.map((cell, idx) => (
        <Line key={`heat-${idx}`} points={cell.points} closed fill={cell.fill} stroke="rgba(15,23,42,0.4)" strokeWidth={0.5 / zoom} />
      ))}
      {debug.showDetectionCorrespondences && detection.correspondences.map((corr, idx) => {
        const current = warpUVThroughMesh(panel.mesh, corr.source.u, corr.source.v);
        const stroke = corr.confidence > 0.7 ? "rgba(34,197,94,0.85)" : corr.confidence > 0.4 ? "rgba(234,179,8,0.85)" : "rgba(249,115,22,0.85)";
        return (
          <Line
            key={`corr-${idx}`}
            points={[current.x, current.y, corr.target.x, corr.target.y]}
            stroke={stroke}
            strokeWidth={1.4 / zoom}
            dash={[6 / zoom, 4 / zoom]}
          />
        );
      })}
      {debug.showDetectionTriangles && detection.detectedTriangles
        .filter((t) => !t.rejected && t.centroidXY)
        .map((tri) => {
          const fill = tri.confidence > 0.7 ? "#22c55e" : tri.confidence > 0.4 ? "#eab308" : "#f97316";
          return (
            <Group key={`tri-${tri.id}`}>
              <Circle
                x={tri.centroidXY!.x}
                y={tri.centroidXY!.y}
                radius={Math.max(2, 5 / zoom)}
                fill={fill}
                stroke="#0f172a"
                strokeWidth={1 / zoom}
              />
              <Text
                x={tri.centroidXY!.x + 6 / zoom}
                y={tri.centroidXY!.y - 6 / zoom}
                text={`${tri.id}`}
                fontSize={10 / zoom}
                fill="#f8fafc"
                stroke="#0f172a"
                strokeWidth={2 / zoom}
                fillAfterStrokeEnabled
              />
            </Group>
          );
        })}
      {debug.showDetectionRejected && detection.detectedTriangles
        .filter((t) => t.rejected)
        .map((tri) => {
          const placeholder = warpUVThroughMesh(panel.mesh, tri.centroidUV.u, tri.centroidUV.v);
          return (
            <Group key={`rej-${tri.id}`}>
              <Circle
                x={placeholder.x}
                y={placeholder.y}
                radius={Math.max(2, 4 / zoom)}
                fill="rgba(220,38,38,0.6)"
                stroke="#0f172a"
                strokeWidth={1 / zoom}
                dash={[3 / zoom, 2 / zoom]}
              />
              <Text
                x={placeholder.x + 6 / zoom}
                y={placeholder.y - 6 / zoom}
                text={`${tri.id}*`}
                fontSize={9 / zoom}
                fill="#fecaca"
              />
            </Group>
          );
        })}
    </Group>
  );
}

function MaskEditor({
  panel,
  view,
  panelKey,
  actions,
  zoom,
}: {
  panel: PanelState;
  view: ViewId;
  panelKey: string;
  actions: CalibrationActions;
  zoom: number;
}) {
  const polygon = panel.mask?.polygon ?? [];
  const warped = polygon.map((p) => warpUVThroughMesh(panel.mesh, p.u, p.v));
  const handleSize = Math.max(4, 8 / zoom);
  const winding = signedArea(warped) >= 0 ? "CW" : "CCW";
  return (
    <Group>
      {warped.length >= 3 && (
        <Shape
          listening={false}
          sceneFunc={(ctx) => {
            const canvasCtx = ctx as unknown as CanvasRenderingContext2D;
            const bounds = meshBounds(panel);
            canvasCtx.save();
            canvasCtx.beginPath();
            canvasCtx.rect(bounds.x - 80 / zoom, bounds.y - 80 / zoom, bounds.width + 160 / zoom, bounds.height + 160 / zoom);
            canvasCtx.moveTo(warped[0].x, warped[0].y);
            for (let i = 1; i < warped.length; i++) canvasCtx.lineTo(warped[i].x, warped[i].y);
            canvasCtx.closePath();
            canvasCtx.fillStyle = "rgba(2,6,23,0.45)";
            canvasCtx.fill("evenodd");
            canvasCtx.restore();
          }}
        />
      )}
      {warped.length >= 2 && (
        <Line
          listening={false}
          points={warped.flatMap((p) => [p.x, p.y])}
          stroke="#d946ef"
          strokeWidth={2.5 / zoom}
          closed={warped.length >= 3}
          fill="rgba(168,85,247,0.18)"
        />
      )}
      {warped.map((p, i) => {
        const next = warped[(i + 1) % warped.length];
        if (!next || warped.length < 2) return null;
        const mid = { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 };
        return (
          <Text
            key={`edge-${i}`}
            x={mid.x + 4 / zoom}
            y={mid.y + 4 / zoom}
            text={`${i + 1}`}
            fontSize={10 / zoom}
            fill="#f0abfc"
            listening={false}
          />
        );
      })}
      {warped.length >= 3 && (
        <Text
          x={warped[0].x}
          y={warped[0].y - 20 / zoom}
          text={`mask ${winding}`}
          fontSize={12 / zoom}
          fill="#f0abfc"
          listening={false}
        />
      )}
      <MaskEdgeHoverOverlay panel={panel} warped={warped} zoom={zoom} />
      {warped.map((p, i) => (
        <Circle
          key={`mask-${i}`}
          x={p.x}
          y={p.y}
          radius={handleSize}
          fill="#a855f7"
          stroke="#0f172a"
          strokeWidth={1 / zoom}
          draggable={!panel.locked}
          onMouseEnter={(e) => {
            const stage = e.target.getStage();
            if (stage) stage.container().style.cursor = "grab";
          }}
          onMouseLeave={(e) => {
            const stage = e.target.getStage();
            if (stage) stage.container().style.cursor = "default";
          }}
          onDragStart={(e) => {
            const stage = e.target.getStage();
            if (stage) stage.container().style.cursor = "grabbing";
          }}
          onDragMove={(e) => {
            const node = e.target;
            // Convert dragged mockup-space point back to UV by inverting via nearest mesh cell.
            const newUv = mockupToUV(panel, node.x(), node.y());
            const next = polygon.slice();
            next[i] = newUv;
            actions.setMaskPolygon(view, panelKey, next);
          }}
          onDragEnd={(e) => {
            const stage = e.target.getStage();
            if (stage) stage.container().style.cursor = "grab";
          }}
          onDblClick={() => {
            // remove vertex on double-click
            if (polygon.length <= 3) return;
            const next = polygon.filter((_, idx) => idx !== i);
            actions.setMaskPolygon(view, panelKey, next);
          }}
        />
      ))}
    </Group>
  );
}

function signedArea(points: Array<{ x: number; y: number }>) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += (b.x - a.x) * (b.y + a.y);
  }
  return sum;
}

function mockupToUV(panel: PanelState, x: number, y: number): UV {
  // Find nearest mesh cell by (x,y), then bilinearly invert. Simple solution: search all cells.
  const cols = panel.mesh.cols;
  const rows = panel.mesh.rows;
  let best: { u: number; v: number; d: number } = { u: 0, v: 0, d: Infinity };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tl = panel.mesh.points[meshIndex(panel.mesh, c, r)];
      const tr = panel.mesh.points[meshIndex(panel.mesh, c + 1, r)];
      const bl = panel.mesh.points[meshIndex(panel.mesh, c, r + 1)];
      const br = panel.mesh.points[meshIndex(panel.mesh, c + 1, r + 1)];
      // Approximate: solve bilinear inverse via Newton's. For simplicity, sample the cell densely.
      const samples = 8;
      for (let sr = 0; sr <= samples; sr++) {
        for (let sc = 0; sc <= samples; sc++) {
          const lu = sc / samples;
          const lv = sr / samples;
          const top = { x: tl.x + (tr.x - tl.x) * lu, y: tl.y + (tr.y - tl.y) * lu };
          const bottom = { x: bl.x + (br.x - bl.x) * lu, y: bl.y + (br.y - bl.y) * lu };
          const px = top.x + (bottom.x - top.x) * lv;
          const py = top.y + (bottom.y - top.y) * lv;
          const dx = px - x;
          const dy = py - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < best.d) {
            const u = (c + lu) / cols;
            const v = (r + lv) / rows;
            best = { u, v, d: d2 };
          }
        }
      }
    }
  }
  return { u: Math.min(1, Math.max(0, best.u)), v: Math.min(1, Math.max(0, best.v)) };
}

const IDENTITY_TRANSFORM: PanelTransform = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };

function panelTransform(panel: PanelState): PanelTransform {
  return { ...IDENTITY_TRANSFORM, ...(panel.transform ?? {}) };
}

function inversePanelPoint(panel: PanelState, x: number, y: number): { x: number; y: number } {
  const t = panelTransform(panel);
  const dx = x - t.x;
  const dy = y - t.y;
  const cos = Math.cos(-t.rotation);
  const sin = Math.sin(-t.rotation);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  return {
    x: rx / (t.scaleX || 1),
    y: ry / (t.scaleY || 1),
  };
}

export default function MockupCanvas(props: MockupCanvasProps) {
  const { state, actions, view, selectedPanel, setSelectedPanel, mode, debug, width, height, detections } = props;
  const stageRef = useRef<Konva.Stage | null>(null);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [draggingPanelKey, setDraggingPanelKey] = useState<string | null>(null);
  const [blinkOn, setBlinkOn] = useState(false);

  const viewState = state.views[view];
  const mockupImage = useLoadedImage(viewState.mockupSrc);

  const panelImageMap = usePanelImages(viewState);

  useEffect(() => {
    if (!debug.blinkCompare) {
      setBlinkOn(false);
      return;
    }
    const id = window.setInterval(() => setBlinkOn((value) => !value), 450);
    return () => window.clearInterval(id);
  }, [debug.blinkCompare]);

  // Fit-to-screen on mount or when the mockup changes.
  useEffect(() => {
    if (!viewState.mockupSize) return;
    const padding = 40;
    const sx = (width - padding * 2) / viewState.mockupSize.width;
    const sy = (height - padding * 2) / viewState.mockupSize.height;
    const s = Math.min(sx, sy);
    setScale(s);
    setPosition({
      x: padding + (width - padding * 2 - viewState.mockupSize.width * s) / 2,
      y: padding + (height - padding * 2 - viewState.mockupSize.height * s) / 2,
    });
  }, [viewState.mockupSize?.width, viewState.mockupSize?.height, width, height]);

  const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = e.target.getStage();
    if (!stage) return;
    const oldScale = scale;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const newScale = Math.max(0.05, Math.min(10, oldScale * (1 + direction * 0.1)));
    const mousePoint = {
      x: (pointer.x - position.x) / oldScale,
      y: (pointer.y - position.y) / oldScale,
    };
    const newPos = {
      x: pointer.x - mousePoint.x * newScale,
      y: pointer.y - mousePoint.y * newScale,
    };
    setScale(newScale);
    setPosition(newPos);
  };

  const onStageClick = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.target === e.target.getStage()) {
      if (mode === "mask" && selectedPanel) {
        // add a mask vertex at click
        const stage = e.target.getStage();
        const pointer = stage?.getPointerPosition();
        if (!pointer) return;
        const px = (pointer.x - position.x) / scale;
        const py = (pointer.y - position.y) / scale;
        const panel = viewState.panels[selectedPanel];
        if (!panel) return;
        const local = inversePanelPoint(panel, px, py);
        const uv = mockupToUV(panel, local.x, local.y);
        const polygon = panel.mask?.polygon ?? [];
        actions.setMaskPolygon(view, selectedPanel, [...polygon, uv]);
        return;
      }
      setSelectedPanel(null);
    }
  };

  const sortedPanels = useMemo(() => {
    return [...viewState.panelOrder]
      .map((k) => viewState.panels[k])
      .filter((p): p is PanelState => Boolean(p))
      .sort((a, b) => a.zIndex - b.zIndex);
  }, [viewState.panels, viewState.panelOrder]);

  const setCursor = useCallback((cursor: string) => {
    const container = stageRef.current?.container();
    if (container) container.style.cursor = cursor;
  }, []);

  const effectiveMockupOpacity = debug.blinkCompare && blinkOn ? 0 : debug.mockupOpacity;
  const effectivePanelOpacity = debug.blinkCompare && !blinkOn ? 0 : debug.warpedPanelOpacity;
  const showMockup = debug.renderPreviewMode !== "source";

  return (
    <div className="relative h-full w-full bg-slate-950 overflow-hidden" data-testid="aop-mapper-canvas">
      <Stage
        ref={(s) => {
          stageRef.current = s;
        }}
        width={width}
        height={height}
        scaleX={scale}
        scaleY={scale}
        x={position.x}
        y={position.y}
        draggable={mode === "select" && draggingPanelKey === null}
        onDragEnd={(e) => {
          if (e.target === e.target.getStage()) setPosition({ x: e.target.x(), y: e.target.y() });
        }}
        onWheel={handleWheel}
        onMouseDown={onStageClick}
      >
        {/* Background */}
        <Layer listening={false}>
          {viewState.mockupSize && (
            <Rect
              x={0}
              y={0}
              width={viewState.mockupSize.width}
              height={viewState.mockupSize.height}
              fill="#0f172a"
            />
          )}
          {mockupImage && viewState.mockupSize && showMockup && (
            <KonvaImage
              image={mockupImage}
              x={0}
              y={0}
              width={viewState.mockupSize.width}
              height={viewState.mockupSize.height}
              opacity={effectiveMockupOpacity}
              filters={debug.highContrast ? [Konva.Filters.Contrast] : []}
              contrast={debug.highContrast ? 80 : 0}
              listening={false}
              ref={(node) => {
                if (node && debug.highContrast) {
                  node.cache();
                }
              }}
            />
          )}
          {debug.showGarmentSeamGuides && viewState.mockupSize && (
            <Group listening={false}>
              <Line
                points={[viewState.mockupSize.width / 2, 0, viewState.mockupSize.width / 2, viewState.mockupSize.height]}
                stroke="#38bdf8"
                strokeWidth={1 / scale}
                dash={[10 / scale, 8 / scale]}
                opacity={0.45}
              />
              <Line
                points={[0, viewState.mockupSize.height / 2, viewState.mockupSize.width, viewState.mockupSize.height / 2]}
                stroke="#38bdf8"
                strokeWidth={1 / scale}
                dash={[10 / scale, 8 / scale]}
                opacity={0.35}
              />
            </Group>
          )}
          {debug.showMockupEdges && viewState.mockupSize && (
            <Group listening={false}>
              <Rect
                x={0}
                y={0}
                width={viewState.mockupSize.width}
                height={viewState.mockupSize.height}
                stroke="#f8fafc"
                strokeWidth={2 / scale}
                dash={[8 / scale, 6 / scale]}
                opacity={0.35}
              />
            </Group>
          )}
        </Layer>

        {/* Onion skin (duplicate mockup image at user-set opacity, on top of panels) */}
        {/* Rendered as separate layer below panels for now. */}

        {/* Panels */}
        <Layer>
          {sortedPanels.map((panel) => {
            if (!panel.visible) return null;
            const img = panelImageMap[panel.panelKey] ?? null;
            const isSelected = panel.panelKey === selectedPanel;
            const transform = panelTransform(panel);
            const canDragPanel = mode === "select" && isSelected && !panel.locked;
            return (
              <Group
                key={panel.panelKey}
                x={transform.x}
                y={transform.y}
                rotation={transform.rotation * (180 / Math.PI)}
                scaleX={transform.scaleX}
                scaleY={transform.scaleY}
                draggable={canDragPanel}
                onMouseDown={(e) => {
                  e.cancelBubble = true;
                  setSelectedPanel(panel.panelKey);
                }}
                onMouseEnter={() => {
                  if (canDragPanel) setCursor("grab");
                }}
                onMouseLeave={() => {
                  if (draggingPanelKey !== panel.panelKey) setCursor("default");
                }}
                onDragStart={(e) => {
                  e.cancelBubble = true;
                  setSelectedPanel(panel.panelKey);
                  setDraggingPanelKey(panel.panelKey);
                  setCursor("grabbing");
                }}
                onDragMove={(e) => {
                  e.cancelBubble = true;
                  const node = e.currentTarget;
                  actions.setPanelTransform(view, panel.panelKey, { x: node.x(), y: node.y() });
                }}
                onDragEnd={(e) => {
                  e.cancelBubble = true;
                  const node = e.currentTarget;
                  actions.setPanelTransform(view, panel.panelKey, { x: node.x(), y: node.y() });
                  setDraggingPanelKey(null);
                  setCursor(canDragPanel ? "grab" : "default");
                }}
              >
                {mode === "select" && <PanelHitArea panel={panel} />}
                <PanelMesh
                  panel={panel}
                  image={img}
                  highlighted={isSelected}
                  previewMode={mode === "mask" && isSelected ? "clipped" : debug.renderPreviewMode}
                  opacity={panel.opacity * effectivePanelOpacity}
                />
                {debug.showPanelBounds && (
                  <PanelBoundsOverlay panel={panel} color={isSelected ? "#f97316" : "#94a3b8"} />
                )}
              </Group>
            );
          })}
        </Layer>

        {/* Onion skin */}
        {debug.showOnionSkin && mockupImage && viewState.mockupSize && (
          <Layer listening={false}>
            <KonvaImage
              image={mockupImage}
              x={0}
              y={0}
              width={viewState.mockupSize.width}
              height={viewState.mockupSize.height}
              opacity={debug.onionSkinOpacity}
            />
          </Layer>
        )}

        {/* Detection overlay (AI-assist) */}
        {detections && Object.keys(detections).length > 0 && (
          <Layer listening={false}>
            {sortedPanels.map((panel) => {
              const det = detections[panel.panelKey];
              if (!det) return null;
              return <DetectionOverlay key={`det-${panel.panelKey}`} panel={panel} detection={det} debug={debug} zoom={scale} />;
            })}
          </Layer>
        )}

        {/* Mesh + mask handles */}
        <Layer>
          {sortedPanels.map((panel) => {
            if (!panel.visible) return null;
            const isSelected = panel.panelKey === selectedPanel;
            const transform = panelTransform(panel);
            return (
              <Group
                key={`handles-${panel.panelKey}`}
                x={transform.x}
                y={transform.y}
                rotation={transform.rotation * (180 / Math.PI)}
                scaleX={transform.scaleX}
                scaleY={transform.scaleY}
              >
                {(debug.showMesh || (mode === "mesh" && isSelected)) && (
                  <>
                    {debug.showDistortionHeatmap && (mode === "mesh" || isSelected) && (
                      <MeshDistortionHeatmap panel={panel} zoom={scale} />
                    )}
                    {mode === "mesh" && isSelected && <MeshCellHoverOverlay panel={panel} zoom={scale} />}
                    <MeshHandles
                      panel={panel}
                      view={view}
                      panelKey={panel.panelKey}
                      selected={isSelected}
                      actions={actions}
                      zoom={scale}
                      editable={mode === "mesh" && isSelected}
                      showIntersections={debug.showGridIntersections}
                    />
                  </>
                )}
                {(debug.showMask || (mode === "mask" && isSelected)) && panel.mask && (
                  <MaskEditor panel={panel} view={view} panelKey={panel.panelKey} actions={actions} zoom={scale} />
                )}
                {isSelected && (
                  <Text
                    x={panel.mesh.points[0].x}
                    y={panel.mesh.points[0].y - 18 / scale}
                    text={`${panel.panelKey}${panel.locked ? " (locked)" : ""}`}
                    fontSize={14 / scale}
                    fill="#f1f5f9"
                    listening={false}
                  />
                )}
              </Group>
            );
          })}
        </Layer>
      </Stage>

      <div className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-2 py-1 text-xs text-slate-200" data-testid="aop-mapper-canvas-zoom">
        zoom {(scale * 100).toFixed(0)}%
      </div>
      {debug.showFinalPreview && (
        <FinalPreview
          viewState={viewState}
          mockupImage={mockupImage}
          panelImageMap={panelImageMap}
          sortedPanels={sortedPanels}
        />
      )}
    </div>
  );
}

function FinalPreview({
  viewState,
  mockupImage,
  panelImageMap,
  sortedPanels,
}: {
  viewState: CalibrationState["views"][ViewId];
  mockupImage: HTMLImageElement | null;
  panelImageMap: Record<string, HTMLImageElement | null>;
  sortedPanels: PanelState[];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const canvas = canvasRef.current;
      const size = viewState.mockupSize;
      if (!canvas || !size) return;
      const previewW = 220;
      const previewH = Math.max(1, Math.round((size.height / Math.max(1, size.width)) * previewW));
      canvas.width = previewW;
      canvas.height = previewH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, previewW, previewH);
      ctx.save();
      ctx.scale(previewW / size.width, previewH / size.height);
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(0, 0, size.width, size.height);
      if (mockupImage) ctx.drawImage(mockupImage, 0, 0, size.width, size.height);
      for (const panel of sortedPanels) {
        const img = panelImageMap[panel.panelKey];
        const sourceSize = panel.sourceSize ?? (img ? { width: img.width, height: img.height } : null);
        if (!panel.visible || !img || !sourceSize) continue;
        drawMeshWarp(ctx, img, sourceSize, applyPanelTransformToMesh(panel.mesh, panel.transform), {
          opacity: panel.opacity,
          mask: panel.mask?.polygon ?? null,
        });
      }
      ctx.restore();
    }, 40);
    return () => window.clearTimeout(timeout);
  }, [viewState.mockupSize, mockupImage, panelImageMap, sortedPanels]);

  return (
    <div className="pointer-events-none absolute bottom-3 right-3 rounded-lg border border-slate-700 bg-slate-950/90 p-2 shadow-2xl">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-300">Final output only</div>
      <canvas ref={canvasRef} className="block rounded border border-slate-800 bg-slate-900" />
    </div>
  );
}

function usePanelImages(viewState: { panels: Record<string, PanelState> }): Record<string, HTMLImageElement | null> {
  const [map, setMap] = useState<Record<string, HTMLImageElement | null>>({});
  const artworkKey = useMemo(
    () => Object.values(viewState.panels).map((panel) => `${panel.panelKey}:${panel.artworkSrc ?? ""}`).sort().join("|"),
    [viewState.panels],
  );
  useEffect(() => {
    let cancelled = false;
    const tasks = Object.values(viewState.panels).map(async (panel) => {
      if (!panel.artworkSrc) return [panel.panelKey, null] as const;
      const img = await loadImage(panel.artworkSrc);
      return [panel.panelKey, img] as const;
    });
    Promise.all(tasks).then((entries) => {
      if (cancelled) return;
      const out: Record<string, HTMLImageElement | null> = {};
      for (const [key, img] of entries) out[key] = img;
      setMap(out);
    });
    return () => {
      cancelled = true;
    };
  }, [artworkKey]);
  return map;
}
