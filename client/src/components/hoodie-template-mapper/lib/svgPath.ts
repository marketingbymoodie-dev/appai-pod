/**
 * SVG path utilities for the hoodie template mapper.
 *
 * The template JSON stores mask shapes as a single closed polyline in SVG
 * "d=" syntax: "M x0 y0 L x1 y1 L x2 y2 ... Z". Phase 2 only emits straight
 * segments; Bezier handles arrive in a later phase.
 *
 * All coordinates are in mockup pixel space.
 */

import type { Pt, SvgPathD } from "@shared/hoodieTemplate";

/** Round to 2 decimal places to keep the JSON tidy. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Serialize a closed anchor list to SVG path "d=" syntax.
 * Returns "" for fewer than 3 anchors (an open polyline is not a valid mask).
 */
export function anchorsToSvgPath(anchors: readonly Pt[]): SvgPathD {
  if (!anchors || anchors.length < 3) return "";
  const head = `M ${round(anchors[0].x)} ${round(anchors[0].y)}`;
  const tail = anchors
    .slice(1)
    .map((p) => `L ${round(p.x)} ${round(p.y)}`)
    .join(" ");
  return `${head} ${tail} Z`;
}

/** Join multiple closed subpaths into one SVG "d=" (e.g. merged Front Left + Front Right). */
export function subpathsToSvgPath(subpaths: readonly (readonly Pt[])[]): SvgPathD {
  return subpaths
    .map((anchors) => anchorsToSvgPath(anchors))
    .filter(Boolean)
    .join(" ");
}

const NUM_RE = /-?\d+(?:\.\d+)?/g;

function dropClosingDuplicate(anchors: Pt[]): Pt[] {
  if (
    anchors.length >= 2 &&
    Math.abs(anchors[0].x - anchors[anchors.length - 1].x) < 0.01 &&
    Math.abs(anchors[0].y - anchors[anchors.length - 1].y) < 0.01
  ) {
    anchors.pop();
  }
  return anchors;
}

/**
 * Parse an SVG path into one closed subpath per M…Z segment.
 * Only handles M/L/Z (and lowercase relative variants).
 */
export function svgPathToSubpaths(d: SvgPathD): Pt[][] {
  if (!d) return [];
  const tokens = d
    .replace(/,/g, " ")
    .split(/(?=[A-Za-z])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const subpaths: Pt[][] = [];
  let current: Pt[] = [];
  let cx = 0;
  let cy = 0;
  for (const tok of tokens) {
    const cmd = tok[0];
    const nums = (tok.match(NUM_RE) || []).map(Number);
    switch (cmd) {
      case "M": {
        if (current.length >= 3) subpaths.push(dropClosingDuplicate(current));
        current = [];
        for (let i = 0; i + 1 < nums.length; i += 2) {
          cx = nums[i];
          cy = nums[i + 1];
          current.push({ x: cx, y: cy });
        }
        break;
      }
      case "L": {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          cx = nums[i];
          cy = nums[i + 1];
          current.push({ x: cx, y: cy });
        }
        break;
      }
      case "m": {
        if (current.length >= 3) subpaths.push(dropClosingDuplicate(current));
        current = [];
        for (let i = 0; i + 1 < nums.length; i += 2) {
          cx += nums[i];
          cy += nums[i + 1];
          current.push({ x: cx, y: cy });
        }
        break;
      }
      case "l": {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          cx += nums[i];
          cy += nums[i + 1];
          current.push({ x: cx, y: cy });
        }
        break;
      }
      case "Z":
      case "z": {
        if (current.length >= 3) subpaths.push(dropClosingDuplicate(current));
        current = [];
        break;
      }
      default:
        return [];
    }
  }
  if (current.length >= 3) subpaths.push(dropClosingDuplicate(current));
  return subpaths;
}

/**
 * Parse an SVG path "d=" into a flat anchor list. Only handles M/L/Z and
 * the lowercase variants (relative coords). Returns [] if the path can't
 * be parsed cleanly. Phase 2 always produces M/L/Z so this stays simple.
 *
 * For compound paths (multiple M…Z segments), returns the first subpath only.
 * Use {@link svgPathToSubpaths} when all regions matter (merged panels, render).
 */
export function svgPathToAnchors(d: SvgPathD): Pt[] {
  return svgPathToSubpaths(d)[0] ?? [];
}

/** Squared distance between two points. */
export function distSq(a: Pt, b: Pt): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Project p onto segment (a,b). Returns the projection plus its squared distance from p. */
export function projectOnSegment(p: Pt, a: Pt, b: Pt): { point: Pt; t: number; distSq: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { point: { ...a }, t: 0, distSq: distSq(p, a) };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  return { point, t, distSq: distSq(p, point) };
}

/**
 * Find the closest point on the closed polygon to p. Returns the segment
 * index (i, i+1) the projection falls on. The segment between the last
 * anchor and the first is index `anchors.length - 1`.
 */
export function nearestEdge(p: Pt, anchors: readonly Pt[]): {
  segmentIndex: number;
  point: Pt;
  t: number;
  distSq: number;
} | null {
  if (anchors.length < 2) return null;
  let best: { segmentIndex: number; point: Pt; t: number; distSq: number } | null = null;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % anchors.length];
    const proj = projectOnSegment(p, a, b);
    if (!best || proj.distSq < best.distSq) {
      best = { segmentIndex: i, ...proj };
    }
  }
  return best;
}

