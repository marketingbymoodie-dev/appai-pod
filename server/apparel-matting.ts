/**
 * Chroma-first apparel motif matting — color keying + flat-graphic cleanup.
 * Replicate saliency removal is optional fallback only (see processApparelMotif).
 */

import sharp from "sharp";
import {
  removeBackground,
  bufferFromRemoveBgResult,
  type RemoveBgResult,
} from "./replicate-bg-remover";

export const CHROMA_KEY = { r: 255, g: 0, b: 255 } as const;

export type AlphaQualityMetrics = {
  softAlphaRatio: number;
  cornerBgOpaqueRatio: number;
  chromaRemovedPct: number;
  largestComponentFillRatio: number;
  opaquePixelCount: number;
  totalPixels: number;
};

export type ChromaKeyResult = {
  buffer: Buffer;
  chromaRemovedPct: number;
  cornerRemovedPct: number;
  whiteKeyRemovedPct: number;
};

export type ProcessApparelMotifOptions = {
  isAllOverPrint?: boolean;
  bgRemovalSensitivity?: number;
  allowWhiteKey?: boolean;
  useMlFallback?: boolean;
  vectorize?: boolean;
};

export type ProcessApparelMotifResult = {
  buffer: Buffer;
  usedMlFallback: boolean;
  qa: AlphaQualityMetrics;
};

const CHROMA_SUFFIX =
  "isolated on solid hot pink (#FF00FF) background, no white mat, no rectangular frame, fill entire canvas with #FF00FF outside the subject";

const WHITE_BG_PATTERNS: RegExp[] = [
  /\bwhite\s+background\b/gi,
  /\bpure\s+white\b/gi,
  /\b#FFFFFF\b/gi,
  /\boff-?white\b/gi,
  /\bon\s+white\b/gi,
  /\bwhite\s+card\b/gi,
  /\bwhite\s+plate\b/gi,
  /\brectangular\s+frame\b/gi,
  /\bwhite\s+mat\b/gi,
];

/** Strip conflicting background language from merchant apparel style prefixes. */
export function sanitizeApparelStylePrefix(prefix: string): string {
  let cleaned = prefix.trim();
  for (const pattern of WHITE_BG_PATTERNS) {
    cleaned = cleaned.replace(pattern, "hot pink (#FF00FF) background");
  }
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  if (!cleaned.toLowerCase().includes("#ff00ff") && !cleaned.toLowerCase().includes("hot pink")) {
    cleaned = cleaned ? `${cleaned}, ${CHROMA_SUFFIX}` : CHROMA_SUFFIX;
  } else if (!cleaned.toLowerCase().includes("no white mat")) {
    cleaned = `${cleaned}, no white mat, no rectangular frame`;
  }
  return cleaned;
}

function pixelLuminance(r: number, g: number, b: number): number {
  return (r + g + b) / 3;
}

function pixelChroma(r: number, g: number, b: number): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function colorDistance(
  r: number,
  g: number,
  b: number,
  tr: number,
  tg: number,
  tb: number,
): number {
  return Math.abs(r - tr) + Math.abs(g - tg) + Math.abs(b - tb);
}

/** Parse Replicate remove-bg data URL / HTTP result into a buffer. */
export async function parseRemoveBgResult(removeBgResult: RemoveBgResult): Promise<Buffer> {
  return bufferFromRemoveBgResult(removeBgResult);
}

/**
 * Enhanced connectivity-independent chroma keying (pink → corner → white/grey mat).
 */
