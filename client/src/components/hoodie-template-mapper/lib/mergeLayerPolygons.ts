/**
 * Boolean union of closed mask polygons (mockup pixel space).
 * Used when merging e.g. Front Left + Front Right into one Front panel.
 *
 * Disjoint panels (bomber jacket halves) stay as separate subpaths in one layer —
 * union returns multiple polygons and we keep all outer rings, not just the largest.
 */

import polygonClipping from "polygon-clipping";
import type { Pt } from "@shared/hoodieTemplate";

const { union } = polygonClipping;

type Ring = [number, number][];

function anchorsToRing(anchors: readonly Pt[]): Ring | null {
  if (anchors.length < 3) return null;
  return anchors.map((p) => [p.x, p.y]);
}

function ringToAnchors(ring: Ring): Pt[] {
  return ring.map(([x, y]) => ({ x, y }));
}

/**
 * Union two or more closed polygons. Returns one subpath per disjoint region
 * (e.g. left + right front panels). Overlapping inputs collapse to one ring.
 */
export function unionMaskSubpaths(anchorLists: readonly Pt[][]): Pt[][] | null {
  if (anchorLists.length < 2) return null;

  let acc: ReturnType<typeof union> | null = null;
  for (const anchors of anchorLists) {
    const ring = anchorsToRing(anchors);
    if (!ring) return null;
    const poly = [ring];
    acc = acc ? union(acc, poly) : poly;
  }
  if (!acc?.length) return null;

  const subpaths: Pt[][] = [];
  for (const polygon of acc) {
    const outer = polygon[0];
    if (outer && outer.length >= 3) subpaths.push(ringToAnchors(outer));
  }
  return subpaths.length > 0 ? subpaths : null;
}

/** @deprecated Use unionMaskSubpaths — kept for tests migrating from single-ring API. */
export function unionMaskAnchors(anchorLists: readonly Pt[][]): Pt[] | null {
  const subpaths = unionMaskSubpaths(anchorLists);
  if (!subpaths) return null;
  if (subpaths.length === 1) return subpaths[0];
  return null;
}
