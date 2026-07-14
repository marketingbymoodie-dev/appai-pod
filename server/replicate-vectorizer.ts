/**
 * Recraft Vectorize via Replicate — raster PNG → SVG for apparel edge cleanup.
 * Used when APPAREL_VECTORIZE_PROVIDER=recraft (see apparel-matting.ts).
 *
 * Environment: REPLICATE_API_TOKEN, optional REPLICATE_RECRAFT_VECTORIZE_VERSION
 */

import sharp from "sharp";

const REPLICATE_API_BASE = "https://api.replicate.com/v1";
const REPLICATE_RECRAFT_VECTORIZE_VERSION =
  process.env.REPLICATE_RECRAFT_VECTORIZE_VERSION ||
  "9f71824b45b71f56b576b97149c314989cfabf90b08f0506ffcdc9fa62beb05d";
const REPLICATE_POLL_INTERVAL_MS = 750;
const REPLICATE_VECTORIZE_POLL_TIMEOUT_MS = Number(
  process.env.REPLICATE_VECTORIZE_POLL_TIMEOUT_MS || 120_000,
);
const RECRAFT_MAX_BYTES = 5 * 1024 * 1024;
const RECRAFT_MAX_DIMENSION = 4096;
const RECRAFT_MIN_DIMENSION = 256;

/** Opaque plate behind transparent matted art so tracers keep interior whites (sclera, teeth). */
const VECTORIZE_PLATE_CHROMA = { r: 255, g: 0, b: 255 } as const;

export type RecraftVectorizeParams = {
  imageBuffer: Buffer;
  canvasCorner?: CanvasCornerRgb | null;
};

/**
 * Flatten matted RGBA onto an opaque chroma plate before vectorization.
 * Transparent PNGs often cause tracers to treat white interior fills as holes.
 */
export async function prepareOpaquePlateForVectorize(source: Buffer): Promise<Buffer> {
  const meta = await sharp(source).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;

  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: VECTORIZE_PLATE_CHROMA,
    },
  })
    .composite([{ input: source, blend: "over" }])
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Count opaque near-white pixels — proxy for sclera/teeth/highlights in flat graphics. */
export async function countNearWhiteOpaquePixels(buffer: Buffer): Promise<number> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let count = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const a = data[i + 3];
    if (a <= 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = (r + g + b) / 3;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (lum >= 230 && chroma <= 15) count++;
  }
  return count;
}

type ReplicatePrediction = {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  urls?: { get?: string };
  output?: unknown;
  error?: unknown;
};

/** Prepare matted PNG for Recraft limits (5MB, 256–4096px). Returns API buffer + original output size. */
export async function prepareBufferForRecraftVectorize(
  source: Buffer,
): Promise<{ apiBuffer: Buffer; outputWidth: number; outputHeight: number }> {
  const meta = await sharp(source).metadata();
  const outputWidth = meta.width ?? 1024;
  const outputHeight = meta.height ?? 1024;

  let apiWidth = outputWidth;
  let apiHeight = outputHeight;
  const maxSide = Math.max(apiWidth, apiHeight);
  if (maxSide > RECRAFT_MAX_DIMENSION) {
    const scale = RECRAFT_MAX_DIMENSION / maxSide;
    apiWidth = Math.max(RECRAFT_MIN_DIMENSION, Math.round(apiWidth * scale));
    apiHeight = Math.max(RECRAFT_MIN_DIMENSION, Math.round(apiHeight * scale));
  }

  const minSide = Math.min(apiWidth, apiHeight);
  if (minSide < RECRAFT_MIN_DIMENSION) {
    const scale = RECRAFT_MIN_DIMENSION / minSide;
    apiWidth = Math.round(apiWidth * scale);
    apiHeight = Math.round(apiHeight * scale);
  }

  let apiBuffer = await sharp(source)
    .ensureAlpha()
    .resize(apiWidth, apiHeight, { fit: "fill" })
    .png({ compressionLevel: 9 })
    .toBuffer();

  while (apiBuffer.length > RECRAFT_MAX_BYTES && apiWidth > RECRAFT_MIN_DIMENSION) {
    apiWidth = Math.max(RECRAFT_MIN_DIMENSION, Math.round(apiWidth * 0.85));
    apiHeight = Math.max(RECRAFT_MIN_DIMENSION, Math.round(apiHeight * 0.85));
    apiBuffer = await sharp(source)
      .ensureAlpha()
      .resize(apiWidth, apiHeight, { fit: "fill" })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }

  if (apiBuffer.length > RECRAFT_MAX_BYTES) {
    throw new Error(
      `Image still exceeds Recraft 5MB limit after resize (${(apiBuffer.length / 1024 / 1024).toFixed(2)}MB)`,
    );
  }

  return { apiBuffer, outputWidth, outputHeight };
}

