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
import { normalizeApparelSizeId, resolveVariantFromMap, type VariantMap } from "@shared/variantMapResolve";
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
/** Harvest blanks for every resolved colour unless caller caps via maxBlankColors. */
const DEFAULT_MAX_BLANK_COLORS = 64;

export type FlatTier = "flat" | "mesh" | "reject";
export type FlatCalibrationStatus = "ready" | "unsupported" | "failed";

export type MeshNode = { row: number; col: number; xn: number; yn: number; px: { x: number; y: number } };

export type FlatViewCalibration = {
  printFileDims: { width: number; height: number };
  /** Visible back-face bbox (edge-wrap) or printable area (apparel), normalized. */
  visibleRectNormalized: { x: number; y: number; width: number; height: number } | null;
  /** Full print silhouette bbox from the mask pass — outer edge-wrap guide. */
  printBoundsNormalized?: { x: number; y: number; width: number; height: number } | null;
  /** Back-face only — excludes perspective side strip on phone mockups (preview crop). */
  backFaceCropNormalized?: { x: number; y: number; width: number; height: number } | null;
  /** Phone back silhouette within print canvas (0–1, printFileDims space). */
  phoneBackNormalized?: { x: number; y: number; width: number; height: number } | null;
  /** Safe print zone within print canvas (0–1, printFileDims space). */
  safeZoneNormalized?: { x: number; y: number; width: number; height: number } | null;
  /** Side-profile blank/mask were pre-cropped at harvest (no runtime crop). */
  sideProfileCropped?: boolean;
  /** Original back-face crop on full Printify mockup (before mask pre-crop). */
  sideProfileSourceCropNormalized?: NormRect | null;
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
  /** Per-model geometry overrides (phone cases — camera cutout differs per model). */
  geometryByBlank?: Record<
    string,
    Partial<
      Record<
        ViewName,
        Pick<
          FlatViewCalibration,
          | "visibleRectNormalized"
          | "printBoundsNormalized"
          | "backFaceCropNormalized"
          | "phoneBackNormalized"
          | "safeZoneNormalized"
          | "sideProfileCropped"
          | "sideProfileSourceCropNormalized"
          | "sourceMockupDims"
          | "printFileDims"
          | "mockupDims"
          | "maskUrl"
          | "shadingUrl"
          | "shadingMode"
        >
      >
    >
  >;
  /** True if mask/shading were harvested from a single representative variant
   *  (apparel: geometry is color-independent). Phone-case per-model masks are a
   *  documented follow-up. */
  representativeGeometry: boolean;
  /** Phone cases / rigid edge-print products — guides + exact registration fill. */
  edgeWrap?: boolean;
  /** Framed posters / multi-size decor — blanks keyed by size:color with per-size print dims. */
  decorPerSize?: boolean;
  generatedAt: string;
};

export type HarvestResult = {
  tier: FlatTier;
  status: FlatCalibrationStatus;
  manifest: FlatCalibrationManifest;
  error?: string;
  /** Models/colors that failed per-blank geometry harvest — visible in Admin calibration log. */
  warnings?: string[];
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
async function solidPng(
  targetW: number,
  targetH: number,
  rgb: { r: number; g: number; b: number },
  opts?: { verticalOverscan?: boolean },
): Promise<Buffer> {
  const w = Math.max(1, Math.round(targetW));
  const overscan = opts?.verticalOverscan !== false;
  const h = Math.max(1, Math.round(overscan ? targetH * REG_VERTICAL_OVERSCAN : targetH));
  return sharp({ create: { width: w, height: h, channels: 4, background: { ...rgb, alpha: 1 } } })
    .composite([randomSpeck()])
    .png()
    .toBuffer();
}
const registrationPng = (w: number, h: number, rgb: { r: number; g: number; b: number }, edgeWrap: boolean) =>
  solidPng(w, h, rgb, { verticalOverscan: !edgeWrap });
const magentaPng = (w: number, h: number, edgeWrap = false) =>
  registrationPng(w, h, { r: 255, g: 0, b: 255 }, edgeWrap);
const grayPng = (w: number, h: number, edgeWrap = false) =>
  registrationPng(w, h, { r: 128, g: 128, b: 128 }, edgeWrap);
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

function placeholderDimsForVariant(variant: any): Map<ViewName, { width: number; height: number }> {
  const map = new Map<ViewName, { width: number; height: number }>();
  for (const ph of variant?.placeholders || []) {
    const pos = String(ph.position);
    if (WANTED_VIEWS.includes(pos as ViewName)) {
      map.set(pos as ViewName, { width: ph.width, height: ph.height });
    }
  }
  return map;
}

function blankKeyMatchesManifest(manifest: FlatCalibrationManifest, key: string): boolean {
  const entry = manifest.blanks?.[key];
  return !!(entry?.front || entry?.back);
}

function normalizeBlankKey(id: string): string {
  return id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

/** Resolve which harvested blank set to use (mirrors client flatBlankResolve). */
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
    if (blankKeyMatchesManifest(manifest, id)) return id;
    const norm = normalizeBlankKey(id);
    for (const k of Object.keys(manifest.blanks || {})) {
      if (normalizeBlankKey(k) === norm && blankKeyMatchesManifest(manifest, k)) return k;
    }
  }

  if (manifest.decorPerSize && opts.frameColorId) {
    const colorNorm = normalizeBlankKey(opts.frameColorId);
    for (const k of Object.keys(manifest.blanks || {})) {
      if (!blankKeyMatchesManifest(manifest, k)) continue;
      const kn = normalizeBlankKey(k);
      if (kn === colorNorm || kn.endsWith(`:${colorNorm}`)) return k;
    }
  }

  if (manifest.edgeWrap && opts.sizeId) {
    const sizeNorm = normalizeBlankKey(opts.sizeId);
    for (const k of Object.keys(manifest.blanks || {})) {
      if (!blankKeyMatchesManifest(manifest, k)) continue;
      if (normalizeBlankKey(k) === sizeNorm) return k;
    }
  }

  const fallback =
    opts.sizeId && opts.frameColorId
      ? `${opts.sizeId}:${opts.frameColorId}`
      : opts.frameColorId || opts.sizeId || "";
  for (const k of Object.keys(manifest.blanks || {})) {
    if (normalizeBlankKey(k) === normalizeBlankKey(fallback) && blankKeyMatchesManifest(manifest, k)) {
      return k;
    }
  }
  for (const k of Object.keys(manifest.blanks || {})) {
    if (blankKeyMatchesManifest(manifest, k)) return k;
  }
  return fallback;
}

