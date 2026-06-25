/**
 * Supabase storage helpers for *published* hoodie panel-mapping templates.
 *
 * The admin authoring tool (`/hoodie-template-mapper`) saves templates to the
 * local filesystem (`tmp/hoodie-templates/`). When the admin is happy with a
 * template they "publish" it via `scripts/publish-hoodie-template.ts`, which
 * uploads:
 *
 *   - `templates/<name>.json`            — sanitised customer-facing copy
 *   - `mockups/<name>-front.png`         — base hoodie mockup (front view)
 *   - `mockups/<name>-back.png`          — base hoodie mockup (back view)
 *
 * to the Supabase bucket configured by `SUPABASE_HOODIE_TEMPLATES_BUCKET`
 * (default `hoodie-templates`). The storefront then fetches them at request
 * time via `server/hoodieTemplateStore.ts`.
 *
 * NOTE: while we are still on Supabase free tier the project can pause after
 * inactivity and break customer-facing template loads. The store layer caches
 * fetched templates in memory with a TTL to soften brief pauses, and once
 * we're on pro this concern goes away.
 */
import "./load-env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

export function hoodieTemplatesBucketName(): string {
  return process.env.SUPABASE_HOODIE_TEMPLATES_BUCKET ?? "hoodie-templates";
}

/** @deprecated prefer hoodieTemplatesBucketName() — resolved lazily after .env load */
export const HOODIE_TEMPLATES_BUCKET = hoodieTemplatesBucketName();

export function isSupabaseHoodieTemplatesConfigured(): boolean {
  return client() !== null;
}

/**
 * Ensure the bucket exists with public-read access. Idempotent — safe to
 * call from the publish script every run.
 */
export async function ensureHoodieTemplatesBucket(): Promise<void> {
  const c = client();
  if (!c) throw new Error("Supabase is not configured (missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)");
  const bucket = hoodieTemplatesBucketName();
  const { data: existing } = await c.storage.getBucket(bucket);
  if (existing) return;
  const { error } = await c.storage.createBucket(bucket, {
    public: true,
    // Storefront only ever reads, but allow generous body size for admin
    // PNG re-publishes (mockups can hit 2-3 MB).
    fileSizeLimit: "30MB",
  });
  if (error) throw new Error(`createBucket failed: ${error.message}`);
}

/**
 * Upload a buffer to a path inside the bucket (upsert). Returns the public
 * URL that any storefront can GET without auth.
 */
export async function uploadToHoodieTemplatesBucket(
  filename: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  const c = client();
  if (!c) throw new Error("Supabase is not configured");
  const bucket = hoodieTemplatesBucketName();
  const { error } = await c.storage
    .from(bucket)
    .upload(filename, data, { contentType, upsert: true });
  if (error) throw new Error(`upload(${filename}) failed: ${error.message}`);
  const { data: url } = c.storage.from(bucket).getPublicUrl(filename);
  return url.publicUrl;
}

/** Public URL builder (no I/O) — used by the loader to know where to fetch from. */
export function publicHoodieTemplateUrl(filename: string): string | null {
  const c = client();
  if (!c) return null;
  const bucket = hoodieTemplatesBucketName();
  const { data } = c.storage.from(bucket).getPublicUrl(filename);
  return data.publicUrl;
}
