/**
 * Adjustable dye-sub tote (Printify bp 1300): one print canvas with two face panels.
 * Top panel = normal orientation; bottom panel = same art rotated 180° (Printify fold line).
 */

export const TOTE_FOLDED_V1_TEMPLATE = "tote_folded_v1" as const;

/** Single face panel (Printify spec for adjustable tote). */
export const TOTE_FOLDED_PANEL_WIDTH = 2650;
export const TOTE_FOLDED_PANEL_HEIGHT = 2625;

/** Full fulfillment canvas sent to Printify (two stacked panels). */
export const TOTE_FOLDED_CANVAS_WIDTH = TOTE_FOLDED_PANEL_WIDTH;
export const TOTE_FOLDED_CANVAS_HEIGHT = TOTE_FOLDED_PANEL_HEIGHT * 2;

/** Map full folded canvas dims to single-face panel dims for flat mockup harvest. */
export function normalizeToteFoldedPanelDims(
  width: number,
  height: number,
): { width: number; height: number } {
  if (width === TOTE_FOLDED_CANVAS_WIDTH && height === TOTE_FOLDED_CANVAS_HEIGHT) {
    return { width: TOTE_FOLDED_PANEL_WIDTH, height: TOTE_FOLDED_PANEL_HEIGHT };
  }
  return { width, height };
}

export type ToteFoldedPlacement = {
  scale?: number;
  offsetX?: number;
  offsetY?: number;
};

export type ToteFoldedBuildInput = {
  sourceWidth: number;
  sourceHeight: number;
  /** RGBA pixels — length = sourceWidth * sourceHeight * 4 */
  pixels: Buffer;
  placement?: ToteFoldedPlacement;
};

export type ToteFoldedBuildResult = {
  width: number;
  height: number;
  pixels: Buffer;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Pure math: compose top panel + 180°-rotated bottom panel into one RGBA buffer.
 * Used by server sharp pipeline and unit tests.
 */
export function composeToteFoldedCanvas(input: ToteFoldedBuildInput): ToteFoldedBuildResult {
  const { sourceWidth, sourceHeight, pixels } = input;
  const scale = clamp(input.placement?.scale ?? 1, 0.05, 4);
  const offsetX = input.placement?.offsetX ?? 0;
  const offsetY = input.placement?.offsetY ?? 0;

  const panelW = TOTE_FOLDED_PANEL_WIDTH;
  const panelH = TOTE_FOLDED_PANEL_HEIGHT;
  const canvasW = TOTE_FOLDED_CANVAS_WIDTH;
  const canvasH = TOTE_FOLDED_CANVAS_HEIGHT;

  const fit = Math.min(panelW / sourceWidth, panelH / sourceHeight) * scale;
  const drawW = Math.max(1, Math.round(sourceWidth * fit));
  const drawH = Math.max(1, Math.round(sourceHeight * fit));
  const cx = panelW / 2 + offsetX * panelW * 0.25;
  const cy = panelH / 2 + offsetY * panelH * 0.25;
  const left = Math.round(cx - drawW / 2);
  const top = Math.round(cy - drawH / 2);

  const out = Buffer.alloc(canvasW * canvasH * 4, 0);

  const sample = (sx: number, sy: number) => {
    const x = clamp(Math.floor(sx), 0, sourceWidth - 1);
    const y = clamp(Math.floor(sy), 0, sourceHeight - 1);
    const i = (y * sourceWidth + x) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]] as const;
  };

  const writePanel = (panelTop: number, rotate180: boolean) => {
    for (let dy = 0; dy < panelH; dy++) {
      for (let dx = 0; dx < panelW; dx++) {
        let lx = dx - left;
        let ly = dy - top;
        if (rotate180) {
          lx = drawW - 1 - lx;
          ly = drawH - 1 - ly;
        }
        if (lx < 0 || ly < 0 || lx >= drawW || ly >= drawH) continue;
        const sx = (lx / drawW) * sourceWidth;
        const sy = (ly / drawH) * sourceHeight;
        const [r, g, b, a] = sample(sx, sy);
        if (a === 0) continue;
        const oi = ((panelTop + dy) * canvasW + dx) * 4;
        out[oi] = r;
        out[oi + 1] = g;
        out[oi + 2] = b;
        out[oi + 3] = a;
      }
    }
  };

  writePanel(0, false);
  writePanel(panelH, true);

  return { width: canvasW, height: canvasH, pixels: out };
}
