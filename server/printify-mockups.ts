import pRetry from "p-retry";

import crypto from "crypto";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { getStorageDir } from "./replit_integrations/object_storage";
import { uploadMockupToSupabase, getSupabasePublicUrl } from "./supabaseMockups";

interface MockupRequest {
  blueprintId: number;
  providerId: number;
  variantId: number;
  imageUrl: string;
  printifyApiToken: string;
  printifyShopId: string;
  scale?: number; // 0-2 range, default 1
  x?: number; // -1 to 1 range, default 0 (center)
  y?: number; // -1 to 1 range, default 0 (center)
  doubleSided?: boolean; // Send image to both front and back
  /** Wrap-around: product uses a single print area that wraps both sides (e.g. pillows).
   *  When true, the image is duplicated to fill the full wrap area. */
  wrapAround?: boolean;
  /** Direction to duplicate for wrap-around: 'horizontal' (side-by-side) or 'vertical' (top-to-bottom).
   *  Defaults to 'horizontal' if not specified. */
  wrapDirection?: 'horizontal' | 'vertical';
  /** AOP: list of all panel positions to fill with the same image */
  aopPositions?: { position: string; width: number; height: number }[];
  /** AOP: when true, right_* panels will receive a horizontally flipped copy of the pattern */
  mirrorLegs?: boolean;
  /** AOP per-panel images — one data URL per Printify placeholder position.
   *  When provided, each panel gets its own correctly-sized and inseam-aligned image
   *  instead of the same square canvas scaled to fit every panel. */
  panelUrls?: { position: string; dataUrl: string }[];
}

interface MockupImage {
  url: string;
  label: string; // e.g., "front", "back", "lifestyle"
}

interface MockupResult {
  success: boolean;
  mockupUrls: string[];
  mockupImages: MockupImage[];
  source: "printify" | "fallback";
  error?: string;
  step?: "printify_upload" | "temp_product" | "mockup_fetch" | "image_duplicate";
}

interface PrintifyImage {
  id: string;
  file_name: string;
  height: number;
  width: number;
  size: number;
  mime_type: string;
  preview_url: string;
  upload_time: string;
}

const PRINTIFY_API_BASE = "https://api.printify.com/v1";

function isDataUrl(url: string): boolean {
  return url.startsWith("data:");
}

/**
 * Fix accidental double-prefixed URLs (e.g. APP_URL + Supabase URL).
 * Pattern: "https://railway...https://supabase.../path" → "https://supabase.../path"
 */
function normalizeImageUrl(url: string): string {
  if (!url || typeof url !== "string") return url;
  // Detect double URL: our origin + absolute URL
  const secondProto = url.indexOf("https://", 8); // skip first "https://"
  if (secondProto > 0) {
    const fixed = url.slice(secondProto);
    console.warn(`[Printify] Fixed double-prefixed image URL (${url.length} → ${fixed.length} chars)`);
    return fixed;
  }
  const secondHttp = url.indexOf("http://", 7);
  if (secondHttp > 0) {
    const fixed = url.slice(secondHttp);
    console.warn(`[Printify] Fixed double-prefixed image URL (http)`);
    return fixed;
  }
  return url;
}

function extractBase64FromDataUrl(dataUrl: string): string {
  const base64Match = dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
  return base64Match ? base64Match[1] : "";
}

function isAllowedImageUrl(url: string): boolean {
  if (isDataUrl(url)) return true;

  try {
    const parsedUrl = new URL(url);
    const allowedHosts = [
      process.env.REPLIT_DEV_DOMAIN,
      process.env.REPL_SLUG ? `${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co` : null,
      'storage.googleapis.com',
      'up.railway.app', // Railway hosted apps
    ].filter(Boolean);

    return allowedHosts.some(host => host && parsedUrl.hostname.includes(host as string));
  } catch {
    return false;
  }
}


const MAX_RETRIES = 3;
const MAX_MOCKUP_VIEWS = 4;
// For double-sided products, prioritize front and back; for others, prefer lifestyle shots
const PREFERRED_LABELS = ["front", "back", "left", "right", "close-up"];

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Build a deterministic cache key for a single mockup view.
 * Includes the design image hash, blueprint, provider, variant, and label
 * so different designs/products never collide.
 */
