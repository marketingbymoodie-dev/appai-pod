import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import { enqueueMockupJob, getMockupJob } from "../server/mockup-jobs";

const PRINTIFY_API_BASE = "https://api.printify.com/v1";
const LOCAL_OUTPUT_DIR = path.join(process.cwd(), "tmp", "aop-calibration");
const CALIBRATION_BUCKET = process.env.SUPABASE_AOP_CALIBRATION_BUCKET || "aop-calibration";
const ZIP_HOODIE_BLUEPRINT_ID = 451;
const ZIP_HOODIE_PROVIDER_ID = 10;
const ZIP_HOODIE_SIZE_L_VARIANT_ID = 63249;

type ProductTypeRow = {
  id: number;
  merchant_id: string | null;
  name: string;
  printify_blueprint_id: number | null;
  printify_provider_id: number | null;
  placeholder_positions: string | null;
  variant_map: string | null;
  sizes: string | null;
  is_all_over_print: boolean;
  aop_template_id: string | null;
  printify_api_token?: string | null;
  printify_shop_id?: string | null;
};

type Placeholder = {
  position: string;
  width: number;
  height: number;
  raw?: unknown;
};

type PanelRecord = Placeholder & {
  calibrationImageUrl: string;
  placement: {
    placeholderRaw: unknown;
    storageBucket: string;
    storagePath: string;
    pipeline: string;
  };
};

type RunResult = {
  runId: string;
  productTypeId: number;
  blueprintId: number;
  providerId: number;
  variantId: number;
  size: string | null;
  printifyProductId: string | null;
  mockupJobId: string;
  mockupUrlCount: number;
  mockupUrls: string[];
  panelCount: number;
  status: string;
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
Run an internal AOP calibration capture.

Usage:
  npx tsx scripts/run-aop-calibration.ts --productTypeId 20 --variantSize L --pretty
  npx tsx scripts/run-aop-calibration.ts --blueprintId 451 --variantSize L --pretty
  npx tsx scripts/run-aop-calibration.ts --blueprintId 451 --variantId 63249 --pretty

Options:
  --productTypeId <id>   Product type row to calibrate.
  --blueprintId <id>     Product type lookup fallback by Printify blueprint id.
  --variantId <id>       Exact Printify variant id to calibrate.
  --variantSize <size>   Size label to resolve from stored variant_map or variants.json.
  --topLatency <n>       Run against the top N slow AOP product types.
  --out <path>           Local JSON summary output path.
  --pretty               Pretty-print JSON output.
  --help                 Show this help.

Required environment variables:
  DATABASE_URL
  PRINTIFY_API_TOKEN
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_AOP_CALIBRATION_BUCKET (optional, defaults to aop-calibration)

Supabase setup:
  Create a public Storage bucket named "aop-calibration" or the value of
  SUPABASE_AOP_CALIBRATION_BUCKET before running this script.
`);
}

function validateRequiredEnv() {
  const required = [
    "DATABASE_URL",
    "PRINTIFY_API_TOKEN",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length === 0) return;

  console.error("[run-aop-calibration] Missing required environment variable(s):");
  for (const key of missing) console.error(`  - ${key}`);
  console.error(`  - SUPABASE_AOP_CALIBRATION_BUCKET is optional and currently "${CALIBRATION_BUCKET}"`);
  console.error("\nRun with --help to see usage and setup notes.");
  throw new Error(`Missing required env vars: ${missing.join(", ")}`);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function bufferToPngDataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
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

async function ensureTables(pool: pg.Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "aop_calibration_runs" (
      "id"                   VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      "product_type_id"      INTEGER,
      "blueprint_id"         INTEGER NOT NULL,
      "provider_id"          INTEGER NOT NULL,
      "variant_id"           INTEGER,
      "size"                 TEXT,
      "status"               TEXT NOT NULL DEFAULT 'pending',
      "printify_product_id"  TEXT,
      "printify_mockup_urls" JSONB,
      "print_areas_payload"  JSONB,
      "export_url"           TEXT,
      "error"                TEXT,
      "created_at"           TIMESTAMP DEFAULT NOW() NOT NULL,
      "updated_at"           TIMESTAMP DEFAULT NOW() NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "aop_calibration_panels" (
      "id"                    VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      "run_id"                VARCHAR NOT NULL REFERENCES "aop_calibration_runs"("id") ON DELETE CASCADE,
      "panel_key"             TEXT NOT NULL,
      "width"                 INTEGER NOT NULL,
      "height"                INTEGER NOT NULL,
      "calibration_image_url" TEXT NOT NULL,
      "placement"             JSONB,
      "created_at"            TIMESTAMP DEFAULT NOW() NOT NULL
    )
  `);
  await pool.query(`ALTER TABLE "aop_calibration_runs" ADD COLUMN IF NOT EXISTS "export_url" TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS "aop_calibration_runs_product_type_idx" ON "aop_calibration_runs" ("product_type_id")`);
  await pool.query(`CREATE INDEX IF NOT EXISTS "aop_calibration_runs_created_idx" ON "aop_calibration_runs" ("created_at")`);
  await pool.query(`CREATE INDEX IF NOT EXISTS "aop_calibration_panels_run_idx" ON "aop_calibration_panels" ("run_id")`);
  await pool.query(`CREATE INDEX IF NOT EXISTS "aop_calibration_panels_panel_key_idx" ON "aop_calibration_panels" ("panel_key")`);
}

