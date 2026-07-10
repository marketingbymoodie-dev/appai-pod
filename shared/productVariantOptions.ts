/**
 * Detect when Printify "color" / option dimension duplicates size/orientation
 * already offered in the Size dropdown (e.g. tapestry 26×36 vs 36×26).
 */

export type SizeLike = { id: string; name: string; width?: number; height?: number };
export type ColorLike = { id: string; name: string };

/** Shopify / Printify option tokens: `26''_×_36''`, `26" x 36"`, `68x88`, etc. */
const DIM_PATTERN =
  /(\d+)\s*(?:''|"|″|inch|in)?\s*[_\s-]*[xX×]\s*[_\s-]*(\d+)\s*(?:''|"|″|inch|in)?/;

export function extractDimensionalKey(value: string): string | null {
  const m = String(value || "").match(DIM_PATTERN);
  if (!m) return null;
  return `${parseInt(m[1], 10)}x${parseInt(m[2], 10)}`;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().trim().replace(/[\s_-]+/g, "_");
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Aspect ratio string for a size row (per-size AR, dims, or product fallback). */
export function resolveSizeAspectRatio(
  size: SizeLike,
  productAspectRatio?: string | null,
): string {
  if (size.width && size.height && size.width > 0 && size.height > 0) {
    const d = gcd(Math.round(size.width), Math.round(size.height));
    return `${Math.round(size.width / d)}:${Math.round(size.height / d)}`;
  }
  const fromId = extractDimensionalKey(size.id);
  const fromName = extractDimensionalKey(size.name);
  const dim = fromId || fromName;
  if (dim) {
    const [w, h] = dim.split("x").map(Number);
    if (w && h) {
      const d = gcd(w, h);
      return `${w / d}:${h / d}`;
    }
  }
  return productAspectRatio || "3:4";
}

/**
 * True when every frame-color option is really an orientation/size already in `sizes`
 * — hide the redundant OPTION dropdown (tapestry portrait vs landscape).
 */
export function frameColorsRedundantWithSizes(
  sizes: SizeLike[],
  frameColors: ColorLike[],
  colorLabel?: string | null,
): boolean {
  if (frameColors.length === 0 || sizes.length === 0) return false;

  const sizeDimKeys = new Set<string>();
  for (const s of sizes) {
    const fromId = extractDimensionalKey(s.id);
    const fromName = extractDimensionalKey(s.name);
    if (fromId) sizeDimKeys.add(fromId);
    if (fromName) sizeDimKeys.add(fromName);
    sizeDimKeys.add(normalizeToken(s.id));
    sizeDimKeys.add(normalizeToken(s.name));
  }

  const colorDims = frameColors.map((c) => ({
    dim: extractDimensionalKey(c.id) || extractDimensionalKey(c.name),
    id: normalizeToken(c.id),
    name: normalizeToken(c.name),
  }));

  const allColorsAreDimensionalSizes =
    colorDims.length > 0 &&
    colorDims.every((c) => c.dim != null && sizeDimKeys.has(c.dim));

  if (allColorsAreDimensionalSizes) return true;

  if (colorLabel === "Option") {
    const allColorsMatchSizeTokens = colorDims.every(
      (c) =>
        c.dim != null &&
        [...sizeDimKeys].some(
          (sk) => sk === c.dim || sk.includes(c.dim!) || c.dim!.includes(sk),
        ),
    );
    if (allColorsMatchSizeTokens) return true;
  }

  return false;
}

/** Find frame color id that matches the selected size orientation (for variantMap). */
export function resolveFrameColorForSize(
  size: SizeLike | null | undefined,
  frameColors: ColorLike[],
): string | null {
  if (!size || frameColors.length === 0) return null;
  const sizeDim = extractDimensionalKey(size.id) || extractDimensionalKey(size.name);
  const sizeNorm = normalizeToken(size.name);

  for (const c of frameColors) {
    const cDim = extractDimensionalKey(c.id) || extractDimensionalKey(c.name);
    if (sizeDim && cDim && sizeDim === cDim) return c.id;
    const cNorm = normalizeToken(c.name);
    if (sizeNorm && (cNorm === sizeNorm || cNorm.includes(sizeNorm) || sizeNorm.includes(cNorm))) {
      return c.id;
    }
  }
  return null;
}

/** Tapestry-style products: size dropdown is orientation (26×36 vs 36×26). */
export function isOrientationSizeProduct(
  sizes: SizeLike[],
  frameColors: ColorLike[],
  colorLabel?: string | null,
): boolean {
  if (sizes.length < 2) return false;
  return frameColorsRedundantWithSizes(sizes, frameColors, colorLabel);
}

/** Aspect ratio string (w:h) from a size row, including Shopify inch ids. */
export function sizeAspectRatioString(size: SizeLike, fallback?: string | null): string {
  return resolveSizeAspectRatio(size, fallback);
}

/** True when size aspect is landscape (w > h). */
export function isLandscapeSizeAspect(aspect: string): boolean {
  const [w, h] = aspect.split(":").map(Number);
  return w > 0 && h > 0 && w > h;
}
