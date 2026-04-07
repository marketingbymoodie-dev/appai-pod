/**
 * Replicate image generation client
 *
 * Supports two call modes:
 *   1. Version-hash mode: POST /v1/predictions with { version, input }
 *      Used for: Nano Banana, SDXL (any bare SHA-256 hash)
 *
 *   2. Model-name mode: POST /v1/models/{owner}/{name}/predictions with { input }
 *      Used for: Flux Schnell, SDXL Lightning, SD3, etc.
 *      Stored as "model:owner/name" in the DB (e.g. "model:black-forest-labs/flux-schnell")
 *
 * Required env:
 *   REPLICATE_API_TOKEN=...
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
  // Default to Nano Banana
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
  inputImageUrl?: string | string[] | null;
  isApparel?: boolean;
  isAllOverPrint?: boolean;
  model?: string;
};

// Map aspect ratio to Nano Banana Pro supported values
function mapToSupportedAspectRatio(aspectRatio?: string): string {
  if (!aspectRatio) return "1:1";

  const [wStr, hStr] = aspectRatio.split(":");
  const w = Number(wStr);
  const h = Number(hStr);
  if (!w || !h || Number.isNaN(w) || Number.isNaN(h)) return "1:1";

  const ratio = w / h;

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

// Map aspect ratio string to width/height for models that need explicit dimensions
function aspectRatioToSize(aspectRatio: string): { width: number; height: number } {
  const map: Record<string, { width: number; height: number }> = {
    "1:1": { width: 1024, height: 1024 },
    "2:3": { width: 768, height: 1152 },
    "3:2": { width: 1152, height: 768 },
    "3:4": { width: 768, height: 1024 },
    "4:3": { width: 1024, height: 768 },
    "4:5": { width: 896, height: 1120 },
    "5:4": { width: 1120, height: 896 },
    "9:16": { width: 576, height: 1024 },
    "16:9": { width: 1024, height: 576 },
    "21:9": { width: 1344, height: 576 },
  };
  return map[aspectRatio] || { width: 1024, height: 1024 };
}

const PROMPT_MAX_LENGTH = 900;

function compressPrompt(raw: string, isApparel: boolean, isAllOverPrint: boolean = false): string {
  let compressed: string;

  if (isApparel && isAllOverPrint) {
    // AOP: white background for Picsart removebg, seamless tiling motif
    compressed = raw.replace(
      /\n*MANDATORY IMAGE REQUIREMENTS FOR ALL-OVER PRINT[\s\S]*?(?==== ARTWORK DESCRIPTION|$)/,
      ""
    );
    compressed = compressed.replace(/=== ARTWORK DESCRIPTION ===\s*/g, "");
    compressed = compressed.trim();

    const shortAopConstraints =
      "Isolated centered motif on a SOLID FLAT WHITE (#FFFFFF) background. " +
      "Every pixel not part of the design must be exactly #FFFFFF. " +
      "Do NOT use white in the design itself. " +
      "Vibrant bold colors, clean hard edges, no gradients into background, no rectangular frames. " +
      "Do NOT add any text, words, slogans, or labels unless the user explicitly requested them. ";
    compressed = shortAopConstraints + compressed;
  } else if (isApparel) {
    compressed = raw.replace(
      /\n*MANDATORY IMAGE REQUIREMENTS FOR APPAREL PRINTING[\s\S]*?(?==== ARTWORK DESCRIPTION|$)/,
      ""
    );
    compressed = compressed.replace(/=== ARTWORK DESCRIPTION ===\s*/g, "");
    compressed = compressed.trim();

    const shortApparelConstraints =
      "Isolated centered graphic on a SOLID HOT PINK (#FF00FF) background. " +
      "Every pixel not part of the design must be exactly #FF00FF. " +
      "Do NOT use hot pink or magenta anywhere in the design itself. " +
      "Clean hard edges, no gradients into background, no rectangular frames. " +
      "Do NOT add any text, words, slogans, or labels unless the user explicitly requested them. ";
    compressed = shortApparelConstraints + compressed;
  } else {
    compressed = raw.replace(
      /=== CRITICAL CANVAS REQUIREMENTS[\s\S]*?(?==== ARTWORK DESCRIPTION|=== IMAGE CONTENT|$)/,
      ""
    );
    compressed = compressed.replace(/=== ARTWORK DESCRIPTION ===\s*/g, "");
    compressed = compressed.replace(/=== IMAGE CONTENT REQUIREMENTS ===[\s\S]*?(?=\n\n|$)/g, "");
    compressed = compressed.trim();

    const shortConstraints =
      "Full-bleed, edge-to-edge, no borders, no blank margins. " +
      "Keep important elements away from edges (wraparound safe area). ";
    compressed = shortConstraints + compressed;
  }

  if (compressed.length > PROMPT_MAX_LENGTH) {
    compressed = compressed.substring(0, PROMPT_MAX_LENGTH);
  }

  return compressed;
}

