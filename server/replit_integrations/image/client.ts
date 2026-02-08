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
  // Default to Nano Banana Pro (Google's Gemini image model)
  // Version hash from: https://replicate.com/google/nano-banana-pro
  return process.env.REPLICATE_MODEL_VERSION || "0acb550957f20951ffab7592a64c4da1305179e9f9bf413d4bf99f932dce3ffe";
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
    const msg =
      json?.detail ||
      json?.error ||
      json?.message ||
      `HTTP ${res.status} from ${url}`;
    throw new Error(`Replicate error: ${msg}`);
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

/**
 * Main helper: generate an image via Replicate and return base64 + mimeType.
 */
export async function generateImageBase64(
  params: GenerateImageParams
): Promise<{
  mimeType: string;
  data: string;
}> {
  const token = getReplicateToken();
  const version = getReplicateModelVersion();

  // Nano Banana Pro uses aspect_ratio and resolution, not width/height
  // Use 1K resolution for faster generation (~5-10s vs ~20-30s for 2K)
  const input: Record<string, any> = {
    prompt: params.prompt,
    aspect_ratio: mapToSupportedAspectRatio(params.aspectRatio),
    resolution: "1K",
    output_format: "png",
  };

  if (params.inputImageUrl) {
    input.image_input = [params.inputImageUrl];
  }

  console.log("[Replicate] Creating prediction with version:", version);
  console.log("[Replicate] Input:", JSON.stringify(input, null, 2));

  const created: ReplicatePrediction = await fetchJson(
    "https://api.replicate.com/v1/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version,
        input,
      }),
    }
  );

  console.log("[Replicate] Prediction created:", created.id, "status:", created.status);

  let prediction = created;

  for (let i = 0; i < 120; i++) {
    if (prediction.status === "succeeded") break;
    if (prediction.status === "failed" || prediction.status === "canceled") {
      console.error("[Replicate] Generation failed:", prediction.error);
      throw new Error(
        `Replicate generation ${prediction.status}: ${JSON.stringify(prediction.error) || "Unknown error"}`
      );
    }

    await sleep(1000);

    prediction = await fetchJson(
      `https://api.replicate.com/v1/predictions/${prediction.id}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
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
    throw new Error(
      "Replicate succeeded but did not return an image URL in output"
    );
  }

  console.log("[Replicate] Extracted image URL:", imageUrl.substring(0, 100) + "...");

  return await urlToBase64(imageUrl);
}
