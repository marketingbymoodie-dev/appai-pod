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
import { drawMeshWarp, meshIndex, meshOutline, warpUVThroughMesh } from "./meshUtils";
import type {
  CalibrationState,
  DebugFlags,
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
}: {
  panel: PanelState;
  image: HTMLImageElement | null;
  highlighted: boolean;
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
      drawMeshWarp(ctx as unknown as CanvasRenderingContext2D, image, sourceSize, panel.mesh, {
        opacity: panel.opacity,
        mask: panel.mask?.polygon ?? null,
      });
    },
    [panel.mesh, panel.opacity, panel.mask, panel.sourceSize, image, highlighted],
  );

  return <Shape listening={false} sceneFunc={sceneFunc} />;
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
}: {
  panel: PanelState;
  view: ViewId;
  panelKey: string;
  selected: boolean;
  actions: CalibrationActions;
  zoom: number;
  editable: boolean;
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
              onDragMove={(e) => {
                const node = e.target;
                actions.moveMeshPoint(view, panelKey, i, node.x(), node.y());
              }}
              onDragEnd={(e) => {
                const node = e.target;
                actions.moveMeshPoint(view, panelKey, i, node.x(), node.y());
              }}
            />
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
  return (
    <Group>
      {warped.length >= 2 && (
        <Line
          listening={false}
          points={warped.flatMap((p) => [p.x, p.y])}
          stroke="#a855f7"
          strokeWidth={1.5 / zoom}
          closed={warped.length >= 3}
          dash={[8 / zoom, 4 / zoom]}
          fill="rgba(168,85,247,0.08)"
        />
      )}
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
          onDragMove={(e) => {
            const node = e.target;
            // Convert dragged mockup-space point back to UV by inverting via nearest mesh cell.
            const newUv = mockupToUV(panel, node.x(), node.y());
            const next = polygon.slice();
            next[i] = newUv;
            actions.setMaskPolygon(view, panelKey, next);
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
  const { state, actions, view, selectedPanel, setSelectedPanel, mode, debug, width, height } = props;
  const stageRef = useRef<Konva.Stage | null>(null);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [draggingPanelKey, setDraggingPanelKey] = useState<string | null>(null);

  const viewState = state.views[view];
  const mockupImage = useLoadedImage(viewState.mockupSrc);

  const panelImageMap = usePanelImages(viewState);

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
          {mockupImage && viewState.mockupSize && (
            <KonvaImage
              image={mockupImage}
              x={0}
              y={0}
              width={viewState.mockupSize.width}
              height={viewState.mockupSize.height}
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
                <PanelMesh panel={panel} image={img} highlighted={isSelected} />
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
                  <MeshHandles panel={panel} view={view} panelKey={panel.panelKey} selected={isSelected} actions={actions} zoom={scale} editable={mode === "mesh" && isSelected} />
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
