/**
 * Supabase storage helpers for flat/mesh on-the-fly mockup calibration assets.
 *
 * At Printify import time `server/flat-calibration.ts` harvests, per product:
 *   - `products/<ptId>/mask-<view>.png`         — white-on-transparent print silhouette
 *   - `products/<ptId>/shading-<view>.png`      — gray-pass shading transfer map
 *   - `products/<ptId>/blank-<id>-<view>.png`   — plain garment photo per color/model
 *   - `products/<ptId>/calibration.json`        — full manifest (also stored on product_types)
 *
 * to the Supabase bucket configured by `SUPABASE_FLAT_CALIBRATION_BUCKET`
 * (default `flat-calibration`). The storefront renderer fetches the mask /
 * shading / blank PNGs at customize time to composite the live preview.
 *
 * Mirrors `server/supabaseHoodieTemplates.ts`. Same free-tier caveat applies:
 * the project can pause after inactivity; the renderer should tolerate brief
 * fetch failures and fall back to Printify mockups.
 */
// Ensure .env is loaded (dev) BEFORE this module reads process.env. load-env
// uses a top-level await, so modules that read env at import time without this
// side-effect import race ahead of it and see empty values in dev (see the
// "[SupabaseMockups] … not set" warning). We ALSO read env lazily below so the
// check is correct regardless of import order.
import "./load-env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Bucket name (read lazily so dev env timing can't leave it stale). */
export function flatCalibrationBucketName(): string {
  return process.env.SUPABASE_FLAT_CALIBRATION_BUCKET ?? "flat-calibration";
}
/** Back-compat constant (resolved at module load, after load-env completes). */
export const FLAT_CALIBRATION_BUCKET = flatCalibrationBucketName();

let _client: SupabaseClient | null | undefined;

function client(): SupabaseClient | null {
  if (_client !== undefined) return _client;
  const url = process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    _client = null;
    return null;
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

export function isSupabaseFlatCalibrationConfigured(): boolean {
  return client() !== null;
}

/**
 * Ensure the bucket exists with public-read access. Idempotent — safe to call
 * before every harvest run.
 */
export async function ensureFlatCalibrationBucket(): Promise<void> {
  const c = client();
  if (!c) throw new Error("Supabase is not configured (missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)");
  const { data: existing } = await c.storage.getBucket(FLAT_CALIBRATION_BUCKET);
  if (existing) return;
  const { error } = await c.storage.createBucket(FLAT_CALIBRATION_BUCKET, {
    public: true,
    fileSizeLimit: "30MB",
  });
  if (error) throw new Error(`createBucket failed: ${error.message}`);
}

/**
 * Upload a buffer to a path inside the bucket (upsert). Returns the public URL
 * that any storefront can GET without auth.
 */
export async function uploadToFlatCalibrationBucket(
  filename: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  const c = client();
  if (!c) throw new Error("Supabase is not configured");
  const { error } = await c.storage
    .from(FLAT_CALIBRATION_BUCKET)
    .upload(filename, data, { contentType, upsert: true });
  if (error) throw new Error(`upload(${filename}) failed: ${error.message}`);
  const { data: url } = c.storage.from(FLAT_CALIBRATION_BUCKET).getPublicUrl(filename);
  return url.publicUrl;
}

/** Public URL builder (no I/O). */
export function publicFlatCalibrationUrl(filename: string): string | null {
  const c = client();
  if (!c) return null;
  const { data } = c.storage.from(FLAT_CALIBRATION_BUCKET).getPublicUrl(filename);
  return data.publicUrl;
}

/** List all file paths under a prefix (recursive). */
export async function listFlatCalibrationFiles(prefix: string): Promise<string[]> {
  const c = client();
  if (!c) throw new Error("Supabase is not configured");
  const paths: string[] = [];

  async function walk(dir: string): Promise<void> {
    let offset = 0;
    const limit = 100;
    for (;;) {
      const { data, error } = await c!.storage.from(FLAT_CALIBRATION_BUCKET).list(dir, {
        limit,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`list(${dir}) failed: ${error.message}`);
      if (!data?.length) break;
      for (const entry of data) {
        const child = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.metadata) paths.push(child);
        else await walk(child);
      }
      if (data.length < limit) break;
      offset += limit;
    }
  }

  await walk(prefix);
  return paths;
}

/** Delete every object under a prefix. Returns count removed. */
export async function deleteFlatCalibrationAssetsByPrefix(prefix: string): Promise<number> {
  const c = client();
  if (!c) throw new Error("Supabase is not configured");
  const files = await listFlatCalibrationFiles(prefix);
  if (files.length === 0) return 0;
  const batchSize = 100;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const { error } = await c.storage.from(FLAT_CALIBRATION_BUCKET).remove(batch);
    if (error) throw new Error(`remove(${prefix}) failed: ${error.message}`);
  }
  return files.length;
}

/** Delete every object under `products/{productTypeId}/`. Returns count removed. */
export async function deleteFlatCalibrationProductAssets(productTypeId: number): Promise<number> {
  return deleteFlatCalibrationAssetsByPrefix(`products/${productTypeId}`);
}

export async function downloadFlatCalibrationFile(filename: string): Promise<Buffer | null> {
  const c = client();
  if (!c) return null;
  const { data, error } = await c.storage.from(FLAT_CALIBRATION_BUCKET).download(filename);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}
