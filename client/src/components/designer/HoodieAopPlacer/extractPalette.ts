/**
 * Tiny in-process palette extractor used to seed the bg-colour swatch row
 * with 6 dominant artwork colours.
 *
 * Approach: median-cut on a downsampled image. Fast (< 5 ms for typical
 * AOP artwork at the 64×64 work size), no dependencies, runs entirely in
 * the customer's browser.
 *
 * The artwork canvas is intentionally kept small — colour quantisation
 * doesn't need pixel-perfect input and bigger images cost frame time
 * without changing the result much. We also drop any pixels that are
 * effectively transparent (alpha < 32) so PNG halos / soft edges don't
 * skew the palette toward the artwork's background colour.
 */

export type PaletteSwatch = {
  hex: string;
  /** 0..1 — share of sampled pixels in the bucket this swatch came from. */
  weight: number;
};

const WORK_SIZE = 64;
const MIN_ALPHA = 32;
const MIN_BUCKET_PIXELS = 4;
const DEFAULT_COUNT = 6;

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

type Bucket = {
  pixels: Uint8ClampedArray; // packed [r,g,b,r,g,b,...]
  count: number;
};

function rangeOf(buf: Uint8ClampedArray, count: number, channel: 0 | 1 | 2): number {
  let lo = 255;
  let hi = 0;
  const step = 3;
  for (let i = 0; i < count; i += 1) {
    const v = buf[i * step + channel];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
}

function widestChannel(b: Bucket): 0 | 1 | 2 {
  const r = rangeOf(b.pixels, b.count, 0);
  const g = rangeOf(b.pixels, b.count, 1);
  const bl = rangeOf(b.pixels, b.count, 2);
  if (r >= g && r >= bl) return 0;
  if (g >= bl) return 1;
  return 2;
}

function splitBucket(b: Bucket): [Bucket, Bucket] | null {
  if (b.count < MIN_BUCKET_PIXELS * 2) return null;
  const ch = widestChannel(b);
  // In-place sort by channel via a temporary index array (sorting a
  // 3-channel packed buffer in place is awkward enough that an
  // index list is faster than swap-based sorts here).
  const indices = new Uint16Array(b.count);
  for (let i = 0; i < b.count; i += 1) indices[i] = i;
  indices.sort((a, c) => b.pixels[a * 3 + ch] - b.pixels[c * 3 + ch]);

  const half = Math.floor(b.count / 2);
  const aBuf = new Uint8ClampedArray(half * 3);
  const cBuf = new Uint8ClampedArray((b.count - half) * 3);
  for (let i = 0; i < half; i += 1) {
    const src = indices[i] * 3;
    aBuf[i * 3] = b.pixels[src];
    aBuf[i * 3 + 1] = b.pixels[src + 1];
    aBuf[i * 3 + 2] = b.pixels[src + 2];
  }
  for (let i = half; i < b.count; i += 1) {
    const dst = (i - half) * 3;
    const src = indices[i] * 3;
    cBuf[dst] = b.pixels[src];
    cBuf[dst + 1] = b.pixels[src + 1];
    cBuf[dst + 2] = b.pixels[src + 2];
  }
  return [
    { pixels: aBuf, count: half },
    { pixels: cBuf, count: b.count - half },
  ];
}

function meanOf(b: Bucket): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let bl = 0;
  for (let i = 0; i < b.count; i += 1) {
    r += b.pixels[i * 3];
    g += b.pixels[i * 3 + 1];
    bl += b.pixels[i * 3 + 2];
  }
  return { r: r / b.count, g: g / b.count, b: bl / b.count };
}

function collectOpaquePixels(image: HTMLImageElement): Bucket {
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  if (!w || !h) return { pixels: new Uint8ClampedArray(0), count: 0 };

  const aspect = w / h;
  const cw = aspect >= 1 ? WORK_SIZE : Math.max(1, Math.round(WORK_SIZE * aspect));
  const ch = aspect >= 1 ? Math.max(1, Math.round(WORK_SIZE / aspect)) : WORK_SIZE;

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { pixels: new Uint8ClampedArray(0), count: 0 };
  ctx.drawImage(image, 0, 0, cw, ch);
  const data = ctx.getImageData(0, 0, cw, ch).data;

  // Pre-allocate to the worst case (every pixel opaque) and trim later.
  const total = cw * ch;
  const buf = new Uint8ClampedArray(total * 3);
  let count = 0;
  for (let i = 0; i < total; i += 1) {
    const a = data[i * 4 + 3];
    if (a < MIN_ALPHA) continue;
    buf[count * 3] = data[i * 4];
    buf[count * 3 + 1] = data[i * 4 + 1];
    buf[count * 3 + 2] = data[i * 4 + 2];
    count += 1;
  }
  return { pixels: buf.subarray(0, count * 3), count };
}

/**
 * Extracts up to `count` dominant colours from an opaque-pixel sample of
 * the image via repeated median-cut. Returns swatches sorted by bucket
 * weight (most prominent first).
 */
export function extractArtworkPalette(
  image: HTMLImageElement,
  count: number = DEFAULT_COUNT,
): PaletteSwatch[] {
  const root = collectOpaquePixels(image);
  if (root.count === 0) return [];

  const buckets: Bucket[] = [root];
  // Median-cut: split the largest bucket until we have `count` buckets
  // or every bucket is too small to halve further.
  while (buckets.length < count) {
    // Pick the bucket with the largest channel range × pixel count —
    // splitting a bucket that's both populous and colour-spread gives
    // the most palette diversity per split.
    let bestIndex = -1;
    let bestScore = -1;
    for (let i = 0; i < buckets.length; i += 1) {
      const b = buckets[i];
      if (b.count < MIN_BUCKET_PIXELS * 2) continue;
      const r = rangeOf(b.pixels, b.count, 0);
      const g = rangeOf(b.pixels, b.count, 1);
      const bl = rangeOf(b.pixels, b.count, 2);
      const score = Math.max(r, g, bl) * b.count;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) break;
    const split = splitBucket(buckets[bestIndex]);
    if (!split) break;
    buckets.splice(bestIndex, 1, split[0], split[1]);
  }

  const total = buckets.reduce((acc, b) => acc + b.count, 0) || 1;
  const swatches: PaletteSwatch[] = buckets.map((b) => {
    const { r, g, b: bl } = meanOf(b);
    return { hex: toHex(r, g, bl), weight: b.count / total };
  });

  // Most-prominent first.
  swatches.sort((a, b) => b.weight - a.weight);
  // Dedupe near-identical hexes — median-cut can produce two buckets
  // very close in colour when the image is nearly monochrome.
  const out: PaletteSwatch[] = [];
  for (const s of swatches) {
    const tooClose = out.some((o) => hexDistance(o.hex, s.hex) < 18);
    if (!tooClose) out.push(s);
    if (out.length >= count) break;
  }
  return out;
}

function hexDistance(a: string, b: string): number {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  return Math.sqrt((ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2);
}
