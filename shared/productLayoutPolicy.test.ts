import { describe, expect, it } from "vitest";
import {
  resolveStorefrontMockupMode,
  usesAopStorefrontCustomizer,
} from "./productLayoutPolicy";

describe("productLayoutPolicy — flat vs AOP exclusivity", () => {
  it("prefers flat on-the-fly over AOP title flag when calibrated", () => {
    const product = {
      isAllOverPrint: true,
      onTheFlyTier: "flat",
      printifyBlueprintId: 1007,
    };
    expect(resolveStorefrontMockupMode(product)).toBe("flat");
    expect(usesAopStorefrontCustomizer(product)).toBe(false);
  });

  it("keeps AOP customizer for uncalibrated AOP products", () => {
    const product = {
      isAllOverPrint: true,
      onTheFlyTier: null,
    };
    expect(resolveStorefrontMockupMode(product)).toBe("aop");
    expect(usesAopStorefrontCustomizer(product)).toBe(true);
  });

  it("mesh panel-mapping template still wins over flat tier", () => {
    const product = {
      isAllOverPrint: true,
      onTheFlyTier: "flat",
      panelMappingTemplate: "unisex-zip-hoodie-aop-L",
    };
    expect(resolveStorefrontMockupMode(product)).toBe("aop");
    expect(usesAopStorefrontCustomizer(product)).toBe(true);
  });

  it("explicit storefrontMockupMode=aop overrides flat tier", () => {
    const product = {
      isAllOverPrint: true,
      onTheFlyTier: "flat",
      storefrontMockupMode: "aop",
    };
    expect(resolveStorefrontMockupMode(product)).toBe("aop");
    expect(usesAopStorefrontCustomizer(product)).toBe(true);
  });
});
