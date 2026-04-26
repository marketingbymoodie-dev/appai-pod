import { describe, it, expect } from "vitest";
import { resolveAopLayoutKind } from "./registry";
import { detectProductKind, type AopLayoutKind } from "./detectLayoutKind";

describe("resolveAopLayoutKind", () => {
  it("returns inferred when template id is empty", () => {
    expect(resolveAopLayoutKind(null, "hoodie")).toBe("hoodie");
    expect(resolveAopLayoutKind(undefined, "leggings")).toBe("leggings");
    expect(resolveAopLayoutKind("", "generic")).toBe("generic");
  });

  it("maps known template ids", () => {
    expect(resolveAopLayoutKind("leggings_v1", "generic")).toBe("leggings");
    expect(resolveAopLayoutKind("hoodie_v1", "leggings")).toBe("hoodie");
  });

  it("generic_aop_v1 defers to inferred layout (zip hoodie uses hoodie rules)", () => {
    expect(resolveAopLayoutKind("generic_aop_v1", "hoodie")).toBe("hoodie");
    expect(resolveAopLayoutKind("generic_aop_v1", "leggings")).toBe("leggings");
  });

  it("falls back to inferred for unknown template id", () => {
    const inferred: AopLayoutKind = "leggings";
    expect(resolveAopLayoutKind("unknown_vendor_v9", inferred)).toBe(inferred);
  });
});

describe("detectProductKind", () => {
  it("prefers hoodie layout when zip hoodie panels include a waistband", () => {
    expect(
      detectProductKind([
        { position: "front_right" },
        { position: "front_left" },
        { position: "right_hood" },
        { position: "left_hood" },
        { position: "waistband" },
      ]),
    ).toBe("hoodie");
  });

  it("treats spaced Printify position names as hoodie (front left / right)", () => {
    expect(
      detectProductKind([{ position: "Front Right" }, { position: "Front Left" }]),
    ).toBe("hoodie");
  });
});
