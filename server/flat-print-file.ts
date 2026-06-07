/**
 * Order-time print-file bake for "on-the-fly" flat / mesh products.
 *
 * The storefront preview (client `FlatProductPlacer` + `lib/flatRender.ts`)
 * composites the customer's artwork onto a calibrated blank using a NORMALIZED
 * placement (`{ scale, offsetX, offsetY }`) relative to the detected visible
 * print rect. At order time we must hand Printify a real print file that lands
 * the artwork in the exact same geometry as that preview.
 *
 * Known Printify quirk (see `scripts/harvest-flat-mockups.ts:181-198` and
 * `server/flat-calibration.ts:42-44`): Printify ignores the uploaded image's
 * pixel size, clamps the placement `scale` at 1.0, and at scale=1 lays the
 * image at the print-area width and clips to the printable rect. The harvested
 * `visibleRectNormalized` was captured as the full print area at scale=1.
 *
 * RECOMMENDED APPROACH — bake, don't transform:
 *   - Rasterize the print file ourselves at `printFileDims` (the full print
 *     area). Because the harvested visible rect IS the full print area at
 *     scale=1, mapping the customer's placement onto `rect = {0,0,printW,printH}`
 *     reproduces the preview geometry exactly.
 *   - Draw the RAW artwork (no mask, no shading — those are mockup-only).
 *   - Submit to Printify at `{ x:0.5, y:0.5, scale:1, angle:0 }` (full-bleed
 *     center), which sidesteps the scale clamp.
 *   - MESH tier: the print file is still a flat blit at `printFileDims`
 *     (curvature is a mockup-only artifact) — we do NOT warp the print file.
 *
 * The `flatArtBox` math below is a server-side PORT of the client's
 * `flatArtBox` in `client/src/components/designer/FlatProductPlacer/lib/flatRender.ts`.
 * It is intentionally duplicated (NOT imported) to keep the server free of any
 * client/browser coupling. Keep the two in sync if the placement math changes.
 */
import sharp from "sharp";
import {
  uploadToFlatCalibrationBucket,
  ensureFlatCalibrationBucket,
  isSupabaseFlatCalibrationConfigured,
} from "./supabaseFlatCalibration";

