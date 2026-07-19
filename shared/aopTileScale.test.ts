import { describe, expect, it } from "vitest";
import {
  computePreviewMeshTileStretch,
  computeTilePxOnFlatCanvas,
  patternModeFrontBodyTileScale,
  patternModeUniformTileScale,
  usesBomberUniformPatternTileScale,
  referenceMockupToFlatScale,
  usesFrontMatchedBodyPatternTileScale,
  usesPerPanelPatternTileScale,
} from "./aopTileScale";

describe("computeTilePxOnFlatCanvas", () => {
  it("scales mockup inches into print canvas pixels via mesh target width", () => {
    const tilePx = computeTilePxOnFlatCanvas({
      tileSizeInches: 2,
      pixelsPerInch: 1024 / 24,
      flatCanvasW: 4500,
      meshTargetWidth: 500,
    });
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

  it("ignores overscan compensation when garment-wide scale override is set", () => {
    const base = {
      tileSizeInches: 2,
      pixelsPerInch: 1024 / 24,
      flatCanvasW: 4500,
      meshTargetWidth: 500,
      visiblePolyWidth: 250,
      meshOverscanCompensation: true,
      mockupToFlatScaleOverride: 9,
    };
    expect(computeTilePxOnFlatCanvas(base)).toBeCloseTo(85.33 * 9, 0);
  });

  it("applies a fixed override the same way regardless of flat width", () => {
    const override = 8.4;
    const base = {
      tileSizeInches: 1.5,
      pixelsPerInch: 1024 / 24,
      meshTargetWidth: 500,
      outputScale: 1,
      mockupToFlatScaleOverride: override,
    };
    const chestPx = computeTilePxOnFlatCanvas({ ...base, flatCanvasW: 4000 });
    const otherPx = computeTilePxOnFlatCanvas({ ...base, flatCanvasW: 8000 });
    expect(otherPx).toBeCloseTo(chestPx, 5);
  });
});

describe("usesPerPanelPatternTileScale", () => {
  it("marks hood and pocket panels for native scale", () => {
    expect(usesPerPanelPatternTileScale("left_hood")).toBe(true);
    expect(usesPerPanelPatternTileScale("front_pocket")).toBe(true);
    expect(usesPerPanelPatternTileScale("front")).toBe(false);
  });
});

describe("patternModeFrontBodyTileScale", () => {
  it("uses full-front scale so back can match front density", () => {
    expect(
      patternModeFrontBodyTileScale([
        { panelKey: "front", flatCanvasW: 4200, meshTargetWidth: 500 },
        { panelKey: "back", flatCanvasW: 4500, meshTargetWidth: 600 },
        { panelKey: "left_sleeve", flatCanvasW: 3000, meshTargetWidth: 400 },
      ]),
    ).toBeCloseTo(8.4, 5);
  });

  it("falls back to median of front halves when full front is missing", () => {
    expect(
      patternModeFrontBodyTileScale([
        { panelKey: "front_left", flatCanvasW: 4000, meshTargetWidth: 500 },
        { panelKey: "front_right", flatCanvasW: 4400, meshTargetWidth: 500 },
        { panelKey: "back", flatCanvasW: 9000, meshTargetWidth: 500 },
      ]),
    ).toBeCloseTo(8.4, 5);
  });
});

describe("usesFrontMatchedBodyPatternTileScale", () => {
  it("covers front/back body panels only", () => {
    expect(usesFrontMatchedBodyPatternTileScale("front")).toBe(true);
    expect(usesFrontMatchedBodyPatternTileScale("back")).toBe(true);
    expect(usesFrontMatchedBodyPatternTileScale("left_sleeve")).toBe(false);
  });
});

describe("usesBomberUniformPatternTileScale", () => {
  it("covers body and sleeves, not hood/pocket", () => {
    expect(usesBomberUniformPatternTileScale("front_left")).toBe(true);
    expect(usesBomberUniformPatternTileScale("back")).toBe(true);
    expect(usesBomberUniformPatternTileScale("left_sleeve")).toBe(true);
    expect(usesBomberUniformPatternTileScale("right_sleeve")).toBe(true);
    expect(usesBomberUniformPatternTileScale("left_hood")).toBe(false);
    expect(usesBomberUniformPatternTileScale("front_pocket")).toBe(false);
  });
});

describe("patternModeUniformTileScale", () => {
  it("uses median of chest/back/sleeve panels, not hood or pocket outliers", () => {
    const scale = patternModeUniformTileScale([
      { panelKey: "front_left", flatCanvasW: 4000, meshTargetWidth: 500 },
      { panelKey: "front_right", flatCanvasW: 4200, meshTargetWidth: 500 },
      { panelKey: "back", flatCanvasW: 4500, meshTargetWidth: 500 },
      { panelKey: "left_sleeve", flatCanvasW: 4100, meshTargetWidth: 500 },
      { panelKey: "left_hood", flatCanvasW: 9000, meshTargetWidth: 500 },
      { panelKey: "pocket_left", flatCanvasW: 2000, meshTargetWidth: 500 },
    ]);
    // median of [8, 8.2, 8.4, 9] = (8.2+8.4)/2 = 8.3
    expect(scale).toBeCloseTo(8.3, 5);
  });
});

describe("referenceMockupToFlatScale", () => {
  it("prefers back panel scale over outlier front halves", () => {
    const scale = referenceMockupToFlatScale([
      { panelKey: "back", flatCanvasW: 4500, meshTargetWidth: 500 },
      { panelKey: "front_left", flatCanvasW: 9000, meshTargetWidth: 500 },
      { panelKey: "left_sleeve", flatCanvasW: 2000, meshTargetWidth: 500 },
    ]);
    expect(scale).toBeCloseTo(9, 5);
  });

  it("falls back to median of body panels when back is missing", () => {
    const scale = referenceMockupToFlatScale([
      { panelKey: "front_left", flatCanvasW: 4000, meshTargetWidth: 500 },
      { panelKey: "left_sleeve", flatCanvasW: 2000, meshTargetWidth: 500 },
    ]);
    expect(scale).toBeCloseTo(6, 5);
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
