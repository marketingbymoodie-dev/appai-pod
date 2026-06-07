/**
 * Read-only calibration / harvester for flat (front+back print) products.
 *
 * Goal: validate — BEFORE building any UI — that we can, fully automatically,
 * derive from Printify everything an on-the-fly masked mockup needs:
 *   1. The exact PRINT-AREA rectangle on the garment photo, per view
 *      (front/back), by printing a full-bleed #FF00FF target into the print
 *      area and detecting the magenta region in the returned mockup.
 *   2. A clean BLANK garment photo per colour, per view, by rendering the
 *      product with a fully-transparent print.
 *
 * This script ONLY writes to tmp/flat-calibration/<key>/ and creates+deletes
 * temporary Printify products (same pattern the live costs/mockup flow uses).
 * It does NOT touch our database or schema.
 *
 * Usage (either identify the product from our DB, or hit Printify directly):
 *   npx tsx scripts/harvest-flat-mockups.ts --productTypeId 42
 *   npx tsx scripts/harvest-flat-mockups.ts --blueprintId 1684 --providerId 99
 *   npx tsx scripts/harvest-flat-mockups.ts --blueprintId 1684 --providerId 99 --colors 4
 *
 * Optional flags: --variantId <id>, --shopId <id>, --colors <max>, --out <dir>
 *
 * PROBE mode (planarity / "bow" scoring → flat | mesh | reject):
 *   npx tsx scripts/harvest-flat-mockups.ts --probe --productTypeId 13
 *   npx tsx scripts/harvest-flat-mockups.ts --probe --blueprintId 5 --providerId 99 --grid 6x8
 *   Extra probe flags: --grid CxR (default 6x8), --t1 <n>, --t2 <n>,
 *                       --minCoverage <0..1> (reject if too few nodes survive), --view <position>
 *   Prints a magenta dot grid, measures how straight rows/cols stay in the
 *   mockup, and classifies the surface (flat=homography, mesh=warp, reject=keep
 *   Printify mockups). Writes probe-grid-source.png, probe-detected.png, probe.json.
 *
 * Requires PRINTIFY_API_TOKEN (+ DATABASE_URL only when using --productTypeId).
 */

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const PRINTIFY_API_BASE = "https://api.printify.com/v1";
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 60_000;
const WANTED_VIEWS = ["front", "back"] as const;
type ViewName = (typeof WANTED_VIEWS)[number];

// ── PROBE defaults ────────────────────────────────────────────────────────────
// Planarity "bow" thresholds (dimensionless; perpendicular RMS deviation of the
// fitted rows/cols as a fraction of the detected grid's diagonal extent).
// Calibrated from validation runs (6x8 grid):
//   tee  (blueprint 5/99)    bowScore 0.00006, coverage 100% → flat
//   cap  (blueprint 1108/99) bowScore 0.01077, coverage 100% → mesh  (rows bow, cols straight)
//   tumbler (353/1)          coverage 33% (only ~2 of 6 cols survive) → reject (coverage gate)
const DEFAULT_PROBE_T1 = 0.006; // flat  if bowScore < t1   (≈100x above the tee noise floor)
const DEFAULT_PROBE_T2 = 0.03; //  mesh  if t1 <= bowScore < t2; reject if >= t2
// Coverage gate: a flat/mildly-curved surface shows nearly every grid node. A
// cylinder/wrap/3D surface HIDES most of the grid (the tumbler only shows ~2 of
// 6 columns → 0.33). Too few surviving nodes ⇒ reject regardless of bow.
const DEFAULT_PROBE_MIN_COVERAGE = 0.6;
const DEFAULT_PROBE_COLS = 6;
const DEFAULT_PROBE_ROWS = 8;
const PROBE_MAX_SRC_SIDE = 1600; // cap generated grid resolution

