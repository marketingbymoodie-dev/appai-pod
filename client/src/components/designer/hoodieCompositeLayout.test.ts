import { describe, it, expect } from "vitest";
import {
  HOODIE_COMPOSITE_GAP_PX,
  HOODIE_FRONT_CENTER_GAP_PX,
  HOODIE_HOOD_CENTER_GAP_PX,
  HOODIE_PREVIEW_PAD,
} from "./PatternCustomizer";

describe("hoodie 2-up layout constants", () => {
  it("front and hood use simple positive print-px gaps", () => {
    expect(HOODIE_COMPOSITE_GAP_PX).toBe(0);
    expect(HOODIE_FRONT_CENTER_GAP_PX).toBe(200);
    expect(HOODIE_HOOD_CENTER_GAP_PX).toBe(800);
    expect(HOODIE_FRONT_CENTER_GAP_PX).toBeLessThan(HOODIE_HOOD_CENTER_GAP_PX);
  });

  it("HOODIE_PREVIEW_PAD is shared for pad-aware scale", () => {
    expect(HOODIE_PREVIEW_PAD).toBe(2);
  });
});
