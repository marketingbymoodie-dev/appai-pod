/**
 * Probe Printify/catalog mockup URLs and auto-fill Primary + Gallery for
 * mixed-orientation product types.
 */

import sharp from "sharp";
import {
  applyOrientationBlankSelection,
  availablePlaceholderUrls,
  classifyDimsToOrientation,
  merchantPlaceholdersAreSparse,
  neededOrientationsFromSizes,
  selectOrientationBlankUrls,
  type ClassifiedBlankUrl,
  type PlaceholderImagesLike,
} from "@shared/orientationBlankPreselect";
import type { SizeLike } from "@shared/productVariantOptions";

const PROBE_TIMEOUT_MS = 8_000;
const MAX_PROBE_BYTES = 2_500_000;

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "image/*,*/*" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_PROBE_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

export async function probeImageOrientation(
  url: string,
): Promise<ClassifiedBlankUrl | null> {
  const buf = await fetchImageBuffer(url);
  if (!buf) return null;
  try {
    const meta = await sharp(buf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (!(w > 0 && h > 0)) return null;
    return { url, orientation: classifyDimsToOrientation(w, h) };
  } catch {
    return null;
  }
}

export async function classifyPlaceholderImageUrls(
  urls: string[],
): Promise<ClassifiedBlankUrl[]> {
  const unique = Array.from(new Set(urls.filter(Boolean))).slice(0, 24);
  const results = await Promise.all(unique.map((u) => probeImageOrientation(u)));
  return results.filter((r): r is ClassifiedBlankUrl => r != null);
}

export type PreselectOrientationBlanksOpts = {
  /** Re-run even when merchant already curated multiple blanks. */
  force?: boolean;
  productAspectRatio?: string | null;
};

/**
 * When the size catalog needs 2+ orientations, pick primary + gallery from
 * `available` (or current curated URLs) by probing image aspects.
 */
export async function maybePreselectOrientationBlanks(
  images: PlaceholderImagesLike,
  sizes: SizeLike[],
  opts?: PreselectOrientationBlanksOpts,
): Promise<{ images: PlaceholderImagesLike; changed: boolean; needed: string[] }> {
  const needed = neededOrientationsFromSizes(sizes, opts?.productAspectRatio);
  if (needed.length < 2) {
    return { images, changed: false, needed };
  }

  if (!opts?.force && !merchantPlaceholdersAreSparse(images)) {
    return { images, changed: false, needed };
  }

  const pool = availablePlaceholderUrls(images);
  const probeUrls = pool.length > 0 ? pool : [
    images.primary,
    images.front,
    ...(images.gallery || []),
  ].filter((u): u is string => typeof u === "string" && !!u);

  if (probeUrls.length === 0) {
    return { images, changed: false, needed };
  }

  const classified = await classifyPlaceholderImageUrls(probeUrls);
  if (classified.length === 0) {
    return { images, changed: false, needed };
  }

  const selection = selectOrientationBlankUrls(classified, needed);
  if (!selection) {
    return { images, changed: false, needed };
  }

  const next = applyOrientationBlankSelection(images, selection);
  const prevPrimary = String(images.primary || images.front || "");
  const prevGallery = JSON.stringify(images.gallery || []);
  const changed =
    prevPrimary !== selection.primary ||
    prevGallery !== JSON.stringify(selection.gallery);

  return { images: next, changed, needed };
}
