import { describe, it, expect } from "vitest";
import {
  HOODIE_COMPOSITE_GAP_PX,
  HOODIE_FRONT_MAX_SLOT_OVERLAP_PX,
  HOODIE_HOOD_CENTER_GAP_PX,
  HOODIE_PREVIEW_PAD,
} from "./PatternCustomizer";

describe("hoodie 2-up layout constants", () => {
  it("front and hood use different center spacing rules", () => {
    expect(HOODIE_COMPOSITE_GAP_PX).toBe(0);
    expect(HOODIE_FRONT_MAX_SLOT_OVERLAP_PX).toBe(450);
    expect(HOODIE_HOOD_CENTER_GAP_PX).toBe(140);
  });

  it("HOODIE_PREVIEW_PAD is shared for pad-aware scale", () => {
    expect(HOODIE_PREVIEW_PAD).toBe(2);
  });
});
