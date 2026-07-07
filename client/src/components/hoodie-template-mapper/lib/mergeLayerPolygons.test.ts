import { describe, expect, it } from "vitest";
import { unionMaskAnchors } from "./mergeLayerPolygons";

describe("unionMaskAnchors", () => {
  it("unions two adjacent rectangles into one", () => {
    const left = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const right = [
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 10 },
    ];
    const merged = unionMaskAnchors([left, right]);
    expect(merged).not.toBeNull();
    expect(merged!.length).toBeGreaterThanOrEqual(4);
    const xs = merged!.map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(0, 0);
    expect(Math.max(...xs)).toBeCloseTo(20, 0);
  });

  it("returns null for fewer than two inputs", () => {
    expect(unionMaskAnchors([[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]])).toBeNull();
  });
});
