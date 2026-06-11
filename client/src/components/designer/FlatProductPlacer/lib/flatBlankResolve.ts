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

/**
 * Resolve which harvested blank set to use for the current size / frame colour.
 *
 * Order matters: for decorPerSize manifests (`16x20:white` keys) we must try
 * combined keys before bare frame colour (`white`), otherwise every size falls
 * back to the same single-colour blank.
 */
export function resolveFlatBlankColorId(
  manifest: FlatCalibrationManifest,
  opts: { sizeId?: string; frameColorId?: string },
): string {
  const candidates: string[] = [];

  if (opts.sizeId && opts.frameColorId) {
    candidates.push(`${opts.sizeId}:${opts.frameColorId}`, `${opts.frameColorId}:${opts.sizeId}`);
  }
  if (opts.sizeId) candidates.push(opts.sizeId);
  if (opts.frameColorId) candidates.push(opts.frameColorId);

  for (const id of candidates) {
    const hit = findBlankKey(manifest, id);
    if (hit) return hit;
  }

  // Same garment colour at any size — never return the first size:* match (wrong colour).
  if (manifest.decorPerSize && opts.frameColorId) {
    const colorNorm = normalizeFlatColorKey(opts.frameColorId);
    for (const k of Object.keys(manifest.blanks || {})) {
      if (!blankKeyMatches(manifest, k)) continue;
      const kn = normalizeFlatColorKey(k);
      if (kn === colorNorm || kn.endsWith(`:${colorNorm}`)) return k;
    }
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
  opts: { sizeId?: string; frameColorId?: string },
): string {
  if ((manifest.decorPerSize || manifest.edgeWrap) && opts.sizeId) {
    return opts.sizeId;
  }
  return resolveFlatBlankColorId(manifest, opts);
}
