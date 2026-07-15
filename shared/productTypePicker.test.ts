import { describe, expect, it } from "vitest";
import { dedupeProductTypesForPicker } from "./productTypePicker";

describe("dedupeProductTypesForPicker", () => {
  it("keeps one row per blueprint+provider (newest id wins)", () => {
    const out = dedupeProductTypesForPicker([
      { id: 10, name: "Unisex Zip Hoodie (AOP)", printifyBlueprintId: 99, printifyProviderId: 1, sortOrder: 0 },
      { id: 25, name: "Unisex Zip Hoodie (AOP)", printifyBlueprintId: 99, printifyProviderId: 1, sortOrder: 0 },
      { id: 5, name: "Tumbler 20oz", printifyBlueprintId: 1, printifyProviderId: 2, sortOrder: 1 },
    ]);
    expect(out.map((p) => p.id)).toEqual([25, 5]);
  });

  it("does not merge different providers for the same blueprint", () => {
    const out = dedupeProductTypesForPicker([
      { id: 1, name: "Hoodie A", printifyBlueprintId: 99, printifyProviderId: 1 },
      { id: 2, name: "Hoodie B", printifyBlueprintId: 99, printifyProviderId: 2 },
    ]);
    expect(out).toHaveLength(2);
  });

  it("keeps rows without a blueprint distinct by id", () => {
    const out = dedupeProductTypesForPicker([
      { id: 1, name: "Custom", printifyBlueprintId: null },
      { id: 2, name: "Custom", printifyBlueprintId: null },
    ]);
    expect(out).toHaveLength(2);
  });
});
