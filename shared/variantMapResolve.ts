export type VariantMapEntry = {
  printifyVariantId?: number | string;
  providerId?: number | string;
};

export type VariantMap = Record<string, VariantMapEntry>;

/** Normalize a size or color id for case-insensitive map lookups. */
function normalizeId(id: string | undefined | null): string {
  if (!id || id === "default") return "default";
  return id.toLowerCase().trim();
}

/** Build the canonical `{sizeId}:{colorId}` lookup key (case-insensitive). */
export function variantMapKey(sizeId: string | undefined | null, colorId: string | undefined | null): string {
  return `${normalizeId(sizeId)}:${normalizeId(colorId)}`;
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
  const size = normalizeId(sizeId);
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
