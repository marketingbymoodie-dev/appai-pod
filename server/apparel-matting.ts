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
import { sanitizeVectorSvgConnected, vectorizeWithRecraft, prepareOpaquePlateForVectorize, countNearWhiteOpaquePixels, countChromaPlateOpaquePixels, rasterizeSvgBuffer } from "./replicate-vectorizer";
import {
  APPAREL_CHROMA_STYLE_BY_NAME,
  APPAREL_DARK_TIER_PROMPTS,
  isChromaSafeApparelPrefix,
} from "@shared/apparel-chroma-prompts";
import {
  GRAPHICS_CHROMA_STYLE_BY_ID,
  GRAPHICS_CHROMA_STYLE_BY_NAME,
} from "@shared/graphics-chroma-prompts";

export {
  APPAREL_CHROMA_STYLE_BY_NAME,
  APPAREL_DARK_TIER_PROMPTS,
  isChromaSafeApparelPrefix,
} from "@shared/apparel-chroma-prompts";

export const CHROMA_KEY = { r: 255, g: 0, b: 255 } as const;

/** Manhattan distance to #FF00FF — tight enough to avoid purple design colors. */
export const DEFAULT_CHROMA_TOLERANCE = 28;
/** Slightly wider for AI off-pink canvas drift; used on retry + border flood only. */
export const EXPANDED_CHROMA_TOLERANCE = 55;
const CHROMA_DESPILL_TOLERANCE = 35;

export type AlphaQualityMetrics = {
  softAlphaRatio: number;
  cornerBgOpaqueRatio: number;
  chromaRemovedPct: number;
  largestComponentFillRatio: number;
  opaquePixelCount: number;
  totalPixels: number;
  /** Share of opaque pixels that are still magenta/pink-hued (any shade) — leftover chroma
   *  fringe that the fixed-distance-to-#FF00FF passes miss because Manhattan distance grows
   *  fast with brightness even when the hue is identical. */
  residualMagentaOpaqueRatio: number;
};

export type ChromaKeyResult = {
  buffer: Buffer;
  chromaRemovedPct: number;
  cornerRemovedPct: number;
  whiteKeyRemovedPct: number;
  borderFloodRemovedPct: number;
  magentaFloodRemovedPct: number;
  cornerIsLightCanvas: boolean;
  cornerIsMagentaCanvas: boolean;
};

export type CornerColorSample = {
  avgR: number;
  avgG: number;
  avgB: number;
};

export type WhiteMatThresholds = {
  nearWhiteLum: number;
  nearWhiteChroma: number;
  greyLum: number;
  greyChroma: number;
};

const DEFAULT_WHITE_MAT_THRESHOLDS: WhiteMatThresholds = {
  nearWhiteLum: 240,
  nearWhiteChroma: 12,
  greyLum: 220,
  greyChroma: 18,
};

const AGGRESSIVE_WHITE_MAT_THRESHOLDS: WhiteMatThresholds = {
  nearWhiteLum: 235,
  nearWhiteChroma: 14,
  greyLum: 210,
  greyChroma: 20,
};

export type ProcessApparelMotifOptions = {
  isAllOverPrint?: boolean;
  bgRemovalSensitivity?: number;
  allowWhiteKey?: boolean;
  useMlFallback?: boolean;
  vectorize?: boolean;
};

export type ApparelMotifMimeType = "image/png" | "image/svg+xml";

export type ProcessApparelMotifResult = {
  buffer: Buffer;
  mimeType: ApparelMotifMimeType;
  usedMlFallback: boolean;
  qa: AlphaQualityMetrics;
};

