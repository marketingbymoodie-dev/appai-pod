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

/** First/second inch dims from id, name, or width/height fields. */
export function sizeDimensionPair(size: SizeLike): [number, number] | null {
  const dim =
    extractDimensionalKey(size.id) || extractDimensionalKey(size.name);
  if (dim) {
    const [w, h] = dim.split("x").map(Number);
    if (w > 0 && h > 0) return [w, h];
  }
  if (size.width && size.height && size.width > 0 && size.height > 0) {
    return [size.width, size.height];
  }
  return null;
}

/**
 * Sort dimensional sizes ascending by the first number, then the second
 * (e.g. 11×8 → 14×11 → 18×12 → …). Non-dimensional rows keep relative order at the end.
 */
export function sortDimensionalSizesAscending<T extends SizeLike>(sizes: T[]): T[] {
  return sizes
    .map((size, index) => ({ size, index, dims: sizeDimensionPair(size) }))
    .sort((a, b) => {
      if (!a.dims && !b.dims) return a.index - b.index;
      if (!a.dims) return 1;
      if (!b.dims) return -1;
      if (a.dims[0] !== b.dims[0]) return a.dims[0] - b.dims[0];
      if (a.dims[1] !== b.dims[1]) return a.dims[1] - b.dims[1];
      return a.index - b.index;
    })
    .map(({ size }) => size);
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

/** True when a size id/name like `36x24` / `20" x 16"` is landscape. */
export function sizeIdLooksLandscape(sizeId: string | null | undefined): boolean {
  if (!sizeId) return false;
  const dim = extractDimensionalKey(sizeId);
  if (!dim) return false;
  const [w, h] = dim.split("x").map(Number);
  return w > 0 && h > 0 && w > h;
}

export type CanvasOrientation = "horizontal" | "vertical" | "square";

/** Classify a w:h aspect string into horizontal / vertical / square. */
export function canvasOrientationFromAspect(
  aspect: string,
): CanvasOrientation | null {
  const [w, h] = aspect.split(":").map(Number);
  if (!(w > 0 && h > 0)) return null;
  if (w > h * 1.05) return "horizontal";
  if (h > w * 1.05) return "vertical";
  return "square";
}

/** Parse Horizontal / Vertical / Square / Landscape / Portrait from a label. */
export function parseCanvasOrientationFromLabel(
  text: string | null | undefined,
): CanvasOrientation | null {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  if (/\b(horizontal|landscape)\b/.test(t)) return "horizontal";
  if (/\b(vertical|portrait)\b/.test(t)) return "vertical";
  if (/\bsquare\b/.test(t)) return "square";
  return null;
}

/** Which orientation kinds exist in the size list. */
export function listCanvasOrientationsInSizes(
  sizes: SizeLike[],
  productAspectRatio?: string | null,
): CanvasOrientation[] {
  let landscape = false;
  let portrait = false;
  let square = false;
  for (const s of sizes) {
    const o = canvasOrientationFromAspect(
      resolveSizeAspectRatio(s, productAspectRatio),
    );
    if (o === "horizontal") landscape = true;
    else if (o === "vertical") portrait = true;
    else if (o === "square") square = true;
  }
  const out: CanvasOrientation[] = [];
  if (landscape) out.push("horizontal");
  if (portrait) out.push("vertical");
  if (square) out.push("square");
  return out;
}

/** True when size list includes 2+ of landscape / portrait / square. */
export function sizesHaveMixedCanvasOrientation(
  sizes: SizeLike[],
  productAspectRatio?: string | null,
): boolean {
  return listCanvasOrientationsInSizes(sizes, productAspectRatio).length >= 2;
}

export function filterSizesByCanvasOrientation(
  sizes: SizeLike[],
  orientation: CanvasOrientation,
  productAspectRatio?: string | null,
): SizeLike[] {
  return sizes.filter((s) => {
    const o = canvasOrientationFromAspect(
      resolveSizeAspectRatio(s, productAspectRatio),
    );
    return o === orientation;
  });
}

function sizeMatchesOrientation(
  size: SizeLike,
  orientation: CanvasOrientation,
  productAspectRatio?: string | null,
): boolean {
  return (
    canvasOrientationFromAspect(
      resolveSizeAspectRatio(size, productAspectRatio),
    ) === orientation
  );
}

/**
 * Pick a size for Horizontal / Vertical / Square. Prefers the dimension-swap
 * of the current size (68×88 → 88×68), else the first matching orientation.
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

  if (current && orientation !== "square") {
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

/** Phone-case size/colour tokens (iPhone 13, Galaxy S23, …). */
export function looksLikePhoneModelName(name: string): boolean {
  const lower = (name || "").toLowerCase().trim();
  return (
    /^iphone[-\s](\d|x|xs|xr|se|pro|plus|max|air)/i.test(lower) ||
    /^galaxy[-\s](s\d|a\d|note|z\s*(fold|flip)|ultra)/i.test(lower) ||
    /^pixel[-\s](\d|fold|pro)/i.test(lower) ||
    /^samsung[-\s](galaxy|note)/i.test(lower) ||
    /^oneplus[-\s]\d/i.test(lower) ||
    /^for[-\s](iphone|galaxy|pixel|samsung)/i.test(lower) ||
    /^(iphone|samsung|galaxy|pixel|oneplus|motorola)\b/i.test(lower)
  );
}

/** True when the Size list is really device models (phone cases). */
export function sizesLookLikePhoneModels(
  sizes: Array<{ id?: string; name?: string }> | null | undefined,
): boolean {
  if (!sizes?.length) return false;
  const hits = sizes.filter(
    (s) => looksLikePhoneModelName(s.name || "") || looksLikePhoneModelName(s.id || ""),
  );
  return hits.length >= Math.max(1, Math.ceil(sizes.length * 0.5));
}
