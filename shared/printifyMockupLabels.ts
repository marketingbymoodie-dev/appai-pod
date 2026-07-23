/**
 * Printify mockup camera_label helpers shared by server poll + client Lifestyle merge.
 */

export function normalizeMockupCameraLabel(raw: string): string {
  const s = String(raw || "")
    .replace(/\+/g, " ")
    .replace(/_/g, " ")
    .trim();
  try {
    return decodeURIComponent(s).trim().toLowerCase();
  } catch {
    return s.trim().toLowerCase();
  }
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
  if (/\bon[\s-]*person\b/.test(n)) return true;
  return false;
}

/**
 * Flat cover-scale → Printify placement scale for Lifestyle Shot.
 * Printify's print-area scale reads slightly larger than FlatProductPlacer cover
 * on tote/flat blanks; damp so Context matches the in-app Artwork slide.
 */
export const FLAT_LIFESTYLE_PRINTIFY_SCALE_FACTOR = 0.9;