export async function removeChromaKeyBackground(
  buffer: Buffer,
  opts?: { tolerance?: number; allowWhiteKey?: boolean },
): Promise<ChromaKeyResult> {
  const tolerance = opts?.tolerance ?? 60;
  const allowWhiteKey = opts?.allowWhiteKey !== false;
  console.log(`[Chroma Key] Starting (tolerance=${tolerance}, whiteKey=${allowWhiteKey})...`);
  const startTime = Date.now();

  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const source = new Uint8Array(data);
  const pixels = new Uint8Array(source);
  const total = width * height;

  // Pass A: #FF00FF chroma key
  let pinkRemoved = 0;
  for (let i = 0; i < pixels.length; i += channels) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const dist = colorDistance(r, g, b, CHROMA_KEY.r, CHROMA_KEY.g, CHROMA_KEY.b);
    if (dist <= tolerance) {
      pixels[i + 3] = 0;
      pinkRemoved++;
    }
  }
  const chromaRemovedPct = (pinkRemoved / total) * 100;
  console.log(`[Chroma Key] Pink pass: ${chromaRemovedPct.toFixed(1)}%`);

  // Pass B: corner-detected background (on original RGB, apply to current alpha)
  const cornerSamples: { r: number; g: number; b: number }[] = [];
  const sampleSize = 5;
  const corners = [
    [0, 0],
    [width - sampleSize, 0],
    [0, height - sampleSize],
    [width - sampleSize, height - sampleSize],
  ];
  for (const [cx, cy] of corners) {
    for (let dy = 0; dy < sampleSize; dy++) {
      for (let dx = 0; dx < sampleSize; dx++) {
        const idx = ((cy + dy) * width + (cx + dx)) * channels;
        cornerSamples.push({ r: source[idx], g: source[idx + 1], b: source[idx + 2] });
      }
    }
  }
  let avgR = Math.round(cornerSamples.reduce((s, c) => s + c.r, 0) / cornerSamples.length);
  let avgG = Math.round(cornerSamples.reduce((s, c) => s + c.g, 0) / cornerSamples.length);
  let avgB = Math.round(cornerSamples.reduce((s, c) => s + c.b, 0) / cornerSamples.length);
  if (avgR > 240 && avgG > 240 && avgB > 240) {
    avgR = 255;
    avgG = 255;
    avgB = 255;
  }

  let cornerRemoved = 0;
  const bgTolerance = 45;
  for (let i = 0; i < pixels.length; i += channels) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    if (pixels[i + 3] === 0) continue;
    const dist = colorDistance(r, g, b, avgR, avgG, avgB);
    if (dist <= bgTolerance) {
      pixels[i + 3] = 0;
      cornerRemoved++;
    }
  }
  const cornerRemovedPct = (cornerRemoved / total) * 100;
  console.log(`[Chroma Key] Corner pass (rgb ${avgR},${avgG},${avgB}): ${cornerRemovedPct.toFixed(1)}%`);

  // Pass C/D: global near-white and light-grey mat removal
  let whiteKeyRemoved = 0;
  if (allowWhiteKey) {
    for (let i = 0; i < pixels.length; i += channels) {
      if (pixels[i + 3] === 0) continue;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const lum = pixelLuminance(r, g, b);
      const chroma = pixelChroma(r, g, b);
      const isNearWhite = lum >= 240 && chroma <= 12;
      const isLightGreyMat = lum >= 220 && chroma <= 18;
      if (isNearWhite || isLightGreyMat) {
        pixels[i + 3] = 0;
        whiteKeyRemoved++;
      }
    }
    console.log(`[Chroma Key] White/grey mat pass: ${((whiteKeyRemoved / total) * 100).toFixed(1)}%`);
  }

  const elapsed = Date.now() - startTime;
  console.log(`[Chroma Key] Complete in ${elapsed}ms`);

  const out = await sharp(Buffer.from(pixels), { raw: { width, height, channels } }).png().toBuffer();
  return {
    buffer: out,
    chromaRemovedPct,
    cornerRemovedPct,
    whiteKeyRemovedPct: (whiteKeyRemoved / total) * 100,
  };
}

async function despillEdgeColors(data: Uint8Array, ch: number): Promise<void> {
  for (let i = 0; i < data.length; i += ch) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a === 0) continue;

    const magenta = Math.min(r, b) - g;
    if (magenta > 10) {
      if (a < 255) {
        data[i] = g;
        data[i + 2] = g;
      } else if (r > 180 && b > 180 && g < 120 && magenta > 80) {
        data[i + 3] = 0;
      }
      continue;
    }

    // White/grey spill on semi-transparent edge pixels
    if (a < 255) {
      const lum = pixelLuminance(r, g, b);
      const chroma = pixelChroma(r, g, b);
      if (lum >= 230 && chroma <= 15) {
        data[i + 3] = 0;
      }
    }
  }
}

async function erodeAlphaChannel(buffer: Buffer, radiusPx: number): Promise<Buffer> {
  if (radiusPx <= 0) return buffer;
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const src = new Uint8Array(data);
  const dst = new Uint8Array(src);
  const alphaThreshold = 8;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      if (src[idx + 3] <= alphaThreshold) continue;
      let keep = true;
      for (let dy = -radiusPx; dy <= radiusPx && keep; dy++) {
        for (let dx = -radiusPx; dx <= radiusPx; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            keep = false;
            break;
          }
          const nidx = (ny * width + nx) * channels;
          if (src[nidx + 3] <= alphaThreshold) {
            keep = false;
            break;
          }
        }
      }
      if (!keep) dst[idx + 3] = 0;
    }
  }

  return sharp(Buffer.from(dst), { raw: { width, height, channels } }).png().toBuffer();
}