export type FlatPlacement = { scale: number; offsetX: number; offsetY: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type PrintFileDims = { width: number; height: number };

const PRINTIFY_API_BASE = "https://api.printify.com/v1";

/**
 * Server-side port of the client `flatArtBox`. Baseline (scale=1) = the
 * smallest uniform scale that fully COVERS `rect`; reducing scale reveals
 * background at the edges (matching the preview's coverage behaviour).
 */
export function flatArtBox(
  rect: Rect,
  placement: FlatPlacement,
  artW: number,
  artH: number,
): Rect {
  const aspectSafeW = artW > 0 ? artW : 1;
  const aspectSafeH = artH > 0 ? artH : 1;
  const cover = Math.max(rect.width / aspectSafeW, rect.height / aspectSafeH);
  const k = cover * placement.scale;
  const drawW = aspectSafeW * k;
  const drawH = aspectSafeH * k;
  const cx = rect.x + rect.width * (0.5 + placement.offsetX);
  const cy = rect.y + rect.height * (0.5 + placement.offsetY);
  return { x: cx - drawW / 2, y: cy - drawH / 2, width: drawW, height: drawH };
}

async function downloadBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export type BakeFlatPrintFileArgs = {
  /** Raw print-ready artwork — provide a URL (`designImageUrl`) or a buffer. */
  artworkUrl?: string;
  artworkBuffer?: Buffer;
  /** The view's normalized placement from `flatPlacerState.placements[view]`. */
  placement: FlatPlacement;
  /** Print area pixel dims for this view (`flatCalibration.views[view].printFileDims`). */
  printFileDims: PrintFileDims;
};

export type BakeFlatPrintFileResult = {
  buffer: Buffer;
  width: number;
  height: number;
};

/**
 * Bake one view's print file: a transparent PNG sized to `printFileDims` with
 * the raw artwork drawn at the placement geometry (clipped to the canvas like
 * the preview's `drawImage`). Submit the result to Printify at scale=1 center.
 */
export async function bakeFlatPrintFile(
  args: BakeFlatPrintFileArgs,
): Promise<BakeFlatPrintFileResult> {
  const { placement, printFileDims } = args;
  const printW = Math.max(2, Math.round(printFileDims.width));
  const printH = Math.max(2, Math.round(printFileDims.height));

  let artworkBuffer = args.artworkBuffer;
  if (!artworkBuffer) {
    if (!args.artworkUrl) throw new Error("bakeFlatPrintFile: artworkUrl or artworkBuffer required");
    artworkBuffer = await downloadBuffer(args.artworkUrl);
  }

  const meta = await sharp(artworkBuffer).metadata();
  const artW = meta.width ?? 0;
  const artH = meta.height ?? 0;
  if (artW <= 0 || artH <= 0) throw new Error("bakeFlatPrintFile: could not read artwork dimensions");

  const rect: Rect = { x: 0, y: 0, width: printW, height: printH };
  const box = flatArtBox(rect, placement, artW, artH);

  const drawW = Math.max(1, Math.round(box.width));
  const drawH = Math.max(1, Math.round(box.height));
  const left = Math.round(box.x);
  const top = Math.round(box.y);

  // Resize the artwork to its on-canvas draw box, then crop to the portion that
  // actually lands inside the print canvas (replicates canvas drawImage clip).
  const resized = await sharp(artworkBuffer)
    .resize(drawW, drawH, { fit: "fill" })
    .ensureAlpha()
    .png()
    .toBuffer();

  const base = sharp({
    create: { width: printW, height: printH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  });

  // Source-crop offsets (how much of the resized art is off the left/top edge).
  const sx = left < 0 ? -left : 0;
  const sy = top < 0 ? -top : 0;
  const destLeft = Math.max(0, left);
  const destTop = Math.max(0, top);
  const visibleW = Math.min(drawW - sx, printW - destLeft);
  const visibleH = Math.min(drawH - sy, printH - destTop);

  if (visibleW <= 0 || visibleH <= 0) {
    // Artwork is entirely off-canvas — emit a transparent print file.
    const buffer = await base.png().toBuffer();
    return { buffer, width: printW, height: printH };
  }

  let overlay = resized;
  if (sx > 0 || sy > 0 || visibleW < drawW || visibleH < drawH) {
    overlay = await sharp(resized)
      .extract({ left: sx, top: sy, width: visibleW, height: visibleH })
      .png()
      .toBuffer();
  }

  const buffer = await base
    .composite([{ input: overlay, left: destLeft, top: destTop }])
    .png()
    .toBuffer();

  return { buffer, width: printW, height: printH };
}

/**
 * Persist a baked print file to the Supabase flat-calibration bucket for
 * audit / reprint. Best-effort: returns null when Supabase is not configured.
 */
export async function persistBakedPrintFile(
  productTypeId: number | string,
  designId: string,
  view: string,
  buffer: Buffer,
): Promise<string | null> {
  if (!isSupabaseFlatCalibrationConfigured()) return null;
  await ensureFlatCalibrationBucket();
  const safeDesign = String(designId).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `print-files/${productTypeId}/${safeDesign}-${view}.png`;
  return uploadToFlatCalibrationBucket(path, buffer, "image/png");
}

/**
 * Upload a buffer to Printify's image library. Mirrors the proven pattern in
 * `server/flat-calibration.ts:102-108`. Returns the Printify image id used in
 * a product / order `print_areas[].placeholders[].images[].id`.
 */
export async function uploadPrintFileToPrintify(
  token: string,
  fileName: string,
  buffer: Buffer,
): Promise<string> {
  const res = await fetch(`${PRINTIFY_API_BASE}/uploads/images.json`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ file_name: fileName, contents: buffer.toString("base64") }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Printify upload ${res.status}: ${text.slice(0, 300)}`);
  const json = text ? JSON.parse(text) : {};
  if (!json.id) throw new Error("Printify upload returned no image id");
  return String(json.id);
}
