import { describe, expect, it } from "vitest";
import {
  mapMockupPointToFrontFlat,
  overlayRectOnReferencePanel,
  pocketOverlayRectOnFrontPanel,
  shouldMergePulloverPocketForPrintify,
} from "./pulloverPocketPrintMerge";
import { PULOVER_HOODIE_BLUEPRINT_ID } from "./hoodieTemplate";

describe("shouldMergePulloverPocketForPrintify", () => {
  it("merges for pullover when pockets are on", () => {
    expect(shouldMergePulloverPocketForPrintify(PULOVER_HOODIE_BLUEPRINT_ID, true)).toBe(true);
  });

  it("merges when blueprint id is missing but hoodie type is pullover", () => {
    expect(shouldMergePulloverPocketForPrintify(undefined, true, "pullover-hoodie-aop")).toBe(
      true,
    );
  });

  it("skips for zip hoodie or pockets off", () => {
    expect(shouldMergePulloverPocketForPrintify(451, true)).toBe(false);
    expect(shouldMergePulloverPocketForPrintify(PULOVER_HOODIE_BLUEPRINT_ID, false)).toBe(false);
  });
});

describe("pocketOverlayRectOnFrontPanel", () => {
  it("maps pocket bbox into front canvas space", () => {
    const frontBb = { x: 100, y: 50, width: 400, height: 500 };
    const pocketBb = { x: 200, y: 400, width: 200, height: 120 };
    const dest = pocketOverlayRectOnFrontPanel(frontBb, pocketBb, 800, 1000);
    expect(dest.x).toBeCloseTo(200);
    expect(dest.y).toBeCloseTo(700);
    expect(dest.width).toBeCloseTo(400);
    expect(dest.height).toBeCloseTo(240);
  });

  it("overlayRectOnReferencePanel matches pocketOverlayRectOnFrontPanel", () => {
    const frontBb = { x: 100, y: 50, width: 400, height: 500 };
    const pocketBb = { x: 200, y: 400, width: 200, height: 120 };
    expect(overlayRectOnReferencePanel(frontBb, pocketBb, 800, 1000)).toEqual(
      pocketOverlayRectOnFrontPanel(frontBb, pocketBb, 800, 1000),
    );
  });
});

describe("mapMockupPointToFrontFlat", () => {
  it("maps mockup corners into flat canvas space", () => {
    const host = { x: 100, y: 200, width: 400, height: 500 };
    expect(mapMockupPointToFrontFlat({ x: 100, y: 200 }, host, 800, 1000)).toEqual({
      x: 0,
      y: 0,
    });
    expect(mapMockupPointToFrontFlat({ x: 500, y: 700 }, host, 800, 1000)).toEqual({
      x: 800,
      y: 1000,
    });
  });
});