/**
 * Determine if the model string is a version hash (64-char hex) or a model name (owner/name).
 */
function parseModelString(modelStr: string): { type: "version"; hash: string } | { type: "model"; owner: string; name: string } {
  // Strip legacy "replicate:" prefix
  const clean = modelStr.startsWith("replicate:") ? modelStr.slice("replicate:".length) : modelStr;
  // Strip "model:" prefix
  const noModelPrefix = clean.startsWith("model:") ? clean.slice("model:".length) : clean;

  // If it looks like a SHA-256 hash (64 hex chars), it's a version hash
  if (/^[0-9a-f]{64}$/i.test(noModelPrefix)) {
    return { type: "version", hash: noModelPrefix };
  }

  // Otherwise treat as owner/name
  const parts = noModelPrefix.split("/");
  if (parts.length >= 2) {
    return { type: "model", owner: parts[0], name: parts.slice(1).join("/") };
  }

  // Fallback: treat as version hash anyway
  return { type: "version", hash: noModelPrefix };
}

/**
 * Build the input payload for a given model type.
 * Different models have different input schemas.
 */
function buildInput(
  modelIdentifier: string,
  prompt: string,
  aspectRatio: string,
  inputImageUrl?: string | string[] | null
): Record<string, any> {
  const parsed = parseModelString(modelIdentifier);
  const modelName = parsed.type === "model" ? `${parsed.owner}/${parsed.name}` : "";

  // Flux Schnell / Flux Dev
  if (modelName.includes("flux-schnell") || modelName.includes("flux-dev")) {
    const input: Record<string, any> = {
      prompt,
      aspect_ratio: aspectRatio,
      output_format: "png",
      num_inference_steps: 4,
    };
    return input;
  }

  // SDXL Lightning (bytedance)
  if (modelName.includes("sdxl-lightning")) {
    const size = aspectRatioToSize(aspectRatio);
    const input: Record<string, any> = {
      prompt,
      width: size.width,
      height: size.height,
      num_inference_steps: 4,
      scheduler: "K_EULER",
    };
    return input;
  }

  // Stable Diffusion 3
  if (modelName.includes("stable-diffusion-3")) {
    const input: Record<string, any> = {
      prompt,
      aspect_ratio: aspectRatio,
      output_format: "png",
    };
    return input;
  }

  // Default / Nano Banana / SDXL (version-hash based models)
  const input: Record<string, any> = {
    prompt,
    aspect_ratio: aspectRatio,
    output_format: "png",
  };

  if (inputImageUrl) {
    const urls = Array.isArray(inputImageUrl) ? inputImageUrl : [inputImageUrl];
    input.image_input = urls.filter(Boolean);
  }

  return input;
}

/**
 * Run a prediction using the version-hash endpoint.
 */
async function runVersionPrediction(
  token: string,
  versionHash: string,
  input: Record<string, any>,
): Promise<ReplicatePrediction> {
  console.log("[Replicate] Creating version prediction with hash:", versionHash.substring(0, 16) + "...");
  return await fetchJson(
    "https://api.replicate.com/v1/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ version: versionHash, input }),
    }
  );
}