async function printifyRequest<T>(
  pathname: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${PRINTIFY_API_BASE}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Printify ${init.method || "GET"} ${pathname} failed ${res.status}: ${body.slice(0, 700)}`);
  }
  return res.json() as Promise<T>;
}

function dimensionsFromRaw(placeholder: any): { width: number; height: number } | null {
  const width = Number(
    placeholder?.width ??
      placeholder?.print_area_width ??
      placeholder?.printAreaWidth ??
      placeholder?.dimensions?.width ??
      placeholder?.files?.[0]?.width,
  );
  const height = Number(
    placeholder?.height ??
      placeholder?.print_area_height ??
      placeholder?.printAreaHeight ??
      placeholder?.dimensions?.height ??
      placeholder?.files?.[0]?.height,
  );
  return width > 0 && height > 0 ? { width: Math.round(width), height: Math.round(height) } : null;
}

function normalizePlaceholders(rawList: any[], stored: Placeholder[]): Placeholder[] {
  const storedByPosition = new Map(stored.map((p) => [p.position, p]));
  const normalized = rawList
    .map((raw) => {
      const position = String(raw?.position || raw?.name || raw?.id || "").trim();
      if (!position) return null;
      const dimensions = dimensionsFromRaw(raw) || storedByPosition.get(position);
      if (!dimensions) return null;
      return { position, width: dimensions.width, height: dimensions.height, raw };
    })
    .filter(Boolean) as Placeholder[];

  if (normalized.length > 0) return normalized;
  return stored;
}

function variantsList(variantsData: any): any[] {
  const variants = Array.isArray(variantsData?.variants)
    ? variantsData.variants
    : Array.isArray(variantsData)
      ? variantsData
      : [];
  return Array.isArray(variants) ? variants : [];
}

function variantIdOf(variant: any): number {
  return Number(variant?.id ?? variant?.variant_id);
}

function pickVariant(
  variantsData: any,
  options: { variantSize?: string; variantId?: number; blueprintId: number; providerId: number },
): { id: number; title?: string; raw?: any } {
  const variants = variantsList(variantsData);
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error("Printify variants response did not include any variants.");
  }

  if (options.variantId) {
    const exact = variants.find((variant: any) => variantIdOf(variant) === options.variantId);
    if (!exact) throw new Error(`Variant id ${options.variantId} was not found in variants.json.`);
    return { id: options.variantId, title: exact.title, raw: exact };
  }

  const sizeNeedle = options.variantSize?.trim().toLowerCase();
  const defaultZipHoodieL =
    !sizeNeedle &&
    options.blueprintId === ZIP_HOODIE_BLUEPRINT_ID &&
    options.providerId === ZIP_HOODIE_PROVIDER_ID
      ? variants.find((variant: any) => variantIdOf(variant) === ZIP_HOODIE_SIZE_L_VARIANT_ID)
      : null;

  const match = defaultZipHoodieL || (sizeNeedle
    ? variants.find((variant: any) => {
        const haystack = [
          variant.title,
          variant.size,
          ...(Array.isArray(variant.options) ? variant.options.map((option: any) => option?.value || option?.title || option) : []),
        ].join(" ").toLowerCase();
        return haystack.split(/[^a-z0-9]+/i).some((part) => part.toLowerCase() === sizeNeedle) ||
          haystack.includes(`size ${sizeNeedle}`) ||
          haystack.includes(`/${sizeNeedle}`) ||
          haystack.includes(`${sizeNeedle}/`);
      })
    : null);

  const selected = match || variants[0];
  const id = variantIdOf(selected);
  if (!id) throw new Error("Could not determine Printify variant id.");
  return { id, title: selected.title, raw: selected };
}

function pickVariantFromProductType(
  product: ProductTypeRow,
  options: { variantSize?: string; variantId?: number },
): { id: number; providerId: number; key: string; raw: any } | null {
  const variantMap = parseJson<Record<string, any>>(product.variant_map, {});
  const entries = Object.entries(variantMap);
  if (entries.length === 0) return null;

  if (options.variantId) {
    const exact = entries.find(([, value]) => Number(value?.printifyVariantId) === options.variantId);
    if (exact) {
      const [key, value] = exact;
      return {
        id: Number(value.printifyVariantId),
        providerId: Number(value.providerId || product.printify_provider_id),
        key,
        raw: value,
      };
    }
    return null;
  }

  const sizeId = options.variantSize || "default";
  const preferredKeys = [
    `${sizeId}:default`,
    `${sizeId}:`,
    `default:default`,
  ];
  const match = preferredKeys
    .map((key) => [key, variantMap[key]] as const)
    .find(([, value]) => value?.printifyVariantId) ||
    entries.find(([key, value]) => key.startsWith(`${sizeId}:`) && value?.printifyVariantId) ||
    entries.find(([, value]) => value?.printifyVariantId);

  if (!match) return null;
  const [key, value] = match;
  return {
    id: Number(value.printifyVariantId),
    providerId: Number(value.providerId || product.printify_provider_id),
    key,
    raw: value,
  };
}

function placeholderListFromVariantData(variant: any): Placeholder[] {
  const rawPlaceholders = Array.isArray(variant?.placeholders)
    ? variant.placeholders
    : Array.isArray(variant?.print_areas)
      ? variant.print_areas.flatMap((area: any) => area?.placeholders || [])
      : [];
  return normalizePlaceholders(rawPlaceholders, []);
}

function resolvePlaceholdersForVariant(params: {
  storedPlaceholders: Placeholder[];
  mappedVariant?: { raw?: any } | null;
  catalogVariant?: any;
}): Placeholder[] {
  if (params.storedPlaceholders.length > 0) return params.storedPlaceholders;

  const mapped = placeholderListFromVariantData(params.mappedVariant?.raw);
  if (mapped.length > 0) return mapped;

  const catalog = placeholderListFromVariantData(params.catalogVariant);
  if (catalog.length > 0) return catalog;

  return [];
}

function escapeSvg(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function generateCalibrationPanelPng(placeholder: Placeholder, sizeLabel: string): Promise<Buffer> {
  const { width, height, position } = placeholder;
  const minor = Math.max(25, Math.round(Math.min(width, height) / 20));
  const major = minor * 4;
  const fontSize = Math.max(18, Math.round(Math.min(width, height) / 28));
  const anchorSize = Math.max(18, Math.round(minor * 0.7));
  const panelHash = crypto.createHash("sha1").update(position).digest();
  const anchorColors = [
    `rgb(${80 + (panelHash[0] % 120)},${30 + (panelHash[1] % 90)},${170 + (panelHash[2] % 70)})`,
    `rgb(${170 + (panelHash[3] % 70)},${80 + (panelHash[4] % 120)},${30 + (panelHash[5] % 90)})`,
    `rgb(${30 + (panelHash[6] % 90)},${170 + (panelHash[7] % 70)},${80 + (panelHash[8] % 120)})`,
    `rgb(${120 + (panelHash[9] % 90)},${40 + (panelHash[10] % 80)},${120 + (panelHash[11] % 90)})`,
  ];
  const lines: string[] = [];

  for (let x = 0; x <= width; x += minor) {
    const isMajor = x % major === 0;
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="${isMajor ? "#9ca3af" : "#d1d5db"}" stroke-width="${isMajor ? 2 : 1}" />`);
  }
  for (let y = 0; y <= height; y += minor) {
    const isMajor = y % major === 0;
    lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${isMajor ? "#9ca3af" : "#d1d5db"}" stroke-width="${isMajor ? 2 : 1}" />`);
  }
  for (let x = 0; x <= width; x += major) {
    lines.push(`<text x="${Math.min(x + 4, width - 55)}" y="${fontSize + 4}" font-size="${Math.max(12, fontSize * 0.65)}" fill="#111827">x${x}</text>`);
  }
  for (let y = 0; y <= height; y += major) {
    lines.push(`<text x="6" y="${Math.max(fontSize + 8, y - 5)}" font-size="${Math.max(12, fontSize * 0.65)}" fill="#111827">y${y}</text>`);
  }
  for (let x = 0; x <= width; x += major) {
    for (let y = 0; y <= height; y += major) {
      lines.push(`<circle cx="${x}" cy="${y}" r="${Math.max(4, Math.round(minor / 7))}" fill="#ef4444" opacity="0.9" />`);
    }
  }

  const label = `${position} | ${sizeLabel} | ${width}x${height}`;
  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#ffffff" />
      ${lines.join("\n")}
      <line x1="${width / 2}" y1="0" x2="${width / 2}" y2="${height}" stroke="#2563eb" stroke-width="${Math.max(3, Math.round(minor / 8))}" />
      <line x1="0" y1="${height / 2}" x2="${width}" y2="${height / 2}" stroke="#2563eb" stroke-width="${Math.max(3, Math.round(minor / 8))}" />
      <rect x="${anchorSize}" y="${anchorSize}" width="${anchorSize}" height="${anchorSize}" fill="${anchorColors[0]}" stroke="#000000" stroke-width="3" />
      <rect x="${width - anchorSize * 2}" y="${anchorSize}" width="${anchorSize}" height="${anchorSize}" fill="${anchorColors[1]}" stroke="#000000" stroke-width="3" />
      <rect x="${width - anchorSize * 2}" y="${height - anchorSize * 2}" width="${anchorSize}" height="${anchorSize}" fill="${anchorColors[2]}" stroke="#000000" stroke-width="3" />
      <rect x="${anchorSize}" y="${height - anchorSize * 2}" width="${anchorSize}" height="${anchorSize}" fill="${anchorColors[3]}" stroke="#000000" stroke-width="3" />
      <rect x="10" y="${Math.max(10, fontSize * 0.6)}" width="${Math.min(width - 20, label.length * fontSize * 0.58)}" height="${fontSize * 2.2}" rx="8" fill="#ffffff" opacity="0.9" stroke="#111827" />
      <text x="22" y="${Math.max(32, fontSize * 2)}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" fill="#111827">${escapeSvg(label)}</text>
      <rect x="0" y="0" width="${width}" height="${height}" fill="none" stroke="#000000" stroke-width="${Math.max(4, Math.round(minor / 5))}" />
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function uploadCalibrationFile(params: {
  buffer: Buffer;
  objectPath: string;
  contentType: string;
}): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

  if (supabaseUrl && supabaseKey) {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await supabase.storage.from(CALIBRATION_BUCKET).upload(params.objectPath, params.buffer, {
      contentType: params.contentType,
      upsert: false,
    });
    if (error) {
      throw new Error(
        `Supabase calibration upload failed for bucket "${CALIBRATION_BUCKET}" path "${params.objectPath}": ${error.message}. ` +
        `Create a public Supabase Storage bucket named "${CALIBRATION_BUCKET}" manually if it does not exist.`,
      );
    }
    const { data } = supabase.storage.from(CALIBRATION_BUCKET).getPublicUrl(params.objectPath);
    return data.publicUrl;
  }

  console.warn(
    `[run-aop-calibration] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured; writing calibration artifact locally instead of bucket "${CALIBRATION_BUCKET}".`,
  );
  const localPath = path.join(LOCAL_OUTPUT_DIR, params.objectPath);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  try {
    await fs.access(localPath);
    throw new Error(`Refusing to overwrite existing local calibration artifact: ${localPath}`);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.writeFile(localPath, params.buffer);
  return localPath;
}

