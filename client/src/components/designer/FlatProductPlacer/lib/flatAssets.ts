import { API_BASE } from "@/lib/urlBase";
import type { FlatCalibrationManifest } from "@/pages/embed-design";

export type FlatViewName = "front" | "back";

export type FlatLoadedViewAssets = {
  blank: HTMLImageElement | null;
  mask: HTMLImageElement | null;
  shading: HTMLImageElement | null;
};

/** Resolve absolute URL (manifest urls are usually Supabase absolutes already). */
export function toAbsFlatAssetUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${API_BASE}${url.startsWith("/") ? "" : "/"}${url}`;
}

export function normalizeFlatColorKey(id: string): string {
  return id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

/**
 * Pick the blank photo set for `colorId`, with graceful fallback: exact key →
 * normalized-key match → first entry.
 */
export function resolveFlatBlank(
  manifest: FlatCalibrationManifest,
  colorId: string,
): Partial<Record<FlatViewName, string>> {
  const blanks = manifest.blanks || {};
  if (colorId && blanks[colorId]) return blanks[colorId];
  if (colorId) {
    const norm = normalizeFlatColorKey(colorId);
    for (const k of Object.keys(blanks)) {
      if (normalizeFlatColorKey(k) === norm) return blanks[k];
    }
  }
  const first = Object.keys(blanks)[0];
  return first ? blanks[first] : {};
}

export function loadFlatImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = toAbsFlatAssetUrl(url);
  });
}

export async function loadFlatViewAssets(
  manifest: FlatCalibrationManifest,
  colorId: string,
  view: FlatViewName,
): Promise<FlatLoadedViewAssets | null> {
  const blank = resolveFlatBlank(manifest, colorId);
  const blankUrl = blank[view];
  const calib = manifest.views[view];
  if (!blankUrl || !calib) return null;

  const [b, m, s] = await Promise.all([
    loadFlatImage(blankUrl),
    calib.maskUrl ? loadFlatImage(calib.maskUrl) : Promise.resolve(null),
    calib.shadingMode === "map" && calib.shadingUrl
      ? loadFlatImage(calib.shadingUrl)
      : Promise.resolve(null),
  ]);
  if (!b) return null;
  return { blank: b, mask: m, shading: s };
}
