import { describe, expect, it } from "vitest";
import {
  expandHoodPanelImageIdsWithSiblingFallback,
  expandPanelImageIdsWithCollarAliases,
  expandPanelImageIdsWithPocketAliases,
  isPocketLikePrintifyPosition,
  pocketOverlayRectOnFrontPanel,
  resolvePocketFallbackImageId,
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

  it("fuzzy-matches any pocket-like upload to any pocket-like placeholder", () => {
    const ids = new Map([["outer_pocket", "img-x"]]);
    expect(resolvePrintifyPanelImageId("pocket", ids)).toBe("img-x");
  });

  it("matches bp 449 title-case Collar to lowercase collar upload", () => {
    const ids = new Map([["collar", "img-collar"]]);
    expect(resolvePrintifyPanelImageId("Collar", ids)).toBe("img-collar");
  });
});

describe("expandPanelImageIdsWithCollarAliases", () => {
  it("registers collar under both Collar and collar", () => {
    const ids = new Map([["collar", "img-c"]]);
    expandPanelImageIdsWithCollarAliases(ids);
    expect(ids.get("Collar")).toBe("img-c");
    expect(ids.get("collar")).toBe("img-c");
  });
});

describe("resolvePocketFallbackImageId", () => {
  it("prefers front then split front halves", () => {
    expect(resolvePocketFallbackImageId(new Map([["front", "f"]]))).toBe("f");
    expect(
      resolvePocketFallbackImageId(new Map([["front_left", "fl"], ["back", "b"]])),
    ).toBe("fl");
  });
});

describe("expandHoodPanelImageIdsWithSiblingFallback", () => {
  it("fills missing left_hood from right_hood", () => {
    const ids = new Map([["right_hood", "img-r"]]);
    expandHoodPanelImageIdsWithSiblingFallback(ids);
    expect(ids.get("left_hood")).toBe("img-r");
  });

  it("fills missing right_hood from left_hood", () => {
    const ids = new Map([["left_hood", "img-l"]]);
    expandHoodPanelImageIdsWithSiblingFallback(ids);
    expect(ids.get("right_hood")).toBe("img-l");
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
