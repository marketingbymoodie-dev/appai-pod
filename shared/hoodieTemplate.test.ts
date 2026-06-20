import { describe, expect, it } from "vitest";
import {
  PULOVER_HOODIE_BLUEPRINT_ID,
  ZIP_HOODIE_BLUEPRINT_ID,
  createFreshAopTemplate,
  defaultHoodieTypeForBlueprint,
  defaultPulloverDesignGroups,
  designGroupsForBlueprint,
  drawMockupImageInCanvas,
  isValidAopTemplateSlug,
  mockupDrawRect,
  panelsEligibleForView,
} from "./hoodieTemplate";

describe("createFreshAopTemplate", () => {
  it("builds blank views and blueprint-specific design groups", () => {
    const t = createFreshAopTemplate({
      name: "sweatshirt-aop-L",
      blueprintId: 449,
    });
    expect(t.name).toBe("sweatshirt-aop-L");
    expect(t.views.front.layers).toHaveLength(0);
    expect(t.views.back.layers).toHaveLength(0);
    expect(t.productTypeId).toBeNull();
    expect(t.hoodieType).toBe("aop-bp-449");
    expect(t.designGroups.length).toBeGreaterThan(0);
  });

  it("uses pullover defaults for bp 450", () => {
    const t = createFreshAopTemplate({ name: "pullover-hoodie-aop-L", blueprintId: 450 });
    expect(t.hoodieType).toBe("pullover-hoodie-aop");
    expect(t.designGroups.find((g) => g.id === "front-body")?.panelKeys).toEqual(["front"]);
  });
});

describe("isValidAopTemplateSlug", () => {
  it("accepts admin slugs", () => {
    expect(isValidAopTemplateSlug("pullover-hoodie-aop-L")).toBe(true);
    expect(isValidAopTemplateSlug("bad slug")).toBe(false);
  });
});

describe("defaultHoodieTypeForBlueprint", () => {
  it("maps known blueprints", () => {
    expect(defaultHoodieTypeForBlueprint(450)).toBe("pullover-hoodie-aop");
    expect(defaultHoodieTypeForBlueprint(451)).toBe("zip-hoodie-aop");
    expect(defaultHoodieTypeForBlueprint(1604)).toBe("aop-bp-1604");
  });
});

describe("pullover hoodie panel keys (bp 450)", () => {
  it("offers full front panel, not zip L/R split", () => {
    const eligible = panelsEligibleForView("front", PULOVER_HOODIE_BLUEPRINT_ID);
    expect(eligible).toContain("front");
    expect(eligible).toContain("front_pocket");
    expect(eligible).not.toContain("front_left");
    expect(eligible).not.toContain("front_right");
    expect(eligible).not.toContain("pocket_left");
    expect(eligible).not.toContain("pocket_right");
  });

  it("zip hoodie hides full front panel", () => {
    const eligible = panelsEligibleForView("front", ZIP_HOODIE_BLUEPRINT_ID);
    expect(eligible).not.toContain("front");
    expect(eligible).toContain("front_left");
    expect(eligible).toContain("front_right");
  });

  it("front-body design group is a single front panel", () => {
    const groups = defaultPulloverDesignGroups();
    const frontBody = groups.find((g) => g.id === "front-body");
    expect(frontBody?.panelKeys).toEqual(["front"]);
  });

  it("designGroupsForBlueprint picks pullover defaults for 450", () => {
    const groups = designGroupsForBlueprint(PULOVER_HOODIE_BLUEPRINT_ID);
    expect(groups.find((g) => g.id === "front-body")?.panelKeys).toEqual(["front"]);
  });

  it("mockupDrawRect applies x/y/scale", () => {
    const rect = mockupDrawRect({
      src: "/x.png",
      width: 2048,
      height: 2048,
      x: 10,
      y: 20,
      scale: 0.9,
    });
    expect(rect).toEqual({
      x: 10,
      y: 20,
      scale: 0.9,
      renderWidth: 2048 * 0.9,
      renderHeight: 2048 * 0.9,
    });
  });

  it("drawMockupImageInCanvas uses transformed rect when mockup asset present", () => {
    const asset = {
      src: "/x.png",
      width: 1024,
      height: 1024,
      x: 27,
      y: 19,
      scale: 0.94,
    };
    const calls: { x: number; y: number; w: number; h: number }[] = [];
    const ctx = {
      drawImage: (_img: unknown, x: number, y: number, w: number, h: number) => {
        calls.push({ x, y, w, h });
      },
    } as unknown as CanvasRenderingContext2D;

    drawMockupImageInCanvas(ctx, {} as CanvasImageSource, asset, 1024, 1024);

    expect(calls).toEqual([{ x: 27, y: 19, w: 1024 * 0.94, h: 1024 * 0.94 }]);
  });
});
