import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import type {
  AopPanelCurvature,
  AopProjectionDebugArtifacts,
  AopProjectionGridPoint,
  AopProjectionMapJson,
  AopProjectionMeshCell,
  AopProjectionPanelMap,
  AopProjectionPoint,
  AopProjectionViewMap,
} from "../shared/aopProjectionMap";

const LOCAL_OUTPUT_DIR = path.join(process.cwd(), "tmp", "aop-projection-maps");
const CALIBRATION_BUCKET = process.env.SUPABASE_AOP_CALIBRATION_BUCKET || "aop-calibration";
const DEFAULT_BLUEPRINT_ID = 451;
const DEFAULT_PROVIDER_ID = 10;
const DEFAULT_SIZE = "L";

type CalibrationRunRow = {
  id: string;
  product_type_id: number | null;
  blueprint_id: number;
  provider_id: number;
  variant_id: number | null;
  size: string | null;
  status: string;
  printify_mockup_urls: unknown;
  print_areas_payload: unknown;
  export_url: string | null;
};

type CalibrationPanelRow = {
  id: string;
  panel_key: string;
  width: number;
  height: number;
  calibration_image_url: string;
  placement: unknown;
};

type RawImage = {
  data: Buffer;
  width: number;
  height: number;
};

type ColorBlob = {
  id: string;
  x: number;
  y: number;
  pixelCount: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type LatticeCluster = {
  id: string;
  points: ColorBlob[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  rowCount: number;
  colCount: number;
};

type DetectedPanelBuild = {
  panelMap: AopProjectionPanelMap;
  usedDetection: boolean;
};

function argValue(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0) return process.argv[idx + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function printHelp() {
  console.log(`
Build a reusable AOP projection map from a completed calibration run.

Usage:
  npx tsx scripts/build-aop-warp-map.ts --runId RUN_ID --pretty
  npx tsx scripts/build-aop-warp-map.ts --productTypeId 20 --view all --pretty
  npx tsx scripts/build-aop-warp-map.ts --blueprintId 451 --view front --replace

Options:
  --runId <id>          Calibration run id to build from.
  --productTypeId <id>  Use latest completed run for product type.
  --blueprintId <id>    Use latest completed run for blueprint id. Defaults to 451.
  --providerId <id>     Provider filter. Defaults to 10 for blueprint 451.
  --size <size>         Size filter. Defaults to L.
  --view <name>         front, back, or all. Defaults to all.
  --out <path>          Local output path.
  --replace             Allow overwriting map/debug objects in Supabase.
  --pretty              Pretty-print JSON.
  --help                Show this help.

Required environment variables:
  DATABASE_URL
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_AOP_CALIBRATION_BUCKET (optional, defaults to aop-calibration)
`);
}

function validateRequiredEnv() {
  const required = ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length === 0) return;
  console.error("[build-aop-warp-map] Missing required environment variable(s):");
  for (const key of missing) console.error(`  - ${key}`);
  console.error(`  - SUPABASE_AOP_CALIBRATION_BUCKET is optional and currently "${CALIBRATION_BUCKET}"`);
  throw new Error(`Missing required env vars: ${missing.join(", ")}`);
}

function makePool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const isRailwayPublicProxy = connectionString.includes("rlwy.net");
  return new pg.Pool({
    connectionString,
    ssl: isRailwayPublicProxy ? { rejectUnauthorized: false } : false,
  });
}

async function ensureProjectionTable(pool: pg.Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "aop_projection_maps" (
      "id"              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      "product_type_id" INTEGER,
      "blueprint_id"    INTEGER NOT NULL,
      "provider_id"     INTEGER NOT NULL,
      "size"            TEXT,
      "map_json"        JSONB NOT NULL,
      "created_at"      TIMESTAMP DEFAULT NOW() NOT NULL,
      "updated_at"      TIMESTAMP DEFAULT NOW() NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS "aop_projection_maps_product_type_idx" ON "aop_projection_maps" ("product_type_id")`);
  await pool.query(`CREATE INDEX IF NOT EXISTS "aop_projection_maps_blueprint_provider_idx" ON "aop_projection_maps" ("blueprint_id", "provider_id")`);
  await pool.query(`CREATE INDEX IF NOT EXISTS "aop_projection_maps_created_idx" ON "aop_projection_maps" ("created_at")`);
}

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function fetchBuffer(url: string): Promise<Buffer> {
  if (/^https?:\/\//.test(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetch failed ${response.status} for ${url}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return fs.readFile(url);
}

async function loadRawImage(buffer: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function publicRunArtifactUrl(runId: string, objectName: string): string | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) return null;
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${CALIBRATION_BUCKET}/runs/${runId}/${objectName}`;
}

async function fetchRunArtifact(runId: string, objectName: string): Promise<Buffer | null> {
  const url = publicRunArtifactUrl(runId, objectName);
  if (url) {
    try {
      return await fetchBuffer(url);
    } catch {
      // Fall through to local filesystem for local-only calibration captures.
    }
  }
  const localPath = path.join(process.cwd(), "tmp", "aop-calibration", "runs", runId, objectName);
  try {
    return await fs.readFile(localPath);
  } catch {
    return null;
  }
}

function sanitizeObjectName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "artifact";
}

async function uploadArtifact(params: {
  objectPath: string;
  buffer: Buffer;
  contentType: string;
  replace: boolean;
}): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    const localPath = path.join(LOCAL_OUTPUT_DIR, params.objectPath);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    if (!params.replace) {
      try {
        await fs.access(localPath);
        throw new Error(`Refusing to overwrite existing local artifact: ${localPath}`);
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await fs.writeFile(localPath, params.buffer);
    return localPath;
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await supabase.storage.from(CALIBRATION_BUCKET).upload(params.objectPath, params.buffer, {
    contentType: params.contentType,
    upsert: params.replace,
  });
  if (error) {
    throw new Error(
      `Supabase upload failed for bucket "${CALIBRATION_BUCKET}" path "${params.objectPath}": ${error.message}`,
    );
  }
  const { data } = supabase.storage.from(CALIBRATION_BUCKET).getPublicUrl(params.objectPath);
  return data.publicUrl;
}

async function loadRun(pool: pg.Pool): Promise<CalibrationRunRow> {
  const runId = argValue("runId");
  const productTypeId = argValue("productTypeId");
  const blueprintId = Number(argValue("blueprintId") || DEFAULT_BLUEPRINT_ID);
  const providerId = Number(argValue("providerId") || (blueprintId === DEFAULT_BLUEPRINT_ID ? DEFAULT_PROVIDER_ID : 0));
  const size = argValue("size") || DEFAULT_SIZE;

  const query = runId
    ? {
        text: `SELECT * FROM aop_calibration_runs WHERE id = $1 LIMIT 1`,
        values: [runId],
      }
    : productTypeId
      ? {
          text: `SELECT * FROM aop_calibration_runs
                 WHERE product_type_id = $1 AND status = 'completed'
                   AND ($2::integer IS NULL OR provider_id = $2)
                   AND ($3::text IS NULL OR size = $3)
                 ORDER BY updated_at DESC
                 LIMIT 1`,
          values: [Number(productTypeId), providerId || null, size || null],
        }
      : {
          text: `SELECT * FROM aop_calibration_runs
                 WHERE blueprint_id = $1 AND status = 'completed'
                   AND ($2::integer IS NULL OR provider_id = $2)
                   AND ($3::text IS NULL OR size = $3)
                 ORDER BY updated_at DESC
                 LIMIT 1`,
          values: [blueprintId, providerId || null, size || null],
        };

  const result = await pool.query(query);
  const row = result.rows[0];
  if (!row) throw new Error("No matching completed AOP calibration run found.");
  return row;
}

function viewNameFromUrl(url: string, index: number): "front" | "back" {
  const lower = url.toLowerCase();
  if (lower.includes("back")) return "back";
  if (lower.includes("front")) return "front";
  return index === 1 ? "back" : "front";
}

function isRedMarker(r: number, g: number, b: number): boolean {
  return r > 165 && g > 35 && g < 115 && b > 35 && b < 120 && r - g > 70 && r - b > 70;
}

function detectColorBlobs(image: RawImage, predicate: (r: number, g: number, b: number, a: number) => boolean): ColorBlob[] {
  const visited = new Uint8Array(image.width * image.height);
  const blobs: ColorBlob[] = [];
  const queue: number[] = [];
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = y * image.width + x;
      if (visited[offset]) continue;
      const idx = offset * 4;
      if (!predicate(image.data[idx], image.data[idx + 1], image.data[idx + 2], image.data[idx + 3])) {
        visited[offset] = 1;
        continue;
      }

      let count = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      queue.length = 0;
      queue.push(offset);
      visited[offset] = 1;

      while (queue.length > 0) {
        const current = queue.pop()!;
        const cx = current % image.width;
        const cy = Math.floor(current / image.width);
        count += 1;
        sumX += cx;
        sumY += cy;
        minX = Math.min(minX, cx);
        minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx);
        maxY = Math.max(maxY, cy);

        const neighbors = [current - 1, current + 1, current - image.width, current + image.width];
        for (const next of neighbors) {
          if (next < 0 || next >= visited.length || visited[next]) continue;
          const nx = next % image.width;
          const ny = Math.floor(next / image.width);
          if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
          const nidx = next * 4;
          if (!predicate(image.data[nidx], image.data[nidx + 1], image.data[nidx + 2], image.data[nidx + 3])) {
            visited[next] = 1;
            continue;
          }
          visited[next] = 1;
          queue.push(next);
        }
      }

      const blobW = maxX - minX + 1;
      const blobH = maxY - minY + 1;
      if (count >= 4 && blobW <= 45 && blobH <= 45) {
        blobs.push({
          id: `blob_${blobs.length + 1}`,
          x: sumX / count,
          y: sumY / count,
          pixelCount: count,
          minX,
          minY,
          maxX,
          maxY,
        });
      }
    }
  }
  return blobs;
}

