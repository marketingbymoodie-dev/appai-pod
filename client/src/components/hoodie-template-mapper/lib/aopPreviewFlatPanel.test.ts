import { describe, expect, it } from "vitest";
import {
  buildFlatMeshTargetPoints,
  flatBridgeSourceFlipX,
  meshSourceFlipXForPanel,
} from "./aopPreview";

describe("buildFlatMeshTargetPoints", () => {
  it("maps mesh corners to the full flat canvas", () => {
    const mesh = {
      cols: 3,
      rows: 2,
      targetPoints: [
        { x: 10, y: 20 },
        { x: 30, y: 20 },
        { x: 50, y: 20 },
        { x: 10, y: 80 },
        { x: 30, y: 80 },
        { x: 50, y: 80 },
      ],
    };
    const flat = buildFlatMeshTargetPoints(mesh, 400, 200);
    expect(flat).toHaveLength(6);
    expect(flat[0]).toEqual({ x: 0, y: 0 });
    expect(flat[2]).toEqual({ x: 400, y: 0 });
    expect(flat[3]).toEqual({ x: 0, y: 200 });
    expect(flat[5]).toEqual({ x: 400, y: 200 });
  });
});

describe("meshSourceFlipXForPanel", () => {
  it("XORs calibration flip on right_sleeve when sleevesMirrored", () => {
    expect(meshSourceFlipXForPanel("right_sleeve", false, true)).toBe(true);
    expect(meshSourceFlipXForPanel("right_sleeve", true, true)).toBe(false);
    expect(meshSourceFlipXForPanel("right_sleeve", false, false)).toBe(false);
    expect(meshSourceFlipXForPanel("left_sleeve", false, true)).toBe(false);
    expect(meshSourceFlipXForPanel("left_sleeve", true, true)).toBe(true);
  });
});

describe("flatBridgeSourceFlipX", () => {
  it("flips sleeves on the back bridge, not hood", () => {
    expect(flatBridgeSourceFlipX("left_sleeve")).toBe(true);
    expect(flatBridgeSourceFlipX("right_sleeve")).toBe(true);
    expect(flatBridgeSourceFlipX("left_hood")).toBe(false);
    expect(flatBridgeSourceFlipX("right_hood")).toBe(false);
    expect(flatBridgeSourceFlipX("back")).toBe(false);
  });
});