/** Call recraft-ai/recraft-vectorize; returns SVG bytes. */
export async function vectorizeWithRecraft(params: RecraftVectorizeParams): Promise<Buffer> {
  const token = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
  if (!token) {
    throw new Error("REPLICATE_API_TOKEN environment variable is not set");
  }

  const opaquePlate = await prepareOpaquePlateForVectorize(params.imageBuffer);
  const { apiBuffer } = await prepareBufferForRecraftVectorize(opaquePlate);
  const imageInput = `data:image/png;base64,${apiBuffer.toString("base64")}`;

  const prediction = await createReplicatePrediction(token, {
    version: REPLICATE_RECRAFT_VECTORIZE_VERSION,
    input: { image: imageInput },
  });

  const completed = await pollReplicatePrediction(token, prediction);
  const svgUrl = getReplicateOutputUrl(completed.output);
  if (!svgUrl) {
    throw new Error("Recraft vectorize returned no SVG output");
  }

  const response = await fetch(svgUrl);
  if (!response.ok) {
    throw new Error(`Failed to download Recraft SVG: HTTP ${response.status}`);
  }

  const rawSvg = Buffer.from(await response.arrayBuffer());
  return sanitizeVectorSvgConnected(rawSvg, params.imageBuffer, {
    canvasCorner: params.canvasCorner,
  });
}

/** Parse a hex (#rgb / #rrggbb) or rgb()/rgba() SVG color value. */
function parseSvgColor(value: string): { r: number; g: number; b: number } | null {
  const v = value.trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16));
    return { r, g, b };
  }
  m = v.match(/^#([0-9a-f]{6})$/);
  if (m) {
    return {
      r: parseInt(m[1].slice(0, 2), 16),
      g: parseInt(m[1].slice(2, 4), 16),
      b: parseInt(m[1].slice(4, 6), 16),
    };
  }
  m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
  if (v === "magenta" || v === "fuchsia") return { r: 255, g: 0, b: 255 };
  return null;
}

/**
 * True for the #FF00FF vectorize plate INCLUDING tracer color quantization — Neplex's
 * colorPrecision:6 rounds 255 to 252 (#FC00FC) and Recraft can drift similarly, so an
 * exact #FF00FF match misses the traced plate and it survives as a painted background.
 * Bounds stay tight to the plate (both r and b near max, low green) so legitimate purples
 * and violets in the artwork are never stripped.
 */
export function isChromaPlateRgb(r: number, g: number, b: number): boolean {
  return r >= 220 && b >= 220 && g <= 90 && Math.abs(r - b) <= 50;
}

function isChromaPlateColorValue(value: string): boolean {
  const c = parseSvgColor(value);
  return !!c && isChromaPlateRgb(c.r, c.g, c.b);
}

export type CanvasCornerRgb = { r: number; g: number; b: number };

/** Manhattan RGB distance — shared tolerance semantics with apparel chroma key. */
export function rgbManhattanDistance(
  r: number,
  g: number,
  b: number,
  target: CanvasCornerRgb,
): number {
  return Math.abs(r - target.r) + Math.abs(g - target.g) + Math.abs(b - target.b);
}