// ── tiny arg/util helpers ───────────────────────────────────────────────────
function argValue(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0) return process.argv[idx + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ── Printify REST helpers ─────────────────────────────────────────────────────
async function pf<T = any>(
  pathname: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${PRINTIFY_API_BASE}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Printify ${res.status} on ${pathname}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

async function uploadImage(token: string, fileName: string, buffer: Buffer): Promise<string> {
  const result = await pf<{ id: string }>("/uploads/images.json", token, {
    method: "POST",
    body: JSON.stringify({ file_name: fileName, contents: buffer.toString("base64") }),
  });
  return result.id;
}

type Placeholder = { position: string; images: Array<{ id: string; x: number; y: number; scale: number; angle: number }> };

async function createTempProduct(
  token: string,
  shopId: string,
  blueprintId: number,
  providerId: number,
  variantId: number,
  placeholders: Placeholder[],
): Promise<{ productId: string; images: Array<{ url: string; label: string }> }> {
  const body = {
    title: `__appai_calibration_${Date.now()}`,
    description: "temp calibration product (auto-deleted)",
    blueprint_id: blueprintId,
    print_provider_id: providerId,
    variants: [{ id: variantId, price: 100, is_enabled: true }],
    print_areas: [{ variant_ids: [variantId], placeholders }],
  };
  const product = await pf<any>(`/shops/${shopId}/products.json`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { productId: String(product.id), images: extractImages(product), raw: product };
}

function extractCameraLabel(url: string): string {
  const m = url.match(/camera_label=([^&]+)/);
  if (!m) return "front";
  try {
    return decodeURIComponent(m[1].replace(/\+/g, " ")).toLowerCase().trim();
  } catch {
    return m[1].replace(/\+/g, " ").toLowerCase().trim();
  }
}
function extractImages(product: any): Array<{ url: string; label: string }> {
  if (!product || !Array.isArray(product.images)) return [];
  return product.images
    .filter((i: any) => i && typeof i.src === "string" && i.src)
    .map((i: any) => ({ url: i.src, label: extractCameraLabel(i.src) }));
}

async function pollMockups(
  token: string,
  shopId: string,
  productId: string,
  initial: Array<{ url: string; label: string }>,
): Promise<Array<{ url: string; label: string }>> {
  if (initial.length > 0) return initial;
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const product = await pf<any>(`/shops/${shopId}/products/${productId}.json`, token);
    const imgs = extractImages(product);
    if (imgs.length > 0) return imgs;
  }
  return [];
}

async function deleteProduct(token: string, shopId: string, productId: string): Promise<void> {
  try {
    await fetch(`${PRINTIFY_API_BASE}/shops/${shopId}/products/${productId}.json`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    /* best-effort cleanup */
  }
}

// ── image generation + detection ──────────────────────────────────────────────
// How we make the registration target FILL the entire print area (the crux):
//
//   • Printify IGNORES the uploaded image's absolute pixel size.
//   • The product-mockup renderer HARD-CLAMPS placement `scale` at 1.0 — values
//     >1 render byte-identically to scale=1 (verified: scale 1/2/4/8 → identical
//     mockups; only scale<1 shrinks). So "over-scaling" to fill is impossible.
//   • At scale=1 the art is laid into the print area at the print-area WIDTH and
//     CLIPPED to the true printable rectangle. Proven empirically: a landscape,
//     a square AND a tall-portrait magenta ALL render to the exact same clipped
//     rectangle (the placeholder's aspect ratio).
//
// Therefore, to guarantee a FULL fill we generate the target at the placeholder
// aspect ratio and OVERSCAN the height: at scale=1 the magenta overflows the
// print rectangle top/bottom and Printify clips it back to the exact boundary,
// yielding the true print-area rect + pixel-exact silhouette (incl. occlusion
// such as a hoodie's hood notch). Horizontal fill is automatic — at scale=1 the
// rendered width always equals the print-area width.
const REG_VERTICAL_OVERSCAN = 1.12;

async function magentaPng(targetW: number, targetH: number): Promise<Buffer> {
  // Printify caches mockups on image CONTENT, so we stamp a unique random speck
  // in the corner to force a fresh render for every run (otherwise identical
  // solid magenta can return a stale cached mockup).
  const w = Math.max(1, Math.round(targetW));
  const h = Math.max(1, Math.round(targetH * REG_VERTICAL_OVERSCAN));
  const speck = {
    input: {
      create: {
        width: 8,
        height: 8,
        channels: 4 as const,
        background: { r: (Math.random() * 200) | 0, g: (Math.random() * 100) | 0, b: (Math.random() * 50) | 0, alpha: 1 },
      },
    },
    left: 1,
    top: 1,
  };
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } } })
    .composite([speck])
    .png()
    .toBuffer();
}
async function transparentPng(): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png()
    .toBuffer();
}

async function downloadBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

type MagentaAnalysis = {
  width: number;
  height: number;
  found: boolean;
  count: number;
  px: { x: number; y: number; width: number; height: number } | null;
  normalized: { x: number; y: number; width: number; height: number } | null;
  /** White-on-transparent silhouette of the EXACT visible print region. */
  maskRaw: Buffer;
  /** Green @ ~55% over the visible print region; transparent elsewhere. */
  tintRaw: Buffer;
};

/**
 * Scan the #FF00FF print region in a mockup photo. Returns both the bounding
 * box AND a pixel-exact silhouette (which captures occlusion, e.g. the hood
 * notch on a hoodie back). The silhouette is what the live preview clips
 * artwork to so it matches Printify — it never affects the file sent to print.
 */
async function analyzeMagenta(buffer: Buffer): Promise<MagentaAnalysis> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const maskRaw = Buffer.alloc(width * height * 4, 0);
  const tintRaw = Buffer.alloc(width * height * 4, 0);
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 170 && b > 170 && g < 95) {
        count++;
        const o = (y * width + x) * 4;
        maskRaw[o] = 255; maskRaw[o + 1] = 255; maskRaw[o + 2] = 255; maskRaw[o + 3] = 255;
        tintRaw[o] = 0; tintRaw[o + 1] = 210; tintRaw[o + 2] = 90; tintRaw[o + 3] = 140;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const found = maxX >= 0;
  const px = found ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
  return {
    width,
    height,
    found,
    count,
    px,
    normalized: px
      ? {
          x: +(px.x / width).toFixed(5),
          y: +(px.y / height).toFixed(5),
          width: +(px.width / width).toFixed(5),
          height: +(px.height / height).toFixed(5),
        }
      : null,
    maskRaw,
    tintRaw,
  };
}

