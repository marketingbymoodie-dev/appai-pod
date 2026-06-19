import { describe, expect, it } from "vitest";
import {
  composeToteFoldedCanvas,
  TOTE_FOLDED_CANVAS_HEIGHT,
  TOTE_FOLDED_CANVAS_WIDTH,
  TOTE_FOLDED_PANEL_HEIGHT,
  TOTE_FOLDED_PANEL_WIDTH,
} from "./toteFoldedLayout";
import {
  ADJUSTABLE_TOTE_BLUEPRINT_ID,
  resolveFulfillmentLayout,
  resolveStorefrontMockupMode,
  usesAopStorefrontCustomizer,
  usesToteFoldedFulfillment,
} from "./productLayoutPolicy";

describe("composeToteFoldedCanvas", () => {
  it("outputs 2650×5250 with distinct top/bottom panels", () => {
    const w = 100;
    const h = 50;
    const pixels = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        pixels[i] = x >= w / 2 ? 255 : 0;
        pixels[i + 1] = 0;
        pixels[i + 2] = 0;
        pixels[i + 3] = 255;
      }
    }

    const out = composeToteFoldedCanvas({ sourceWidth: w, sourceHeight: h, pixels });
    expect(out.width).toBe(TOTE_FOLDED_CANVAS_WIDTH);
    expect(out.height).toBe(TOTE_FOLDED_CANVAS_HEIGHT);

    const cx = Math.floor(TOTE_FOLDED_PANEL_WIDTH / 2);
    const topRow = Math.floor(TOTE_FOLDED_PANEL_HEIGHT / 2);
    const bottomRow = TOTE_FOLDED_PANEL_HEIGHT + Math.floor(TOTE_FOLDED_PANEL_HEIGHT / 2);
    const topIdx = (topRow * TOTE_FOLDED_CANVAS_WIDTH + cx) * 4;
    const bottomIdx = (bottomRow * TOTE_FOLDED_CANVAS_WIDTH + cx) * 4;
    expect(out.pixels[topIdx]).toBe(255);
    expect(out.pixels[bottomIdx]).toBe(0);
  });
});

describe("productLayoutPolicy", () => {
  it("defaults adjustable tote to flat mockups + folded fulfillment", () => {
    const product = {
      isAllOverPrint: true,
      printifyBlueprintId: ADJUSTABLE_TOTE_BLUEPRINT_ID,
    };
    expect(resolveFulfillmentLayout(product)).toBe("tote_folded_v1");
    expect(resolveStorefrontMockupMode(product)).toBe("flat");
    expect(usesToteFoldedFulfillment(product)).toBe(true);
    expect(usesAopStorefrontCustomizer(product)).toBe(false);
  });

  it("respects explicit storefront override to AOP", () => {
    expect(
      usesAopStorefrontCustomizer({
        isAllOverPrint: true,
        printifyBlueprintId: ADJUSTABLE_TOTE_BLUEPRINT_ID,
        storefrontMockupMode: "aop",
      }),
    ).toBe(true);
  });
});
