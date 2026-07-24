import { describe, expect, it } from "vitest";
import {
  aspectRatioFromFlatCalibration,
  normalizeStandardApparelAspectRatio,
} from "./apparelAspectRatio";

describe("apparelAspectRatio — DTG chest generation", () => {
  it("swaps landscape stored ratios to portrait", () => {
    expect(normalizeStandardApparelAspectRatio("4:3")).toBe("3:4");
    expect(normalizeStandardApparelAspectRatio("3:2")).toBe("2:3");
  });

  it("uses flatCalibration visibleRect (dashed guide) over printFileDims", () => {
    // Portrait dashed box on mockup (taller than wide).
    expect(
      aspectRatioFromFlatCalibration({
        views: {
          front: {
            visibleRectNormalized: { x: 0.3, y: 0.2, width: 0.3, height: 0.45 },
            printFileDims: { width: 4500, height: 4500 },
          },
        },
      }),
    ).toBe("2:3");
  });

  it("falls back to printFileDims when no visible rect", () => {
    expect(
      aspectRatioFromFlatCalibration({
        views: { front: { printFileDims: { width: 4500, height: 5400 } } },
      }),
    ).toBe("5:6");
    expect(
      aspectRatioFromFlatCalibration({
        views: { front: { printFileDims: { width: 5400, height: 4500 } } },
      }),
    ).toBe("5:6");
    expect(aspectRatioFromFlatCalibration(null)).toBeNull();
  });
});
