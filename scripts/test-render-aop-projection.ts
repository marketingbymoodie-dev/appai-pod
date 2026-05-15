import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import type {
  AopPanelCurvature,
  AopProjectionMapJson,
  AopProjectionMeshCell,
  AopProjectionPanelMap,
  AopProjectionPoint,
  AopProjectionViewMap,
} from "../shared/aopProjectionMap";

const CALIBRATION_BUCKET = process.env.SUPABASE_AOP_CALIBRATION_BUCKET || "aop-calibration";
const DEFAULT_PRODUCT_TYPE_ID = 20;
const DEFAULT_MAP_DIR = path.join(process.cwd(), "tmp", "aop-projection-maps");
const OUTPUT_DIR = path.join(process.cwd(), "tmp", "aop-render-tests");
let relativeUrlBase: string | undefined;
let designStateArtwork: string | undefined;

type RawImage = {
  data: Buffer;
  width: number;
  height: number;
};

type ArtworkInput = {
  buffer: Buffer;
  raw: RawImage;
};

function argValue(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0) return process.argv[idx + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const loose = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return loose ? loose.slice(name.length + 1) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function printHelp() {
  console.log(`
Render a local test image using an AOP projection map.

Usage:
  npx tsx scripts/test-render-aop-projection.ts --artwork ./tmp/test-artwork.png --view front

Options:
  --artwork <path-or-url>  Required artwork image.
  --view <front|back>     View to render. Defaults to front.
  --productTypeId <id>    Projection map product type id. Defaults to 20.
  --map <path-or-url>     Explicit projection map JSON path or URL.
  --designState <path>     Design state or calibration export containing aopPrintPanelUrls/panelUrls.
                           URLs may be http(s), data URLs, file:// URLs, or local file paths
                           (relative to cwd or absolute).
  --baseUrl <url>          Base URL for relative /apps/appai/objects/... panel URLs.
  --useLatestPlacement     Load latest captured customer-flow panel placement from DATABASE_URL.
  --quality <mode>        draft, balanced, or production. Defaults to production.
  --help                  Show this help.

Map lookup order:
  1. --map when provided
  2. tmp/aop-projection-maps/projection-map-{productTypeId}.json
  3. Supabase public URL: ${CALIBRATION_BUCKET}/maps/{productTypeId}.json

Outputs:
  tmp/aop-render-tests/{view}.png
  tmp/aop-render-tests/{view}-debug.png
  tmp/aop-render-tests/render-{view}-debug.png
  tmp/aop-render-tests/seam-{view}-debug.png
  tmp/aop-render-tests/source-panels/{panel}.png
`);
}

async function readBuffer(pathOrUrl: string): Promise<Buffer> {
  if (/^data:/i.test(pathOrUrl)) {
    const match = pathOrUrl.match(/^data:[^,]*;base64,(.+)$/s);
    if (!match) throw new Error("Only base64 data URLs are supported.");
    return Buffer.from(match[1], "base64");
  }
  if (pathOrUrl.startsWith("file://")) {
    return fs.readFile(new URL(pathOrUrl));
  }
  if (/^https?:\/\//i.test(pathOrUrl)) {
    const response = await fetch(pathOrUrl);
    if (!response.ok) throw new Error(`Fetch failed ${response.status} for ${pathOrUrl}`);
    return Buffer.from(await response.arrayBuffer());
  }
  if (pathOrUrl.startsWith("/")) {
    // `/`-prefixed paths can be either:
    //   - server-relative URLs (e.g. /apps/appai/objects/..., /objects/..., /api/...)
    //   - absolute filesystem paths on Unix
    // Try filesystem first when the prefix doesn't look like a known server route.
    const looksLikeServerUrl = /^\/(apps|api|objects|cdn)\//.test(pathOrUrl);
    if (!looksLikeServerUrl) {
      try {
        return await fs.readFile(pathOrUrl);
      } catch (error: any) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      }
    }
    if (!relativeUrlBase) {
      throw new Error(`Relative URL "${pathOrUrl}" requires --baseUrl or a baseUrl field in --designState JSON.`);
    }
    const appPath = pathOrUrl.startsWith("/apps/appai/objects/")
      ? pathOrUrl.replace("/apps/appai", "")
      : pathOrUrl;
    return readBuffer(new URL(appPath, relativeUrlBase).toString());
  }
  return fs.readFile(path.resolve(process.cwd(), pathOrUrl));
}

