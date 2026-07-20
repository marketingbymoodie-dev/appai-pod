/**
 * Size-keyed catalog blanks for mixed-orientation products (Cotton Comforter,
 * Wall Decals). Printify placeholder PNGs are often square canvases — match by
 * product size token from the filename (68x88), not image pixel aspect.
 */

import {
  canvasOrientationFromAspect,
  extractDimensionalKey,
  resolveSizeAspectRatio,
  type CanvasOrientation,
  type SizeLike,
} from "./productVariantOptions";

/** Printify blueprint IDs with shared size blanks. */
export const CATALOG_SIZE_BLANK_BLUEPRINTS = {
  cottonComforter: 2706,
  wallDecals: 759,
} as const;

export type CatalogSizeBlankBlueprintId =
  (typeof CATALOG_SIZE_BLANK_BLUEPRINTS)[keyof typeof CATALOG_SIZE_BLANK_BLUEPRINTS];

export function isCatalogSizeBlankBlueprint(
  blueprintId: number | null | undefined,
): blueprintId is CatalogSizeBlankBlueprintId {
  return (
    blueprintId === CATALOG_SIZE_BLANK_BLUEPRINTS.cottonComforter ||
    blueprintId === CATALOG_SIZE_BLANK_BLUEPRINTS.wallDecals
  );
}

/** Build size→URL map using a public-URL resolver (e.g. Supabase getPublicUrl). */
export function resolveCatalogSizeBlankUrlMap(
  blueprintId: number | null | undefined,
  getPublicUrl: (storagePath: string) => string | null | undefined,
): Record<string, string> | null {
  if (!isCatalogSizeBlankBlueprint(blueprintId)) return null;
  const paths = CATALOG_SIZE_BLANK_STORAGE_PATHS[blueprintId];
  const out: Record<string, string> = {};
  for (const [sizeKey, storagePath] of Object.entries(paths)) {
    const url = getPublicUrl(storagePath);
    if (url) out[sizeKey] = url;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Stable Supabase paths under the designs bucket (seeded by scripts/seed-catalog-size-blanks.ts). */
export const CATALOG_SIZE_BLANK_STORAGE_PATHS: Record<
  CatalogSizeBlankBlueprintId,
  Record<string, string>
> = {
  [CATALOG_SIZE_BLANK_BLUEPRINTS.cottonComforter]: {
    "68x88": "catalog-blanks/comforter/68x88.png",
    "68x92": "catalog-blanks/comforter/68x92.png",
    "104x88": "catalog-blanks/comforter/104x88.png",
    "88x88": "catalog-blanks/comforter/88x88.png",
  },
  [CATALOG_SIZE_BLANK_BLUEPRINTS.wallDecals]: {
    "12x18": "catalog-blanks/wall-decals/12x18.png",
    "18x12": "catalog-blanks/wall-decals/18x12.png",
    "18x24": "catalog-blanks/wall-decals/18x24.png",
    "24x18": "catalog-blanks/wall-decals/24x18.png",
    "24x36": "catalog-blanks/wall-decals/24x36.png",
    "36x24": "catalog-blanks/wall-decals/36x24.png",
  },
};

export type BaseMockupImagesLike = {
  primary?: string | null;
  front?: string | null;
  gallery?: string[] | null;
  custom?: string[] | null;
  available?: unknown;
  blanksBySize?: Record<string, string> | null;
  [key: string]: unknown;
};

/** Resolve a blank URL for a selected size from blanksBySize (+ orientation fallback). */
export function resolveBlankUrlForSize(
  images: BaseMockupImagesLike | null | undefined,
  size: SizeLike | null | undefined,
  productAspectRatio?: string | null,
): string | null {
  if (!images?.blanksBySize || !size) return null;
  const map = images.blanksBySize;
  const dim =
    extractDimensionalKey(size.id) ||
    extractDimensionalKey(size.name) ||
    (size.width && size.height ? `${Math.round(size.width)}x${Math.round(size.height)}` : null);
  if (dim && map[dim]) return map[dim];

  const orient = canvasOrientationFromAspect(
    resolveSizeAspectRatio(size, productAspectRatio),
  );
  if (!orient) return null;

  for (const [key, url] of Object.entries(map)) {
    const [w, h] = key.split("x").map(Number);
    if (!(w > 0 && h > 0) || !url) continue;
    const o = canvasOrientationFromAspect(`${w}:${h}`);
    if (o === orient) return url;
  }
  return null;
}

/** Prefer vertical, then square, then horizontal for Primary. */
function pickPrimaryFromBlanksBySize(blanksBySize: Record<string, string>): string | null {
  const entries = Object.entries(blanksBySize).filter(([, u]) => !!u);
  if (entries.length === 0) return null;
  const order: CanvasOrientation[] = ["vertical", "square", "horizontal"];
  for (const want of order) {
    for (const [key, url] of entries) {
      const [w, h] = key.split("x").map(Number);
      if (!(w > 0 && h > 0)) continue;
      if (canvasOrientationFromAspect(`${w}:${h}`) === want) return url;
    }
  }
  return entries[0][1];
}

/**
 * Merge size blanks into baseMockupImages: set blanksBySize, primary, gallery
 * (one URL per orientation for the carousel). Keeps available/custom.
 */
export function applyCatalogSizeBlanks(
  images: BaseMockupImagesLike,
  blanksBySize: Record<string, string>,
): BaseMockupImagesLike {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(blanksBySize)) {
    if (k && v) cleaned[k] = v;
  }
  if (Object.keys(cleaned).length === 0) return images;

  const primary = pickPrimaryFromBlanksBySize(cleaned) || images.primary || images.front || undefined;
  const used = new Set<string>();
  const gallery: string[] = [];
  if (primary) used.add(primary);

  const seenOrient = new Set<CanvasOrientation>();
  if (primary) {
    for (const [key, url] of Object.entries(cleaned)) {
      if (url === primary) {
        const [w, h] = key.split("x").map(Number);
        const o = canvasOrientationFromAspect(`${w}:${h}`);
        if (o) seenOrient.add(o);
        break;
      }
    }
  }
  for (const [key, url] of Object.entries(cleaned)) {
    if (used.has(url)) continue;
    const [w, h] = key.split("x").map(Number);
    const o = w && h ? canvasOrientationFromAspect(`${w}:${h}`) : null;
    if (o && seenOrient.has(o)) continue;
    if (o) seenOrient.add(o);
    gallery.push(url);
    used.add(url);
    if (gallery.length >= 4) break;
  }

  const customSet = new Set<string>([
    ...(Array.isArray(images.custom) ? images.custom.filter(Boolean) : []),
    ...Object.values(cleaned),
  ]);

  return {
    ...images,
    blanksBySize: cleaned,
    ...(primary ? { primary, front: primary } : {}),
    gallery,
    custom: Array.from(customSet).slice(0, 12),
  };
}
