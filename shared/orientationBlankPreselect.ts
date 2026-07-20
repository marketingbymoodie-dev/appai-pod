/**
 * Auto-pick Primary + Gallery blanks so mixed-orientation products
 * (Wall Decals, Comforter, Tapestry, …) get one image per orientation.
 */

import {
  canvasOrientationFromAspect,
  listCanvasOrientationsInSizes,
  type CanvasOrientation,
  type SizeLike,
} from "./productVariantOptions";

export type ClassifiedBlankUrl = {
  url: string;
  orientation: CanvasOrientation;
};

export type PlaceholderImagesLike = {
  primary?: string | null;
  front?: string | null;
  gallery?: string[] | null;
  custom?: string[] | null;
  available?: Array<{ url?: string; label?: string } | string> | null;
  orientationBlanksAutoSelected?: boolean;
  [key: string]: unknown;
};

const MAX_GALLERY = 4;

/** Unique curated primary + gallery URLs. */
export function curatedPlaceholderUrls(
  images: PlaceholderImagesLike | null | undefined,
): string[] {
  if (!images) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (u: string | null | undefined) => {
    if (!u || typeof u !== "string" || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  add(images.primary || images.front || null);
  for (const u of images.gallery || []) add(u);
  return out;
}

/**
 * True when merchant curation is still sparse (≤1 unique blank) — safe to
 * auto-fill orientation coverage without overwriting a careful selection.
 */
export function merchantPlaceholdersAreSparse(
  images: PlaceholderImagesLike | null | undefined,
): boolean {
  return curatedPlaceholderUrls(images).length <= 1;
}

export function availablePlaceholderUrls(
  images: PlaceholderImagesLike | null | undefined,
): string[] {
  if (!images) return [];
  const avail = images.available;
  if (!Array.isArray(avail)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of avail) {
    const url = typeof item === "string" ? item : item?.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Pick primary (prefer vertical) + gallery covering remaining needed orientations.
 */
export function selectOrientationBlankUrls(
  classified: ClassifiedBlankUrl[],
  needed: CanvasOrientation[],
): { primary: string; gallery: string[] } | null {
  if (classified.length === 0 || needed.length < 2) return null;

  const byOrient = new Map<CanvasOrientation, string[]>();
  for (const c of classified) {
    const list = byOrient.get(c.orientation) || [];
    list.push(c.url);
    byOrient.set(c.orientation, list);
  }

  const primaryOrder: CanvasOrientation[] = ["vertical", "square", "horizontal"];
  let primary: string | undefined;
  for (const o of primaryOrder) {
    if (!needed.includes(o)) continue;
    const url = byOrient.get(o)?.[0];
    if (url) {
      primary = url;
      break;
    }
  }
  if (!primary) primary = classified[0]?.url;
  if (!primary) return null;

  const gallery: string[] = [];
  const used = new Set<string>([primary]);
  for (const o of needed) {
    for (const url of byOrient.get(o) || []) {
      if (used.has(url)) continue;
      gallery.push(url);
      used.add(url);
      break;
    }
  }

  // Prefer keeping a second distinct image even if same orientation (legacy lifestyle).
  if (gallery.length === 0) {
    const extra = classified.find((c) => c.url !== primary);
    if (extra) gallery.push(extra.url);
  }

  return { primary, gallery: gallery.slice(0, MAX_GALLERY) };
}

/** Orientations the size catalog needs covered in blanks. */
export function neededOrientationsFromSizes(
  sizes: SizeLike[],
  productAspectRatio?: string | null,
): CanvasOrientation[] {
  return listCanvasOrientationsInSizes(sizes, productAspectRatio);
}

export function classifyDimsToOrientation(
  width: number,
  height: number,
): CanvasOrientation {
  if (!(width > 0 && height > 0)) return "vertical";
  const o = canvasOrientationFromAspect(`${width}:${height}`);
  return o || "vertical";
}

/**
 * Apply selected primary/gallery onto a baseMockupImages object (keeps available).
 */
export function applyOrientationBlankSelection(
  images: PlaceholderImagesLike,
  selection: { primary: string; gallery: string[] },
): PlaceholderImagesLike {
  return {
    ...images,
    primary: selection.primary,
    front: selection.primary,
    gallery: selection.gallery,
    orientationBlanksAutoSelected: true,
  };
}
