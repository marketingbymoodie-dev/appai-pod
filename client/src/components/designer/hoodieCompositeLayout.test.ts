import { describe, it, expect } from "vitest";
import { HOODIE_COMPOSITE_GAP_PX, HOODIE_L_R_SLOT_OVERLAP_PX, HOODIE_PREVIEW_PAD } from "./PatternCustomizer";

describe("hoodie 2-up layout constants", () => {
  it("L/R step pulls panels together (negative net gap vs GAP alone)", () => {
    const step = HOODIE_COMPOSITE_GAP_PX - HOODIE_L_R_SLOT_OVERLAP_PX;
    expect(step).toBe(0 - 700);
  });

  it("HOODIE_PREVIEW_PAD is shared for pad-aware scale", () => {
    expect(HOODIE_PREVIEW_PAD).toBe(4);
  });
});
