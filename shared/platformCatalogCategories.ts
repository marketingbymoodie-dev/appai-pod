/** Operator-assigned niche category stored on platform_catalog_blueprints.category */
export const PLATFORM_CATALOG_CATEGORIES = [
  { value: "phone-cases", label: "Phone cases" },
  { value: "apparel", label: "Apparel" },
  { value: "mugs", label: "Mugs & drinkware" },
  { value: "home-living", label: "Home & living" },
  { value: "accessories", label: "Accessories" },
  { value: "posters", label: "Posters & wall art" },
  { value: "other", label: "Other" },
] as const;

export type PlatformCatalogCategory = (typeof PLATFORM_CATALOG_CATEGORIES)[number]["value"];

export function platformCatalogCategoryLabel(value: string | null | undefined): string {
  if (!value) return "";
  return PLATFORM_CATALOG_CATEGORIES.find((c) => c.value === value)?.label ?? value;
}
