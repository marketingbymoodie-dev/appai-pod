import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  processApparelMotif,
  analyzeAlphaQuality,
  CHROMA_KEY,
  cleanupFlatGraphicAlpha,
  removeChromaKeyBackground,
  resolveApparelStylePrefix,
  resolveGraphicsStylePrefix,
  resolveIsApparelGeneration,
  sanitizeApparelStylePrefix,
  isMagentaCanvasCorner,
} from "./apparel-matting";

async function rgbaBuffer(
  width: number,
  height: number,
  paint: (x: number, y: number, row: Uint8Array, offset: number) => void,
): Promise<Buffer> {
  const row = new Uint8Array(width * 4);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    row.fill(0);
    for (let x = 0; x < width; x++) {
      const o = x * 4;
      row[o] = 0;
      row[o + 1] = 0;
      row[o + 2] = 0;
      row[o + 3] = 255;
      paint(x, y, row, o);
    }
    rows.push(Buffer.from(row));
  }
  return sharp(Buffer.concat(rows), { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function alphaAt(buffer: Buffer, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const idx = (y * info.width + x) * info.channels;
  return data[idx + 3];
}

async function bufferCenter(buffer: Buffer): Promise<{ w: number; h: number; cx: number; cy: number }> {
  const meta = await sharp(buffer).metadata();
  const w = meta.width ?? 1;
  const h = meta.height ?? 1;
  return { w, h, cx: Math.floor(w / 2), cy: Math.floor(h / 2) };
}

describe("resolveIsApparelGeneration", () => {
  it("treats all-over-print designerType as chroma for non-decor styles", () => {
    expect(
      resolveIsApparelGeneration(
        { designerType: "all-over-print", isAllOverPrint: true },
        "all",
      ),
    ).toBe(true);
  });

  it("does not chroma-key decor styles on AOP pillows", () => {
    expect(
      resolveIsApparelGeneration({ designerType: "pillow", isAllOverPrint: true }, "decor"),
    ).toBe(false);
  });

  it("does not chroma-key decor styles on generic isAllOverPrint products", () => {
    expect(resolveIsApparelGeneration({ designerType: "generic", isAllOverPrint: true }, "decor")).toBe(
      false,
    );
  });

  it("uses chroma for apparel styles on AOP pillows", () => {
    expect(
      resolveIsApparelGeneration({ designerType: "pillow", isAllOverPrint: true }, "apparel"),
    ).toBe(true);
  });

  it("falls back to style category apparel", () => {
    expect(resolveIsApparelGeneration({ designerType: "generic" }, "apparel")).toBe(true);
  });

  it("uses chroma matting for graphics styles", () => {
    expect(resolveIsApparelGeneration({ designerType: "pillow" }, "graphics")).toBe(true);
    expect(resolveIsApparelGeneration({ designerType: "generic", isAllOverPrint: true }, "graphics")).toBe(
      true,
    );
  });
});

describe("sanitizeApparelStylePrefix", () => {
  it("replaces white background language with hot pink chroma", () => {
    const out = sanitizeApparelStylePrefix("Centered graphic on white background, bold colors");
    expect(out.toLowerCase()).toContain("#ff00ff");
    expect(out.toLowerCase()).not.toContain("white background");
  });
});

describe("resolveGraphicsStylePrefix", () => {
  it("uses canonical graphics prefix by preset id", () => {
    const out = resolveGraphicsStylePrefix(
      "Centered Graphic (Graphics)",
      "graphics-centered-graphic",
      "",
    );
    expect(out.toLowerCase()).toContain("#ff00ff");
    expect(out.toLowerCase()).not.toContain("t-shirt");
  });
});

describe("resolveApparelStylePrefix", () => {
  it("prefers chroma-safe DB prefix over repo fallback", () => {
    const dbCopy =
      "T-shirt graphic, illustrated character motif, custom merchant copy isolated on a solid hot pink (#FF00FF) background. Create an illustrated motif of";
    const out = resolveApparelStylePrefix("Illustrated Motif", dbCopy);
    expect(out).toContain("custom merchant copy");
    expect(out.toLowerCase()).toContain("#ff00ff");
  });

  it("falls back to canonical when DB prefix lacks chroma key", () => {
    const out = resolveApparelStylePrefix(
      "Illustrated Motif",
      "Illustrated character on white card background",
    );
    expect(out.toLowerCase()).toContain("#ff00ff");
    expect(out.toLowerCase()).toContain("do not use solid hot pink");
    expect(out.toLowerCase()).not.toContain("white card");
  });
});

describe("isMagentaCanvasCorner", () => {
  it("detects off-spec AI pink canvas corners", () => {
    expect(isMagentaCanvasCorner({ avgR: 232, avgG: 39, avgB: 127 })).toBe(true);
    expect(isMagentaCanvasCorner({ avgR: 255, avgG: 0, avgB: 255 })).toBe(true);
    expect(isMagentaCanvasCorner({ avgR: 255, avgG: 255, avgB: 255 })).toBe(false);
  });
});

describe("removeChromaKeyBackground", () => {
  it("keys pink canvas and keeps opaque subject", async () => {
    const src = await rgbaBuffer(64, 64, (x, y, row, o) => {
      const cx = 32;
      const cy = 32;
      const inCircle = (x - cx) ** 2 + (y - cy) ** 2 <= 12 ** 2;
      if (inCircle) {
        row[o] = 200;
        row[o + 1] = 40;
        row[o + 2] = 40;
      } else {
        row[o] = CHROMA_KEY.r;
        row[o + 1] = CHROMA_KEY.g;
        row[o + 2] = CHROMA_KEY.b;
      }
    });

    const { buffer, chromaRemovedPct } = await removeChromaKeyBackground(src);
    expect(chromaRemovedPct).toBeGreaterThan(10);
    expect(await alphaAt(buffer, 5, 5)).toBe(0);
    expect(await alphaAt(buffer, 32, 32)).toBeGreaterThan(200);
  });

  it("removes white mat on pink canvas via connected flood", async () => {
    const src = await rgbaBuffer(80, 80, (x, y, row, o) => {
      const inWhiteMat = x >= 20 && x <= 60 && y >= 20 && y <= 60;
      const inArt = (x - 40) ** 2 + (y - 40) ** 2 <= 8 ** 2;
      if (inArt) {
        row[o] = 30;
        row[o + 1] = 30;
        row[o + 2] = 180;
      } else if (inWhiteMat) {
        row[o] = 250;
        row[o + 1] = 250;
        row[o + 2] = 250;
      } else {
        row[o] = CHROMA_KEY.r;
        row[o + 1] = CHROMA_KEY.g;
        row[o + 2] = CHROMA_KEY.b;
      }
    });

    const { buffer } = await removeChromaKeyBackground(src, { allowWhiteKey: true });
    expect(await alphaAt(buffer, 25, 25)).toBe(0);
    expect(await alphaAt(buffer, 40, 40)).toBeGreaterThan(200);
    expect(await alphaAt(buffer, 2, 2)).toBe(0);
  });

  it("preserves internal white teeth and eyes on magenta canvas", async () => {
    const src = await rgbaBuffer(100, 100, (x, y, row, o) => {
      const inFace = (x - 50) ** 2 + (y - 50) ** 2 <= 22 ** 2;
      const inTeeth = y >= 58 && y <= 62 && x >= 42 && x <= 58;
      const inLeftEyeWhite = (x - 42) ** 2 + (y - 42) ** 2 <= 3 ** 2;
      const inRightEyeWhite = (x - 58) ** 2 + (y - 42) ** 2 <= 3 ** 2;
      if (inTeeth || inLeftEyeWhite || inRightEyeWhite) {
        row[o] = 255;
        row[o + 1] = 255;
        row[o + 2] = 255;
      } else if (inFace) {
        row[o] = 200;
        row[o + 1] = 40;
        row[o + 2] = 30;
      } else {
        row[o] = CHROMA_KEY.r;
        row[o + 1] = CHROMA_KEY.g;
        row[o + 2] = CHROMA_KEY.b;
      }
    });

    const { buffer } = await removeChromaKeyBackground(src, { allowWhiteKey: true });
    expect(await alphaAt(buffer, 5, 5)).toBe(0);
    expect(await alphaAt(buffer, 50, 60)).toBeGreaterThan(200);
    expect(await alphaAt(buffer, 42, 42)).toBeGreaterThan(200);
    expect(await alphaAt(buffer, 58, 42)).toBeGreaterThan(200);
  });

  it("processApparelMotif preserves internal whites after cleanup", async () => {
    const src = await rgbaBuffer(100, 100, (x, y, row, o) => {
      const inFace = (x - 50) ** 2 + (y - 50) ** 2 <= 22 ** 2;
      const inTeeth = y >= 58 && y <= 62 && x >= 42 && x <= 58;
      if (inTeeth) {
        row[o] = 255;
        row[o + 1] = 255;
        row[o + 2] = 255;
      } else if (inFace) {
        row[o] = 180;
        row[o + 1] = 30;
        row[o + 2] = 40;
      } else {
        row[o] = CHROMA_KEY.r;
        row[o + 1] = CHROMA_KEY.g;
        row[o + 2] = CHROMA_KEY.b;
      }
    });

    const result = await processApparelMotif(src, {
      useMlFallback: false,
      allowWhiteKey: true,
      vectorize: false,
    });
    const { w, h, cx } = await bufferCenter(result.buffer);
    expect(await alphaAt(result.buffer, cx, Math.min(h - 1, Math.floor(h * 0.65)))).toBeGreaterThan(200);
    expect(await alphaAt(result.buffer, 0, 0)).toBe(0);
  });

  it("keys enclosed pink pocket inside subject", async () => {
    const src = await rgbaBuffer(60, 60, (x, y, row, o) => {
      const outer = (x - 30) ** 2 + (y - 30) ** 2 <= 15 ** 2;
      const hole = (x - 30) ** 2 + (y - 30) ** 2 <= 5 ** 2;
      if (hole) {
        row[o] = CHROMA_KEY.r;
        row[o + 1] = CHROMA_KEY.g;
        row[o + 2] = CHROMA_KEY.b;
      } else if (outer) {
        row[o] = 180;
        row[o + 1] = 20;
        row[o + 2] = 20;
      } else {
        row[o] = CHROMA_KEY.r;
        row[o + 1] = CHROMA_KEY.g;
        row[o + 2] = CHROMA_KEY.b;
      }
    });

    const { buffer } = await removeChromaKeyBackground(src);
    expect(await alphaAt(buffer, 30, 30)).toBe(0);
    expect(await alphaAt(buffer, 30, 18)).toBeGreaterThan(200);
  });

  it("removes enclosed off-pink canvas pockets on magenta canvas while keeping enclosed purple art", async () => {
    const src = await rgbaBuffer(100, 100, (x, y, row, o) => {
      const inSubject = (x - 50) ** 2 + (y - 50) ** 2 <= 24 ** 2;
      // Enclosed pocket of leaked canvas pink, drifted past the tight tolerance
      // (Manhattan distance 40 from #FF00FF — outside Pass A's 28, inside expanded 55)
      const inPinkPocket = (x - 42) ** 2 + (y - 46) ** 2 <= 4 ** 2;
      // Enclosed purple design accent — far from the key (~170), must survive
      const inPurpleAccent = (x - 58) ** 2 + (y - 54) ** 2 <= 4 ** 2;
      if (inPinkPocket) {
        row[o] = 250;
        row[o + 1] = 30;
        row[o + 2] = 250;
      } else if (inPurpleAccent) {
        row[o] = 180;
        row[o + 1] = 40;
        row[o + 2] = 200;
      } else if (inSubject) {
        row[o] = 40;
        row[o + 1] = 130;
        row[o + 2] = 90;
      } else {
        row[o] = CHROMA_KEY.r;
        row[o + 1] = CHROMA_KEY.g;
        row[o + 2] = CHROMA_KEY.b;
      }
    });

    const { buffer } = await removeChromaKeyBackground(src);
    expect(await alphaAt(buffer, 5, 5)).toBe(0); // canvas removed
    expect(await alphaAt(buffer, 42, 46)).toBe(0); // enclosed off-pink pocket removed
    expect(await alphaAt(buffer, 58, 54)).toBeGreaterThan(200); // enclosed purple kept
    expect(await alphaAt(buffer, 50, 30)).toBeGreaterThan(200); // subject kept
  });

  it("removes full white canvas while keeping colored subject", async () => {
    const src = await rgbaBuffer(80, 80, (x, y, row, o) => {
      const inBear = (x - 40) ** 2 + (y - 40) ** 2 <= 14 ** 2;
      if (inBear) {
        row[o] = 120;
        row[o + 1] = 70;
        row[o + 2] = 20;
      } else {
        row[o] = 252;
        row[o + 1] = 252;
        row[o + 2] = 250;
      }
    });

    const { buffer, cornerIsLightCanvas } = await removeChromaKeyBackground(src, {
      allowWhiteKey: true,
      aggressiveWhiteKey: true,
      borderFloodFill: true,
    });
    expect(cornerIsLightCanvas).toBe(true);
    expect(await alphaAt(buffer, 2, 2)).toBe(0);
    expect(await alphaAt(buffer, 40, 40)).toBeGreaterThan(200);
  });

  it("removes off-pink magenta canvas (AI compression drift)", async () => {
    const src = await rgbaBuffer(80, 80, (x, y, row, o) => {
      const inDragon = (x - 40) ** 2 + (y - 40) ** 2 <= 12 ** 2;
      if (inDragon) {
        row[o] = 100;
        row[o + 1] = 40;
        row[o + 2] = 180;
      } else {
        // Slightly off #FF00FF — common from AI / JPEG
        row[o] = 255;
        row[o + 1] = 55;
        row[o + 2] = 255;
      }
    });

    const { buffer, cornerIsMagentaCanvas } = await removeChromaKeyBackground(src);
    expect(cornerIsMagentaCanvas).toBe(true);
    expect(await alphaAt(buffer, 5, 5)).toBe(0);
    expect(await alphaAt(buffer, 40, 40)).toBeGreaterThan(200);
  });

  it("preserves interior purple design colors on magenta canvas", async () => {
    const src = await rgbaBuffer(100, 100, (x, y, row, o) => {
      const inFlower = (x - 50) ** 2 + (y - 50) ** 2 <= 18 ** 2;
      const inPetal = (x - 38) ** 2 + (y - 42) ** 2 <= 6 ** 2;
      if (inPetal) {
        // Purple petal — must not be keyed (old heuristic treated this as background)
        row[o] = 180;
        row[o + 1] = 40;
        row[o + 2] = 200;
      } else if (inFlower) {
        row[o] = 80;
        row[o + 1] = 30;
        row[o + 2] = 120;
      } else {
        row[o] = CHROMA_KEY.r;
        row[o + 1] = CHROMA_KEY.g;
        row[o + 2] = CHROMA_KEY.b;
      }
    });

    const { buffer } = await removeChromaKeyBackground(src);
    expect(await alphaAt(buffer, 5, 5)).toBe(0);
    expect(await alphaAt(buffer, 38, 42)).toBeGreaterThan(200);
    expect(await alphaAt(buffer, 50, 50)).toBeGreaterThan(200);
  });

  it("processApparelMotif preserves purple after cleanup and despill", async () => {
    const src = await rgbaBuffer(100, 100, (x, y, row, o) => {
      const inSkull = (x - 50) ** 2 + (y - 50) ** 2 <= 20 ** 2;
      const inPurpleAccent = x >= 58 && x <= 68 && y >= 44 && y <= 54;
      if (inPurpleAccent) {
        row[o] = 200;
        row[o + 1] = 60;
        row[o + 2] = 210;
      } else if (inSkull) {
        row[o] = 40;
        row[o + 1] = 120;
        row[o + 2] = 160;
      } else {
        row[o] = CHROMA_KEY.r;
        row[o + 1] = CHROMA_KEY.g;
        row[o + 2] = CHROMA_KEY.b;
      }
    });

    const result = await processApparelMotif(src, {
      useMlFallback: false,
      allowWhiteKey: true,
      vectorize: false,
    });
    const { data, info } = await sharp(result.buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let purpleAccentOpaque = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const idx = (y * info.width + x) * info.channels;
        const a = data[idx + 3];
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        if (a > 200 && r > 150 && b > 150 && g < 100) purpleAccentOpaque++;
      }
    }
    expect(purpleAccentOpaque).toBeGreaterThan(20);
    expect(await alphaAt(result.buffer, 0, 0)).toBe(0);
  });

  it("processApparelMotif removes full hot pink plate for Illustrated Motif case", async () => {
    const src = await rgbaBuffer(100, 100, (x, y, row, o) => {
      const inPlate = x >= 15 && x <= 85 && y >= 15 && y <= 85;
      const inDragon = (x - 50) ** 2 + (y - 50) ** 2 <= 14 ** 2;
      if (inDragon) {
        row[o] = 80;
        row[o + 1] = 200;
        row[o + 2] = 60;
      } else if (inPlate) {
        row[o] = CHROMA_KEY.r;
        row[o + 1] = CHROMA_KEY.g;
        row[o + 2] = CHROMA_KEY.b;
      } else {
        row[o] = CHROMA_KEY.r;
        row[o + 1] = CHROMA_KEY.g;
        row[o + 2] = CHROMA_KEY.b;
      }
    });

    const result = await processApparelMotif(src, {
      useMlFallback: true,
      allowWhiteKey: true,
      vectorize: false,
    });
    expect(result.usedMlFallback).toBe(false);
    const { cx, cy } = await bufferCenter(result.buffer);
    expect(await alphaAt(result.buffer, 0, 0)).toBe(0);
    expect(await alphaAt(result.buffer, cx, cy)).toBeGreaterThan(200);
  });
});

describe("cleanupFlatGraphicAlpha", () => {
  it("binarizes soft alpha edges", async () => {
    const src = await rgbaBuffer(32, 32, (x, _y, row, o) => {
      if (x > 8 && x < 24) {
        row[o + 3] = 140;
        row[o] = 100;
        row[o + 1] = 100;
        row[o + 2] = 100;
      } else {
        row[o + 3] = 0;
      }
    });

    const cleaned = await cleanupFlatGraphicAlpha(src);
    const qa = await analyzeAlphaQuality(cleaned);
    expect(qa.softAlphaRatio).toBe(0);
  });
});

describe("cleanupFlatGraphicAlpha — magenta fringe", () => {
  it("removes darkened/desaturated pink fringe connected to background while preserving enclosed purple", async () => {
    const src = await rgbaBuffer(100, 100, (x, y, row, o) => {
      const dist = Math.sqrt((x - 50) ** 2 + (y - 50) ** 2);
      const inPurpleAccent = x >= 44 && x <= 52 && y >= 44 && y <= 52;
      const inCore = dist <= 18;
      const inHalo = dist > 18 && dist <= 22;
      if (inPurpleAccent) {
        // Enclosed by the teal core — never touches the removed background, must survive.
        row[o] = 190;
        row[o + 1] = 50;
        row[o + 2] = 200;
      } else if (inCore) {
        row[o] = 40;
        row[o + 1] = 120;
        row[o + 2] = 160;
      } else if (inHalo) {
        // Darkened/desaturated pink anti-alias ring: Manhattan distance to #FF00FF is
        // |140-255|+|10-0|+|140-255| = 240, far past even the expanded (55) tolerance, but
        // the hue is unmistakably chroma-pink (~300deg) and it's connected to the already
        // background (alpha 0) region below.
        row[o] = 140;
        row[o + 1] = 10;
        row[o + 2] = 140;
      } else {
        row[o + 3] = 0; // already-keyed background
      }
    });

    const cleaned = await cleanupFlatGraphicAlpha(src);
    expect(await alphaAt(cleaned, 50, 70)).toBe(0); // halo ring (dist 20) removed
    expect(await alphaAt(cleaned, 50, 35)).toBeGreaterThan(200); // teal core (dist 15) kept
    expect(await alphaAt(cleaned, 48, 48)).toBeGreaterThan(200); // enclosed purple accent kept
  });
});

describe("processApparelMotif", () => {
  it("does not use ML fallback on full white canvas", async () => {
    const src = await rgbaBuffer(64, 64, (x, y, row, o) => {
      const inSubject = (x - 32) ** 2 + (y - 32) ** 2 <= 10 ** 2;
      if (inSubject) {
        row[o] = 200;
        row[o + 1] = 50;
        row[o + 2] = 30;
      } else {
        row[o] = 255;
        row[o + 1] = 255;
        row[o + 2] = 255;
      }
    });

    const result = await processApparelMotif(src, {
      useMlFallback: true,
      allowWhiteKey: true,
      vectorize: false,
    });
    expect(result.usedMlFallback).toBe(false);
    const { cx, cy } = await bufferCenter(result.buffer);
    expect(await alphaAt(result.buffer, 0, 0)).toBe(0);
    expect(await alphaAt(result.buffer, cx, cy)).toBeGreaterThan(200);
  });
});

describe("analyzeAlphaQuality", () => {
  it("flags images with many semi-transparent pixels", async () => {
    const src = await rgbaBuffer(40, 40, (_x, _y, row, o) => {
      row[o + 3] = 128;
      row[o] = 100;
      row[o + 1] = 50;
      row[o + 2] = 50;
    });

    const qa = await analyzeAlphaQuality(src);
    expect(qa.softAlphaRatio).toBeGreaterThan(0.9);
  });
});
