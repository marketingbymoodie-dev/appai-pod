import { describe, expect, it } from "vitest";
import {
  applyCatalogSizeBlanks,
  resolveBlankUrlForSize,
  visibleRectForCatalogSizeAspect,
} from "./catalogSizeBlanks";

describe("catalogSizeBlanks", () => {
  const blanksBySize = {
    "68x88": "https://cdn.example/68x88.png",
    "104x88": "https://cdn.example/104x88.png",
    "88x88": "https://cdn.example/88x88.png",
  };

  it("resolves exact size key from id/name", () => {
    const images = { blanksBySize };
    expect(
      resolveBlankUrlForSize(images, { id: "68x88", name: '68" x 88"' }),
    ).toBe(blanksBySize["68x88"]);
    expect(
      resolveBlankUrlForSize(images, {
        id: `104''_x_88"`,
        name: `104'' x 88"`,
      }),
    ).toBe(blanksBySize["104x88"]);
  });

  it("falls back by orientation when exact size missing", () => {
    const images = { blanksBySize };
    expect(
      resolveBlankUrlForSize(images, { id: "88x68", name: '88" x 68"' }),
    ).toBe(blanksBySize["104x88"]);
  });

  it("applies primary + gallery covering orientations", () => {
    const next = applyCatalogSizeBlanks({}, blanksBySize);
    expect(next.primary).toBe(blanksBySize["68x88"]);
    expect(next.blanksBySize).toEqual(blanksBySize);
    expect(next.gallery).toContain(blanksBySize["104x88"]);
    expect(next.gallery).toContain(blanksBySize["88x88"]);
  });

  it("synthesizes wall-decal sheet guides for 3:4 and 4:3 (not 2:3 landscape swap)", () => {
    const p18x24 = visibleRectForCatalogSizeAspect("3:4");
    expect(p18x24).toBeTruthy();
    expect(p18x24!.width / p18x24!.height).toBeCloseTo(0.75, 2);
    expect(p18x24!.height).toBeCloseTo(0.75, 2);

    const l24x18 = visibleRectForCatalogSizeAspect("4:3");
    expect(l24x18).toBeTruthy();
    expect(l24x18!.width / l24x18!.height).toBeCloseTo(4 / 3, 2);
    expect(l24x18!.width).toBeCloseTo(0.75, 2);

    // Must NOT match 2:3 / 3:2 (the shared-harvest failure mode).
    expect(p18x24!.width / p18x24!.height).not.toBeCloseTo(2 / 3, 2);
    expect(l24x18!.width / l24x18!.height).not.toBeCloseTo(3 / 2, 2);

    const p12x18 = visibleRectForCatalogSizeAspect("2:3");
    expect(p12x18!.width).toBeCloseTo(0.5, 2);
    expect(p12x18!.height).toBeCloseTo(0.75, 2);
  });
});