function rawToPng(raw: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

// ── PROBE: planarity / "bow" scoring ─────────────────────────────────────────
// We print a regular grid of magenta dots (transparent gaps) into the print
// area, then measure how STRAIGHT the grid rows/columns stay in the returned
// mockup. A flat surface (even shown at an angle) keeps every row/column a
// straight line under perspective → ~0 bow. A cylinder bows the rows into arcs.
type GridNode = { row: number; col: number; xn: number; yn: number };
type Centroid = { x: number; y: number; count: number };

async function gridPng(
  srcW: number,
  srcH: number,
  cols: number,
  rows: number,
): Promise<{ buffer: Buffer; nodes: GridNode[]; dotPx: number; width: number; height: number }> {
  const cellW = srcW / cols;
  const cellH = srcH / rows;
  const dotPx = Math.max(6, Math.round(0.3 * Math.min(cellW, cellH)));
  const nodes: GridNode[] = [];
  const composites: sharp.OverlayOptions[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const xn = (c + 0.5) / cols;
      const yn = (r + 0.5) / rows;
      nodes.push({ row: r, col: c, xn, yn });
      const left = Math.round(xn * srcW - dotPx / 2);
      const top = Math.round(yn * srcH - dotPx / 2);
      composites.push({
        input: { create: { width: dotPx, height: dotPx, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } } },
        left: Math.max(0, Math.min(srcW - dotPx, left)),
        top: Math.max(0, Math.min(srcH - dotPx, top)),
      });
    }
  }
  // cache-bust speck (NON-magenta so detection ignores it): identical grids
  // would otherwise return a stale cached Printify mockup.
  composites.push({
    input: { create: { width: 6, height: 6, channels: 4, background: { r: (Math.random() * 200) | 0, g: (Math.random() * 80) | 0, b: (Math.random() * 40) | 0, alpha: 1 } } },
    left: 1,
    top: 1,
  });
  const buffer = await sharp({ create: { width: srcW, height: srcH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .png()
    .toBuffer();
  return { buffer, nodes, dotPx, width: srcW, height: srcH };
}

/** Connected-component centroids of the magenta dots (4-connectivity flood fill). */
async function detectDots(buffer: Buffer): Promise<{ centroids: Centroid[]; width: number; height: number }> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 170 && b > 170 && g < 95) mask[y * width + x] = 1;
    }
  }
  const visited = new Uint8Array(width * height);
  const comps: Centroid[] = [];
  const stack: number[] = [];
  for (let p = 0; p < width * height; p++) {
    if (!mask[p] || visited[p]) continue;
    let sx = 0, sy = 0, cnt = 0;
    stack.push(p);
    visited[p] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      const qx = q % width;
      const qy = (q / width) | 0;
      sx += qx;
      sy += qy;
      cnt++;
      if (qx > 0) { const n = q - 1; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
      if (qx < width - 1) { const n = q + 1; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
      if (qy > 0) { const n = q - width; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
      if (qy < height - 1) { const n = q + width; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
    }
    comps.push({ x: sx / cnt, y: sy / cnt, count: cnt });
  }
  if (comps.length === 0) return { centroids: [], width, height };
  // Drop noise: anything much smaller than the median blob (antialias specks etc.).
  const sizes = comps.map((c) => c.count).sort((a, b) => a - b);
  const median = sizes[sizes.length >> 1];
  const minCount = Math.max(4, median * 0.2);
  return { centroids: comps.filter((c) => c.count >= minCount), width, height };
}

/** Simple 1-D k-means; returns a cluster index per value, relabelled ascending. */
function kmeans1d(values: number[], k: number, iters = 60): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values), max = Math.max(...values);
  let centers = Array.from({ length: k }, (_, i) => min + ((i + 0.5) * (max - min)) / k);
  const assign = new Array(values.length).fill(0);
  for (let it = 0; it < iters; it++) {
    let changed = false;
    for (let i = 0; i < values.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = Math.abs(values[i] - centers[c]);
        if (d < bd) { bd = d; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; changed = true; }
    }
    const sum = new Array(k).fill(0), cnt = new Array(k).fill(0);
    for (let i = 0; i < values.length; i++) { sum[assign[i]] += values[i]; cnt[assign[i]]++; }
    for (let c = 0; c < k; c++) if (cnt[c] > 0) centers[c] = sum[c] / cnt[c];
    if (!changed && it > 0) break;
  }
  const order = centers.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const remap = new Array(k);
  order.forEach((o, newIdx) => { remap[o.i] = newIdx; });
  return assign.map((a) => remap[a]);
}

/** Total-least-squares line fit; returns RMS perpendicular deviation + direction. */
function lineFitRms(pts: { x: number; y: number }[]): { rms: number; dir: { x: number; y: number }; cx: number; cy: number } | null {
  const n = pts.length;
  if (n < 2) return null;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { const dx = p.x - cx, dy = p.y - cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  sxx /= n; sxy /= n; syy /= n;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const lMax = tr / 2 + disc, lMin = tr / 2 - disc;
  const rms = Math.sqrt(Math.max(0, lMin)); // mean squared perp distance = smaller eigenvalue
  let dir: { x: number; y: number };
  if (Math.abs(sxy) > 1e-9) dir = { x: lMax - syy, y: sxy };
  else dir = sxx >= syy ? { x: 1, y: 0 } : { x: 0, y: 1 };
  const dl = Math.hypot(dir.x, dir.y) || 1;
  return { rms, dir: { x: dir.x / dl, y: dir.y / dl }, cx, cy };
}

/** Least-squares homography (inhomogeneous DLT, h33=1) via normal equations. */
function solveHomography(src: { x: number; y: number }[], dst: { x: number; y: number }[]): number[] | null {
  const n = src.length;
  if (n < 4) return null;
  const ATA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const ATb = new Array(8).fill(0);
  const addRow = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      ATb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) ATA[i][j] += row[i] * row[j];
    }
  };
  for (let k = 0; k < n; k++) {
    const X = src[k].x, Y = src[k].y, u = dst[k].x, v = dst[k].y;
    addRow([X, Y, 1, 0, 0, 0, -X * u, -Y * u], u);
    addRow([0, 0, 0, X, Y, 1, -X * v, -Y * v], v);
  }
  return gaussSolve(ATA, ATb);
}
function gaussSolve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map((row) => row[n]);
}
function applyH(h: number[], x: number, y: number): { x: number; y: number } {
  const d = h[6] * x + h[7] * y + 1;
  return { x: (h[0] * x + h[1] * y + h[2]) / d, y: (h[3] * x + h[4] * y + h[5]) / d };
}

function esc(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}
/** SVG overlay: dots (yellow), per-line straight fit (cyan), dot polyline (orange),
 *  homography-expected node (lime). Bow = gap between the orange and cyan lines. */
