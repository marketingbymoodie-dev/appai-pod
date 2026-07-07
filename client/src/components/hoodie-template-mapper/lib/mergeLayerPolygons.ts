/**
 * Boolean union of closed mask polygons (mockup pixel space).
 * Used when merging e.g. Front Left + Front Right into one Front panel.
 */

import { union } from "polygon-clipping";
import type { Pt } from "@shared/hoodieTemplate";

type Ring = [number, number][];

function ringArea(ring: Ring): number {
  if (ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    sum += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return Math.abs(sum) / 2;
}

function anchorsToRing(anchors: readonly Pt[]): Ring | null {
  if (anchors.length < 3) return null;
  return anchors.map((p) => [p.x, p.y]);
}

/**
 * Union two or more closed polygons into one outer boundary.
 * Returns null when inputs are invalid or union produces nothing.
 */
export function unionMaskAnchors(anchorLists: readonly Pt[][]): Pt[] | null {
  if (anchorLists.length < 2) return null;

  let acc: ReturnType<typeof union> | null = null;
  for (const anchors of anchorLists) {
    const ring = anchorsToRing(anchors);
    if (!ring) return null;
    const poly = [ring];
    acc = acc ? union(acc, poly) : poly;
  }
  if (!acc?.length) return null;

  let bestRing: Ring | null = null;
  let bestArea = 0;
  for (const polygon of acc) {
    const outer = polygon[0];
    if (!outer || outer.length < 3) continue;
    const area = ringArea(outer);
    if (area > bestArea) {
      bestArea = area;
      bestRing = outer;
    }
  }
  if (!bestRing) return null;
  return bestRing.map(([x, y]) => ({ x, y }));
}