async function loadRawImage(pathOrUrl: string, size?: { width: number; height: number }): Promise<RawImage> {
  const input = await readBuffer(pathOrUrl);
  let image = sharp(input).ensureAlpha();
  if (size) image = image.resize(size.width, size.height, { fit: "fill" });
  const metadata = await image.metadata();
  const width = size?.width || metadata.width || 1;
  const height = size?.height || metadata.height || 1;
  const data = await image.raw().toBuffer();
  return { data, width, height };
}

async function loadMap(productTypeId: number): Promise<AopProjectionMapJson> {
  const explicit = argValue("map");
  if (explicit) return JSON.parse((await readBuffer(explicit)).toString("utf8")) as AopProjectionMapJson;

  const localPath = path.join(DEFAULT_MAP_DIR, `projection-map-${productTypeId}.json`);
  try {
    return JSON.parse((await fs.readFile(localPath, "utf8"))) as AopProjectionMapJson;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(`Projection map not found at ${localPath}, and Supabase env vars are not configured.`);
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data } = supabase.storage.from(CALIBRATION_BUCKET).getPublicUrl(`maps/${productTypeId}.json`);
  return JSON.parse((await readBuffer(data.publicUrl)).toString("utf8")) as AopProjectionMapJson;
}

type PanelSourceEntry = {
  position?: string;
  panelKey?: string;
  panel_key?: string;
  key?: string;
  url?: string;
  dataUrl?: string;
  imageUrl?: string;
  calibrationImageUrl?: string;
  calibration_image_url?: string;
};

type PanelSourceMap = Map<string, string>;

function normalizePanelKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function addPanelEntry(sources: PanelSourceMap, entry: PanelSourceEntry) {
  const position = String(entry.position || entry.panelKey || entry.panel_key || entry.key || "");
  const source = String(entry.url || entry.dataUrl || entry.imageUrl || entry.calibrationImageUrl || entry.calibration_image_url || "");
  if (!position || !source) return;
  sources.set(position, source);
  sources.set(position.toLowerCase(), source);
  sources.set(normalizePanelKey(position), source);
}

function collectPanelSources(value: unknown, sources: PanelSourceMap = new Map(), depth = 0): PanelSourceMap {
  if (!value || depth > 8) return sources;
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === "object") {
        addPanelEntry(sources, item as PanelSourceEntry);
        collectPanelSources(item, sources, depth + 1);
      }
    }
    return sources;
  }
  if (typeof parsed !== "object") return sources;

  const obj = parsed as Record<string, unknown>;
  for (const key of ["aopPrintPanelUrls", "printPanelUrls", "panelUrls", "panels"]) {
    const candidate = parseMaybeJson(obj[key]);
    if (Array.isArray(candidate)) collectPanelSources(candidate, sources, depth + 1);
  }
  for (const key of ["designState", "printAreasPayload", "print_areas_payload", "printAreas", "run"]) {
    if (obj[key]) collectPanelSources(obj[key], sources, depth + 1);
  }
  return sources;
}

async function loadPanelSourcesFromDesignState(filePath: string): Promise<PanelSourceMap> {
  const json = JSON.parse((await readBuffer(filePath)).toString("utf8"));
  if (!relativeUrlBase && json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    const base = obj.baseUrl || obj.appBaseUrl || obj.origin;
    if (typeof base === "string" && /^https?:\/\//i.test(base)) relativeUrlBase = base;
  }
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    const state = (obj.designState && typeof obj.designState === "object" ? obj.designState : obj) as Record<string, unknown>;
    if (typeof state.aopPatternUrl === "string") designStateArtwork = state.aopPatternUrl;
  }
  return collectPanelSources(json);
}

function makePool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("--useLatestPlacement requires DATABASE_URL.");
  const isRailwayPublicProxy = connectionString.includes("rlwy.net");
  return new pg.Pool({
    connectionString,
    ssl: isRailwayPublicProxy ? { rejectUnauthorized: false } : false,
  });
}