function buildProbeSvg(
  width: number,
  height: number,
  lines: Array<{ a: { x: number; y: number }; b: { x: number; y: number }; poly: { x: number; y: number }[] }>,
  centroids: Centroid[],
  expected: { x: number; y: number }[],
): string {
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  for (const l of lines) {
    if (l.poly.length >= 2) {
      const pts = l.poly.map((p) => `${esc(p.x)},${esc(p.y)}`).join(" ");
      parts.push(`<polyline points="${pts}" fill="none" stroke="#ff8c00" stroke-width="2"/>`);
    }
    parts.push(`<line x1="${esc(l.a.x)}" y1="${esc(l.a.y)}" x2="${esc(l.b.x)}" y2="${esc(l.b.y)}" stroke="#00e5ff" stroke-width="1.5"/>`);
  }
  for (const e of expected) parts.push(`<circle cx="${esc(e.x)}" cy="${esc(e.y)}" r="3" fill="none" stroke="#39ff14" stroke-width="1.2"/>`);
  for (const c of centroids) parts.push(`<circle cx="${esc(c.x)}" cy="${esc(c.y)}" r="3.5" fill="#ffd400"/>`);
  parts.push(`</svg>`);
  return parts.join("");
}

async function runProbe(opts: {
  token: string;
  shopId: string;
  blueprintId: number;
  providerId: number;
  variantId: number;
  placeholder: { width: number; height: number };
  view: string;
  cols: number;
  rows: number;
  t1: number;
  t2: number;
  minCoverage: number;
  outDir: string;
  name: string;
}): Promise<void> {
  const { token, shopId, blueprintId, providerId, variantId, placeholder, view, cols, rows, t1, t2, minCoverage, outDir, name } = opts;
  await fs.mkdir(outDir, { recursive: true });

  // 1. Build the registration grid at the placeholder aspect ratio (capped res).
  const sf = Math.min(1, PROBE_MAX_SRC_SIDE / Math.max(placeholder.width, placeholder.height));
  const srcW = Math.max(cols * 12, Math.round(placeholder.width * sf));
  const srcH = Math.max(rows * 12, Math.round(placeholder.height * sf));
  const grid = await gridPng(srcW, srcH, cols, rows);
  await fs.writeFile(path.join(outDir, "probe-grid-source.png"), grid.buffer);
  console.log(`[probe] ${name} blueprint=${blueprintId} provider=${providerId} view=${view} grid=${cols}x${rows} src=${srcW}x${srcH} dot=${grid.dotPx}px`);

  const createdProductIds: string[] = [];
  try {
    const imageId = await uploadImage(token, `probe-grid-${view}.png`, grid.buffer);
    const placeholders: Placeholder[] = [{ position: view, images: [{ id: imageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }];
    const created = await createTempProduct(token, shopId, blueprintId, providerId, variantId, placeholders);
    createdProductIds.push(created.productId);
    const images = await pollMockups(token, shopId, created.productId, created.images);
    const match = images.find((i) => i.label === view) || images.find((i) => i.label.includes(view)) || images[0];
    if (!match) throw new Error("no mockup returned for probe grid");
    const mockup = await downloadBuffer(match.url);
    await fs.writeFile(path.join(outDir, "probe-mockup-raw.png"), mockup);

    // 2. Detect dot centroids.
    const det = await detectDots(mockup);
    console.log(`[probe] detected ${det.centroids.length} dot clusters (expected ${cols * rows}) in ${det.width}x${det.height} mockup`);
    if (det.centroids.length === 0) {
      console.warn(`[probe] NO dots detected — the print may be fully hidden/wrapped (→ reject) or the mockup failed to render.`);
    }

    // 3. Assign dots to rows/cols via 1-D k-means.
    const xs = det.centroids.map((c) => c.x);
    const ys = det.centroids.map((c) => c.y);
    const rowIdx = kmeans1d(ys, rows);
    const colIdx = kmeans1d(xs, cols);

    // De-dup to one centroid per (row,col), keeping the largest blob.
    const cellMap = new Map<string, { c: Centroid; row: number; col: number }>();
    for (let i = 0; i < det.centroids.length; i++) {
      const key = `${rowIdx[i]},${colIdx[i]}`;
      const prev = cellMap.get(key);
      if (!prev || det.centroids[i].count > prev.c.count) cellMap.set(key, { c: det.centroids[i], row: rowIdx[i], col: colIdx[i] });
    }
    const assigned = [...cellMap.values()];

    // 4. Bow score from row/col straightness, normalized by grid extent.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const a of assigned) {
      if (a.c.x < minX) minX = a.c.x;
      if (a.c.y < minY) minY = a.c.y;
      if (a.c.x > maxX) maxX = a.c.x;
      if (a.c.y > maxY) maxY = a.c.y;
    }
    const extent = Math.hypot(maxX - minX, maxY - minY) || 1;

    const drawLines: Array<{ a: { x: number; y: number }; b: { x: number; y: number }; poly: { x: number; y: number }[] }> = [];
    const rowRms: number[] = [];
    const colRms: number[] = [];
    const rowsOut: any[] = [];
    const colsOut: any[] = [];

    const fitGroup = (members: { c: Centroid }[], sortKey: "x" | "y") => {
      const pts = members.map((m) => ({ x: m.c.x, y: m.c.y }));
      if (pts.length < 3) return null; // need >=3 so the fit isn't trivially perfect
      const fit = lineFitRms(pts);
      if (!fit) return null;
      const ts = pts.map((p) => (p.x - fit.cx) * fit.dir.x + (p.y - fit.cy) * fit.dir.y);
      const tmin = Math.min(...ts), tmax = Math.max(...ts);
      const a = { x: fit.cx + fit.dir.x * tmin, y: fit.cy + fit.dir.y * tmin };
      const b = { x: fit.cx + fit.dir.x * tmax, y: fit.cy + fit.dir.y * tmax };
      const poly = pts.slice().sort((p, q) => p[sortKey] - q[sortKey]);
      drawLines.push({ a, b, poly });
      return { rmsPx: fit.rms, rmsNorm: fit.rms / extent, points: pts.length };
    };

    for (let r = 0; r < rows; r++) {
      const members = assigned.filter((a) => a.row === r);
      const res = fitGroup(members, "x");
      if (res) { rowRms.push(res.rmsNorm); rowsOut.push({ row: r, ...res }); }
    }
    for (let c = 0; c < cols; c++) {
      const members = assigned.filter((a) => a.col === c);
      const res = fitGroup(members, "y");
      if (res) { colRms.push(res.rmsNorm); colsOut.push({ col: c, ...res }); }
    }

    const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
    const max = (a: number[]) => (a.length ? Math.max(...a) : 0);
    const meanRowRms = mean(rowRms), maxRowRms = max(rowRms);
    const meanColRms = mean(colRms), maxColRms = max(colRms);
    // Dominant-direction mean bow: a cylinder bows rows but keeps columns straight,
    // so taking the larger of the two directional means isolates the curvature.
    const bowScore = Math.max(meanRowRms, meanColRms);

    // 5. Displacement field (control grid) + homography residual cross-check.
    const expectedNorm = grid.nodes; // source-normalized node positions
    const srcPts: { x: number; y: number }[] = [];
    const dstPts: { x: number; y: number }[] = [];
    const nodeByCell = new Map<string, Centroid>();
    for (const a of assigned) nodeByCell.set(`${a.row},${a.col}`, a.c);
    for (const n of expectedNorm) {
      const c = nodeByCell.get(`${n.row},${n.col}`);
      if (c) { srcPts.push({ x: n.xn, y: n.yn }); dstPts.push({ x: c.x, y: c.y }); }
    }
    const H = solveHomography(srcPts, dstPts);
    const expectedPxList: { x: number; y: number }[] = [];
    let hResSq = 0, hResN = 0;
    const nodesOut = expectedNorm.map((n) => {
      const c = nodeByCell.get(`${n.row},${n.col}`);
      const exp = H ? applyH(H, n.xn, n.yn) : null;
      if (exp) expectedPxList.push(exp);
      let disp: { x: number; y: number } | null = null;
      if (c && exp) {
        disp = { x: +(c.x - exp.x).toFixed(2), y: +(c.y - exp.y).toFixed(2) };
        hResSq += disp.x * disp.x + disp.y * disp.y;
        hResN++;
      }
      return {
        row: n.row,
        col: n.col,
        xn: +n.xn.toFixed(5),
        yn: +n.yn.toFixed(5),
        detectedPx: c ? { x: +c.x.toFixed(2), y: +c.y.toFixed(2) } : null,
        expectedPx: exp ? { x: +exp.x.toFixed(2), y: +exp.y.toFixed(2) } : null,
        displacementPx: disp,
      };
    });
    const homographyResidualNorm = hResN ? Math.sqrt(hResSq / hResN) / extent : null;

    // 6. Classify. Coverage gate first: a wrapped/3D surface hides most nodes
    //    (the row/col bow of the few survivors is meaningless), so low coverage
    //    is decisive for reject. Otherwise the bow thresholds decide flat/mesh.
    const coverage = (cols * rows) > 0 ? assigned.length / (cols * rows) : 0;
    let classification: "flat" | "mesh" | "reject";
    let reason: string;
    if (coverage < minCoverage) {
      classification = "reject";
      reason = `coverage ${coverage.toFixed(2)} < ${minCoverage} (most grid nodes hidden → wrapped/3D surface)`;
    } else if (bowScore < t1) {
      classification = "flat";
      reason = `bowScore ${bowScore.toFixed(5)} < t1 ${t1}`;
    } else if (bowScore < t2) {
      classification = "mesh";
      reason = `t1 ${t1} <= bowScore ${bowScore.toFixed(5)} < t2 ${t2}`;
    } else {
      classification = "reject";
      reason = `bowScore ${bowScore.toFixed(5)} >= t2 ${t2}`;
    }

    // 7. Visualisation.
    const svg = buildProbeSvg(det.width, det.height, drawLines, assigned.map((a) => a.c), expectedPxList);
    const overlay = await sharp(mockup).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
    await fs.writeFile(path.join(outDir, "probe-detected.png"), overlay);

    const probe = {
      name,
      blueprintId,
      providerId,
      shopId,
      variantId,
      view,
      grid: {
        cols,
        rows,
        dotPx: grid.dotPx,
        sourceImage: { width: srcW, height: srcH },
        placeholder,
        expectedNormalizedNodes: expectedNorm.map((n) => ({ row: n.row, col: n.col, xn: +n.xn.toFixed(5), yn: +n.yn.toFixed(5) })),
      },
      mockup: { width: det.width, height: det.height, url: match.url },
      detection: { totalCentroids: det.centroids.length, assignedNodes: assigned.length, expectedNodes: cols * rows, coverage: +coverage.toFixed(3) },
      nodes: nodesOut,
      rows: rowsOut,
      cols: colsOut,
      metrics: {
        extentPx: +extent.toFixed(2),
        meanRowRmsNorm: +meanRowRms.toFixed(5),
        maxRowRmsNorm: +maxRowRms.toFixed(5),
        meanColRmsNorm: +meanColRms.toFixed(5),
        maxColRmsNorm: +maxColRms.toFixed(5),
        homographyResidualNorm: homographyResidualNorm == null ? null : +homographyResidualNorm.toFixed(5),
        coverage: +coverage.toFixed(3),
        bowScore: +bowScore.toFixed(5),
      },
      thresholds: { t1, t2, minCoverage },
      classification,
      reason,
      generatedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(outDir, "probe.json"), JSON.stringify(probe, null, 2), "utf8");

    console.log(`[probe] coverage=${(coverage * 100).toFixed(0)}% (${assigned.length}/${cols * rows})  rows fitted=${rowsOut.length}/${rows} cols fitted=${colsOut.length}/${cols}`);
    console.log(`[probe] meanRowRms=${meanRowRms.toFixed(5)} maxRowRms=${maxRowRms.toFixed(5)} meanColRms=${meanColRms.toFixed(5)} maxColRms=${maxColRms.toFixed(5)}`);
    console.log(`[probe] homographyResidualNorm=${homographyResidualNorm == null ? "n/a" : homographyResidualNorm.toFixed(5)}`);
    console.log(`[probe] bowScore=${bowScore.toFixed(5)}  →  CLASSIFICATION: ${classification.toUpperCase()}  (${reason})`);
    console.log(`[probe] wrote ${outDir}\\probe-grid-source.png, probe-detected.png, probe.json`);
  } finally {
    for (const id of createdProductIds) await deleteProduct(token, shopId, id);
    console.log(`[probe] cleaned up ${createdProductIds.length} temp product(s).`);
  }
}

// ── product/colour resolution ─────────────────────────────────────────────────
type ColorEntry = { id: string; name: string; hex?: string; variantId: number };

async function resolveFromDb(productTypeId: number) {
  const pg = (await import("pg")).default;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL required for --productTypeId");
  const pool = new pg.Pool({
    connectionString,
    ssl: connectionString.includes("rlwy.net") ? { rejectUnauthorized: false } : false,
  });
  try {
    const { rows } = await pool.query(
      `SELECT pt.*, m.printify_api_token, m.printify_shop_id
         FROM product_types pt LEFT JOIN merchants m ON m.id = pt.merchant_id
         WHERE pt.id = $1 LIMIT 1`,
      [productTypeId],
    );
    const p = rows[0];
    if (!p) throw new Error(`product_type ${productTypeId} not found`);
    const frameColors = parseJson<Array<{ id: string; name: string; hex?: string }>>(p.frame_colors, []);
    const variantMap = parseJson<Record<string, { printifyVariantId: number }>>(p.variant_map, {});
    const colorToVariant = new Map<string, number>();
    for (const [key, val] of Object.entries(variantMap)) {
      const colorId = key.split(":")[1];
      if (colorId && !colorToVariant.has(colorId) && val?.printifyVariantId) {
        colorToVariant.set(colorId, Number(val.printifyVariantId));
      }
    }
    const colors: ColorEntry[] = frameColors
      .filter((c) => colorToVariant.has(String(c.id)))
      .map((c) => ({ id: String(c.id), name: c.name, hex: c.hex, variantId: colorToVariant.get(String(c.id))! }));
    return {
      token: (p.printify_api_token as string) || process.env.PRINTIFY_API_TOKEN!,
      shopId: p.printify_shop_id as string | null,
      blueprintId: Number(p.printify_blueprint_id),
      providerId: Number(p.printify_provider_id),
      name: p.name as string,
      colors,
    };
  } finally {
    await pool.end();
  }
}

async function resolveColorsFromCatalog(token: string, blueprintId: number, providerId: number, variants: any[]): Promise<ColorEntry[]> {
  const blueprint = await pf<any>(`/catalog/blueprints/${blueprintId}.json`, token);
  const colorOption = (blueprint.options || []).find((o: any) => o.type === "color" || /colou?r/i.test(o.name || ""));
  const valueMeta = new Map<number, { name: string; hex?: string }>();
  if (colorOption) {
    for (const v of colorOption.values || []) {
      valueMeta.set(Number(v.id), { name: v.title || String(v.id), hex: Array.isArray(v.colors) ? v.colors[0] : undefined });
    }
  }
  const colorIdSet = new Set(valueMeta.keys());
  const byColor = new Map<number, ColorEntry>();
  for (const variant of variants) {
    const optVals: number[] = Array.isArray(variant.options) ? variant.options : Object.values(variant.options || {}).map(Number);
    const colorId = optVals.find((id) => colorIdSet.has(Number(id)));
    if (colorId == null || byColor.has(colorId)) continue;
    const meta = valueMeta.get(Number(colorId));
    byColor.set(colorId, { id: String(colorId), name: meta?.name || String(colorId), hex: meta?.hex, variantId: variant.id });
  }
  return [...byColor.values()];
}

async function listProductTypes() {
  const pg = (await import("pg")).default;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL required for --list");
  const pool = new pg.Pool({
    connectionString,
    ssl: connectionString.includes("rlwy.net") ? { rejectUnauthorized: false } : false,
  });
  try {
    const { rows } = await pool.query(
      `SELECT id, name, printify_blueprint_id AS blueprint, printify_provider_id AS provider,
              is_all_over_print AS aop, designer_type
         FROM product_types
         ORDER BY is_all_over_print ASC, updated_at DESC
         LIMIT 60`,
    );
    console.table(rows);
    console.log(`\n[harvest] Pick a non-AOP (aop=false) flat product and run:\n  npx tsx scripts/harvest-flat-mockups.ts --productTypeId <id>`);
  } finally {
    await pool.end();
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (process.argv.includes("--list")) {
    await listProductTypes();
    return;
  }
  const productTypeId = argValue("productTypeId");
  let blueprintId = argValue("blueprintId") ? Number(argValue("blueprintId")) : undefined;
  let providerId = argValue("providerId") ? Number(argValue("providerId")) : undefined;
  const variantIdOverride = argValue("variantId") ? Number(argValue("variantId")) : undefined;
  const maxColors = argValue("colors") ? Number(argValue("colors")) : 4;
  // Placement scale for the registration target. The mockup renderer CLAMPS
  // scale at 1.0 (see magentaPng note), and scale=1 + a vertically-overscanned
  // target already fills the whole print area via clip-to-boundary, so 1.0 is
  // the correct default. The flag is kept for experiments (e.g. --regScale 0.5
  // renders a half-width target); values >1 are clamped by Printify and warned.
  const regScale = argValue("regScale") ? Number(argValue("regScale")) : 1;
  const outArg = argValue("out");

  let token = process.env.PRINTIFY_API_TOKEN || "";
  let shopId: string | null = argValue("shopId") || null;
  let name = "product";
  let colors: ColorEntry[] = [];

  if (productTypeId) {
    const db = await resolveFromDb(Number(productTypeId));
    token = db.token;
    shopId = shopId || db.shopId;
    blueprintId = db.blueprintId;
    providerId = db.providerId;
    name = db.name;
    colors = db.colors;
  }
  if (!token) throw new Error("PRINTIFY_API_TOKEN missing");
  if (!blueprintId || !providerId) {
    throw new Error("Provide --productTypeId, or both --blueprintId and --providerId");
  }
  if (!shopId) {
    const shops = await pf<any[]>("/shops.json", token);
    shopId = String(shops?.[0]?.id);
    console.log(`[harvest] resolved shopId=${shopId} (${shops?.[0]?.title})`);
  }

  // Catalog: variants + per-position print-area pixel dims (front/back only).
  const variantsData = await pf<any>(`/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json`, token);
  const variants: any[] = variantsData.variants || [];
  if (variants.length === 0) throw new Error("no variants returned from catalog");

  const placeholderDims = new Map<string, { width: number; height: number }>();
  for (const ph of variants[0].placeholders || []) {
    if (WANTED_VIEWS.includes(String(ph.position) as ViewName)) {
      placeholderDims.set(ph.position, { width: ph.width, height: ph.height });
    }
  }
  const availableViews = WANTED_VIEWS.filter((v) => placeholderDims.has(v));
  if (availableViews.length === 0) {
    console.warn("[harvest] no front/back placeholders found; placeholders present:", (variants[0].placeholders || []).map((p: any) => p.position));
  }

  if (process.argv.includes("--inspect")) {
    console.log(`[inspect] ${name} blueprint=${blueprintId} provider=${providerId}`);
    console.log("[inspect] variant[0].placeholders (raw position/width/height):");
    for (const ph of variants[0].placeholders || []) {
      const orient = ph.width >= ph.height ? "landscape" : "portrait";
      console.log(`  - ${ph.position}: ${ph.width} x ${ph.height} px  (${orient}, ratio ${(ph.width / ph.height).toFixed(3)})`);
    }
    return;
  }

  if (process.argv.includes("--probe")) {
    const gridArg = argValue("grid");
    let cols = DEFAULT_PROBE_COLS, rows = DEFAULT_PROBE_ROWS;
    if (gridArg) {
      const m = gridArg.toLowerCase().match(/^(\d+)x(\d+)$/);
      if (m) { cols = Number(m[1]); rows = Number(m[2]); }
      else console.warn(`[probe] could not parse --grid "${gridArg}"; using ${cols}x${rows}`);
    }
    const t1 = argValue("t1") ? Number(argValue("t1")) : DEFAULT_PROBE_T1;
    const t2 = argValue("t2") ? Number(argValue("t2")) : DEFAULT_PROBE_T2;
    const minCoverage = argValue("minCoverage") ? Number(argValue("minCoverage")) : DEFAULT_PROBE_MIN_COVERAGE;

    // Gather ALL print positions (probe is not limited to front/back).
    const allPh = new Map<string, { width: number; height: number }>();
    for (const ph of variants[0].placeholders || []) allPh.set(String(ph.position), { width: ph.width, height: ph.height });
    if (allPh.size === 0) throw new Error("no print placeholder positions found for this product");

    const viewArg = argValue("view");
    const preference = viewArg ? [viewArg] : ["front", "back", "default"];
    const view = preference.find((v) => allPh.has(v)) || [...allPh.keys()][0];

    const variantId = variantIdOverride || variants[0].id;
    const probeOutDir = outArg || path.join(process.cwd(), "tmp", "flat-calibration", `${blueprintId}-${providerId}`);
    await runProbe({ token, shopId: shopId!, blueprintId, providerId, variantId, placeholder: allPh.get(view)!, view, cols, rows, t1, t2, minCoverage, outDir: probeOutDir, name });
    return;
  }

  if (colors.length === 0) {
    colors = await resolveColorsFromCatalog(token, blueprintId, providerId, variants);
  }
  if (colors.length === 0) {
    // Fallback: just use the first variant as a single "default" colour.
    colors = [{ id: "default", name: "default", variantId: variants[0].id }];
  }
  const limitedColors = colors.slice(0, Math.max(1, maxColors));

  const outDir = outArg || path.join(process.cwd(), "tmp", "flat-calibration", `${blueprintId}-${providerId}`);
  await fs.mkdir(outDir, { recursive: true });

  const createdProductIds: string[] = [];
  const summary: any = {
    name,
    blueprintId,
    providerId,
    shopId,
    views: availableViews,
    printAreaPixels: Object.fromEntries(placeholderDims),
    registration: {},
    colors: [],
    generatedAt: new Date().toISOString(),
  };

  const regAnalysis = new Map<ViewName, MagentaAnalysis>();
  try {
    const registrationVariantId = variantIdOverride || variants[0].id;

    // ── PASS 1: registration target → detect print-area rect + silhouette ─────
    console.log(`[harvest] Registration pass (variant ${registrationVariantId})...`);
    if (regScale > 1) {
      console.warn(`[harvest] NOTE: --regScale ${regScale} > 1 — Printify's mockup renderer clamps scale at 1.0, so this renders identically to scale=1. The target already fills the print area at scale=1.`);
    }
    const regPlaceholders: Placeholder[] = [];
    for (const view of availableViews) {
      const dims = placeholderDims.get(view)!;
      const buf = await magentaPng(dims.width, dims.height);
      const imageId = await uploadImage(token, `reg-${view}.png`, buf);
      regPlaceholders.push({ position: view, images: [{ id: imageId, x: 0.5, y: 0.5, scale: regScale, angle: 0 }] });
    }
    const reg = await createTempProduct(token, shopId!, blueprintId, providerId, registrationVariantId, regPlaceholders);
    createdProductIds.push(reg.productId);
    console.log(`[harvest] requested scale=${regScale}; Printify stored placement:`,
      JSON.stringify((reg.raw?.print_areas || []).flatMap((pa: any) => (pa.placeholders || []).map((p: any) => ({ position: p.position, images: (p.images || []).map((im: any) => ({ x: im.x, y: im.y, scale: im.scale, angle: im.angle })) })))));
    const regImages = await pollMockups(token, shopId!, reg.productId, reg.images);
    for (const view of availableViews) {
      const match = regImages.find((i) => i.label === view) || regImages.find((i) => i.label.includes(view));
      if (!match) {
        console.warn(`[harvest] no registration mockup found for view=${view}`);
        continue;
      }
      const buf = await downloadBuffer(match.url);
      const file = path.join(outDir, `registration-${view}.png`);
      await fs.writeFile(file, buf);
      const a = await analyzeMagenta(buf);
      regAnalysis.set(view, a);
      const maskFile = path.join(outDir, `mask-${view}.png`);
      if (a.found) await fs.writeFile(maskFile, await rawToPng(a.maskRaw, a.width, a.height));
      summary.registration[view] = {
        file: path.basename(file),
        maskFile: a.found ? path.basename(maskFile) : null,
        sourceUrl: match.url,
        rect: {
          found: a.found,
          mockup: { width: a.width, height: a.height },
          pixels: a.count,
          px: a.px,
          normalized: a.normalized,
        },
      };
      console.log(`[harvest]   ${view}: ${a.found ? `rect ${JSON.stringify(a.px)} of ${a.width}x${a.height}, silhouette ${a.count}px` : "NO magenta detected"}`);
    }

    // ── PASS 2: blank garment per colour ──────────────────────────────────────
    const transparentId = await uploadImage(token, "blank.png", await transparentPng());
    for (const color of limitedColors) {
      console.log(`[harvest] Blank pass: ${color.name} (variant ${color.variantId})...`);
      const placeholders: Placeholder[] = availableViews.map((view) => ({
        position: view,
        images: [{ id: transparentId, x: 0.5, y: 0.5, scale: 1, angle: 0 }],
      }));
      const blank = await createTempProduct(token, shopId!, blueprintId, providerId, color.variantId, placeholders);
      createdProductIds.push(blank.productId);
      const blankImages = await pollMockups(token, shopId!, blank.productId, blank.images);
      const colorOut: any = { id: color.id, name: color.name, hex: color.hex, variantId: color.variantId, views: {} };
      const safe = color.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      for (const view of availableViews) {
        const match = blankImages.find((i) => i.label === view) || blankImages.find((i) => i.label.includes(view));
        if (!match) continue;
        const buf = await downloadBuffer(match.url);
        const file = path.join(outDir, `blank-${safe}-${view}.png`);
        await fs.writeFile(file, buf);
        colorOut.views[view] = { file: path.basename(file), sourceUrl: match.url };

        // Eyeball aid: tint the EXACT printable silhouette (green) over the real
        // blank garment so you can see the print region + any occlusion (hood).
        const a = regAnalysis.get(view);
        if (a?.found) {
          const meta = await sharp(buf).metadata();
          let tintPng = await rawToPng(a.tintRaw, a.width, a.height);
          if (meta.width && meta.height && (meta.width !== a.width || meta.height !== a.height)) {
            tintPng = await sharp(tintPng).resize(meta.width, meta.height).png().toBuffer();
          }
          const overlay = await sharp(buf).composite([{ input: tintPng }]).png().toBuffer();
          const overlayFile = path.join(outDir, `overlay-${safe}-${view}.png`);
          await fs.writeFile(overlayFile, overlay);
          colorOut.views[view].overlayFile = path.basename(overlayFile);
        }
      }
      summary.colors.push(colorOut);
    }

    await fs.writeFile(path.join(outDir, "calibration.json"), JSON.stringify(summary, null, 2), "utf8");
    console.log(`\n[harvest] DONE. Wrote ${outDir}`);
    console.log(`[harvest] Eyeball: registration-<view>.png (raw print area), mask-<view>.png (silhouette used to clip the preview),`);
    console.log(`[harvest]          overlay-<color>-<view>.png (silhouette tinted over the real blank), calibration.json (coordinates).`);
  } finally {
    // Always clean up the temp products we created in the merchant's shop.
    for (const id of createdProductIds) {
      await deleteProduct(token, shopId!, id);
    }
    console.log(`[harvest] Cleaned up ${createdProductIds.length} temp product(s).`);
  }
}

main().catch((err) => {
  console.error("[harvest-flat-mockups] Failed:", err);
  process.exit(1);
});
