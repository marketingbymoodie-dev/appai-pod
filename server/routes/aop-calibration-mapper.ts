/**
 * Dev-only API for the AOP Calibration Mapper UI
 * (client/src/pages/aop-calibration-mapper.tsx).
 *
 * Endpoints (mounted under /api/dev/aop-mapper):
 *   GET    /source-panels                 → list local panel PNGs (tmp/aop-render-tests/source-panels)
 *   GET    /source-panels/:filename       → serve a local panel PNG
 *   GET    /calibration-mockups           → list available calibration mockups (cached or remote)
 *   GET    /calibration-mockups/:view     → serve front/back calibration mockup PNG (cached)
 *   GET    /calibrations                  → list saved calibration JSON files (tmp/aop-calibrations)
 *   GET    /calibrations/:name            → load a saved calibration JSON
 *   POST   /calibrations/:name            → save a calibration JSON (raw body)
 *   POST   /test-render                   → server-side test render preview (multipart not required;
 *                                            takes JSON body { calibration, view, panels: { panelKey: dataUrl } })
 *
 * All endpoints are intentionally guarded by NODE_ENV !== 'production'.
 */

import { type Express, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import sharp from "sharp";

const PROJECT_ROOT = process.cwd();

const SOURCE_PANELS_DIR = path.resolve(PROJECT_ROOT, "tmp", "aop-render-tests", "source-panels");
const SOURCE_PANELS_GENERATED_DIR = path.resolve(
  PROJECT_ROOT,
  "tmp",
  "aop-render-tests",
  "source-panels-generated",
);
const CALIBRATION_RUNS_DIR = path.resolve(PROJECT_ROOT, "tmp", "aop-calibration");
const MOCKUP_CACHE_DIR = path.resolve(PROJECT_ROOT, "tmp", "aop-calibration-mapper-cache");
const CALIBRATIONS_DIR = path.resolve(PROJECT_ROOT, "tmp", "aop-calibrations");

const SAFE_PANEL_NAMES = new Set([
  "front_right",
  "front_left",
  "back",
  "right_sleeve",
  "left_sleeve",
  "right_hood",
  "left_hood",
  "pocket_right",
  "pocket_left",
  "right_cuff_panel",
  "left_cuff_panel",
  "waistband",
]);

function isSafeName(name: string): boolean {
  return /^[a-zA-Z0-9_\-]+$/.test(name) && name.length <= 64;
}

function isSafeFilename(name: string): boolean {
  return /^[a-zA-Z0-9_\-]+(?:\.[a-zA-Z0-9]+)?$/.test(name) && name.length <= 80;
}

function safeJoin(base: string, name: string): string | null {
  if (!isSafeFilename(name)) return null;
  const joined = path.resolve(base, name);
  // Add trailing separator to base so safeJoin(base, "..") cannot escape sibling dirs that share a prefix.
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (!joined.startsWith(baseWithSep) && joined !== base) return null;
  return joined;
}

function ensureDirSync(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

async function readJsonSafe<T>(file: string): Promise<T | null> {
  try {
    const buf = await fs.promises.readFile(file, "utf-8");
    return JSON.parse(buf) as T;
  } catch {
    return null;
  }
}

type RunSummary = {
  results?: Array<{
    runId: string;
    productTypeId?: number | null;
    blueprintId?: number;
    providerId?: number;
    variantId?: number | null;
    size?: string | null;
    mockupUrls?: string[];
  }>;
};

async function findLatestRunSummary(): Promise<{
  runId: string;
  productTypeId: number | null;
  blueprintId: number | null;
  providerId: number | null;
  size: string | null;
  mockupUrls: string[];
  filePath: string;
} | null> {
  try {
    const entries = await fs.promises.readdir(CALIBRATION_RUNS_DIR);
    const summaries = entries
      .filter((entry) => entry.startsWith("run-summary-") && entry.endsWith(".json"))
      .map((entry) => path.join(CALIBRATION_RUNS_DIR, entry));
    if (summaries.length === 0) return null;
    const stats = await Promise.all(summaries.map(async (file) => ({ file, stat: await fs.promises.stat(file) })));
    stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const { file } of stats) {
      const json = await readJsonSafe<RunSummary>(file);
      const result = json?.results?.[0];
      if (!result?.runId) continue;
      return {
        runId: result.runId,
        productTypeId: result.productTypeId ?? null,
        blueprintId: result.blueprintId ?? null,
        providerId: result.providerId ?? null,
        size: result.size ?? null,
        mockupUrls: Array.isArray(result.mockupUrls) ? result.mockupUrls : [],
        filePath: file,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function readPanelMetadata(file: string) {
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat) return null;
  let width: number | null = null;
  let height: number | null = null;
  try {
    const meta = await sharp(file).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
  } catch {
    /* ignore */
  }
  return { size: stat.size, mtimeMs: stat.mtimeMs, width, height };
}

function viewFromUrl(url: string, fallbackIndex: number): "front" | "back" {
  const lower = url.toLowerCase();
  if (lower.includes("/back") || lower.endsWith("back.png")) return "back";
  if (lower.includes("/front") || lower.endsWith("front.png")) return "front";
  return fallbackIndex === 1 ? "back" : "front";
}

async function downloadAndCacheMockup(url: string, runId: string, view: "front" | "back"): Promise<string> {
  ensureDirSync(MOCKUP_CACHE_DIR);
  const cacheFile = path.join(MOCKUP_CACHE_DIR, `${runId}-${view}.png`);
  if (fs.existsSync(cacheFile)) return cacheFile;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Mockup fetch failed ${response.status} for ${url}`);
  const buf = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(cacheFile, buf);
  return cacheFile;
}

export function registerAopCalibrationMapperRoutes(app: Express) {
  if (process.env.NODE_ENV === "production") return; // dev-only

  ensureDirSync(CALIBRATIONS_DIR);

  // ──────────────────────────────────────────────────────────────────────
  // GET /api/dev/aop-mapper/source-panels
  // ──────────────────────────────────────────────────────────────────────
  app.get("/api/dev/aop-mapper/source-panels", async (_req: Request, res: Response) => {
    try {
      const dirs: Array<{ label: string; dir: string }> = [
        { label: "source-panels", dir: SOURCE_PANELS_DIR },
        { label: "source-panels-generated", dir: SOURCE_PANELS_GENERATED_DIR },
      ];

      const panels: Array<{
        panelKey: string;
        source: string;
        url: string;
        width: number | null;
        height: number | null;
        sizeBytes: number;
      }> = [];

      for (const { label, dir } of dirs) {
        if (!fs.existsSync(dir)) continue;
        const files = await fs.promises.readdir(dir);
        for (const file of files) {
          if (!file.endsWith(".png")) continue;
          const panelKey = file.replace(/\.png$/i, "");
          if (!SAFE_PANEL_NAMES.has(panelKey)) continue;
          const meta = await readPanelMetadata(path.join(dir, file));
          if (!meta) continue;
          panels.push({
            panelKey,
            source: label,
            url: `/api/dev/aop-mapper/source-panels/${file}?source=${encodeURIComponent(label)}`,
            width: meta.width,
            height: meta.height,
            sizeBytes: meta.size,
          });
        }
      }

      panels.sort((a, b) => {
        if (a.panelKey !== b.panelKey) return a.panelKey.localeCompare(b.panelKey);
        if (a.source === b.source) return 0;
        return a.source === "source-panels" ? -1 : 1;
      });

      res.json({ panels });
    } catch (error: any) {
      console.error("[aop-mapper] source-panels list error:", error);
      res.status(500).json({ error: error.message || "Failed to list source panels" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // GET /api/dev/aop-mapper/source-panels/:filename
  // ──────────────────────────────────────────────────────────────────────
  app.get("/api/dev/aop-mapper/source-panels/:filename", async (req: Request, res: Response) => {
    const { filename } = req.params as { filename: string };
    if (!/^[a-zA-Z0-9_\-]+\.png$/.test(filename)) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    const source = (req.query.source as string) || "source-panels";
    const baseDir =
      source === "source-panels-generated" ? SOURCE_PANELS_GENERATED_DIR : SOURCE_PANELS_DIR;
    const file = safeJoin(baseDir, filename);
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: "Not found" });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=60");
    fs.createReadStream(file).pipe(res);
  });

  // ──────────────────────────────────────────────────────────────────────
  // GET /api/dev/aop-mapper/calibration-mockups
  // ──────────────────────────────────────────────────────────────────────
  app.get("/api/dev/aop-mapper/calibration-mockups", async (_req: Request, res: Response) => {
    try {
      const summary = await findLatestRunSummary();
      const result: {
        runId: string | null;
        productTypeId: number | null;
        blueprintId: number | null;
        providerId: number | null;
        size: string | null;
        views: Array<{ view: "front" | "back"; url: string; remoteUrl: string | null }>;
      } = {
        runId: summary?.runId ?? null,
        productTypeId: summary?.productTypeId ?? null,
        blueprintId: summary?.blueprintId ?? null,
        providerId: summary?.providerId ?? null,
        size: summary?.size ?? null,
        views: [],
      };

      if (summary && summary.mockupUrls.length > 0) {
        const seen = new Set<string>();
        summary.mockupUrls.forEach((url, idx) => {
          const view = viewFromUrl(url, idx);
          if (seen.has(view)) return;
          seen.add(view);
          result.views.push({
            view,
            url: `/api/dev/aop-mapper/calibration-mockups/${view}`,
            remoteUrl: url,
          });
        });
      }

      res.json(result);
    } catch (error: any) {
      console.error("[aop-mapper] calibration-mockups list error:", error);
      res.status(500).json({ error: error.message || "Failed to list calibration mockups" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // GET /api/dev/aop-mapper/calibration-mockups/:view
  // ──────────────────────────────────────────────────────────────────────
  app.get("/api/dev/aop-mapper/calibration-mockups/:view", async (req: Request, res: Response) => {
    const view = req.params.view as "front" | "back";
    if (view !== "front" && view !== "back") {
      return res.status(400).json({ error: "Invalid view" });
    }
    try {
      const summary = await findLatestRunSummary();
      if (!summary) return res.status(404).json({ error: "No calibration run found" });
      const url = summary.mockupUrls.find((u) => viewFromUrl(u, 0) === view);
      if (!url) return res.status(404).json({ error: `No ${view} mockup in latest run` });
      const cacheFile = await downloadAndCacheMockup(url, summary.runId, view);
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "private, max-age=300");
      fs.createReadStream(cacheFile).pipe(res);
    } catch (error: any) {
      console.error("[aop-mapper] calibration-mockup get error:", error);
      res.status(500).json({ error: error.message || "Failed to fetch calibration mockup" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // GET /api/dev/aop-mapper/calibrations
  // ──────────────────────────────────────────────────────────────────────
  app.get("/api/dev/aop-mapper/calibrations", async (_req: Request, res: Response) => {
    try {
      ensureDirSync(CALIBRATIONS_DIR);
      const files = await fs.promises.readdir(CALIBRATIONS_DIR);
      const items: Array<{ name: string; updatedAt: string; sizeBytes: number }> = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const stat = await fs.promises.stat(path.join(CALIBRATIONS_DIR, file));
        items.push({
          name: file.replace(/\.json$/i, ""),
          updatedAt: new Date(stat.mtimeMs).toISOString(),
          sizeBytes: stat.size,
        });
      }
      items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      res.json({ directory: CALIBRATIONS_DIR, calibrations: items });
    } catch (error: any) {
      console.error("[aop-mapper] calibrations list error:", error);
      res.status(500).json({ error: error.message || "Failed to list calibrations" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // GET /api/dev/aop-mapper/calibrations/:name
  // ──────────────────────────────────────────────────────────────────────
  app.get("/api/dev/aop-mapper/calibrations/:name", async (req: Request, res: Response) => {
    const { name } = req.params as { name: string };
    if (!isSafeName(name)) return res.status(400).json({ error: "Invalid name" });
    const file = safeJoin(CALIBRATIONS_DIR, `${name}.json`);
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: "Not found" });
    try {
      const buf = await fs.promises.readFile(file, "utf-8");
      res.setHeader("Content-Type", "application/json");
      res.send(buf);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to read calibration" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // POST /api/dev/aop-mapper/calibrations/:name
  // ──────────────────────────────────────────────────────────────────────
  app.post("/api/dev/aop-mapper/calibrations/:name", async (req: Request, res: Response) => {
    const { name } = req.params as { name: string };
    if (!isSafeName(name)) return res.status(400).json({ error: "Invalid name" });
    const file = safeJoin(CALIBRATIONS_DIR, `${name}.json`);
    if (!file) return res.status(400).json({ error: "Invalid name" });
    try {
      ensureDirSync(CALIBRATIONS_DIR);
      const payload = req.body;
      if (!payload || typeof payload !== "object") {
        return res.status(400).json({ error: "Invalid JSON payload" });
      }
      const json = JSON.stringify(
        {
          ...payload,
          savedAt: new Date().toISOString(),
        },
        null,
        2,
      );
      await fs.promises.writeFile(file, json, "utf-8");
      res.json({ ok: true, file, sizeBytes: Buffer.byteLength(json, "utf-8") });
    } catch (error: any) {
      console.error("[aop-mapper] calibration save error:", error);
      res.status(500).json({ error: error.message || "Failed to save calibration" });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // POST /api/dev/aop-mapper/test-render
  //
  // body: {
  //   view: "front" | "back",
  //   mockupSize: { width, height },
  //   baseMockupDataUrl: "data:image/png;base64,...",
  //   panels: [{
  //     panelKey, opacity, zIndex, mesh: { cols, rows, points: [{u,v,x,y}, ...] },
  //     mask?: { polygon: [{u,v}, ...] },
  //     artworkDataUrl: "data:image/png;base64,..."   // raw artwork PNG for that panel
  //   }]
  // }
  //
  // Returns a composite PNG that warps each artwork panel through its mesh
  // onto the base mockup (server-side using sharp/raw canvas math).
  // ──────────────────────────────────────────────────────────────────────
  app.post("/api/dev/aop-mapper/test-render", async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        view?: string;
        mockupSize?: { width?: number; height?: number };
        baseMockupDataUrl?: string;
        panels?: Array<{
          panelKey: string;
          opacity?: number;
          zIndex?: number;
          mesh: {
            cols: number;
            rows: number;
            points: Array<{ u: number; v: number; x: number; y: number }>;
          };
          mask?: { polygon: Array<{ u: number; v: number }> } | null;
          artworkDataUrl: string;
          sourceSize?: { width: number; height: number };
        }>;
      };
      const W = Math.max(64, Math.round(body.mockupSize?.width || 0));
      const H = Math.max(64, Math.round(body.mockupSize?.height || 0));
      if (!W || !H) return res.status(400).json({ error: "mockupSize.width/height required" });

      // Start with a transparent canvas; composite mockup if provided.
      let composite = sharp({
        create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .toBuffer();

      let baseBuf = await composite;
      if (body.baseMockupDataUrl) {
        const m = body.baseMockupDataUrl.match(/^data:image\/(png|jpeg);base64,(.*)$/);
        if (m) {
          const buf = Buffer.from(m[2], "base64");
          baseBuf = await sharp(buf).resize(W, H, { fit: "fill" }).png().toBuffer();
        }
      }

      // Render each panel into its own RGBA buffer using a triangulated mesh, then composite.
      const overlays: Array<{ buffer: Buffer; zIndex: number }> = [];
      for (const panel of body.panels || []) {
        if (!panel?.artworkDataUrl) continue;
        const m = panel.artworkDataUrl.match(/^data:image\/(png|jpeg);base64,(.*)$/);
        if (!m) continue;
        const artwork = await sharp(Buffer.from(m[2], "base64")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const buf = warpPanelMesh({
          src: { data: artwork.data, width: artwork.info.width, height: artwork.info.height },
          mesh: panel.mesh,
          mask: panel.mask,
          opacity: typeof panel.opacity === "number" ? Math.max(0, Math.min(1, panel.opacity)) : 1,
          width: W,
          height: H,
        });
        if (buf) overlays.push({ buffer: buf, zIndex: panel.zIndex ?? 0 });
      }
      overlays.sort((a, b) => a.zIndex - b.zIndex);

      const final = await sharp(baseBuf)
        .composite(
          overlays.map((o) => ({
            input: o.buffer,
            raw: { width: W, height: H, channels: 4 as const },
          })),
        )
        .png()
        .toBuffer();

      res.setHeader("Content-Type", "image/png");
      res.send(final);
    } catch (error: any) {
      console.error("[aop-mapper] test-render error:", error);
      res.status(500).json({ error: error.message || "Test render failed" });
    }
  });

  console.log("[aop-mapper] dev routes registered at /api/dev/aop-mapper/*");
}

// ──────────────────────────────────────────────────────────────────────
// Software mesh warp implementation (no native canvas dep).
//
// For each cell in the mesh grid, split into two triangles and rasterize.
// For each pixel in the destination triangle, compute its barycentric
// coordinates → look up the corresponding source UV via the corresponding
// triangle in source-space, sample the source pixel (bilinear).
// ──────────────────────────────────────────────────────────────────────
function warpPanelMesh(params: {
  src: { data: Buffer; width: number; height: number };
  mesh: {
    cols: number;
    rows: number;
    points: Array<{ u: number; v: number; x: number; y: number }>;
  };
  mask?: { polygon: Array<{ u: number; v: number }> } | null;
  opacity: number;
  width: number;
  height: number;
}): Buffer | null {
  const { src, mesh, opacity, width: W, height: H } = params;
  const cols = mesh.cols | 0;
  const rows = mesh.rows | 0;
  if (cols < 1 || rows < 1) return null;
  if (mesh.points.length !== (cols + 1) * (rows + 1)) return null;
  const out = Buffer.alloc(W * H * 4, 0);
  const idxFor = (cx: number, ry: number) => ry * (cols + 1) + cx;

  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const tl = mesh.points[idxFor(cx, ry)];
      const tr = mesh.points[idxFor(cx + 1, ry)];
      const br = mesh.points[idxFor(cx + 1, ry + 1)];
      const bl = mesh.points[idxFor(cx, ry + 1)];
      // Two triangles: tl-tr-br, tl-br-bl
      rasterizeTriangle(out, W, H, src, opacity, tl, tr, br, params.mask?.polygon);
      rasterizeTriangle(out, W, H, src, opacity, tl, br, bl, params.mask?.polygon);
    }
  }

  return Buffer.from(out);
}

type MeshPt = { u: number; v: number; x: number; y: number };

function rasterizeTriangle(
  out: Buffer,
  W: number,
  H: number,
  src: { data: Buffer; width: number; height: number },
  opacity: number,
  p0: MeshPt,
  p1: MeshPt,
  p2: MeshPt,
  maskPolygon: Array<{ u: number; v: number }> | null | undefined,
) {
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
  if (maxX < minX || maxY < minY) return;

  const denom = (p1.y - p2.y) * (p0.x - p2.x) + (p2.x - p1.x) * (p0.y - p2.y);
  if (Math.abs(denom) < 1e-9) return;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const w0 = ((p1.y - p2.y) * (x - p2.x) + (p2.x - p1.x) * (y - p2.y)) / denom;
      const w1 = ((p2.y - p0.y) * (x - p2.x) + (p0.x - p2.x) * (y - p2.y)) / denom;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;

      const u = w0 * p0.u + w1 * p1.u + w2 * p2.u;
      const v = w0 * p0.v + w1 * p1.v + w2 * p2.v;
      if (maskPolygon && maskPolygon.length >= 3 && !pointInPolygon(u, v, maskPolygon)) continue;

      const sx = u * src.width;
      const sy = v * src.height;
      if (sx < 0 || sy < 0 || sx >= src.width - 1 || sy >= src.height - 1) continue;

      // Bilinear sample
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * src.width + x0) * 4;
      const i10 = i00 + 4;
      const i01 = ((y0 + 1) * src.width + x0) * 4;
      const i11 = i01 + 4;
      const wA = (1 - fx) * (1 - fy);
      const wB = fx * (1 - fy);
      const wC = (1 - fx) * fy;
      const wD = fx * fy;
      const r = wA * src.data[i00] + wB * src.data[i10] + wC * src.data[i01] + wD * src.data[i11];
      const g = wA * src.data[i00 + 1] + wB * src.data[i10 + 1] + wC * src.data[i01 + 1] + wD * src.data[i11 + 1];
      const b = wA * src.data[i00 + 2] + wB * src.data[i10 + 2] + wC * src.data[i01 + 2] + wD * src.data[i11 + 2];
      const a = (wA * src.data[i00 + 3] + wB * src.data[i10 + 3] + wC * src.data[i01 + 3] + wD * src.data[i11 + 3]) * opacity;

      const dstIdx = (y * W + x) * 4;
      // Painter's algo within the same panel buffer (already 0)
      const outA = out[dstIdx + 3] / 255;
      const inA = a / 255;
      const newA = inA + outA * (1 - inA);
      if (newA <= 0) continue;
      out[dstIdx] = (r * inA + out[dstIdx] * outA * (1 - inA)) / newA;
      out[dstIdx + 1] = (g * inA + out[dstIdx + 1] * outA * (1 - inA)) / newA;
      out[dstIdx + 2] = (b * inA + out[dstIdx + 2] * outA * (1 - inA)) / newA;
      out[dstIdx + 3] = Math.min(255, Math.round(newA * 255));
    }
  }
}

function pointInPolygon(u: number, v: number, polygon: Array<{ u: number; v: number }>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].u, yi = polygon[i].v;
    const xj = polygon[j].u, yj = polygon[j].v;
    const intersect = (yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