async function loadLatestPlacementSources(productTypeId: number): Promise<PanelSourceMap> {
  const pool = makePool();
  try {
    const result = await pool.query(
      `SELECT id, print_areas_payload
       FROM aop_calibration_runs
       WHERE product_type_id = $1
         AND print_areas_payload IS NOT NULL
         AND status IN ('customer_flow_capture', 'completed')
       ORDER BY
         CASE WHEN status = 'customer_flow_capture' THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT 25`,
      [productTypeId],
    );
    for (const row of result.rows) {
      const sources = collectPanelSources(row.print_areas_payload);
      if (sources.size > 0) {
        console.error(`[test-render-aop-projection] Using latest placement capture ${row.id} (${sources.size} source keys).`);
        return sources;
      }
    }
    return new Map();
  } finally {
    await pool.end();
  }
}

function resolvePanelSource(panel: AopProjectionPanelMap, sources?: PanelSourceMap): string | undefined {
  if (!sources || sources.size === 0) return undefined;
  return sources.get(panel.panelKey) || sources.get(panel.panelKey.toLowerCase()) || sources.get(normalizePanelKey(panel.panelKey));
}

function cloneRaw(image: RawImage): RawImage {
  return {
    data: Buffer.from(image.data),
    width: image.width,
    height: image.height,
  };
}

function sampleNearest(image: RawImage, x: number, y: number): [number, number, number, number] {
  const sx = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const sy = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const idx = (sy * image.width + sx) * 4;
  return [image.data[idx], image.data[idx + 1], image.data[idx + 2], image.data[idx + 3]];
}

function qualitySettings(quality: string) {
  switch (quality) {
    case "draft":
      return { overlap: 0, shadowAlpha: 0.45, highlightAlpha: 0.35, qualityFactor: 1, seamPad: 0, seamFeather: 0 };
    case "balanced":
      return { overlap: 1.0, shadowAlpha: 0.55, highlightAlpha: 0.45, qualityFactor: 2, seamPad: 5, seamFeather: 8 };
    case "production":
    default:
      return { overlap: 1.6, shadowAlpha: 0.62, highlightAlpha: 0.5, qualityFactor: 4, seamPad: 10, seamFeather: 14 };
  }
}

function classifyPanelCurvatureFromKey(panelKey: string): AopPanelCurvature {
  const k = (panelKey || "").toLowerCase();
  if (
    k.includes("hood") ||
    k.includes("sleeve") ||
    k.includes("shoulder") ||
    k.includes("cuff") ||
    k.includes("armhole") ||
    k.includes("underarm")
  ) return "high";
  if (
    k.includes("pocket") ||
    k.includes("zipper") ||
    k.includes("waistband") ||
    k.includes("collar") ||
    k.includes("placket")
  ) return "medium";
  return "low";
}

function curvatureSubdivision(curvature: AopPanelCurvature): number {
  if (curvature === "high") return 3;
  if (curvature === "medium") return 2;
  return 1;
}

function panelSubdivisionFactor(panel: AopProjectionPanelMap, qualityFactor: number): number {
  const stored = typeof panel.subdivision === "number" && panel.subdivision > 0 ? panel.subdivision : null;
  const curvature = panel.curvature || classifyPanelCurvatureFromKey(panel.panelKey);
  const fromCurvature = stored ?? curvatureSubdivision(curvature);
  return Math.max(1, Math.min(6, Math.max(qualityFactor, fromCurvature)));
}

function bilerpQuad(corners: AopProjectionMeshCell["target"], u: number, v: number): AopProjectionPoint {
  const top = {
    x: corners.topLeft.x + (corners.topRight.x - corners.topLeft.x) * u,
    y: corners.topLeft.y + (corners.topRight.y - corners.topLeft.y) * u,
  };
  const bottom = {
    x: corners.bottomLeft.x + (corners.bottomRight.x - corners.bottomLeft.x) * u,
    y: corners.bottomLeft.y + (corners.bottomRight.y - corners.bottomLeft.y) * u,
  };
  return {
    x: top.x + (bottom.x - top.x) * v,
    y: top.y + (bottom.y - top.y) * v,
  };
}

