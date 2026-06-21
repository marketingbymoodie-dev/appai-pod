import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
} from "lucide-react";

/** One nudge click ≈ this many CSS pixels on screen (converted per placer). */
export const PLACEMENT_NUDGE_SCREEN_PX = 2;

export function mockupDeltaFromScreenNudge(
  axis: "x" | "y",
  direction: 1 | -1,
  canvasRect: DOMRect,
  mockupWidth: number,
  mockupHeight: number,
): number {
  const delta =
    axis === "x"
      ? (PLACEMENT_NUDGE_SCREEN_PX / Math.max(1, canvasRect.width)) * mockupWidth
      : (PLACEMENT_NUDGE_SCREEN_PX / Math.max(1, canvasRect.height)) * mockupHeight;
  return delta * direction;
}

export function NudgeButton({
  children,
  label,
  direction,
  onPress,
}: {
  children: React.ReactNode;
  label: string;
  direction: 1 | -1;
  onPress: (direction: 1 | -1) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label} (right-click: opposite)`}
      className="inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={(e) => {
        e.stopPropagation();
        onPress(direction);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onPress((-direction) as 1 | -1);
      }}
    >
      {children}
    </button>
  );
}

type FinePositionNudgeProps = {
  onNudge: (axis: "x" | "y", direction: 1 | -1) => void;
  hint?: string;
  className?: string;
};

/** Shared ↑←→↓ fine-position controls for flat-lay and AOP placers. */
export function FinePositionNudge({
  onNudge,
  hint = "Drag the artwork box to move freely. Right-click a nudge arrow for the opposite direction.",
  className,
}: FinePositionNudgeProps) {
  return (
    <div className={className}>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Fine position
      </div>
      <div className="flex flex-col items-center gap-1">
        <NudgeButton label="Nudge up" direction={-1} onPress={(dir) => onNudge("y", dir)}>
          <ChevronUp className="h-3.5 w-3.5" />
        </NudgeButton>
        <div className="flex items-center gap-1">
          <NudgeButton label="Nudge left" direction={-1} onPress={(dir) => onNudge("x", dir)}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </NudgeButton>
          <NudgeButton label="Nudge right" direction={1} onPress={(dir) => onNudge("x", dir)}>
            <ChevronRight className="h-3.5 w-3.5" />
          </NudgeButton>
        </div>
        <NudgeButton label="Nudge down" direction={1} onPress={(dir) => onNudge("y", dir)}>
          <ChevronDown className="h-3.5 w-3.5" />
        </NudgeButton>
      </div>
      {hint ? (
        <p className="mt-1 text-[10px] text-muted-foreground leading-snug">{hint}</p>
      ) : null}
    </div>
  );
}

/** Compact row of nudge arrows — sits directly under the mockup preview. */
export function FinePositionNudgeInline({
  onNudge,
  className,
  label = "Nudge Artwork",
}: {
  onNudge: (axis: "x" | "y", direction: 1 | -1) => void;
  className?: string;
  label?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="flex items-center justify-center gap-1">
        <NudgeButton label="Nudge left" direction={-1} onPress={(dir) => onNudge("x", dir)}>
          <ChevronLeft className="h-3.5 w-3.5" />
        </NudgeButton>
        <NudgeButton label="Nudge up" direction={-1} onPress={(dir) => onNudge("y", dir)}>
          <ChevronUp className="h-3.5 w-3.5" />
        </NudgeButton>
        <NudgeButton label="Nudge down" direction={1} onPress={(dir) => onNudge("y", dir)}>
          <ChevronDown className="h-3.5 w-3.5" />
        </NudgeButton>
        <NudgeButton label="Nudge right" direction={1} onPress={(dir) => onNudge("x", dir)}>
          <ChevronRight className="h-3.5 w-3.5" />
        </NudgeButton>
      </div>
    </div>
  );
}
