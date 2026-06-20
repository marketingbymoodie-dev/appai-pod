import { describe, expect, it } from "vitest";
import {
  PULOVER_HOODIE_BLUEPRINT_ID,
  ZIP_HOODIE_BLUEPRINT_ID,
  defaultPulloverDesignGroups,
  designGroupsForBlueprint,
  drawMockupImageInCanvas,
  mockupDrawRect,
  panelsEligibleForView,
} from "./hoodieTemplate";

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