function clusterMarkerBlobs(blobs: ColorBlob[], width: number, height: number): LatticeCluster[] {
  const sorted = [...blobs].sort((a, b) => b.pixelCount - a.pixelCount);
  const minDistance = Math.max(5, Math.min(width, height) * 0.006);
  const deduped: ColorBlob[] = [];
  for (const blob of sorted) {
    if (deduped.some((existing) => Math.hypot(existing.x - blob.x, existing.y - blob.y) < minDistance)) continue;
    deduped.push(blob);
  }

  const clusters: LatticeCluster[] = [];
  const visited = new Set<string>();
  const joinDistance = Math.max(55, Math.min(width, height) * 0.11);
  for (const seed of deduped) {
    if (visited.has(seed.id)) continue;
    const group: ColorBlob[] = [];
    const queue = [seed];
    visited.add(seed.id);
    while (queue.length > 0) {
      const current = queue.pop()!;
      group.push(current);
      for (const candidate of deduped) {
        if (visited.has(candidate.id)) continue;
        const dx = Math.abs(candidate.x - current.x);
        const dy = Math.abs(candidate.y - current.y);
        if (Math.hypot(dx, dy) <= joinDistance || dx <= joinDistance * 0.42 || dy <= joinDistance * 0.42) {
          visited.add(candidate.id);
          queue.push(candidate);
        }
      }
    }
    if (group.length < 4) continue;
    const minX = Math.min(...group.map((point) => point.x));
    const minY = Math.min(...group.map((point) => point.y));
    const maxX = Math.max(...group.map((point) => point.x));
    const maxY = Math.max(...group.map((point) => point.y));
    const rowCount = groupRows(group, "y").length;
    const colCount = groupRows(group, "x").length;
    clusters.push({
      id: `cluster_${clusters.length + 1}`,
      points: group,
      minX,
      minY,
      maxX,
      maxY,
      width: maxX - minX,
      height: maxY - minY,
      rowCount,
      colCount,
    });
  }
  return clusters.sort((a, b) => b.points.length - a.points.length);
}

function groupRows(points: Array<{ x: number; y: number }>, axis: "x" | "y", tolerance = 12): Array<Array<{ x: number; y: number }>> {
  const key = axis;
  const groups: Array<Array<{ x: number; y: number }>> = [];
  for (const point of [...points].sort((a, b) => a[key] - b[key])) {
    const group = groups.find((candidate) => {
      const avg = candidate.reduce((sum, item) => sum + item[key], 0) / candidate.length;
      return Math.abs(avg - point[key]) <= tolerance;
    });
    if (group) group.push(point);
    else groups.push([point]);
  }
  return groups;
}

