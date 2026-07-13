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

  return sanitizeVectorSvg(Buffer.from(await response.arrayBuffer()));
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

/** Count opaque plate-magenta pixels — detects a traced plate that survived sanitizing. */
export async function countChromaPlateOpaquePixels(buffer: Buffer): Promise<number> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let count = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] <= 128) continue;
    if (isChromaPlateRgb(data[i], data[i + 1], data[i + 2])) count++;
  }
  return count;
}

/** Strip chroma-key pink from traced SVG (fast string pass, no extra API latency). */
export function sanitizeVectorSvg(svg: Buffer): Buffer {
  let text = svg.toString("utf8");
  if (!text.includes("<svg")) return svg;

  text = text.replace(
    /(fill|stroke)\s*=\s*(["'])([^"']*)\2/gi,
    (match, attr: string, quote: string, value: string) =>
      isChromaPlateColorValue(value) ? `${attr}=${quote}none${quote}` : match,
  );

  text = text.replace(/style\s*=\s*(["'])([^"']*)\1/gi, (match, quote: string, css: string) => {
    const paintDecls = css.match(/(?:fill|stroke)\s*:\s*[^;]+/gi) || [];
    const hasPlatePaint = paintDecls.some((decl) =>
      isChromaPlateColorValue(decl.split(":").slice(1).join(":")),
    );
    return hasPlatePaint ? `style=${quote}display:none${quote}` : match;
  });

  return Buffer.from(text, "utf8");
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