function despeckleAlpha(
  data: Uint8Array,
  width: number,
  height: number,
  channels: number,
  minIslandPixels: number,
): void {
  const total = width * height;
  const visited = new Uint8Array(total);
  const stack: number[] = [];

  for (let seed = 0; seed < total; seed++) {
    if (visited[seed]) continue;
    const seedIdx = seed * channels;
    const isOpaque = data[seedIdx + 3] > 128;
    stack.length = 0;
    stack.push(seed);
    visited[seed] = 1;
    const component: number[] = [seed];

    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % width;
      const y = Math.floor(p / width);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const np = ny * width + nx;
        if (visited[np]) continue;
        const nidx = np * channels;
        const nOpaque = data[nidx + 3] > 128;
        if (nOpaque !== isOpaque) continue;
        visited[np] = 1;
        stack.push(np);
        component.push(np);
      }
    }

    if (component.length < minIslandPixels) {
      for (const p of component) {
        const idx = p * channels;
        if (isOpaque) {
          data[idx + 3] = 0;
        } else {
          data[idx + 3] = 255;
        }
      }
    }
  }
}

/** Deterministic flat-graphic cleanup after chroma keying. */
export async function cleanupFlatGraphicAlpha(
  buffer: Buffer,
  opts?: { bgRemovalSensitivity?: number; erodeAfterCleanup?: boolean },
): Promise<Buffer> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  if (ch < 4) return buffer;

  const px = new Uint8Array(data);
  await despillEdgeColors(px, ch);

  // Binarize alpha for hard vector-like edges
  for (let i = 0; i < px.length; i += ch) {
    px[i + 3] = px[i + 3] < 128 ? 0 : 255;
  }

  despeckleAlpha(px, info.width, info.height, ch, 12);

  let out = await sharp(px, {
    raw: { width: info.width, height: info.height, channels: ch },
  })
    .png()
    .toBuffer();

  let erosionRadius = 0;
  if (opts?.erodeAfterCleanup) {
    erosionRadius = 1;
  } else if (typeof opts?.bgRemovalSensitivity === "number") {
    const s = Math.max(0, Math.min(100, opts.bgRemovalSensitivity));
    erosionRadius = Math.round((s / 100) * 2);
  }

  if (erosionRadius > 0) {
    out = await erodeAlphaChannel(out, erosionRadius);
  }

  return out;
}

export async function analyzeAlphaQuality(buffer: Buffer): Promise<AlphaQualityMetrics> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const pixels = new Uint8Array(data);
  const total = width * height;

  let softAlpha = 0;
  let opaqueCount = 0;
  let cornerOpaque = 0;
  let cornerTotal = 0;
  const cornerSize = 5;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const a = pixels[idx + 3];
      if (a > 0 && a < 255) softAlpha++;
      if (a > 128) opaqueCount++;

      const inCorner =
        x < cornerSize ||
        x >= width - cornerSize ||
        y < cornerSize ||
        y >= height - cornerSize;
      if (inCorner) {
        cornerTotal++;
        if (a > 128) cornerOpaque++;
      }
    }
  }

  const largestComponentFillRatio = estimateLargestOpaqueFillRatio(pixels, width, height, channels);

  return {
    softAlphaRatio: total > 0 ? softAlpha / total : 0,
    cornerBgOpaqueRatio: cornerTotal > 0 ? cornerOpaque / cornerTotal : 0,
    chromaRemovedPct: 0,
    largestComponentFillRatio,
    opaquePixelCount: opaqueCount,
    totalPixels: total,
  };
}

function estimateLargestOpaqueFillRatio(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
): number {
  const total = width * height;
  const visited = new Uint8Array(total);
  let largest = 0;
  const stack: number[] = [];

  for (let seed = 0; seed < total; seed++) {
    if (visited[seed]) continue;
    const idx = seed * channels;
    if (pixels[idx + 3] <= 128) {
      visited[seed] = 1;
      continue;
    }
    stack.length = 0;
    stack.push(seed);
    visited[seed] = 1;
    let size = 0;

    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      const x = p % width;
      const y = Math.floor(p / width);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const np = ny * width + nx;
        if (visited[np]) continue;
        const nidx = np * channels;
        if (pixels[nidx + 3] <= 128) continue;
        visited[np] = 1;
        stack.push(np);
      }
    }
    if (size > largest) largest = size;
  }

  return total > 0 ? largest / total : 0;
}

export async function trimTransparentBounds(
  buffer: Buffer,
  alphaThreshold: number = 8,
  padding: number = 8,
): Promise<Buffer> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const pixels = new Uint8Array(data);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      if (pixels[idx + 3] > alphaThreshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return buffer;

  const left = Math.max(0, minX - padding);
  const top = Math.max(0, minY - padding);
  const right = Math.min(width - 1, maxX + padding);
  const bottom = Math.min(height - 1, maxY + padding);
  const cropWidth = Math.max(1, right - left + 1);
  const cropHeight = Math.max(1, bottom - top + 1);

  if (left === 0 && top === 0 && cropWidth === width && cropHeight === height) {
    return buffer;
  }

  return sharp(buffer)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .png()
    .toBuffer();
}