function subdivideCell(cell: AopProjectionMeshCell, factor: number): AopProjectionMeshCell[] {
  if (factor <= 1) return [cell];
  const out: AopProjectionMeshCell[] = [];
  for (let j = 0; j < factor; j += 1) {
    for (let i = 0; i < factor; i += 1) {
      const u0 = i / factor;
      const u1 = (i + 1) / factor;
      const v0 = j / factor;
      const v1 = (j + 1) / factor;
      out.push({
        id: `${cell.id}_s${i}_${j}`,
        source: {
          topLeft: bilerpQuad(cell.source, u0, v0),
          topRight: bilerpQuad(cell.source, u1, v0),
          bottomRight: bilerpQuad(cell.source, u1, v1),
          bottomLeft: bilerpQuad(cell.source, u0, v1),
        },
        target: {
          topLeft: bilerpQuad(cell.target, u0, v0),
          topRight: bilerpQuad(cell.target, u1, v0),
          bottomRight: bilerpQuad(cell.target, u1, v1),
          bottomLeft: bilerpQuad(cell.target, u0, v1),
        },
      });
    }
  }
  return out;
}

function subdivideMesh(mesh: AopProjectionMeshCell[], factor: number): AopProjectionMeshCell[] {
  if (factor <= 1) return mesh;
  return mesh.flatMap((cell) => subdivideCell(cell, factor));
}

function sampleBilinear(image: RawImage, x: number, y: number): [number, number, number, number] {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
  const x1 = Math.max(0, Math.min(image.width - 1, x0 + 1));
  const y1 = Math.max(0, Math.min(image.height - 1, y0 + 1));
  const tx = x - x0;
  const ty = y - y0;
  const c00 = sampleNearest(image, x0, y0);
  const c10 = sampleNearest(image, x1, y0);
  const c01 = sampleNearest(image, x0, y1);
  const c11 = sampleNearest(image, x1, y1);
  return [0, 1, 2, 3].map((channel) => {
    const top = c00[channel] * (1 - tx) + c10[channel] * tx;
    const bottom = c01[channel] * (1 - tx) + c11[channel] * tx;
    return Math.round(top * (1 - ty) + bottom * ty);
  }) as [number, number, number, number];
}

function compositePixel(dst: RawImage, x: number, y: number, rgba: [number, number, number, number]) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= dst.width || iy >= dst.height) return;
  const idx = (iy * dst.width + ix) * 4;
  const alpha = rgba[3] / 255;
  const inv = 1 - alpha;
  dst.data[idx] = Math.round(rgba[0] * alpha + dst.data[idx] * inv);
  dst.data[idx + 1] = Math.round(rgba[1] * alpha + dst.data[idx + 1] * inv);
  dst.data[idx + 2] = Math.round(rgba[2] * alpha + dst.data[idx + 2] * inv);
  dst.data[idx + 3] = Math.min(255, Math.round(rgba[3] + dst.data[idx + 3] * inv));
}

type Quad = AopProjectionPanelMap["bounds"];

