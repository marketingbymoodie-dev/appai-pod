import { describe, expect, it } from "vitest";
import { unionMaskAnchors, unionMaskSubpaths } from "./mergeLayerPolygons";

describe("unionMaskSubpaths", () => {
  it("unions two adjacent rectangles into one subpath", () => {
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
    const merged = unionMaskSubpaths([left, right]);
    expect(merged).not.toBeNull();
    expect(merged).toHaveLength(1);
    const xs = merged![0].map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(0, 0);
    expect(Math.max(...xs)).toBeCloseTo(20, 0);
  });

  it("keeps two disjoint rectangles as two subpaths (bomber front halves)", () => {
    const left = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const right = [
      { x: 20, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 10 },
      { x: 20, y: 10 },
    ];
    const merged = unionMaskSubpaths([left, right]);
    expect(merged).not.toBeNull();
    expect(merged).toHaveLength(2);
    const leftXs = merged![0].map((p) => p.x);
    const rightXs = merged![1].map((p) => p.x);
    expect(Math.max(...leftXs)).toBeLessThan(Math.min(...rightXs));
  });

  it("returns null for fewer than two inputs", () => {
    expect(
      unionMaskSubpaths([[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]]),
    ).toBeNull();
  });
});

describe("unionMaskAnchors (legacy single-ring)", () => {
  it("returns one ring when union is connected", () => {
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
    expect(unionMaskAnchors([left, right])).not.toBeNull();
  });

  it("returns null when result is multiple disjoint regions", () => {
    const left = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const right = [
      { x: 20, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 10 },
      { x: 20, y: 10 },
    ];
    expect(unionMaskAnchors([left, right])).toBeNull();
  });
});
