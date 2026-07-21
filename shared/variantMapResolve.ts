export type VariantMapEntry = {
  printifyVariantId?: number | string;
  providerId?: number | string;
};

export type VariantMap = Record<string, VariantMapEntry>;

/** Normalize a color id for case-insensitive map lookups. */
function normalizeId(id: string | undefined | null): string {
  if (!id || id === "default") return "default";
  return id.toLowerCase().trim();
}

function normalizeSizeId(id: string | undefined | null): string {
  if (!id || id === "default") return "default";
  return normalizeApparelSizeId(id);
}

/** Canonical apparel size slug — keeps variantMap keys consistent across import paths. */
export function normalizeApparelSizeId(id: string): string {
  let s = id.toLowerCase().trim().replace(/\s+/g, "_");
  const aliases: Record<string, string> = {
    extra_large: "xl",
    "x-large": "xl",
    x_large: "xl",
    "xx-large": "2xl",
    xx_large: "2xl",
    xxlarge: "2xl",
    "xxx-large": "3xl",
    xxx_large: "3xl",
    "2_xl": "2xl",
    "3_xl": "3xl",
    "4_xl": "4xl",
    "5_xl": "5xl",
    xxl: "2xl",
    xxxl: "3xl",
    small: "s",
    medium: "m",
    large: "l",
  };
  return aliases[s] ?? s;
}

/** Build the canonical `{sizeId}:{colorId}` lookup key (case-insensitive). */
export function variantMapKey(sizeId: string | undefined | null, colorId: string | undefined | null): string {
  return `${normalizeSizeId(sizeId)}:${normalizeId(colorId)}`;
}

/** True when an exact size+color Printify variant exists in the map. */
export function hasExactVariantMapping(
  variantMap: VariantMap | null | undefined,
  sizeId: string | undefined | null,
  colorId: string | undefined | null,
): boolean {
  if (!variantMap) return false;
  const entry = variantMap[variantMapKey(sizeId, colorId)];
  return entry?.printifyVariantId != null && entry.printifyVariantId !== "";
}

/**
 * True when the given color appears in the variant map for ANY size.
 * Used for UI availability checks so a color isn't hidden just because the
 * currently-selected size has no mapping (e.g. XL+ sizes missing from import).
 */
export function hasVariantMappingForColor(
  variantMap: VariantMap | null | undefined,
  colorId: string | undefined | null,
): boolean {
  if (!variantMap || !colorId || colorId === "default") return false;
  const normColor = normalizeId(colorId);
  return Object.keys(variantMap).some((key) => {
    const [, kColor] = key.split(":");
    return kColor === normColor && (variantMap[key]?.printifyVariantId != null && variantMap[key]?.printifyVariantId !== "");
  });
}

export type ResolveVariantOptions = {
  /**
   * For mockup requests only: when the exact size+color key is missing, fall
   * back to the same color at any other size.  Garment mockup photos are
   * identical across sizes so this is safe for display; do NOT use for order
   * fulfillment where the size must be exact.
   */
  allowSizeFallbackForColor?: boolean;
};

/**
 * Resolve a Printify variant for mockup / fulfillment.
 * Does not fall back to a different color when `colorId` is explicit — that
 * produced wrong-garment mockups (e.g. Red selected, grey shirt shown).
 */
export function resolveVariantFromMap(
  variantMap: VariantMap | null | undefined,
  sizeId: string | undefined | null,
  colorId: string | undefined | null,
  opts?: ResolveVariantOptions,
): { entry: VariantMapEntry; key: string } | null {
  if (!variantMap) return null;
  const size = normalizeSizeId(sizeId);
  const color = normalizeId(colorId);

  const exact = variantMap[variantMapKey(size, color)];
  if (exact?.printifyVariantId != null && exact.printifyVariantId !== "") {
    return { entry: exact, key: variantMapKey(size, color) };
  }

  const wantsDefaultColor = !colorId || colorId === "default";
  if (wantsDefaultColor) {
    const sizeOnly = variantMap[variantMapKey(size, "default")];
    if (sizeOnly?.printifyVariantId != null && sizeOnly.printifyVariantId !== "") {
      return { entry: sizeOnly, key: variantMapKey(size, "default") };
    }
  }

  const wantsDefaultSize = !sizeId || sizeId === "default";
  if (wantsDefaultSize && color !== "default") {
    const colorOnly = variantMap[variantMapKey("default", color)];
    if (colorOnly?.printifyVariantId != null && colorOnly.printifyVariantId !== "") {
      return { entry: colorOnly, key: variantMapKey("default", color) };
    }
  }

  if (wantsDefaultSize && wantsDefaultColor) {
    const fallback = variantMap["default:default"];
    if (fallback?.printifyVariantId != null && fallback.printifyVariantId !== "") {
      return { entry: fallback, key: "default:default" };
    }
  }

  // Mockup-only: same color at any other size — garment photos are size-agnostic.
  if (opts?.allowSizeFallbackForColor && color !== "default") {
    for (const [key, entry] of Object.entries(variantMap)) {
      if (!entry?.printifyVariantId || entry.printifyVariantId === "") continue;
      const [, kColor] = key.split(":");
      if (kColor === color) {
        return { entry, key };
      }
    }
  }

  return null;
}

/**
 * First variantMap entry for this size (any colour). Phone cases key models as
 * size and often carry junk Model fragments as "colour" that never match.
 */
export function resolveVariantForSizeOnly(
  variantMap: VariantMap | null | undefined,
  sizeId: string | undefined | null,
): { entry: VariantMapEntry; key: string } | null {
  if (!variantMap) return null;
  const size = normalizeSizeId(sizeId);
  if (size === "default") return null;
  for (const [key, entry] of Object.entries(variantMap)) {
    if (entry?.printifyVariantId == null || entry.printifyVariantId === "") continue;
    const [sz] = key.split(":");
    if (normalizeSizeId(sz) === size) {
      return { entry, key };
    }
  }
  return null;
}

export const SHOPIFY_MAX_VARIANTS_PER_PRODUCT = 100;

/** Count variantMap entries that match the merchant's selected size/color filters. */
export function countActiveVariantMapKeys(
  variantMap: VariantMap | Record<string, VariantMapEntry> | null | undefined,
  selectedSizeIds?: string[] | null,
  selectedColorIds?: string[] | null,
): number {
  if (!variantMap) return 0;
  const sizeSet = selectedSizeIds?.length
    ? new Set(selectedSizeIds.map((id) => normalizeSizeId(id)))
    : null;
  const colorSet = selectedColorIds?.length
    ? new Set(selectedColorIds.map((id) => normalizeId(id)))
    : null;
  let count = 0;
  for (const key of Object.keys(variantMap)) {
    const [sizeId, colorId = "default"] = key.split(":");
    if (sizeSet && !sizeSet.has(normalizeSizeId(sizeId))) continue;
    if (colorSet && !colorSet.has(normalizeId(colorId))) continue;
    count++;
  }
  return count;
}