function pointInQuad(p: AopProjectionPoint, q: Quad): boolean {
  const pts = [q.topLeft, q.topRight, q.bottomRight, q.bottomLeft];
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

function distanceToQuadEdge(p: AopProjectionPoint, q: Quad): number {
  const pts = [q.topLeft, q.topRight, q.bottomRight, q.bottomLeft];
  let minDist = Infinity;
  for (let i = 0; i < 4; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    const dist = Math.hypot(p.x - cx, p.y - cy);
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

function panelDestinationFalloff(p: AopProjectionPoint, hull: Quad, featherPx: number): number {
  if (featherPx <= 0) return 1;
  const inside = pointInQuad(p, hull);
  const dist = distanceToQuadEdge(p, hull);
  if (inside) return 1;
  if (dist >= featherPx) return 0;
  const t = dist / featherPx;
  return 1 - t * t * (3 - 2 * t);
}

function multiplyLayer(dst: RawImage, layer: RawImage, alpha: number) {
  for (let i = 0; i < dst.data.length; i += 4) {
    const a = (layer.data[i + 3] / 255) * alpha;
    dst.data[i] = Math.round(dst.data[i] * (1 - a + (layer.data[i] / 255) * a));
    dst.data[i + 1] = Math.round(dst.data[i + 1] * (1 - a + (layer.data[i + 1] / 255) * a));
    dst.data[i + 2] = Math.round(dst.data[i + 2] * (1 - a + (layer.data[i + 2] / 255) * a));
  }
}

function screenLayer(dst: RawImage, layer: RawImage, alpha: number) {
  for (let i = 0; i < dst.data.length; i += 4) {
    const a = (layer.data[i + 3] / 255) * alpha;
    dst.data[i] = Math.round(dst.data[i] * (1 - a) + (255 - (255 - dst.data[i]) * (255 - layer.data[i]) / 255) * a);
    dst.data[i + 1] = Math.round(dst.data[i + 1] * (1 - a) + (255 - (255 - dst.data[i + 1]) * (255 - layer.data[i + 1]) / 255) * a);
    dst.data[i + 2] = Math.round(dst.data[i + 2] * (1 - a) + (255 - (255 - dst.data[i + 2]) * (255 - layer.data[i + 2]) / 255) * a);
  }
}

function applyDestinationMask(dst: RawImage, mask: RawImage) {
  for (let i = 0; i < dst.data.length; i += 4) {
    dst.data[i + 3] = Math.round(dst.data[i + 3] * (mask.data[i + 3] / 255));
  }
}

function barycentric(
  p: AopProjectionPoint,
  a: AopProjectionPoint,
  b: AopProjectionPoint,
  c: AopProjectionPoint,
): [number, number, number] | null {
  const denom = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (Math.abs(denom) < 0.00001) return null;
  const w1 = ((b.y - c.y) * (p.x - c.x) + (c.x - b.x) * (p.y - c.y)) / denom;
  const w2 = ((c.y - a.y) * (p.x - c.x) + (a.x - c.x) * (p.y - c.y)) / denom;
  const w3 = 1 - w1 - w2;
  return [w1, w2, w3];
}

type DrawOptions = {
  overlap?: number;
  sourceOffsetX?: number;
  sourceOffsetY?: number;
  panelHull?: Quad;
  featherPx?: number;
};

function drawTriangle(
  dst: RawImage,
  src: RawImage,
  source: [AopProjectionPoint, AopProjectionPoint, AopProjectionPoint],
  target: [AopProjectionPoint, AopProjectionPoint, AopProjectionPoint],
  options: DrawOptions = {},
) {
  const overlap = options.overlap || 0;
  const dx = options.sourceOffsetX || 0;
  const dy = options.sourceOffsetY || 0;
  const featherPx = options.featherPx || 0;
  const hull = options.panelHull;
  const adjustedSource: [AopProjectionPoint, AopProjectionPoint, AopProjectionPoint] = [
    { x: source[0].x + dx, y: source[0].y + dy },
    { x: source[1].x + dx, y: source[1].y + dy },
    { x: source[2].x + dx, y: source[2].y + dy },
  ];
  const centroid = {
    x: (target[0].x + target[1].x + target[2].x) / 3,
    y: (target[0].y + target[1].y + target[2].y) / 3,
  };
  const expanded = target.map((point) => {
    if (!overlap) return point;
    const ddx = point.x - centroid.x;
    const ddy = point.y - centroid.y;
    const len = Math.hypot(ddx, ddy) || 1;
    return { x: point.x + (ddx / len) * overlap, y: point.y + (ddy / len) * overlap };
  }) as [AopProjectionPoint, AopProjectionPoint, AopProjectionPoint];
  const minX = Math.floor(Math.min(expanded[0].x, expanded[1].x, expanded[2].x));
  const maxX = Math.ceil(Math.max(expanded[0].x, expanded[1].x, expanded[2].x));
  const minY = Math.floor(Math.min(expanded[0].y, expanded[1].y, expanded[2].y));
  const maxY = Math.ceil(Math.max(expanded[0].y, expanded[1].y, expanded[2].y));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const weights = barycentric({ x, y }, expanded[0], expanded[1], expanded[2]);
      if (!weights) continue;
      const [w1, w2, w3] = weights;
      if (w1 < -0.001 || w2 < -0.001 || w3 < -0.001) continue;
      const sx = adjustedSource[0].x * w1 + adjustedSource[1].x * w2 + adjustedSource[2].x * w3;
      const sy = adjustedSource[0].y * w1 + adjustedSource[1].y * w2 + adjustedSource[2].y * w3;
      const rgba = sampleBilinear(src, sx, sy);
      if (hull && featherPx > 0) {
        const falloff = panelDestinationFalloff({ x, y }, hull, featherPx);
        if (falloff <= 0) continue;
        if (falloff < 1) rgba[3] = Math.round(rgba[3] * falloff);
      }
      compositePixel(dst, x, y, rgba);
    }
  }
}

function drawMesh(dst: RawImage, src: RawImage, mesh: AopProjectionMeshCell[], options: DrawOptions = {}) {
  for (const cell of mesh) {
    const s = cell.source;
    const t = cell.target;
    drawTriangle(dst, src, [s.topLeft, s.topRight, s.bottomRight], [t.topLeft, t.topRight, t.bottomRight], options);
    drawTriangle(dst, src, [s.topLeft, s.bottomRight, s.bottomLeft], [t.topLeft, t.bottomRight, t.bottomLeft], options);
  }
}

type PanelSource = {
  image: RawImage;
  offsetX: number;
  offsetY: number;
  mode: "atlas" | "panel-source";
  sourceUrl?: string;
};

async function panelArtwork(artwork: ArtworkInput, panel: AopProjectionPanelMap, padPx: number): Promise<PanelSource> {
  const sw = Math.max(1, Math.round(panel.sourceWidth));
  const sh = Math.max(1, Math.round(panel.sourceHeight));
  const pad = Math.max(0, Math.round(panel.seamPaddingPx ?? padPx));
  const targetWidth = sw + pad * 2;
  const targetHeight = sh + pad * 2;
  const rect = panel.sourceRect;
  if (rect) {
    const unit = rect.unit || "pixels";
    const left = unit === "normalized" ? rect.x * artwork.raw.width : rect.x;
    const top = unit === "normalized" ? rect.y * artwork.raw.height : rect.y;
    const width = unit === "normalized" ? rect.width * artwork.raw.width : rect.width;
    const height = unit === "normalized" ? rect.height * artwork.raw.height : rect.height;
    const xScale = width / sw;
    const yScale = height / sh;
    const padArtX = pad * xScale;
    const padArtY = pad * yScale;
    const extractLeft = Math.max(0, Math.min(artwork.raw.width - 1, Math.round(left - padArtX)));
    const extractTop = Math.max(0, Math.min(artwork.raw.height - 1, Math.round(top - padArtY)));
    const extractWidth = Math.max(1, Math.min(artwork.raw.width - extractLeft, Math.round(width + padArtX * 2)));
    const extractHeight = Math.max(1, Math.min(artwork.raw.height - extractTop, Math.round(height + padArtY * 2)));
    const extracted = await sharp(artwork.buffer)
      .extract({
        left: extractLeft,
        top: extractTop,
        width: extractWidth,
        height: extractHeight,
      })
      .resize(targetWidth, targetHeight, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer();
    return {
      image: { data: extracted, width: targetWidth, height: targetHeight },
      offsetX: pad,
      offsetY: pad,
      mode: "atlas",
    };
  }
  const resized = await sharp(artwork.buffer)
    .resize(targetWidth, targetHeight, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return {
    image: { data: resized, width: targetWidth, height: targetHeight },
    offsetX: pad,
    offsetY: pad,
    mode: "atlas",
  };
}

async function panelSourceArtwork(sourceUrl: string, panel: AopProjectionPanelMap): Promise<PanelSource> {
  const sw = Math.max(1, Math.round(panel.sourceWidth));
  const sh = Math.max(1, Math.round(panel.sourceHeight));
  const buffer = await readBuffer(sourceUrl);
  const resized = await sharp(buffer)
    .resize(sw, sh, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return {
    image: { data: resized, width: sw, height: sh },
    offsetX: 0,
    offsetY: 0,
    mode: "panel-source",
    sourceUrl,
  };
}

function drawLine(image: RawImage, a: AopProjectionPoint, b: AopProjectionPoint, color: [number, number, number, number]) {
  const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    compositePixel(image, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, color);
  }
}

function drawCircle(image: RawImage, center: AopProjectionPoint, radius: number, color: [number, number, number, number]) {
  for (let y = -radius; y <= radius; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      if (x * x + y * y <= radius * radius) compositePixel(image, center.x + x, center.y + y, color);
    }
  }
}

function drawDebug(image: RawImage, view: AopProjectionViewMap) {
  for (const panel of view.panels) {
    const b = panel.bounds;
    drawLine(image, b.topLeft, b.topRight, [56, 189, 248, 230]);
    drawLine(image, b.topRight, b.bottomRight, [56, 189, 248, 230]);
    drawLine(image, b.bottomRight, b.bottomLeft, [56, 189, 248, 230]);
    drawLine(image, b.bottomLeft, b.topLeft, [56, 189, 248, 230]);
    for (const cell of panel.mesh) {
      const t = cell.target;
      drawLine(image, t.topLeft, t.topRight, [249, 115, 22, 90]);
      drawLine(image, t.topLeft, t.bottomLeft, [249, 115, 22, 90]);
    }
    for (const point of panel.points) drawCircle(image, point.target, 5, [34, 197, 94, 230]);
  }
}

function drawSeamDebug(image: RawImage, view: AopProjectionViewMap, featherPx: number) {
  const pad = Math.max(2, Math.ceil(featherPx) + 2);
  for (const panel of view.panels) {
    const b = panel.bounds;
    const xs = [b.topLeft.x, b.topRight.x, b.bottomRight.x, b.bottomLeft.x];
    const ys = [b.topLeft.y, b.topRight.y, b.bottomRight.y, b.bottomLeft.y];
    const minX = Math.max(0, Math.floor(Math.min(...xs) - pad));
    const maxX = Math.min(image.width - 1, Math.ceil(Math.max(...xs) + pad));
    const minY = Math.max(0, Math.floor(Math.min(...ys) - pad));
    const maxY = Math.min(image.height - 1, Math.ceil(Math.max(...ys) + pad));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dist = distanceToQuadEdge({ x, y }, b);
        if (dist > featherPx) continue;
        const inside = pointInQuad({ x, y }, b);
        if (inside) {
          compositePixel(image, x, y, [34, 197, 94, 60]);
        } else if (featherPx > 0) {
          const t = 1 - dist / featherPx;
          compositePixel(image, x, y, [251, 191, 36, Math.round(140 * t)]);
        }
      }
    }
    drawLine(image, b.topLeft, b.topRight, [239, 68, 68, 255]);
    drawLine(image, b.topRight, b.bottomRight, [239, 68, 68, 255]);
    drawLine(image, b.bottomRight, b.bottomLeft, [239, 68, 68, 255]);
    drawLine(image, b.bottomLeft, b.topLeft, [239, 68, 68, 255]);
  }
}

