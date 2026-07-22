import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { stripLetterboxBars } from "./stripLetterboxBars";

async function makeLetterboxedLandscape(): Promise<Buffer> {
  // 300x200 canvas: cream bars 40px each side, blue content in middle
  const w = 300;
  const h = 200;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (x < 40 || x >= 260) {
        raw[i] = 232;
        raw[i + 1] = 211;
        raw[i + 2] = 169;
      } else {
        raw[i] = 40;
        raw[i + 1] = 80;
        raw[i + 2] = 160;
      }
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe("stripLetterboxBars", () => {
  it("crops cream side bars and stretches content to full canvas", async () => {
    const input = await makeLetterboxedLandscape();
    const result = await stripLetterboxBars(input);
    expect(result.changed).toBe(true);
    expect(result.left).toBeGreaterThanOrEqual(35);
    expect(result.right).toBeGreaterThanOrEqual(35);

    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(300);
    expect(meta.height).toBe(200);

    const { data, info } = await sharp(result.buffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // Left edge should now be blue-ish content, not cream
    const i = 0;
    expect(data[i + 2]).toBeGreaterThan(120);
    expect(data[i]).toBeLessThan(100);
    void info;
  });

  it("leaves full-bleed art unchanged", async () => {
    const full = await sharp({
      create: {
        width: 200,
        height: 120,
        channels: 3,
        background: { r: 20, g: 90, b: 180 },
      },
    })
      .png()
      .toBuffer();
    const result = await stripLetterboxBars(full);
    expect(result.changed).toBe(false);
  });

  it("strips wide soft off-white side bars (vintage landscape bias)", async () => {
    // 40% total side bars with mild grain — previously above maxBarFraction / variance.
    const w = 400;
    const h = 240;
    const bar = 80;
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        if (x < bar || x >= w - bar) {
          const n = ((x * 17 + y * 31) % 7) - 3;
          raw[i] = 210 + n;
          raw[i + 1] = 205 + n;
          raw[i + 2] = 195 + n;
        } else {
          raw[i] = 30;
          raw[i + 1] = 70;
          raw[i + 2] = 140;
        }
      }
    }
    const input = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
      .png()
      .toBuffer();
    const result = await stripLetterboxBars(input);
    expect(result.changed).toBe(true);
    expect(result.left + result.right).toBeGreaterThanOrEqual(140);
  });
});
