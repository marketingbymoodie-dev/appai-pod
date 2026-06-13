/** Slug segment for Printify catalog URLs (provider or product title). */
export function slugifyPrintifySegment(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Printify catalog search (reliable when provider slug unknown). */
export function printifyCatalogSearchUrl(searchKey: string): string {
  return `https://printify.com/app/products/search-catalog?searchKey=${encodeURIComponent(searchKey.trim())}`;
}

/**
 * Printify catalog product page when print provider is known, e.g.
 * https://printify.com/app/products/2692/orca-coatings/accent-rim-and-handle-mug-11oz-15oz
 */
export function printifyCatalogProductUrl(args: {
  blueprintId: number;
  productTitle: string;
  /** Print provider title (NOT garment brand like "Bella+Canvas"). */
  providerTitle?: string | null;
}): string {
  const productSlug = slugifyPrintifySegment(args.productTitle) || String(args.blueprintId);
  if (args.providerTitle?.trim()) {
    const providerSlug = slugifyPrintifySegment(args.providerTitle);
    if (providerSlug) {
      return `https://printify.com/app/products/${args.blueprintId}/${providerSlug}/${productSlug}`;
    }
  }
  return printifyCatalogSearchUrl(String(args.blueprintId));
}