async function maybeVectorizeFlatGraphic(buffer: Buffer): Promise<Buffer> {
  if (process.env.APPAREL_VECTORIZE !== "true") return buffer;

  try {
    const meta = await sharp(buffer).metadata();
    const width = meta.width ?? 1024;
    const height = meta.height ?? 1024;

    const { vectorize, ColorMode, Hierarchical, PathSimplifyMode } = await import(
      "@neplex/vectorizer"
    );

    const svg = await vectorize(buffer, {
      colorMode: ColorMode.Color,
      colorPrecision: 5,
      filterSpeckle: 4,
      cornerThreshold: 80,
      hierarchical: Hierarchical.Stacked,
      mode: PathSimplifyMode.Spline,
      pathPrecision: 4,
    });

    const rasterized = await sharp(Buffer.from(svg))
      .resize(width, height, { fit: "fill" })
      .png()
      .toBuffer();

    console.log("[Apparel Matting] Vectorize round-trip complete");
    return rasterized;
  } catch (err) {
    console.warn("[Apparel Matting] Vectorize skipped:", (err as Error).message);
    return buffer;
  }
}

function logQaWarnings(qa: AlphaQualityMetrics, chromaRemovedPct: number): void {
  if (qa.softAlphaRatio > 0.03) {
    console.warn(
      `[Apparel Matting QA] High soft-alpha ratio ${(qa.softAlphaRatio * 100).toFixed(2)}%`,
    );
  }
  if (qa.cornerBgOpaqueRatio > 0.5) {
    console.warn(
      `[Apparel Matting QA] Corners still opaque ${(qa.cornerBgOpaqueRatio * 100).toFixed(1)}% — key may have failed`,
    );
  }
  if (chromaRemovedPct < 5) {
    console.warn(
      `[Apparel Matting QA] Low pink chroma removal ${chromaRemovedPct.toFixed(1)}% — model may have ignored #FF00FF`,
    );
  }
  if (qa.largestComponentFillRatio > 0.85) {
    console.warn(
      `[Apparel Matting QA] Single blob fills ${(qa.largestComponentFillRatio * 100).toFixed(1)}% — possible matting failure`,
    );
  }
}

/**
 * Primary apparel motif pipeline: chroma key first, optional ML fallback, cleanup, QA.
 */
export async function processApparelMotif(
  sourceBuffer: Buffer,
  opts: ProcessApparelMotifOptions = {},
): Promise<ProcessApparelMotifResult> {
  const allowWhiteKey = opts.allowWhiteKey !== false;
  const useMlFallback = opts.useMlFallback !== false;

  const chroma = await removeChromaKeyBackground(sourceBuffer, { allowWhiteKey });
  let buffer = chroma.buffer;
  let usedMlFallback = false;

  let qa = await analyzeAlphaQuality(buffer);
  qa = { ...qa, chromaRemovedPct: chroma.chromaRemovedPct };

  const needsMlFallback =
    useMlFallback &&
    chroma.chromaRemovedPct < 5 &&
    qa.cornerBgOpaqueRatio > 0.4;

  if (needsMlFallback) {
    console.log("[Apparel Matting] Chroma key weak — trying Replicate fallback...");
    try {
      const mlBuffer = await parseRemoveBgResult(
        await removeBackground({ imageBuffer: sourceBuffer }),
      );
      buffer = mlBuffer;
      usedMlFallback = true;
    } catch (err) {
      console.warn("[Apparel Matting] Replicate fallback failed:", (err as Error).message);
    }
  }

  buffer = await cleanupFlatGraphicAlpha(buffer, {
    bgRemovalSensitivity: opts.bgRemovalSensitivity,
    erodeAfterCleanup: !usedMlFallback,
  });

  if (opts.vectorize || process.env.APPAREL_VECTORIZE === "true") {
    buffer = await maybeVectorizeFlatGraphic(buffer);
  }

  qa = await analyzeAlphaQuality(buffer);
  qa = { ...qa, chromaRemovedPct: chroma.chromaRemovedPct };
  logQaWarnings(qa, chroma.chromaRemovedPct);

  return { buffer, usedMlFallback, qa };
}

/** Data URL PNG for API responses (remove-bg endpoint). */
export async function processApparelMotifToDataUrl(
  sourceBuffer: Buffer,
  opts?: ProcessApparelMotifOptions,
): Promise<string> {
  const { buffer } = await processApparelMotif(sourceBuffer, opts);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}
