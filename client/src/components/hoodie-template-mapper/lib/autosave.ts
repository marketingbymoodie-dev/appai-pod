import type { HoodieTemplate, HoodieToolId, HoodieView } from "@shared/hoodieTemplate";

/**
 * localStorage-backed autosave for the hoodie template mapper.
 *
 * The dev API does not persist a template until the user clicks Save, and
 * the in-memory Zustand store is wiped on page reload. To prevent a
 * repeat of the "spent 30 minutes tracing anchors and reloaded the page"
 * data loss, we mirror every dirty change to localStorage, and on next
 * page load offer to restore from the autosave snapshot.
 *
 * Stored value is intentionally small (one snapshot, latest-wins) — full
 * undo history is out of scope for phase 2.
 */

const KEY = "hoodie-mapper:autosave:v1";

export type AutosaveSnapshot = {
  template: HoodieTemplate;
  view: HoodieView;
  tool: HoodieToolId;
  /** ISO timestamp when this snapshot was written. */
  savedAt: string;
};

export function readAutosave(): AutosaveSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AutosaveSnapshot;
    if (!parsed?.template || typeof parsed.template !== "object") return null;
    if (typeof parsed.template.version !== "string" || !parsed.template.version.startsWith("hoodie-template/")) {
      return null;
    }
    return parsed;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[hoodie-mapper] autosave read failed", err);
    return null;
  }
}

export function writeAutosave(snap: AutosaveSnapshot): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(snap));
  } catch (err) {
    // QuotaExceededError most likely — large mockups would only ever be
    // referenced by URL, not embedded, so this should rarely happen.
    // eslint-disable-next-line no-console
    console.warn("[hoodie-mapper] autosave write failed", err);
  }
}

export function clearAutosave(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * True when the template carries any work the user would care about
 * recovering — at least one mask layer or an attached mockup.
 */
export function hasMeaningfulContent(tpl: HoodieTemplate): boolean {
  const front = tpl.views?.front;
  const back = tpl.views?.back;
  return (
    (front?.layers?.length ?? 0) > 0 ||
    (back?.layers?.length ?? 0) > 0 ||
    Boolean(front?.mockup) ||
    Boolean(back?.mockup)
  );
}

/** Human-friendly summary for the restore banner. */
export function summarizeSnapshot(snap: AutosaveSnapshot): string {
  const front = snap.template.views?.front;
  const back = snap.template.views?.back;
  const fl = front?.layers?.length ?? 0;
  const bl = back?.layers?.length ?? 0;
  const parts: string[] = [];
  if (fl > 0) parts.push(`${fl} front mask${fl === 1 ? "" : "s"}`);
  if (bl > 0) parts.push(`${bl} back mask${bl === 1 ? "" : "s"}`);
  if (parts.length === 0) {
    if (front?.mockup) parts.push("front mockup");
    if (back?.mockup) parts.push("back mockup");
  }
  return parts.length > 0 ? parts.join(", ") : "draft";
}
