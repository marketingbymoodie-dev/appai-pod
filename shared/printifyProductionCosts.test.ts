import { describe, expect, it } from "vitest";
import {
  extractCostsFromCatalogVariants,
  extractCostsFromPrintifyProduct,
  extractPrintifyVariantCostCents,
  parsePrintifyCostsCache,
  serializePrintifyCostsCache,
} from "./printifyProductionCosts";

describe("printifyProductionCosts", () => {
  it("reads direct cost on catalog variants", () => {
    const costs = extractCostsFromCatalogVariants([
      { id: 101, title: "Black / S", cost: 899 },
      { id: 102, title: "Black / M", cost: 949 },
    ]);
    expect(costs).toEqual({ "101": 899, "102": 949 });
  });

  it("reads priceTag.cost when present", () => {
    expect(extractPrintifyVariantCostCents({ id: 1, priceTag: { cost: 1234 } })).toBe(1234);
    expect(extractPrintifyVariantCostCents({ variant_id: 2, price_tag: { cost: "567" } })).toBe(567);
  });

  it("extracts costs from shop product payloads", () => {
    const costs = extractCostsFromPrintifyProduct({
      variants: [{ id: 55, cost: 400, price: 1999 }],
    });
    expect(costs).toEqual({ "55": 400 });
  });

  it("round-trips cache serialization", () => {
    const raw = serializePrintifyCostsCache({ "1": 500 });
    const { costs, fetchedAt } = parsePrintifyCostsCache(raw);
    expect(costs).toEqual({ "1": 500 });
    expect(fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
