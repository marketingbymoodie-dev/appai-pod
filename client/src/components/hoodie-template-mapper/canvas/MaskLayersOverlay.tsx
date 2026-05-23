import { Group, Line, Text, Circle } from "react-konva";
import { type CSSProperties, useMemo } from "react";
import type { MaskLayer } from "@shared/hoodieTemplate";
import { PANEL_DISPLAY_LABEL } from "@shared/hoodieTemplate";
import { centroid, svgPathToAnchors } from "../lib/svgPath";

/**
 * Renders all saved mask layers for the current view. Hover and selection
 * highlights are driven by the parent (so the canvas can pass through
 * pointer events for the active tool). Pointer events are gated by
 * `interactive` so the pen tools can draw over without snagging clicks.
 */

type Props = {
  layers: MaskLayer[];
  selectedId: string | null;
  hoverId: string | null;
  zoom: number;
  showPanelLabels: boolean;
  showHoverHighlight: boolean;
  interactive: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  /** Alt-click on the layer body — used by HoodieCanvas to insert an anchor at the click. */
  onAltClick?: (id: string, mockupX: number, mockupY: number) => void;
};

const PANEL_FILL = "rgba(56,189,248,0.08)";
const PANEL_STROKE = "#38bdf8";
const PANEL_HOVER_FILL = "rgba(148,163,184,0.18)";
const PANEL_SELECTED_FILL = "rgba(56,189,248,0.22)";
const PANEL_SELECTED_STROKE = "#7dd3fc";
const EXCLUSION_FILL = "rgba(239,68,68,0.10)";
const EXCLUSION_STROKE = "#ef4444";
const EXCLUSION_SELECTED_FILL = "rgba(239,68,68,0.22)";

function flatten(anchors: { x: number; y: number }[]): number[] {
  const out: number[] = [];
  for (const p of anchors) {
    out.push(p.x, p.y);
  }
  return out;
}

export default function MaskLayersOverlay(props: Props) {
  const {
    layers,
    selectedId,
    hoverId,
    zoom,
    showPanelLabels,
    showHoverHighlight,
    interactive,
    onHover,
    onSelect,
    onAltClick,
  } = props;

  const sorted = useMemo(() => [...layers].sort((a, b) => a.zIndex - b.zIndex), [layers]);

  return (
    <Group>
      {sorted.map((layer) => {
        if (!layer.visible) return null;
        const anchors = svgPathToAnchors(layer.maskPath);
        if (anchors.length < 3) return null;
        const isSelected = layer.id === selectedId;
        const isHover = layer.id === hoverId;
        const isExclusion = layer.isExclusion || layer.kind === "exclusion";
        const fill = isExclusion
          ? isSelected
            ? EXCLUSION_SELECTED_FILL
            : isHover && showHoverHighlight
              ? PANEL_HOVER_FILL
              : EXCLUSION_FILL
          : isSelected
            ? PANEL_SELECTED_FILL
            : isHover && showHoverHighlight
              ? PANEL_HOVER_FILL
              : PANEL_FILL;
        const stroke = isExclusion
          ? EXCLUSION_STROKE
          : isSelected
            ? PANEL_SELECTED_STROKE
            : PANEL_STROKE;
        const strokeWidth = (isSelected ? 2.5 : 1.5) / zoom;
        const opacity = layer.opacity;
        const dash = isExclusion ? [6 / zoom, 4 / zoom] : undefined;
        const labelPt = centroid(anchors);
        const label = layer.panelKey ? PANEL_DISPLAY_LABEL[layer.panelKey] : layer.name;
        return (
          <Group key={layer.id}>
            <Line
              points={flatten(anchors)}
              closed
              fill={fill}
              stroke={stroke}
              strokeWidth={strokeWidth}
              dash={dash}
              opacity={opacity}
              listening={interactive && !layer.locked}
              onMouseEnter={(e) => {
                onHover(layer.id);
                const stage = e.target.getStage();
                if (stage?.container()) stage.container().style.cursor = "pointer";
              }}
              onMouseLeave={(e) => {
                onHover(null);
                const stage = e.target.getStage();
                if (stage?.container()) stage.container().style.cursor = "default";
              }}
              onMouseDown={(e) => {
                const evt = e.evt as MouseEvent;
                if (evt.button !== 0) return;
                e.cancelBubble = true;
                if (evt.altKey && onAltClick) {
                  // Translate stage pointer back into mockup coords.
                  const stage = e.target.getStage();
                  if (stage) {
                    const pt = stage.getPointerPosition();
                    if (pt) {
                      const tr = stage.getAbsoluteTransform().copy().invert();
                      const mp = tr.point(pt);
                      onAltClick(layer.id, mp.x, mp.y);
                      return;
                    }
                  }
                }
                onSelect(layer.id);
              }}
            />
            {showPanelLabels && labelPt && (
              <Text
                x={labelPt.x}
                y={labelPt.y}
                text={`${label}${isExclusion ? " · EXCL" : ""}`}
                fontSize={11 / zoom}
                fill={isExclusion ? "#fecaca" : "#bae6fd"}
                listening={false}
                offsetX={50 / zoom}
                offsetY={6 / zoom}
                width={100 / zoom}
                align="center"
                shadowColor="#000"
                shadowBlur={3 / zoom}
                shadowOpacity={0.8}
              />
            )}
          </Group>
        );
      })}
    </Group>
  );
}

/** Read-only convenience: return inline CSS for a fallback non-Konva use. */
export const MASK_OVERLAY_DEFAULT_STYLE: CSSProperties = {};