function distributePanels(panels: CalibrationPanelRow[], width: number, height: number): Map<string, {
  topLeft: AopProjectionPoint;
  topRight: AopProjectionPoint;
  bottomRight: AopProjectionPoint;
  bottomLeft: AopProjectionPoint;
}> {
  const out = new Map<string, {
    topLeft: AopProjectionPoint;
    topRight: AopProjectionPoint;
    bottomRight: AopProjectionPoint;
    bottomLeft: AopProjectionPoint;
  }>();
  const sorted = [...panels].sort((a, b) => a.panel_key.localeCompare(b.panel_key));
  const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
  const rows = Math.max(1, Math.ceil(sorted.length / cols));
  const marginX = width * 0.12;
  const marginY = height * 0.12;
  const usableW = width - marginX * 2;
  const usableH = height - marginY * 2;
  const cellW = usableW / cols;
  const cellH = usableH / rows;

  sorted.forEach((panel, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = marginX + col * cellW + cellW * 0.08;
    const y = marginY + row * cellH + cellH * 0.08;
    const w = cellW * 0.84;
    const h = cellH * 0.84;
    out.set(panel.panel_key, {
      topLeft: { x, y },
      topRight: { x: x + w, y },
      bottomRight: { x: x + w, y: y + h },
      bottomLeft: { x, y: y + h },
    });
  });
  return out;
}

function createMesh(panel: CalibrationPanelRow, bounds: AopProjectionPanelMap["bounds"], steps = 4): AopProjectionMeshCell[] {
  const mesh: AopProjectionMeshCell[] = [];
  const bilerp = (u: number, v: number): AopProjectionPoint => {
    const top = {
      x: bounds.topLeft.x + (bounds.topRight.x - bounds.topLeft.x) * u,
      y: bounds.topLeft.y + (bounds.topRight.y - bounds.topLeft.y) * u,
    };
    const bottom = {
      x: bounds.bottomLeft.x + (bounds.bottomRight.x - bounds.bottomLeft.x) * u,
      y: bounds.bottomLeft.y + (bounds.bottomRight.y - bounds.bottomLeft.y) * u,
    };
    return {
      x: top.x + (bottom.x - top.x) * v,
      y: top.y + (bottom.y - top.y) * v,
    };
  };

  for (let y = 0; y < steps; y += 1) {
    for (let x = 0; x < steps; x += 1) {
      const u0 = x / steps;
      const u1 = (x + 1) / steps;
      const v0 = y / steps;
      const v1 = (y + 1) / steps;
      mesh.push({
        id: `${panel.panel_key}_${x}_${y}`,
        source: {
          topLeft: { x: u0 * panel.width, y: v0 * panel.height },
          topRight: { x: u1 * panel.width, y: v0 * panel.height },
          bottomRight: { x: u1 * panel.width, y: v1 * panel.height },
          bottomLeft: { x: u0 * panel.width, y: v1 * panel.height },
        },
        target: {
          topLeft: bilerp(u0, v0),
          topRight: bilerp(u1, v0),
          bottomRight: bilerp(u1, v1),
          bottomLeft: bilerp(u0, v1),
        },
      });
    }
  }
  return mesh;
}

function expectedMajorStep(panel: CalibrationPanelRow): number {
  const minor = Math.max(25, Math.round(Math.min(panel.width, panel.height) / 20));
  return minor * 4;
}

function expectedGridCoordinates(panel: CalibrationPanelRow): { xs: number[]; ys: number[] } {
  const step = expectedMajorStep(panel);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = 0; x <= panel.width; x += step) xs.push(x);
  for (let y = 0; y <= panel.height; y += step) ys.push(y);
  if (xs[xs.length - 1] !== panel.width) xs.push(panel.width);
  if (ys[ys.length - 1] !== panel.height) ys.push(panel.height);
  return { xs, ys };
}

function pointKey(x: number, y: number): string {
  return `${Math.round(x)}:${Math.round(y)}`;
}

function bilerp(bounds: AopProjectionPanelMap["bounds"], u: number, v: number): AopProjectionPoint {
  const top = {
    x: bounds.topLeft.x + (bounds.topRight.x - bounds.topLeft.x) * u,
    y: bounds.topLeft.y + (bounds.topRight.y - bounds.topLeft.y) * u,
  };
  const bottom = {
    x: bounds.bottomLeft.x + (bounds.bottomRight.x - bounds.bottomLeft.x) * u,
    y: bounds.bottomLeft.y + (bounds.bottomRight.y - bounds.bottomLeft.y) * u,
  };
  return {
    x: top.x + (bottom.x - top.x) * v,
    y: top.y + (bottom.y - top.y) * v,
  };
}

function boundsFromPoints(points: AopProjectionGridPoint[]): AopProjectionPanelMap["bounds"] {
  const xs = points.map((point) => point.target.x);
  const ys = points.map((point) => point.target.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    topLeft: { x: minX, y: minY },
    topRight: { x: maxX, y: minY },
    bottomRight: { x: maxX, y: maxY },
    bottomLeft: { x: minX, y: maxY },
  };
}

function buildMeshFromDetectedPoints(panel: CalibrationPanelRow, points: AopProjectionGridPoint[]): AopProjectionMeshCell[] {
  const bySource = new Map(points.map((point) => [pointKey(point.source.x, point.source.y), point]));
  const xs = [...new Set(points.map((point) => Math.round(point.source.x)))].sort((a, b) => a - b);
  const ys = [...new Set(points.map((point) => Math.round(point.source.y)))].sort((a, b) => a - b);
  const mesh: AopProjectionMeshCell[] = [];
  for (let yi = 0; yi < ys.length - 1; yi += 1) {
    for (let xi = 0; xi < xs.length - 1; xi += 1) {
      const topLeft = bySource.get(pointKey(xs[xi], ys[yi]));
      const topRight = bySource.get(pointKey(xs[xi + 1], ys[yi]));
      const bottomRight = bySource.get(pointKey(xs[xi + 1], ys[yi + 1]));
      const bottomLeft = bySource.get(pointKey(xs[xi], ys[yi + 1]));
      if (!topLeft || !topRight || !bottomRight || !bottomLeft) continue;
      mesh.push({
        id: `${panel.panel_key}_detected_${xi}_${yi}`,
        source: {
          topLeft: topLeft.source,
          topRight: topRight.source,
          bottomRight: bottomRight.source,
          bottomLeft: bottomLeft.source,
        },
        target: {
          topLeft: topLeft.target,
          topRight: topRight.target,
          bottomRight: bottomRight.target,
          bottomLeft: bottomLeft.target,
        },
      });
    }
  }
  return mesh;
}