function sanitizeObjectName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "artifact";
}

async function uploadMockupImagesToCalibrationBucket(
  runId: string,
  mockupImages: Array<{ url: string; label?: string }> | undefined,
): Promise<string[]> {
  if (!mockupImages?.length) return [];

  const uploadedUrls: string[] = [];
  for (let i = 0; i < mockupImages.length; i++) {
    const image = mockupImages[i];
    if (!image?.url) continue;
    try {
      const response = await fetch(image.url);
      if (!response.ok) throw new Error(`fetch ${response.status}`);
      const input = Buffer.from(await response.arrayBuffer());
      const png = await sharp(input).png().toBuffer();
      const viewName = sanitizeObjectName(image.label || `view_${i + 1}`);
      const publicUrl = await uploadCalibrationFile({
        buffer: png,
        objectPath: `runs/${runId}/mockups/${viewName}.png`,
        contentType: "image/png",
      });
      uploadedUrls.push(publicUrl);
    } catch (error: any) {
      console.warn(`[run-aop-calibration] Could not store mockup image "${image.url}" in calibration bucket:`, error?.message || error);
      uploadedUrls.push(image.url);
    }
  }
  return uploadedUrls;
}

async function waitForMockupJob(jobId: string): Promise<NonNullable<ReturnType<typeof getMockupJob>>> {
  const started = Date.now();
  const timeoutMs = 150_000;
  while (Date.now() - started < timeoutMs) {
    const job = getMockupJob(jobId);
    if (job && (job.status === "done" || job.status === "failed")) return job as any;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Mockup job ${jobId} did not finish within ${Math.round(timeoutMs / 1000)}s.`);
}

async function loadProducts(pool: pg.Pool): Promise<ProductTypeRow[]> {
  const productTypeId = argValue("productTypeId");
  const blueprintId = argValue("blueprintId");
  const topLatency = Number(argValue("topLatency") || 0);

  if (topLatency > 0) {
    const result = await pool.query(
      `SELECT pt.*, m.printify_api_token, m.printify_shop_id,
              AVG(EXTRACT(EPOCH FROM (gj.updated_at - gj.created_at))) AS avg_latency_seconds
       FROM product_types pt
       LEFT JOIN merchants m ON m.id = pt.merchant_id
       LEFT JOIN generation_jobs gj ON gj.product_type_id IN (pt.id::text, pt.id::varchar)
       WHERE pt.is_all_over_print = true
         AND pt.printify_blueprint_id IS NOT NULL
         AND pt.printify_provider_id IS NOT NULL
       GROUP BY pt.id, m.printify_api_token, m.printify_shop_id
       ORDER BY avg_latency_seconds DESC NULLS LAST, pt.updated_at DESC
       LIMIT $1`,
      [topLatency],
    );
    return result.rows;
  }

  const query = productTypeId
    ? {
        text: `SELECT pt.*, m.printify_api_token, m.printify_shop_id
               FROM product_types pt
               LEFT JOIN merchants m ON m.id = pt.merchant_id
               WHERE pt.id = $1
               LIMIT 1`,
        values: [Number(productTypeId)],
      }
    : {
        text: `SELECT pt.*, m.printify_api_token, m.printify_shop_id
               FROM product_types pt
               LEFT JOIN merchants m ON m.id = pt.merchant_id
               WHERE pt.printify_blueprint_id = $1
               ORDER BY pt.is_all_over_print DESC, pt.updated_at DESC
               LIMIT 1`,
        values: [Number(blueprintId || 451)],
      };

  const result = await pool.query(query);
  return result.rows;
}

async function runOne(pool: pg.Pool, product: ProductTypeRow): Promise<RunResult> {
  const blueprintId = Number(product.printify_blueprint_id);
  const providerId = Number(product.printify_provider_id);
  const token = product.printify_api_token || process.env.PRINTIFY_API_TOKEN;
  const shopId = product.printify_shop_id || process.env.PRINTIFY_SHOP_ID;
  const variantSize = argValue("variantSize");
  const variantIdArg = argValue("variantId");
  const requestedVariantId = variantIdArg ? Number(variantIdArg) : undefined;
  const sizeLabel = variantSize || "default";
  if (variantIdArg && !requestedVariantId) throw new Error(`Invalid --variantId value: ${variantIdArg}`);

  if (!blueprintId || !providerId) throw new Error(`Product type ${product.id} is missing Printify blueprint/provider ids.`);
  if (!token || !shopId) throw new Error("Printify token/shop id are required from merchant record or PRINTIFY_API_TOKEN/PRINTIFY_SHOP_ID.");

  const storedPlaceholders = parseJson<any[]>(product.placeholder_positions, []).map((pos: any) => ({
    position: String(pos.position),
    width: Number(pos.width),
    height: Number(pos.height),
    raw: pos,
  })).filter((pos) => pos.position && pos.width > 0 && pos.height > 0) as Placeholder[];

  const runResult = await pool.query(
    `INSERT INTO aop_calibration_runs (product_type_id, blueprint_id, provider_id, size, status)
     VALUES ($1, $2, $3, $4, 'started')
     RETURNING id`,
    [product.id, blueprintId, providerId, variantSize || null],
  );
  const runId = String(runResult.rows[0].id);

  try {
    const variantsData = await printifyRequest<any>(
      `/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json`,
      token,
    );
    const mappedVariant = pickVariantFromProductType(product, { variantSize, variantId: requestedVariantId });
    const variant = mappedVariant || pickVariant(variantsData, {
      variantSize,
      variantId: requestedVariantId,
      blueprintId,
      providerId,
    });
    const effectiveProviderId = mappedVariant?.providerId || providerId;
    const catalogVariant = variantsList(variantsData).find((candidate) => variantIdOf(candidate) === variant.id) || variant.raw;
    await pool.query(
      `UPDATE aop_calibration_runs SET variant_id = $2, provider_id = $3, updated_at = NOW() WHERE id = $1`,
      [runId, variant.id, effectiveProviderId],
    );

    const placeholders = resolvePlaceholdersForVariant({
      storedPlaceholders,
      mappedVariant,
      catalogVariant,
    });
    if (placeholders.length === 0) {
      throw new Error(
        "No placeholder dimensions found from product_types.placeholder_positions, product_types.variant_map, or variants.json.",
      );
    }

    const panelRecords: PanelRecord[] = [];
    const panelUrls: { position: string; dataUrl: string }[] = [];

    for (const placeholder of placeholders) {
      const safePanelKey = sanitizeObjectName(placeholder.position);
      const objectPath = `runs/${runId}/panels/${safePanelKey}.png`;
      const buffer = await generateCalibrationPanelPng(placeholder, sizeLabel);
      const calibrationImageUrl = await uploadCalibrationFile({ buffer, objectPath, contentType: "image/png" });
      const dataUrl = bufferToPngDataUrl(buffer);
      const placement = {
        placeholderRaw: placeholder.raw || null,
        storageBucket: CALIBRATION_BUCKET,
        storagePath: objectPath,
        pipeline: "enqueueMockupJob -> generatePrintifyMockup",
      };

      await pool.query(
        `INSERT INTO aop_calibration_panels (run_id, panel_key, width, height, calibration_image_url, placement)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [runId, placeholder.position, placeholder.width, placeholder.height, calibrationImageUrl, placement],
      );

      panelRecords.push({ ...placeholder, calibrationImageUrl, placement });
      panelUrls.push({ position: placeholder.position, dataUrl });
    }

    await pool.query(
      `UPDATE aop_calibration_runs
       SET status = 'mockups_requested', updated_at = NOW()
       WHERE id = $1`,
      [runId],
    );

    let capturedPrintAreasPayload: unknown = null;
    let printifyProductId: string | null = null;
    const correlationId = `aop_calibration_${runId}`;
    const { jobId, cached } = await enqueueMockupJob({
      blueprintId,
      providerId: effectiveProviderId,
      variantId: variant.id,
      imageUrl: panelUrls[0]?.dataUrl || "data:image/png;base64,",
      printifyApiToken: token,
      printifyShopId: shopId,
      scale: 1,
      x: 0,
      y: 0,
      doubleSided: true,
      wrapAround: false,
      aopPositions: placeholders.map(({ position, width, height }) => ({ position, width, height })),
      panelUrls,
      internalProductTitle: `INTERNAL CALIBRATION DO NOT PUBLISH - ${product.name} - ${runId}`,
      internalProductDescription: `Internal AOP calibration capture run ${runId}. Temporary Printify product for mockup mapping only; do not publish.`,
      internalProductTags: ["INTERNAL_CALIBRATION", "DO_NOT_PUBLISH", "APPAI"],
      onPrintifyProductPayload: (payload) => {
        capturedPrintAreasPayload = (payload as any)?.print_areas || null;
      },
      onPrintifyProductCreated: (productId) => {
        printifyProductId = productId;
      },
    }, {
      correlationId,
      cacheParts: {
        calibrationRunId: runId,
        productTypeId: product.id,
        sizeId: variantSize || "default",
        variantKey: mappedVariant?.key || null,
      },
    });

    const finalJob = cached
      ? { status: "done", mockupUrls: cached.mockupUrls, mockupImages: cached.mockupImages, error: cached.error, source: cached.source }
      : await waitForMockupJob(jobId);

    if (finalJob.status !== "done") {
      throw new Error(finalJob.error || `Mockup job ${jobId} failed.`);
    }

    const mockupUrls = await uploadMockupImagesToCalibrationBucket(runId, finalJob.mockupImages);
    const persistedMockupUrls = mockupUrls.length > 0 ? mockupUrls : (finalJob.mockupUrls || []);
    await pool.query(
      `UPDATE aop_calibration_runs
       SET printify_product_id = $2, printify_mockup_urls = $3, print_areas_payload = $4, status = 'completed', updated_at = NOW()
       WHERE id = $1`,
      [runId, printifyProductId, JSON.stringify(persistedMockupUrls), JSON.stringify(capturedPrintAreasPayload)],
    );

    return {
      runId,
      productTypeId: product.id,
      blueprintId,
      providerId: effectiveProviderId,
      variantId: variant.id,
      size: variantSize || null,
      printifyProductId,
      mockupJobId: jobId,
      mockupUrlCount: persistedMockupUrls.length,
      mockupUrls: persistedMockupUrls,
      panelCount: panelRecords.length,
      status: "completed",
    };
  } catch (error: any) {
    await pool.query(
      `UPDATE aop_calibration_runs
       SET status = 'failed', error = $2, updated_at = NOW()
       WHERE id = $1`,
      [runId, error?.message || String(error)],
    );
    throw error;
  }
}

