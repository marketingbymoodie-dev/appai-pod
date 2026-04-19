import { describe, it, expect } from "vitest";
import { resolveAopLayoutKind } from "./registry";
import type { AopLayoutKind } from "./detectLayoutKind";

describe("resolveAopLayoutKind", () => {
  it("returns inferred when template id is empty", () => {
    expect(resolveAopLayoutKind(null, "hoodie")).toBe("hoodie");
    expect(resolveAopLayoutKind(undefined, "leggings")).toBe("leggings");
    expect(resolveAopLayoutKind("", "generic")).toBe("generic");
  });

  it("maps known template ids", () => {
    expect(resolveAopLayoutKind("leggings_v1", "generic")).toBe("leggings");
    expect(resolveAopLayoutKind("hoodie_v1", "leggings")).toBe("hoodie");
    expect(resolveAopLayoutKind("generic_aop_v1", "hoodie")).toBe("generic");
  });

  it("falls back to inferred for unknown template id", () => {
    const inferred: AopLayoutKind = "leggings";
    expect(resolveAopLayoutKind("unknown_vendor_v9", inferred)).toBe(inferred);
  });
});