function buildPointsFromCluster(panel: CalibrationPanelRow, cluster: LatticeCluster): AopProjectionGridPoint[] {
  const { xs, ys } = expectedGridCoordinates(panel);
  const colGroups = groupRows(cluster.points, "x", Math.max(10, cluster.width / Math.max(xs.length, 1) * 0.35))
    .sort((a, b) => a.reduce((sum, p) => sum + p.x, 0) / a.length - b.reduce((sum, p) => sum + p.x, 0) / b.length);
  const rowGroups = groupRows(cluster.points, "y", Math.max(10, cluster.height / Math.max(ys.length, 1) * 0.35))
    .sort((a, b) => a.reduce((sum, p) => sum + p.y, 0) / a.length - b.reduce((sum, p) => sum + p.y, 0) / b.length);
  const colCount = Math.min(xs.length, colGroups.length);
  const rowCount = Math.min(ys.length, rowGroups.length);
  const points: AopProjectionGridPoint[] = [];

  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < colCount; col += 1) {
      const colAvg = colGroups[col].reduce((sum, point) => sum + point.x, 0) / colGroups[col].length;
      const rowAvg = rowGroups[row].reduce((sum, point) => sum + point.y, 0) / rowGroups[row].length;
      const nearest = cluster.points
        .map((point) => ({ point, distance: Math.hypot(point.x - colAvg, point.y - rowAvg) }))
        .sort((a, b) => a.distance - b.distance)[0];
      const tolerance = Math.max(18, Math.min(cluster.width / Math.max(colCount, 1), cluster.height / Math.max(rowCount, 1)) * 0.55);
      if (!nearest || nearest.distance > tolerance) continue;
      points.push({
        id: `${panel.panel_key}_${xs[col]}_${ys[row]}`,
        source: { x: xs[col], y: ys[row] },
        target: { x: Number(nearest.point.x.toFixed(2)), y: Number(nearest.point.y.toFixed(2)) },
        confidence: Number(Math.max(0.35, 1 - nearest.distance / Math.max(tolerance, 1)).toFixed(3)),
        note: "detected-red-marker",
      });
    }
  }
  return points;
}

function classifyPanelCurvature(panelKey: string): AopPanelCurvature {
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

function curvatureToSubdivision(curvature: AopPanelCurvature): number {
  if (curvature === "high") return 3;
  if (curvature === "medium") return 2;
  return 1;
}

function sourceRectForPanel(panel: CalibrationPanelRow, index: number, total: number) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(total)));
  const rows = Math.max(1, Math.ceil(total / cols));
  const col = index % cols;
  const row = Math.floor(index / cols);
  return {
    x: col / cols,
    y: row / rows,
    width: 1 / cols,
    height: 1 / rows,
    unit: "normalized" as const,
  };
}

function buildPanelFromDetection(params: {
  panel: CalibrationPanelRow;
  panelIndex: number;
  panelCount: number;
  cluster: LatticeCluster | null;
  coarseBounds: AopProjectionPanelMap["bounds"];
}): DetectedPanelBuild {
  const expected = expectedGridCoordinates(params.panel);
  const expectedPointCount = expected.xs.length * expected.ys.length;
  if (params.cluster) {
    const points = buildPointsFromCluster(params.panel, params.cluster);
    const mesh = buildMeshFromDetectedPoints(params.panel, points);
    const coverage = points.length / Math.max(expectedPointCount, 1);
    const confidence = Math.min(0.98, Math.max(0, coverage * 0.72 + Math.min(mesh.length / Math.max((expected.xs.length - 1) * (expected.ys.length - 1), 1), 1) * 0.28));
    if (points.length >= 6 && mesh.length >= 2 && confidence >= 0.18) {
      const bounds = boundsFromPoints(points);
      const curvature = classifyPanelCurvature(params.panel.panel_key);
      return {
        usedDetection: true,
        panelMap: {
          panelKey: params.panel.panel_key,
          sourceWidth: params.panel.width,
          sourceHeight: params.panel.height,
          sourceRect: sourceRectForPanel(params.panel, params.panelIndex, params.panelCount),
          calibrationImageUrl: params.panel.calibration_image_url,
          transformType: "mesh",
          confidence: Number(confidence.toFixed(3)),
          curvature,
          subdivision: curvatureToSubdivision(curvature),
          detection: {
            detectedPointCount: points.length,
            expectedPointCount,
            meshCellCount: mesh.length,
            confidence: Number(confidence.toFixed(3)),
            detector: "sharp-color-blob-lattice",
          },
          points,
          mesh,
          bounds,
        },
      };
    }
  }

  const fallbackPoints: AopProjectionGridPoint[] = [
    { id: `${params.panel.panel_key}_tl`, source: { x: 0, y: 0 }, target: params.coarseBounds.topLeft, confidence: 0.12, note: "fallback-coarse" },
    { id: `${params.panel.panel_key}_tr`, source: { x: params.panel.width, y: 0 }, target: params.coarseBounds.topRight, confidence: 0.12, note: "fallback-coarse" },
    { id: `${params.panel.panel_key}_br`, source: { x: params.panel.width, y: params.panel.height }, target: params.coarseBounds.bottomRight, confidence: 0.12, note: "fallback-coarse" },
    { id: `${params.panel.panel_key}_bl`, source: { x: 0, y: params.panel.height }, target: params.coarseBounds.bottomLeft, confidence: 0.12, note: "fallback-coarse" },
  ];
  const fallbackReason = params.cluster ? "detected points did not form a usable mesh" : "no matching calibration marker cluster";
  const fallbackCurvature = classifyPanelCurvature(params.panel.panel_key);
  return {
    usedDetection: false,
    panelMap: {
      panelKey: params.panel.panel_key,
      sourceWidth: params.panel.width,
      sourceHeight: params.panel.height,
      sourceRect: sourceRectForPanel(params.panel, params.panelIndex, params.panelCount),
      calibrationImageUrl: params.panel.calibration_image_url,
      transformType: "mesh",
      confidence: 0.12,
      curvature: fallbackCurvature,
      subdivision: curvatureToSubdivision(fallbackCurvature),
      fallbackReason,
      detection: {
        detectedPointCount: params.cluster?.points.length || 0,
        expectedPointCount,
        meshCellCount: 0,
        confidence: 0.12,
        detector: "sharp-color-blob-lattice",
        failed: true,
        fallbackReason,
      },
      points: fallbackPoints,
      mesh: createMesh(params.panel, params.coarseBounds),
      bounds: params.coarseBounds,
    },
  };
}

