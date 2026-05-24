import { Circle, Group, Line } from "react-konva";
import type { Pt } from "@shared/hoodieTemplate";
import type { PenDraft } from "../store";

/**
 * Renders the in-progress polygon being drawn by the pen tools. Shows:
 *  - solid line through committed anchors
 *  - dashed "next segment" preview to the cursor
 *  - small dots at each anchor; first anchor highlighted when canClose
 *  - a "snap target" ring at the magnetic-snapped cursor position
 *
 * Listening is disabled — clicks belong to the canvas mouse handler.
 */

type Props = {
  draft: PenDraft;
  zoom: number;
  /** Magnetic-snapped cursor position, when different from raw cursor. */
  snapTarget: Pt | null;
  /** Pixel radius the snap is searching, in mockup coords. 0 means no magnet. */
  snapRadius: number;
};

const ACCENT = "#fbbf24";
const ACCENT_CLOSE = "#22c55e";
const SNAP_COLOR = "#a78bfa";

function flatten(anchors: readonly Pt[]): number[] {
  const out: number[] = [];
  for (const p of anchors) out.push(p.x, p.y);
  return out;
}

export default function PenToolOverlay({ draft, zoom, snapTarget, snapRadius }: Props) {
  const anchors = draft.anchors;
  const cursor = draft.cursor;
  const sw = 1.5 / zoom;

  return (
    <Group listening={false}>
      {/* Committed segments. */}
      {anchors.length > 1 && (
        <Line points={flatten(anchors)} stroke={ACCENT} strokeWidth={sw} lineJoin="round" />
      )}

      {/* Live preview segment from last anchor to cursor. */}
      {anchors.length > 0 && cursor && (
        <Line
          points={[anchors[anchors.length - 1].x, anchors[anchors.length - 1].y, cursor.x, cursor.y]}
          stroke={draft.canClose ? ACCENT_CLOSE : ACCENT}
          strokeWidth={sw}
          dash={[6 / zoom, 4 / zoom]}
          opacity={0.85}
        />
      )}

      {/* Closing preview: line from cursor back to anchor[0] when close enough. */}
      {draft.canClose && anchors.length > 1 && cursor && (
        <Line
          points={[cursor.x, cursor.y, anchors[0].x, anchors[0].y]}
          stroke={ACCENT_CLOSE}
          strokeWidth={sw}
          dash={[6 / zoom, 4 / zoom]}
          opacity={0.85}
        />
      )}

      {/* Anchor dots. */}
      {anchors.map((p, i) => (
        <Circle
          key={`anchor-${i}`}
          x={p.x}
          y={p.y}
          radius={(i === 0 && draft.canClose ? 7 : 4) / zoom}
          fill={i === 0 ? (draft.canClose ? ACCENT_CLOSE : ACCENT) : "#0f172a"}
          stroke={i === 0 ? "#fff" : ACCENT}
          strokeWidth={(i === 0 ? 2 : 1.5) / zoom}
        />
      ))}

      {/* Magnetic snap target indicator + radius ring. */}
      {snapRadius > 0 && cursor && (
        <Circle
          x={cursor.x}
          y={cursor.y}
          radius={snapRadius}
          stroke={SNAP_COLOR}
          strokeWidth={1 / zoom}
          opacity={0.18}
          dash={[3 / zoom, 4 / zoom]}
        />
      )}
      {snapTarget && (
        <Group>
          <Circle
            x={snapTarget.x}
            y={snapTarget.y}
            radius={6 / zoom}
            stroke={SNAP_COLOR}
            strokeWidth={2 / zoom}
            opacity={0.95}
          />
          <Circle x={snapTarget.x} y={snapTarget.y} radius={1.5 / zoom} fill={SNAP_COLOR} />
        </Group>
      )}
    </Group>
  );
}
