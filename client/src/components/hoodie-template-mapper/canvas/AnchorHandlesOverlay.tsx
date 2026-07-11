import { Circle, Group } from "react-konva";
import Konva from "konva";
import type { Pt } from "@shared/hoodieTemplate";

/**
 * Draggable anchor handles for the selected mask layer. Supports compound
 * paths (merged Front Left + Right) — one handle set per subpath.
 */

type Props = {
  subpaths: Pt[][];
  zoom: number;
  selectedSubpath: number | null;
  selectedIndex: number | null;
  onSelectAnchor: (subpathIndex: number, anchorIndex: number) => void;
  onDragMove: (subpathIndex: number, anchorIndex: number, p: Pt) => void;
  onDragEnd: (subpathIndex: number, anchorIndex: number, p: Pt) => void;
  onDeleteAnchor: (subpathIndex: number, anchorIndex: number) => void;
};

const HANDLE_FILL = "#fff";
const HANDLE_STROKE = "#7dd3fc";
const HANDLE_SELECTED = "#fbbf24";

export default function AnchorHandlesOverlay({
  subpaths,
  zoom,
  selectedSubpath,
  selectedIndex,
  onSelectAnchor,
  onDragMove,
  onDragEnd,
  onDeleteAnchor,
}: Props) {
  return (
    <Group>
      {subpaths.map((anchors, subpathIndex) =>
        anchors.map((p, anchorIndex) => {
          const isSelected =
            subpathIndex === selectedSubpath && anchorIndex === selectedIndex;
          return (
            <Circle
              key={`handle-${subpathIndex}-${anchorIndex}`}
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
                  onDeleteAnchor(subpathIndex, anchorIndex);
                  return;
                }
                onSelectAnchor(subpathIndex, anchorIndex);
              }}
              onDragMove={(e) =>
                onDragMove(subpathIndex, anchorIndex, {
                  x: e.target.x(),
                  y: e.target.y(),
                })
              }
              onDragEnd={(e) =>
                onDragEnd(subpathIndex, anchorIndex, {
                  x: e.target.x(),
                  y: e.target.y(),
                })
              }
            />
          );
        }),
      )}
    </Group>
  );
}
