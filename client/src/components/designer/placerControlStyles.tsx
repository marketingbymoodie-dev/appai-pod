/**
 * Theme-aware control styling for storefront customizer placers (AOP hoodie,
 * pattern step, flat placer). Uses CSS variables (`foreground` / `background`)
 * so selected states invert clearly on any merchant theme — not faint `primary`.
 */

/** Virtual part id — both sleeve design groups edited together. */
export const SLEEVES_PART_ID = "sleeves";

const SEGMENT_SELECTED =
  "bg-foreground text-background border-foreground";
const SEGMENT_UNSELECTED =
  "bg-background border-border text-muted-foreground hover:border-foreground/50";

/** Segmented pill / mode button (Pattern, Place, View, Part rows). */
export function placerSegmentClass(selected: boolean, extra = ""): string {
  const base = selected ? SEGMENT_SELECTED : SEGMENT_UNSELECTED;
  return `${base} transition-colors ${extra}`.trim();
}

/** Compact segment in a bordered grid (HoodieAopPlacer mode row). */
export function placerSegmentGridClass(selected: boolean, extra = ""): string {
  const base = selected
    ? "bg-foreground text-background"
    : "text-card-foreground hover:bg-muted";
  return `${base} transition ${extra}`.trim();
}

export function placerToggleTrackClass(checked: boolean): string {
  return checked ? "bg-foreground" : "bg-muted-foreground/30";
}

export function placerToggleKnobClass(checked: boolean): string {
  return checked ? "translate-x-4 bg-background" : "translate-x-0.5 bg-white";
}

type PlacerToggleProps = {
  checked: boolean;
  onChange: (on: boolean) => void;
  /** Accessible label, e.g. "Trim on artwork" */
  "aria-label"?: string;
};

/** ON/OFF switch — track inverts with theme foreground when checked. */
export function PlacerToggle({ checked, onChange, "aria-label": ariaLabel }: PlacerToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${placerToggleTrackClass(checked)}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full shadow transition ${placerToggleKnobClass(checked)}`}
      />
    </button>
  );
}
