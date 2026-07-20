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

export type CanvasOrientation = "horizontal" | "vertical";

/** Framed poster / wall-art style products (for orientation UI). */
export function isFramedPrintLike(product: {
  designerType?: string | null;
  name?: string | null;
}): boolean {
  if (product.designerType === "framed-print") return true;
  const n = (product.name || "").toLowerCase();
  return (
    n.includes("framed") ||
    n.includes("poster") ||
    n.includes("canvas print") ||
    n.includes("wall art")
  );
}

/**
 * Infer horizontal vs vertical for framed products (name → aspectRatio → size majority).
 * Used by Generator Tester Orientation pills to switch sibling product types.
 */
export function inferProductCanvasOrientation(product: {
  name?: string | null;
  aspectRatio?: string | null;
  designerType?: string | null;
  sizes?: string | SizeLike[] | null;
}): CanvasOrientation | null {
  if (!isFramedPrintLike(product)) return null;
  const name = (product.name || "").toLowerCase();
  if (name.includes("horizontal") || name.includes("landscape")) return "horizontal";
  if (name.includes("vertical") || name.includes("portrait")) return "vertical";

  const ar = String(product.aspectRatio || "");
  const [aw, ah] = ar.split(":").map(Number);
  if (aw > 0 && ah > 0) {
    if (aw > ah * 1.05) return "horizontal";
    if (ah > aw * 1.05) return "vertical";
  }

  let sizes: SizeLike[] = [];
  try {
    sizes =
      typeof product.sizes === "string"
        ? (JSON.parse(product.sizes || "[]") as SizeLike[])
        : Array.isArray(product.sizes)
          ? product.sizes
          : [];
  } catch {
    sizes = [];
  }
  let landscape = 0;
  let portrait = 0;
  for (const s of sizes) {
    const ratio = resolveSizeAspectRatio(s, product.aspectRatio);
    if (isLandscapeSizeAspect(ratio)) landscape += 1;
    else {
      const [w, h] = ratio.split(":").map(Number);
      if (w > 0 && h > 0 && h > w) portrait += 1;
    }
  }
  if (landscape > portrait) return "horizontal";
  if (portrait > landscape) return "vertical";
  return null;
}

/** Strip orientation words so "Horizontal Framed Poster" ↔ "Vertical Framed Poster" match. */
export function framedProductFamilyKey(name: string | null | undefined): string {
  return String(name || "")
    .toLowerCase()
    .replace(/\b(horizontal|vertical|landscape|portrait)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find a sibling framed product type with the opposite/requested canvas orientation
 * (e.g. switch Generator Tester from Horizontal → Vertical Framed Poster).
 */
export function findFramedOrientationSibling<T extends {
  id: number;
  name?: string | null;
  aspectRatio?: string | null;
  designerType?: string | null;
  sizes?: string | SizeLike[] | null;
}>(
  products: T[],
  current: T | null | undefined,
  target: CanvasOrientation,
): T | null {
  if (!current || !isFramedPrintLike(current)) return null;
  const currentOrient = inferProductCanvasOrientation(current);
  if (currentOrient === target) return current;
  const family = framedProductFamilyKey(current.name);
  if (!family) return null;

  const matches = products.filter((p) => {
    if (p.id === current.id) return false;
    if (!isFramedPrintLike(p)) return false;
    if (framedProductFamilyKey(p.name) !== family) return false;
    return inferProductCanvasOrientation(p) === target;
  });
  return matches[0] ?? null;
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