/** Per-size print canvas dims for order-time bake (falls back to shared view dims). */
export function resolveFlatPrintFileDims(
  manifest: FlatCalibrationManifest,
  view: ViewName,
  opts: { sizeId?: string; frameColorId?: string },
): { width: number; height: number } | null {
  const blankKey = resolveFlatBlankColorId(manifest, opts);
  const override = manifest.geometryByBlank?.[blankKey]?.[view]?.printFileDims;
  const base = manifest.views[view]?.printFileDims;
  const dims = override ?? base;
  if (!dims?.width || !dims.height) return null;
  return { width: dims.width, height: dims.height };
}

/** Placement anchor for print-file bake — matches client preview semantics. */
export function resolveFlatBakePlacementRect(
  manifest: FlatCalibrationManifest,
  view: ViewName,
  opts: { sizeId?: string; frameColorId?: string },
): Rect | null {
  const dims = resolveFlatPrintFileDims(manifest, view, opts);
  if (!dims) return null;
  const { width: printW, height: printH } = dims;

  if (manifest.edgeWrap) {
    return { x: 0, y: 0, width: printW, height: printH };
  }

  if (manifest.decorPerSize) {
    const blankKey = resolveFlatBlankColorId(manifest, opts);
    const base = manifest.views[view];
    const override = manifest.geometryByBlank?.[blankKey]?.[view];
    const nr = override?.visibleRectNormalized ?? base?.visibleRectNormalized;
    if (nr) {
      return {
        x: nr.x * printW,
        y: nr.y * printH,
        width: nr.width * printW,
        height: nr.height * printH,
      };
    }
  }

  return { x: 0, y: 0, width: printW, height: printH };
}

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

export function looksLikePhoneModelName(name: string): boolean {
  const lower = (name || "").toLowerCase().trim();
  return (
    /^iphone[-\s](\d|x|xs|xr|se|pro|plus|max|air)/i.test(lower) ||
    /^galaxy[-\s](s\d|a\d|note|z\s*(fold|flip)|ultra)/i.test(lower) ||
    /^pixel[-\s](\d|fold|pro)/i.test(lower) ||
    /^samsung[-\s](galaxy|note)/i.test(lower) ||
    /^oneplus[-\s]\d/i.test(lower) ||
    /^for[-\s](iphone|galaxy|pixel|samsung)/i.test(lower)
  );
}

/** Detect phone-case / edge-print products for harvest + storefront guides. */
export function isEdgeWrapHarvestProduct(productName: string, colors?: ColorEntry[]): boolean {
  const lower = (productName || "").toLowerCase();
  if (
    /phone\s*case|tough\s*case|slim\s*case|snap\s*case|cell\s*case|iphone\s*case|galaxy\s*case|pixel\s*case|dye.?sub.*case|sublimation.*case/i.test(
      lower,
    )
  ) {
    return true;
  }
  if (colors?.some((c) => looksLikePhoneModelName(c.name || c.id))) return true;
  return false;
}

type NormRect = { x: number; y: number; width: number; height: number };

function pxRectToNormalized(
  px: { x: number; y: number; width: number; height: number },
  canvasW: number,
  canvasH: number,
): NormRect {
  return {
    x: +(px.x / canvasW).toFixed(5),
    y: +(px.y / canvasH).toFixed(5),
    width: +(px.width / canvasW).toFixed(5),
    height: +(px.height / canvasH).toFixed(5),
  };
}

function normalizedRectToPx(nr: NormRect, canvasW: number, canvasH: number): NormRect {
  return {
    x: Math.round(nr.x * canvasW),
    y: Math.round(nr.y * canvasH),
    width: Math.max(1, Math.round(nr.width * canvasW)),
    height: Math.max(1, Math.round(nr.height * canvasH)),
  };
}

/** Crop an RGBA raw buffer in-place dimensions. */
function cropRawRgba(
  raw: Buffer,
  srcW: number,
  srcH: number,
  crop: { x: number; y: number; width: number; height: number },
): { raw: Buffer; width: number; height: number } {
  const w = Math.max(1, Math.round(crop.width));
  const h = Math.max(1, Math.round(crop.height));
  const left = Math.max(0, Math.round(crop.x));
  const top = Math.max(0, Math.round(crop.y));
  const out = Buffer.alloc(w * h * 4, 0);
  for (let y = 0; y < h; y++) {
    const sy = top + y;
    if (sy >= srcH) break;
    for (let x = 0; x < w; x++) {
      const sx = left + x;
      if (sx >= srcW) continue;
      const si = (sy * srcW + sx) * 4;
      const oi = (y * w + x) * 4;
      out[oi] = raw[si];
      out[oi + 1] = raw[si + 1];
      out[oi + 2] = raw[si + 2];
      out[oi + 3] = raw[si + 3];
    }
  }
  return { raw: out, width: w, height: h };
}