export type VectorizeFlatGraphicResult = {
  buffer: Buffer;
  mimeType: ApparelMotifMimeType;
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

/**
 * True when generation/post-processing should use hot-pink chroma-key matting.
 * Decor styles always use full-bleed generation — even on AOP pillows.
 * Apparel styles and classic apparel / zip-hoodie products use chroma key.
 */
export function resolveIsApparelGeneration(
  productType?: { designerType?: string | null; isAllOverPrint?: boolean | null } | null,
  styleCategory?: string | null,
): boolean {
  const styleCat = (styleCategory || "all").toLowerCase();
  const designerType = (productType?.designerType || "").toLowerCase();

  if (styleCat === "apparel" || styleCat === "graphics") return true;
  if (designerType === "apparel") return true;

  // Decor presets (Pop Art, Watercolor, etc.) — full bleed, no chroma plate
  if (styleCat === "decor") return false;

  // Zip hoodies / AOP garments with non-decor styles (incl. "No Style" custom prompt)
  if (designerType === "all-over-print") return true;

  // Decor AOP products (pillows): chroma only when an apparel-category style is selected
  if (productType?.isAllOverPrint) return false;

  return false;
}

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

/** Graphics prefix: chroma + matting/SVG pipeline, large-format motif language. */
export function resolveGraphicsStylePrefix(
  styleName: string,
  stylePresetId: string | null | undefined,
  dbPrefix: string,
): string {
  const trimmed = dbPrefix.trim();
  if (trimmed && isChromaSafeApparelPrefix(trimmed)) {
    return sanitizeApparelStylePrefix(trimmed);
  }
  const idKey = (stylePresetId || "").trim().toLowerCase();
  if (idKey && GRAPHICS_CHROMA_STYLE_BY_ID[idKey]) {
    return sanitizeApparelStylePrefix(GRAPHICS_CHROMA_STYLE_BY_ID[idKey]);
  }
  const nameKey = styleName.trim().toLowerCase();
  const canonical = GRAPHICS_CHROMA_STYLE_BY_NAME[nameKey];
  if (canonical) {
    return sanitizeApparelStylePrefix(canonical);
  }
  return sanitizeApparelStylePrefix(trimmed);
}

/** Route motif prefix resolution by style category (apparel vs graphics). */
export function resolveMotifStylePrefix(
  styleCategory: string | null | undefined,
  styleName: string,
  stylePresetId: string | null | undefined,
  dbPrefix: string,
): string {
  if ((styleCategory || "").toLowerCase() === "graphics") {
    return resolveGraphicsStylePrefix(styleName, stylePresetId, dbPrefix);
  }
  return resolveApparelStylePrefix(styleName, dbPrefix);
}

/** Light-garment prefix: prefer Admin/DB when chroma-safe; else repo fallback by style name. */
export function resolveApparelStylePrefix(styleName: string, dbPrefix: string): string {
  const trimmed = dbPrefix.trim();
  if (trimmed && isChromaSafeApparelPrefix(trimmed)) {
    return sanitizeApparelStylePrefix(trimmed);
  }
  const key = styleName.trim().toLowerCase();
  const canonical = APPAREL_CHROMA_STYLE_BY_NAME[key];
  if (canonical !== undefined) {
    return sanitizeApparelStylePrefix(canonical);
  }
  return sanitizeApparelStylePrefix(trimmed);
}

/** Dark-garment prefix: prefer DB `prompt_prefix_dark`, else fallback by preset id. */
export function resolveApparelDarkTierPrefix(
  stylePresetId: string | null | undefined,
  dbDarkPrefix: string | null | undefined,
): string {
  const trimmed = (dbDarkPrefix ?? "").trim();
  if (trimmed && isChromaSafeApparelPrefix(trimmed)) {
    return sanitizeApparelStylePrefix(trimmed);
  }
  const fallback = stylePresetId ? APPAREL_DARK_TIER_PROMPTS[stylePresetId] : "";
  if (fallback) {
    return sanitizeApparelStylePrefix(fallback);
  }
  return "";
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

/** Hue (deg), saturation and lightness (0–1) — used for hue-family matching independent of brightness. */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

/**
 * True for ANY shade/tint of the #FF00FF chroma hue (dark, desaturated, or pale pink) — not
 * just colors close to pure magenta by RGB distance. Anti-aliased fringe pixels blend the
 * design edge color into the pink canvas and often end up as a darker or muddier pink that
 * survives every fixed-tolerance distance-to-key check even though the hue is unmistakably
 * chroma-pink. Bounds exclude near-black/near-white and low-saturation greys so real dark
 * edge colors and neutral tones are never misclassified.
 */
function isMagentaHueFamily(r: number, g: number, b: number): boolean {
  const { h, s, l } = rgbToHsl(r, g, b);
  if (l < 0.05 || l > 0.97) return false;
  if (s < 0.22) return false;
  return h >= 280 && h <= 335;
}

/**
 * Flood-fill magenta-hue-family pixels connected to already-transparent regions (border or
 * previously chroma-keyed background). This mirrors applyBorderFloodFillChromaMat's
 * connectivity-only approach but classifies by hue instead of RGB distance to a fixed color,
 * so it catches darkened/desaturated pink fringe those passes miss — while never touching
 * magenta/purple pixels fully enclosed by the subject (not connected to the removed background).
 */
function applyMagentaFringeFloodFill(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
): number {
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue: number[] = [];
  let removed = 0;

  for (let p = 0; p < total; p++) {
    if (pixels[p * channels + 3] === 0) {
      visited[p] = 1;
      queue.push(p);
    }
  }

  while (queue.length > 0) {
    const p = queue.pop()!;
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
      const idx = np * channels;
      if (pixels[idx + 3] === 0) {
        visited[np] = 1;
        queue.push(np);
        continue;
      }
      if (!isMagentaHueFamily(pixels[idx], pixels[idx + 1], pixels[idx + 2])) continue;
      visited[np] = 1;
      pixels[idx + 3] = 0;
      removed++;
      queue.push(np);
    }
  }

  return removed;
}

function isMatColor(
  r: number,
  g: number,
  b: number,
  thresholds: WhiteMatThresholds = DEFAULT_WHITE_MAT_THRESHOLDS,
): boolean {
  const lum = pixelLuminance(r, g, b);
  const chroma = pixelChroma(r, g, b);
  return (
    (lum >= thresholds.nearWhiteLum && chroma <= thresholds.nearWhiteChroma) ||
    (lum >= thresholds.greyLum && chroma <= thresholds.greyChroma)
  );
}

/** Sample average RGB from the four image corners (uses raw source buffer). */
export function sampleCornerColorFromRaw(
  source: Uint8Array,
  width: number,
  height: number,
  channels: number,
): CornerColorSample {
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
  return { avgR, avgG, avgB };
}

/** True when AI used a white/grey canvas instead of hot pink chroma. */
export function isLightCanvasCorner(sample: CornerColorSample): boolean {
  const lum = pixelLuminance(sample.avgR, sample.avgG, sample.avgB);
  const chroma = pixelChroma(sample.avgR, sample.avgG, sample.avgB);
  return lum >= 220 && chroma <= 18;
}

/** True when corners are hot pink / magenta chroma key background. */
export function isMagentaCanvasCorner(sample: CornerColorSample): boolean {
  const { avgR, avgG, avgB } = sample;
  const magenta = Math.min(avgR, avgB) - avgG;
  return avgR >= 140 && avgB >= 140 && avgG <= 140 && magenta >= 40;
}

/** Whether an RGB pixel matches the chroma-key color within tolerance (no purple-family heuristic). */
export function isChromaBackgroundColor(
  r: number,
  g: number,
  b: number,
  tolerance: number = DEFAULT_CHROMA_TOLERANCE,
): boolean {
  return colorDistance(r, g, b, CHROMA_KEY.r, CHROMA_KEY.g, CHROMA_KEY.b) <= tolerance;
}

/**
 * Flood-fill near-white/grey mat pixels reachable from image borders or keyed background.
 * Interior subject whites (teeth, sclera) surrounded by colored pixels are preserved.
 */
function applyFloodFillLightMatFromBackground(
  pixels: Uint8Array,
  source: Uint8Array,
  width: number,
  height: number,
  channels: number,
  thresholds: WhiteMatThresholds,
): number {
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue: number[] = [];
  let removed = 0;

  const seedTransparentOrBorderMat = (p: number) => {
    if (visited[p]) return;
    const idx = p * channels;
    if (pixels[idx + 3] === 0) {
      visited[p] = 1;
      queue.push(p);
      return;
    }
    if (!isMatColor(source[idx], source[idx + 1], source[idx + 2], thresholds)) return;
    visited[p] = 1;
    pixels[idx + 3] = 0;
    removed++;
    queue.push(p);
  };

  for (let x = 0; x < width; x++) {
    seedTransparentOrBorderMat(x);
    seedTransparentOrBorderMat((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seedTransparentOrBorderMat(y * width);
    seedTransparentOrBorderMat(y * width + width - 1);
  }

  for (let p = 0; p < total; p++) {
    if (visited[p]) continue;
    const idx = p * channels;
    if (pixels[idx + 3] !== 0) continue;
    visited[p] = 1;
    queue.push(p);
  }

  while (queue.length > 0) {
    const p = queue.pop()!;
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
      const idx = np * channels;
      if (pixels[idx + 3] === 0) {
        visited[np] = 1;
        queue.push(np);
        continue;
      }
      if (!isMatColor(source[idx], source[idx + 1], source[idx + 2], thresholds)) continue;
      visited[np] = 1;
      pixels[idx + 3] = 0;
      removed++;
      queue.push(np);
    }
  }

  return removed;
}

/**
 * Flood-fill chroma/magenta mat pixels connected to any image border.
 */
function applyBorderFloodFillChromaMat(
  pixels: Uint8Array,
  source: Uint8Array,
  width: number,
  height: number,
  channels: number,
  tolerance: number,
): number {
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue: number[] = [];
  let removed = 0;

  const trySeed = (x: number, y: number) => {
    const p = y * width + x;
    if (visited[p]) return;
    const idx = p * channels;
    if (pixels[idx + 3] === 0) {
      visited[p] = 1;
      return;
    }
    if (!isChromaBackgroundColor(source[idx], source[idx + 1], source[idx + 2], tolerance)) {
      return;
    }
    visited[p] = 1;
    pixels[idx + 3] =  0;
    removed++;
    queue.push(p);
  };

  for (let x = 0; x < width; x++) {
    trySeed(x, 0);
    trySeed(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    trySeed(0, y);
    trySeed(width - 1, y);
  }

  while (queue.length > 0) {
    const p = queue.pop()!;
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
      const idx = np * channels;
      visited[np] = 1;
      if (pixels[idx + 3] === 0) continue;
      if (!isChromaBackgroundColor(source[idx], source[idx + 1], source[idx + 2], tolerance)) {
        continue;
      }
      pixels[idx + 3] = 0;
      removed++;
      queue.push(np);
    }
  }

  return removed;
}

/** Parse Replicate remove-bg data URL / HTTP result into a buffer. */
export async function parseRemoveBgResult(removeBgResult: RemoveBgResult): Promise<Buffer> {
  return bufferFromRemoveBgResult(removeBgResult);
}

/**
 * Chroma keying: tight #FF00FF match, optional white-mat flood, border-connected chroma flood.
 */
export async function removeChromaKeyBackground(
  buffer: Buffer,
  opts?: {
    tolerance?: number;
    cornerTolerance?: number;
    allowWhiteKey?: boolean;
    aggressiveWhiteKey?: boolean;
    borderFloodFill?: boolean;
    chromaFloodFill?: boolean;
  },
): Promise<ChromaKeyResult> {
  const allowWhiteKey = opts?.allowWhiteKey !== false;
  const aggressiveWhiteKey = opts?.aggressiveWhiteKey === true;
  const borderFloodFill = opts?.borderFloodFill !== false;
  const chromaFloodFill = opts?.chromaFloodFill !== false;
  const whiteThresholds = aggressiveWhiteKey
    ? AGGRESSIVE_WHITE_MAT_THRESHOLDS
    : DEFAULT_WHITE_MAT_THRESHOLDS;
  console.log(
    `[Chroma Key] Starting (tolerance=${opts?.tolerance ?? "auto"}, whiteKey=${allowWhiteKey}, aggressive=${aggressiveWhiteKey})...`,
  );
  const startTime = Date.now();

  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const source = new Uint8Array(data);
  const pixels = new Uint8Array(source);
  const total = width * height;
  const corners = sampleCornerColorFromRaw(source, width, height, channels);
  const cornerIsLightCanvas = isLightCanvasCorner(corners);
  const cornerIsMagentaCanvas = isMagentaCanvasCorner(corners);

  const chromaTolerance = opts?.tolerance ?? DEFAULT_CHROMA_TOLERANCE;
  const cornerTolerance = opts?.cornerTolerance ?? 55;
  /** Border flood uses wider tolerance for AI off-pink canvas; connectivity keeps interior purple safe. */
  const chromaFloodTolerance = EXPANDED_CHROMA_TOLERANCE;

  // Pass A: global tight match — removes exact/off-pink key incl. enclosed holes in the subject
  let pinkRemoved = 0;
  for (let i = 0; i < pixels.length; i += channels) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    if (isChromaBackgroundColor(r, g, b, chromaTolerance)) {
      pixels[i + 3] = 0;
      pinkRemoved++;
    }
  }
  const chromaRemovedPct = (pinkRemoved / total) * 100;
  console.log(`[Chroma Key] Pink pass: ${chromaRemovedPct.toFixed(1)}%`);

  const { avgR, avgG, avgB } = corners;

  // Pass A2: when the corners confirm a magenta chroma canvas, run one GLOBAL pass at the
  // expanded tolerance against both the pure key and the SAMPLED canvas color. This removes
  // enclosed canvas pockets (truck windows, gaps between tree branches) whose pink drifted
  // past the tight Pass A tolerance — they're the same leaked canvas color, so they sit close
  // to the sample, while legitimate purple design colors (e.g. rgb(180,40,200), Manhattan
  // distance ~170 from the key) stay far outside the expanded tolerance.
  let sampledCanvasRemoved = 0;
  if (cornerIsMagentaCanvas) {
    for (let i = 0; i < pixels.length; i += channels) {
      if (pixels[i + 3] === 0) continue;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      if (
        isChromaBackgroundColor(r, g, b, EXPANDED_CHROMA_TOLERANCE) ||
        colorDistance(r, g, b, avgR, avgG, avgB) <= EXPANDED_CHROMA_TOLERANCE
      ) {
        pixels[i + 3] = 0;
        sampledCanvasRemoved++;
      }
    }
    console.log(
      `[Chroma Key] Sampled-canvas global pass (rgb ${avgR},${avgG},${avgB}): ${((sampledCanvasRemoved / total) * 100).toFixed(1)}%`,
    );
  }

  // Pass B: corner-detected background — only when AI used a white/grey canvas (not hot pink)

  let cornerRemoved = 0;
  if (cornerIsLightCanvas) {
    for (let i = 0; i < pixels.length; i += channels) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      if (pixels[i + 3] === 0) continue;
      const dist = colorDistance(r, g, b, avgR, avgG, avgB);
      if (dist <= cornerTolerance) {
        pixels[i + 3] = 0;
        cornerRemoved++;
      }
    }
  }
  const cornerRemovedPct = (cornerRemoved / total) * 100;
  console.log(`[Chroma Key] Corner pass (rgb ${avgR},${avgG},${avgB}): ${cornerRemovedPct.toFixed(1)}%`);

  // Pass C: connectivity-only white/grey mat removal (border + keyed background)
  let whiteKeyRemoved = 0;
  let borderFloodRemoved = 0;
  if (borderFloodFill && allowWhiteKey) {
    borderFloodRemoved = applyFloodFillLightMatFromBackground(
      pixels,
      source,
      width,
      height,
      channels,
      whiteThresholds,
    );
    whiteKeyRemoved = borderFloodRemoved;
    console.log(
      `[Chroma Key] Connected white/grey mat pass: ${((whiteKeyRemoved / total) * 100).toFixed(1)}%`,
    );
  }

  // Pass F: border-connected chroma flood only (never global purple-family sweep)
  let magentaFloodRemoved = 0;
  if (chromaFloodFill) {
    magentaFloodRemoved = applyBorderFloodFillChromaMat(
      pixels,
      source,
      width,
      height,
      channels,
      chromaFloodTolerance,
    );
    console.log(
      `[Chroma Key] Border chroma flood: ${((magentaFloodRemoved / total) * 100).toFixed(1)}%`,
    );
  }

  const elapsed = Date.now() - startTime;
  console.log(`[Chroma Key] Complete in ${elapsed}ms`);

  const out = await sharp(Buffer.from(pixels), { raw: { width, height, channels } }).png().toBuffer();
  return {
    buffer: out,
    chromaRemovedPct,
    cornerRemovedPct,
    whiteKeyRemovedPct: (whiteKeyRemoved / total) * 100,
    borderFloodRemovedPct: (borderFloodRemoved / total) * 100,
    magentaFloodRemovedPct: (magentaFloodRemoved / total) * 100,
    cornerIsLightCanvas,
    cornerIsMagentaCanvas,
  };
}

