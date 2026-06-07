/**
 * Flat / mesh on-the-fly mockup calibration harvest (server runtime).
 *
 * Ports the validated logic from `scripts/harvest-flat-mockups.ts` into a
 * reusable module that runs at Printify import time (or on demand) and PERSISTS
 * its results to Supabase + `product_types` (the script only wrote to tmp/).
 *
 * Pipeline per product:
 *   0. PROBE each view with a magenta dot grid -> planarity tier
 *        flat   : planar surface            -> homography composite client-side
 *        mesh   : mildly curved (cap front) -> low-density mesh warp (nodes stored)
 *        reject : wrapped / 3D (mug, shoe)  -> keep Printify mockups (early return)
 *   1. REGISTRATION: full-bleed #FF00FF -> pixel-exact print-area mask + visible rect
 *   2. SHADING: full-bleed #808080 -> shading transfer map (gloss/AO), + tonal range
 *   3. BLANK: transparent print per color/model -> plain garment photos
 *   4. Upload assets to Supabase `flat-calibration` bucket; return a manifest.
 *
 * Side effects: creates + DELETES temporary Printify products (same pattern the
 * live mockup flow uses). Never leaves temp products behind.
 */
import sharp from "sharp";
import {
  uploadToFlatCalibrationBucket,
  ensureFlatCalibrationBucket,
  isSupabaseFlatCalibrationConfigured,
} from "./supabaseFlatCalibration";

const PRINTIFY_API_BASE = "https://api.printify.com/v1";
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 60_000;
const WANTED_VIEWS = ["front", "back"] as const;
type ViewName = (typeof WANTED_VIEWS)[number];

// Planarity thresholds (calibrated in scripts/harvest-flat-mockups.ts):
//   tee 0.00006 -> flat ; cap 0.01077 -> mesh ; tumbler coverage 0.33 -> reject
const PROBE_T1 = 0.006;
const PROBE_T2 = 0.03;
const PROBE_MIN_COVERAGE = 0.6;
const PROBE_COLS = 6;
const PROBE_ROWS = 8;
const PROBE_MAX_SRC_SIDE = 1600;
// scale=1 + vertical overscan fills the print area via clip-to-boundary
// (Printify clamps placement scale at 1.0 and ignores uploaded image px size).
const REG_VERTICAL_OVERSCAN = 1.12;
const DEFAULT_MAX_BLANK_COLORS = 8;

export type FlatTier = "flat" | "mesh" | "reject";
export type FlatCalibrationStatus = "ready" | "unsupported" | "failed";

export type MeshNode = { row: number; col: number; xn: number; yn: number; px: { x: number; y: number } };

export type FlatViewCalibration = {
  printFileDims: { width: number; height: number };
  /** Detected visible print silhouette bounding box, normalized to the mockup. */
  visibleRectNormalized: { x: number; y: number; width: number; height: number } | null;
  mockupDims: { width: number; height: number } | null;
  maskUrl: string | null;
  shadingUrl: string | null;
  /** "blank" = multiply the garment photo (apparel); "map" = use shading transfer (white cases). */
  shadingMode: "blank" | "map";
  /** Mesh control points (mesh tier only) in normalized-source -> mockup px. */
  meshNodes: MeshNode[] | null;
  meshGrid: { cols: number; rows: number } | null;
  planarityScore: number | null;
  coverage: number | null;
};

export type FlatCalibrationManifest = {
  productTypeId: number;
  name: string;
  blueprintId: number;
  providerId: number;
  tier: FlatTier;
  views: Partial<Record<ViewName, FlatViewCalibration>>;
  /** colorOrModelId -> { view -> blank photo url } */
  blanks: Record<string, Partial<Record<ViewName, string>>>;
  /** True if mask/shading were harvested from a single representative variant
   *  (apparel: geometry is color-independent). Phone-case per-model masks are a
   *  documented follow-up. */
  representativeGeometry: boolean;
  generatedAt: string;
};

export type HarvestResult = {
  tier: FlatTier;
  status: FlatCalibrationStatus;
  manifest: FlatCalibrationManifest;
  error?: string;
};

