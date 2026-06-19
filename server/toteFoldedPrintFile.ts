import sharp from "sharp";
import {
  composeToteFoldedCanvas,
  TOTE_FOLDED_CANVAS_HEIGHT,
  TOTE_FOLDED_CANVAS_WIDTH,
  type ToteFoldedPlacement,
} from "@shared/toteFoldedLayout";

export type { ToteFoldedPlacement };

/** Build the single Printify fulfillment PNG (2650×5250) from customer artwork. */
export async function buildToteFoldedPrintPng(
  source: Buffer,
  placement?: ToteFoldedPlacement,
): Promise<Buffer> {
  const { data, info } = await sharp(source)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const composed = composeToteFoldedCanvas({
    sourceWidth: info.width,
    sourceHeight: info.height,
    pixels: data,
    placement,
  });

  return sharp(composed.pixels, {
    raw: { width: composed.width, height: composed.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

export async function buildToteFoldedPrintPngFromUrl(
  url: string,
  placement?: ToteFoldedPlacement,
): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch artwork (${res.status})`);
  return buildToteFoldedPrintPng(Buffer.from(await res.arrayBuffer()), placement);
}

export const TOTE_FOLDED_PRINT_DIMS = {
  width: TOTE_FOLDED_CANVAS_WIDTH,
  height: TOTE_FOLDED_CANVAS_HEIGHT,
};
