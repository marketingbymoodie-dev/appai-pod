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

function pickVariant(variantsData: any, variantSize?: string): { id: number; title?: string; raw?: any } {
  const variants = Array.isArray(variantsData?.variants)
    ? variantsData.variants
    : Array.isArray(variantsData)
      ? variantsData
      : [];
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error("Printify variants response did not include any variants.");
  }

  const sizeNeedle = variantSize?.trim().toLowerCase();
  const match = sizeNeedle
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
    : null;

  const selected = match || variants[0];
  const id = Number(selected.id ?? selected.variant_id);
  if (!id) throw new Error("Could not determine Printify variant id.");
  return { id, title: selected.title, raw: selected };
}

function pickVariantFromProductType(product: ProductTypeRow, variantSize?: string): { id: number; providerId: number; key: string; raw: any } | null {
  const variantMap = parseJson<Record<string, any>>(product.variant_map, {});
  const entries = Object.entries(variantMap);
  if (entries.length === 0) return null;

  const sizeId = variantSize || "default";
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
      <rect x="10" y="${Math.max(10, fontSize * 0.6)}" width="${Math.min(width - 20, label.length * fontSize * 0.58)}" height="${fontSize * 2.2}" rx="8" fill="#ffffff" opacity="0.9" stroke="#111827" />
      <text x="22" y="${Math.max(32, fontSize * 2)}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" fill="#111827">${escapeSvg(label)}</text>
      <rect x="0" y="0" width="${width}" height="${height}" fill="none" stroke="#000000" stroke-width="${Math.max(4, Math.round(minor / 5))}" />
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function uploadCalibrationFile(params: {
  buffer: Buffer;
  filename: string;
  contentType: string;
}): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  const bucket = process.env.SUPABASE_DESIGNS_BUCKET || "designs";

  if (supabaseUrl && supabaseKey) {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await supabase.storage.from(bucket).upload(params.filename, params.buffer, {
      contentType: params.contentType,
      upsert: true,
    });
    if (error) throw new Error(`Supabase upload failed: ${error.message}`);
    const { data } = supabase.storage.from(bucket).getPublicUrl(params.filename);
    return data.publicUrl;
  }

  const localPath = path.join(LOCAL_OUTPUT_DIR, params.filename);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, params.buffer);
  return localPath;
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

async function runOne(pool: pg.Pool, product: ProductTypeRow) {
  const blueprintId = Number(product.printify_blueprint_id);
  const providerId = Number(product.printify_provider_id);
  const token = product.printify_api_token || process.env.PRINTIFY_API_TOKEN;
  const shopId = product.printify_shop_id || process.env.PRINTIFY_SHOP_ID;
  const variantSize = argValue("variantSize");
  const sizeLabel = variantSize || "default";

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
    const mappedVariant = pickVariantFromProductType(product, variantSize);
    const variant = mappedVariant || pickVariant(variantsData, variantSize);
    const effectiveProviderId = mappedVariant?.providerId || providerId;
    await pool.query(
      `UPDATE aop_calibration_runs SET variant_id = $2, provider_id = $3, updated_at = NOW() WHERE id = $1`,
      [runId, variant.id, effectiveProviderId],
    );

    const placeholdersResponse = await printifyRequest<any>(
      `/catalog/blueprints/${blueprintId}/print_providers/${effectiveProviderId}/variants/${variant.id}/placeholders.json`,
      token,
    );
    const rawPlaceholders = Array.isArray(placeholdersResponse?.placeholders)
      ? placeholdersResponse.placeholders
      : Array.isArray(placeholdersResponse)
        ? placeholdersResponse
        : [];
    const placeholders = normalizePlaceholders(rawPlaceholders, storedPlaceholders);
    if (placeholders.length === 0) throw new Error("No placeholder dimensions found from Printify or product_types.placeholder_positions.");

    const panelRecords = [];
    const panelUrls: { position: string; dataUrl: string }[] = [];

    for (const placeholder of placeholders) {
      const safePanelKey = placeholder.position.replace(/[^a-z0-9_-]+/gi, "_");
      const filename = `aop-calibration/${runId}/${safePanelKey}-${placeholder.width}x${placeholder.height}.png`;
      const buffer = await generateCalibrationPanelPng(placeholder, sizeLabel);
      const calibrationImageUrl = await uploadCalibrationFile({ buffer, filename, contentType: "image/png" });
      const dataUrl = bufferToPngDataUrl(buffer);
      const placement = {
        placeholderRaw: placeholder.raw || null,
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

    const mockupUrls = finalJob.mockupUrls || [];
    await pool.query(
      `UPDATE aop_calibration_runs
       SET printify_product_id = $2, printify_mockup_urls = $3, print_areas_payload = $4, status = 'completed', updated_at = NOW()
       WHERE id = $1`,
      [runId, printifyProductId, JSON.stringify(mockupUrls), JSON.stringify(capturedPrintAreasPayload)],
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
      mockupUrlCount: mockupUrls.length,
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
  const pool = makePool();
  try {
    await ensureTables(pool);
    const products = await loadProducts(pool);
    if (products.length === 0) throw new Error("No matching AOP product type found.");

    const results = [];
    for (const product of products) {
      results.push(await runOne(pool, product));
    }

    const outPath = argValue("out") || path.join(LOCAL_OUTPUT_DIR, `run-summary-${crypto.randomUUID()}.json`);
    const output = { results: results.map((result) => ({ ...result, jsonExportPath: outPath })) };
    const json = JSON.stringify(output, null, hasFlag("pretty") ? 2 : 0);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
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
