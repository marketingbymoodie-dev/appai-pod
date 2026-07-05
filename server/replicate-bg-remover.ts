/**
 * Replicate Bria / 851-labs saliency background removal — **fallback only** for apparel.
 * Primary matting lives in apparel-matting.ts (chroma key first).
 *
 * Environment: REPLICATE_API_TOKEN
 */

import sharp from "sharp";

const REPLICATE_API_BASE = "https://api.replicate.com/v1";
const REPLICATE_BRIA_BG_REMOVER_VERSION =
  process.env.REPLICATE_BRIA_BG_REMOVER_VERSION ||
  "4ed060b3587b7c3912353dd7d59000c883a6e1c5c9181ed7415c2624c2e8e392";
const REPLICATE_851_LABS_BG_REMOVER_VERSION =
  process.env.REPLICATE_851_LABS_BG_REMOVER_VERSION ||
  process.env.REPLICATE_BG_REMOVER_VERSION ||
  "a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc";
const REPLICATE_POLL_INTERVAL_MS = 750;
const REPLICATE_POLL_TIMEOUT_MS = 60_000;
const REPLICATE_BG_REMOVER_PROVIDER = normalizeBgRemoverProvider(
  process.env.REPLICATE_BG_REMOVER_PROVIDER,
);

type BgRemoverProvider = "bria" | "851labs";

type BgRemoverConfig = {
  provider: BgRemoverProvider;
  version: string;
  input: Record<string, unknown>;
};

export interface RemoveBgParams {
  imageUrl?: string;
  imageBuffer?: Buffer;
  bgColor?: string;
}

export interface RemoveBgResult {
  url: string;
  id: string;
}

export async function bufferFromRemoveBgResult(removeBgResult: RemoveBgResult): Promise<Buffer> {
  if (removeBgResult.url.startsWith("data:")) {
    return Buffer.from(removeBgResult.url.split(",")[1], "base64");
  }
  const response = await fetch(removeBgResult.url);
  if (!response.ok) {
    throw new Error(`Failed to download background removal result: ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Saliency-based removal via Replicate — use only when chroma key fails. */
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

  const completedPrediction = await runBackgroundRemovalPrediction(token, imageInput, {
    hasImageBuffer: Boolean(params.imageBuffer),
  });
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

async function runBackgroundRemovalPrediction(
  token: string,
  imageInput: string,
  options: { hasImageBuffer: boolean },
): Promise<ReplicatePrediction> {
  const configs = buildBgRemoverConfigs(imageInput, options);
  let lastError: unknown;

  for (const config of configs) {
    try {
      const prediction = await createReplicatePrediction(token, config);
      return await pollReplicatePrediction(token, prediction, config.provider);
    } catch (err) {
      lastError = err;
      if (config.provider === "bria" && configs.some((c) => c.provider === "851labs")) {
        console.warn(
          `[removeBackground] Bria failed; falling back to 851-labs: ${(err as Error).message}`,
        );
        continue;
      }
      throw err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Replicate background remover failed");
}

function buildBgRemoverConfigs(
  imageInput: string,
  options: { hasImageBuffer: boolean },
): BgRemoverConfig[] {
  const primary = createBgRemoverConfig(REPLICATE_BG_REMOVER_PROVIDER, imageInput, options);
  if (primary.provider !== "bria") return [primary];
  return [primary, createBgRemoverConfig("851labs", imageInput, options)];
}

function createBgRemoverConfig(
  provider: BgRemoverProvider,
  imageInput: string,
  options: { hasImageBuffer: boolean },
): BgRemoverConfig {
  if (provider === "bria") {
    return {
      provider,
      version: REPLICATE_BRIA_BG_REMOVER_VERSION,
      input: {
        ...(options.hasImageBuffer ? { image: imageInput } : { image_url: imageInput }),
        preserve_alpha: true,
        content_moderation: false,
      },
    };
  }

  return {
    provider,
    version: REPLICATE_851_LABS_BG_REMOVER_VERSION,
    input: { image: imageInput },
  };
}

function normalizeBgRemoverProvider(value: string | undefined): BgRemoverProvider {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "bria") return "bria";
  if (normalized === "851labs" || normalized === "851-labs" || normalized === "851_labs") {
    return "851labs";
  }
  console.warn(`[removeBackground] Unknown REPLICATE_BG_REMOVER_PROVIDER="${value}"; using Bria`);
  return "bria";
}

type ReplicatePrediction = {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  urls?: { get?: string };
  output?: unknown;
  error?: unknown;
};

async function createReplicatePrediction(
  token: string,
  config: BgRemoverConfig,
): Promise<ReplicatePrediction> {
  return fetchReplicateJson(`${REPLICATE_API_BASE}/predictions`, token, {
    method: "POST",
    body: JSON.stringify({ version: config.version, input: config.input }),
  });
}

async function pollReplicatePrediction(
  token: string,
  prediction: ReplicatePrediction,
  provider: BgRemoverProvider,
): Promise<ReplicatePrediction> {
  const getUrl = prediction.urls?.get;
  if (!getUrl) throw new Error("Replicate prediction did not include a polling URL");

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
    throw new Error(`Replicate ${provider} background remover failed: ${detail || latest.status}`);
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
    if (Array.isArray(record.images)) {
      const first = record.images.find((item) => typeof item === "string");
      return first ?? null;
    }
  }
  return null;
}

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

/** @deprecated Use Sharp tiling via /api/pattern/preview */
export async function generatePattern(_params: PatternParams): Promise<PatternResult> {
  throw new Error("generatePattern is deprecated — use Sharp tiling via /api/pattern/preview instead");
}
