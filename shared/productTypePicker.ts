/** Minimal fields needed to dedupe product-type picker rows. */
export type ProductTypePickerRow = {
  id: number;
  name: string;
  sortOrder?: number | null;
  printifyBlueprintId?: number | null;
  printifyProviderId?: number | null;
};

/**
 * Collapse duplicate catalog rows in admin pickers (e.g. Generator Tester).
 * Legacy imports may have the same Printify blueprint twice; cross-tenant leaks
 * from the old public /api/product-types list showed other merchants' copies too.
 * Keeps the highest id (most recent) per blueprint+provider key.
 */
export function dedupeProductTypesForPicker<T extends ProductTypePickerRow>(types: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const pt of types) {
    const key =
      pt.printifyBlueprintId != null
        ? `bp:${pt.printifyBlueprintId}:prov:${pt.printifyProviderId ?? 0}`
        : `id:${pt.id}`;
    const prev = byKey.get(key);
    if (!prev || pt.id > prev.id) byKey.set(key, pt);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
      String(a.name || "").localeCompare(String(b.name || "")) ||
      a.id - b.id,
  );
}