// ── Printify REST helpers (self-contained; mirrors the proven script) ─────────
async function pf<T = any>(pathname: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${PRINTIFY_API_BASE}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Printify ${res.status} on ${pathname}: ${text.slice(0, 300)}`);
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
type MockupImage = { url: string; label: string };

function extractCameraLabel(url: string): string {
  const m = url.match(/camera_label=([^&]+)/);
  if (!m) return "front";
  try {
    return decodeURIComponent(m[1].replace(/\+/g, " ")).toLowerCase().trim();
  } catch {
    return m[1].replace(/\+/g, " ").toLowerCase().trim();
  }
}
function extractImages(product: any): MockupImage[] {
  if (!product || !Array.isArray(product.images)) return [];
  return product.images
    .filter((i: any) => i && typeof i.src === "string" && i.src)
    .map((i: any) => ({ url: i.src, label: extractCameraLabel(i.src) }));
}

async function createTempProduct(
  token: string,
  shopId: string,
  blueprintId: number,
  providerId: number,
  variantId: number,
  placeholders: Placeholder[],
): Promise<{ productId: string; images: MockupImage[] }> {
  const body = {
    title: `__appai_calibration_${Date.now()}`,
    description: "temp calibration product (auto-deleted)",
    blueprint_id: blueprintId,
    print_provider_id: providerId,
    variants: [{ id: variantId, price: 100, is_enabled: true }],
    print_areas: [{ variant_ids: [variantId], placeholders }],
  };
  const product = await pf<any>(`/shops/${shopId}/products.json`, token, { method: "POST", body: JSON.stringify(body) });
  return { productId: String(product.id), images: extractImages(product) };
}

async function pollMockups(token: string, shopId: string, productId: string, initial: MockupImage[]): Promise<MockupImage[]> {
  if (initial.length > 0) return initial;
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const product = await pf<any>(`/shops/${shopId}/products/${productId}.json`, token);
    const imgs = extractImages(product);
    if (imgs.length > 0) return imgs;
  }
  return [];
}

async function deleteTempProduct(token: string, shopId: string, productId: string): Promise<void> {
  try {
    await fetch(`${PRINTIFY_API_BASE}/shops/${shopId}/products/${productId}.json`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    /* best-effort cleanup */
  }
}

async function downloadBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function pickView(images: MockupImage[], view: string): MockupImage | undefined {
  return images.find((i) => i.label === view) || images.find((i) => i.label.includes(view));
}

function randomSpeck(maxR = 200, maxG = 100, maxB = 50) {
  return {
    input: { create: { width: 8, height: 8, channels: 4 as const, background: { r: (Math.random() * maxR) | 0, g: (Math.random() * maxG) | 0, b: (Math.random() * maxB) | 0, alpha: 1 } } },
    left: 1,
    top: 1,
  };
}

// ── full-bleed solid targets (cache-busted) ───────────────────────────────────
async function solidPng(targetW: number, targetH: number, rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  const w = Math.max(1, Math.round(targetW));
  const h = Math.max(1, Math.round(targetH * REG_VERTICAL_OVERSCAN));
  return sharp({ create: { width: w, height: h, channels: 4, background: { ...rgb, alpha: 1 } } })
    .composite([randomSpeck()])
    .png()
    .toBuffer();
}
const magentaPng = (w: number, h: number) => solidPng(w, h, { r: 255, g: 0, b: 255 });
const grayPng = (w: number, h: number) => solidPng(w, h, { r: 128, g: 128, b: 128 });
async function transparentPng(): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
}

function isMagenta(r: number, g: number, b: number): boolean {
  return r > 170 && b > 170 && g < 95;
}

type MagentaAnalysis = {
  width: number;
  height: number;
  found: boolean;
  count: number;
  px: { x: number; y: number; width: number; height: number } | null;
  normalized: { x: number; y: number; width: number; height: number } | null;
  maskRaw: Buffer;
};

/** Detect the #FF00FF print region: bounding box + pixel-exact silhouette (captures occlusion). */
async function analyzeMagenta(buffer: Buffer): Promise<MagentaAnalysis> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const maskRaw = Buffer.alloc(width * height * 4, 0);
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      if (isMagenta(data[i], data[i + 1], data[i + 2])) {
        count++;
        const o = (y * width + x) * 4;
        maskRaw[o] = 255; maskRaw[o + 1] = 255; maskRaw[o + 2] = 255; maskRaw[o + 3] = 255;
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
      ? { x: +(px.x / width).toFixed(5), y: +(px.y / height).toFixed(5), width: +(px.width / width).toFixed(5), height: +(px.height / height).toFixed(5) }
      : null,
    maskRaw,
  };
}

function rawToPng(raw: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/**
 * Decide whether the blank garment carries enough tonal range to act as its own
 * multiply shading (apparel), or whether the gray-pass shading map is needed
 * (white/rigid cases). Measures luminance spread inside the mask region.
 */
async function shadingModeFromGray(grayMockup: Buffer, mask: MagentaAnalysis): Promise<"blank" | "map"> {
  if (!mask.found || !mask.px) return "blank";
  try {
    const { data, info } = await sharp(grayMockup).resize(mask.width, mask.height, { fit: "fill" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    let min = 255, max = 0, n = 0;
    for (let y = mask.px.y; y < mask.px.y + mask.px.height; y += 2) {
      for (let x = mask.px.x; x < mask.px.x + mask.px.width; x += 2) {
        const i = (y * info.width + x) * ch;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < min) min = lum;
        if (lum > max) max = lum;
        n++;
      }
    }
    if (n === 0) return "blank";
    // Wide spread on a gray print => the renderer scene bakes gloss/AO worth using.
    return max - min > 90 ? "map" : "blank";
  } catch {
    return "blank";
  }
}

// ── PROBE: planarity scoring (ported) ─────────────────────────────────────────
type GridNode = { row: number; col: number; xn: number; yn: number };
type Centroid = { x: number; y: number; count: number };

async function gridPng(srcW: number, srcH: number, cols: number, rows: number): Promise<{ buffer: Buffer; nodes: GridNode[]; width: number; height: number }> {
  const cellW = srcW / cols, cellH = srcH / rows;
  const dotPx = Math.max(6, Math.round(0.3 * Math.min(cellW, cellH)));
  const nodes: GridNode[] = [];
  const composites: sharp.OverlayOptions[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const xn = (c + 0.5) / cols, yn = (r + 0.5) / rows;
      nodes.push({ row: r, col: c, xn, yn });
      const left = Math.round(xn * srcW - dotPx / 2), top = Math.round(yn * srcH - dotPx / 2);
      composites.push({
        input: { create: { width: dotPx, height: dotPx, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } } },
        left: Math.max(0, Math.min(srcW - dotPx, left)),
        top: Math.max(0, Math.min(srcH - dotPx, top)),
      });
    }
  }
  composites.push({ input: { create: { width: 6, height: 6, channels: 4, background: { r: (Math.random() * 200) | 0, g: (Math.random() * 80) | 0, b: (Math.random() * 40) | 0, alpha: 1 } } }, left: 1, top: 1 });
  const buffer = await sharp({ create: { width: srcW, height: srcH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(composites).png().toBuffer();
  return { buffer, nodes, width: srcW, height: srcH };
}

async function detectDots(buffer: Buffer): Promise<{ centroids: Centroid[]; width: number; height: number }> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      if (isMagenta(data[i], data[i + 1], data[i + 2])) mask[y * width + x] = 1;
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
      const qx = q % width, qy = (q / width) | 0;
      sx += qx; sy += qy; cnt++;
      if (qx > 0) { const n = q - 1; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
      if (qx < width - 1) { const n = q + 1; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
      if (qy > 0) { const n = q - width; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
      if (qy < height - 1) { const n = q + width; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
    }
    comps.push({ x: sx / cnt, y: sy / cnt, count: cnt });
  }
  if (comps.length === 0) return { centroids: [], width, height };
  const sizes = comps.map((c) => c.count).sort((a, b) => a - b);
  const median = sizes[sizes.length >> 1];
  const minCount = Math.max(4, median * 0.2);
  return { centroids: comps.filter((c) => c.count >= minCount), width, height };
}

function kmeans1d(values: number[], k: number, iters = 60): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values), max = Math.max(...values);
  let centers = Array.from({ length: k }, (_, i) => min + ((i + 0.5) * (max - min)) / k);
  const assign = new Array(values.length).fill(0);
  for (let it = 0; it < iters; it++) {
    let changed = false;
    for (let i = 0; i < values.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const d = Math.abs(values[i] - centers[c]); if (d < bd) { bd = d; best = c; } }
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

function lineFitRms(pts: { x: number; y: number }[]): { rms: number } | null {
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
  const lMin = tr / 2 - disc;
  return { rms: Math.sqrt(Math.max(0, lMin)) };
}

type ProbeResult = { tier: FlatTier; bowScore: number; coverage: number; meshNodes: MeshNode[]; mockupDims: { width: number; height: number } };

/** Run one grid probe on a single view. Caller owns temp-product cleanup ids. */
async function probeView(
  token: string,
  shopId: string,
  blueprintId: number,
  providerId: number,
  variantId: number,
  placeholder: { width: number; height: number },
  view: string,
  createdProductIds: string[],
): Promise<ProbeResult> {
  const cols = PROBE_COLS, rows = PROBE_ROWS;
  const sf = Math.min(1, PROBE_MAX_SRC_SIDE / Math.max(placeholder.width, placeholder.height));
  const srcW = Math.max(cols * 12, Math.round(placeholder.width * sf));
  const srcH = Math.max(rows * 12, Math.round(placeholder.height * sf));
  const grid = await gridPng(srcW, srcH, cols, rows);
  const imageId = await uploadImage(token, `probe-${view}.png`, grid.buffer);
  const created = await createTempProduct(token, shopId, blueprintId, providerId, variantId, [{ position: view, images: [{ id: imageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }]);
  createdProductIds.push(created.productId);
  const images = await pollMockups(token, shopId, created.productId, created.images);
  const match = pickView(images, view) || images[0];
  if (!match) throw new Error(`probe: no mockup returned for ${view}`);
  const mockup = await downloadBuffer(match.url);
  const det = await detectDots(mockup);

  const rowIdx = kmeans1d(det.centroids.map((c) => c.y), rows);
  const colIdx = kmeans1d(det.centroids.map((c) => c.x), cols);
  const cellMap = new Map<string, { c: Centroid; row: number; col: number }>();
  for (let i = 0; i < det.centroids.length; i++) {
    const key = `${rowIdx[i]},${colIdx[i]}`;
    const prev = cellMap.get(key);
    if (!prev || det.centroids[i].count > prev.c.count) cellMap.set(key, { c: det.centroids[i], row: rowIdx[i], col: colIdx[i] });
  }
  const assigned = [...cellMap.values()];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const a of assigned) { if (a.c.x < minX) minX = a.c.x; if (a.c.y < minY) minY = a.c.y; if (a.c.x > maxX) maxX = a.c.x; if (a.c.y > maxY) maxY = a.c.y; }
  const extent = Math.hypot(maxX - minX, maxY - minY) || 1;

  const dirMean = (sel: "row" | "col", count: number) => {
    const vals: number[] = [];
    for (let g = 0; g < count; g++) {
      const members = assigned.filter((a) => a[sel] === g).map((m) => ({ x: m.c.x, y: m.c.y }));
      if (members.length < 3) continue;
      const fit = lineFitRms(members);
      if (fit) vals.push(fit.rms / extent);
    }
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  };
  const bowScore = Math.max(dirMean("row", rows), dirMean("col", cols));
  const coverage = assigned.length / (cols * rows);

  const meshNodes: MeshNode[] = grid.nodes
    .map((n) => {
      const c = cellMap.get(`${n.row},${n.col}`)?.c;
      return c ? { row: n.row, col: n.col, xn: +n.xn.toFixed(5), yn: +n.yn.toFixed(5), px: { x: +c.x.toFixed(2), y: +c.y.toFixed(2) } } : null;
    })
    .filter((n): n is MeshNode => n !== null);

  let tier: FlatTier;
  if (coverage < PROBE_MIN_COVERAGE) tier = "reject";
  else if (bowScore < PROBE_T1) tier = "flat";
  else if (bowScore < PROBE_T2) tier = "mesh";
  else tier = "reject";

  return { tier, bowScore: +bowScore.toFixed(5), coverage: +coverage.toFixed(3), meshNodes, mockupDims: { width: det.width, height: det.height } };
}

// ── catalog colour/model resolution (ported) ─────────────────────────────────
type ColorEntry = { id: string; name: string; hex?: string; variantId: number };

/**
 * Slugify a colour/model name to match the storefront's frameColor id scheme
 * (see the import variant-options handler: `colorName.toLowerCase().replace(/\s+/g,'_')`).
 * The manifest's `blanks` keys MUST use this scheme so the storefront placer can
 * look up the right blank photo by its `selectedFrameColor`; keying by Printify's
 * numeric colour value id would never match and every colour would show the same blank.
 */
function slugColorId(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, "_");
}

async function resolveColorsFromCatalog(token: string, blueprintId: number, providerId: number, variants: any[]): Promise<ColorEntry[]> {
  const blueprint = await pf<any>(`/catalog/blueprints/${blueprintId}.json`, token);
  const colorOption = (blueprint.options || []).find((o: any) => o.type === "color" || /colou?r/i.test(o.name || ""));
  const valueMeta = new Map<number, { name: string; hex?: string }>();
  if (colorOption) for (const v of colorOption.values || []) valueMeta.set(Number(v.id), { name: v.title || String(v.id), hex: Array.isArray(v.colors) ? v.colors[0] : undefined });
  const colorIdSet = new Set(valueMeta.keys());
  const byColor = new Map<number, ColorEntry>();
  for (const variant of variants) {
    const optVals: number[] = Array.isArray(variant.options) ? variant.options : Object.values(variant.options || {}).map(Number);
    const colorId = optVals.find((id) => colorIdSet.has(Number(id)));
    if (colorId == null || byColor.has(colorId)) continue;
    const meta = valueMeta.get(Number(colorId));
    const name = meta?.name || String(colorId);
    byColor.set(colorId, { id: slugColorId(name), name, hex: meta?.hex, variantId: variant.id });
  }
  return [...byColor.values()];
}

function parseJsonArray(raw: unknown): any[] {
  if (!raw) return [];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

function parseJsonRecord(raw: unknown): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, any>) : {};
}

/**
 * Resolve harvest colours from the persisted product type (frameColors +
 * variantMap). This mirrors the import path's slug ids and is far more reliable
 * than `resolveColorsFromCatalog`, which often returns [] for apparel blueprints
 * whose Printify option metadata doesn't expose a classic "color" dimension.
 */
export function buildHarvestColorsFromProductType(productType: {
  frameColors?: unknown;
  sizes?: unknown;
  variantMap?: unknown;
}): ColorEntry[] {
  const frameColors = parseJsonArray(productType.frameColors);
  const sizes = parseJsonArray(productType.sizes);
  const variantMap = parseJsonRecord(productType.variantMap);
  const colors: ColorEntry[] = [];

  for (const fc of frameColors) {
    if (!fc?.id) continue;
    let variantId: number | null = null;

    for (const size of sizes) {
      const key = `${size.id}:${fc.id}`;
      const entry = variantMap[key];
      if (entry?.printifyVariantId) {
        variantId = Number(entry.printifyVariantId);
        break;
      }
    }

    if (variantId == null) {
      for (const [key, entry] of Object.entries(variantMap)) {
        if (key.endsWith(`:${fc.id}`) && entry?.printifyVariantId) {
          variantId = Number(entry.printifyVariantId);
          break;
        }
      }
    }

    if (variantId == null && sizes.length > 0) {
      const key = `${sizes[0].id}:${fc.id}`;
      const entry = variantMap[key];
      if (entry?.printifyVariantId) variantId = Number(entry.printifyVariantId);
    }

    if (variantId != null) {
      colors.push({
        id: String(fc.id),
        name: fc.name || String(fc.id),
        hex: fc.hex,
        variantId,
      });
    }
  }

  return colors;
}

function manifestHasBlanks(manifest: FlatCalibrationManifest): boolean {
  return Object.values(manifest.blanks || {}).some(
    (perView) => !!(perView?.front || perView?.back),
  );
}

export type HarvestOptions = {
  productTypeId: number;
  name: string;
  blueprintId: number;
  providerId: number;
  token: string;
  shopId: string;
  /** Optional explicit color list (e.g. from product frameColors+variantMap). Falls back to catalog. */
  colors?: ColorEntry[];
  maxBlankColors?: number;
};

/**
 * Harvest flat/mesh calibration for one product and upload assets to Supabase.
 * Returns a manifest + tier; caller persists tier/status/manifest to product_types.
 * Throws only on unexpected failure (caller should catch and mark `failed`).
 */
export async function harvestFlatCalibration(opts: HarvestOptions): Promise<HarvestResult> {
  const { productTypeId, name, blueprintId, providerId, token, shopId } = opts;
  const maxBlankColors = opts.maxBlankColors ?? DEFAULT_MAX_BLANK_COLORS;

  const baseManifest: FlatCalibrationManifest = {
    productTypeId,
    name,
    blueprintId,
    providerId,
    tier: "reject",
    views: {},
    blanks: {},
    representativeGeometry: true,
    generatedAt: new Date().toISOString(),
  };

  if (!isSupabaseFlatCalibrationConfigured()) {
    return { tier: "reject", status: "failed", manifest: baseManifest, error: "Supabase flat-calibration bucket not configured" };
  }

  const variantsData = await pf<any>(`/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json`, token);
  const variants: any[] = variantsData.variants || [];
  if (variants.length === 0) return { tier: "reject", status: "failed", manifest: baseManifest, error: "no variants from catalog" };

  const placeholderDims = new Map<ViewName, { width: number; height: number }>();
  for (const ph of variants[0].placeholders || []) {
    if (WANTED_VIEWS.includes(String(ph.position) as ViewName)) placeholderDims.set(ph.position as ViewName, { width: ph.width, height: ph.height });
  }
  const availableViews = WANTED_VIEWS.filter((v) => placeholderDims.has(v));
  if (availableViews.length === 0) {
    return { tier: "reject", status: "unsupported", manifest: baseManifest, error: "no front/back print placeholders" };
  }

  const representativeVariantId = variants[0].id;
  const createdProductIds: string[] = [];

  try {
    await ensureFlatCalibrationBucket();

    // ── 0. PROBE each view -> per-view tier + mesh nodes ──────────────────────
    const probes: Partial<Record<ViewName, ProbeResult>> = {};
    for (const view of availableViews) {
      try {
        probes[view] = await probeView(token, shopId, blueprintId, providerId, representativeVariantId, placeholderDims.get(view)!, view, createdProductIds);
      } catch (e) {
        console.warn(`[flat-calibration] probe failed for ${name}/${view}:`, (e as Error).message);
      }
    }
    const tiers = Object.values(probes).map((p) => p!.tier);
    const productTier: FlatTier = tiers.includes("reject") || tiers.length === 0 ? "reject" : tiers.includes("mesh") ? "mesh" : "flat";
    baseManifest.tier = productTier;

    if (productTier === "reject") {
      // Curved/wrap/3D or undetectable -> keep Printify mockups. Skip the rest.
      return { tier: "reject", status: "unsupported", manifest: baseManifest };
    }

    // ── 1. REGISTRATION pass (all views, one temp product) -> masks ───────────
    const regPlaceholders: Placeholder[] = [];
    for (const view of availableViews) {
      const dims = placeholderDims.get(view)!;
      const id = await uploadImage(token, `reg-${view}.png`, await magentaPng(dims.width, dims.height));
      regPlaceholders.push({ position: view, images: [{ id, x: 0.5, y: 0.5, scale: 1, angle: 0 }] });
    }
    const reg = await createTempProduct(token, shopId, blueprintId, providerId, representativeVariantId, regPlaceholders);
    createdProductIds.push(reg.productId);
    const regImages = await pollMockups(token, shopId, reg.productId, reg.images);
    const maskByView: Partial<Record<ViewName, MagentaAnalysis>> = {};
    for (const view of availableViews) {
      const match = pickView(regImages, view);
      if (!match) continue;
      const buf = await downloadBuffer(match.url);
      const a = await analyzeMagenta(buf);
      maskByView[view] = a;
      let maskUrl: string | null = null;
      if (a.found) {
        const maskPng = await rawToPng(a.maskRaw, a.width, a.height);
        maskUrl = await uploadToFlatCalibrationBucket(`products/${productTypeId}/mask-${view}.png`, maskPng, "image/png");
      }
      baseManifest.views[view] = {
        printFileDims: placeholderDims.get(view)!,
        visibleRectNormalized: a.normalized,
        mockupDims: { width: a.width, height: a.height },
        maskUrl,
        shadingUrl: null,
        shadingMode: "blank",
        meshNodes: productTier === "mesh" ? probes[view]?.meshNodes ?? null : null,
        meshGrid: productTier === "mesh" && probes[view]?.meshNodes?.length ? { cols: PROBE_COLS, rows: PROBE_ROWS } : null,
        planarityScore: probes[view]?.bowScore ?? null,
        coverage: probes[view]?.coverage ?? null,
      };
    }

    // ── 2. SHADING pass (#808080) -> shading transfer + tonal-range decision ──
    const grayPlaceholders: Placeholder[] = [];
    for (const view of availableViews) {
      const dims = placeholderDims.get(view)!;
      const id = await uploadImage(token, `gray-${view}.png`, await grayPng(dims.width, dims.height));
      grayPlaceholders.push({ position: view, images: [{ id, x: 0.5, y: 0.5, scale: 1, angle: 0 }] });
    }
    const gray = await createTempProduct(token, shopId, blueprintId, providerId, representativeVariantId, grayPlaceholders);
    createdProductIds.push(gray.productId);
    const grayImages = await pollMockups(token, shopId, gray.productId, gray.images);
    for (const view of availableViews) {
      const vc = baseManifest.views[view];
      const match = pickView(grayImages, view);
      if (!vc || !match) continue;
      const buf = await downloadBuffer(match.url);
      const mask = maskByView[view];
      vc.shadingUrl = await uploadToFlatCalibrationBucket(`products/${productTypeId}/shading-${view}.png`, buf, "image/jpeg");
      vc.shadingMode = mask ? await shadingModeFromGray(buf, mask) : "blank";
    }

    // ── 3. BLANK pass per color/model -> plain garment photos ─────────────────
    let colors =
      opts.colors && opts.colors.length > 0
        ? opts.colors
        : await resolveColorsFromCatalog(token, blueprintId, providerId, variants);
    if (colors.length === 0) {
      console.warn(
        `[flat-calibration] ${name} (pt ${productTypeId}): catalog colour resolution returned 0 — blank harvest skipped`,
      );
    }
    colors = colors.slice(0, Math.max(1, maxBlankColors));
    const transparentId = await uploadImage(token, "blank.png", await transparentPng());
    for (const color of colors) {
      const placeholders: Placeholder[] = availableViews.map((view) => ({ position: view, images: [{ id: transparentId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }));
      const blank = await createTempProduct(token, shopId, blueprintId, providerId, color.variantId, placeholders);
      createdProductIds.push(blank.productId);
      const blankImages = await pollMockups(token, shopId, blank.productId, blank.images);
      const safe = color.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      const perView: Partial<Record<ViewName, string>> = {};
      for (const view of availableViews) {
        const match = pickView(blankImages, view);
        if (!match) continue;
        const buf = await downloadBuffer(match.url);
        perView[view] = await uploadToFlatCalibrationBucket(`products/${productTypeId}/blank-${safe}-${view}.jpg`, buf, "image/jpeg");
      }
      baseManifest.blanks[color.id] = perView;
    }

    if (!manifestHasBlanks(baseManifest)) {
      return {
        tier: productTier,
        status: "failed",
        manifest: baseManifest,
        error: "blank garment photos could not be harvested (no colours resolved or Printify mockups missing)",
      };
    }

    return { tier: productTier, status: "ready", manifest: baseManifest };
  } finally {
    for (const id of createdProductIds) await deleteTempProduct(token, shopId, id);
    console.log(`[flat-calibration] ${name} (pt ${productTypeId}): cleaned up ${createdProductIds.length} temp product(s).`);
  }
}
