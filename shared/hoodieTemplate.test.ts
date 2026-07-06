import { describe, expect, it } from "vitest";
import {
  PULOVER_HOODIE_BLUEPRINT_ID,
  SWEATSHIRT_BLUEPRINT_ID,
  ZIP_HOODIE_BLUEPRINT_ID,
  PILLOW_WRAP_BLUEPRINT_ID,
  FAUX_SUEDE_PILLOW_WRAP_BLUEPRINT_ID,
  BODY_PILLOW_WRAP_BLUEPRINT_ID,
  createFreshAopTemplate,
  createDefaultMesh,
  defaultHoodieTypeForBlueprint,
  defaultPulloverDesignGroups,
  defaultSweatshirtDesignGroups,
  designGroupsForBlueprint,
  drawMockupImageInCanvas,
  hoodiePanelKeyToPrintifyPosition,
  isValidAopTemplateSlug,
  normalizeAopTemplateSlugInput,
  MAX_MESH_COLS,
  defaultPlacerEditorForBlueprint,
  defaultPrintFileLayoutForBlueprint,
  resolvePlacerEditor,
  resolvePrintFileLayout,
  isPillowWrapBlueprint,
  isPillowWrapTemplate,
  migrateSweatshirtDesignGroups,
  mockupDrawRect,
  normalizeHoodieTemplate,
  panelsEligibleForView,
  SWEATSHIRT_TRIM_PANEL_KEYS,
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
    expect(t.designGroups.find((g) => g.id === "trim")?.panelKeys).toEqual([
      ...SWEATSHIRT_TRIM_PANEL_KEYS,
    ]);
    expect(t.designGroups.find((g) => g.id === "left-sleeve")?.panelKeys).toEqual(["left_sleeve"]);
    expect(t.designGroups.find((g) => g.id === "hood")).toBeUndefined();
    expect(t.designGroups.find((g) => g.id === "collar")).toBeUndefined();
  });
});

describe("isValidAopTemplateSlug", () => {
  it("accepts admin slugs", () => {
    expect(isValidAopTemplateSlug("pullover-hoodie-aop-L")).toBe(true);
    expect(isValidAopTemplateSlug("bad slug")).toBe(false);
  });
});

describe("normalizeAopTemplateSlugInput", () => {
  it("converts labels with spaces into admin slugs", () => {
    expect(normalizeAopTemplateSlugInput("Spun Polyester Square Pillow")).toBe(
      "Spun_Polyester_Square_Pillow",
    );
  });
});

