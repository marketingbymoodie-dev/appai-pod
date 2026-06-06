/**
 * Edge gradient map for the magnetic pen tool.
 *
 * On mockup load we run Sobel on a downsampled copy of the image and store
 * a combined gradient magnitude as a Float32Array. Magnetic-pen mouse moves
 * then look up the strongest gradient peak inside a configurable radius
 * and snap the cursor there.
 *
 * The combined magnitude blends:
 *   - LUMINANCE gradient  (Rec. 709 luma) — picks up colour/contrast edges.
 *   - ALPHA gradient      — picks up transparent-background silhouettes.
 *
 * Alpha is given a heavy weight (ALPHA_WEIGHT) so a transparent-background
 * mockup's silhouette dominates internal seams, drawstrings, etc. — the
 * silhouette is what users actually want to trace on a hoodie panel.
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
 * Weight applied to the alpha gradient before combining with luminance.
 * The silhouette of a transparent-background mockup is the cleanest edge
 * we have, so we want it to win decisively against any internal contrast.
 *
 * With the combined formula `magL + ALPHA_WEIGHT * magA`, a silhouette
 * pixel (which has BOTH a strong luminance step from foreground colour to
 * transparent black AND a strong alpha step from 255 → 0) ends up roughly
 * (1 + ALPHA_WEIGHT)x stronger than an internal seam (luminance only).
 * That comfortably moves internal edges below the relative-strength
 * threshold in `findEdgeSnap`, so they fall through to raw cursor instead
 * of yanking points off-silhouette.
 */
const ALPHA_WEIGHT = 4;

/**
 * Minimum alpha range for the alpha channel to count as "informative".
 * If every pixel in the downsampled image has the same alpha (e.g. a
 * fully opaque JPEG or a flattened PNG), the alpha gradient is pure
 * floating-point noise — disable it and fall back to luminance only.
 */
const ALPHA_RANGE_THRESHOLD = 16;

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
  const alpha = new Float32Array(w * h);
  let alphaMin = 255;
  let alphaMax = 0;
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // Rec. 709 luma.
    lum[j] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    const a = data[i + 3];
    alpha[j] = a;
    if (a < alphaMin) alphaMin = a;
    if (a > alphaMax) alphaMax = a;
  }

  // Only mix in the alpha gradient if the alpha channel actually varies
  // across the image. Flattened/opaque mockups don't get bogus snap targets
  // from numerical noise.
  const useAlpha = alphaMax - alphaMin >= ALPHA_RANGE_THRESHOLD;

  const magnitudes = new Float32Array(w * h);
  let maxMag = 0;
  for (let y = 1; y < h - 1; y++) {
    const yp = (y - 1) * w;
    const y0 = y * w;
    const yn = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      // Sobel on luminance.
      const ltl = lum[yp + x - 1];
      const ltc = lum[yp + x];
      const ltr = lum[yp + x + 1];
      const lml = lum[y0 + x - 1];
      const lmr = lum[y0 + x + 1];
      const lbl = lum[yn + x - 1];
      const lbc = lum[yn + x];
      const lbr = lum[yn + x + 1];
      const lgx = -ltl - 2 * lml - lbl + ltr + 2 * lmr + lbr;
      const lgy = -ltl - 2 * ltc - ltr + lbl + 2 * lbc + lbr;
      const magL = Math.sqrt(lgx * lgx + lgy * lgy);

      let mag = magL;
      if (useAlpha) {
        // Sobel on alpha — boundary between transparent and opaque pixels.
        const atl = alpha[yp + x - 1];
        const atc = alpha[yp + x];
        const atr = alpha[yp + x + 1];
        const aml = alpha[y0 + x - 1];
        const amr = alpha[y0 + x + 1];
        const abl = alpha[yn + x - 1];
        const abc = alpha[yn + x];
        const abr = alpha[yn + x + 1];
        const agx = -atl - 2 * aml - abl + atr + 2 * amr + abr;
        const agy = -atl - 2 * atc - atr + abl + 2 * abc + abr;
        const magA = Math.sqrt(agx * agx + agy * agy);
        mag = magL + ALPHA_WEIGHT * magA;
      }

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
