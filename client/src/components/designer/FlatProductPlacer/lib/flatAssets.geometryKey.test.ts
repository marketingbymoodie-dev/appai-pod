import { describe, expect, it } from "vitest";
import { findGeometryBlankKey, resolveFlatViewCalibration } from "./flatAssets";
import type { FlatCalibrationManifest } from "@/pages/embed-design";

function posterManifest(): FlatCalibrationManifest {
  return {
    productTypeId: 1,
    name: "Framed Vertical Poster",
    blueprintId: 1,
    providerId: 1,
    tier: "flat",
    views: {
      front: {
        maskUrl: "https://example.com/shared-11x14-mask.png",
        printFileDims: { width: 3300, height: 4200 },
        mockupDims: { width: 1000, height: 1273 },
        visibleRectNormalized: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      } as any,
    },
    blanks: {
      "11x14:black": { front: "https://example.com/11x14-b.png" },
      "20x30:black": { front: "https://example.com/20x30-b.png" },
      "16x16:white": { front: "https://example.com/16x16-w.png" },
    },
    geometryByBlank: {
      "11x14:black": {
        front: {
          maskUrl: "https://example.com/11x14-mask.png",
          printFileDims: { width: 3300, height: 4200 },
        },
      },
      "20x30:black": {
        front: {
          maskUrl: "https://example.com/20x30-mask.png",
          printFileDims: { width: 4800, height: 7200 },
        },
      },
      "16x16:white": {
        front: {
          maskUrl: "https://example.com/16x16-mask.png",
          printFileDims: { width: 4800, height: 4800 },
        },
      },
    },
    representativeGeometry: true,
    decorPerSize: true,
    generatedAt: new Date().toISOString(),
  };
}

describe("findGeometryBlankKey / decorPerSize size-only lookup", () => {
  it("resolves size-only placement key to size:color geometry", () => {
    const m = posterManifest();
    expect(findGeometryBlankKey(m, "20x30")).toBe("20x30:black");
    expect(findGeometryBlankKey(m, "16x16")).toBe("16x16:white");
    expect(findGeometryBlankKey(m, "20x30:black")).toBe("20x30:black");
  });

  it("uses per-size mask for size-only key instead of shared 11x14 mask", () => {
    const m = posterManifest();
    const calib = resolveFlatViewCalibration(m, "20x30", "front");
    expect(calib?.maskUrl).toBe("https://example.com/20x30-mask.png");
    expect(calib?.printFileDims).toEqual({ width: 4800, height: 7200 });
  });

  it("falls back to dimension-swapped size for landscape HFP keys", () => {
    const m = posterManifest();
    // 30x20 is landscape twin of harvested 20x30
    expect(findGeometryBlankKey(m, "30x20")).toBe("20x30:black");
    expect(findGeometryBlankKey(m, "30x20:black")).toBe("20x30:black");
  });
});

describe("resolveFlatViewCalibration catalog size blank refit", () => {
  function wallDecalManifest(): FlatCalibrationManifest {
    return {
      productTypeId: 759,
      name: "Wall Decals",
      blueprintId: 759,
      providerId: 1,
      tier: "flat",
      views: {
        front: {
          maskUrl: "https://example.com/shared-2x3-mask.png",
          // Shared harvest from 12×18 (2:3) — the wall-decal failure mode.
          printFileDims: { width: 2400, height: 3600 },
          mockupDims: { width: 1024, height: 1024 },
          visibleRectNormalized: { x: 0.25, y: 0.127, width: 0.5, height: 0.746 },
        } as any,
      },
      blanks: {
        default: { front: "https://example.com/harvest-default.png" },
      },
      representativeGeometry: true,
      decorPerSize: false,
      generatedAt: new Date().toISOString(),
    };
  }

  it("refits 18×24 guide to 3:4 instead of shared 2:3", () => {
    const m = wallDecalManifest();
    const calib = resolveFlatViewCalibration(m, "default", "front", {
      sizeAspectRatio: "3:4",
      refitCatalogSizeGuide: true,
    });
    expect(calib?.visibleRectNormalized).toBeTruthy();
    const r = calib!.visibleRectNormalized!;
    expect(r.width / r.height).toBeCloseTo(0.75, 2);
    expect(r.height).toBeCloseTo(0.75, 2);
    expect(r.width / r.height).not.toBeCloseTo(2 / 3, 2);
  });

  it("refits 24×18 to 4:3 (not landscape-swapped 3:2)", () => {
    const m = wallDecalManifest();
    const calib = resolveFlatViewCalibration(m, "default", "front", {
      landscapeOrientation: true,
      sizeAspectRatio: "4:3",
      refitCatalogSizeGuide: true,
    });
    const r = calib!.visibleRectNormalized!;
    expect(r.width / r.height).toBeCloseTo(4 / 3, 2);
    expect(r.width).toBeCloseTo(0.75, 2);
    expect(r.width / r.height).not.toBeCloseTo(1.5, 2);
  });
});