async function writePng(filePath: string, image: RawImage) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp(image.data, {
    raw: {
      width: image.width,
      height: image.height,
      channels: 4,
    },
  }).png().toFile(filePath);
}

function safeFileName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "panel";
}

async function writeSourcePanelDebug(panel: AopProjectionPanelMap, source: PanelSource) {
  const outPath = path.join(OUTPUT_DIR, "source-panels", `${safeFileName(panel.panelKey)}.png`);
  await writePng(outPath, source.image);
}

async function renderView(
  map: AopProjectionMapJson,
  artworkPath: string | undefined,
  viewName: "front" | "back",
  qualityMode: string,
  panelSources?: PanelSourceMap,
) {
  const view = map.views[viewName];
  if (!view) throw new Error(`Projection map does not contain view "${viewName}".`);
  const base = await loadRawImage(view.baseImageUrl, { width: view.width, height: view.height });
  const normal = cloneRaw(base);
  const quality = qualitySettings(qualityMode);
  const artwork = artworkPath
    ? {
        buffer: await readBuffer(artworkPath),
        raw: await loadRawImage(artworkPath),
      }
    : undefined;
  let realPanelSourceCount = 0;
  let atlasFallbackCount = 0;

  for (const panel of view.panels) {
    const sourceUrl = resolvePanelSource(panel, panelSources);
    if (!sourceUrl && !artwork) {
      throw new Error(`No source panel found for "${panel.panelKey}" and --artwork was not provided for atlas fallback.`);
    }
    let src: PanelSource;
    if (sourceUrl && sourceUrl !== "undefined") {
      try {
        src = await panelSourceArtwork(sourceUrl, panel);
      } catch (error: any) {
        if (!artwork) throw error;
        console.warn(
          `[test-render-aop-projection] Panel source failed for "${panel.panelKey}" (${sourceUrl}); falling back to atlas artwork: ${error?.message || error}`,
        );
        src = await panelArtwork(artwork, panel, quality.seamPad);
      }
    } else {
      src = await panelArtwork(artwork!, panel, quality.seamPad);
    }
    if (src.mode === "panel-source") realPanelSourceCount += 1;
    else atlasFallbackCount += 1;
    await writeSourcePanelDebug(panel, src);
    const factor = panelSubdivisionFactor(panel, quality.qualityFactor);
    const subdividedMesh = subdivideMesh(panel.mesh, factor);
    const featherPx = panel.seamFeatherPx ?? quality.seamFeather;
    drawMesh(normal, src.image, subdividedMesh, {
      overlap: quality.overlap,
      sourceOffsetX: src.offsetX,
      sourceOffsetY: src.offsetY,
      panelHull: featherPx > 0 ? panel.bounds : undefined,
      featherPx,
    });
  }

  if (view.maskLayerUrl) {
    const mask = await loadRawImage(view.maskLayerUrl, { width: view.width, height: view.height });
    applyDestinationMask(normal, mask);
  }
  if (view.zipperLayerUrl) {
    const zipper = await loadRawImage(view.zipperLayerUrl, { width: view.width, height: view.height });
    for (let i = 0; i < zipper.data.length; i += 4) {
      compositePixel(normal, (i / 4) % normal.width, Math.floor((i / 4) / normal.width), [
        zipper.data[i],
        zipper.data[i + 1],
        zipper.data[i + 2],
        zipper.data[i + 3],
      ]);
    }
  }
  if (view.shadowLayerUrl) {
    const shadow = await loadRawImage(view.shadowLayerUrl, { width: view.width, height: view.height });
    multiplyLayer(normal, shadow, quality.shadowAlpha);
  }
  if (view.highlightLayerUrl) {
    const highlight = await loadRawImage(view.highlightLayerUrl, { width: view.width, height: view.height });
    screenLayer(normal, highlight, quality.highlightAlpha);
  }

  const outputPath = path.join(OUTPUT_DIR, `${viewName}.png`);
  await writePng(outputPath, normal);

  const debug = cloneRaw(normal);
  drawDebug(debug, view);
  const debugPath = path.join(OUTPUT_DIR, `${viewName}-debug.png`);
  await writePng(debugPath, debug);
  const renderDebugPath = path.join(OUTPUT_DIR, `render-${viewName}-debug.png`);
  await writePng(renderDebugPath, debug);

  const seamFeather = quality.seamFeather > 0 ? quality.seamFeather : 8;
  const seam = cloneRaw(base);
  drawSeamDebug(seam, view, seamFeather);
  const seamPath = path.join(OUTPUT_DIR, `seam-${viewName}-debug.png`);
  await writePng(seamPath, seam);

  return { outputPath, debugPath, renderDebugPath, seamPath, sourceMode: realPanelSourceCount > 0 ? "panel-source" : "atlas", realPanelSourceCount, atlasFallbackCount };
}