/**
 * Run a prediction using the model-name endpoint (for official/deployment models).
 */
async function runModelPrediction(
  token: string,
  owner: string,
  name: string,
  input: Record<string, any>,
): Promise<ReplicatePrediction> {
  console.log("[Replicate] Creating model prediction for:", `${owner}/${name}`);
  return await fetchJson(
    `https://api.replicate.com/v1/models/${owner}/${name}/predictions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input }),
    }
  );
}

/**
 * Poll a prediction until it completes.
 */
async function pollPrediction(
  token: string,
  predictionId: string,
): Promise<ReplicatePrediction> {
  let prediction: ReplicatePrediction = { id: predictionId, status: "starting" };

  for (let i = 0; i < 120; i++) {
    if (prediction.status === "succeeded") break;
    if (prediction.status === "failed" || prediction.status === "canceled") {
      console.error("[Replicate] Generation failed:", {
        predictionId: prediction.id,
        status: prediction.status,
        error: prediction.error,
      });
      throw new Error(
        `Replicate generation ${prediction.status} (id=${prediction.id}): ${JSON.stringify(prediction.error) || "Unknown error"}`
      );
    }

    await sleep(1000);

    prediction = await fetchJson(
      `https://api.replicate.com/v1/predictions/${predictionId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  }

  if (prediction.status !== "succeeded") {
    throw new Error(`Replicate generation timed out (status=${prediction.status})`);
  }

  return prediction;
}

/**
 * Run a single Replicate prediction (version-hash or model-name) and return base64 image.
 */
async function runPrediction(
  token: string,
  modelStr: string,
  input: Record<string, any>,
): Promise<{ mimeType: string; data: string }> {
  const parsed = parseModelString(modelStr);

  console.log("[Replicate] Model type:", parsed.type, parsed.type === "version" ? parsed.hash.substring(0, 16) + "..." : `${parsed.owner}/${parsed.name}`);
  console.log("[Replicate] Input aspect_ratio:", input.aspect_ratio, "prompt length:", input.prompt?.length);
  console.log("[Replicate] Prompt first 200 chars:", input.prompt?.substring(0, 200));

  let created: ReplicatePrediction;

  if (parsed.type === "version") {
    created = await runVersionPrediction(token, parsed.hash, input);
  } else {
    created = await runModelPrediction(token, parsed.owner, parsed.name, input);
  }

  console.log("[Replicate] Prediction created:", created.id, "status:", created.status);

  // If the prediction already succeeded (via Prefer: wait), skip polling
  let prediction = created;
  if (prediction.status !== "succeeded") {
    prediction = await pollPrediction(token, created.id);
  }

  console.log("[Replicate] Prediction succeeded, output:", JSON.stringify(prediction.output)?.substring(0, 200));

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

  // Use provided model or fall back to default version
  const modelStr = params.model || getReplicateModelVersion();

  const requestedAspectRatio = mapToSupportedAspectRatio(params.aspectRatio);

  // Attempt 0: requested aspect ratio, Attempt 1: 1:1, Attempt 2: 3:4
  const fallbackRatios = [requestedAspectRatio, "1:1", "3:4"];

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < fallbackRatios.length; attempt++) {
    const aspectRatio = fallbackRatios[attempt];

    if (attempt > 0) {
      console.log(`[Replicate] Retry #${attempt} — switching aspect_ratio to "${aspectRatio}"`);
    }

    const compressedPrompt = compressPrompt(params.prompt, params.isApparel ?? false, params.isAllOverPrint ?? false);
    const input = buildInput(modelStr, compressedPrompt, aspectRatio, params.inputImageUrl);

    try {
      return await runPrediction(token, modelStr, input);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[Replicate] Attempt ${attempt + 1}/${fallbackRatios.length} failed:`, lastError.message);
      // Don't retry on 422 (invalid model/version) — it will always fail
      if (lastError.message.includes("status=422")) {
        break;
      }
    }
  }

  throw lastError || new Error("All Replicate generation attempts failed");
}
