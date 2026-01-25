/**
 * Replicate image generation client (NO Gemini / NO Replit OIDC image stuff)
 *
 * Exports a single helper that returns base64 image data + mimeType, compatible
 * with the rest of the server that expects base64 image payloads.
 *
 * Required env:
 *   REPLICATE_API_TOKEN=...
 *
 * Optional env:
 *   REPLICATE_MODEL=black-forest-labs/nano-banana
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

function getReplicateModel() {
  // ✅ Default to Nano Banana
  return process.env.REPLICATE_MODEL || "black-forest-labs/nano-banana";
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

function aspectToDims(aspectRatio?: string) {
  const maxDim = 1024;

  if (!aspectRatio) return { width: 1024, height: 1024 };

  const [wStr, hStr] = aspectRatio.split(":");
  const w = Number(wStr);
  const h = Number(hStr);
  if (!w || !h || Number.isNaN(w) || Number.isNaN(h)) {
    return { width: 1024, height: 1024 };
  }

  const ratio = w / h;
  if (ratio >= 1) {
    return { width: maxDim, height: Math.max(256, Math.round(maxDim / ratio)) };
  } else {
    return { width: Math.max(256, Math.round(maxDim * ratio)), height: maxDim };
  }
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
  const model = getReplicateModel();
  const { width, height } = aspectToDims(params.aspectRatio);

  const input: Record<string, any> = {
    prompt: params.prompt,
    width,
    height,
  };

  if (params.inputImageUrl) {
    input.image = params.inputImageUrl;
  }

  const created: ReplicatePrediction = await fetchJson(
    "https://api.replicate.com/v1/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input,
      }),
    }
  );

  let prediction = created;

  for (let i = 0; i < 120; i++) {
    if (prediction.status === "succeeded") break;
    if (prediction.status === "failed" || prediction.status === "canceled") {
      throw new Error(
        `Replicate generation ${prediction.status}: ${prediction.error || "Unknown error"}`
      );
    }

    await sleep(1000);

    prediction = await fetchJson(
      `https://api.replicate.com/v1/predictions/${prediction.id}`,
      {
        method: "GET",
        headers: {
          Authorization: `Token ${token}`,
        },
      }
    );
  }

  if (prediction.status !== "succeeded") {
    throw new Error(`Replicate generation timed out (status=${prediction.status})`);
  }

  const imageUrl = pickFirstImageUrl(prediction.output);
  if (!imageUrl) {
    throw new Error(
      "Replicate succeeded but did not return an image URL in output"
    );
  }

  return await urlToBase64(imageUrl);
}