async function main() {
  if (hasFlag("help")) {
    printHelp();
    return;
  }

  const view = (argValue("view") || "front") as "front" | "back";
  if (view !== "front" && view !== "back") throw new Error('--view must be "front" or "back".');

  const productTypeId = Number(argValue("productTypeId") || DEFAULT_PRODUCT_TYPE_ID);
  const quality = argValue("quality") || "production";
  if (!["draft", "balanced", "production"].includes(quality)) throw new Error("--quality must be draft, balanced, or production.");
  let artwork = argValue("artwork");
  const designState = argValue("designState");
  relativeUrlBase = argValue("baseUrl") || relativeUrlBase;
  let panelSources: PanelSourceMap | undefined;
  if (designState) panelSources = await loadPanelSourcesFromDesignState(designState);
  artwork = artwork || designStateArtwork;
  if (hasFlag("useLatestPlacement")) {
    const latest = await loadLatestPlacementSources(productTypeId);
    panelSources = panelSources ? new Map([...latest, ...panelSources]) : latest;
  }
  if (!artwork && (!panelSources || panelSources.size === 0)) {
    throw new Error("--artwork is required unless --designState or --useLatestPlacement provides per-panel sources.");
  }
  const map = await loadMap(productTypeId);
  const result = await renderView(map, artwork, view, quality, panelSources);

  console.log(JSON.stringify({ view, productTypeId, quality, ...result }, null, 2));
}

main().catch((error) => {
  console.error("[test-render-aop-projection] Failed:", error);
  process.exit(1);
});
