import { describe, expect, it } from "vitest";
import { computeMeshFlatTileStretch } from "./aopPreview";

describe("computeMeshFlatTileStretch", () => {
  it("returns 1 when mesh target matches the visible polygon width", () => {
    expect(computeMeshFlatTileStretch(400, 400)).toBe(1);
  });

  it("scales up tile px when the mesh overscans the polygon", () => {
    expect(computeMeshFlatTileStretch(2000, 200)).toBe(10);
  });

  it("returns 1 for zero or invalid widths", () => {
    expect(computeMeshFlatTileStretch(0, 500)).toBe(1);
    expect(computeMeshFlatTileStretch(400, 0)).toBe(1);
  });
});
