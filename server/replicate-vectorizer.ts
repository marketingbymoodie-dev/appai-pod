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

/** Strip chroma-key pink from traced SVG (fast string pass, no extra API latency). */
export function sanitizeVectorSvg(svg: Buffer): Buffer {
  let text = svg.toString("utf8");
  if (!text.includes("<svg")) return svg;

  const pinkFill =
    /fill\s*=\s*["'](?:#ff00ff|#FF00FF|#f0f|#F0F|rgb\(\s*255\s*,\s*0\s*,\s*255\s*\)|rgba\(\s*255\s*,\s*0\s*,\s*255\s*,[^)]+\))["']/gi;
  const pinkStroke =
    /stroke\s*=\s*["'](?:#ff00ff|#FF00FF|#f0f|#F0F|rgb\(\s*255\s*,\s*0\s*,\s*255\s*\)|rgba\(\s*255\s*,\s*0\s*,\s*255\s*,[^)]+\))["']/gi;

  text = text.replace(pinkFill, 'fill="none"');
  text = text.replace(pinkStroke, 'stroke="none"');
  text = text.replace(
    /style\s*=\s*["'][^"']*(?:fill|stroke)\s*:\s*(?:#ff00ff|#FF00FF|#f0f|#F0F|rgb\(\s*255\s*,\s*0\s*,\s*255\s*\))[^"']*["']/gi,
    'style="display:none"',
  );

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
