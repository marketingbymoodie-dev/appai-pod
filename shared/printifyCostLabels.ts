/**
 * Normalize variant titles for Printify production-cost lookup.
 * Framed prints often differ by quote style / "X" vs "x" between Shopify and Printify.
 */
export function normalizeVariantLabelForCostMatch(label: string): string {
  return label
    .toLowerCase()
    .replace(/[""″‶‴''′‵]/g, "")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .replace(/\s*x\s*/g, "x")
    .trim();
}

/** Build normalized-label → cost (cents) from Printify id costs + id→label map. */
export function buildCostsByNormalizedLabel(
  costs: Record<string, number>,
  printifyVariantLabels: Record<string, string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [printifyVid, label] of Object.entries(printifyVariantLabels)) {
    const cost = costs[printifyVid];
    if (cost == null || !label) continue;
    out[normalizeVariantLabelForCostMatch(label)] = cost;
  }
  return out;
}
