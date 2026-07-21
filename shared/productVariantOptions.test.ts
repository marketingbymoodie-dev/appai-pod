import { describe, expect, it } from "vitest";
import {
  extractDimensionalKey,
  filterSizesByCanvasOrientation,
  frameColorsRedundantWithSizes,
  isLandscapeSizeAspect,
  isOrientationSizeProduct,
  parseCanvasOrientationFromLabel,
  pickSizeForCanvasOrientation,
  resolveFrameColorForSize,
  resolveSizeAspectRatio,
  sizesHaveMixedCanvasOrientation,
  looksLikePhoneModelName,
  sizeIdLooksLandscape,
  sizesLookLikePhoneModels,
  sortDimensionalSizesAscending,
  styleChoicesIncludeCanvasOrientation,
} from "./productVariantOptions";

describe("productVariantOptions", () => {
  it("extractDimensionalKey parses inch dimensions", () => {
    expect(extractDimensionalKey('26" x 36"')).toBe("26x36");
    expect(extractDimensionalKey("36x26")).toBe("36x26");
    expect(extractDimensionalKey("26''_×_36''")).toBe("26x36");
    expect(extractDimensionalKey("36''_×_26''")).toBe("36x26");
    expect(extractDimensionalKey("104''_x_88\"")).toBe("104x88");
  });

  it("sizeIdLooksLandscape detects WxH orientation", () => {
    expect(sizeIdLooksLandscape("36x24")).toBe(true);
    expect(sizeIdLooksLandscape('20" x 16"')).toBe(true);
    expect(sizeIdLooksLandscape("16x20")).toBe(false);
    expect(sizeIdLooksLandscape("m")).toBe(false);
  });

  it("detects phone model size lists", () => {
    expect(looksLikePhoneModelName("iPhone 13")).toBe(true);
    expect(looksLikePhoneModelName("Galaxy S23")).toBe(true);
    expect(looksLikePhoneModelName("Model")).toBe(false);
    expect(
      sizesLookLikePhoneModels([
        { id: "iphone-13", name: "iPhone 13" },
        { id: "iphone-14", name: "iPhone 14" },
        { id: "iphone-15-pro", name: "iPhone 15 Pro" },
      ]),
    ).toBe(true);
  });

  it("sortDimensionalSizesAscending orders by first number then second", () => {
    const sizes = [
      { id: "14x11", name: '14" x 11"', width: 14, height: 11 },
      { id: "18x12", name: '18" x 12"', width: 18, height: 12 },
      { id: "24x18", name: '24" x 18"', width: 24, height: 18 },
      { id: "36x24", name: '36" x 24"', width: 36, height: 24 },
      { id: "11x8", name: '11" x 8"', width: 11, height: 8 },
      { id: "20x16", name: '20" x 16"', width: 20, height: 16 },
      { id: "30x20", name: '30" x 20"', width: 30, height: 20 },
    ];
    expect(sortDimensionalSizesAscending(sizes).map((s) => s.id)).toEqual([
      "11x8",
      "14x11",
      "18x12",
      "20x16",
      "24x18",
      "30x20",
      "36x24",
    ]);
  });

  it("resolveSizeAspectRatio from Shopify-style size id when width/height missing", () => {
    expect(
      resolveSizeAspectRatio({ id: "36''_×_26''", name: "36'' × 26''", width: 0, height: 0 }),
    ).toBe("18:13");
    expect(
      resolveSizeAspectRatio({ id: "26''_×_36''", name: "26'' × 36''", width: 0, height: 0 }),
    ).toBe("13:18");
  });

  it("detects redundant OPTION when ids use Shopify inch encoding", () => {
    const sizes = [
      { id: "26''_×_36''", name: "26'' × 36''", width: 0, height: 0 },
      { id: "36''_×_26''", name: "36'' × 26''", width: 0, height: 0 },
    ];
    const frameColors = [
      { id: "26''_×_36''", name: "26'' × 36''" },
      { id: "36''_×_26''", name: "36'' × 26''" },
    ];
    expect(frameColorsRedundantWithSizes(sizes, frameColors, "Option")).toBe(true);
  });

  it("detects tapestry-style redundant option dimension", () => {
    const sizes = [
      { id: "26x36", name: '26" x 36"', width: 26, height: 36 },
      { id: "36x26", name: '36" x 26"', width: 36, height: 26 },
    ];
    const frameColors = [
      { id: "26x36", name: '26" x 36"' },
      { id: "36x26", name: '36" x 26"' },
    ];
    expect(frameColorsRedundantWithSizes(sizes, frameColors, "Option")).toBe(true);
  });

  it("keeps real color options visible", () => {
    const sizes = [{ id: "68x88", name: '68" x 88"', width: 68, height: 88 }];
    const frameColors = [
      { id: "white", name: "White" },
      { id: "navy", name: "Navy" },
    ];
    expect(frameColorsRedundantWithSizes(sizes, frameColors, "Color")).toBe(false);
  });

  it("resolveSizeAspectRatio uses width/height", () => {
    expect(resolveSizeAspectRatio({ id: "88x88", name: "88x88", width: 88, height: 88 })).toBe(
      "1:1",
    );
    expect(resolveSizeAspectRatio({ id: "104x88", name: "104x88", width: 104, height: 88 })).toBe(
      "13:11",
    );
  });

  it("resolveFrameColorForSize matches orientation", () => {
    const sizes = [{ id: "26x36", name: '26" x 36"', width: 26, height: 36 }];
    const frameColors = [
      { id: "26x36", name: '26" x 36"' },
      { id: "36x26", name: '36" x 26"' },
    ];
    expect(resolveFrameColorForSize(sizes[0], frameColors)).toBe("26x36");
  });

  it("isOrientationSizeProduct detects tapestry-style sizes", () => {
    const sizes = [
      { id: "26''_×_36''", name: "26'' × 36''", width: 0, height: 0 },
      { id: "36''_×_26''", name: "36'' × 26''", width: 0, height: 0 },
    ];
    const frameColors = [
      { id: "26''_×_36''", name: "26'' × 36''" },
      { id: "36''_×_26''", name: "36'' × 26''" },
    ];
    expect(isOrientationSizeProduct(sizes, frameColors, "Option")).toBe(true);
    expect(isLandscapeSizeAspect("18:13")).toBe(true);
  });

  it("prefers size label dims over swapped width/height fields", () => {
    expect(
      resolveSizeAspectRatio({
        id: "24''_×_18''",
        name: '24" x 18"',
        width: 18,
        height: 24,
      }),
    ).toBe("4:3");
  });

  it("parses orientation labels and picks swapped comforter sizes", () => {
    expect(parseCanvasOrientationFromLabel("Horizontal")).toBe("horizontal");
    expect(parseCanvasOrientationFromLabel("vertical")).toBe("vertical");
    expect(parseCanvasOrientationFromLabel("Square")).toBe("square");
    expect(parseCanvasOrientationFromLabel("Pet")).toBe(null);
    expect(
      styleChoicesIncludeCanvasOrientation([
        { id: "h", name: "Horizontal" },
        { id: "v", name: "Vertical" },
      ]),
    ).toBe(true);

    const sizes = [
      { id: "68x88", name: '68" x 88"', width: 68, height: 88 },
      { id: "88x68", name: '88" x 68"', width: 88, height: 68 },
      { id: "104x88", name: '104" x 88"', width: 104, height: 88 },
      { id: "88x88", name: '88" x 88"', width: 88, height: 88 },
    ];
    expect(sizesHaveMixedCanvasOrientation(sizes)).toBe(true);
    expect(pickSizeForCanvasOrientation(sizes, "horizontal", "68x88")?.id).toBe("88x68");
    expect(pickSizeForCanvasOrientation(sizes, "vertical", "88x68")?.id).toBe("68x88");
    expect(pickSizeForCanvasOrientation(sizes, "horizontal", "104x88")?.id).toBe("104x88");
    expect(pickSizeForCanvasOrientation(sizes, "square", "68x88")?.id).toBe("88x88");
    expect(
      filterSizesByCanvasOrientation(sizes, "vertical").map((s) => s.id),
    ).toEqual(["68x88"]);
    expect(
      filterSizesByCanvasOrientation(sizes, "horizontal").map((s) => s.id),
    ).toEqual(["88x68", "104x88"]);
  });
});