function buildMockupCacheKey(
  designImageUrl: string,
  blueprintId: number,
  providerId: number,
  variantId: number,
  label: string,
  scale: number = 1,
  x: number = 0,
  y: number = 0,
  doubleSided: boolean = false,
): string {
  const designHash = crypto.createHash("sha256").update(designImageUrl).digest("hex").substring(0, 12);
  const s = Math.round(scale * 100);
  const px = Math.round(x * 100);
  const py = Math.round(y * 100);
  const ds = doubleSided ? "_ds" : "";
  return `${designHash}_bp${blueprintId}_pr${providerId}_v${variantId}_s${s}_x${px}_y${py}${ds}_${label}`;
}

/**
 * Check if a cached mockup exists on Supabase (via local disk marker).
 * Returns Supabase CDN URL if available, otherwise falls back to /objects/designs/{filename}
 * which is served via the App Proxy route. Returns null on cache miss.
 */
function getCachedMockup(cacheKey: string): string | null {
  const filename = `${cacheKey}.jpg`;
  const filePath = path.join(getStorageDir(), "mockups", filename);
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
  } catch {
    return null;
  }

  const parts = cacheKey.split("_");
  const designId = parts[0] || cacheKey;
  // Include variant (v{id}), transform (s/x/y) and label in the view name so each
  // color+zoom+position combination gets a unique Supabase path and never overwrites another color.
  const viewName = parts.slice(3).join("_") || "front";
  // Prefer Supabase CDN URL; fall back to local designs/ path (served via App Proxy route)
  return getSupabasePublicUrl(designId, viewName) ?? `/objects/designs/${filename}`;
}

/**
 * Pick up to MAX_MOCKUP_VIEWS images, preferring PREFERRED_LABELS in order.
 */
function selectPreferredViews(images: MockupImage[]): MockupImage[] {
  const selected: MockupImage[] = [];
  const used = new Set<number>();

  for (const label of PREFERRED_LABELS) {
    if (selected.length >= MAX_MOCKUP_VIEWS) break;
    const idx = images.findIndex((img, i) => img.label === label && !used.has(i));
    if (idx !== -1) {
      selected.push(images[idx]);
      used.add(idx);
    }
  }

  for (let i = 0; i < images.length && selected.length < MAX_MOCKUP_VIEWS; i++) {
    if (!used.has(i)) {
      selected.push(images[i]);
      used.add(i);
    }
  }

  return selected;
}

