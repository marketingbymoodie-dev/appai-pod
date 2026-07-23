import { isContextLikeMockupLabel } from "@shared/printifyMockupLabels";

export type PostGenGalleryNavItem =
  | { kind: "artwork"; label: string }
  | { kind: "mockup"; url: string; label: string }
  | { kind: "catalog"; url: string; label: string };

export function isPostGenContextLabel(label: string): boolean {
  const l = String(label || "").toLowerCase();
  if (!l) return false;
  if (l.startsWith("printers") || l.startsWith("printify")) return true;
  return isContextLikeMockupLabel(label);
}

/**
 * While the flat placer is open, skip local Front/Back rasters (they match the
 * live canvas). Keep Artwork, merchant catalog Views (Primary / View 2…), and
 * on-demand Printers/Context mockups.
 */
export function isFlatPlacerGalleryReachable(item: PostGenGalleryNavItem): boolean {
  if (item.kind === "artwork") return true;
  if (item.kind === "catalog") return true;
  if (item.kind === "mockup") return isPostGenContextLabel(item.label);
  return false;
}

/**
 * Step the post-gen carousel. When the flat placer is open, skip Front rasters
 * so catalog + Printers/Context slides stay reachable after wrapping.
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
    if (isFlatPlacerGalleryReachable(item)) return next;
  }
  return next;
}
