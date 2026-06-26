import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  processApparelMotif,
  analyzeAlphaQuality,
  CHROMA_KEY,
  cleanupFlatGraphicAlpha,
  removeChromaKeyBackground,
  resolveApparelStylePrefix,
  sanitizeApparelStylePrefix,
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

describe("sanitizeApparelStylePrefix", () => {
  it("replaces white background language with hot pink chroma", () => {
    const out = sanitizeApparelStylePrefix("Centered graphic on white background, bold colors");
    expect(out.toLowerCase()).toContain("#ff00ff");
    expect(out.toLowerCase()).not.toContain("white background");
  });
});

describe("resolveApparelStylePrefix", () => {
  it("replaces Illustrated Motif DB prefix with canonical chroma copy", () => {
    const out = resolveApparelStylePrefix(
      "Illustrated Motif",
      "Illustrated character on white card background",
    );
    expect(out.toLowerCase()).toContain("#ff00ff");
    expect(out.toLowerCase()).not.toContain("white card");
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

  it("removes white mat on pink canvas (pass C)", async () => {
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

    const result = await processApparelMotif(src, { useMlFallback: true, allowWhiteKey: true });
    expect(result.usedMlFallback).toBe(false);
    expect(await alphaAt(result.buffer, 20, 20)).toBe(0);
    expect(await alphaAt(result.buffer, 50, 50)).toBeGreaterThan(200);
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

    const result = await processApparelMotif(src, { useMlFallback: true, allowWhiteKey: true });
    expect(result.usedMlFallback).toBe(false);
    expect(await alphaAt(result.buffer, 4, 4)).toBe(0);
    expect(await alphaAt(result.buffer, 32, 32)).toBeGreaterThan(200);
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
