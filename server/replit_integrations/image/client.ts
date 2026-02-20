/**
 * Replicate image generation client
 *
 * Exports a single helper that returns base64 image data + mimeType, compatible
 * with the rest of the server that expects base64 image payloads.
 *
 * Required env:
 *   REPLICATE_API_TOKEN=...
 *
 * Optional env:
 *   REPLICATE_MODEL_VERSION=<version_hash> (defaults to nano-banana-pro)
 *
 * Notes:
 * - Replicate returns hosted image URLs; we fetch the image and convert to base64.
 * - We poll the prediction until it finishes.
 */

type ReplicatePrediction = {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: any;
  error?: any;
};

function getReplicateToken() {
  const token = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
  if (!token) {
    throw new Error(
      "Missing REPLICATE_API_TOKEN (or REPLICATE_API_KEY). Add it to Railway + your local .env"
    );
  }
  return token;
}

function getReplicateModelVersion() {
  // Default to Nano Banana (standard version - faster and cheaper than Pro)
  // Version hash from: https://replicate.com/google/nano-banana
  return process.env.REPLICATE_MODEL_VERSION || "5bdc2c7cd642ae33611d8c33f79615f98ff02509ab8db9d8ec1cc6c36d378fba";
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const requestId = res.headers.get("x-request-id") || json?.id || "unknown";
    console.error("[Replicate] API error response:", {
      status: res.status,
      statusText: res.statusText,
      requestId,
      body: JSON.stringify(json).substring(0, 2000),
      url: url.replace(/\/v1\/predictions\/.*/, "/v1/predictions/[redacted]"),
    });
    const msg =
      json?.detail ||
      json?.error ||
      json?.message ||
      `HTTP ${res.status} from ${url}`;
    throw new Error(`Replicate error (status=${res.status} reqId=${requestId}): ${msg}`);
  }
  return json;
}

function pickFirstImageUrl(output: any): string | null {
  if (!output) return null;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const first = output.find((x) => typeof x === "string");
    return first || null;
  }
  if (typeof output === "object") {
    const maybe = (output.images || output.image) as any;
    if (typeof maybe === "string") return maybe;
    if (Array.isArray(maybe)) {
      const first = maybe.find((x) => typeof x === "string");
      return first || null;
    }
  }
  return null;
}

