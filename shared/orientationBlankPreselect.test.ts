import { describe, expect, it } from "vitest";
import {
  applyOrientationBlankSelection,
  curatedPlaceholderUrls,
  merchantPlaceholdersAreSparse,
  neededOrientationsFromSizes,
  selectOrientationBlankUrls,
} from "./orientationBlankPreselect";

describe("orientationBlankPreselect", () => {
  it("detects sparse curation", () => {
    expect(merchantPlaceholdersAreSparse({ primary: "a.jpg", gallery: ["a.jpg"] })).toBe(
      true,
    );
    expect(
      merchantPlaceholdersAreSparse({
        primary: "a.jpg",
        gallery: ["b.jpg"],
      }),
    ).toBe(false);
    expect(curatedPlaceholderUrls({ primary: "a.jpg", gallery: ["a.jpg", "b.jpg"] })).toEqual([
      "a.jpg",
      "b.jpg",
    ]);
  });

  it("needs multiple orientations from size catalog", () => {
    const needed = neededOrientationsFromSizes([
      { id: "18x24", name: '18" x 24"', width: 18, height: 24 },
      { id: "24x18", name: '24" x 18"', width: 24, height: 18 },
      { id: "88x88", name: '88" x 88"', width: 88, height: 88 },
    ]);
    expect(needed).toContain("horizontal");
    expect(needed).toContain("vertical");
    expect(needed).toContain("square");
  });

  it("selects primary vertical and gallery for other orientations", () => {
    const selection = selectOrientationBlankUrls(
      [
        { url: "h.jpg", orientation: "horizontal" },
        { url: "v.jpg", orientation: "vertical" },
        { url: "s.jpg", orientation: "square" },
      ],
      ["horizontal", "vertical", "square"],
    );
    expect(selection).toEqual({
      primary: "v.jpg",
      gallery: ["h.jpg", "s.jpg"],
    });
  });

  it("applies selection onto baseMockupImages", () => {
    const next = applyOrientationBlankSelection(
      { available: [{ url: "v.jpg" }, { url: "h.jpg" }], gallery: [] },
      { primary: "v.jpg", gallery: ["h.jpg"] },
    );
    expect(next.primary).toBe("v.jpg");
    expect(next.front).toBe("v.jpg");
    expect(next.gallery).toEqual(["h.jpg"]);
    expect(next.orientationBlanksAutoSelected).toBe(true);
  });
});