async function despillEdgeColors(data: Uint8Array, ch: number): Promise<void> {
  for (let i = 0; i < data.length; i += ch) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a === 0) continue;

    const keyDist = colorDistance(r, g, b, CHROMA_KEY.r, CHROMA_KEY.g, CHROMA_KEY.b);
    if (keyDist <= CHROMA_DESPILL_TOLERANCE) {
      if (a < 255) {
        data[i + 3] = 0;
      } else if (g > 0) {
        data[i] = g;
        data[i + 2] = g;
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
  const fringeRemoved = applyMagentaFringeFloodFill(px, info.width, info.height, ch);
  if (fringeRemoved > 0) {
    console.log(`[Apparel Matting] Magenta hue-family fringe pass removed ${fringeRemoved} px`);
  }

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
  let residualMagentaOpaque = 0;
  const cornerSize = 5;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const a = pixels[idx + 3];
      if (a > 0 && a < 255) softAlpha++;
      if (a > 128) {
        opaqueCount++;
        if (isMagentaHueFamily(pixels[idx], pixels[idx + 1], pixels[idx + 2])) residualMagentaOpaque++;
      }

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
    residualMagentaOpaqueRatio: opaqueCount > 0 ? residualMagentaOpaque / opaqueCount : 0,
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

async function vectorizeWithNeplex(buffer: Buffer): Promise<Buffer> {
  const { vectorize, ColorMode, Hierarchical, PathSimplifyMode } = await import("@neplex/vectorizer");
  const opaquePlate = await prepareOpaquePlateForVectorize(buffer);

  const svg = await vectorize(opaquePlate, {
    colorMode: ColorMode.Color,
    colorPrecision: 6,
    filterSpeckle: 2,
    cornerThreshold: 80,
    hierarchical: Hierarchical.Stacked,
    mode: PathSimplifyMode.Spline,
    pathPrecision: 4,
  });

  return sanitizeVectorSvgConnected(Buffer.from(svg), buffer);
}

/** Reject SVG when interior whites (eyes, teeth) were lost during tracing. */
async function acceptVectorizedOrFallback(
  sourcePng: Buffer,
  svg: Buffer,
): Promise<VectorizeFlatGraphicResult> {
  const meta = await sharp(sourcePng).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;

  const raster = await rasterizeSvgBuffer(svg, width, height);

  // Plate-residue QA: vectorization drops the matted art onto an opaque #FF00FF plate
  // so tracers keep interior whites. sanitizeVectorSvg strips the traced plate paths,
  // but if a tracer emits the plate in a form the sanitizer can't parse, the SVG renders
  // with a solid magenta background. Any meaningful plate-magenta area that isn't in the
  // source PNG means the plate survived — keep the clean PNG instead.
  const sourcePlatePx = await countChromaPlateOpaquePixels(sourcePng);
  const tracedPlatePx = await countChromaPlateOpaquePixels(raster);
  const addedPlatePx = tracedPlatePx - sourcePlatePx;
  if (addedPlatePx > width * height * 0.005) {
    console.warn(
      `[Apparel Matting] Vectorize plate residue detected (${tracedPlatePx}px magenta vs ${sourcePlatePx}px in source) — keeping PNG`,
    );
    return { buffer: sourcePng, mimeType: "image/png" };
  }

  // General coverage-regression QA: catches any internal color/section dropped during
  // tracing or plate sanitization — not just whites (see white-retention check below).
  // Connectivity-based plate classification (sanitizeVectorSvgConnected) already prevents
  // most of this, but this stays as a defense-in-depth net for edge cases (e.g. a color with
  // zero matched pixels in the classification raster, which conservatively defaults to plate).
  const sourceOpaque = await analyzeAlphaQuality(sourcePng);
  const tracedOpaque = await analyzeAlphaQuality(raster);
  const coverageFloor = Math.max(500, Math.round(width * height * 0.005));
  if (sourceOpaque.opaquePixelCount >= coverageFloor) {
    const coverageRatio = tracedOpaque.opaquePixelCount / sourceOpaque.opaquePixelCount;
    if (coverageRatio < 0.88) {
      console.warn(
        `[Apparel Matting] Vectorize dropped ${(100 - coverageRatio * 100).toFixed(0)}% of opaque art coverage (${tracedOpaque.opaquePixelCount}/${sourceOpaque.opaquePixelCount}px) — keeping PNG`,
      );
      return { buffer: sourcePng, mimeType: "image/png" };
    }
  }

  // Only enforce the white-retention QA when the source has a design-significant
  // white region (eye/teeth scale — ≥0.02% of the canvas). Tiny white areas
  // (specular highlights, anti-aliased edge pixels) make the retention ratio pure
  // noise: tracer spline smoothing shifts a handful of pixels past the near-white
  // threshold and the ratio collapses, falsely rejecting good SVGs. The old fixed
  // 24px floor rejected nearly every design that had any white at all.
  const sourceWhites = await countNearWhiteOpaquePixels(sourcePng);
  const significanceFloor = Math.max(300, Math.round(width * height * 0.0002));
  if (sourceWhites < significanceFloor) {
    console.log(
      `[Apparel Matting] Vectorize white QA skipped (${sourceWhites}px white < ${significanceFloor}px floor) — SVG accepted`,
    );
    return { buffer: svg, mimeType: "image/svg+xml" };
  }

  const tracedWhites = await countNearWhiteOpaquePixels(raster);
  const ratio = tracedWhites / sourceWhites;
  // Genuine failures (interior whites traced as holes) drop retention to near zero;
  // benign tracer drift (smoothed edges, slightly off-white fills) stays well above 0.5.
  if (ratio < 0.5) {
    console.warn(
      `[Apparel Matting] Vectorize dropped interior white (${(ratio * 100).toFixed(0)}% retained, ${tracedWhites}/${sourceWhites}px) — keeping PNG`,
    );
    return { buffer: sourcePng, mimeType: "image/png" };
  }

  console.log(
    `[Apparel Matting] Vectorize white QA passed (${(ratio * 100).toFixed(0)}% retained, ${tracedWhites}/${sourceWhites}px) — SVG accepted`,
  );
  return { buffer: svg, mimeType: "image/svg+xml" };
}

export async function maybeVectorizeFlatGraphic(buffer: Buffer): Promise<VectorizeFlatGraphicResult> {
  if (process.env.APPAREL_VECTORIZE !== "true") {
    return { buffer, mimeType: "image/png" };
  }

  const startedAt = Date.now();
  const provider = (process.env.APPAREL_VECTORIZE_PROVIDER || "recraft").trim().toLowerCase();

  if (provider === "recraft" || provider === "") {
    try {
      const svg = await vectorizeWithRecraft({ imageBuffer: buffer });
      const accepted = await acceptVectorizedOrFallback(buffer, svg);
      console.log(
        `[Apparel Matting] Recraft vectorize complete (${accepted.mimeType === "image/svg+xml" ? "SVG retained" : "PNG fallback"}) in ${Date.now() - startedAt}ms`,
      );
      return accepted;
    } catch (err) {
      console.warn(
        `[Apparel Matting] Recraft vectorize failed after ${Date.now() - startedAt}ms, trying neplex:`,
        (err as Error).message,
      );
    }
  }

  if (provider === "recraft" || provider === "neplex") {
    try {
      const neplexStarted = Date.now();
      const svg = await vectorizeWithNeplex(buffer);
      const accepted = await acceptVectorizedOrFallback(buffer, svg);
      console.log(
        `[Apparel Matting] Neplex vectorize complete (${accepted.mimeType === "image/svg+xml" ? "SVG retained" : "PNG fallback"}) in ${Date.now() - neplexStarted}ms (total ${Date.now() - startedAt}ms)`,
      );
      return accepted;
    } catch (err) {
      console.warn("[Apparel Matting] Neplex vectorize skipped:", (err as Error).message);
    }
  } else {
    console.warn(
      `[Apparel Matting] Unknown APPAREL_VECTORIZE_PROVIDER="${provider}" — skipping vectorize`,
    );
  }

  return { buffer, mimeType: "image/png" };
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
  if (qa.residualMagentaOpaqueRatio > 0.01) {
    console.warn(
      `[Apparel Matting QA] Residual magenta fringe ${(qa.residualMagentaOpaqueRatio * 100).toFixed(2)}% of opaque pixels`,
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

  const { data: rawData, info: rawInfo } = await sharp(sourceBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sourceCorner = sampleCornerColorFromRaw(
    new Uint8Array(rawData),
    rawInfo.width,
    rawInfo.height,
    rawInfo.channels,
  );
  const cornerIsLightCanvas = isLightCanvasCorner(sourceCorner);
  const cornerIsMagentaCanvas = isMagentaCanvasCorner(sourceCorner);
  const useAggressiveWhiteKey = cornerIsLightCanvas;

  let chroma = await removeChromaKeyBackground(sourceBuffer, {
    allowWhiteKey,
    aggressiveWhiteKey: useAggressiveWhiteKey,
    borderFloodFill: true,
    chromaFloodFill: true,
  });

  // Retry with slightly wider key tolerance when AI used off-pink magenta canvas
  if (cornerIsMagentaCanvas && chroma.chromaRemovedPct < 20) {
    console.log("[Apparel Matting] Magenta canvas — retrying chroma with expanded tolerance");
    chroma = await removeChromaKeyBackground(sourceBuffer, {
      allowWhiteKey,
      tolerance: EXPANDED_CHROMA_TOLERANCE,
      aggressiveWhiteKey: useAggressiveWhiteKey,
      borderFloodFill: true,
      chromaFloodFill: true,
    });
  }

  let buffer = chroma.buffer;
  let usedMlFallback = false;

  let qa = await analyzeAlphaQuality(buffer);
  qa = { ...qa, chromaRemovedPct: chroma.chromaRemovedPct };

  const needsMlFallback =
    useMlFallback &&
    chroma.chromaRemovedPct < 5 &&
    qa.cornerBgOpaqueRatio > 0.4 &&
    !cornerIsLightCanvas &&
    !cornerIsMagentaCanvas &&
    !chroma.cornerIsLightCanvas &&
    !chroma.cornerIsMagentaCanvas;

  if (needsMlFallback) {
    console.log("[Apparel Matting] Chroma key weak — trying Replicate fallback...");
    try {
      const mlBuffer = await parseRemoveBgResult(
        await removeBackground({ imageBuffer: sourceBuffer }),
      );
      const rechroma = await removeChromaKeyBackground(mlBuffer, {
        allowWhiteKey,
        tolerance: EXPANDED_CHROMA_TOLERANCE,
        aggressiveWhiteKey: useAggressiveWhiteKey,
        borderFloodFill: true,
        chromaFloodFill: true,
      });
      buffer = rechroma.buffer;
      usedMlFallback = true;
    } catch (err) {
      console.warn("[Apparel Matting] Replicate fallback failed:", (err as Error).message);
    }
  } else if (cornerIsLightCanvas) {
    console.log(
      "[Apparel Matting] Light/white canvas detected — skipping ML fallback, using chroma + border flood",
    );
  } else if (cornerIsMagentaCanvas) {
    console.log(
      "[Apparel Matting] Magenta chroma canvas detected — skipping ML fallback, using expanded chroma key",
    );
  }

  buffer = await cleanupFlatGraphicAlpha(buffer, {
    bgRemovalSensitivity: opts.bgRemovalSensitivity,
    erodeAfterCleanup: !usedMlFallback,
  });

  // Safety net: if corners still opaque after cleanup, run one more chroma sweep
  const postQa = await analyzeAlphaQuality(buffer);
  if (postQa.cornerBgOpaqueRatio > 0.35) {
    console.warn(
      `[Apparel Matting] Post-cleanup corners still ${(postQa.cornerBgOpaqueRatio * 100).toFixed(0)}% opaque — final chroma sweep`,
    );
    const finalChroma = await removeChromaKeyBackground(buffer, {
      allowWhiteKey,
      tolerance: EXPANDED_CHROMA_TOLERANCE,
      borderFloodFill: true,
      chromaFloodFill: true,
    });
    buffer = await cleanupFlatGraphicAlpha(finalChroma.buffer, {
      bgRemovalSensitivity: opts.bgRemovalSensitivity,
      erodeAfterCleanup: false,
    });
  }

  // NOTE: no automatic retry on residual magenta here (unlike the corner-opaque safety net
  // above). The flood-fill inside cleanupFlatGraphicAlpha already removes every fringe pixel
  // connected to transparency in one pass — anything still magenta-hued afterward is, by
  // construction, NOT connected to background, i.e. legitimate enclosed purple/magenta art.
  // Re-running cleanup (with its erosion step) risks thinning the margin around such enclosed
  // pixels on a second pass until they become newly "connected" and get wrongly deleted.
  // residualMagentaOpaqueRatio is logged via logQaWarnings() below for monitoring only.

  buffer = await trimTransparentBounds(buffer, 8, usedMlFallback ? 4 : 8);

  let mimeType: ApparelMotifMimeType = "image/png";
  const qaBeforeVectorize = await analyzeAlphaQuality(buffer);

  if (opts.vectorize || process.env.APPAREL_VECTORIZE === "true") {
    const vectorized = await maybeVectorizeFlatGraphic(buffer);
    buffer = vectorized.buffer;
    mimeType = vectorized.mimeType;
  }

  qa =
    mimeType === "image/svg+xml"
      ? { ...qaBeforeVectorize, chromaRemovedPct: chroma.chromaRemovedPct }
      : await analyzeAlphaQuality(buffer);
  qa = { ...qa, chromaRemovedPct: chroma.chromaRemovedPct };
  logQaWarnings(qa, chroma.chromaRemovedPct);

  return { buffer, mimeType, usedMlFallback, qa };
}

/** Data URL for API responses (remove-bg endpoint). */
export async function processApparelMotifToDataUrl(
  sourceBuffer: Buffer,
  opts?: ProcessApparelMotifOptions,
): Promise<string> {
  const { buffer, mimeType } = await processApparelMotif(sourceBuffer, opts);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}
