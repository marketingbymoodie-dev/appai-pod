import { describe, expect, it } from "vitest";
import {
  pocketOverlayRectOnFrontPanel,
  shouldMergePulloverPocketForPrintify,
} from "./pulloverPocketPrintMerge";
import { PULOVER_HOODIE_BLUEPRINT_ID } from "./hoodieTemplate";

describe("shouldMergePulloverPocketForPrintify", () => {
  it("merges for pullover when pockets are on", () => {
    expect(shouldMergePulloverPocketForPrintify(PULOVER_HOODIE_BLUEPRINT_ID, true)).toBe(true);
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
});