async function main() {
  if (hasFlag("help")) {
    printHelp();
    return;
  }
  validateRequiredEnv();

  const pool = makePool();
  try {
    await ensureTables(pool);
    const products = await loadProducts(pool);
    if (products.length === 0) throw new Error("No matching AOP product type found.");

    const results: RunResult[] = [];
    for (const product of products) {
      results.push(await runOne(pool, product));
    }

    const firstRunId = results[0]?.runId || crypto.randomUUID();
    const outPath = argValue("out") || path.join(LOCAL_OUTPUT_DIR, `run-summary-${firstRunId}.json`);
    const initialOutput = { results };
    const initialJson = JSON.stringify(initialOutput, null, hasFlag("pretty") ? 2 : 0);
    let exportUrl: string | null = null;
    try {
      exportUrl = await uploadCalibrationFile({
        buffer: Buffer.from(initialJson, "utf8"),
        objectPath: `runs/${firstRunId}/export.json`,
        contentType: "application/json",
      });
      await pool.query(
        `UPDATE aop_calibration_runs SET export_url = $2, updated_at = NOW() WHERE id = $1`,
        [firstRunId, exportUrl],
      );
    } catch (error: any) {
      console.warn(`[run-aop-calibration] Could not upload export JSON to "${CALIBRATION_BUCKET}" bucket:`, error?.message || error);
    }

    const output = {
      results: results.map((result) => ({
        ...result,
        jsonExportPath: outPath,
        exportUrl: result.runId === firstRunId ? exportUrl : null,
      })),
    };
    const json = JSON.stringify(output, null, hasFlag("pretty") ? 2 : 0);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    try {
      await fs.access(outPath);
      throw new Error(`Refusing to overwrite existing local export: ${outPath}`);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.writeFile(outPath, json, "utf8");
    console.log(json);
    console.error(`\n[run-aop-calibration] Wrote ${outPath}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[run-aop-calibration] Failed:", error);
  process.exit(1);
});
