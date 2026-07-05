import { describe, expect, it } from "vitest";
import { AUTO_TRIM_MARGIN_RATIO, expandCropRect, setCropSizeKeepCenter } from "./mockupCrop";

describe("mockupCrop", () => {
  it("expands auto-trim box by margin ratio", () => {
    const tight = { x: 100, y: 100, width: 500, height: 500 };
    const expanded = expandCropRect(tight, AUTO_TRIM_MARGIN_RATIO, 1200, 1200);
    expect(expanded.width).toBeGreaterThan(tight.width);
    expect(expanded.x).toBeLessThan(tight.x);
    expect(expanded.width).toBe(Math.round(tight.width * (1 + AUTO_TRIM_MARGIN_RATIO * 2)));
  });

  it("keeps center when setting square size", () => {
    const rect = { x: 250, y: 250, width: 700, height: 699 };
    const next = setCropSizeKeepCenter(rect, 700, 700, 1200, 1200);
    expect(next.width).toBe(700);
    expect(next.height).toBe(700);
    const cx = next.x + next.width / 2;
    const cy = next.y + next.height / 2;
    expect(cx).toBeCloseTo(250 + 700 / 2, 0);
    expect(cy).toBeCloseTo(250 + 699 / 2, 0);
  });
});
