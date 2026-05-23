/**
 * Edge gradient map for the magnetic pen tool.
 *
 * On mockup load we run Sobel on a downsampled luminance copy of the image
 * and store the gradient magnitude as a Float32Array. Magnetic-pen mouse
 * moves then look up the strongest gradient peak inside a configurable
 * radius and snap the cursor there.
 *
 * The downsample step keeps the cost bounded on large mockups (Printify
 * panel renders are often 4-8MP). Lookup is O(radius^2) per move which is
 * fine at typical sub-50px snap radii.
 */

import type { Pt } from "@shared/hoodieTemplate";

export type EdgeGradientMap = {
  /** Width of the downsampled grid. */
  width: number;
  height: number;
  /** Mockup pixels per grid pixel. Always >= 1. */
  scale: number;
  /** Gradient magnitudes, length = width * height. Range 0..~1020. */
  magnitudes: Float32Array;
  /** Pre-computed max magnitude for normalization. */
  maxMagnitude: number;
};

const MAX_GRID_DIM = 768;

/**
 * Build a Sobel gradient-magnitude map from an HTMLImageElement (or anything
 * the canvas API can drawImage). Returns null if the canvas can't read pixel
 * data (cross-origin tainted images, OOM, etc.).
 */
export function buildEdgeGradientMap(image: HTMLImageElement | HTMLCanvasElement): EdgeGradientMap | null {
  const srcW = "naturalWidth" in image ? image.naturalWidth : image.width;
  const srcH = "naturalHeight" in image ? image.naturalHeight : image.height;
  if (!srcW || !srcH) return null;

  const scale = Math.max(1, Math.ceil(Math.max(srcW, srcH) / MAX_GRID_DIM));
  const w = Math.max(2, Math.floor(srcW / scale));
  const h = Math.max(2, Math.floor(srcH / scale));

  let imageData: ImageData;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, w, h);
    imageData = ctx.getImageData(0, 0, w, h);
  } catch {
    // Tainted canvas (cross-origin without CORS) — magnetic pen won't work
    // for this image. Caller should fall back to plain polygon behavior.
    return null;
  }

  const data = imageData.data;
  const lum = new Float32Array(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // Rec. 709 luma.
    lum[j] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }

  const magnitudes = new Float32Array(w * h);
  let maxMag = 0;
  for (let y = 1; y < h - 1; y++) {
    const yp = (y - 1) * w;
    const y0 = y * w;
    const yn = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      const tl = lum[yp + x - 1];
      const tc = lum[yp + x];
      const tr = lum[yp + x + 1];
      const ml = lum[y0 + x - 1];
      const mr = lum[y0 + x + 1];
      const bl = lum[yn + x - 1];
      const bc = lum[yn + x];
      const br = lum[yn + x + 1];
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      const mag = Math.sqrt(gx * gx + gy * gy);
      magnitudes[y0 + x] = mag;
      if (mag > maxMag) maxMag = mag;
    }
  }

  return { width: w, height: h, scale, magnitudes, maxMagnitude: maxMag || 1 };
}

/**
 * Find the strongest gradient peak within `radius` mockup-pixels of `p`.
 * Returns null if no peak is meaningfully stronger than the background
 * (avoids snapping to noise on a flat region). When `radius <= 0` the
 * cursor passes through unchanged.
 */
export function findEdgeSnap(
  map: EdgeGradientMap | null,
  p: Pt,
  radius: number,
  /** 0..1; relative threshold against maxMagnitude. */
  minStrength = 0.18,
): Pt | null {
  if (!map || radius <= 0) return null;
  const { width: w, height: h, scale, magnitudes, maxMagnitude } = map;
  const cx = Math.round(p.x / scale);
  const cy = Math.round(p.y / scale);
  const r = Math.max(1, Math.round(radius / scale));
  const x0 = Math.max(1, cx - r);
  const x1 = Math.min(w - 2, cx + r);
  const y0 = Math.max(1, cy - r);
  const y1 = Math.min(h - 2, cy + r);
  if (x0 > x1 || y0 > y1) return null;

  const threshold = maxMagnitude * minStrength;
  let bestMag = 0;
  let bestX = -1;
  let bestY = -1;
  // Slight bias toward the cursor: subtract a small distance penalty so two
  // equally strong edges don't yo-yo when the cursor moves.
  const distScale = 0.25 / Math.max(1, r);
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const row = y * w;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const mag = magnitudes[row + x];
      if (mag <= 0) continue;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > r) continue;
      const score = mag - mag * dist * distScale;
      if (score > bestMag) {
        bestMag = score;
        bestX = x;
        bestY = y;
      }
    }
  }
  if (bestX < 0 || bestMag < threshold) return null;
  return { x: bestX * scale, y: bestY * scale };
}
