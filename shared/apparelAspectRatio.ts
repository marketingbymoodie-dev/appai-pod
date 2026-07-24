/**
 * Print-area aspect ratio helpers for standard DTG apparel (not AOP).
 * Printify front placeholders are portrait; sleeve/neck slots are often landscape
 * and must not drive generation aspect or canvasConfig.
 */

export function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Map pixel dimensions to a supported aspect ratio string. */
export function computeAspectRatioFromPixelDims(w: number, h: number): string {
  if (!w || !h) return "2:3";
  const divisor = gcd(w, h);
  const sw = w / divisor;
  const sh = h / divisor;
  if (sw <= 20 && sh <= 20) return `${sw}:${sh}`;
  const r = w / h;
  if (r >= 1.7) return "16:9";
  if (r >= 1.4) return "3:2";
  if (r >= 1.2) return "4:3";
  if (r >= 0.9) return "1:1";
  if (r >= 0.7) return "3:4";
  if (r >= 0.6) return "2:3";
  return "9:16";
}

/** Positions that must not define chest-print aspect ratio. */
function isNonChestPrintPosition(position: string): boolean {
  const p = position.toLowerCase();
  return (
    p === "back" ||
    p.includes("sleeve") ||
    p.includes("neck") ||
    p.includes("label") ||
    p.includes("inside") ||
    p.includes("hood")
  );
}

/**
 * Pick the front/chest placeholder dims for aspect ratio — never a sleeve/neck slot.
 */
export function pickPrimaryPrintPlaceholderDims(
  placeholderDimensions: Record<string, { width: number; height: number }>,
): { width: number; height: number } | null {
  const entries = Object.entries(placeholderDimensions);
  if (entries.length === 0) return null;

  if (placeholderDimensions.front?.width && placeholderDimensions.front?.height) {
    return placeholderDimensions.front;
  }
  if (placeholderDimensions.default?.width && placeholderDimensions.default?.height) {
    return placeholderDimensions.default;
  }

  const frontLike = entries.find(([pos]) => {
    if (isNonChestPrintPosition(pos)) return false;
    const p = pos.toLowerCase();
    return p === "front" || p.startsWith("front_") || p.includes("front");
  });
  if (frontLike) return frontLike[1];

  const chestCandidates = entries
    .filter(([pos]) => !isNonChestPrintPosition(pos))
    .sort((a, b) => b[1].width * b[1].height - a[1].width * a[1].height);
  if (chestCandidates.length > 0) return chestCandidates[0][1];

  return entries.sort((a, b) => b[1].width * b[1].height - a[1].width * a[1].height)[0]?.[1] ?? null;
}

/**
 * Standard DTG chest prints are portrait. If stored ratio is landscape, swap to portrait.
 */
export function normalizeStandardApparelAspectRatio(aspectRatioStr: string): string {
  const [w, h] = aspectRatioStr.split(":").map(Number);
  if (!w || !h || Number.isNaN(w) || Number.isNaN(h)) return "2:3";
  if (w > h) {
    return computeAspectRatioFromPixelDims(h, w);
  }
  return aspectRatioStr;
}

export function resolveStandardApparelAspectRatioFromPlaceholders(
  placeholderDimensions: Record<string, { width: number; height: number }>,
  fallback = "2:3",
): string {
  const dims = pickPrimaryPrintPlaceholderDims(placeholderDimensions);
  if (!dims?.width || !dims?.height) return fallback;
  let { width: w, height: h } = dims;
  if (w > h) [w, h] = [h, w];
  return computeAspectRatioFromPixelDims(w, h);
}

/**
 * Aspect ratio from a flat-calibration harvest — matches the dashed print guide
 * in FlatProductPlacer (visible/print bounds on the blank). Falls back to
 * printFileDims. Only used when a product has flatCalibration; other apparel
 * keeps per-size probed placeholder ratios from import.
 */
export function aspectRatioFromFlatCalibration(flatCalibration: unknown): string | null {
  let cal: any = flatCalibration;
  if (typeof cal === "string") {
    try {
      cal = JSON.parse(cal);
    } catch {
      return null;
    }
  }
  if (!cal || typeof cal !== "object") return null;
  const view = cal.views?.front || cal.views?.back;
  if (!view || typeof view !== "object") return null;

  // Dashed guide on the mockup = visible / print bounds (normalized mockup space).
  const nr = view.visibleRectNormalized || view.printBoundsNormalized;
  if (nr && Number(nr.width) > 0 && Number(nr.height) > 0) {
    let w = Math.round(Number(nr.width) * 1000);
    let h = Math.round(Number(nr.height) * 1000);
    if (w > h) [w, h] = [h, w];
    return computeAspectRatioFromPixelDims(w, h);
  }

  const dims = view.printFileDims;
  if (!dims?.width || !dims?.height) return null;
  let w = Number(dims.width);
  let h = Number(dims.height);
  if (!w || !h || Number.isNaN(w) || Number.isNaN(h)) return null;
  if (w > h) [w, h] = [h, w];
  return computeAspectRatioFromPixelDims(w, h);
}
