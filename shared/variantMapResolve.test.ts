import { describe, expect, it } from "vitest";
import {
  resolveVariantForSizeOnly,
  resolveVariantFromMap,
} from "./variantMapResolve";

describe("resolveVariantForSizeOnly", () => {
  const phoneMap = {
    "iphone_13:black": { printifyVariantId: 101, providerId: 1 },
    "iphone_13:clear": { printifyVariantId: 102, providerId: 1 },
    "iphone_14_pro:black": { printifyVariantId: 201, providerId: 1 },
  };

  it("finds any colour for a phone model size", () => {
    const hit = resolveVariantForSizeOnly(phoneMap, "iphone_13");
    expect(hit?.entry.printifyVariantId).toBe(101);
    expect(hit?.key).toBe("iphone_13:black");
  });

  it("returns null when size is missing", () => {
    expect(resolveVariantForSizeOnly(phoneMap, "galaxy_s23")).toBeNull();
  });
});

describe("resolveVariantFromMap vs junk phone colour", () => {
  const phoneMap = {
    "iphone_13:black": { printifyVariantId: 101, providerId: 1 },
  };

  it("exact lookup fails for Model fragment colour", () => {
    expect(resolveVariantFromMap(phoneMap, "iphone_13", "12_pro")).toBeNull();
  });

  it("size-only helper recovers the variant", () => {
    expect(resolveVariantForSizeOnly(phoneMap, "iphone_13")?.entry.printifyVariantId).toBe(101);
  });
});