async function createDebugOverlay(params: {
  runId: string;
  view: string;
  width: number;
  height: number;
  panels: AopProjectionPanelMap[];
  replace: boolean;
}): Promise<string> {
  const panelLines = params.panels.flatMap((panel) => {
    const b = panel.bounds;
    const meshLines = panel.mesh.flatMap((cell) => {
      const t = cell.target;
      return [
        `<path d="M${t.topLeft.x},${t.topLeft.y} L${t.topRight.x},${t.topRight.y} L${t.bottomRight.x},${t.bottomRight.y} L${t.bottomLeft.x},${t.bottomLeft.y} Z" fill="none" stroke="#38bdf8" stroke-width="1" opacity="0.35" />`,
      ];
    });
    return [
      `<path d="M${b.topLeft.x},${b.topLeft.y} L${b.topRight.x},${b.topRight.y} L${b.bottomRight.x},${b.bottomRight.y} L${b.bottomLeft.x},${b.bottomLeft.y} Z" fill="none" stroke="#f97316" stroke-width="4" />`,
      `<text x="${b.topLeft.x + 8}" y="${b.topLeft.y + 24}" font-family="Arial" font-size="20" fill="#f97316">${panel.panelKey}</text>`,
      ...meshLines,
      ...panel.points.map((point) => `<circle cx="${point.target.x}" cy="${point.target.y}" r="5" fill="#22c55e" />`),
    ];
  });
  const svg = `<svg width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgba(0,0,0,0)" />
    ${panelLines.join("\n")}
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return uploadArtifact({
    objectPath: `maps/debug/${params.runId}/${params.view}-overlay.png`,
    buffer,
    contentType: "image/png",
    replace: params.replace,
  });
}

async function createDetectedPointsDebug(params: {
  runId: string;
  view: string;
  width: number;
  height: number;
  panels: AopProjectionPanelMap[];
  replace: boolean;
}): Promise<string> {
  const circles = params.panels.flatMap((panel) => [
    ...panel.points.map((point) => `<circle cx="${point.target.x}" cy="${point.target.y}" r="6" fill="${panel.fallbackReason ? "#ef4444" : "#22c55e"}" opacity="0.85" />`),
    ...panel.points.slice(0, 8).map((point) => `<text x="${point.target.x + 8}" y="${point.target.y - 8}" font-family="Arial" font-size="13" fill="#111827">${panel.panelKey}:${Math.round(point.source.x)},${Math.round(point.source.y)}</text>`),
  ]);
  const svg = `<svg width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgba(255,255,255,0)" />
    ${circles.join("\n")}
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return uploadArtifact({
    objectPath: `maps/debug/${params.runId}/detected-points-${params.view}.png`,
    buffer,
    contentType: "image/png",
    replace: params.replace,
  });
}

async function createMeshDebug(params: {
  runId: string;
  view: string;
  width: number;
  height: number;
  panels: AopProjectionPanelMap[];
  replace: boolean;
}): Promise<string> {
  const lines = params.panels.flatMap((panel) => {
    const color = panel.fallbackReason ? "#ef4444" : "#2563eb";
    return panel.mesh.map((cell) => {
      const t = cell.target;
      return `<path d="M${t.topLeft.x},${t.topLeft.y} L${t.topRight.x},${t.topRight.y} L${t.bottomRight.x},${t.bottomRight.y} L${t.bottomLeft.x},${t.bottomLeft.y} Z" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.6" />`;
    });
  });
  const svg = `<svg width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgba(255,255,255,0)" />
    ${lines.join("\n")}
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return uploadArtifact({
    objectPath: `maps/debug/${params.runId}/mesh-${params.view}.png`,
    buffer,
    contentType: "image/png",
    replace: params.replace,
  });
}

async function uploadDetectedPointsJson(params: {
  runId: string;
  view: string;
  panels: AopProjectionPanelMap[];
  replace: boolean;
}): Promise<string> {
  const json = JSON.stringify({
    version: "aop-detected-points/v1",
    runId: params.runId,
    view: params.view,
    generatedAt: new Date().toISOString(),
    panels: params.panels.map((panel) => ({
      panelKey: panel.panelKey,
      confidence: panel.confidence,
      fallbackReason: panel.fallbackReason,
      detection: panel.detection,
      points: panel.points,
    })),
  }, null, hasFlag("pretty") ? 2 : 0);
  return uploadArtifact({
    objectPath: `maps/debug/${params.runId}/detected-points-${params.view}.json`,
    buffer: Buffer.from(json, "utf8"),
    contentType: "application/json",
    replace: params.replace,
  });
}

async function uploadRawPng(params: {
  objectPath: string;
  image: RawImage;
  replace: boolean;
}): Promise<string> {
  const buffer = await sharp(params.image.data, {
    raw: { width: params.image.width, height: params.image.height, channels: 4 },
  }).png().toBuffer();
  return uploadArtifact({
    objectPath: params.objectPath,
    buffer,
    contentType: "image/png",
    replace: params.replace,
  });
}

function deriveFabricLayers(image: RawImage): {
  mask: RawImage;
  shadow: RawImage;
  highlight: RawImage;
} {
  const mask = Buffer.alloc(image.width * image.height * 4);
  const shadow = Buffer.alloc(image.width * image.height * 4);
  const highlight = Buffer.alloc(image.width * image.height * 4);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const idx = (y * image.width + x) * 4;
      const r = image.data[idx];
      const g = image.data[idx + 1];
      const b = image.data[idx + 2];
      const a = image.data[idx + 3];
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const saturation = Math.max(r, g, b) - Math.min(r, g, b);
      const isBackground = a < 20 || (luminance > 244 && saturation < 18);
      const maskAlpha = isBackground ? 0 : 255;

      mask[idx] = 255;
      mask[idx + 1] = 255;
      mask[idx + 2] = 255;
      mask[idx + 3] = maskAlpha;

      const shadowAlpha = maskAlpha ? Math.max(0, Math.min(150, Math.round((178 - luminance) * 0.85))) : 0;
      shadow[idx] = 0;
      shadow[idx + 1] = 0;
      shadow[idx + 2] = 0;
      shadow[idx + 3] = shadowAlpha;

      const highlightAlpha = maskAlpha ? Math.max(0, Math.min(120, Math.round((luminance - 205) * 0.7))) : 0;
      highlight[idx] = 255;
      highlight[idx + 1] = 255;
      highlight[idx + 2] = 255;
      highlight[idx + 3] = highlightAlpha;
    }
  }
  return {
    mask: { data: mask, width: image.width, height: image.height },
    shadow: { data: shadow, width: image.width, height: image.height },
    highlight: { data: highlight, width: image.width, height: image.height },
  };
}

async function createDerivedLayerArtifacts(params: {
  runId: string;
  view: string;
  image: RawImage;
  replace: boolean;
}): Promise<Required<Pick<AopProjectionDebugArtifacts, "maskLayerUrl" | "shadowLayerUrl" | "highlightLayerUrl">>> {
  const layers = deriveFabricLayers(params.image);
  const [maskLayerUrl, shadowLayerUrl, highlightLayerUrl] = await Promise.all([
    uploadRawPng({
      objectPath: `maps/debug/${params.runId}/${params.view}-mask-layer.png`,
      image: layers.mask,
      replace: params.replace,
    }),
    uploadRawPng({
      objectPath: `maps/debug/${params.runId}/${params.view}-shadow-layer.png`,
      image: layers.shadow,
      replace: params.replace,
    }),
    uploadRawPng({
      objectPath: `maps/debug/${params.runId}/${params.view}-highlight-layer.png`,
      image: layers.highlight,
      replace: params.replace,
    }),
  ]);
  return { maskLayerUrl, shadowLayerUrl, highlightLayerUrl };
}

async function createWarpDensityDebug(params: {
  runId: string;
  view: string;
  width: number;
  height: number;
  panels: AopProjectionPanelMap[];
  replace: boolean;
}): Promise<string> {
  const paths = params.panels.flatMap((panel) => panel.mesh.map((cell) => {
    const t = cell.target;
    const sourceArea = Math.max(1, Math.abs((cell.source.topRight.x - cell.source.topLeft.x) * (cell.source.bottomLeft.y - cell.source.topLeft.y)));
    const targetArea = Math.max(1, Math.abs((t.topRight.x - t.topLeft.x) * (t.bottomLeft.y - t.topLeft.y)));
    const ratio = Math.max(0.2, Math.min(2.5, targetArea / sourceArea * 2500));
    const opacity = Math.max(0.18, Math.min(0.75, ratio / 2.5));
    return `<path d="M${t.topLeft.x},${t.topLeft.y} L${t.topRight.x},${t.topRight.y} L${t.bottomRight.x},${t.bottomRight.y} L${t.bottomLeft.x},${t.bottomLeft.y} Z" fill="#f97316" opacity="${opacity.toFixed(2)}" stroke="#111827" stroke-width="0.5" />`;
  }));
  const svg = `<svg width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgba(255,255,255,0)" />
    ${paths.join("\n")}
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return uploadArtifact({
    objectPath: `maps/debug/${params.runId}/warp-density-${params.view}.png`,
    buffer,
    contentType: "image/png",
    replace: params.replace,
  });
}