async function cacheMockupToStorage(printifyUrl: string, cacheKey: string): Promise<string | null> {
  const parts = cacheKey.split("_");
  const designId = parts[0] || cacheKey;
  // Include variant (v{id}), transform (s/x/y) and label in the view name so each
  // color+zoom+position combination gets a unique Supabase path and never overwrites another color.
  const viewName = parts.slice(3).join("_") || "front";

   // Retry the download to handle Printify CDN propagation delay.
  // The product API lists images immediately but the CDN may not have rendered them yet.
  const MAX_DOWNLOAD_RETRIES = 4;
  const DOWNLOAD_RETRY_DELAYS = [2000, 4000, 6000, 8000]; // ms between retries
  let buffer: Buffer | null = null;
  for (let attempt = 0; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = DOWNLOAD_RETRY_DELAYS[attempt - 1] ?? 8000;
      console.log(`[Mockup Cache] Retry ${attempt}/${MAX_DOWNLOAD_RETRIES} for mockup download in ${delay}ms...`);
      await sleep(delay);
    }
    try {
      const response = await fetch(printifyUrl);
      if (!response.ok) {
        console.warn(`[Mockup Cache] Attempt ${attempt + 1}: Failed to download mockup (${response.status}): ${printifyUrl.substring(0, 80)}`);
        if (attempt < MAX_DOWNLOAD_RETRIES) continue;
        return null;
      }
      const arrayBuffer = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
      console.log(`[Mockup Cache] Downloaded mockup on attempt ${attempt + 1} (${buffer.length} bytes)`);
      break;
    } catch (fetchErr: any) {
      console.warn(`[Mockup Cache] Attempt ${attempt + 1}: Fetch exception: ${fetchErr.message}`);
      if (attempt < MAX_DOWNLOAD_RETRIES) continue;
      return null;
    }
  }
  if (!buffer) return null;
  try {
    const filename = `${cacheKey}.jpg`;

    // Write to local disk in two places:
    // 1. mockups/ subdirectory for getCachedMockup cache-first lookup
    // 2. designs/ subdirectory as fallback serve path (has a working App Proxy route)
    const mockupsDir = path.join(getStorageDir(), "mockups");
    const designsDir = path.join(getStorageDir(), "designs");
    await fs.promises.mkdir(mockupsDir, { recursive: true });
    await fs.promises.mkdir(designsDir, { recursive: true });
    await fs.promises.writeFile(path.join(mockupsDir, filename), buffer);
    // Also write to designs/ so the /api/proxy/objects/designs/:filename proxy route can serve it
    await fs.promises.writeFile(path.join(designsDir, filename), buffer);

    // Upload to Supabase for public CDN URL
    try {
      const publicUrl = await uploadMockupToSupabase({ buffer, designId, viewName });
      if (publicUrl) return publicUrl;
    } catch (err: any) {
      console.warn(`[Mockup Cache] Supabase upload failed (${designId}/${viewName}): ${err.message || err}`);
    }

    // Supabase unavailable/failed — serve from designs/ via the App Proxy route.
    // This is critical: the Printify CDN URL becomes invalid after the temp product is deleted.
    // The designs/ path has a working proxy route: /api/proxy/objects/designs/:filename
    // which Shopify rewrites from /apps/appai/objects/designs/:filename.
    console.warn(`[Mockup Cache] Supabase failed — serving from local designs/: /objects/designs/${filename}`);
    return `/objects/designs/${filename}`;
  } catch (error) {
    console.warn("[Mockup Cache] Download failed, cannot cache mockup");
    return null;
  }
}

async function cacheMockupImages(
  mockupData: { urls: string[]; images: MockupImage[] },
  cacheKeys: string[],
): Promise<{ urls: string[]; images: MockupImage[] }> {
  const cachedUrls: string[] = [];
  const cachedImages: MockupImage[] = [];

  const results = await Promise.allSettled(
    mockupData.images.map((img, i) => cacheMockupToStorage(img.url, cacheKeys[i]))
  );

   for (let i = 0; i < mockupData.images.length; i++) {
    const result = results[i];
    const original = mockupData.images[i];
    if (result.status === "fulfilled" && result.value) {
      cachedUrls.push(result.value);
      cachedImages.push({ url: result.value, label: original.label });
    } else {
      // IMPORTANT: Do NOT fall back to original.url here.
      // The original URL is a Printify CDN URL that requires the temp product to exist.
      // After deleteProduct() runs, that URL returns 400/404.
      // If caching failed, skip this view entirely rather than returning a broken URL.
      console.warn(`[Mockup Cache] Skipping view "${original.label}" — caching failed and original URL would be invalid after product deletion`);
    }
  }

  return { urls: cachedUrls, images: cachedImages };
}

