import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { prepareBakeUploadBuffer } from "./flat-print-file";

describe("prepareBakeUploadBuffer", () => {
  it("passes through small PNGs unchanged", async () => {
    const small = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const out = await prepareBakeUploadBuffer(small);
    expect(out.ext).toBe("png");
    expect(out.contentType).toBe("image/png");
    expect(out.buffer.length).toBe(small.length);
  });

  it("compresses oversized buffers under the soft max", async () => {
    // Uncompressible random noise at large dimensions → huge PNG.
    const noise = Buffer.alloc(4800 * 7200 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 37 + 11) % 256;
    const huge = await sharp(noise, { raw: { width: 4800, height: 7200, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(huge.length).toBeGreaterThan(28 * 1024 * 1024);

    const out = await prepareBakeUploadBuffer(huge);
    expect(out.buffer.length).toBeLessThanOrEqual(28 * 1024 * 1024);
    expect(["png", "jpg"]).toContain(out.ext);
  }, 60_000);
});
