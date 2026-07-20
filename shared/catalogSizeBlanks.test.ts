import { describe, expect, it } from "vitest";
import {
  applyCatalogSizeBlanks,
  resolveBlankUrlForSize,
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
});
