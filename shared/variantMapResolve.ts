export type VariantMapEntry = {
  printifyVariantId?: number | string;
  providerId?: number | string;
};

export type VariantMap = Record<string, VariantMapEntry>;

/** Build the canonical `{sizeId}:{colorId}` lookup key. */
export function variantMapKey(sizeId: string | undefined | null, colorId: string | undefined | null): string {
  return `${sizeId || "default"}:${colorId || "default"}`;
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
 * Resolve a Printify variant for mockup / fulfillment.
 * Does not fall back to a different color when `colorId` is explicit — that
 * produced wrong-garment mockups (e.g. Red selected, grey shirt shown).
 */
export function resolveVariantFromMap(
  variantMap: VariantMap | null | undefined,
  sizeId: string | undefined | null,
  colorId: string | undefined | null,
): { entry: VariantMapEntry; key: string } | null {
  if (!variantMap) return null;
  const size = sizeId || "default";
  const color = colorId || "default";

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

  return null;
}
