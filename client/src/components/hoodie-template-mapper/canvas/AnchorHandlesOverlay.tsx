import { Circle, Group } from "react-konva";
import Konva from "konva";
import type { Pt } from "@shared/hoodieTemplate";

/**
 * Draggable anchor handles for the selected mask layer. Each anchor is a
 * filled dot the user can drag to reshape the mask. Alt-click on an anchor
 * deletes it (with min-anchors=3 enforced by the parent). Edge-insert is
 * handled in HoodieCanvas via a click on the layer fill while in Move tool.
 */

type Props = {
  anchors: Pt[];
  zoom: number;
  selectedIndex: number | null;
  onSelectAnchor: (index: number | null) => void;
  onDragMove: (index: number, p: Pt) => void;
  onDragEnd: (index: number, p: Pt) => void;
  onDeleteAnchor: (index: number) => void;
};

const HANDLE_FILL = "#fff";
const HANDLE_STROKE = "#7dd3fc";
const HANDLE_SELECTED = "#fbbf24";

export default function AnchorHandlesOverlay({
  anchors,
  zoom,
  selectedIndex,
  onSelectAnchor,
  onDragMove,
  onDragEnd,
  onDeleteAnchor,
}: Props) {
  return (
    <Group>
      {anchors.map((p, i) => {
        const isSelected = i === selectedIndex;
        return (
          <Circle
            key={`handle-${i}`}
            x={p.x}
            y={p.y}
            radius={(isSelected ? 6 : 5) / zoom}
            fill={HANDLE_FILL}
            stroke={isSelected ? HANDLE_SELECTED : HANDLE_STROKE}
            strokeWidth={(isSelected ? 2.5 : 1.5) / zoom}
            draggable
            onMouseEnter={(e) => {
              const stage = e.target.getStage();
              if (stage?.container()) stage.container().style.cursor = "move";
            }}
            onMouseLeave={(e) => {
              const stage = e.target.getStage();
              if (stage?.container()) stage.container().style.cursor = "default";
            }}
            onMouseDown={(e: Konva.KonvaEventObject<MouseEvent>) => {
              e.cancelBubble = true;
              const evt = e.evt;
              if (evt.altKey) {
                evt.preventDefault();
                onDeleteAnchor(i);
                return;
              }
              onSelectAnchor(i);
            }}
            onDragMove={(e) =>
              onDragMove(i, { x: e.target.x(), y: e.target.y() })
            }
            onDragEnd={(e) => onDragEnd(i, { x: e.target.x(), y: e.target.y() })}
          />
        );
      })}
    </Group>
  );
}
