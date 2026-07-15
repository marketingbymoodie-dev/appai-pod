import { describe, expect, it } from "vitest";
import {
  detectStylePromptMismatch,
  resolveSuggestedStylePresets,
  userPromptRequestsPattern,
} from "./stylePromptCompatibility";

const MINIMALIST_ICON_PREFIX =
  "T-shirt graphic, minimalist icon, vector style, bold clean outlines, flat solid vibrant colors (avoid white and light colors in the design), high contrast, centered, isolated on plain white background, no shadow, no texture, no gradient background, hard edges, flat lighting, simple geometric shapes. Create a minimal icon of";

describe("stylePromptCompatibility", () => {
  it("detects pattern requests", () => {
    expect(userPromptRequestsPattern("black and white jungle patterns")).toBe(true);
    expect(userPromptRequestsPattern("a scary bear")).toBe(false);
  });

  it("flags minimalist icon + B&W patterns prompt", () => {
    const mismatch = detectStylePromptMismatch(
      "black and white jungle patterns",
      MINIMALIST_ICON_PREFIX,
      "Minimalist Icon",
    );
    expect(mismatch).not.toBeNull();
    expect(mismatch!.reasons.length).toBeGreaterThanOrEqual(2);
    expect(mismatch!.suggestedStyleNames).toContain("Pattern Maker");
    expect(mismatch!.suggestedStyleNames).toContain("Free 4 All");
  });

  it("returns null for short prompts", () => {
    expect(
      detectStylePromptMismatch("cat", MINIMALIST_ICON_PREFIX, "Minimalist Icon"),
    ).toBeNull();
  });

  it("returns null when style is unconstrained", () => {
    expect(
      detectStylePromptMismatch("black and white jungle patterns", "", "Free 4 All"),
    ).toBeNull();
  });

  it("resolves merchant presets by canonical name", () => {
    const presets = [
      { id: "1", name: "Minimalist Icon" },
      { id: "2", name: "Pattern Maker" },
      { id: "3", name: "Free 4 All" },
    ];
    const resolved = resolveSuggestedStylePresets(
      presets,
      ["Pattern Maker", "Free 4 All"],
      "1",
    );
    expect(resolved.map((p) => p.name)).toEqual(["Pattern Maker", "Free 4 All"]);
  });
});
