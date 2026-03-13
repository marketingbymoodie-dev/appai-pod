import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BUCKET = process.env.SUPABASE_DESIGNS_BUCKET ?? "designs";

const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

export function isSupabaseDesignsConfigured(): boolean {
  return !!(supabase && SUPABASE_URL && SUPABASE_KEY);
}

/**
 * Upload a design image and its thumbnail to Supabase Storage.
 * Returns public URLs for both. Returns null if Supabase is not configured.
 */
export async function uploadDesignToSupabase(params: {
  imageBuffer: Buffer;
  thumbnailBuffer: Buffer;
  imageId: string;
  extension: "png" | "jpg";
}): Promise<{ imageUrl: string; thumbnailUrl: string } | null> {
  if (!supabase) return null;

  const { imageBuffer, thumbnailBuffer, imageId, extension } = params;
  const filename = `${imageId}.${extension}`;
  const thumbFilename = `thumb_${imageId}.jpg`;

  const contentType = extension === "png" ? "image/png" : "image/jpeg";

  const [imageResult, thumbResult] = await Promise.all([
    supabase.storage.from(BUCKET).upload(filename, imageBuffer, {
      contentType,
      upsert: true,
    }),
    supabase.storage.from(BUCKET).upload(thumbFilename, thumbnailBuffer, {
      contentType: "image/jpeg",
      upsert: true,
    }),
  ]);

  if (imageResult.error) throw new Error(`Supabase design upload failed: ${imageResult.error.message}`);
  if (thumbResult.error) throw new Error(`Supabase thumbnail upload failed: ${thumbResult.error.message}`);

  const { data: imageData } = supabase.storage.from(BUCKET).getPublicUrl(filename);
  const { data: thumbData } = supabase.storage.from(BUCKET).getPublicUrl(thumbFilename);

  return {
    imageUrl: imageData.publicUrl,
    thumbnailUrl: thumbData.publicUrl,
  };
}

/**
 * Upload a single file (e.g. pattern) to the designs bucket.
 */
export async function uploadDesignFileToSupabase(params: {
  buffer: Buffer;
  filename: string;
  contentType: string;
}): Promise<string | null> {
  if (!supabase) return null;

  const { buffer, filename, contentType } = params;

  const { error } = await supabase.storage.from(BUCKET).upload(filename, buffer, {
    contentType,
    upsert: true,
  });

  if (error) throw new Error(`Supabase design file upload failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(filename);
  return data.publicUrl;
}

/**
 * Get the public URL for a design file if it exists in Supabase.
 * Use for redirect fallback when local file is missing.
 */
export function getSupabaseDesignPublicUrl(filename: string): string | null {
  if (!supabase) return null;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(filename);
  return data.publicUrl;
}
