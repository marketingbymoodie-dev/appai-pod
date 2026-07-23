import { describe, expect, it } from "vitest";
import {
  aopDesignColorRequirement,
  apparelMotifDesignColors,
  buildAopPatternSizingRequirements,
  buildAopSizingRequirements,
  buildDecorTextEdgeRestrictions,
  buildDecorTextSafeMarginShortConstraint,
  buildOrientationCompositionExtra,
  filterStyleReferenceUrls,
  hasUserArtworkDescription,
  shouldUseStyleReferenceImage,
  styleAllowsGeneratedText,
  styleIsPatternMaker,
  useCylindricalWrapPrompt,
  userPromptRequestsMonochrome,
} from "./generationPromptHints";

describe("generationPromptHints", () => {
  it("detects user artwork descriptions", () => {
    expect(hasUserArtworkDescription("black and white jungle patterns")).toBe(true);
    expect(hasUserArtworkDescription("  hi ")).toBe(false);
    expect(hasUserArtworkDescription("")).toBe(false);
  });

  it("detects monochrome requests", () => {
    expect(userPromptRequestsMonochrome("black and white jungle patterns")).toBe(true);
    expect(userPromptRequestsMonochrome("B&W geometric")).toBe(true);
    expect(userPromptRequestsMonochrome("colorful jungle")).toBe(false);
  });

  it("uses B&W color rules for AOP when requested", () => {
    const line = aopDesignColorRequirement("black and white jungle patterns");
    expect(line).toContain("ONLY black, white, and grey");
    expect(line).not.toContain("VIBRANT, BOLD");
  });

  it("buildAopSizingRequirements embeds B&W line", () => {
    const block = buildAopSizingRequirements("black and white jungle patterns");
    expect(block).toContain("ONLY black, white, and grey");
    expect(block).toContain("STRICT PROMPT ADHERENCE");
  });

  it("apparelMotifDesignColors respects monochrome", () => {
    expect(apparelMotifDesignColors("black and white stripes", false)).toContain("ONLY black, white, and grey");
    expect(apparelMotifDesignColors("sunset palm trees", false)).toContain("VIBRANT");
  });

  it("skips style reference image when user typed a subject", () => {
    expect(shouldUseStyleReferenceImage("black and white jungle patterns", false)).toBe(false);
    expect(shouldUseStyleReferenceImage("", false)).toBe(true);
    expect(shouldUseStyleReferenceImage("short", false)).toBe(false);
    expect(shouldUseStyleReferenceImage("ab", false)).toBe(true);
    expect(shouldUseStyleReferenceImage("black and white jungle patterns", true)).toBe(true);
  });

  it("filterStyleReferenceUrls drops preset samples for typed prompts", () => {
    const urls = ["https://example.com/skull-icon.png"];
    expect(filterStyleReferenceUrls(urls, "black and white jungle patterns", false)).toEqual([]);
    expect(filterStyleReferenceUrls(urls, "black and white jungle patterns", true)).toEqual(urls);
    expect(filterStyleReferenceUrls(urls, "", false)).toEqual(urls);
  });

  it("buildAopPatternSizingRequirements targets tileable repeats", () => {
    const block = buildAopPatternSizingRequirements("rainbow pattern");
    expect(block).toContain("TILEABLE REPEATING UNIT");
    expect(block).not.toContain("SINGLE, centered");
  });

  it("styleIsPatternMaker detects pattern maker styles", () => {
    expect(styleIsPatternMaker("Pattern Maker", "Create a repeating pattern of")).toBe(true);
    expect(styleIsPatternMaker("Minimalist Icon", "Create a minimal icon of")).toBe(false);
  });

  it("does not treat landscape framed posters as cylindrical wrap", () => {
    expect(
      useCylindricalWrapPrompt({ designerType: "framed-print", isKnownWrapAround: true }),
    ).toBe(false);
    expect(useCylindricalWrapPrompt({ designerType: "mug", isKnownWrapAround: false })).toBe(true);
    expect(
      useCylindricalWrapPrompt({ designerType: "hard-goods", isKnownWrapAround: true }),
    ).toBe(true);
  });

  it("locks landscape framed composition against side letterboxing", () => {
    const block = buildOrientationCompositionExtra(1.25, "framed-print");
    expect(block).toContain("ORIENTATION LOCK — LANDSCAPE");
    expect(block).toContain("blank white/empty side margins");
    expect(buildOrientationCompositionExtra(1.25, "mug")).toBe("");
  });

  it("also locks landscape for generic wall decals (not only framed-print)", () => {
    const block = buildOrientationCompositionExtra(1.5, "generic");
    expect(block).toContain("ORIENTATION LOCK — LANDSCAPE");
    expect(buildOrientationCompositionExtra(0.67, "generic")).toContain(
      "ORIENTATION LOCK — PORTRAIT",
    );
    expect(buildOrientationCompositionExtra(1.5, "apparel")).toBe("");
  });

  it("detects text-friendly styles like Vintage Poster", () => {
    expect(styleAllowsGeneratedText("Vintage Poster", "period typography")).toBe(true);
    expect(styleAllowsGeneratedText("Opinionated", "bold stacked text typography")).toBe(true);
    expect(styleAllowsGeneratedText("Minimalist Icon", "simple icon")).toBe(false);
  });

  it("requires a 5% text-free border on flat decor", () => {
    const block = buildDecorTextEdgeRestrictions(false);
    expect(block).toContain("5%");
    expect(buildDecorTextSafeMarginShortConstraint()).toContain("5%");
  });
});