async function cropImageBuffer(
  buffer: Buffer,
  crop: { x: number; y: number; width: number; height: number },
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const w = Math.max(1, Math.round(crop.width));
  const h = Math.max(1, Math.round(crop.height));
  const left = Math.max(0, Math.round(crop.x));
  const top = Math.max(0, Math.round(crop.y));
  const cropped = await sharp(buffer).extract({ left, top, width: w, height: h }).toBuffer();
  const meta = await sharp(cropped).metadata();
  return { buffer: cropped, width: meta.width ?? w, height: meta.height ?? h };
}

/** Center-fit content aspect inside print-canvas aspect (Printify grey box). */
function fitAspectCenteredInCanvas(contentAspect: number, canvasAspect: number): NormRect {
  let w: number;
  let h: number;
  if (contentAspect >= canvasAspect) {
    w = 1;
    h = canvasAspect / contentAspect;
  } else {
    h = 1;
    w = contentAspect / canvasAspect;
  }
  return {
    x: +((1 - w) / 2).toFixed(5),
    y: +((1 - h) / 2).toFixed(5),
    width: +w.toFixed(5),
    height: +h.toFixed(5),
  };
}

/**
 * Printify bleed model: print file = phone back + EQUAL margin on all 4 sides.
 * Unique solution of  w + 2m = W,  h + 2m = H,  w/h = aspect.
 * Returns null when unsolvable (caller falls back to aspect-fit).
 */
function fitEqualMarginInCanvasNorm(
  contentAspect: number,
  canvasW: number,
  canvasH: number,
): NormRect | null {
  if (!(contentAspect > 0) || canvasW <= 0 || canvasH <= 0) return null;
  if (Math.abs(1 - contentAspect) < 1e-4) return null;
  const h = (canvasH - canvasW) / (1 - contentAspect);
  const w = contentAspect * h;
  if (!(w > 0) || !(h > 0) || w > canvasW + 0.5 || h > canvasH + 0.5) return null;
  const m = (canvasW - w) / 2;
  if (m < 0 || w < canvasW * 0.5 || h < canvasH * 0.5) return null;
  return {
    x: +(m / canvasW).toFixed(5),
    y: +((canvasH - h) / 2 / canvasH).toFixed(5),
    width: +(w / canvasW).toFixed(5),
    height: +(h / canvasH).toFixed(5),
  };
}

/**
 * Map harvested back-face geometry into print-canvas normalized coords.
 * Print canvas = Printify grey box (printFileDims). Phone back sits with an
 * equal bleed margin on all 4 sides; safe zone maps from the harvested inset.
 */
export function computePrintCanvasGeometry(
  derived: { safeZone: NormRect; backFaceCrop: NormRect },
  printFileDims: { width: number; height: number },
  croppedMockupW: number,
  croppedMockupH: number,
): { phoneBackNormalized: NormRect; safeZoneNormalized: NormRect } {
  const { safeZone: safe, backFaceCrop: back } = derived;
  const contentAspect = croppedMockupW / Math.max(croppedMockupH, 1);
  const canvasAspect = printFileDims.width / Math.max(printFileDims.height, 1);
  const phoneBackNormalized =
    fitEqualMarginInCanvasNorm(contentAspect, printFileDims.width, printFileDims.height) ??
    fitAspectCenteredInCanvas(contentAspect, canvasAspect);

  const relSafeX = (safe.x - back.x) / Math.max(back.width, 1e-6);
  const relSafeY = (safe.y - back.y) / Math.max(back.height, 1e-6);
  const relSafeW = safe.width / Math.max(back.width, 1e-6);
  const relSafeH = safe.height / Math.max(back.height, 1e-6);

  const safeZoneNormalized: NormRect = {
    x: +(phoneBackNormalized.x + relSafeX * phoneBackNormalized.width).toFixed(5),
    y: +(phoneBackNormalized.y + relSafeY * phoneBackNormalized.height).toFixed(5),
    width: +(relSafeW * phoneBackNormalized.width).toFixed(5),
    height: +(relSafeH * phoneBackNormalized.height).toFixed(5),
  };

  return { phoneBackNormalized, safeZoneNormalized };
}

function sideProfileStripDetected(derived: { printBounds: NormRect; backFaceCrop: NormRect }): boolean {
  return derived.backFaceCrop.width < derived.printBounds.width * 0.97;
}

/** Crop rect on full-size Printify mockup when side strip was removed at harvest. */
function sideProfileCropPx(
  geo: {
    sideProfileCropped?: boolean;
    sideProfileSourceCropNormalized?: NormRect | null;
    backFaceCropNormalized?: NormRect | null;
    mockupDims?: { width: number; height: number } | null;
  } | null | undefined,
  origW: number,
  origH: number,
): { x: number; y: number; width: number; height: number } | null {
  if (!geo?.sideProfileCropped || origW <= 0 || origH <= 0) return null;
  const src = geo.sideProfileSourceCropNormalized;
  if (src && src.width > 0 && src.width < 0.98) {
    return normalizedRectToPx(src, origW, origH);
  }
  const bf = geo.backFaceCropNormalized;
  if (bf && bf.width > 0 && bf.width < 0.98) {
    return normalizedRectToPx(bf, origW, origH);
  }
  if (geo.mockupDims?.width && geo.mockupDims?.height) {
    return { x: 0, y: 0, width: geo.mockupDims.width, height: geo.mockupDims.height };
  }
  return null;
}

