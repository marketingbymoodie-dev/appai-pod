/**
 * Slug for Printify garment/frame colour ids — must match between import,
 * harvest blank keys, and storefront `selectedFrameColor`.
 */
export function slugPrintifyColorId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[\s/]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Normalized key for fuzzy blank lookup (slashes, underscores, spaces → hyphens). */
export function normalizePrintifyColorKey(id: string): string {
  return id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}
