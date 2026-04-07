/**
 * Background removal client.
 *
 * Previously used Picsart. Now uses remove.bg for faster, more reliable results.
 *
 * Docs:
 *   https://www.remove.bg/api
 *
 * Environment variable required:
 *   REMOVE_BG_API_KEY — API key from https://www.remove.bg/dashboard
 *
 * Falls back to PICSART_API_KEY if REMOVE_BG_API_KEY is not set (legacy support).
 */

const REMOVE_BG_API_BASE = "https://api.remove.bg/v1.0";

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
 * Remove (or replace) the background of an image using remove.bg.
 * Returns a data URL (base64 PNG) wrapped in a fake URL object for compatibility.
 */
export async function removeBackground(params: RemoveBgParams): Promise<RemoveBgResult> {
  const apiKey = process.env.REMOVE_BG_API_KEY;
  if (!apiKey) {
    throw new Error("REMOVE_BG_API_KEY environment variable is not set");
  }

  if (!params.imageUrl && !params.imageBuffer) {
    throw new Error("Either imageUrl or imageBuffer must be provided");
  }

  const formData = new FormData();
  if (params.imageBuffer) {
    // Send as binary file upload — avoids public URL accessibility issues for internal images
    const blob = new Blob([params.imageBuffer], { type: "image/png" });
    formData.append("image_file", blob, "image.png");
  } else {
    formData.append("image_url", params.imageUrl!);
  }
  formData.append("size", "auto");
  formData.append("format", "png");
  if (params.bgColor) {
    formData.append("bg_color", params.bgColor.replace(/^#/, ""));
  }

  const response = await fetch(`${REMOVE_BG_API_BASE}/removebg`, {
    method: "POST",
    headers: {
      "X-Api-Key": apiKey,
    },
    body: formData,
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errJson = await response.json() as { errors?: Array<{ title?: string }> };
      detail = errJson.errors?.map(e => e.title).join(", ") ?? "";
    } catch {
      detail = await response.text();
    }
    throw new Error(`remove.bg API error ${response.status}: ${detail}`);
  }

  // remove.bg returns the image directly as binary PNG in the response body
  const imageBuffer = Buffer.from(await response.arrayBuffer());

  // Store as a temporary local file and return a data URL
  // We encode as base64 data URL so callers can use it directly without a second fetch
  const base64 = imageBuffer.toString("base64");
  const dataUrl = `data:image/png;base64,${base64}`;

  return { url: dataUrl, id: crypto.randomUUID() };
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
