import { describe, expect, it } from "vitest";
import {
  expandPanelImageIdsWithPocketAliases,
  isPocketLikePrintifyPosition,
  pocketOverlayRectOnFrontPanel,
  resolvePrintifyPanelImageId,
  shouldExportPulloverPocketAsPrintifyPanel,
  shouldMergePulloverPocketForPrintify,
} from "./pulloverPocketPrintMerge";
import { PULOVER_HOODIE_BLUEPRINT_ID } from "./hoodieTemplate";

describe("shouldExportPulloverPocketAsPrintifyPanel", () => {
  it("exports for pullover when pockets are on", () => {
    expect(shouldExportPulloverPocketAsPrintifyPanel(PULOVER_HOODIE_BLUEPRINT_ID, true)).toBe(
      true,
    );
  });

  it("exports when blueprint id is missing but hoodie type is pullover", () => {
    expect(
      shouldExportPulloverPocketAsPrintifyPanel(undefined, true, "pullover-hoodie-aop"),
    ).toBe(true);
  });

  it("skips for zip hoodie or pockets off", () => {
    expect(shouldExportPulloverPocketAsPrintifyPanel(451, true)).toBe(false);
    expect(shouldExportPulloverPocketAsPrintifyPanel(PULOVER_HOODIE_BLUEPRINT_ID, false)).toBe(
      false,
    );
  });

  it("keeps deprecated alias in sync", () => {
    expect(shouldMergePulloverPocketForPrintify(PULOVER_HOODIE_BLUEPRINT_ID, true)).toBe(true);
  });
});

describe("resolvePrintifyPanelImageId", () => {
  it("matches exact position", () => {
    const ids = new Map([["front_pocket", "img-1"]]);
    expect(resolvePrintifyPanelImageId("front_pocket", ids)).toBe("img-1");
  });

  it("matches pocket alias when Printify uses pocket and client uploads front_pocket", () => {
    const ids = new Map([["front_pocket", "img-pocket"]]);
    expect(resolvePrintifyPanelImageId("pocket", ids)).toBe("img-pocket");
  });
});

describe("expandPanelImageIdsWithPocketAliases", () => {
  it("registers front_pocket upload under pocket aliases", () => {
    const ids = new Map([["front_pocket", "img-pocket"], ["front", "img-front"]]);
    expandPanelImageIdsWithPocketAliases(ids);
    expect(ids.get("pocket")).toBe("img-pocket");
    expect(ids.get("kangaroo_pocket")).toBe("img-pocket");
    expect(ids.get("front")).toBe("img-front");
  });
});

describe("isPocketLikePrintifyPosition", () => {
  it("detects pocket-related placeholder names", () => {
    expect(isPocketLikePrintifyPosition("front_pocket")).toBe(true);
    expect(isPocketLikePrintifyPosition("pocket")).toBe(true);
    expect(isPocketLikePrintifyPosition("left_sleeve")).toBe(false);
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
