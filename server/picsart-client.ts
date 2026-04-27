/**
 * Background removal client.
 *
 * Previously used Picsart/remove.bg. Now uses Replicate's 851-labs
 * background-remover model so we are not blocked by remove.bg credits.
 *
 * Docs:
 *   https://replicate.com/851-labs/background-remover
 *
 * Environment variable required:
 *   REPLICATE_API_TOKEN — API token from https://replicate.com/account/api-tokens
 */

import sharp from "sharp";

const REPLICATE_API_BASE = "https://api.replicate.com/v1";
const REPLICATE_BG_REMOVER_VERSION =
  process.env.REPLICATE_BG_REMOVER_VERSION ||
  "a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc";
const REPLICATE_POLL_INTERVAL_MS = 750;
const REPLICATE_POLL_TIMEOUT_MS = 60_000;

// ─── Remove Background ────────────────────────────────────────────────────────

export interface RemoveBgParams {
  /** URL of the source image (must be publicly accessible). Use imageBuffer instead for internal images. */
  imageUrl?: string;
  /** Raw image buffer — preferred over imageUrl for internal/private images to avoid public URL issues. */
  imageBuffer?: Buffer;
  /**
   * Optional background colour to fill instead of transparency.
   * Hex code (e.g. "#ffffff") or colour name (e.g. "white").
   * If omitted the result will be a transparent PNG.
   */
  bgColor?: string;
}

export interface RemoveBgResult {
  url: string;
  id: string;
}

/**
 * Remove (or replace) the background of an image using Replicate 851-labs.
 * Returns a data URL (base64 PNG) wrapped in a fake URL object for compatibility.
 */
export async function removeBackground(params: RemoveBgParams): Promise<RemoveBgResult> {
  const token = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
  if (!token) {
    throw new Error("REPLICATE_API_TOKEN environment variable is not set");
  }

  if (!params.imageUrl && !params.imageBuffer) {
    throw new Error("Either imageUrl or imageBuffer must be provided");
  }

  const imageInput = params.imageBuffer
    ? `data:image/png;base64,${params.imageBuffer.toString("base64")}`
    : params.imageUrl!;

  const prediction = await createReplicatePrediction(token, {
    image: imageInput,
  });
  const completedPrediction = await pollReplicatePrediction(token, prediction);
  const outputUrl = getReplicateOutputUrl(completedPrediction.output);
  if (!outputUrl) {
    throw new Error("Replicate background remover returned no output image");
  }

  const response = await fetch(outputUrl);
  if (!response.ok) {
    throw new Error(`Failed to download Replicate background result: HTTP ${response.status}`);
  }

  let imageBuffer = Buffer.from(await response.arrayBuffer());
  if (params.bgColor) {
    imageBuffer = await sharp(imageBuffer)
      .flatten({ background: params.bgColor })
      .png()
      .toBuffer();
  }

  const base64 = imageBuffer.toString("base64");
  const dataUrl = `data:image/png;base64,${base64}`;

  return { url: dataUrl, id: completedPrediction.id || crypto.randomUUID() };
}

type ReplicatePrediction = {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  urls?: {
    get?: string;
  };
  output?: unknown;
  error?: unknown;
};

async function createReplicatePrediction(
  token: string,
  input: Record<string, unknown>,
): Promise<ReplicatePrediction> {
  return fetchReplicateJson(`${REPLICATE_API_BASE}/predictions`, token, {
    method: "POST",
    body: JSON.stringify({
      version: REPLICATE_BG_REMOVER_VERSION,
      input,
    }),
  });
}

async function pollReplicatePrediction(
  token: string,
  prediction: ReplicatePrediction,
): Promise<ReplicatePrediction> {
  const getUrl = prediction.urls?.get;
  if (!getUrl) {
    throw new Error("Replicate prediction did not include a polling URL");
  }

  let latest = prediction;
  const startedAt = Date.now();
  while (latest.status === "starting" || latest.status === "processing") {
    if (Date.now() - startedAt > REPLICATE_POLL_TIMEOUT_MS) {
      throw new Error("Replicate background remover timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, REPLICATE_POLL_INTERVAL_MS));
    latest = await fetchReplicateJson(getUrl, token);
  }

  if (latest.status !== "succeeded") {
    const detail = typeof latest.error === "string" ? latest.error : JSON.stringify(latest.error);
    throw new Error(`Replicate background remover failed: ${detail || latest.status}`);
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

  const response = await fetch(url, {
    ...init,
    headers,
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail =
      json?.detail ||
      json?.error ||
      json?.message ||
      `HTTP ${response.status} from Replicate`;
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
    if (Array.isArray(record.images)) {
      const first = record.images.find((item) => typeof item === "string");
      return first ?? null;
    }
  }
  return null;
}

// ─── Pattern Generator ────────────────────────────────────────────────────────
// Note: Picsart pattern generation is no longer used — we use Sharp tiling instead.
// This stub is kept for import compatibility only.

export type PatternType = "hex" | "mirror" | "diamond" | "hex2" | "tile";

export interface PatternParams {
  imageUrl: string;
  pattern?: PatternType;
  scale?: number;
  rotate?: number;
  offsetX?: number;
  offsetY?: number;
  width?: number;
  height?: number;
}

export interface PatternResult {
  url: string;
  id: string;
}

/**
 * @deprecated Sharp tiling is used instead. This function is kept for import compatibility.
 */
export async function generatePattern(_params: PatternParams): Promise<PatternResult> {
  throw new Error("generatePattern is deprecated — use Sharp tiling via /api/pattern/preview instead");
}
