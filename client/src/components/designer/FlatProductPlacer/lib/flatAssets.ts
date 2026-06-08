import { API_BASE } from "@/lib/urlBase";
import type { FlatCalibrationManifest, FlatViewCalibration } from "@/pages/embed-design";

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

export function flatBlankHasViews(
  entry: Partial<Record<FlatViewName, string>> | undefined,
): entry is Partial<Record<FlatViewName, string>> {
  return !!(entry?.front || entry?.back);
}

function blankKeyMatches(manifest: FlatCalibrationManifest, key: string): boolean {
  return flatBlankHasViews(manifest.blanks?.[key]);
}

function findBlankKey(manifest: FlatCalibrationManifest, id: string): string | null {
  if (!id) return null;
  if (blankKeyMatches(manifest, id)) return id;
  const norm = normalizeFlatColorKey(id);
  for (const k of Object.keys(manifest.blanks || {})) {
    if (normalizeFlatColorKey(k) === norm && blankKeyMatches(manifest, k)) return k;
  }
  return null;
}

/**
 * Phone cases store device models in `sizes`; apparel stores colours in
 * `frameColors`. Calibration blanks may be keyed by either — try size first
 * when a manifest entry exists, then frame colour, then combined keys.
 */
export function resolveFlatBlankColorId(
  manifest: FlatCalibrationManifest,
  opts: { sizeId?: string; frameColorId?: string },
): string {
  const candidates: string[] = [];
  if (opts.sizeId) candidates.push(opts.sizeId);
  if (opts.frameColorId) candidates.push(opts.frameColorId);
  if (opts.sizeId && opts.frameColorId) {
    candidates.push(`${opts.sizeId}:${opts.frameColorId}`);
    candidates.push(`${opts.frameColorId}:${opts.sizeId}`);
  }

  for (const id of candidates) {
    const hit = findBlankKey(manifest, id);
    if (hit) return hit;
  }

  const fallback = opts.frameColorId || opts.sizeId || "";
  const resolved = findBlankKey(manifest, fallback);
  if (resolved) return resolved;

  for (const k of Object.keys(manifest.blanks || {})) {
    if (blankKeyMatches(manifest, k)) return k;
  }
  return fallback;
}

/**
 * Pick the blank photo set for `colorId`, with graceful fallback: exact key →
 * normalized-key match → first entry with usable URLs.
 *
 * Empty `{}` entries (failed harvest for that colour) are skipped — treating
 * them as missing avoids blocking fallback and breaking the placer.
 */
/** Per-model geometry overrides (phone cases — camera cutout differs per model). */
export type FlatViewGeometryOverride = Pick<
  FlatViewCalibration,
  | "visibleRectNormalized"
  | "printBoundsNormalized"
  | "mockupDims"
  | "maskUrl"
  | "shadingUrl"
  | "shadingMode"
>;

export type FlatCalibrationManifestWithGeometry = FlatCalibrationManifest & {
  geometryByBlank?: Record<string, Partial<Record<FlatViewName, FlatViewGeometryOverride>>>;
};

/**
 * Merge shared view calibration with optional per-blank-key overrides.
 * Falls back to shared `manifest.views[view]` when no override exists.
 */
export function resolveFlatViewCalibration(
  manifest: FlatCalibrationManifest,
  colorId: string,
  view: FlatViewName,
): FlatViewCalibration | undefined {
  const base = manifest.views[view];
  if (!base) return undefined;
  const blankKey = findBlankKey(manifest, colorId);
  const override = blankKey ? manifest.geometryByBlank?.[blankKey]?.[view] : undefined;
  if (!override) return base;
  return {
    ...base,
    ...override,
    printFileDims: base.printFileDims,
    meshNodes: base.meshNodes,
    meshGrid: base.meshGrid,
    planarityScore: base.planarityScore,
    coverage: base.coverage,
  };
}

export function resolveFlatBlank(
  manifest: FlatCalibrationManifest,
  colorId: string,
): Partial<Record<FlatViewName, string>> {
  const blanks = manifest.blanks || {};
  if (colorId && flatBlankHasViews(blanks[colorId])) return blanks[colorId];
  if (colorId) {
    const norm = normalizeFlatColorKey(colorId);
    for (const k of Object.keys(blanks)) {
      if (normalizeFlatColorKey(k) === norm && flatBlankHasViews(blanks[k])) return blanks[k];
    }
  }
  for (const k of Object.keys(blanks)) {
    if (flatBlankHasViews(blanks[k])) return blanks[k];
  }
  return {};
}

export function loadFlatImage(
  url: string,
  opts?: { cors?: boolean },
): Promise<HTMLImageElement | null> {
  const cors = opts?.cors !== false;
  return new Promise((resolve) => {
    const img = new Image();
    if (cors) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = toAbsFlatAssetUrl(url);
  });
}

/** Try CORS first (needed for canvas export); fall back to display-only load. */
export async function loadFlatImageRelaxed(url: string): Promise<HTMLImageElement | null> {
  const withCors = await loadFlatImage(url, { cors: true });
  if (withCors) return withCors;
  return loadFlatImage(url, { cors: false });
}

export async function loadFlatViewAssets(
  manifest: FlatCalibrationManifest,
  colorId: string,
  view: FlatViewName,
): Promise<FlatLoadedViewAssets | null> {
  const blank = resolveFlatBlank(manifest, colorId);
  const blankUrl = blank[view];
  const calib = resolveFlatViewCalibration(manifest, colorId, view);
  if (!blankUrl || !calib) return null;

  const [b, m, s] = await Promise.all([
    loadFlatImage(blankUrl),
    calib.maskUrl ? loadFlatImage(calib.maskUrl) : Promise.resolve(null),
    calib.shadingUrl &&
    (calib.shadingMode === "map" || calib.printBoundsNormalized)
      ? loadFlatImage(calib.shadingUrl)
      : Promise.resolve(null),
  ]);
  if (!b) return null;
  return { blank: b, mask: m, shading: s };
}
