/**
 * Crop cream/white letterbox bars that image models paint inside an already
 * correct-aspect canvas (common with Vintage Poster on landscape frames).
 */
import sharp from "sharp";

export type LetterboxStripResult = {
  buffer: Buffer;
  changed: boolean;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

function columnStats(
  data: Buffer,
  w: number,
  h: number,
  ch: number,
  x: number,
): { meanLuma: number; variance: number; meanR: number; meanG: number; meanB: number } {
  let sum = 0;
  let sumSq = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const n = h;
  for (let y = 0; y < h; y++) {
    const i = (y * w + x) * ch;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += luma;
    sumSq += luma * luma;
    sumR += r;
    sumG += g;
    sumB += b;
  }
  const meanLuma = sum / n;
  const variance = sumSq / n - meanLuma * meanLuma;
  return {
    meanLuma,
    variance,
    meanR: sumR / n,
    meanG: sumG / n,
    meanB: sumB / n,
  };
}

function rowStats(
  data: Buffer,
  w: number,
  h: number,
  ch: number,
  y: number,
): { meanLuma: number; variance: number } {
  let sum = 0;
  let sumSq = 0;
  const n = w;
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * ch;
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += luma;
    sumSq += luma * luma;
  }
  const meanLuma = sum / n;
  return { meanLuma, variance: sumSq / n - meanLuma * meanLuma };
}

/** Uniform light column/row — cream letterbox, not busy artwork. */
function isLetterboxBand(meanLuma: number, variance: number): boolean {
  return meanLuma >= 175 && variance <= 220;
}

/**
 * Detect and remove side (and optional top/bottom) letterbox bars, then
 * stretch the remaining art back to the original canvas size.
 */
export async function stripLetterboxBars(
  input: Buffer,
  opts?: { minBarFraction?: number; maxBarFraction?: number },
): Promise<LetterboxStripResult> {
  const minBarFraction = opts?.minBarFraction ?? 0.04;
  const maxBarFraction = opts?.maxBarFraction ?? 0.35;

  const { data, info } = await sharp(input)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ch = info.channels;

  let left = 0;
  while (left < w) {
    const s = columnStats(data, w, h, ch, left);
    if (!isLetterboxBand(s.meanLuma, s.variance)) break;
    left++;
  }
  let right = 0;
  while (right < w - left) {
    const s = columnStats(data, w, h, ch, w - 1 - right);
    if (!isLetterboxBand(s.meanLuma, s.variance)) break;
    right++;
  }

  let top = 0;
  while (top < h) {
    const s = rowStats(data, w, h, ch, top);
    if (!isLetterboxBand(s.meanLuma, s.variance)) break;
    top++;
  }
  let bottom = 0;
  while (bottom < h - top) {
    const s = rowStats(data, w, h, ch, h - 1 - bottom);
    if (!isLetterboxBand(s.meanLuma, s.variance)) break;
    bottom++;
  }

  const sideFrac = (left + right) / w;
  const vertFrac = (top + bottom) / h;
  const landscape = w >= h * 1.05;
  const portrait = h >= w * 1.05;

  // On landscape canvases, side bars are the Vintage Poster failure mode —
  // prefer them over incidental light bands at top/bottom (title areas).
  // On portrait canvases, prefer top/bottom bars.
  let useSides =
    sideFrac >= minBarFraction &&
    sideFrac <= maxBarFraction &&
    left + right > 0 &&
    w - left - right >= Math.floor(w * 0.45);
  let useVert =
    vertFrac >= minBarFraction &&
    vertFrac <= maxBarFraction &&
    top + bottom > 0 &&
    h - top - bottom >= Math.floor(h * 0.45);

  if (landscape && useSides) useVert = false;
  if (portrait && useVert) useSides = false;
  if (!landscape && !portrait) {
    // Square: keep the larger letterbox axis only.
    if (useSides && useVert) {
      if (sideFrac >= vertFrac) useVert = false;
      else useSides = false;
    }
  }

  if (!useSides) {
    left = 0;
    right = 0;
  }
  if (!useVert) {
    top = 0;
    bottom = 0;
  }

  if (!useSides && !useVert) {
    return { buffer: input, changed: false, left: 0, right: 0, top: 0, bottom: 0 };
  }

  const cropLeft = left;
  const cropTop = top;
  const cropW = w - left - right;
  const cropH = h - top - bottom;

  const buffer = await sharp(input)
    .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
    .resize(w, h, { fit: "fill" })
    .png()
    .toBuffer();

  return { buffer, changed: true, left, right, top, bottom };
}