type EdgeWrapViewGeometry = {
  visibleRectNormalized: NormRect | null;
  printBoundsNormalized: NormRect | null;
  backFaceCropNormalized: NormRect | null;
  sideProfileSourceCropNormalized: NormRect | null;
  phoneBackNormalized: NormRect | null;
  safeZoneNormalized: NormRect | null;
  sideProfileCropped: boolean;
  mockupW: number;
  mockupH: number;
  maskRaw: Buffer;
};

/** Edge-wrap geometry + optional side-profile crop of mask raw buffer. */
function edgeWrapViewGeometryFromMask(
  maskRaw: Buffer,
  width: number,
  height: number,
  printFileDims?: { width: number; height: number },
): EdgeWrapViewGeometry | null {
  const derived = analyzeEdgeWrapGeometryFromMask(maskRaw, width, height);
  if (!derived) return null;

  let outRaw = maskRaw;
  let outW = width;
  let outH = height;
  let sideProfileCropped = false;

  if (sideProfileStripDetected(derived)) {
    const cropPx = normalizedRectToPx(derived.backFaceCrop, width, height);
    const cropped = cropRawRgba(maskRaw, width, height, cropPx);
    outRaw = cropped.raw;
    outW = cropped.width;
    outH = cropped.height;
    sideProfileCropped = true;
  }

  const canvasGeo = computePrintCanvasGeometry(
    derived,
    printFileDims ?? { width: outW, height: outH },
    outW,
    outH,
  );

  let visibleRectNormalized = derived.safeZone;
  let printBoundsNormalized = derived.printBounds;
  let backFaceCropNormalized = derived.backFaceCrop;
  let sideProfileSourceCropNormalized: NormRect | null = null;

  if (sideProfileCropped) {
    sideProfileSourceCropNormalized = derived.backFaceCrop;
    const cropPx = normalizedRectToPx(derived.backFaceCrop, width, height);
    const safePx = normalizedRectToPx(derived.safeZone, width, height);
    visibleRectNormalized = pxRectToNormalized(
      {
        x: safePx.x - cropPx.x,
        y: safePx.y - cropPx.y,
        width: safePx.width,
        height: safePx.height,
      },
      outW,
      outH,
    );
    backFaceCropNormalized = { x: 0, y: 0, width: 1, height: 1 };
    printBoundsNormalized = { x: 0, y: 0, width: 1, height: 1 };
  }

  return {
    visibleRectNormalized,
    printBoundsNormalized,
    backFaceCropNormalized,
    sideProfileSourceCropNormalized,
    phoneBackNormalized: canvasGeo.phoneBackNormalized,
    safeZoneNormalized: canvasGeo.safeZoneNormalized,
    sideProfileCropped,
    mockupW: outW,
    mockupH: outH,
    maskRaw: outRaw,
  };
}

/**
 * Derive full-print bounds + safe back-face zone from a registration mask.
 * Handles flat back-only unwraps and back+side composite mockups (side strip on
 * the right of the unwrap is excluded from the safe zone but included in print bounds).
 */