function rgbToSvgHexColor(r: number, g: number, b: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function isCanvasCornerPlateRgb(
  r: number,
  g: number,
  b: number,
  canvasCorner: CanvasCornerRgb | null | undefined,
  tolerance: number = 55,
): boolean {
  if (!canvasCorner) return false;
  return rgbManhattanDistance(r, g, b, canvasCorner) <= tolerance;
}

/** Count opaque plate-magenta pixels — detects a traced plate that survived sanitizing. */
export async function countChromaPlateOpaquePixels(
  buffer: Buffer,
  canvasCorner?: CanvasCornerRgb | null,
): Promise<number> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let count = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] <= 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (isChromaPlateRgb(r, g, b) || isCanvasCornerPlateRgb(r, g, b, canvasCorner)) count++;
  }
  return count;
}

/** Count raster pixels that became opaque where the matted source was transparent. */
export async function countOpaqueWhereSourceTransparent(
  sourcePng: Buffer,
  raster: Buffer,
): Promise<number> {
  const meta = await sharp(sourcePng).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;

  const [sourceRaw, rasterRaw] = await Promise.all([
    sharp(sourcePng).resize(width, height, { fit: "fill" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(raster).resize(width, height, { fit: "fill" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);

  const src = new Uint8Array(sourceRaw.data);
  const out = new Uint8Array(rasterRaw.data);
  const channels = sourceRaw.info.channels;
  let count = 0;
  for (let i = 0; i < src.length; i += channels) {
    if (src[i + 3] > 128) continue;
    if (out[i + 3] > 128) count++;
  }
  return count;
}

/**
 * Strip chroma-key pink from traced SVG (fast string pass, no extra API latency).
 *
 * `isPlateValue` defaults to a blind hue-range match (`isChromaPlateColorValue`), which
 * cannot tell the actual plate/background apart from legitimate enclosed design content in
 * the same magenta/pink/fuchsia hue family (e.g. a hot-pink flower petal) — both satisfy the
 * same RGB bounds. Callers that have done connectivity-based classification (see
 * `classifyPlateColorsByConnectivity`) should pass a narrower predicate so only colors
 * confirmed to be background-connected get stripped.
 */
export function sanitizeVectorSvg(
  svg: Buffer,
  isPlateValue: (value: string) => boolean = isChromaPlateColorValue,
): Buffer {
  let text = svg.toString("utf8");
  if (!text.includes("<svg")) return svg;

  text = text.replace(
    /(fill|stroke)\s*=\s*(["'])([^"']*)\2/gi,
    (match, attr: string, quote: string, value: string) =>
      isPlateValue(value) ? `${attr}=${quote}none${quote}` : match,
  );

  text = text.replace(/style\s*=\s*(["'])([^"']*)\1/gi, (match, quote: string, css: string) => {
    const paintDecls = css.match(/(?:fill|stroke)\s*:\s*[^;]+/gi) || [];
    const hasPlatePaint = paintDecls.some((decl) =>
      isPlateValue(decl.split(":").slice(1).join(":")),
    );
    return hasPlatePaint ? `style=${quote}display:none${quote}` : match;
  });

  return Buffer.from(text, "utf8");
}

/** Collect distinct fill/stroke color strings in the SVG that fall in the plate hue range. */
function collectCandidatePlateColorValues(
  svgText: string,
  canvasCorner?: CanvasCornerRgb | null,
): string[] {
  const values = new Set<string>();

  const consider = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "none") return;
    if (isChromaPlateColorValue(trimmed)) {
      values.add(trimmed);
      return;
    }
    const rgb = parseSvgColor(trimmed);
    if (rgb && isCanvasCornerPlateRgb(rgb.r, rgb.g, rgb.b, canvasCorner)) {
      values.add(trimmed);
    }
  };

  const attrRe = /(?:fill|stroke)\s*=\s*(["'])([^"']*)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(svgText))) {
    consider(m[2]);
  }

  const styleRe = /style\s*=\s*(["'])([^"']*)\1/gi;
  while ((m = styleRe.exec(svgText))) {
    const decls = m[2].match(/(?:fill|stroke)\s*:\s*[^;]+/gi) || [];
    for (const decl of decls) {
      consider(decl.split(":").slice(1).join(":"));
    }
  }

  if (canvasCorner) {
    values.add(rgbToSvgHexColor(canvasCorner.r, canvasCorner.g, canvasCorner.b));
  }

  return [...values];
}

/**
 * Distinguish tracer-emitted plate/background paths from legitimate enclosed design content
 * that happens to share the plate's magenta/pink/fuchsia hue family (e.g. a hot-pink flower
 * petal on a floral design). A blind color-range match can't tell them apart — pixels of the
 * exact same quantized color can be background in one path and real design fill in another.
 *
 * Mirrors the connectivity approach already used for raster chroma-key removal
 * (`removeChromaKeyBackground` in apparel-matting.ts): rasterize the raw (unsanitized) trace,
 * flood-fill plate-hued pixels connected to the canvas border, then classify each candidate
 * fill/stroke color by whether its pixels in the raster are majority border-connected (plate)
 * or majority enclosed (design). Only border-connected colors are returned for stripping.
 */
/**
 * Manhattan distance to pure #FF00FF for the border-connectivity FLOOD ITSELF (not for
 * choosing which SVG colors are worth classifying — that uses the much wider
 * `isChromaPlateRgb`). This must stay tight: a hot-pink design fill and the plate both
 * satisfy the wide hue-family bounds, so flooding on that wide predicate would just treat
 * the whole hue family as one connected blob and swallow enclosed design shapes too. A tight
 * distance-to-key bound (with headroom for tracer color quantization, e.g. Neplex rounding
 * 255→252) still only connects genuine plate/background pixels.
 */
const PLATE_FLOOD_MANHATTAN_TOLERANCE = 60;

function isPlateFloodPixelRgb(r: number, g: number, b: number): boolean {
  return Math.abs(r - 255) + Math.abs(g - 0) + Math.abs(b - 255) <= PLATE_FLOOD_MANHATTAN_TOLERANCE;
}

export async function classifyPlateColorsByConnectivity(
  rawTracedRaster: Buffer,
  candidateColors: string[],
  canvasCorner?: CanvasCornerRgb | null,
): Promise<Set<string>> {
  const parsed = candidateColors
    .map((value) => ({ value, rgb: parseSvgColor(value) }))
    .filter((c): c is { value: string; rgb: { r: number; g: number; b: number } } => !!c.rgb);
  if (parsed.length === 0) return new Set();

  const { data, info } = await sharp(rawTracedRaster)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const total = width * height;

  const isPlateHuePixel = (pixelIdx: number) => {
    const r = data[pixelIdx];
    const g = data[pixelIdx + 1];
    const b = data[pixelIdx + 2];
    return (
      isPlateFloodPixelRgb(r, g, b) ||
      isCanvasCornerPlateRgb(r, g, b, canvasCorner)
    );
  };

  // Border-connected flood over tight-tolerance plate pixels (see isPlateFloodPixelRgb) so
  // tracer color quantization noise along the plate/subject boundary doesn't fragment the
  // background, while a same-hue-family but clearly-distinct design color (hot pink, etc.)
  // never gets swept in just because it shares the hue.
  const connected = new Uint8Array(total);
  const visited = new Uint8Array(total);
  const queue: number[] = [];
  const trySeed = (x: number, y: number) => {
    const p = y * width + x;
    if (visited[p]) return;
    visited[p] = 1;
    if (isPlateHuePixel(p * channels)) {
      connected[p] = 1;
      queue.push(p);
    }
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
      visited[np] = 1;
      if (!isPlateHuePixel(np * channels)) continue;
      connected[np] = 1;
      queue.push(np);
    }
  }

  const plateColorTolerance = 6;
  const plateColors = new Set<string>();
  for (const { value, rgb } of parsed) {
    let matched = 0;
    let matchedConnected = 0;
    for (let p = 0; p < total; p++) {
      const idx = p * channels;
      if (
        Math.abs(data[idx] - rgb.r) <= plateColorTolerance &&
        Math.abs(data[idx + 1] - rgb.g) <= plateColorTolerance &&
        Math.abs(data[idx + 2] - rgb.b) <= plateColorTolerance
      ) {
        matched++;
        if (connected[p]) matchedConnected++;
      }
    }
    // No matched pixels (anti-aliased away to nothing) is rare and low-risk either way;
    // default to treating it as plate, matching prior (pre-connectivity) behavior.
    if (matched === 0 || matchedConnected / matched >= 0.5) {
      plateColors.add(value);
    }
  }
  return plateColors;
}

/**
 * Sanitize a raw traced SVG using connectivity-based plate classification instead of a blind
 * hue-range match, so enclosed design content sharing the plate's hue (hot-pink/magenta
 * flowers, accents, etc.) survives while the actual background plate is still stripped.
 */
export type SanitizeVectorSvgOptions = {
  /** AI canvas color sampled from source corners — strips off-spec pink plates the tracer kept. */
  canvasCorner?: CanvasCornerRgb | null;
};

export async function sanitizeVectorSvgConnected(
  rawSvg: Buffer,
  sourceForDims: Buffer,
  opts?: SanitizeVectorSvgOptions,
): Promise<Buffer> {
  const text = rawSvg.toString("utf8");
  const candidates = collectCandidatePlateColorValues(text, opts?.canvasCorner);
  if (candidates.length === 0) return rawSvg;

  const meta = await sharp(sourceForDims).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;
  const raster = await rasterizeSvgBuffer(rawSvg, width, height);
  const plateColors = await classifyPlateColorsByConnectivity(
    raster,
    candidates,
    opts?.canvasCorner,
  );

  return sanitizeVectorSvg(rawSvg, (value) => plateColors.has(value.trim()));
}

export async function rasterizeSvgBuffer(
  svg: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(svg, { density: 150 })
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .png()
    .toBuffer();
}

async function createReplicatePrediction(
  token: string,
  body: { version: string; input: Record<string, unknown> },
): Promise<ReplicatePrediction> {
  return fetchReplicateJson(`${REPLICATE_API_BASE}/predictions`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function pollReplicatePrediction(
  token: string,
  prediction: ReplicatePrediction,
): Promise<ReplicatePrediction> {
  const getUrl = prediction.urls?.get;
  if (!getUrl) throw new Error("Replicate prediction did not include a polling URL");

  let latest = prediction;
  const startedAt = Date.now();
  while (latest.status === "starting" || latest.status === "processing") {
    if (Date.now() - startedAt > REPLICATE_VECTORIZE_POLL_TIMEOUT_MS) {
      throw new Error("Recraft vectorize timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, REPLICATE_POLL_INTERVAL_MS));
    latest = await fetchReplicateJson(getUrl, token);
  }

  if (latest.status !== "succeeded") {
    const detail = typeof latest.error === "string" ? latest.error : JSON.stringify(latest.error);
    throw new Error(`Recraft vectorize failed: ${detail || latest.status}`);
  }

  return latest;
}

async function fetchReplicateJson(
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<ReplicatePrediction> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");

  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail =
      json?.detail || json?.error || json?.message || `HTTP ${response.status} from Replicate`;
    throw new Error(`Replicate API error ${response.status}: ${detail}`);
  }
  return json as ReplicatePrediction;
}

function getReplicateOutputUrl(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const first = output.find((item) => typeof item === "string");
    return first ?? null;
  }
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.url === "string") return record.url;
    if (typeof record.image === "string") return record.image;
  }
  return null;
}
