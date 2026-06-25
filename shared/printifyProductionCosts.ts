/** Parse Printify variant cost in cents from catalog or shop product payloads. */
export function extractPrintifyVariantCostCents(variant: unknown): number | undefined {
  if (!variant || typeof variant !== "object") return undefined;
  const v = variant as Record<string, unknown>;
  const variantId = v.id ?? v.variant_id;
  if (variantId == null) return undefined;

  const direct = v.cost;
  if (typeof direct === "number" && Number.isFinite(direct)) return Math.round(direct);
  if (typeof direct === "string" && direct.trim()) {
    const n = Number(direct);
    if (Number.isFinite(n)) return Math.round(n);
  }

  const priceTag = (v.priceTag ?? v.price_tag) as Record<string, unknown> | undefined;
  if (priceTag && priceTag.cost != null) {
    const tagCost = priceTag.cost;
    if (typeof tagCost === "number" && Number.isFinite(tagCost)) return Math.round(tagCost);
    if (typeof tagCost === "string" && tagCost.trim()) {
      const n = Number(tagCost);
      if (Number.isFinite(n)) return Math.round(n);
    }
  }

  return undefined;
}

/** Build printifyVariantId → cost (cents) from catalog variants.json entries. */
export function extractCostsFromCatalogVariants(variants: unknown[]): Record<string, number> {
  const costs: Record<string, number> = {};
  for (const variant of variants) {
    if (!variant || typeof variant !== "object") continue;
    const v = variant as Record<string, unknown>;
    const variantId = v.id ?? v.variant_id;
    if (variantId == null) continue;
    const cost = extractPrintifyVariantCostCents(variant);
    if (cost != null) costs[String(variantId)] = cost;
  }
  return costs;
}

/** Build printifyVariantId → cost (cents) from a shop product payload. */
export function extractCostsFromPrintifyProduct(product: unknown): Record<string, number> {
  const costs: Record<string, number> = {};
  const variants = (product as { variants?: unknown[] } | null)?.variants;
  if (!Array.isArray(variants)) return costs;
  for (const variant of variants) {
    const v = variant as Record<string, unknown>;
    const variantId = v?.id;
    if (variantId == null) continue;
    const cost = extractPrintifyVariantCostCents(variant);
    if (cost != null) costs[String(variantId)] = cost;
  }
  return costs;
}

export function serializePrintifyCostsCache(costs: Record<string, number>): string {
  return JSON.stringify({ ...costs, _fetchedAt: new Date().toISOString() });
}

/** Keep only costs for Printify variant IDs in the active variantMap. */
export function filterCostsToPrintifyVariantIds(
  costs: Record<string, number>,
  variantIds: Iterable<number>,
): Record<string, number> {
  const idSet = new Set([...variantIds].map(Number).filter((id) => Number.isFinite(id) && id > 0));
  if (idSet.size === 0) return { ...costs };
  const filtered: Record<string, number> = {};
  for (const [key, value] of Object.entries(costs)) {
    if (idSet.has(Number(key))) filtered[key] = value;
  }
  return filtered;
}

/** True when at least one active variant has a cached production cost. */
export function cacheCoversVariantIds(
  costs: Record<string, number>,
  variantIds: Iterable<number>,
): boolean {
  const keys = Object.keys(costs);
  if (keys.length === 0) return false;
  const idSet = new Set([...variantIds].map(Number).filter((id) => Number.isFinite(id) && id > 0));
  if (idSet.size === 0) return true;
  for (const id of idSet) {
    if (costs[String(id)] != null) return true;
  }
  return false;
}

export function parsePrintifyCostsCache(raw: string | null | undefined): {
  costs: Record<string, number>;
  fetchedAt: string | null;
} {
  const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
  const { _fetchedAt, ...rest } = parsed;
  const costs: Record<string, number> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (key === "_fetchedAt") continue;
    if (typeof value === "number" && Number.isFinite(value)) costs[key] = value;
  }
  return {
    costs,
    fetchedAt: typeof _fetchedAt === "string" ? _fetchedAt : null,
  };
}
