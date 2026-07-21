import { describe, expect, it } from "vitest";
import {
  pickFlatOrderArtworkUrl,
  pickFlatOrderSizeColor,
  resolvePrintifyTarget,
} from "./flat-order-fulfillment";
import type { ProductType } from "@shared/schema";

describe("pickFlatOrderArtworkUrl", () => {
  it("prefers flatPlacer artwork over stale job URL", () => {
    expect(
      pickFlatOrderArtworkUrl({
        flatPlacerArtworkUrl: "https://cdn.example/new.png",
        jobDesignImageUrl: "https://cdn.example/old.png",
        lineArtworkUrl: "https://cdn.example/line.png",
      }),
    ).toBe("https://cdn.example/new.png");
  });

  it("falls back to job then line", () => {
    expect(
      pickFlatOrderArtworkUrl({
        jobDesignImageUrl: "https://cdn.example/job.png",
        lineArtworkUrl: "https://cdn.example/line.png",
      }),
    ).toBe("https://cdn.example/job.png");
    expect(
      pickFlatOrderArtworkUrl({
        lineArtworkUrl: "https://cdn.example/line.png",
      }),
    ).toBe("https://cdn.example/line.png");
  });
});

describe("pickFlatOrderSizeColor", () => {
  it("prefers designState over job columns", () => {
    expect(
      pickFlatOrderSizeColor({
        designStateSize: "20x30",
        designStateColor: "white",
        jobSize: "11x14",
        jobColor: "black",
      }),
    ).toEqual({ sizeId: "20x30", colorId: "white" });
  });

  it("design product override wins over designState", () => {
    expect(
      pickFlatOrderSizeColor({
        designProductSizeId: "16x20",
        designProductColorId: "black",
        designStateSize: "20x30",
        designStateColor: "white",
        jobSize: "11x14",
        jobColor: "gold",
      }),
    ).toEqual({ sizeId: "16x20", colorId: "black" });
  });
});

describe("resolvePrintifyTarget phone size-only", () => {
  it("resolves iphone_13:12_pro via edgeWrap size-only fallback", () => {
    const productType = {
      printifyBlueprintId: 999,
      printifyProviderId: 1,
      variantMap: JSON.stringify({
        "iphone_13:black": { printifyVariantId: 4242, providerId: 1 },
      }),
      flatCalibration: JSON.stringify({ edgeWrap: true }),
    } as unknown as ProductType;

    const target = resolvePrintifyTarget(productType, "iphone_13", "12_pro");
    expect(target).toEqual({
      blueprintId: 999,
      providerId: 1,
      printifyVariantId: 4242,
    });
  });

  it("does not size-only fallback without edgeWrap", () => {
    const productType = {
      printifyBlueprintId: 999,
      printifyProviderId: 1,
      variantMap: JSON.stringify({
        "iphone_13:black": { printifyVariantId: 4242, providerId: 1 },
      }),
      flatCalibration: JSON.stringify({ edgeWrap: false }),
    } as unknown as ProductType;

    expect(resolvePrintifyTarget(productType, "iphone_13", "12_pro")).toBeNull();
  });
});