async function uploadImageToPrintify(
  imageUrlOrBuffer: string | Buffer,
  apiToken: string
): Promise<PrintifyImage | null> {
  let requestBody: Record<string, string>;
  let uploadMethod: string;

  if (Buffer.isBuffer(imageUrlOrBuffer)) {
    const base64Data = imageUrlOrBuffer.toString('base64');
    uploadMethod = `buffer (${base64Data.length} chars base64)`;
    requestBody = {
      file_name: `design-${Date.now()}.png`,
      contents: base64Data,
    };
  } else if (isDataUrl(imageUrlOrBuffer)) {
    const base64Data = extractBase64FromDataUrl(imageUrlOrBuffer);
    if (!base64Data) {
      console.error("[Printify Upload] Failed to extract base64 from data URL");
      return null;
    }
    uploadMethod = `data-url (${base64Data.length} chars base64)`;
    requestBody = {
      file_name: `design-${Date.now()}.png`,
      contents: base64Data,
    };
  } else {
    uploadMethod = `url: ${imageUrlOrBuffer.substring(0, 100)}`;
    requestBody = {
      file_name: `design-${Date.now()}.png`,
      url: imageUrlOrBuffer,
    };
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[Printify Upload] Attempt ${attempt}/${MAX_RETRIES} via ${uploadMethod}`);

      const response = await fetch(`${PRINTIFY_API_BASE}/uploads/images.json`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Printify Upload] Attempt ${attempt} failed (${response.status}):`, errorText.substring(0, 500));
        // 4xx = client error, not retryable
        if (response.status >= 400 && response.status < 500) return null;
        if (attempt < MAX_RETRIES) { await sleep(1000 * Math.pow(2, attempt - 1)); continue; }
        return null;
      }

      const result = await response.json();
      console.log(`[Printify Upload] Success on attempt ${attempt}: id=${result.id}, ${result.width}x${result.height}`);
      return result;
    } catch (error) {
      console.error(`[Printify Upload] Attempt ${attempt} exception:`, error);
      if (attempt < MAX_RETRIES) { await sleep(1000 * Math.pow(2, attempt - 1)); continue; }
      return null;
    }
  }
  return null;
}

async function createTemporaryProduct(
  shopId: string,
  blueprintId: number,
  providerId: number,
  variantId: number,
  imageId: string,
  apiToken: string,
  scale: number = 1,
  x: number = 0,
  y: number = 0,
  doubleSided: boolean = false,
  aopPositions?: { position: string; width: number; height: number }[],
  mirroredImageId?: string,
  /** Per-panel image IDs — when provided, each panel uses its own uploaded image */
  panelImageIds?: Map<string, string>
): Promise<{ productId: string } | { error: string }> {
  const printifyX = 0.5 + (x * 0.5);
  const printifyY = 0.5 + (y * 0.5);

  const imageEntry = { id: imageId, x: printifyX, y: printifyY, scale: scale, angle: 0 };
  const placeholders: Array<{ position: string; images: typeof imageEntry[] }> = [];

  if (aopPositions && aopPositions.length > 0) {
    // AOP: use per-panel image IDs if available, otherwise fall back to same image for all panels
    for (const pos of aopPositions) {
      const isRightPanel = pos.position.startsWith("right");
      let useImageId: string;
      if (panelImageIds && panelImageIds.has(pos.position)) {
        // Per-panel image: already correctly sized and inseam-aligned by the client canvas.
        // Use scale=100, x=0.5, y=0.5 so Printify fills the panel exactly without any
        // additional scaling or offset. Using the user's placeScale/x/y here would cause
        // double-scaling (artwork scaled once in the canvas, then again by Printify).
        useImageId = panelImageIds.get(pos.position)!;
        const panelEntry = { id: useImageId, x: 0.5, y: 0.5, scale: 100, angle: 0 };
        placeholders.push({ position: pos.position, images: [panelEntry] });
        continue;
      } else if (isRightPanel && mirroredImageId) {
        // Legacy fallback: mirrored copy for right panels
        useImageId = mirroredImageId;
      } else {
        useImageId = imageId;
      }
      const entry = { ...imageEntry, id: useImageId };
      placeholders.push({ position: pos.position, images: [entry] });
    }
  } else {
    // Standard single/double-sided
    placeholders.push({ position: "front", images: [imageEntry] });
    if (doubleSided) {
      placeholders.push({ position: "back", images: [imageEntry] });
    }
  }

  const requestBody = {
    title: `Mockup Preview - ${Date.now()}`,
    description: "Temporary product for mockup generation",
    blueprint_id: blueprintId,
    print_provider_id: providerId,
    variants: [{ id: variantId, price: 100, is_enabled: true }],
    print_areas: [{ variant_ids: [variantId], placeholders }],
  };

  console.log(`[Printify CreateProduct] doubleSided=${doubleSided}, aopPositions=${JSON.stringify(aopPositions || null)}, placeholders=${JSON.stringify(placeholders.map(p => p.position))}`);
  console.log(`[Printify CreateProduct] Full print_areas:`, JSON.stringify(requestBody.print_areas, null, 2));

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[Printify] Creating temp product (attempt ${attempt}/${MAX_RETRIES}):`, {
        shopId, blueprintId, providerId, variantId, imageId, scale, x: printifyX, y: printifyY, doubleSided,
      });

      const response = await fetch(
        `${PRINTIFY_API_BASE}/shops/${shopId}/products.json`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Printify] Attempt ${attempt} create product failed (${response.status}):`, errorText.substring(0, 500));
        // 4xx = client error, not retryable
        if (response.status >= 400 && response.status < 500) {
          return { error: `Printify rejected product (${response.status}): ${errorText.substring(0, 200)}` };
        }
        if (attempt < MAX_RETRIES) { await sleep(1000 * Math.pow(2, attempt - 1)); continue; }
        return { error: `Printify server error after ${MAX_RETRIES} attempts (${response.status})` };
      }

      const product = await response.json();
      console.log(`[Printify] Temp product created on attempt ${attempt}:`, product.id);
      return { productId: product.id };
    } catch (error: any) {
      console.error(`[Printify] Attempt ${attempt} create product exception:`, error);
      if (attempt < MAX_RETRIES) { await sleep(1000 * Math.pow(2, attempt - 1)); continue; }
      return { error: `Exception after ${MAX_RETRIES} attempts: ${error.message || String(error)}` };
    }
  }
  return { error: "Unexpected: exhausted retries" };
}