export function analyzeEdgeWrapGeometryFromMask(
  maskRaw: Buffer,
  width: number,
  height: number,
  safeInsetFraction = 0.04,
): { printBounds: NormRect; safeZone: NormRect; backFaceCrop: NormRect } | null {
  if (!maskRaw || width <= 0 || height <= 0) return null;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (maskRaw[(y * width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return null;

  const bbox = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };

  const rowLeft: number[] = [];
  const rowRight: number[] = [];
  const rowY: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    let lx = -1;
    let rx = -1;
    for (let x = minX; x <= maxX; x++) {
      if (maskRaw[(y * width + x) * 4 + 3] > 10) {
        if (lx < 0) lx = x;
        rx = x;
      }
    }
    if (lx >= 0) {
      rowLeft.push(lx);
      rowRight.push(rx);
      rowY.push(y);
    }
  }
  if (rowLeft.length === 0) return null;

  let maxRowWidth = 0;
  for (let i = 0; i < rowLeft.length; i++) {
    maxRowWidth = Math.max(maxRowWidth, rowRight[i] - rowLeft[i] + 1);
  }

  let backPanel = bbox;
  {
    const bw = bbox.width;
    const colFill = new Float32Array(bw);
    for (let y = bbox.y; y < bbox.y + bbox.height; y++) {
      for (let x = bbox.x; x < bbox.x + bw; x++) {
        if (maskRaw[((y * width + x) * 4 + 3)] > 10) colFill[x - bbox.x]++;
      }
    }
    const maxFill = Math.max(...colFill, 1);
    const scanStart = Math.floor(bw * 0.55);
    let splitCol: number | null = null;
    let minVal = Infinity;
    for (let i = scanStart; i < bw - 2; i++) {
      const v = colFill[i];
      if (v < minVal) {
        minVal = v;
        splitCol = i;
      }
    }
    let backWidth = bw;
    if (splitCol !== null && splitCol > scanStart) {
      let before = 0;
      let after = 0;
      for (let i = 0; i < splitCol; i++) before += colFill[i];
      for (let i = splitCol; i < bw; i++) after += colFill[i];
      if (after >= maxFill * 2 && before > after * 1.15 && splitCol < Math.floor(bw * 0.93)) {
        backWidth = splitCol;
      }
    }
    backPanel = {
      x: bbox.x,
      y: bbox.y,
      width: Math.max(1, backWidth),
      height: bbox.height,
    };
  }

  const inset = Math.max(2, Math.min(backPanel.width, backPanel.height) * safeInsetFraction);
  const safePanel = {
    x: backPanel.x + inset,
    y: backPanel.y + inset,
    width: Math.max(1, backPanel.width - 2 * inset),
    height: Math.max(1, backPanel.height - 2 * inset),
  };

  return {
    printBounds: pxRectToNormalized(bbox, width, height),
    safeZone: pxRectToNormalized(safePanel, width, height),
    backFaceCrop: pxRectToNormalized(backPanel, width, height),
  };
}

function geometryFromMagentaAnalysis(
  a: MagentaAnalysis,
  edgeWrap: boolean,
  printFileDims?: { width: number; height: number },
): {
  visibleRectNormalized: NormRect | null;
  printBoundsNormalized: NormRect | null;
  backFaceCropNormalized: NormRect | null;
  sideProfileSourceCropNormalized: NormRect | null;
  phoneBackNormalized: NormRect | null;
  safeZoneNormalized: NormRect | null;
  sideProfileCropped: boolean;
  maskRaw: Buffer;
  mockupW: number;
  mockupH: number;
  sourceMockupW: number;
  sourceMockupH: number;
} {
  if (!a.found || !a.normalized) {
    return {
      visibleRectNormalized: null,
      printBoundsNormalized: null,
      backFaceCropNormalized: null,
      sideProfileSourceCropNormalized: null,
      phoneBackNormalized: null,
      safeZoneNormalized: null,
      sideProfileCropped: false,
      maskRaw: a.maskRaw,
      mockupW: a.width,
      mockupH: a.height,
      sourceMockupW: a.width,
      sourceMockupH: a.height,
    };
  }
  if (!edgeWrap) {
    return {
      visibleRectNormalized: a.normalized,
      printBoundsNormalized: a.normalized,
      backFaceCropNormalized: null,
      sideProfileSourceCropNormalized: null,
      phoneBackNormalized: null,
      safeZoneNormalized: null,
      sideProfileCropped: false,
      maskRaw: a.maskRaw,
      mockupW: a.width,
      mockupH: a.height,
      sourceMockupW: a.width,
      sourceMockupH: a.height,
    };
  }
  const derived = edgeWrapViewGeometryFromMask(a.maskRaw, a.width, a.height, printFileDims);
  if (!derived) {
    return {
      visibleRectNormalized: a.normalized,
      printBoundsNormalized: a.normalized,
      backFaceCropNormalized: null,
      sideProfileSourceCropNormalized: null,
      phoneBackNormalized: null,
      safeZoneNormalized: null,
      sideProfileCropped: false,
      maskRaw: a.maskRaw,
      mockupW: a.width,
      mockupH: a.height,
      sourceMockupW: a.width,
      sourceMockupH: a.height,
    };
  }
  return {
    visibleRectNormalized: derived.visibleRectNormalized,
    printBoundsNormalized: derived.printBoundsNormalized,
    backFaceCropNormalized: derived.backFaceCropNormalized,
    sideProfileSourceCropNormalized: derived.sideProfileSourceCropNormalized,
    phoneBackNormalized: derived.phoneBackNormalized,
    safeZoneNormalized: derived.safeZoneNormalized,
    sideProfileCropped: derived.sideProfileCropped,
    maskRaw: derived.maskRaw,
    mockupW: derived.mockupW,
    mockupH: derived.mockupH,
    sourceMockupW: a.width,
    sourceMockupH: a.height,
  };
}

function variantIdForKey(variantMap: Record<string, any>, key: string): number | null {
  const entry = variantMap[key];
  return entry?.printifyVariantId ? Number(entry.printifyVariantId) : null;
}

function resolveVariantIdForHarvest(
  variantMap: Record<string, any>,
  sizeId: string,
  colorId: string,
  opts?: { allowSizeFallbackForColor?: boolean },
): number | null {
  const resolved = resolveVariantFromMap(variantMap as VariantMap, sizeId, colorId, {
    allowSizeFallbackForColor: opts?.allowSizeFallbackForColor ?? false,
  });
  const id = resolved?.entry.printifyVariantId;
  return id != null && id !== "" ? Number(id) : null;
}

/** Any Printify variant for this phone model (colour does not affect case blank). */
function resolveVariantIdForPhoneModel(
  variantMap: Record<string, any>,
  sizeId: string,
): number | null {
  const normSize = sizeId.toLowerCase().trim();
  for (const [key, entry] of Object.entries(variantMap)) {
    if (!entry?.printifyVariantId) continue;
    const [sz] = key.split(":");
    if (sz === normSize) return Number(entry.printifyVariantId);
  }
  return null;
}

const APPAREL_SIZE_IDS = new Set([
  "xxs", "xs", "s", "m", "l", "xl", "2xl", "3xl", "4xl", "5xl", "xxl", "xxxl",
  "small", "medium", "large", "extra_large",
]);

function isApparelSizeId(sizeId: string): boolean {
  const s = normalizeApparelSizeId(sizeId);
  return APPAREL_SIZE_IDS.has(s);
}

function isDimensionalDecorSize(sizeId: string, sizeName?: string): boolean {
  const combined = `${sizeId} ${sizeName || ""}`.toLowerCase();
  return /\d+\s*["']?\s*[xX×]\s*\d+/.test(combined) || /\d+\s*oz\b/.test(combined);
}

/**
 * Resolve harvest colours from the persisted product type (frameColors +
 * variantMap). This mirrors the import path's slug ids and is far more reliable
 * than `resolveColorsFromCatalog`, which often returns [] for apparel blueprints
 * whose Printify option metadata doesn't expose a classic "color" dimension.
 *
 * Phone cases store device models in `sizes` — harvest one blank per model id.
 */
function isApparelHarvestProduct(
  designerType: string | null | undefined,
  sizes: any[],
): boolean {
  if ((designerType || "").toLowerCase() === "apparel") return true;
  return (
    sizes.length > 0 &&
    sizes.every((s: any) => s?.id && isApparelSizeId(String(s.id)))
  );
}

export function buildHarvestColorsFromProductType(productType: {
  designerType?: string | null;
  frameColors?: unknown;
  sizes?: unknown;
  variantMap?: unknown;
}): ColorEntry[] {
  const frameColors = parseJsonArray(productType.frameColors);
  const sizes = parseJsonArray(productType.sizes);
  const variantMap = parseJsonRecord(productType.variantMap);
  const colors: ColorEntry[] = [];
  const seen = new Set<string>();

  const pushColor = (entry: ColorEntry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    colors.push(entry);
  };

  const phoneSizes = sizes.filter(
    (s: any) => s?.id && looksLikePhoneModelName(String(s.name || s.id)),
  );
  if (phoneSizes.length > 0) {
    const colorIds =
      frameColors.length > 0
        ? frameColors.map((fc: any) => String(fc.id))
        : ["default"];
    for (const size of phoneSizes) {
      const variantId = resolveVariantIdForPhoneModel(variantMap, String(size.id));
      if (variantId == null) continue;
      pushColor({
        id: String(size.id),
        name: size.name || String(size.id),
        hex: frameColors.find((fc: any) => colorIds.includes(String(fc.id)))?.hex,
        variantId,
      });
    }
    return colors;
  }

  // Framed / pillow decor only: harvest one blank + geometry per size × frame colour.
  // Apparel (S/M/L/XL sweaters, etc.) uses the colour-only path below — garment
  // colour is size-independent and size×colour harvest hits the 64-blank cap.
  const designerType = (productType.designerType || "").toLowerCase();
  const apparelProduct = isApparelHarvestProduct(productType.designerType, sizes);
  const decorBySizeAndColor =
    !apparelProduct &&
    (designerType === "framed-print" || designerType === "pillow") &&
    sizes.length > 1 &&
    frameColors.length > 0 &&
    sizes.some((s: any) => isDimensionalDecorSize(String(s.id), String(s.name || "")));

  if (decorBySizeAndColor) {
    for (const size of sizes) {
      for (const fc of frameColors) {
        const variantId = resolveVariantIdForHarvest(variantMap, String(size.id), String(fc.id));
        if (variantId == null) continue;
        pushColor({
          id: `${size.id}:${fc.id}`,
          name: `${size.name || size.id} / ${fc.name || fc.id}`,
          hex: fc.hex,
          variantId,
        });
      }
    }
    if (colors.length > 0) return colors;
  }

  for (const fc of frameColors) {
    if (!fc?.id) continue;
    let variantId: number | null = null;

    for (const size of sizes) {
      variantId = resolveVariantIdForHarvest(variantMap, String(size.id), String(fc.id), {
        allowSizeFallbackForColor: true,
      });
      if (variantId != null) break;
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
      variantId = resolveVariantIdForHarvest(variantMap, String(sizes[0].id), String(fc.id), {
        allowSizeFallbackForColor: true,
      });
    }

    if (variantId != null) {
      pushColor({
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

/** Per-blank registration mask + guides (phone models, framed size×colour, etc.). */
async function harvestPerBlankGeometry(args: {
  token: string;
  shopId: string;
  blueprintId: number;
  providerId: number;
  productTypeId: number;
  color: ColorEntry;
  safe: string;
  availableViews: ViewName[];
  variantPlaceholderDims: Map<ViewName, { width: number; height: number }>;
  sharedViewCalib: Partial<Record<ViewName, FlatViewCalibration>>;
  edgeWrap: boolean;
  createdProductIds: string[];
}): Promise<Partial<Record<ViewName, NonNullable<FlatCalibrationManifest["geometryByBlank"]>[string][ViewName]>> | null> {
  const {
    token,
    shopId,
    blueprintId,
    providerId,
    productTypeId,
    color,
    safe,
    availableViews,
    variantPlaceholderDims,
    sharedViewCalib,
    edgeWrap,
    createdProductIds,
  } = args;
  const geo: NonNullable<FlatCalibrationManifest["geometryByBlank"]>[string] = {};
  let any = false;

  for (const view of availableViews) {
    const vc = sharedViewCalib[view];
    const dims = variantPlaceholderDims.get(view);
    if (!vc || !dims) continue;
    try {
      const magId = await uploadImage(
        token,
        `reg-${safe}-${view}.png`,
        await magentaPng(dims.width, dims.height, edgeWrap),
      );
      const reg = await createTempProduct(token, shopId, blueprintId, providerId, color.variantId, [
        { position: view, images: [{ id: magId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] },
      ]);
      createdProductIds.push(reg.productId);
      const regImages = await pollMockups(token, shopId, reg.productId, reg.images);
      const regMatch = pickView(regImages, view);
      if (!regMatch) continue;
      const regBuf = await downloadBuffer(regMatch.url);
      const a = await analyzeMagenta(regBuf);
      const geoDerived = geometryFromMagentaAnalysis(a, edgeWrap, dims);
      let maskUrl: string | null = null;
      if (a.found) {
        maskUrl = await uploadToFlatCalibrationBucket(
          `products/${productTypeId}/mask-${safe}-${view}.png`,
          await rawToPng(geoDerived.maskRaw, geoDerived.mockupW, geoDerived.mockupH),
          "image/png",
        );
      }

      let shadingUrl: string | null = vc.shadingUrl;
      let shadingMode: "blank" | "map" = vc.shadingMode;
      try {
        const grayId = await uploadImage(
          token,
          `gray-${safe}-${view}.png`,
          await grayPng(dims.width, dims.height, edgeWrap),
        );
        const grayProd = await createTempProduct(token, shopId, blueprintId, providerId, color.variantId, [
          { position: view, images: [{ id: grayId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] },
        ]);
        createdProductIds.push(grayProd.productId);
        const grayImages = await pollMockups(token, shopId, grayProd.productId, grayProd.images);
        const grayMatch = pickView(grayImages, view);
        if (grayMatch) {
          let grayBuf = await downloadBuffer(grayMatch.url);
          const cropGeo = {
            sideProfileCropped: geoDerived.sideProfileCropped,
            sideProfileSourceCropNormalized: geoDerived.sideProfileSourceCropNormalized,
            backFaceCropNormalized: geoDerived.backFaceCropNormalized,
            mockupDims: { width: geoDerived.mockupW, height: geoDerived.mockupH },
          };
          const cropPx = sideProfileCropPx(cropGeo, geoDerived.sourceMockupW, geoDerived.sourceMockupH);
          if (cropPx) ({ buffer: grayBuf } = await cropImageBuffer(grayBuf, cropPx));
          shadingUrl = await uploadToFlatCalibrationBucket(
            `products/${productTypeId}/shading-${safe}-${view}.jpg`,
            grayBuf,
            "image/jpeg",
          );
          shadingMode = a.found ? await shadingModeFromGray(grayBuf, a) : "blank";
        }
      } catch (e) {
        console.warn(
          `[flat-calibration] per-blank shading failed for ${color.id}/${view}:`,
          (e as Error).message,
        );
      }

      geo[view] = {
        printBoundsNormalized: geoDerived.printBoundsNormalized,
        visibleRectNormalized: geoDerived.visibleRectNormalized,
        backFaceCropNormalized: geoDerived.backFaceCropNormalized,
        sideProfileSourceCropNormalized: geoDerived.sideProfileSourceCropNormalized,
        phoneBackNormalized: geoDerived.phoneBackNormalized,
        safeZoneNormalized: geoDerived.safeZoneNormalized,
        sideProfileCropped: geoDerived.sideProfileCropped,
        printFileDims: { width: dims.width, height: dims.height },
        mockupDims: { width: geoDerived.mockupW, height: geoDerived.mockupH },
        sourceMockupDims: { width: geoDerived.sourceMockupW, height: geoDerived.sourceMockupH },
        maskUrl,
        shadingUrl,
        shadingMode,
      };
      any = true;
    } catch (e) {
      console.warn(
        `[flat-calibration] per-blank geometry failed for ${color.id}/${view}:`,
        (e as Error).message,
      );
    }
  }
  return any ? geo : null;
}

function needsPerBlankGeometry(color: ColorEntry, edgeWrapProduct: boolean, decorPerSize: boolean): boolean {
  if (edgeWrapProduct && looksLikePhoneModelName(color.name || color.id)) return true;
  if (decorPerSize && color.id.includes(":")) return true;
  return false;
}

export type HarvestOptions = {
  productTypeId: number;
  name: string;
  blueprintId: number;
  providerId: number;
  token: string;
  shopId: string;
  designerType?: string | null;
  sizes?: unknown;
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
  const edgeWrapProduct = isEdgeWrapHarvestProduct(name, opts.colors);

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
    baseManifest.edgeWrap = edgeWrapProduct;

    if (productTier === "reject") {
      // Curved/wrap/3D or undetectable -> keep Printify mockups. Skip the rest.
      return { tier: "reject", status: "unsupported", manifest: baseManifest };
    }

    // ── 1. REGISTRATION pass (all views, one temp product) -> masks ───────────
    const regPlaceholders: Placeholder[] = [];
    for (const view of availableViews) {
      const dims = placeholderDims.get(view)!;
      const id = await uploadImage(token, `reg-${view}.png`, await magentaPng(dims.width, dims.height, edgeWrapProduct));
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
      const geo = geometryFromMagentaAnalysis(a, edgeWrapProduct, placeholderDims.get(view));
      let maskUrl: string | null = null;
      if (a.found) {
        const maskPng = await rawToPng(geo.maskRaw, geo.mockupW, geo.mockupH);
        maskUrl = await uploadToFlatCalibrationBucket(`products/${productTypeId}/mask-${view}.png`, maskPng, "image/png");
      }
      baseManifest.views[view] = {
        printFileDims: placeholderDims.get(view)!,
        visibleRectNormalized: geo.visibleRectNormalized,
        printBoundsNormalized: geo.printBoundsNormalized,
        backFaceCropNormalized: geo.backFaceCropNormalized,
        sideProfileSourceCropNormalized: geo.sideProfileSourceCropNormalized,
        phoneBackNormalized: geo.phoneBackNormalized,
        safeZoneNormalized: geo.safeZoneNormalized,
        sideProfileCropped: geo.sideProfileCropped,
        mockupDims: { width: geo.mockupW, height: geo.mockupH },
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
      const id = await uploadImage(token, `gray-${view}.png`, await grayPng(dims.width, dims.height, edgeWrapProduct));
      grayPlaceholders.push({ position: view, images: [{ id, x: 0.5, y: 0.5, scale: 1, angle: 0 }] });
    }
    const gray = await createTempProduct(token, shopId, blueprintId, providerId, representativeVariantId, grayPlaceholders);
    createdProductIds.push(gray.productId);
    const grayImages = await pollMockups(token, shopId, gray.productId, gray.images);
    for (const view of availableViews) {
      const vc = baseManifest.views[view];
      const match = pickView(grayImages, view);
      if (!vc || !match) continue;
      let buf = await downloadBuffer(match.url);
      const mask = maskByView[view];
      if (vc.sideProfileCropped && mask) {
        const cropPx = sideProfileCropPx(vc, mask.width, mask.height);
        if (cropPx) ({ buffer: buf } = await cropImageBuffer(buf, cropPx));
      }
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
    const harvestWarnings: string[] = [];
    const harvestSizes = parseJsonArray(opts.sizes);
    const apparelProduct = isApparelHarvestProduct(opts.designerType, harvestSizes);
    const decorPerSize =
      !edgeWrapProduct && !apparelProduct && colors.some((c) => c.id.includes(":"));
    baseManifest.decorPerSize = decorPerSize;
    if (apparelProduct && colors.some((c) => c.id.includes(":"))) {
      harvestWarnings.push(
        "apparel product had size:colour harvest keys — re-run will store colour-only blanks",
      );
    }
    const transparentId = await uploadImage(token, "blank.png", await transparentPng());
    for (const color of colors) {
      const placeholders: Placeholder[] = availableViews.map((view) => ({ position: view, images: [{ id: transparentId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }));
      const blank = await createTempProduct(token, shopId, blueprintId, providerId, color.variantId, placeholders);
      createdProductIds.push(blank.productId);
      const blankImages = await pollMockups(token, shopId, blank.productId, blank.images);
      const safe = color.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

      // Try to find the catalog variant by ID.  Note: color.variantId is a
      // PRODUCT variant ID (from the merchant's Printify product), while
      // `variants` contains CATALOG variant IDs — they are different number
      // spaces and will never match.  Fall back to placeholderDims (derived from
      // variants[0]) which is correct for per-model geometry: all phone-case
      // models share the same print-area dimensions within a blueprint.
      const variant = variants.find((v) => v.id === color.variantId);
      const variantDims = placeholderDimsForVariant(variant).size > 0
        ? placeholderDimsForVariant(variant)
        : placeholderDims;
      let perBlankGeo: Partial<Record<ViewName, NonNullable<FlatCalibrationManifest["geometryByBlank"]>[string][ViewName]>> | null = null;
      if (
        needsPerBlankGeometry(color, edgeWrapProduct, decorPerSize) &&
        variantDims.size > 0
      ) {
        perBlankGeo = await harvestPerBlankGeometry({
          token,
          shopId,
          blueprintId,
          providerId,
          productTypeId,
          color,
          safe,
          availableViews,
          variantPlaceholderDims: variantDims,
          sharedViewCalib: baseManifest.views,
          edgeWrap: edgeWrapProduct,
          createdProductIds,
        });
        if (perBlankGeo && Object.keys(perBlankGeo).length > 0) {
          if (!baseManifest.geometryByBlank) baseManifest.geometryByBlank = {};
          baseManifest.geometryByBlank[color.id] = perBlankGeo;
          baseManifest.representativeGeometry = false;
          // Warn about views that were expected but returned no mask
          for (const view of availableViews) {
            const g = perBlankGeo[view];
            if (g && !g.maskUrl) {
              harvestWarnings.push(`${color.id}/${view}: geometry harvested but no mask (magenta not detected)`);
            }
          }
        } else if (needsPerBlankGeometry(color, edgeWrapProduct, decorPerSize) && variantDims.size > 0) {
          harvestWarnings.push(`${color.id}: per-model geometry harvest returned nothing (all views failed)`);
        }
      }

      const perView: Partial<Record<ViewName, string>> = {};
      for (const view of availableViews) {
        const match = pickView(blankImages, view);
        if (!match) continue;
        let buf = await downloadBuffer(match.url);
        const geoView = perBlankGeo?.[view] ?? baseManifest.views[view];
        const maskMeta = maskByView[view];
        const origW =
          perBlankGeo?.[view]?.sourceMockupDims?.width ??
          maskMeta?.width ??
          geoView?.mockupDims?.width;
        const origH =
          perBlankGeo?.[view]?.sourceMockupDims?.height ??
          maskMeta?.height ??
          geoView?.mockupDims?.height;
        const perModelCropped = perBlankGeo?.[view]?.sideProfileCropped === true;
        const perModelMask = !!perBlankGeo?.[view]?.maskUrl;
        if (perModelCropped && perModelMask && geoView?.sideProfileCropped && origW && origH) {
          const cropPx = sideProfileCropPx(geoView, origW, origH);
          if (cropPx) ({ buffer: buf } = await cropImageBuffer(buf, cropPx));
        }
        perView[view] = await uploadToFlatCalibrationBucket(`products/${productTypeId}/blank-${safe}-${view}.jpg`, buf, "image/jpeg");
      }
      if (Object.keys(perView).length > 0) {
        baseManifest.blanks[color.id] = perView;
      }
    }

    if (!manifestHasBlanks(baseManifest)) {
      return {
        tier: productTier,
        status: "failed",
        manifest: baseManifest,
        error: "blank garment photos could not be harvested (no colours resolved or Printify mockups missing)",
        warnings: harvestWarnings,
      };
    }

    return {
      tier: productTier,
      status: "ready",
      manifest: baseManifest,
      warnings: harvestWarnings.length > 0 ? harvestWarnings : undefined,
    };
  } finally {
    for (const id of createdProductIds) await deleteTempProduct(token, shopId, id);
    console.log(`[flat-calibration] ${name} (pt ${productTypeId}): cleaned up ${createdProductIds.length} temp product(s).`);
  }
}
