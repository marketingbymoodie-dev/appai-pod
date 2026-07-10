import { describe, expect, it } from "vitest";
import {
  extractDimensionalKey,
  frameColorsRedundantWithSizes,
  resolveFrameColorForSize,
  resolveSizeAspectRatio,
} from "./productVariantOptions";

describe("productVariantOptions", () => {
  it("extractDimensionalKey parses inch dimensions", () => {
    expect(extractDimensionalKey('26" x 36"')).toBe("26x36");
    expect(extractDimensionalKey("36x26")).toBe("36x26");
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
});
