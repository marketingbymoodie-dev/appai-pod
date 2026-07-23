/**
 * Printify mockup camera_label helpers shared by server poll + client Lifestyle merge.
 */

export function normalizeMockupCameraLabel(raw: string): string {
  const s = String(raw || "")
    .replace(/\+/g, " ")
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  try {
    return decodeURIComponent(s).trim().toLowerCase();
  } catch {
    return s.trim().toLowerCase();
  }
}

/** Printify tote/lifestyle "On Person" camera (bag on shoulder). */
export function isOnPersonMockupLabel(label: string): boolean {
  const n = normalizeMockupCameraLabel(label);
  if (!n) return false;
  if (/\b(front|back|side)\s+person\b/.test(n)) return false;
  return /\bon\s*person\b/.test(n);
}

/** Printify "Context 1" flatlay — prefer On Person / Context 2 for Lifestyle Shot. */
export function isContext1MockupLabel(label: string): boolean {
  const n = normalizeMockupCameraLabel(label);
  return n === "context1" || /^context\s*1\b/.test(n);
}

/**
 * True when a Printify camera_label looks like a room/lifestyle/context shot.
 * Includes Printify UI names like "Context 2" and "On Person".
 * Do NOT treat flatlay "front side" / "side person" as context.
 */
export function isContextLikeMockupLabel(label: string): boolean {
  const n = normalizeMockupCameraLabel(label);
  if (!n || n === "front" || n === "back" || n === "mockup 1" || n === "mockup 2") {
    return false;
  }
  // Flatlay / crop angles — not lifestyle.
  if (/\b(front|back)\s*side\b/.test(n)) return false;
  if (/\bside\s*person\b/.test(n)) return false;
  if (/\bfront\s*person\b/.test(n)) return false;

  if (/(lifestyle|context|room|home|bedroom|\bwall\b)/.test(n)) return true;
  // Printify tote UI: "On Person" (bag on shoulder) — camera_label on+person / on-person.
  if (isOnPersonMockupLabel(label)) return true;
  return false;
}

/**
 * Lower = better for Lifestyle Shot. Tote Context 1 is a table flatlay — demote
 * it when On Person / Context 2 exist.
 */
export function lifestyleMockupPreferenceRank(label: string): number {
  if (isOnPersonMockupLabel(label)) return 0;
  const n = normalizeMockupCameraLabel(label);
  if (n === "lifestyle" || n.startsWith("lifestyle ")) return 1;
  if (n === "context2" || /^context\s*2\b/.test(n)) return 2;
  if (isContext1MockupLabel(label)) return 50;
  if (/context/.test(n)) return 10;
  if (/(room|home|bedroom|\bwall\b)/.test(n)) return 15;
  return 40;
}

/**
 * Flat cover-scale → Printify placement scale for Lifestyle Shot.
 * Printify's print-area scale reads slightly larger than FlatProductPlacer cover
 * on tote/flat blanks; damp so Context matches the in-app Artwork slide.
 */
export const FLAT_LIFESTYLE_PRINTIFY_SCALE_FACTOR = 0.9;
