import { describe, expect, it } from "vitest";
import {
  filterStylePresetsForPage,
  parseCustomizerPageStyleConfig,
} from "./customizerPageStyles";
import {
  selectableCategoriesForDesignerType,
  styleMatchesSelectableCategories,
} from "./styleCategories";

describe("selectableCategoriesForDesignerType", () => {
  it("offers decor + graphics for pillow products", () => {
    expect(selectableCategoriesForDesignerType("pillow")).toEqual(["decor", "graphics"]);
  });

  it("offers apparel only for apparel products", () => {
    expect(selectableCategoriesForDesignerType("apparel")).toEqual(["apparel"]);
  });

  it("offers all categories for generic products", () => {
    expect(selectableCategoriesForDesignerType("generic")).toBe("all");
  });
});

describe("styleMatchesSelectableCategories", () => {
  const presets = [
    { id: "1", name: "Watercolor", category: "decor" },
    { id: "2", name: "Centered Graphic (Graphics)", category: "graphics" },
    { id: "3", name: "Quotes", category: "apparel" },
  ];

  it("includes decor and graphics for pillow selectable set", () => {
    const selectable = selectableCategoriesForDesignerType("pillow");
    const matched = presets.filter((p) => styleMatchesSelectableCategories(p, selectable));
    expect(matched.map((p) => p.category)).toEqual(["decor", "graphics"]);
  });
});

describe("filterStylePresetsForPage", () => {
  const presets = [
    { id: "w", name: "Watercolor", category: "decor" },
    { id: "g", name: "Motif", category: "graphics" },
    { id: "a", name: "Quotes", category: "apparel" },
  ];

  it("parses graphics category bundle", () => {
    const cfg = parseCustomizerPageStyleConfig({ mode: "category", category: "graphics" });
    expect(cfg).toEqual({ mode: "category", category: "graphics" });
    expect(filterStylePresetsForPage(presets, cfg)).toEqual([presets[1]]);
  });
});
