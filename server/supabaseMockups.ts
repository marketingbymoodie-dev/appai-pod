import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BUCKET = process.env.SUPABASE_BUCKET ?? "mockups";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('[SupabaseMockups] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — mockup caching disabled');
} else {
  console.log('[SupabaseMockups] Supabase configured. URL:', SUPABASE_URL.substring(0, 40), 'Bucket:', BUCKET);
}

const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-]/g, "_").substring(0, 120);
}

/**
 * Deterministically construct the public URL for a cached mockup.
 * Returns null if Supabase is not configured.
 */
export function getSupabasePublicUrl(designId: string, viewName: string): string | null {
  if (!supabase) return null;
  const safeName = sanitizeFilename(viewName);
  const storagePath = `designs/${designId}/${safeName}.jpg`;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

export async function uploadMockupToSupabase({
  sourceUrl,
  designId,
  viewName,
  buffer,
}: {
  sourceUrl?: string;
  designId: string;
  viewName: string;
  buffer?: Buffer | Uint8Array;
}): Promise<string | null> {
  if (!supabase) return null;

  const safeName = sanitizeFilename(viewName);
  const storagePath = `designs/${designId}/${safeName}.jpg`;

  let bytes: Uint8Array;
  if (buffer) {
    bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  } else if (sourceUrl) {
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`Fetch failed (${response.status})`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    throw new Error("Either sourceUrl or buffer must be provided");
  }

  console.log(`[SupabaseMockups] Uploading ${bytes.length} bytes to ${BUCKET}/${storagePath}`);
  const { error } = await supabase.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: "image/jpeg",
    upsert: true,
  });

  if (error) {
    console.error(`[SupabaseMockups] Upload error for ${storagePath}:`, JSON.stringify(error));
    throw error;
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  console.log(`[SupabaseMockups] Upload success → ${data.publicUrl.substring(0, 80)}`);
  return data.publicUrl;
}
