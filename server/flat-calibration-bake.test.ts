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

describe("resolveFlatPrintFileDims catalog size blanks (wall decals)", () => {
  const wallDecalManifest = {
    ...decorManifest,
    blueprintId: 759,
    name: "Wall Decals",
    decorPerSize: false,
    views: {
      front: {
        ...decorManifest.views.front,
        // Shared harvest from 12×18 (2:3) — must not win over size inches.
        printFileDims: { width: 2400, height: 3600 },
      },
    },
  };

  it("uses 3:4 print dims for 18x24 (not shared 2:3)", () => {
    const dims = resolveFlatPrintFileDims(wallDecalManifest as any, "front", {
      sizeId: "18x24",
    });
    expect(dims).toEqual({ width: 2700, height: 3600 });
  });

  it("uses 4:3 for 24x18 (not landscape-swapped 3:2)", () => {
    const dims = resolveFlatPrintFileDims(wallDecalManifest as any, "front", {
      sizeId: "24x18",
    });
    expect(dims).toEqual({ width: 3600, height: 2700 });
    // Axis-swap of 2400×3600 would be 3600×2400 (3:2) — wrong.
    expect(dims).not.toEqual({ width: 3600, height: 2400 });
  });
});
