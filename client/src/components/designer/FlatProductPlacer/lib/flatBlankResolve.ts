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
    if (!blankKeyMatches(manifest, k)) continue;
    const kn = normalizeFlatColorKey(k);
    if (kn === norm || kn.endsWith(`-${norm}`)) return k;
  }
  return null;
}

/** Prefer `default`, else first blank with front/back URLs. */
export function firstUsableBlankKey(manifest: FlatCalibrationManifest): string | null {
  if (blankKeyMatches(manifest, "default")) return "default";
  for (const k of Object.keys(manifest.blanks || {})) {
    if (blankKeyMatches(manifest, k)) return k;
  }
  return null;
}

/** True when harvest has distinct colour/model blanks (not a single default-only manifest). */
export function manifestHasMultipleColorBlanks(manifest: FlatCalibrationManifest): boolean {
  const keys = Object.keys(manifest.blanks || {}).filter((k) => blankKeyMatches(manifest, k));
  if (keys.length <= 1) return false;
  if (keys.length === 1 && keys[0] === "default") return false;
  return true;
}

const APPAREL_SIZE_SEGMENTS = new Set([
  "xxs",
  "xs",
  "s",
  "m",
  "l",
  "xl",
  "2xl",
  "3xl",
  "4xl",
  "5xl",
  "xxl",
  "xxxl",
]);

/** Left side of `size:color` looks like apparel (S/M/L), not decor inches (16x20). */
function isApparelSizeSegment(seg: string): boolean {
  const raw = seg.toLowerCase().trim();
  if (!raw) return false;
  // Dimensional inch tokens: 16x20, 11x8, 16''×20'', etc.
  if (/\d+\s*[x×]\s*\d+/i.test(raw)) return false;
  const compact = raw.replace(/[^a-z0-9]/g, "");
  return APPAREL_SIZE_SEGMENTS.has(compact);
}

/**
 * True when every blank key is `{apparelSize}:{color}` (legacy mis-harvested sweaters).
 * Must NOT treat framed-poster `16x20:white` keys as apparel — that skips size:color
 * candidates and breaks frame-colour swaps.
 */
export function blanksLookLikeApparelSizeColor(manifest: FlatCalibrationManifest): boolean {
  const keys = Object.keys(manifest.blanks || {}).filter((k) => blankKeyMatches(manifest, k));
  if (keys.length === 0) return false;
  return keys.every((k) => {
    const colon = k.indexOf(":");
    if (colon <= 0 || colon !== k.lastIndexOf(":")) return false;
    const sizeSeg = k.slice(0, colon);
    const colorSeg = k.slice(colon + 1);
    if (!colorSeg || !/^[a-z0-9_]+$/i.test(colorSeg)) return false;
    return isApparelSizeSegment(sizeSeg);
  });
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
    // Multi-colour harvest: never swap in a different blank when slug lookup misses.
    if (manifestHasMultipleColorBlanks(manifest)) return opts.frameColorId;
    // Single/default blank harvest — keep flat tier alive until re-harvest adds per-colour blanks.
    const singleBlank = firstUsableBlankKey(manifest);
    if (singleBlank) return singleBlank;
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