async function createSeamContinuityDebug(params: {
  runId: string;
  view: string;
  width: number;
  height: number;
  panels: AopProjectionPanelMap[];
  replace: boolean;
}): Promise<string> {
  const paths = params.panels.flatMap((panel) => {
    const color = panel.confidence >= 0.45 ? "#22c55e" : panel.confidence >= 0.2 ? "#f97316" : "#ef4444";
    return [
      `<text x="${panel.bounds.topLeft.x + 6}" y="${panel.bounds.topLeft.y + 18}" font-family="Arial" font-size="14" fill="${color}">${panel.panelKey} ${(panel.confidence * 100).toFixed(0)}%</text>`,
      ...panel.mesh.map((cell) => {
        const t = cell.target;
        return `<path d="M${t.topLeft.x},${t.topLeft.y} L${t.topRight.x},${t.topRight.y} L${t.bottomRight.x},${t.bottomRight.y} L${t.bottomLeft.x},${t.bottomLeft.y} Z" fill="none" stroke="${color}" stroke-width="1" opacity="0.5" />`;
      }),
    ];
  });
  const svg = `<svg width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgba(255,255,255,0)" />
    ${paths.join("\n")}
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return uploadArtifact({
    objectPath: `maps/debug/${params.runId}/seam-continuity-${params.view}.png`,
    buffer,
    contentType: "image/png",
    replace: params.replace,
  });
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

function subdividedTargetCells(cell: AopProjectionMeshCell, factor: number): AopProjectionMeshCell["target"][] {
  if (factor <= 1) return [cell.target];
  const out: AopProjectionMeshCell["target"][] = [];
  for (let j = 0; j < factor; j += 1) {
    for (let i = 0; i < factor; i += 1) {
      const u0 = i / factor;
      const u1 = (i + 1) / factor;
      const v0 = j / factor;
      const v1 = (j + 1) / factor;
      out.push({
        topLeft: bilerpQuad(cell.target, u0, v0),
        topRight: bilerpQuad(cell.target, u1, v0),
        bottomRight: bilerpQuad(cell.target, u1, v1),
        bottomLeft: bilerpQuad(cell.target, u0, v1),
      });
    }
  }
  return out;
}

async function createAdaptiveMeshDebug(params: {
  runId: string;
  view: string;
  width: number;
  height: number;
  panels: AopProjectionPanelMap[];
  replace: boolean;
}): Promise<string> {
  const colorByCurvature = (curvature: AopPanelCurvature | undefined): string => {
    if (curvature === "high") return "#ef4444";
    if (curvature === "medium") return "#f59e0b";
    return "#22c55e";
  };
  const fragments = params.panels.flatMap((panel) => {
    const factor = Math.max(1, Math.min(6, panel.subdivision || curvatureToSubdivision(panel.curvature || classifyPanelCurvature(panel.panelKey))));
    const color = colorByCurvature(panel.curvature || classifyPanelCurvature(panel.panelKey));
    const cells = panel.mesh.flatMap((cell) => subdividedTargetCells(cell, factor));
    return [
      `<text x="${panel.bounds.topLeft.x + 6}" y="${panel.bounds.topLeft.y + 18}" font-family="Arial" font-size="13" fill="${color}">${panel.panelKey} f=${factor}</text>`,
      ...cells.map((t) => `<path d="M${t.topLeft.x},${t.topLeft.y} L${t.topRight.x},${t.topRight.y} L${t.bottomRight.x},${t.bottomRight.y} L${t.bottomLeft.x},${t.bottomLeft.y} Z" fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-width="0.5" opacity="0.7" />`),
    ];
  });
  const svg = `<svg width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgba(255,255,255,0)" />
    ${fragments.join("\n")}
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return uploadArtifact({
    objectPath: `maps/debug/${params.runId}/adaptive-mesh-${params.view}.png`,
    buffer,
    contentType: "image/png",
    replace: params.replace,
  });
}

