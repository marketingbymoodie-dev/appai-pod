import { describe, expect, it } from "vitest";
import {
  isContext1MockupLabel,
  isContextLikeMockupLabel,
  isOnPersonMockupLabel,
  lifestyleMockupPreferenceRank,
  normalizeMockupCameraLabel,
} from "./printifyMockupLabels";

describe("isContextLikeMockupLabel", () => {
  it("accepts lifestyle / context / room cameras", () => {
    expect(isContextLikeMockupLabel("lifestyle")).toBe(true);
    expect(isContextLikeMockupLabel("context-1")).toBe(true);
    expect(isContextLikeMockupLabel("Context 2")).toBe(true);
    expect(isContextLikeMockupLabel("context2")).toBe(true);
    expect(isContextLikeMockupLabel("Lifestyle Room")).toBe(true);
    expect(isContextLikeMockupLabel("bedroom")).toBe(true);
    expect(isContextLikeMockupLabel("wall")).toBe(true);
  });

  it("accepts Printify On Person lifestyle cameras", () => {
    expect(isContextLikeMockupLabel("On Person")).toBe(true);
    expect(isContextLikeMockupLabel("on+person")).toBe(true);
    expect(isContextLikeMockupLabel("on-person")).toBe(true);
    expect(isContextLikeMockupLabel("on-person-1-front")).toBe(true);
  });

  it("ranks On Person above Context 1 for Lifestyle Shot", () => {
    expect(lifestyleMockupPreferenceRank("on-person")).toBeLessThan(
      lifestyleMockupPreferenceRank("context-1"),
    );
    expect(lifestyleMockupPreferenceRank("on-person")).toBeLessThan(
      lifestyleMockupPreferenceRank("context-2"),
    );
    expect(isOnPersonMockupLabel("On Person")).toBe(true);
    expect(isContext1MockupLabel("context-1")).toBe(true);
    expect(isContext1MockupLabel("context-2")).toBe(false);
  });

  it("rejects flatlay and side-person cameras", () => {
    expect(isContextLikeMockupLabel("front")).toBe(false);
    expect(isContextLikeMockupLabel("front side")).toBe(false);
    expect(isContextLikeMockupLabel("side person")).toBe(false);
    expect(isContextLikeMockupLabel("front person")).toBe(false);
    expect(isContextLikeMockupLabel("back")).toBe(false);
  });
});

describe("normalizeMockupCameraLabel", () => {
  it("normalizes plus and underscores", () => {
    expect(normalizeMockupCameraLabel("Front+Side")).toBe("front side");
    expect(normalizeMockupCameraLabel("context_1")).toBe("context 1");
  });
});
