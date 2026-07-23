import { describe, expect, it } from "vitest";
import {
  isContextLikeMockupLabel,
  normalizeMockupCameraLabel,
} from "./printifyMockupLabels";

describe("isContextLikeMockupLabel", () => {
  it("accepts lifestyle / context / room cameras", () => {
    expect(isContextLikeMockupLabel("lifestyle")).toBe(true);
    expect(isContextLikeMockupLabel("context-1")).toBe(true);
    expect(isContextLikeMockupLabel("Lifestyle Room")).toBe(true);
    expect(isContextLikeMockupLabel("bedroom")).toBe(true);
    expect(isContextLikeMockupLabel("wall")).toBe(true);
  });

  it("rejects flatlay and on-model side cameras", () => {
    expect(isContextLikeMockupLabel("front")).toBe(false);
    expect(isContextLikeMockupLabel("front side")).toBe(false);
    expect(isContextLikeMockupLabel("side person")).toBe(false);
    expect(isContextLikeMockupLabel("back")).toBe(false);
  });
});

describe("normalizeMockupCameraLabel", () => {
  it("normalizes plus and underscores", () => {
    expect(normalizeMockupCameraLabel("Front+Side")).toBe("front side");
    expect(normalizeMockupCameraLabel("context_1")).toBe("context 1");
  });
});
