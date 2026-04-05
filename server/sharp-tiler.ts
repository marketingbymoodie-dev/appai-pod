/**
 * sharp-tiler.ts
 *
 * Server-side pattern tiling using Sharp.
 *
 * Replaces the Picsart pattern API for the tiling step.
 * Picsart is still used for background removal (higher quality).
 *
 * Tiling modes:
 *   - "grid"   : straight repeat (default)
 *   - "brick"  : brick-offset — each row offset by 50% horizontally
 *   - "half"   : half-drop — each column offset by 50% vertically
 *
 * Algorithm:
 *   1. Resize the motif to (outputW / cols) × (outputH / rows) based on scale.
 *   2. Composite tileW × tileH copies onto a canvas of outputW × outputH.
 *   3. Fill uncovered edges with a final crop/extend.
 */

import sharp from "sharp";

export type TileMode = "grid" | "brick" | "half";

export interface TileOptions {
  /** Motif image as a Buffer (PNG or JPEG) */
  motifBuffer: Buffer;
  /** Output canvas width in pixels */
  outputWidth: number;
  /** Output canvas height in pixels */
  outputHeight: number;
  /**
   * Scale factor that controls how large each tile is relative to the canvas.
   * scale=1.0 → tile fills 1/3 of the canvas width (≈3 columns)
   * scale=2.0 → tile fills 2/3 of the canvas width (≈1.5 columns)
   * scale=1.5 → tile fills 1/2 of the canvas width (≈2 columns)
   *
   * Internally: tileW = outputWidth * (scale / 3)
   */
  scale?: number;
  /** Tiling mode (default: "grid") */
  mode?: TileMode;
  /**
   * Background fill colour as a hex string (e.g. "#ffffff") or "" for transparent.
   * This is the canvas background before tiles are composited.
   */
  bgColor?: string;
}

export interface TileResult {
  buffer: Buffer;
  tileWidth: number;
  tileHeight: number;
  cols: number;
  rows: number;
}

/**
 * Parse a hex colour string into { r, g, b } components.
 * Returns white { r:255, g:255, b:255 } for invalid/empty input.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace(/^#/, "");
  if (clean.length === 3) {
    return {
      r: parseInt(clean[0] + clean[0], 16),
      g: parseInt(clean[1] + clean[1], 16),
      b: parseInt(clean[2] + clean[2], 16),
    };
  }
  if (clean.length === 6) {
    return {
      r: parseInt(clean.slice(0, 2), 16),
      g: parseInt(clean.slice(2, 4), 16),
      b: parseInt(clean.slice(4, 6), 16),
    };
  }
  return { r: 255, g: 255, b: 255 };
}

/**
 * Tile a motif image into a seamless pattern using Sharp.
 */
export async function tileImage(opts: TileOptions): Promise<TileResult> {
  const {
    motifBuffer,
    outputWidth,
    outputHeight,
    scale = 1.5,
    mode = "grid",
    bgColor = "#ffffff",
  } = opts;

  // Determine tile dimensions based on scale.
  // scale=1.5 → tileW = outputWidth * 1.5 / 3 = outputWidth / 2 (2 columns)
  // scale=1.0 → tileW = outputWidth / 3 (3 columns)
  // scale=3.0 → tileW = outputWidth (1 column)
  const tileWidth = Math.max(32, Math.round(outputWidth * (scale / 3)));
  const tileHeight = Math.max(32, Math.round(outputHeight * (scale / 3)));

  // Resize motif to tile dimensions, preserving aspect ratio with padding
  const motifMeta = await sharp(motifBuffer).metadata();
  const motifAspect = (motifMeta.width ?? 1) / (motifMeta.height ?? 1);

  // Fit inside tileWidth × tileHeight, then extend with transparency to exact tile size
  const resizedMotif = await sharp(motifBuffer)
    .resize(tileWidth, tileHeight, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  // Build the canvas background
  const bgRgb = bgColor ? hexToRgb(bgColor) : null;
  const canvasBackground = bgRgb
    ? { r: bgRgb.r, g: bgRgb.g, b: bgRgb.b, alpha: 255 }
    : { r: 0, g: 0, b: 0, alpha: 0 };

  // Calculate how many columns and rows we need to cover the canvas
  // Add 2 extra in each direction to handle offsets and ensure full coverage
  const cols = Math.ceil(outputWidth / tileWidth) + 2;
  const rows = Math.ceil(outputHeight / tileHeight) + 2;

  // Build composite operations
  const composites: sharp.OverlayOptions[] = [];

  for (let row = -1; row < rows - 1; row++) {
    for (let col = -1; col < cols - 1; col++) {
      let x = col * tileWidth;
      let y = row * tileHeight;

      // Apply offset for brick/half-drop modes
      if (mode === "brick" && row % 2 !== 0) {
        x += Math.round(tileWidth / 2);
      } else if (mode === "half" && col % 2 !== 0) {
        y += Math.round(tileHeight / 2);
      }

      composites.push({
        input: resizedMotif,
        left: x,
        top: y,
        blend: "over",
      });
    }
  }

  // Create canvas and composite all tiles
  const outputBuffer = await sharp({
    create: {
      width: outputWidth,
      height: outputHeight,
      channels: bgRgb ? 3 : 4,
      background: canvasBackground,
    },
  })
    .composite(composites)
    .png({ compressionLevel: 6 })
    .toBuffer();

  return {
    buffer: outputBuffer,
    tileWidth,
    tileHeight,
    cols: cols - 2,
    rows: rows - 2,
  };
}
