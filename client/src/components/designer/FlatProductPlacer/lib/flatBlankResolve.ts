import type { FlatCalibrationManifest } from "@/pages/embed-design";

function normalizeFlatColorKey(id: string): string {
  return id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function blankKeyMatches(manifest: FlatCalibrationManifest, key: string): boolean {
  const entry = manifest.blanks?.[key];
  return !!(entry?.front || entry?.back);
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

/** True when every blank key is `{apparelSize}:{color}` (legacy mis-harvested sweaters). */
function blanksLookLikeApparelSizeColor(manifest: FlatCalibrationManifest): boolean {
  const keys = Object.keys(manifest.blanks || {}).filter((k) => blankKeyMatches(manifest, k));
  if (keys.length === 0) return false;
  return keys.every((k) => /^[a-z0-9]+:[a-z0-9_]+$/i.test(k));
}

/** Match harvested blank keys by frame colour when size×colour keys omit the current size. */
function findBlankKeyForColor(
  manifest: FlatCalibrationManifest,
  frameColorId: string,
): string | null {
  const colorNorm = normalizeFlatColorKey(frameColorId);
  for (const k of Object.keys(manifest.blanks || {})) {
    if (!blankKeyMatches(manifest, k)) continue;
    const kn = normalizeFlatColorKey(k);
    // normalizeFlatColorKey turns `s:light_pink` into `s-light-pink` — match suffix, not `:color`.
    if (kn === colorNorm || kn.endsWith(`-${colorNorm}`)) return k;
  }
  return null;
}

/**
 * Resolve which harvested blank set to use for the current size / frame colour.
 *
 * Order matters: for decorPerSize manifests (`16x20:white` keys) we must try
 * combined keys before bare frame colour (`white`), otherwise every size falls
 * back to the same single-colour blank.
 */
export function resolveFlatBlankColorId(
  manifest: FlatCalibrationManifest,
  opts: { sizeId?: string; frameColorId?: string; isApparel?: boolean },
): string {
  const apparelColorOnly =
    !!opts.isApparel ||
    (manifest.decorPerSize && blanksLookLikeApparelSizeColor(manifest));
  const candidates: string[] = [];

  if (!apparelColorOnly && opts.sizeId && opts.frameColorId) {
    candidates.push(`${opts.sizeId}:${opts.frameColorId}`, `${opts.frameColorId}:${opts.sizeId}`);
  }
  if (!apparelColorOnly && opts.sizeId) candidates.push(opts.sizeId);
  if (opts.frameColorId) candidates.push(opts.frameColorId);

  for (const id of candidates) {
    const hit = findBlankKey(manifest, id);
    if (hit) return hit;
  }

  // Apparel + legacy size×colour harvest: garment colour is size-independent.
  if ((manifest.decorPerSize || apparelColorOnly) && opts.frameColorId) {
    const colorHit = findBlankKeyForColor(manifest, opts.frameColorId);
    if (colorHit) return colorHit;
    const direct = findBlankKey(manifest, opts.frameColorId);
    if (direct) return direct;
    // Do not fall back to the first harvested blank — that makes every colour
    // show the same shirt when slug lookup misses.
    return opts.frameColorId;
  }

  if (manifest.edgeWrap && opts.sizeId) {
    const sizeNorm = normalizeFlatColorKey(opts.sizeId);
    for (const k of Object.keys(manifest.blanks || {})) {
      if (!blankKeyMatches(manifest, k)) continue;
      if (normalizeFlatColorKey(k) === sizeNorm) return k;
    }
  }

  const fallback =
    opts.sizeId && opts.frameColorId
      ? `${opts.sizeId}:${opts.frameColorId}`
      : opts.frameColorId || opts.sizeId || "";
  const resolved = findBlankKey(manifest, fallback);
  if (resolved) return resolved;

  for (const k of Object.keys(manifest.blanks || {})) {
    if (blankKeyMatches(manifest, k)) return k;
  }
  return fallback;
}

/**
 * Key for placement persistence — blank photo may change (frame colour) while
 * print geometry stays the same (decor per size, phone model).
 */
export function resolveFlatPlacementGeometryKey(
  manifest: FlatCalibrationManifest,
  opts: { sizeId?: string; frameColorId?: string; isApparel?: boolean },
): string {
  const apparelColorOnly =
    !!opts.isApparel ||
    (manifest.decorPerSize && blanksLookLikeApparelSizeColor(manifest));
  if (!apparelColorOnly && (manifest.decorPerSize || manifest.edgeWrap) && opts.sizeId) {
    return opts.sizeId;
  }
  return resolveFlatBlankColorId(manifest, opts);
}
