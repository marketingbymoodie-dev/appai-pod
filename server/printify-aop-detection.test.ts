import { describe, expect, it } from "vitest";
import { detectPrintifyAllOverPrint } from "./printify-aop-detection";

describe("detectPrintifyAllOverPrint", () => {
  it("does not treat non-AOP apparel with sleeve/neck-label print areas as AOP", () => {
    const isAop = detectPrintifyAllOverPrint({
      name: "Unisex Sweatshirt",
      description: "Print areas: front, left_sleeve, right_sleeve, neck_label",
      blueprintId: 449,
    });

    expect(isAop).toBe(false);
  });

  it("detects explicit (AOP) marker in product name", () => {
    const isAop = detectPrintifyAllOverPrint({
      name: "Unisex Hoodie (AOP)",
      description: "Premium fleece hoodie",
      blueprintId: 99999,
    });

    expect(isAop).toBe(true);
  });

  it("keeps known AOP blueprint exceptions marked as AOP", () => {
    const isAop = detectPrintifyAllOverPrint({
      name: "Women's Capri Leggings",
      description: "No explicit marker in title",
      blueprintId: 1050,
    });

    expect(isAop).toBe(true);
  });

  it("keeps standard front/back products non-AOP unless explicitly marked", () => {
    const isAop = detectPrintifyAllOverPrint({
      name: "Classic T-Shirt",
      description: "Front and back print areas",
      blueprintId: 42,
    });

    expect(isAop).toBe(false);
  });
});

