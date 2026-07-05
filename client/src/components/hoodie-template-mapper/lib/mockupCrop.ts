import type { Pt } from "@shared/hoodieTemplate";

export type CropRect = { x: number; y: number; width: number; height: number };

/** Default outward margin on auto-trim (10% of detected content size per side). */
export const AUTO_TRIM_MARGIN_RATIO = 0.1;

export function clampCrop(rect: CropRect, maxW: number, maxH: number): CropRect {
  const x = Math.max(0, Math.min(rect.x, maxW - 1));
  const y = Math.max(0, Math.min(rect.y, maxH - 1));
  const width = Math.max(1, Math.min(rect.width, maxW - x));
  const height = Math.max(1, Math.min(rect.height, maxH - y));
  return { x, y, width, height };
}

/** Expand a crop rect outward by `marginRatio` of its width/height (keeps centered). */
export function expandCropRect(
  rect: CropRect,
  marginRatio: number,
  maxW: number,
  maxH: number,
): CropRect {
  const padX = rect.width * marginRatio;
  const padY = rect.height * marginRatio;
  return clampCrop(
    {
      x: rect.x - padX,
      y: rect.y - padY,
      width: rect.width + padX * 2,
      height: rect.height + padY * 2,
    },
    maxW,
    maxH,
  );
}

export function nudgeCropRect(
  rect: CropRect,
  dx: number,
  dy: number,
  maxW: number,
  maxH: number,
): CropRect {
  return clampCrop({ ...rect, x: rect.x + dx, y: rect.y + dy }, maxW, maxH);
}

/** Resize crop while keeping the same center point. */
export function setCropSizeKeepCenter(
  rect: CropRect,
  width: number,
  height: number,
  maxW: number,
  maxH: number,
): CropRect {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return clampCrop({ x: cx - w / 2, y: cy - h / 2, width: w, height: h }, maxW, maxH);
}

export function centerCropOnCanvas(
  rect: CropRect,
  maxW: number,
  maxH: number,
): CropRect {
  return clampCrop(
    {
      x: (maxW - rect.width) / 2,
      y: (maxH - rect.height) / 2,
      width: rect.width,
      height: rect.height,
    },
    maxW,
    maxH,
  );
}

/** Detect non-empty content bounds (alpha or non-white pixels). */
export function detectMockupContentBounds(
  image: HTMLImageElement,
  opts?: { paddingPx?: number; whiteThreshold?: number; marginRatio?: number },
): CropRect {
  const paddingPx = opts?.paddingPx ?? 0;
  const marginRatio = opts?.marginRatio ?? AUTO_TRIM_MARGIN_RATIO;
  const whiteThreshold = opts?.whiteThreshold ?? 248;
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { x: 0, y: 0, width: w, height: h };
  ctx.drawImage(image, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  let found = false;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const isContent = a > 12 && !(r >= whiteThreshold && g >= whiteThreshold && b >= whiteThreshold);
      if (!isContent) continue;
      found = true;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (!found) return { x: 0, y: 0, width: w, height: h };

  const tight = clampCrop(
    {
      x: minX - paddingPx,
      y: minY - paddingPx,
      width: maxX - minX + 1 + paddingPx * 2,
      height: maxY - minY + 1 + paddingPx * 2,
    },
    w,
    h,
  );
  return expandCropRect(tight, marginRatio, w, h);
}

export function cropImageToCanvas(image: HTMLImageElement, rect: CropRect): HTMLCanvasElement {
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  const crop = clampCrop(rect, w, h);
  const out = document.createElement("canvas");
  out.width = Math.round(crop.width);
  out.height = Math.round(crop.height);
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not create crop canvas");
  ctx.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );
  return out;
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error("Failed to encode cropped PNG"));
      else resolve(blob);
    }, "image/png");
  });
}

export async function cropImageToPngBlob(image: HTMLImageElement, rect: CropRect): Promise<Blob> {
  return canvasToPngBlob(cropImageToCanvas(image, rect));
}

/** Shift polygon anchors after cropping the mockup origin. */
export function offsetAnchors(anchors: Pt[], dx: number, dy: number): Pt[] {
  return anchors.map((a) => ({ x: a.x - dx, y: a.y - dy }));
}
