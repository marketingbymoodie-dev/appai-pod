/**
 * Picsart Pattern Generator API client.
 * Docs: https://docs.picsart.io/reference/image-generate-pattern
 *
 * Endpoint: POST https://api.picsart.io/tools/1.0/background/pattern
 *
 * Takes a source motif image and tiles it into a seamless repeating pattern
 * at a requested output size. Used for All-Over-Print (AOP) products where
 * the same pattern is applied across all panels.
 */

const PICSART_API_BASE = "https://api.picsart.io/tools/1.0";

export type PatternType = "hex" | "mirror" | "diamond" | "hex2" | "tile";

export interface PatternParams {
  /** URL of the source motif image (must be publicly accessible) */
  imageUrl: string;
  /** Tiling pattern type (default: "tile") */
  pattern?: PatternType;
  /** Scale factor 0.5–10.0 (default: 1.0) */
  scale?: number;
  /** Rotation angle -180 to 180 degrees (default: 0) */
  rotate?: number;
  /** X offset from center in pixels (default: 0) */
  offsetX?: number;
  /** Y offset from center in pixels (default: 0) */
  offsetY?: number;
  /** Output image width in pixels (max 8000, default 1024) */
  width?: number;
  /** Output image height in pixels (max 8000, default 1024) */
  height?: number;
}

export interface PatternResult {
  url: string;
  id: string;
}

/**
 * Generate a seamless tiled pattern from a source motif image using Picsart.
 * Returns the URL of the tiled pattern image (PNG).
 */
export async function generatePattern(params: PatternParams): Promise<PatternResult> {
  const apiKey = process.env.PICSART_API_KEY;
  if (!apiKey) {
    throw new Error("PICSART_API_KEY environment variable is not set");
  }

  const formData = new FormData();
  formData.append("image_url", params.imageUrl);
  formData.append("format", "PNG");
  formData.append("pattern", params.pattern ?? "tile");
  formData.append("scale", String(params.scale ?? 1.0));
  formData.append("rotate", String(params.rotate ?? 0));
  formData.append("offset_x", String(params.offsetX ?? 0));
  formData.append("offset_y", String(params.offsetY ?? 0));

  const width = Math.min(params.width ?? 1024, 8000);
  const height = Math.min(params.height ?? 1024, 8000);
  formData.append("width", String(width));
  formData.append("height", String(height));

  const response = await fetch(`${PICSART_API_BASE}/background/pattern`, {
    method: "POST",
    headers: {
      "X-Picsart-API-Key": apiKey,
    },
    body: formData,
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errJson = await response.json() as { detail?: string; message?: string };
      detail = errJson.detail ?? errJson.message ?? "";
    } catch {
      detail = await response.text();
    }
    throw new Error(`Picsart pattern API error ${response.status}: ${detail}`);
  }

  const data = await response.json() as {
    data?: { id: string; url: string };
    status?: string;
  };

  const resultId = data.data?.id ?? "";
  const resultUrl = data.data?.url ?? "";

  if (!resultUrl) {
    throw new Error("Picsart pattern API returned no image URL");
  }

  return { url: resultUrl, id: resultId };
}
