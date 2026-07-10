/**
 * Art style preset categories and designer-type → selectable category mapping.
 */

export type StylePresetCategory = "decor" | "apparel" | "graphics" | "all";

/** Categories available as customizer-page bundles (same values as preset categories). */
export type CustomizerPageStyleCategory = StylePresetCategory;

const DECOR_PRODUCT_TYPES = new Set(["pillow", "framed-print", "mug"]);
const APPAREL_PRODUCT_TYPES = new Set(["apparel", "all-over-print"]);

/**
 * Which preset categories appear in the admin "choose specific styles" picker
 * and in storefront fallbacks when no page styleConfig is set.
 */
export function selectableCategoriesForDesignerType(
  designerType?: string | null,
): StylePresetCategory[] | "all" {
  const dt = (designerType || "").toLowerCase();
  if (APPAREL_PRODUCT_TYPES.has(dt)) return ["apparel"];
  if (DECOR_PRODUCT_TYPES.has(dt)) return ["decor", "graphics"];
  return "all";
}

export function styleMatchesSelectableCategories(
  style: { category?: string | null },
  selectable: StylePresetCategory[] | "all",
): boolean {
  if (selectable === "all") return true;
  const cat = (style.category || "all").toLowerCase();
  if (cat === "all" || !cat) return true;
  return selectable.includes(cat as StylePresetCategory);
}

export function isValidStylePresetCategory(value: string): value is StylePresetCategory {
  return value === "decor" || value === "apparel" || value === "graphics" || value === "all";
}

/** All page-level category bundle options (for admin selector buttons). */
export const CUSTOMIZER_PAGE_CATEGORY_OPTIONS: readonly CustomizerPageStyleCategory[] = [
  "decor",
  "apparel",
  "graphics",
  "all",
] as const;

export const STYLE_PRESET_CATEGORY_LABELS: Record<StylePresetCategory, string> = {
  decor: "Decor",
  apparel: "Apparel",
  graphics: "Graphics",
  all: "All styles",
};

export const CUSTOMIZER_PAGE_CATEGORY_LABELS: Record<CustomizerPageStyleCategory, string> = {
  decor: "All Decor styles",
  apparel: "All Apparel styles",
  graphics: "All Graphics styles",
  all: "All styles",
};
