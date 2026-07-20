import { describe, expect, it } from "vitest";
import { buildDecorOrientationShortConstraint } from "./client";

describe("buildDecorOrientationShortConstraint", () => {
  it("locks landscape canvases against side letterboxing", () => {
    const s = buildDecorOrientationShortConstraint("3:2");
    expect(s).toContain("LANDSCAPE");
    expect(s).toMatch(/white|empty bars/i);
    expect(s).toMatch(/full width/i);
  });

  it("locks portrait canvases against top/bottom letterboxing", () => {
    const s = buildDecorOrientationShortConstraint("2:3");
    expect(s).toContain("PORTRAIT");
    expect(s).toMatch(/full height/i);
  });

  it("handles square", () => {
    expect(buildDecorOrientationShortConstraint("1:1")).toContain("SQUARE");
  });
});