async function urlToBase64(
  url: string
): Promise<{ mimeType: string; data: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download generated image: HTTP ${res.status}`);
  }
  const contentType = res.headers.get("content-type") || "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  return { mimeType: contentType, data: buf.toString("base64") };
}

export type GenerateImageParams = {
  prompt: string;
  aspectRatio?: string;
  inputImageUrl?: string | null;
};

// Map aspect ratio to Nano Banana Pro supported values
// Supported: "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
function mapToSupportedAspectRatio(aspectRatio?: string): string {
  if (!aspectRatio) return "1:1";

  const [wStr, hStr] = aspectRatio.split(":");
  const w = Number(wStr);
  const h = Number(hStr);
  if (!w || !h || Number.isNaN(w) || Number.isNaN(h)) return "1:1";

  const ratio = w / h;

  // Map to closest supported aspect ratio
  if (ratio >= 2.1) return "21:9";
  if (ratio >= 1.65) return "16:9";
  if (ratio >= 1.4) return "3:2";
  if (ratio >= 1.2) return "4:3";
  if (ratio >= 1.1) return "5:4";
  if (ratio >= 0.9) return "1:1";
  if (ratio >= 0.75) return "4:5";
  if (ratio >= 0.65) return "3:4";
  if (ratio >= 0.55) return "2:3";
  return "9:16";
}

const PROMPT_MAX_LENGTH = 600;

/**
 * Strip the verbose canvas-requirements block injected by the route handler and
 * replace it with a compact version that fits Nano Banana's context window better.
 */
function compressPrompt(raw: string): string {
  // Remove everything between the "=== CRITICAL CANVAS REQUIREMENTS" header
  // and the "=== ARTWORK DESCRIPTION ===" header (or "=== IMAGE CONTENT" as fallback).
  let compressed = raw.replace(
    /=== CRITICAL CANVAS REQUIREMENTS[\s\S]*?(?==== ARTWORK DESCRIPTION|=== IMAGE CONTENT|$)/,
    ""
  );
  // Also strip any leftover section headers
  compressed = compressed.replace(/=== ARTWORK DESCRIPTION ===\s*/g, "");
  compressed = compressed.replace(/=== IMAGE CONTENT REQUIREMENTS ===[\s\S]*?(?=\n\n|$)/g, "");

  compressed = compressed.trim();

  // Prepend a short, model-friendly version of the constraints
  const shortConstraints =
    "Full-bleed, edge-to-edge, no borders, no blank margins. " +
    "Keep important elements away from edges (wraparound safe area). ";

  compressed = shortConstraints + compressed;

  // Hard truncate
  if (compressed.length > PROMPT_MAX_LENGTH) {
    compressed = compressed.substring(0, PROMPT_MAX_LENGTH);
  }

  return compressed;
}

/**
 * Run a single Replicate prediction and return the result.
 */
async function runPrediction(
  token: string,
  version: string,
  input: Record<string, any>,
): Promise<{ mimeType: string; data: string }> {
  console.log("[Replicate] Creating prediction with version:", version);
  console.log("[Replicate] Input aspect_ratio:", input.aspect_ratio, "output_format:", input.output_format, "has_image_input:", !!input.image_input);
  console.log("[Replicate] Prompt length:", input.prompt?.length, "first 200 chars:", input.prompt?.substring(0, 200));

  const created: ReplicatePrediction = await fetchJson(
    "https://api.replicate.com/v1/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ version, input }),
    }
  );

  console.log("[Replicate] Prediction created:", created.id, "status:", created.status);

  let prediction = created;

  for (let i = 0; i < 120; i++) {
    if (prediction.status === "succeeded") break;
    if (prediction.status === "failed" || prediction.status === "canceled") {
      console.error("[Replicate] Generation failed:", {
        predictionId: prediction.id,
        status: prediction.status,
        error: prediction.error,
        fullPrediction: JSON.stringify(prediction).substring(0, 2000),
      });
      throw new Error(
        `Replicate generation ${prediction.status} (id=${prediction.id}): ${JSON.stringify(prediction.error) || "Unknown error"}`
      );
    }

    await sleep(1000);

    prediction = await fetchJson(
      `https://api.replicate.com/v1/predictions/${prediction.id}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  }

  if (prediction.status !== "succeeded") {
    throw new Error(`Replicate generation timed out (status=${prediction.status})`);
  }

  console.log("[Replicate] Prediction succeeded, output:", JSON.stringify(prediction.output));

  const imageUrl = pickFirstImageUrl(prediction.output);
  if (!imageUrl) {
    console.error("[Replicate] Could not extract image URL from output:", prediction.output);
    throw new Error("Replicate succeeded but did not return an image URL in output");
  }

  console.log("[Replicate] Extracted image URL:", imageUrl.substring(0, 100) + "...");

  return await urlToBase64(imageUrl);
}

/**
 * Main helper: generate an image via Replicate and return base64 + mimeType.
 * Retries up to 2 times on failure, cycling through fallback aspect ratios.
 */
export async function generateImageBase64(
  params: GenerateImageParams
): Promise<{
  mimeType: string;
  data: string;
}> {
  const token = getReplicateToken();
  const version = getReplicateModelVersion();

  const compressedPrompt = compressPrompt(params.prompt);
  const requestedAspectRatio = mapToSupportedAspectRatio(params.aspectRatio);

  // Attempt 0: requested aspect ratio, Attempt 1: 1:1, Attempt 2: 3:4
  const fallbackRatios = [requestedAspectRatio, "1:1", "3:4"];

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < fallbackRatios.length; attempt++) {
    const aspectRatio = fallbackRatios[attempt];

    if (attempt > 0) {
      console.log(`[Replicate] Retry #${attempt} — switching aspect_ratio to "${aspectRatio}"`);
    }

    const input: Record<string, any> = {
      prompt: compressedPrompt,
      aspect_ratio: aspectRatio,
      output_format: "png",
    };

    if (params.inputImageUrl) {
      input.image_input = [params.inputImageUrl];
    }

    try {
      return await runPrediction(token, version, input);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[Replicate] Attempt ${attempt + 1}/${fallbackRatios.length} failed:`, lastError.message);
    }
  }

  throw lastError || new Error("All Replicate generation attempts failed");
}
