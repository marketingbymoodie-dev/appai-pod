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
  // Prefer id/name inch tokens (Shopify `24''_×_18''`) over stored width/height —
  // those fields are sometimes swapped or left at a portrait default for landscape sizes.
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
  if (size.width && size.height && size.width > 0 && size.height > 0) {
    const d = gcd(Math.round(size.width), Math.round(size.height));
    return `${Math.round(size.width / d)}:${Math.round(size.height / d)}`;
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

export type CanvasOrientation = "horizontal" | "vertical";

/** Parse Horizontal / Vertical / Landscape / Portrait from a style option or label. */
export function parseCanvasOrientationFromLabel(
  text: string | null | undefined,
): CanvasOrientation | null {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  if (/\b(horizontal|landscape)\b/.test(t)) return "horizontal";
  if (/\b(vertical|portrait)\b/.test(t)) return "vertical";
  return null;
}

/** True when size list includes both landscape and portrait options. */
export function sizesHaveMixedCanvasOrientation(
  sizes: SizeLike[],
  productAspectRatio?: string | null,
): boolean {
  let landscape = 0;
  let portrait = 0;
  for (const s of sizes) {
    const ratio = resolveSizeAspectRatio(s, productAspectRatio);
    const [w, h] = ratio.split(":").map(Number);
    if (!(w > 0 && h > 0)) continue;
    if (w > h * 1.05) landscape += 1;
    else if (h > w * 1.05) portrait += 1;
  }
  return landscape > 0 && portrait > 0;
}

export function filterSizesByCanvasOrientation(
  sizes: SizeLike[],
  orientation: CanvasOrientation,
  productAspectRatio?: string | null,
): SizeLike[] {
  return sizes.filter((s) => {
    const ratio = resolveSizeAspectRatio(s, productAspectRatio);
    const [w, h] = ratio.split(":").map(Number);
    if (!(w > 0 && h > 0)) return false;
    if (orientation === "horizontal") return w > h * 1.05;
    return h > w * 1.05;
  });
}

function sizeMatchesOrientation(
  size: SizeLike,
  orientation: CanvasOrientation,
  productAspectRatio?: string | null,
): boolean {
  const ratio = resolveSizeAspectRatio(size, productAspectRatio);
  const [w, h] = ratio.split(":").map(Number);
  if (!(w > 0 && h > 0)) return false;
  if (orientation === "horizontal") return w > h * 1.05;
  return h > w * 1.05;
}

/**
 * Pick a size for Horizontal / Vertical. Prefers the dimension-swap of the
 * current size (68×88 → 88×68), else the first matching orientation.
 */
export function pickSizeForCanvasOrientation<T extends SizeLike>(
  sizes: T[],
  orientation: CanvasOrientation,
  currentSizeId?: string | null,
  productAspectRatio?: string | null,
): T | null {
  if (sizes.length === 0) return null;
  const matching = filterSizesByCanvasOrientation(
    sizes,
    orientation,
    productAspectRatio,
  ) as T[];
  if (matching.length === 0) return null;

  const current = currentSizeId
    ? sizes.find((s) => s.id === currentSizeId)
    : undefined;
  if (current && sizeMatchesOrientation(current, orientation, productAspectRatio)) {
    return current;
  }

  if (current) {
    const curDim =
      extractDimensionalKey(current.id) || extractDimensionalKey(current.name);
    if (curDim) {
      const [a, b] = curDim.split("x").map(Number);
      if (a > 0 && b > 0 && a !== b) {
        const swapped = `${b}x${a}`;
        const twin = matching.find((s) => {
          const d = extractDimensionalKey(s.id) || extractDimensionalKey(s.name);
          return d === swapped;
        });
        if (twin) return twin;
      }
    }
  }

  return matching[0] ?? null;
}

/** True when any style choice looks like an orientation control. */
export function styleChoicesIncludeCanvasOrientation(
  choices: Array<{ id?: string; name?: string }> | null | undefined,
): boolean {
  if (!choices?.length) return false;
  return choices.some(
    (c) =>
      parseCanvasOrientationFromLabel(c.name) != null ||
      parseCanvasOrientationFromLabel(c.id) != null,
  );
}
