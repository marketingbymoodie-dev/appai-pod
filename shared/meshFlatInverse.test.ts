import { describe, expect, it } from "vitest";
import { mockupPointToMeshFlatPixel } from "./meshFlatInverse";
import type { MeshGrid } from "./hoodieTemplate";

function makeSquareMesh(
  size: number,
  flatW: number,
  flatH: number,
): MeshGrid {
  return {
    cols: 2,
    rows: 2,
    targetPoints: [
      { x: 0, y: 0 },
      { x: size, y: 0 },
      { x: 0, y: size },
      { x: size, y: size },
    ],
    sourceRect: { x: 0, y: 0, width: flatW, height: flatH },
    sourceRotation: 0,
    sourceFlipX: false,
    sourceFlipY: false,
  };
}

describe("mockupPointToMeshFlatPixel", () => {
  it("maps mockup corners to flat canvas corners for a uniform square mesh", () => {
    const mesh = makeSquareMesh(100, 800, 1000);
    expect(mockupPointToMeshFlatPixel({ x: 0, y: 0 }, mesh, 800, 1000)).toEqual({
      x: 0,
      y: 0,
    });
    expect(mockupPointToMeshFlatPixel({ x: 100, y: 100 }, mesh, 800, 1000)).toEqual({
      x: 800,
      y: 1000,
    });
  });

  it("maps the mesh centre to the flat canvas centre", () => {
    const mesh = makeSquareMesh(200, 400, 600);
    const center = mockupPointToMeshFlatPixel({ x: 100, y: 100 }, mesh, 400, 600);
    expect(center?.x).toBeCloseTo(200, 4);
    expect(center?.y).toBeCloseTo(300, 4);
  });

  it("returns null when the point is outside the meshed region", () => {
    const mesh = makeSquareMesh(100, 800, 1000);
    expect(mockupPointToMeshFlatPixel({ x: 500, y: 500 }, mesh, 800, 1000)).toBeNull();
  });
});
