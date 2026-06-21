import { describe, expect, it } from "vitest";
import {
  PULOVER_HOODIE_BLUEPRINT_ID,
  SWEATSHIRT_BLUEPRINT_ID,
  ZIP_HOODIE_BLUEPRINT_ID,
  createFreshAopTemplate,
  createDefaultMesh,
  defaultHoodieTypeForBlueprint,
  defaultPulloverDesignGroups,
  defaultSweatshirtDesignGroups,
  designGroupsForBlueprint,
  drawMockupImageInCanvas,
  hoodiePanelKeyToPrintifyPosition,
  isValidAopTemplateSlug,
  MAX_MESH_COLS,
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

  it("uses sweatshirt defaults for bp 449", () => {
    const t = createFreshAopTemplate({ name: "sweatshirt-aop-L", blueprintId: 449 });
    expect(t.designGroups.find((g) => g.id === "collar")?.panelKeys).toEqual([
      "collar_front",
      "collar_back",
    ]);
    expect(t.designGroups.find((g) => g.id === "hood")).toBeUndefined();
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

describe("sweatshirt hoodie panel keys (bp 449)", () => {
  it("offers collar keys and hides hoodie-only panels", () => {
    const front = panelsEligibleForView("front", SWEATSHIRT_BLUEPRINT_ID);
    expect(front).toContain("front");
    expect(front).toContain("collar_front");
    expect(front).toContain("collar_back");
    expect(front).not.toContain("left_hood");
    expect(front).not.toContain("front_left");

    const back = panelsEligibleForView("back", SWEATSHIRT_BLUEPRINT_ID);
    expect(back).toContain("collar_back");
    expect(back).not.toContain("collar_front");
    expect(back).not.toContain("left_hood");
  });

  it("collar design group lists front + back collar keys", () => {
    const groups = defaultSweatshirtDesignGroups();
    expect(groups.find((g) => g.id === "collar")?.panelKeys).toEqual([
      "collar_front",
      "collar_back",
    ]);
  });

  it("designGroupsForBlueprint picks sweatshirt defaults for 449", () => {
    const groups = designGroupsForBlueprint(SWEATSHIRT_BLUEPRINT_ID);
    expect(groups.find((g) => g.id === "trim")?.panelKeys).toEqual(["waistband"]);
  });
});

describe("hoodiePanelKeyToPrintifyPosition", () => {
  it("maps cuff and collar keys to Printify placeholder names", () => {
    expect(hoodiePanelKeyToPrintifyPosition("left_cuff")).toBe("left_cuff_panel");
    expect(hoodiePanelKeyToPrintifyPosition("collar_front")).toBe("collar");
    expect(hoodiePanelKeyToPrintifyPosition("collar_back")).toBe("collar");
    expect(hoodiePanelKeyToPrintifyPosition("front")).toBe("front");
  });
});

describe("mesh grid limits", () => {
  it("allows up to 24 columns for wide collar strips", () => {
    expect(MAX_MESH_COLS).toBe(24);
    const mesh = createDefaultMesh({ x: 0, y: 0, width: 100, height: 10 }, 24, 3);
    expect(mesh.cols).toBe(24);
    expect(mesh.rows).toBe(3);
    expect(mesh.targetPoints).toHaveLength(72);
  });
});
