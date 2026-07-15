import { describe, expect, it } from "vitest";
import {
  computePreviewMeshTileStretch,
  computeTilePxOnFlatCanvas,
} from "./aopTileScale";

describe("computeTilePxOnFlatCanvas", () => {
  it("scales mockup inches into print canvas pixels via mesh target width", () => {
    // 2" tile at 42.67 mockup px/in, flat canvas 4500px wide, mesh spans 500 mockup px
    const tilePx = computeTilePxOnFlatCanvas({
      tileSizeInches: 2,
      pixelsPerInch: 1024 / 24,
      flatCanvasW: 4500,
      meshTargetWidth: 500,
    });
    // tilePxMockup ≈ 85.33, mockupToFlatScale = 9, → ≈ 768
    expect(tilePx).toBeCloseTo(85.33 * 9, 0);
  });

  it("uses same formula for print and preview when no overscan compensation", () => {
    const base = {
      tileSizeInches: 4.2,
      pixelsPerInch: 1024 / 24,
      flatCanvasW: 3200,
      meshTargetWidth: 400,
      visiblePolyWidth: 400,
    };
    const printPx = computeTilePxOnFlatCanvas({ ...base, meshOverscanCompensation: false });
    const previewPx = computeTilePxOnFlatCanvas({ ...base, meshOverscanCompensation: true });
    expect(printPx).toBeCloseTo(previewPx, 5);
  });

  it("preview-only stretch compensates mesh overscan", () => {
    const base = {
      tileSizeInches: 2,
      pixelsPerInch: 1024 / 24,
      flatCanvasW: 4500,
      meshTargetWidth: 500,
      visiblePolyWidth: 250,
    };
    const printPx = computeTilePxOnFlatCanvas({ ...base, meshOverscanCompensation: false });
    const previewPx = computeTilePxOnFlatCanvas({ ...base, meshOverscanCompensation: true });
    expect(previewPx).toBeCloseTo(printPx * 2, 0);
  });
});

describe("computePreviewMeshTileStretch", () => {
  it("returns 1 when mesh target matches polygon", () => {
    expect(computePreviewMeshTileStretch(400, 400)).toBe(1);
  });

  it("returns ratio when mesh overscans polygon", () => {
    expect(computePreviewMeshTileStretch(500, 250)).toBe(2);
  });
});