async function createUvContinuityDebug(params: {
  runId: string;
  view: string;
  width: number;
  height: number;
  panels: AopProjectionPanelMap[];
  replace: boolean;
}): Promise<string> {
  const fragments = params.panels.flatMap((panel) => {
    return panel.mesh.map((cell) => {
      const t = cell.target;
      const s = cell.source;
      const cx = (t.topLeft.x + t.topRight.x + t.bottomRight.x + t.bottomLeft.x) / 4;
      const cy = (t.topLeft.y + t.topRight.y + t.bottomRight.y + t.bottomLeft.y) / 4;
      const u = panel.sourceWidth > 0 ? Math.max(0, Math.min(1, (s.topLeft.x + s.bottomRight.x) / 2 / panel.sourceWidth)) : 0;
      const v = panel.sourceHeight > 0 ? Math.max(0, Math.min(1, (s.topLeft.y + s.bottomRight.y) / 2 / panel.sourceHeight)) : 0;
      const r = Math.round(u * 255);
      const g = Math.round(v * 255);
      const b = Math.round((1 - u) * 255);
      return `<path d="M${t.topLeft.x},${t.topLeft.y} L${t.topRight.x},${t.topRight.y} L${t.bottomRight.x},${t.bottomRight.y} L${t.bottomLeft.x},${t.bottomLeft.y} Z" fill="rgb(${r},${g},${b})" fill-opacity="0.55" stroke="rgba(15,23,42,0.5)" stroke-width="0.5" />` +
        `<circle cx="${cx}" cy="${cy}" r="3" fill="#0f172a" />`;
    });
  });
  const svg = `<svg width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgba(255,255,255,0)" />
    ${fragments.join("\n")}
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return uploadArtifact({
    objectPath: `maps/debug/${params.runId}/uv-continuity-${params.view}.png`,
    buffer,
    contentType: "image/png",
    replace: params.replace,
  });
}

async function createSeamErrorDebug(params: {
  runId: string;
  view: string;
  width: number;
  height: number;
  panels: AopProjectionPanelMap[];
  replace: boolean;
}): Promise<string> {
  const lines: string[] = [];
  for (const panel of params.panels) {
    for (const cell of panel.mesh) {
      const t = cell.target;
      const len1 = Math.hypot(t.topLeft.x - t.topRight.x, t.topLeft.y - t.topRight.y);
      const len2 = Math.hypot(t.bottomLeft.x - t.bottomRight.x, t.bottomLeft.y - t.bottomRight.y);
      const lenH = Math.hypot(t.topLeft.x - t.bottomLeft.x, t.topLeft.y - t.bottomLeft.y);
      const lenH2 = Math.hypot(t.topRight.x - t.bottomRight.x, t.topRight.y - t.bottomRight.y);
      const ratio = Math.max(len1, len2) / Math.max(1, Math.min(len1, len2));
      const ratioH = Math.max(lenH, lenH2) / Math.max(1, Math.min(lenH, lenH2));
      const score = Math.max(ratio, ratioH);
      const intensity = Math.min(1, Math.max(0, (score - 1) / 0.6));
      const color = `rgb(${Math.round(255 * intensity)},${Math.round(255 * (1 - intensity))},80)`;
      lines.push(
        `<path d="M${t.topLeft.x},${t.topLeft.y} L${t.topRight.x},${t.topRight.y} L${t.bottomRight.x},${t.bottomRight.y} L${t.bottomLeft.x},${t.bottomLeft.y} Z" fill="${color}" fill-opacity="${(0.15 + intensity * 0.55).toFixed(2)}" stroke="${color}" stroke-width="0.6" />`,
      );
    }
  }
  const svg = `<svg width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgba(255,255,255,0)" />
    ${lines.join("\n")}
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return uploadArtifact({
    objectPath: `maps/debug/${params.runId}/seam-error-${params.view}.png`,
    buffer,
    contentType: "image/png",
    replace: params.replace,
  });
}

