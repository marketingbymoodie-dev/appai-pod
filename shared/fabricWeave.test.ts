import { describe, expect, it } from "vitest";
import {
  resolveFabricWeaveTexture,
  WOVEN_WALL_TAPESTRY_BLUEPRINT_ID,
} from "./fabricWeave";

describe("resolveFabricWeaveTexture", () => {
  it("defaults woven wall tapestry blueprint on when unset", () => {
    expect(
      resolveFabricWeaveTexture({
        fabricWeaveTexture: null,
        printifyBlueprintId: WOVEN_WALL_TAPESTRY_BLUEPRINT_ID,
      }),
    ).toBe(true);
  });

  it("respects explicit false on tapestry blueprint", () => {
    expect(
      resolveFabricWeaveTexture({
        fabricWeaveTexture: false,
        printifyBlueprintId: WOVEN_WALL_TAPESTRY_BLUEPRINT_ID,
      }),
    ).toBe(false);
  });

  it("stays off for other blueprints unless admin-enabled", () => {
    expect(
      resolveFabricWeaveTexture({
        fabricWeaveTexture: null,
        printifyBlueprintId: 999,
      }),
    ).toBe(false);
    expect(
      resolveFabricWeaveTexture({
        fabricWeaveTexture: true,
        printifyBlueprintId: 999,
      }),
    ).toBe(true);
  });
});
