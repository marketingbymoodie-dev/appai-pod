import { describe, expect, it } from "vitest";
import { computeMeshFlatTileStretch } from "./aopPreview";

describe("computeMeshFlatTileStretch", () => {
  it("returns 1 when flat dims match the visible polygon bbox", () => {
    const path = "M0,0 L400,0 L400,500 L0,500 Z";
    expect(computeMeshFlatTileStretch(path, 400, 500)).toBe(1);
  });

  it("scales up tile px when the flat canvas overscans the polygon", () => {
    const path = "M100,50 L300,50 L300,450 L100,450 Z";
    expect(computeMeshFlatTileStretch(path, 2000, 4000)).toBe(10);
  });

  it("returns 1 for zero flat dims", () => {
    expect(computeMeshFlatTileStretch("", 0, 500)).toBe(1);
    expect(computeMeshFlatTileStretch("M0,0 L400,0 L400,500 L0,500 Z", 0, 0)).toBe(1);
  });
});