/** Nearest edge across all subpaths of a compound mask (merged panels). */
export function findNearestEdgeOnSubpaths(
  p: Pt,
  subpaths: readonly (readonly Pt[])[],
): {
  subpathIndex: number;
  segmentIndex: number;
  point: Pt;
  t: number;
  distSq: number;
} | null {
  let best: {
    subpathIndex: number;
    segmentIndex: number;
    point: Pt;
    t: number;
    distSq: number;
  } | null = null;
  for (let si = 0; si < subpaths.length; si++) {
    const ne = nearestEdge(p, subpaths[si]);
    if (!ne) continue;
    if (!best || ne.distSq < best.distSq) {
      best = { subpathIndex: si, ...ne };
    }
  }
  return best;
}

/** Bounding box union of all subpaths. */
export function boundingBoxOfSubpaths(
  subpaths: readonly (readonly Pt[])[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  return boundingBox(subpaths.flat());
}

/** Append closed subpaths to the current canvas path (call inside beginPath). */
export function appendMaskSubpathsToPath(
  ctx: CanvasRenderingContext2D,
  subpaths: readonly (readonly Pt[])[],
): boolean {
  const valid = subpaths.filter((ring) => ring.length >= 3);
  if (valid.length === 0) return false;
  for (const ring of valid) {
    ctx.moveTo(ring[0].x, ring[0].y);
    for (let i = 1; i < ring.length; i += 1) {
      ctx.lineTo(ring[i].x, ring[i].y);
    }
    ctx.closePath();
  }
  return true;
}

/** Clip a 2D canvas to the union of all mask subpaths (merged Front L+R, etc.). */
export function clipCanvasToMaskSubpaths(
  ctx: CanvasRenderingContext2D,
  subpaths: readonly (readonly Pt[])[],
): boolean {
  ctx.beginPath();
  if (!appendMaskSubpathsToPath(ctx, subpaths)) return false;
  ctx.clip();
  return true;
}

/** Flatten one subpath for Konva Line `points`. */
export function flattenSubpathPoints(anchors: readonly Pt[]): number[] {
  const out: number[] = [];
  for (const p of anchors) out.push(p.x, p.y);
  return out;
}

/**
 * Standard ray-casting point-in-polygon for a closed list of anchors.
 */
export function pointInPolygon(p: Pt, anchors: readonly Pt[]): boolean {
  if (anchors.length < 3) return false;
  let inside = false;
  for (let i = 0, j = anchors.length - 1; i < anchors.length; j = i++) {
    const xi = anchors[i].x;
    const yi = anchors[i].y;
    const xj = anchors[j].x;
    const yj = anchors[j].y;
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Douglas-Peucker simplification for a closed polyline. `epsilon` is in
 * mockup-pixel units (the tolerance in pixels between the simplified and
 * original path). Always returns at least 3 points.
 */
export function simplifyPath(anchors: readonly Pt[], epsilon: number): Pt[] {
  if (anchors.length <= 3 || epsilon <= 0) return anchors.slice();
  // Run DP twice on each half so closed shapes don't lose the first/last anchor.
  const n = anchors.length;
  const half = Math.floor(n / 2);
  const head = dp(anchors.slice(0, half + 1), epsilon);
  const tail = dp([anchors[half], ...anchors.slice(half + 1), anchors[0]], epsilon);
  // tail starts with the shared midpoint and ends with anchor[0]; drop first and last to avoid dupes.
  const merged = head.concat(tail.slice(1, -1));
  if (merged.length < 3) return anchors.slice(0, 3);
  return merged;
}

function dp(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return points.slice();
  let maxDistSq = 0;
  let index = 0;
  const a = points[0];
  const b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const proj = projectOnSegment(points[i], a, b);
    if (proj.distSq > maxDistSq) {
      maxDistSq = proj.distSq;
      index = i;
    }
  }
  if (Math.sqrt(maxDistSq) > epsilon) {
    const left = dp(points.slice(0, index + 1), epsilon);
    const right = dp(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

/**
 * One pass of Chaikin corner-cutting. Each iteration roughly doubles the
 * point count and rounds corners. `iterations` defaults to 1. Always closes
 * the result.
 */
export function smoothPath(anchors: readonly Pt[], iterations = 1): Pt[] {
  if (anchors.length < 3 || iterations <= 0) return anchors.slice();
  let pts: Pt[] = anchors.slice();
  for (let k = 0; k < iterations; k++) {
    const next: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      next.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      next.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    pts = next;
  }
  return pts;
}

/**
 * Bounding box for a list of anchors. Returns null for empty inputs.
 */
export function boundingBox(
  anchors: readonly Pt[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!anchors.length) return null;
  let minX = anchors[0].x;
  let minY = anchors[0].y;
  let maxX = anchors[0].x;
  let maxY = anchors[0].y;
  for (let i = 1; i < anchors.length; i++) {
    const p = anchors[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Centroid (average of vertices) — adequate for label placement. */
export function centroid(anchors: readonly Pt[]): Pt | null {
  if (!anchors.length) return null;
  let sx = 0;
  let sy = 0;
  for (const p of anchors) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / anchors.length, y: sy / anchors.length };
}