describe("pillow wrap blueprints", () => {
  it("recognises spun polyester (220) and faux suede (223)", () => {
    expect(isPillowWrapBlueprint(PILLOW_WRAP_BLUEPRINT_ID)).toBe(true);
    expect(isPillowWrapBlueprint(FAUX_SUEDE_PILLOW_WRAP_BLUEPRINT_ID)).toBe(true);
    expect(isPillowWrapBlueprint(BODY_PILLOW_WRAP_BLUEPRINT_ID)).toBe(true);
    expect(isPillowWrapBlueprint(451)).toBe(false);
  });

  it("uses pillow design groups for bp 2758 body pillow", () => {
    const groups = designGroupsForBlueprint(BODY_PILLOW_WRAP_BLUEPRINT_ID);
    expect(groups.find((g) => g.id === "front-face")?.panelKeys).toEqual(["front"]);
    expect(groups.find((g) => g.id === "back-face")?.panelKeys).toEqual(["back"]);
    expect(groups.find((g) => g.id === "front-body")).toBeUndefined();
  });

  it("defaultHoodieTypeForBlueprint maps pillow blueprints", () => {
    expect(defaultHoodieTypeForBlueprint(PILLOW_WRAP_BLUEPRINT_ID)).toBe("pillow-wrap-aop");
    expect(defaultHoodieTypeForBlueprint(FAUX_SUEDE_PILLOW_WRAP_BLUEPRINT_ID)).toBe(
      "pillow-wrap-aop",
    );
  });

  it("normalizeHoodieTemplate replaces hoodie groups on faux suede templates", () => {
    const raw = createFreshAopTemplate({
      name: "faux-suede-square-pillow",
      blueprintId: FAUX_SUEDE_PILLOW_WRAP_BLUEPRINT_ID,
    });
    raw.designGroups = designGroupsForBlueprint(ZIP_HOODIE_BLUEPRINT_ID);
    const normalized = normalizeHoodieTemplate(raw);
    expect(isPillowWrapTemplate(normalized)).toBe(true);
    expect(normalized.placerEditor).toBe("front-back-face");
    expect(normalized.printFileLayout).toBe("wrap-single");
    expect(normalized.designGroups?.find((g) => g.id === "front-face")).toBeDefined();
    expect(normalized.designGroups?.find((g) => g.id === "front-body")).toBeUndefined();
  });

  it("explicit placerEditor front-back-face works for unlisted blueprint ids", () => {
    const t = normalizeHoodieTemplate(
      createFreshAopTemplate({
        name: "custom-pillow",
        blueprintId: 996,
        placerEditor: "front-back-face",
        printFileLayout: "wrap-single",
        hoodieType: "pillow-wrap-aop",
      }),
    );
    expect(isPillowWrapTemplate(t)).toBe(true);
    expect(resolvePlacerEditor(t)).toBe("front-back-face");
    expect(t.designGroups?.find((g) => g.id === "front-face")).toBeDefined();
    expect(panelsEligibleForView("front", 996, "front-back-face")).toContain("front");
    expect(panelsEligibleForView("front", 996, "front-back-face")).not.toContain("front_left");
  });

  it("defaultPrintFileLayoutForBlueprint maps body pillow to split", () => {
    expect(defaultPrintFileLayoutForBlueprint(BODY_PILLOW_WRAP_BLUEPRINT_ID)).toBe("split-front-back");
    expect(defaultPrintFileLayoutForBlueprint(PILLOW_WRAP_BLUEPRINT_ID)).toBe("wrap-single");
    expect(defaultPrintFileLayoutForBlueprint(450)).toBe("split-front-back");
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

  it("trim group includes cuffs, waistband, and neck rib", () => {
    const groups = defaultSweatshirtDesignGroups();
    expect(groups.find((g) => g.id === "trim")?.panelKeys).toEqual([
      ...SWEATSHIRT_TRIM_PANEL_KEYS,
    ]);
    expect(groups.find((g) => g.id === "left-sleeve")?.panelKeys).toEqual(["left_sleeve"]);
    expect(groups.find((g) => g.id === "right-sleeve")?.panelKeys).toEqual(["right_sleeve"]);
    expect(groups.find((g) => g.id === "collar")).toBeUndefined();
  });

  it("designGroupsForBlueprint picks sweatshirt defaults for 449", () => {
    const groups = designGroupsForBlueprint(SWEATSHIRT_BLUEPRINT_ID);
    expect(groups.find((g) => g.id === "trim")?.panelKeys).toEqual([
      ...SWEATSHIRT_TRIM_PANEL_KEYS,
    ]);
  });

  it("migrateSweatshirtDesignGroups strips hood and merges collar into trim", () => {
    const migrated = migrateSweatshirtDesignGroups([
      ...defaultSweatshirtDesignGroups(),
      {
        id: "hood",
        name: "Hood",
        panelKeys: ["left_hood", "right_hood"],
        placement: { front: { scale: 1, offsetX: 0, offsetY: 0 }, back: { scale: 1, offsetX: 0, offsetY: 0 } },
        seamAllowance: 0,
        lockedRatio: null,
        enabled: true,
      },
      {
        id: "collar",
        name: "Collar",
        panelKeys: ["collar_front", "collar_back"],
        placement: { front: { scale: 1, offsetX: 0, offsetY: 0 }, back: { scale: 1, offsetX: 0, offsetY: 0 } },
        seamAllowance: 0,
        lockedRatio: null,
        enabled: true,
      },
    ]);
    expect(migrated.find((g) => g.id === "hood")).toBeUndefined();
    expect(migrated.find((g) => g.id === "collar")).toBeUndefined();
    expect(migrated.find((g) => g.id === "trim")?.panelKeys).toEqual([
      ...SWEATSHIRT_TRIM_PANEL_KEYS,
    ]);
  });

  it("normalizeHoodieTemplate migrates stale bp 449 templates on load", () => {
    const raw = createFreshAopTemplate({ name: "sweatshirt-aop-L", blueprintId: 449 });
    raw.designGroups = [
      ...raw.designGroups!,
      {
        id: "hood",
        name: "Hood",
        panelKeys: ["left_hood", "right_hood"],
        placement: { front: { scale: 1, offsetX: 0, offsetY: 0 }, back: { scale: 1, offsetX: 0, offsetY: 0 } },
        seamAllowance: 0,
        lockedRatio: null,
        enabled: true,
      },
    ];
    const normalized = normalizeHoodieTemplate(raw);
    expect(normalized.designGroups?.find((g) => g.id === "hood")).toBeUndefined();
    expect(normalized.designGroups?.find((g) => g.id === "trim")?.panelKeys).toEqual([
      ...SWEATSHIRT_TRIM_PANEL_KEYS,
    ]);
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