function extractCameraLabel(url: string): string {
  const match = url.match(/camera_label=([^&]+)/);
  if (match) {
    return match[1];
  }
  return "front";
}

async function getProductMockups(
  shopId: string,
  productId: string,
  apiToken: string
): Promise<{ urls: string[]; images: MockupImage[] } | null> {
  try {
    const response = await fetch(
      `${PRINTIFY_API_BASE}/shops/${shopId}/products/${productId}.json`,
      {
        headers: {
          "Authorization": `Bearer ${apiToken}`,
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    const product = await response.json();
    console.log("PRINTIFY PRODUCT KEYS:", Object.keys(product));
    console.log("BLUEPRINT ID:", product.blueprint_id);
    console.log("PRINT PROVIDER ID:", product.print_provider_id);
    console.log("PRINT AREAS:", JSON.stringify(product.print_areas, null, 2));
    console.log("PLACEHOLDERS:", JSON.stringify(product.placeholders, null, 2));
    const mockupUrls: string[] = [];
    const mockupImages: MockupImage[] = [];

    if (product.images && Array.isArray(product.images)) {
      for (const image of product.images) {
        if (image.src) {
          const label = extractCameraLabel(image.src);
          // Skip size-chart images
          if (label === "size-chart") continue;
          
          mockupUrls.push(image.src);
          mockupImages.push({
            url: image.src,
            label: label,
          });
        }
      }
    }

    return mockupUrls.length > 0 ? { urls: mockupUrls, images: mockupImages } : null;
  } catch (error) {
    console.error("Error fetching product mockups:", error);
    return null;
  }
}

async function deleteProduct(
  shopId: string,
  productId: string,
  apiToken: string
): Promise<void> {
  try {
    await fetch(
      `${PRINTIFY_API_BASE}/shops/${shopId}/products/${productId}.json`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${apiToken}`,
        },
      }
    );
  } catch (error) {
    console.error("Error deleting temporary product:", error);
  }
}

export async function generatePrintifyMockup(
  request: MockupRequest
): Promise<MockupResult> {
  const {
    blueprintId,
    providerId,
    variantId,
    imageUrl: rawImageUrl,
    printifyApiToken,
    printifyShopId,
    scale = 1,
    x = 0,
    y = 0,
    doubleSided = false,
    wrapAround = false,
  } = request;

  // Fix accidental double-prefixed URLs (e.g. APP_URL + Supabase URL) before any use
  const imageUrl = typeof rawImageUrl === "string" ? normalizeImageUrl(rawImageUrl) : rawImageUrl;

  if (!printifyApiToken || !printifyShopId) {
    return {
      success: false,
      mockupUrls: [],
      mockupImages: [],
      source: "fallback",
      error: "Printify credentials not configured",
    };
  }

  // --- Cache-first: check if all preferred views are already cached ---
  const preferredCacheKeys = PREFERRED_LABELS.slice(0, MAX_MOCKUP_VIEWS).map(
    (label) => buildMockupCacheKey(imageUrl, blueprintId, providerId, variantId, label, scale, x, y, doubleSided || wrapAround)
  );
  const cachedPaths = preferredCacheKeys.map(getCachedMockup);
  const allCached = cachedPaths.every((p) => p !== null);

  if (allCached) {
    console.log(`[Mockup Cache] Full cache hit for ${MAX_MOCKUP_VIEWS} views — skipping Printify`);
    const urls = cachedPaths as string[];
    const images = PREFERRED_LABELS.slice(0, MAX_MOCKUP_VIEWS).map((label, i) => ({
      url: urls[i],
      label,
    }));
    return {
      success: true,
      mockupUrls: urls,
      mockupImages: images,
      source: "printify",
    };
  }

  // --- Cache miss: call Printify ---
  let productId: string | null = null;

  try {
    // For wrap-around products (e.g. pillows): the "front" placeholder covers both
    // sides as a single continuous 2:1 area. Duplicate the 1:1 image side-by-side
    // so both front and back show the same artwork.
    const isAop = !!(request.aopPositions && request.aopPositions.length > 0);
    let uploadUrl: string | Buffer = imageUrl;

    if (wrapAround && !isAop) {
      const direction = request.wrapDirection || 'horizontal';
      try {
        let originalBuffer: Buffer;
        if (isDataUrl(imageUrl)) {
          const b64 = extractBase64FromDataUrl(imageUrl);
          originalBuffer = Buffer.from(b64, "base64");
        } else {
          const fetchRes = await fetch(imageUrl);
          if (fetchRes.ok) {
            originalBuffer = Buffer.from(await fetchRes.arrayBuffer());
          } else {
            console.warn("[Printify Wrap] Could not fetch image for duplication — using original");
            originalBuffer = Buffer.alloc(0);
          }
        }
        if (originalBuffer.length > 0) {
          const metadata = await sharp(originalBuffer).metadata();
          const w = metadata.width || 1024;
          const h = metadata.height || 1024;

          let wrappedBuffer: Buffer;
          if (direction === 'vertical') {
            // Duplicate top-to-bottom (1:2 canvas)
            wrappedBuffer = await sharp({
              create: {
                width: w,
                height: h * 2,
                channels: 4,
                background: { r: 255, g: 255, b: 255, alpha: 1 },
              },
            })
              .composite([
                { input: originalBuffer, left: 0, top: 0 },
                { input: originalBuffer, left: 0, top: h },
              ])
              .png()
              .toBuffer();
            console.log(`[Printify Wrap] Duplicated ${w}x${h} image to ${w}x${h * 2} vertical wrap-around (${wrappedBuffer.length} bytes)`);
          } else {
            // Duplicate side-by-side (2:1 canvas)
            wrappedBuffer = await sharp({
              create: {
                width: w * 2,
                height: h,
                channels: 4,
                background: { r: 255, g: 255, b: 255, alpha: 1 },
              },
            })
              .composite([
                { input: originalBuffer, left: 0, top: 0 },
                { input: originalBuffer, left: w, top: 0 },
              ])
              .png()
              .toBuffer();
            console.log(`[Printify Wrap] Duplicated ${w}x${h} image to ${w * 2}x${h} horizontal wrap-around (${wrappedBuffer.length} bytes)`);
          }
          uploadUrl = wrappedBuffer;
        }
      } catch (wrapErr: any) {
        console.warn("[Printify Wrap] Image duplication failed, falling back to original:", wrapErr.message);
        uploadUrl = imageUrl;
      }
    }
    let mirroredUploadBuffer: Buffer | null = null;

    // ── AOP per-panel upload path ───────────────────────────────────────────────────
    // When panelUrls are provided (per-panel inseam-aligned canvases), upload each one
    // separately and build a Map<position, imageId> for createTemporaryProduct.
    let panelImageIds: Map<string, string> | undefined;

    if (isAop && request.panelUrls && request.panelUrls.length > 0) {
      panelImageIds = new Map();
      console.log(`[Printify AOP] Uploading ${request.panelUrls.length} per-panel images`);

      await Promise.all(request.panelUrls.map(async ({ position, dataUrl }) => {
        try {
          const b64 = extractBase64FromDataUrl(dataUrl);
          let buf = Buffer.from(b64, "base64");
          // Do NOT resize per-panel images — Printify needs the exact panel dimensions
          // (e.g. 1476×4500px for leggings legs). Resizing causes Printify to stretch
          // the image to fill the panel, distorting the design.
          // Convert to PNG to ensure consistent format and strip any metadata.
          // Note: input may be JPEG (client sends JPEG to reduce payload size) — sharp handles both.
          buf = await sharp(buf).png().toBuffer();
          const uploaded = await uploadImageToPrintify(buf, printifyApiToken);
          if (uploaded) {
            panelImageIds!.set(position, uploaded.id);
            console.log(`[Printify AOP] Panel "${position}" uploaded: ${uploaded.id}`);
          } else {
            console.warn(`[Printify AOP] Panel "${position}" upload failed — will fall back to primary image`);
          }
        } catch (panelErr: any) {
          console.warn(`[Printify AOP] Panel "${position}" error: ${panelErr.message} — falling back`);
        }
      }));
    } else if (isAop) {
      // Legacy path: single image for all panels (with optional mirror for right panels)
      try {
        let originalBuffer: Buffer;
        if (isDataUrl(imageUrl)) {
          const b64 = extractBase64FromDataUrl(imageUrl);
          originalBuffer = Buffer.from(b64, "base64");
        } else {
          const fetchRes = await fetch(imageUrl);
          if (fetchRes.ok) {
            originalBuffer = Buffer.from(await fetchRes.arrayBuffer());
          } else {
            console.warn("[Printify AOP] Could not fetch pattern for resize — using original URL");
            originalBuffer = Buffer.alloc(0);
          }
        }

        if (originalBuffer.length > 0) {
          uploadUrl = await sharp(originalBuffer)
            .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
            .png()
            .toBuffer();
          console.log(`[Printify AOP] Resized pattern to ≤1024px for mockup upload (${(uploadUrl as Buffer).length} bytes)`);

          if (request.mirrorLegs) {
            mirroredUploadBuffer = await sharp(uploadUrl as Buffer)
              .flop()
              .png()
              .toBuffer();
            console.log(`[Printify AOP] Created mirrored pattern for right panels (${mirroredUploadBuffer.length} bytes)`);
          }
        }
      } catch (resizeErr: any) {
        console.warn("[Printify AOP] Resize/mirror failed, falling back to original URL:", resizeErr.message);
        uploadUrl = imageUrl;
        mirroredUploadBuffer = null;
      }
    }

    // When per-panel images were uploaded, reuse the first panel's image ID as the
    // primary image (required by createTemporaryProduct). This avoids uploading the
    // designImageUrl (which may be a mockup URL, not the original artwork) to Printify.
    let uploadedImage: { id: string } | null = null;
    if (panelImageIds && panelImageIds.size > 0) {
      const firstPanelId = panelImageIds.values().next().value as string;
      uploadedImage = { id: firstPanelId };
      console.log(`[Printify AOP] Using first panel image as primary: ${firstPanelId}`);
    } else {
      uploadedImage = await uploadImageToPrintify(uploadUrl, printifyApiToken);
      if (!uploadedImage) {
        return {
          success: false,
          mockupUrls: [],
          mockupImages: [],
          source: "fallback",
          step: "printify_upload",
          error: "Failed to upload image to Printify after retries",
        };
      }
    }

    // Upload mirrored copy for AOP right panels if we generated one (legacy path)
    let resolvedMirroredImageId: string | undefined;
    if (isAop && mirroredUploadBuffer) {
      const mirroredImage = await uploadImageToPrintify(mirroredUploadBuffer, printifyApiToken);
      if (mirroredImage) {
        resolvedMirroredImageId = mirroredImage.id;
        console.log(`[Printify AOP] Uploaded mirrored image: ${resolvedMirroredImageId}`);
      } else {
        console.warn("[Printify AOP] Mirrored image upload failed — right panels will use original");
      }
    }

    // When wrapAround is active, the image is already duplicated side-by-side,
    // so we only need the single "front" placeholder (doubleSided=false).
    const effectiveDoubleSided = wrapAround ? false : doubleSided;

    const createResult = await createTemporaryProduct(
      printifyShopId,
      blueprintId,
      providerId,
      variantId,
      uploadedImage.id,
      printifyApiToken,
      scale,
      x,
      y,
      effectiveDoubleSided,
      request.aopPositions,
      resolvedMirroredImageId,
      panelImageIds
    );

    if ("error" in createResult) {
      return {
        success: false,
        mockupUrls: [],
        mockupImages: [],
        source: "fallback",
        step: "temp_product",
        error: `Failed to create temporary product: ${createResult.error}`,
      };
    }

    productId = createResult.productId;

    // Publish the product so Printify triggers mockup image generation.
    // Without this step product.images stays empty indefinitely.
    try {
      const publishRes = await fetch(
        `${PRINTIFY_API_BASE}/shops/${printifyShopId}/products/${productId}/publish.json`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${printifyApiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: true,
            description: true,
            images: true,
            variants: true,
            tags: true,
            keyFeatures: false,
            shipping_template: false,
          }),
        }
      );
      console.log(`[Printify] Publish response: ${publishRes.status}`);
    } catch (pubErr: any) {
      console.warn(`[Printify] Publish call failed (non-fatal): ${pubErr.message}`);
    }

    const mockupData = await pRetry(
      async () => {
        const data = await getProductMockups(printifyShopId, productId!, printifyApiToken);
        if (!data || data.urls.length === 0) {
          throw new Error("Mockups not ready yet");
        }
        // Also verify the first image URL is actually downloadable from the CDN.
        // Printify lists images immediately but the CDN may not have rendered them yet.
        const firstUrl = data.urls[0];
        const probe = await fetch(firstUrl, { method: 'HEAD' });
        if (!probe.ok) {
          throw new Error(`Mockup CDN not ready yet (${probe.status} for ${firstUrl.substring(0, 60)})`);
        }
        return data;
      },
      {
        retries: 6,
        minTimeout: 4000,
        maxTimeout: 10000,
        onFailedAttempt: (error) => {
          console.log(`[Mockup] Attempt ${error.attemptNumber} failed (${error.message}). ${error.retriesLeft} retries left.`);
        },
      }
    );

    // Select up to 4 preferred views
    const selected = selectPreferredViews(mockupData.images);
    const selectedData = {
      urls: selected.map((img) => img.url),
      images: selected,
    };

    console.log(`[Mockup Cache] Selected ${selected.length} views:`, selected.map((s) => s.label).join(", "));

    // Build cache keys for the selected views
    const cacheKeys = selected.map((img) =>
      buildMockupCacheKey(imageUrl, blueprintId, providerId, variantId, img.label, scale, x, y, doubleSided || wrapAround)
    );

    const cached = await cacheMockupImages(selectedData, cacheKeys);

    return {
      success: true,
      mockupUrls: cached.urls,
      mockupImages: cached.images,
      source: "printify",
    };
  } catch (error) {
    console.error("Printify mockup generation failed:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      mockupUrls: [],
      mockupImages: [],
      source: "fallback",
      step: errMsg.includes("Mockups not ready") ? "mockup_fetch" as const : "printify_upload" as const,
      error: errMsg,
    };
  } finally {
    if (productId) {
      await deleteProduct(printifyShopId, productId, printifyApiToken);
    }
  }
}

export function getLocalMockupTemplate(designerType: string): string | null {
  const templates: Record<string, string> = {
    pillow: "/mockup-templates/pillow-template.png",
    "framed-print": "/mockup-templates/frame-template.png",
    mug: "/mockup-templates/mug-template.png",
    blanket: "/mockup-templates/blanket-template.png",
    "t-shirt": "/mockup-templates/tshirt-template.png",
    "phone-case": "/mockup-templates/phone-case-template.png",
  };

  return templates[designerType] || null;
}