async function buildMap() {
  if (hasFlag("help")) {
    printHelp();
    return;
  }
  validateRequiredEnv();

  const replace = hasFlag("replace");
  const requestedView = argValue("view") || "all";
  const pool = makePool();
  try {
    await ensureProjectionTable(pool);
    const run = await loadRun(pool);
    const panelsResult = await pool.query(
      `SELECT * FROM aop_calibration_panels WHERE run_id = $1 ORDER BY panel_key ASC, created_at ASC`,
      [run.id],
    );
    const panels = panelsResult.rows as CalibrationPanelRow[];
    if (panels.length === 0) throw new Error(`Calibration run ${run.id} has no panel rows.`);

    const mockupUrls = jsonArray(run.printify_mockup_urls);
    if (mockupUrls.length === 0) throw new Error(`Calibration run ${run.id} has no mockup URLs.`);

    const views: Record<string, AopProjectionViewMap> = {};
    const extractionDebugArtifacts: Record<string, AopProjectionDebugArtifacts> = {};
    for (let i = 0; i < mockupUrls.length; i += 1) {
      let url = mockupUrls[i];
      const view = viewNameFromUrl(url, i);
      if (requestedView !== "all" && requestedView !== view) continue;

      const canonicalMockup = await fetchRunArtifact(run.id, `mockups/${view}.png`);
      const buffer = canonicalMockup || await fetchBuffer(url);
      const canonicalUrl = publicRunArtifactUrl(run.id, `mockups/${view}.png`);
      if (canonicalMockup && canonicalUrl) url = canonicalUrl;
      const raw = await loadRawImage(buffer);
      const redBlobs = detectColorBlobs(raw, (r, g, b, a) => a > 150 && isRedMarker(r, g, b));
      const clusters = clusterMarkerBlobs(redBlobs, raw.width, raw.height);
      const metadata = await sharp(buffer).metadata();
      const width = metadata.width || 1024;
      const height = metadata.height || 1024;
      const boundsByPanel = distributePanels(panels, width, height);
      const unusedClusters = [...clusters];
      const panelMaps: AopProjectionPanelMap[] = panels.map((panel, panelIndex) => {
        const bounds = boundsByPanel.get(panel.panel_key)!;
        const expectedAspect = panel.width / Math.max(panel.height, 1);
        const bestCluster = unusedClusters
          .map((cluster, clusterIndex) => {
            const aspect = cluster.width / Math.max(cluster.height, 1);
            const aspectScore = 1 / (1 + Math.abs(Math.log(Math.max(aspect, 0.01) / Math.max(expectedAspect, 0.01))));
            const sizeScore = Math.min(1, cluster.points.length / Math.max(expectedGridCoordinates(panel).xs.length * 0.55, 1));
            const overlapCenter = bilerp(bounds, 0.5, 0.5);
            const distance = Math.hypot((cluster.minX + cluster.maxX) / 2 - overlapCenter.x, (cluster.minY + cluster.maxY) / 2 - overlapCenter.y);
            const distanceScore = 1 / (1 + distance / Math.max(width, height));
            return { cluster, clusterIndex, score: aspectScore * 0.45 + sizeScore * 0.35 + distanceScore * 0.2 };
          })
          .sort((a, b) => b.score - a.score)[0];
        const cluster = bestCluster && bestCluster.score > 0.25 ? bestCluster.cluster : null;
        if (cluster) unusedClusters.splice(bestCluster.clusterIndex, 1);
        return buildPanelFromDetection({
          panel,
          panelIndex,
          panelCount: panels.length,
          cluster,
          coarseBounds: bounds,
        }).panelMap;
      });

      const debugOverlayUrl = await createDebugOverlay({
        runId: run.id,
        view,
        width,
        height,
        panels: panelMaps,
        replace,
      });
      const detectedPointsUrl = await createDetectedPointsDebug({ runId: run.id, view, width, height, panels: panelMaps, replace });
      const meshUrl = await createMeshDebug({ runId: run.id, view, width, height, panels: panelMaps, replace });
      const detectedPointsJsonUrl = await uploadDetectedPointsJson({ runId: run.id, view, panels: panelMaps, replace });
      const derivedLayers = await createDerivedLayerArtifacts({ runId: run.id, view, image: raw, replace });
      const warpDensityUrl = await createWarpDensityDebug({ runId: run.id, view, width, height, panels: panelMaps, replace });
      const seamContinuityUrl = await createSeamContinuityDebug({ runId: run.id, view, width, height, panels: panelMaps, replace });
      const adaptiveMeshUrl = await createAdaptiveMeshDebug({ runId: run.id, view, width, height, panels: panelMaps, replace });
      const uvContinuityUrl = await createUvContinuityDebug({ runId: run.id, view, width, height, panels: panelMaps, replace });
      const seamErrorUrl = await createSeamErrorDebug({ runId: run.id, view, width, height, panels: panelMaps, replace });
      const debugArtifacts = {
        overlayUrl: debugOverlayUrl,
        detectedPointsUrl,
        detectedPointsJsonUrl,
        meshUrl,
        warpDensityUrl,
        seamContinuityUrl,
        adaptiveMeshUrl,
        uvContinuityUrl,
        seamErrorUrl,
        ...derivedLayers,
      };
      extractionDebugArtifacts[view] = debugArtifacts;

      views[view] = {
        view,
        width,
        height,
        baseImageUrl: url,
        shadowLayerUrl: derivedLayers.shadowLayerUrl,
        highlightLayerUrl: derivedLayers.highlightLayerUrl,
        maskLayerUrl: derivedLayers.maskLayerUrl,
        debugOverlayUrl,
        debugArtifacts,
        panels: panelMaps,
      };
    }

    const mapJson: AopProjectionMapJson = {
      version: "aop-projection-map/v1",
      productTypeId: run.product_type_id,
      blueprintId: run.blueprint_id || DEFAULT_BLUEPRINT_ID,
      providerId: run.provider_id || DEFAULT_PROVIDER_ID,
      size: run.size || DEFAULT_SIZE,
      sourceRunId: run.id,
      generatedAt: new Date().toISOString(),
      extraction: {
        mode: "calibration-point-v1",
        detector: "sharp-color-blob-lattice",
        notes: [
          "v1 detects red calibration marker blobs in Printify-returned mockups and builds mesh cells from matched panel coordinates.",
          "Panels with weak marker confidence fall back to coarse bounds and carry fallbackReason/detection metadata.",
          "Detected point JSON artifacts are intended for later manual correction.",
        ],
        debugArtifacts: extractionDebugArtifacts,
      },
      views,
    };

    const productKey = run.product_type_id ? String(run.product_type_id) : `blueprint-${mapJson.blueprintId}`;
    const mapObjectPath = `maps/${productKey}.json`;
    const json = JSON.stringify(mapJson, null, hasFlag("pretty") ? 2 : 0);
    const mapUrl = await uploadArtifact({
      objectPath: mapObjectPath,
      buffer: Buffer.from(json, "utf8"),
      contentType: "application/json",
      replace,
    });
    mapJson.mapUrl = mapUrl;
    const finalJson = JSON.stringify(mapJson, null, hasFlag("pretty") ? 2 : 0);
    if (replace) {
      await uploadArtifact({
        objectPath: mapObjectPath,
        buffer: Buffer.from(finalJson, "utf8"),
        contentType: "application/json",
        replace: true,
      });
    }

    await pool.query(
      `INSERT INTO aop_projection_maps (product_type_id, blueprint_id, provider_id, size, map_json)
       VALUES ($1, $2, $3, $4, $5)`,
      [run.product_type_id, mapJson.blueprintId, mapJson.providerId, mapJson.size, JSON.stringify(mapJson)],
    );

    const outPath = argValue("out") || path.join(LOCAL_OUTPUT_DIR, `projection-map-${productKey}.json`);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, finalJson, "utf8");
    console.log(finalJson);
    console.error(`\n[build-aop-warp-map] Wrote local map ${outPath}`);
    console.error(`[build-aop-warp-map] Uploaded map ${mapUrl}`);
  } finally {
    await pool.end();
  }
}

buildMap().catch((error) => {
  console.error("[build-aop-warp-map] Failed:", error);
  process.exit(1);
});
