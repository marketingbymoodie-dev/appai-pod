import { describe, expect, it } from "vitest";
import {
  resolveFlatBakePlacementRect,
  resolveFlatPrintFileDims,
} from "./flat-calibration";

const decorManifest = {
  productTypeId: 1,
  name: "Framed",
  blueprintId: 1,
  providerId: 1,
  tier: "flat" as const,
  decorPerSize: true,
  views: {
    front: {
      printFileDims: { width: 3000, height: 4000 },
      visibleRectNormalized: { x: 0.15, y: 0.2, width: 0.7, height: 0.55 },
      mockupDims: { width: 1000, height: 1200 },
      maskUrl: null,
      shadingUrl: null,
      shadingMode: "blank" as const,
      meshNodes: null,
      meshGrid: null,
      planarityScore: null,
      coverage: null,
    },
  },
  blanks: {},
  representativeGeometry: true,
  generatedAt: "",
};

describe("resolveFlatBakePlacementRect decorPerSize", () => {
  it("uses full print canvas (no mockup-rect letterbox)", () => {
    const rect = resolveFlatBakePlacementRect(decorManifest as any, "front", {
      sizeId: "16x20",
      frameColorId: "white",
    });
    expect(rect).toEqual({ x: 0, y: 0, width: 3000, height: 4000 });
  });
});

describe("resolveFlatPrintFileDims landscape", () => {
  it("swaps portrait harvest dims for landscape size ids", () => {
    const dims = resolveFlatPrintFileDims(decorManifest as any, "front", {
      sizeId: "36x24",
      frameColorId: "white",
    });
    expect(dims).toEqual({ width: 4000, height: 3000 });
  });

  it("keeps portrait dims for portrait size ids", () => {
    const dims = resolveFlatPrintFileDims(decorManifest as any, "front", {
      sizeId: "16x20",
      frameColorId: "white",
    });
    expect(dims).toEqual({ width: 3000, height: 4000 });
  });
});
