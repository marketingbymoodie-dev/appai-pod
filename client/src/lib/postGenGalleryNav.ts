export type PostGenGalleryNavItem =
  | { kind: "artwork"; label: string }
  | { kind: "mockup"; url: string; label: string }
  | { kind: "catalog"; url: string; label: string };

export function isPostGenContextLabel(label: string): boolean {
  const l = String(label || "").toLowerCase();
  if (!l) return false;
  if (l === "front" || l === "back" || l === "mockup 1" || l === "mockup 2") return false;
  return /(lifestyle|context|room|home|bedroom|wall|person|side)/i.test(l);
}

/**
 * While the flat placer is open, Front rasters and catalog blanks look identical to
 * the live canvas — step only through Artwork + context so lifestyle shots remain
 * reachable after wrapping the carousel.
 */
export function stepPostGenGalleryIndex(
  current: number,
  delta: 1 | -1,
  items: PostGenGalleryNavItem[],
  flatPlacerActive: boolean,
): number {
  const len = items.length;
  if (len <= 1) return 0;
  let next = ((current % len) + len) % len;
  for (let n = 0; n < len; n++) {
    next = (next + delta + len) % len;
    if (!flatPlacerActive) return next;
    const item = items[next];
    if (!item) continue;
    if (item.kind === "artwork") return next;
    if (item.kind === "mockup" && isPostGenContextLabel(item.label)) return next;
  }
  return next;
}
