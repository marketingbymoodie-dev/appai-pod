import sharp from "sharp";
import pRetry from "p-retry";
import crypto from "crypto";

const PRINTIFY_API_BASE = "https://api.printify.com/v1";
const MAX_RETRIES = 3;
const MAX_PANEL_UPLOAD_CONCURRENCY = 8;
/** Max mockups returned after preference ordering (leggings grid + fallbacks). */
const MAX_MOCKUP_VIEWS = 12;

/** Order matches Printify `camera_label` tokens (case-insensitive after normalization). */
// Printify UI often shows "Front Side" / "Side Person"; URL `camera_label` may be spaced or kebab-case.
const LEGGINGS_STYLE_PRIORITY = [
  "front",
  "back",
  "front side",
  "front-side",
  "back side",
  "back-side",
  "front person",
  "front-person",
  "side person",
  "side-person",
  "on-person-side",
  "back person",
  "back-person",
  "lifestyle",
] as const;

const ON_PERSON_FRONT_LABELS = Array.from(
  { length: 100 },
  (_, i) => `on-person-${i + 1}-front`,
);

const PREFERRED_LABELS: string[] = [...LEGGINGS_STYLE_PRIORITY, ...ON_PERSON_FRONT_LABELS];
const AOP_FLAT_LAY_LABELS = ["front", "back"] as const;

export interface MockupRequest {
  blueprintId: number;
  providerId: number;
  variantId: number;
  imageUrl: string;
  printifyApiToken: string;
  printifyShopId: string;
  scale?: number;
  x?: number;
  y?: number;
  doubleSided?: boolean;
  printPlacement?: "front" | "back" | "both";
  wrapAround?: boolean;
  wrapDirection?: "horizontal" | "vertical";
  aopPositions?: { position: string; width: number; height: number }[];
  /** Per-panel canvas images (dataUrls) — already incorporate placement/mirror transforms. */
  panelUrls?: { position: string; dataUrl: string }[];
  /** Legacy: mirror flag. Client now bakes mirror into panelUrls so server-side handling is a no-op. */
  mirrorLegs?: boolean;
  /**
   * Hex (#RRGGBB) the user picked as the AOP background colour. When the
   * blueprint placeholder list (aopPositions) contains positions the client
   * doesn't render (e.g. inner hood, collar/yoke, placket trim on a zip
   * hoodie), the server synthesises a small solid PNG of this colour and
   * uses it for those missing placeholders so they don't render as the
   * default white garment template.
   */
  bgColor?: string;
  /**
   * Internal-only metadata used by calibration/debug scripts. The storefront
   * route does not pass this, so customer mockup behavior is unchanged.
   */
  internalProductTitle?: string;
  internalProductDescription?: string;
  internalProductTags?: string[];
  onPrintifyProductPayload?: (payload: unknown) => void;
  onPrintifyProductCreated?: (productId: string) => void;
}

export interface MockupImage {
  url: string;
  label: string;
}

export interface MockupResult {
  success: boolean;
  mockupUrls: string[];
  mockupImages: MockupImage[];
  source: "printify" | "fallback";
  error?: string;
  step?: "printify_upload" | "temp_product" | "mockup_fetch";
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

type PrintifyImageRef = {
  id: string;
  width: number;
  height: number;
  bufLen: number;
};

type CachedPrintifyImageRef = {
  ref: PrintifyImageRef;
  ts: number;
};

const PRINTIFY_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;
const PRINTIFY_IMAGE_CACHE_LIMIT = 200;
const printifyImageCache = new Map<string, CachedPrintifyImageRef>();

// Per-variant placeholder cache. Printify's blueprint placeholder list is the
// source of truth — the DB's productType.placeholderPositions can be missing
// trim positions (waistband / cuffs / inner hood / collar yoke) for a given
// blueprint. Fetching once per variant (cached for 24h) lets the bgColor
// fallback cover ALL placeholder positions, so a picked colour shows on
// every region of the garment in the mockup.
type BlueprintPlaceholder = { position: string; width: number; height: number };
type CachedPlaceholders = { positions: BlueprintPlaceholder[]; ts: number };
const BLUEPRINT_PLACEHOLDER_TTL_MS = 24 * 60 * 60 * 1000;
const blueprintPlaceholderCache = new Map<string, CachedPlaceholders>();

async function getBlueprintVariantPlaceholders(
  blueprintId: number,
  providerId: number,
  variantId: number,
  apiToken: string,
): Promise<BlueprintPlaceholder[] | null> {
  const cacheKey = `${blueprintId}:${providerId}:${variantId}`;
  const now = Date.now();
  const cached = blueprintPlaceholderCache.get(cacheKey);
  if (cached && now - cached.ts < BLUEPRINT_PLACEHOLDER_TTL_MS) {
    return cached.positions;
  }
  try {
    const res = await fetch(
      `${PRINTIFY_API_BASE}/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json`,
      { headers: { Authorization: `Bearer ${apiToken}` } },
    );
    if (!res.ok) {
      console.warn(`[Printify Blueprint] variants.json ${res.status} for ${blueprintId}/${providerId}`);
      return null;
    }
    const data = (await res.json()) as { variants?: Array<{ id: number; placeholders?: BlueprintPlaceholder[] }> };
    const variant = data.variants?.find((v) => v.id === variantId);
    const positions = (variant?.placeholders ?? [])
      .filter((p) => p && typeof p.position === "string")
      .map((p) => ({
        position: p.position,
        width: typeof p.width === "number" ? p.width : 0,
        height: typeof p.height === "number" ? p.height : 0,
      }));
    if (positions.length === 0) {
      console.warn(`[Printify Blueprint] No placeholders found for variant ${variantId} (blueprint ${blueprintId})`);
      return null;
    }
    blueprintPlaceholderCache.set(cacheKey, { positions, ts: now });
    return positions;
  } catch (err) {
    console.warn(`[Printify Blueprint] Fetch error for ${blueprintId}/${providerId}/${variantId}:`, err);
    return null;
  }
}

function hashBuffer(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function prunePrintifyImageCache() {
  const now = Date.now();
  for (const [key, entry] of printifyImageCache) {
    if (now - entry.ts > PRINTIFY_IMAGE_TTL_MS) {
      printifyImageCache.delete(key);
    }
  }

  while (printifyImageCache.size > PRINTIFY_IMAGE_CACHE_LIMIT) {
    const oldestKey = printifyImageCache.keys().next().value;
    if (!oldestKey) break;
    printifyImageCache.delete(oldestKey);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDataUrl(url: string): boolean {
  return url.startsWith("data:");
}

/**
 * Extract base64 payload from a data URL.
 * Accepts common variants produced by mobile browsers (e.g. extra MIME params,
 * "octet-stream" type, or charset tokens before the base64 marker):
 *   data:image/jpeg;base64,...
 *   data:image/png;charset=utf-8;base64,...
 *   data:application/octet-stream;base64,...
 *   data:image/jpeg;name=photo.jpg;base64,...
 */
export function extractBase64FromDataUrl(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:[^;]+(?:;[^;=]+=[^;]*)*;base64,(.+)$/s);
  if (match) {
    const payload = match[1].trim();
    return payload.length > 0 ? payload : null;
  }
  return null;
}

/** Return a short, non-sensitive summary for a panel data URL suitable for logging. */
function describeDataUrl(dataUrl: string): { mime: string; byteLen: number; valid: boolean } {
  const mimeMatch = dataUrl.match(/^data:([^;,]+)/);
  const mime = mimeMatch ? mimeMatch[1] : "unknown";
  const b64 = extractBase64FromDataUrl(dataUrl);
  const byteLen = b64 ? Math.round(b64.length * 0.75) : 0;
  return { mime, byteLen, valid: b64 !== null && byteLen > 0 };
}

function getDataUrlMime(dataUrl: string): string {
  const mimeMatch = dataUrl.match(/^data:([^;,]+)/);
  return mimeMatch ? mimeMatch[1].toLowerCase() : "application/octet-stream";
}

function getDataUrlExtension(dataUrl: string): "jpg" | "png" {
  const mime = getDataUrlMime(dataUrl);
  return mime === "image/jpeg" || mime === "image/jpg" ? "jpg" : "png";
}

function normalizeImageUrl(url: string): string {
  if (typeof url !== "string") return url;
  const appUrl = process.env.APP_URL || "";
  if (appUrl && url.startsWith(appUrl) && url.includes("supabase.co")) {
    return url.replace(appUrl, "");
  }
  return url;
}

/**
 * Synthesise a small solid-colour PNG (1024×1024) and upload it to Printify
 * so the temp product can use it as a fallback for any blueprint placeholder
 * the client didn't supply a per-panel image for. Cached by hex so repeated
 * mockup requests with the same bgColor reuse the upload.
 */
async function getOrCreateSolidColorImageId(
  hexColor: string,
  apiToken: string,
): Promise<string | null> {
  const m = hexColor.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const hex = m[1].toLowerCase();
  const cacheKey = `solid:${hex}`;
  prunePrintifyImageCache();
  const cached = printifyImageCache.get(cacheKey);
  if (cached) return cached.ref.id;

  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  let buf: Buffer;
  try {
    buf = await sharp({
      create: { width: 1024, height: 1024, channels: 4, background: { r, g, b, alpha: 1 } },
    }).png().toBuffer();
  } catch (err) {
    console.warn(`[Printify Solid Fill] sharp synth failed for #${hex}:`, err);
    return null;
  }

  const result = await uploadImageToPrintify(buf, apiToken);
  if (!result) return null;
  printifyImageCache.set(cacheKey, {
    ref: { id: result.id, width: result.width, height: result.height, bufLen: buf.length },
    ts: Date.now(),
  });
  return result.id;
}

async function uploadImageToPrintify(
  imageUrlOrBuffer: string | Buffer,
  apiToken: string
): Promise<PrintifyImage | null> {
  let requestBody: Record<string, string>;
  let uploadMethod: string;

  if (Buffer.isBuffer(imageUrlOrBuffer)) {
    const base64Data = imageUrlOrBuffer.toString("base64");
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
    const ext = getDataUrlExtension(imageUrlOrBuffer);
    uploadMethod = `data-url (${ext}, ${base64Data.length} chars base64)`;
    requestBody = {
      file_name: `design-${Date.now()}.${ext}`,
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

      const controller = new AbortController();
      const uploadTimeout = setTimeout(() => controller.abort(), 60_000); // 60 s per upload
      let response: Response;
      try {
        response = await fetch(
          `${PRINTIFY_API_BASE}/uploads/images.json`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          }
        );
      } finally {
        clearTimeout(uploadTimeout);
      }
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Printify Upload] Attempt ${attempt} failed (${response.status}):`, errorText.substring(0, 500));
        if (response.status >= 400 && response.status < 500) return null;
        if (attempt < MAX_RETRIES) { await sleep(1000 * Math.pow(2, attempt - 1)); continue; }
        return null;
      }
      const result = await response.json();
      console.log(`[Printify Upload] Success on attempt ${attempt}: id=${result.id}, ${result.width}x${result.height}`);
      return result as PrintifyImage;
    } catch (error: any) {
      console.error(`[Printify Upload] Attempt ${attempt} exception:`, error.message || error);
      if (attempt < MAX_RETRIES) { await sleep(1000 * Math.pow(2, attempt - 1)); continue; }
      return null;
    }
  }
  return null;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
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
  printPlacement: "front" | "back" | "both" | undefined = undefined,
  aopPositions?: { position: string; width: number; height: number }[],
  mirroredImageId?: string,
  panelImageIds?: Map<string, string>,
  /**
   * Image id of a solid-colour PNG matching the user's picked bgColor. Used to
   * fill any aopPosition the client didn't supply a panel image for, so
   * blueprint-only placeholders (e.g. inner hood / collar yoke / placket on
   * zip hoodies) render the same colour as the rest of the garment instead
   * of the default white template.
   */
  inactivePanelFillImageId?: string,
  wrapSingleFace?: "front" | "back",
  internalOptions?: {
    title?: string;
    description?: string;
    tags?: string[];
    onPayload?: (payload: unknown) => void;
    onCreated?: (productId: string) => void;
  },
): Promise<{ productId: string; images: MockupImage[] } | { error: string }> {
  const printifyX = 0.5 + x * 0.5;
  const printifyY = 0.5 + y * 0.5;
  const imageEntry = {
    id: imageId,
    x: printifyX,
    y: printifyY,
    scale: scale,
    angle: 0,
  };
  const placeholders: Array<{ position: string; images: typeof imageEntry[] }> =
    [];

  if (aopPositions && aopPositions.length > 0) {
    for (const pos of aopPositions) {
      const isRightPanel = pos.position.startsWith("right");
      let useImageId: string;
      if (panelImageIds && panelImageIds.has(pos.position)) {
        useImageId = panelImageIds.get(pos.position)!;
        // Per-panel images are already correctly sized for the panel.
        // Printify scale uses 0-2 range where 1 = 100%. Using scale=1
        // so the image fills the panel at its native resolution.
        const panelEntry = {
          id: useImageId,
          x: 0.5,
          y: 0.5,
          scale: 1,
          angle: 0,
        };
        placeholders.push({ position: pos.position, images: [panelEntry] });
        continue;
      } else if (panelImageIds && panelImageIds.size > 0) {
        // The blueprint's placeholder list (aopPositions) can include positions
        // the client doesn't render — e.g. inner hood / collar yoke / placket
        // strips on zip hoodies. If the user picked a bgColor we fill those
        // missing placeholders with a solid bgColor PNG so the mockup doesn't
        // expose the default white garment template through them.
        if (inactivePanelFillImageId) {
          const fillEntry = {
            id: inactivePanelFillImageId,
            x: 0.5,
            y: 0.5,
            scale: 1,
            angle: 0,
          };
          placeholders.push({ position: pos.position, images: [fillEntry] });
        }
        // Without a fallback id (no bgColor picked) we still omit the
        // placeholder so Printify shows the garment colour for trim regions.
        continue;
      } else if (isRightPanel && mirroredImageId) {
        useImageId = mirroredImageId;
      } else {
        useImageId = imageId;
      }
      const entry = { ...imageEntry, id: useImageId };
      placeholders.push({ position: pos.position, images: [entry] });
    }
  } else {
    const placement = printPlacement ?? (doubleSided ? "both" : "front");
    const baseEntry = { ...imageEntry };
    const faceEntry =
      wrapSingleFace === "front"
        ? { ...baseEntry, x: 0.25, scale: scale * 0.5 }
        : wrapSingleFace === "back"
          ? { ...baseEntry, x: 0.75, scale: scale * 0.5 }
          : baseEntry;
    if (placement === "front" || placement === "both") {
      placeholders.push({ position: "front", images: [faceEntry] });
    }
    if (placement === "back" || placement === "both") {
      placeholders.push({
        position: "back",
        images: [wrapSingleFace === "back" ? faceEntry : baseEntry],
      });
    }
  }

  const requestBody = {
    title: internalOptions?.title || `Mockup Preview - ${Date.now()}`,
    description: internalOptions?.description || "Temporary product for mockup generation",
    blueprint_id: blueprintId,
    print_provider_id: providerId,
    variants: [{ id: variantId, price: 100, is_enabled: true }],
    print_areas: [{ variant_ids: [variantId], placeholders }],
    ...(internalOptions?.tags?.length ? { tags: internalOptions.tags } : {}),
  };
  internalOptions?.onPayload?.(requestBody);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(
        `${PRINTIFY_API_BASE}/shops/${shopId}/products.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        }
      );
      if (!response.ok) {
        const errorText = await response.text();
        if (response.status >= 400 && response.status < 500) {
          return {
            error: `Printify rejected product (${
              response.status
            }): ${errorText.substring(0, 200)}`,
          };
        }
        if (attempt < MAX_RETRIES) { await sleep(1000 * Math.pow(2, attempt - 1)); continue; }
        return {
          error: `Printify server error after ${MAX_RETRIES} attempts (${response.status})`,
        };
      }
      const product = await response.json();
      internalOptions?.onCreated?.(String(product.id));
      // Printify often returns the rendered mockup images DIRECTLY in the
      // create-product response (verified for blueprint 353 / tumbler, which
      // never populates images[] on a subsequent GET /products/{id}.json poll).
      // Capture them here so the caller can use them immediately and only fall
      // back to polling when the create response has none.
      return { productId: product.id, images: extractMockupImagesFromProduct(product) };
    } catch (error: any) {
      if (attempt < MAX_RETRIES) { await sleep(1000 * Math.pow(2, attempt - 1)); continue; }
      return {
        error: `Exception after ${MAX_RETRIES} attempts: ${
          error.message || String(error)
        }`,
      };
    }
  }
  return { error: "Unexpected: exhausted retries" };
}

/**
 * Map a Printify product payload's `images[]` (present in both the create
 * response and GET /products/{id}.json) into our MockupImage shape. The
 * `camera_label` query param on each `src` is what we use to select the
 * preferred view (e.g. "front") for the customizer.
 */
function extractMockupImagesFromProduct(product: any): MockupImage[] {
  if (!product || !Array.isArray(product.images) || product.images.length === 0) {
    return [];
  }
  return product.images
    .filter((img: any) => img && typeof img.src === "string" && img.src.length > 0)
    .map((img: any) => ({
      url: img.src,
      label: extractCameraLabel(img.src),
    }));
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
        headers: { Authorization: `Bearer ${apiToken}` },
      }
    );
    if (!response.ok) return null;
    const product = await response.json();
    const images = extractMockupImagesFromProduct(product);
    if (images.length === 0) return null;

    return {
      urls: images.map((img) => img.url),
      images,
    };
  } catch (error) {
    return null;
  }
}

function extractCameraLabel(url: string): string {
  const match = url.match(/camera_label=([^&]+)/);
  if (!match) return "front";
  try {
    return decodeURIComponent(match[1].replace(/\+/g, " "));
  } catch {
    return match[1].replace(/\+/g, " ");
  }
}

/** Normalize Printify camera_label for comparison (spaces, + / %20, case). */
export function normalizeMockupCameraLabel(raw: string): string {
  const s = raw.replace(/\+/g, " ").replace(/_/g, " ").trim();
  try {
    return decodeURIComponent(s).trim().toLowerCase();
  } catch {
    return s.trim().toLowerCase();
  }
}

function labelMatchesPrintPlacement(norm: string, placement: "front" | "back" | "both"): boolean {
  if (placement === "both") return true;
  if (placement === "front") {
    return norm.includes("front") && !norm.includes("back");
  }
  return norm.includes("back");
}

/** True when the blueprint has a single wide wrap canvas (e.g. pillow 2:1) without a separate back area. */
export function isWrapOnlyPlaceholder(
  positions: { position: string; width?: number; height?: number }[],
): boolean {
  const hasBack = positions.some(
    (p) => p.position === "back" && (p.width ?? 0) > 0 && (p.height ?? 0) > 0,
  );
  if (hasBack) return false;
  const front = positions.find((p) => p.position === "front" || p.position === "default");
  if (front?.width && front?.height && front.height > 0) {
    return front.width / front.height > 1.5;
  }
  return positions.length > 0 && !hasBack;
}

function selectPreferredViews(
  images: MockupImage[],
  frontBackOnly = false,
  printPlacement?: "front" | "back" | "both",
): MockupImage[] {
  const selected: MockupImage[] = [];
  const seenUrls = new Set<string>();
  const annotated = images.map((img) => ({
    ...img,
    norm: normalizeMockupCameraLabel(img.label),
  }));
  const preferredLabels = frontBackOnly ? AOP_FLAT_LAY_LABELS : PREFERRED_LABELS;
  const maxViews = frontBackOnly
    ? AOP_FLAT_LAY_LABELS.length
    : printPlacement === "front" || printPlacement === "back"
      ? 1
      : MAX_MOCKUP_VIEWS;

  for (const pref of preferredLabels) {
    const prefNorm = normalizeMockupCameraLabel(pref);
    if (printPlacement && !labelMatchesPrintPlacement(prefNorm, printPlacement)) continue;
    const match = annotated.find(
      (img) =>
        img.norm === prefNorm &&
        !seenUrls.has(img.url) &&
        (!printPlacement || labelMatchesPrintPlacement(img.norm, printPlacement)),
    );
    if (match) {
      selected.push({ url: match.url, label: match.label });
      seenUrls.add(match.url);
      if (selected.length >= maxViews) break;
    }
  }

  if (selected.length === 0 && images.length > 0) {
    const fallback = printPlacement
      ? annotated.filter((img) => labelMatchesPrintPlacement(img.norm, printPlacement))
      : annotated;
    return (fallback.length > 0 ? fallback : annotated)
      .slice(0, maxViews)
      .map((img) => ({ url: img.url, label: img.label }));
  }

  return selected;
}

/** Test hook: same logic as internal mockup picker. */
export function pickPreferredMockupViews(
  images: { url: string; label: string }[],
  frontBackOnly = false,
  printPlacement?: "front" | "back" | "both",
): { url: string; label: string }[] {
  return selectPreferredViews(images, frontBackOnly, printPlacement);
}

async function deleteProduct(shopId: string, productId: string, apiToken: string) {
  try {
    await fetch(
      `${PRINTIFY_API_BASE}/shops/${shopId}/products/${productId}.json`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiToken}` },
      }
    );
  } catch (error) {}
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
    printPlacement,
    wrapAround = false,
  } = request;

  const imageUrl =
    typeof rawImageUrl === "string" ? normalizeImageUrl(rawImageUrl) : rawImageUrl;

  if (!printifyApiToken || !printifyShopId) {
    return {
      success: false,
      mockupUrls: [],
      mockupImages: [],
      source: "fallback",
      error: "Printify credentials not configured",
    };
  }

  let productId: string | null = null;
  try {
    const isAop = !!(request.aopPositions && request.aopPositions.length > 0);
    let uploadUrl: string | Buffer = imageUrl;

    if (wrapAround && !isAop) {
      const direction = request.wrapDirection || "horizontal";
      try {
        let originalBuffer: Buffer;
        if (isDataUrl(imageUrl)) {
          originalBuffer = Buffer.from(extractBase64FromDataUrl(imageUrl)!, "base64");
        } else {
          const fetchRes = await fetch(imageUrl);
          originalBuffer = Buffer.from(await fetchRes.arrayBuffer());
        }

        if (originalBuffer.length > 0) {
          const metadata = await sharp(originalBuffer).metadata();
          const w = metadata.width || 1024;
          const h = metadata.height || 1024;
          let wrappedBuffer: Buffer;

          if (direction === "vertical") {
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
          } else {
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
          }
          uploadUrl = wrappedBuffer;
        }
      } catch (wrapErr) {}
    }

    const panelImageIds = new Map<string, string>();
    const panelImageRefs = new Map<string, PrintifyImageRef>();

    if (isAop && request.panelUrls && request.panelUrls.length > 0) {
      prunePrintifyImageCache();
      // Log per-panel stats so mobile vs desktop sessions can be compared in Railway logs.
      const panelStats = request.panelUrls.map(({ position, dataUrl }) => {
        const desc = describeDataUrl(dataUrl);
        return { position, ...desc };
      });
      const invalidPanels = panelStats.filter((s) => !s.valid);
      console.log(
        `[Printify AOP] Uploading ${request.panelUrls.length} panel(s) (concurrency=${MAX_PANEL_UPLOAD_CONCURRENCY}):`,
        panelStats.map((s) => `${s.position} ${s.mime} ~${(s.byteLen / 1024).toFixed(0)} KB valid=${s.valid}`).join(" | ")
      );
      if (invalidPanels.length > 0) {
        console.warn(
          `[Printify AOP] ${invalidPanels.length} panel(s) have invalid/empty base64 — will be skipped:`,
          invalidPanels.map((s) => s.position).join(", ")
        );
      }

      const panelGroups = new Map<string, {
        hash: string;
        positions: string[];
        dataUrl: string;
        uploadSource: string | Buffer;
        bufLen: number;
        width: number;
        height: number;
        mime: string;
      }>();

      for (const { position, dataUrl } of request.panelUrls) {
        try {
          const b64 = extractBase64FromDataUrl(dataUrl);
          if (!b64) {
            console.warn(`[Printify AOP] Panel "${position}" has no valid base64 data — skipping`);
            continue;
          }

          let buf = Buffer.from(b64, "base64");
          const mime = getDataUrlMime(dataUrl);
          const metadata = await sharp(buf).metadata();
          const isDirectPrintifyMime = mime === "image/png" || mime === "image/jpeg" || mime === "image/jpg";
          if (!isDirectPrintifyMime) {
            buf = await sharp(buf).png().toBuffer();
          }

          const hash = hashBuffer(buf);
          const existing = panelGroups.get(hash);
          if (existing) {
            existing.positions.push(position);
            continue;
          }

          panelGroups.set(hash, {
            hash,
            positions: [position],
            dataUrl,
            uploadSource: isDirectPrintifyMime ? dataUrl : buf,
            bufLen: buf.length,
            width: metadata.width || 1,
            height: metadata.height || 1,
            mime,
          });
        } catch (panelErr: any) {
          console.warn(`[Printify AOP] Panel "${position}" error before upload: ${panelErr.message}`);
        }
      }

      console.log(
        `[Printify AOP] Deduped ${request.panelUrls.length} panel(s) into ${panelGroups.size} unique upload payload(s).`
      );

      const uploadResults = await mapWithConcurrency(
        Array.from(panelGroups.values()),
        MAX_PANEL_UPLOAD_CONCURRENCY,
        async (group) => {
          const primaryPosition = group.positions[0];
          try {
            const cached = printifyImageCache.get(group.hash);
            if (cached && Date.now() - cached.ts <= PRINTIFY_IMAGE_TTL_MS) {
              cached.ts = Date.now();
              console.log(
                `[Printify AOP] Cache hit for ${group.positions.length} panel(s): ${group.positions.join(", ")} -> id=${cached.ref.id}`
              );
              return { positions: group.positions, ref: cached.ref };
            }

            console.log(
              `[Printify AOP] Uploading unique payload for ${group.positions.length} panel(s): ` +
              `${group.positions.join(", ")} ${group.mime} ${group.width}x${group.height} ${group.bufLen} bytes`
            );
            const uploaded = await uploadImageToPrintify(group.uploadSource, printifyApiToken);
            if (!uploaded) {
              console.warn(`[Printify AOP] Panel group "${primaryPosition}" upload returned null`);
              return { positions: group.positions, ref: null as PrintifyImageRef | null };
            }

            const ref: PrintifyImageRef = {
              id: uploaded.id,
              width: uploaded.width || group.width,
              height: uploaded.height || group.height,
              bufLen: group.bufLen,
            };
            printifyImageCache.set(group.hash, { ref, ts: Date.now() });
            console.log(
              `[Printify AOP] Panel group "${primaryPosition}" uploaded OK: id=${uploaded.id} ${uploaded.width}x${uploaded.height}`
            );
            return { positions: group.positions, ref };
          } catch (panelErr: any) {
            console.warn(`[Printify AOP] Panel group "${primaryPosition}" error: ${panelErr.message}`);
            return { positions: group.positions, ref: null as PrintifyImageRef | null };
          }
        }
      );

      for (const result of uploadResults) {
        if (result.ref) {
          for (const position of result.positions) {
            panelImageIds.set(position, result.ref.id);
            panelImageRefs.set(position, result.ref);
          }
        }
      }

      console.log(
        `[Printify AOP] Upload summary: ${panelImageIds.size}/${request.panelUrls.length} panels uploaded successfully.`
      );

      // If client supplied panels for an AOP product but every upload failed, return an
      // explicit error rather than silently falling back to a generic (black/undecorated)
      // image which produces visually wrong mockups.
      if (panelImageIds.size === 0) {
        return {
          success: false,
          mockupUrls: [],
          mockupImages: [],
          source: "fallback",
          step: "printify_upload",
          error:
            "AOP panel upload failed: all per-panel images could not be uploaded to Printify. " +
            `Received ${request.panelUrls.length} panel(s); panel stats: ` +
            panelStats.map((s) => `${s.position}(${s.mime},${(s.byteLen / 1024).toFixed(0)}KB,valid=${s.valid})`).join(", "),
        };
      }

      const expectedPositions = new Set(request.panelUrls.map((panel) => panel.position));
      const missingPositions = Array.from(expectedPositions).filter((position) => !panelImageIds.has(position));
      if (expectedPositions.size > 0 && missingPositions.length > 0) {
        return {
          success: false,
          mockupUrls: [],
          mockupImages: [],
          source: "fallback",
          step: "printify_upload",
          error:
            "AOP panel upload incomplete: preview requires every panel image to upload successfully. " +
            `Missing panels: ${missingPositions.join(", ")}`,
        };
      }
    }

    let uploadedImage: { id: string } | null = null;
    if (panelImageIds.size > 0) {
      const largestPanel = Array.from(panelImageRefs.values())
        .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
      uploadedImage = { id: largestPanel?.id ?? (panelImageIds.values().next().value as string) };
      console.log(
        `[Printify AOP] Primary image id=${uploadedImage.id}` +
        (largestPanel ? ` (${largestPanel.width}x${largestPanel.height}, ${largestPanel.bufLen} bytes)` : "")
      );
    } else {
      uploadedImage = await uploadImageToPrintify(uploadUrl, printifyApiToken);
      if (!uploadedImage) {
        return {
          success: false,
          mockupUrls: [],
          mockupImages: [],
          source: "fallback",
          step: "printify_upload",
          error: "Failed to upload image to Printify",
        };
      }
    }

    // If the user picked a bgColor and we're rendering an AOP product, synth a
    // solid-colour PNG and upload it once so any blueprint placeholder the
    // client didn't supply (e.g. inner hood / collar yoke / placket on zip
    // hoodies) renders bgColor instead of the default white garment template.
    let inactivePanelFillImageId: string | undefined;
    if (
      isAop &&
      panelImageIds.size > 0 &&
      typeof request.bgColor === "string" &&
      /^#?[0-9a-fA-F]{6}$/.test(request.bgColor)
    ) {
      const id = await getOrCreateSolidColorImageId(request.bgColor, printifyApiToken);
      if (id) {
        inactivePanelFillImageId = id;
        console.log(
          `[Printify AOP] Inactive-panel fill ready (bgColor=${request.bgColor}, imageId=${id}) — covers blueprint-only placeholders`,
        );
      } else {
        console.warn(`[Printify AOP] Failed to upload solid bgColor fill (${request.bgColor})`);
      }
    }

    // Merge the DB's placeholderPositions list with Printify's actual variant
    // placeholders. The DB list can be incomplete (e.g. zip hoodie missing
    // waistband_external / *_cuff_external / inner hood positions), and any
    // placeholder we don't include in print_areas[].placeholders renders the
    // default white garment template — which is what produces the visible
    // white bands. Discovering the live list and filling the missing ones with
    // the bgColor solid PNG closes that gap.
    let effectiveAopPositions = request.aopPositions;
    if (isAop && inactivePanelFillImageId) {
      const discovered = await getBlueprintVariantPlaceholders(
        blueprintId,
        providerId,
        variantId,
        printifyApiToken,
      );
      if (discovered && discovered.length > 0) {
        const seen = new Set((request.aopPositions ?? []).map((p) => p.position));
        const merged = [...(request.aopPositions ?? [])];
        const added: string[] = [];
        for (const p of discovered) {
          if (!seen.has(p.position)) {
            merged.push(p);
            seen.add(p.position);
            added.push(p.position);
          }
        }
        if (added.length > 0) {
          console.log(
            `[Printify AOP] Augmented aopPositions with ${added.length} blueprint-only placeholder(s): ${added.join(", ")}`,
          );
        }
        effectiveAopPositions = merged;
      }
    }

    let effectivePrintPlacement = printPlacement ?? (doubleSided ? "both" : "front");
    let wrapSingleFace: "front" | "back" | undefined;
    if (!isAop) {
      const discovered = await getBlueprintVariantPlaceholders(
        blueprintId,
        providerId,
        variantId,
        printifyApiToken,
      );
      if (discovered && discovered.length > 0) {
        const requestedPlacement = printPlacement ?? (doubleSided ? "both" : "front");
        const wrapOnly = isWrapOnlyPlaceholder(discovered);
        const hasStandardFrontBack = discovered.some(
          (p) => p.position === "front" || p.position === "back",
        );

        if (requestedPlacement !== "both" && wrapOnly) {
          // Wrap-style pillow: use legacy front/back placeholders with half-width
          // positioning so front-only art stays on one face, not the full 2:1 wrap.
          effectiveAopPositions = undefined;
          effectivePrintPlacement = requestedPlacement;
          wrapSingleFace = requestedPlacement === "back" ? "back" : "front";
          console.log(
            `[Printify Blueprint] Wrap-only ${requestedPlacement}-only for ${blueprintId}/${providerId}/${variantId} — half-width legacy placement`,
          );
        } else if (hasStandardFrontBack) {
          const selectedPositions = discovered.filter((p) => {
            if (requestedPlacement === "both") {
              return p.position === "front" || p.position === "back";
            }
            return p.position === requestedPlacement;
          });
          effectiveAopPositions = selectedPositions.length > 0 ? selectedPositions : discovered;
          effectivePrintPlacement = requestedPlacement;
          console.log(
            `[Printify Blueprint] Using discovered placeholder(s) for ${blueprintId}/${providerId}/${variantId}: ` +
            effectiveAopPositions.map((p) => p.position).join(", "),
          );
        } else {
          effectiveAopPositions = discovered;
          effectivePrintPlacement = requestedPlacement;
          console.log(
            `[Printify Blueprint] Using discovered placeholder(s) for ${blueprintId}/${providerId}/${variantId}: ` +
            effectiveAopPositions.map((p) => p.position).join(", "),
          );
        }
      } else {
        console.warn(
          `[Printify Blueprint] Falling back to legacy placement "${effectivePrintPlacement}" ` +
          `for ${blueprintId}/${providerId}/${variantId}; live placeholders unavailable.`,
        );
      }
    }

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
      doubleSided,
      effectiveAopPositions && effectiveAopPositions.length > 0 ? undefined : effectivePrintPlacement,
      effectiveAopPositions,
      undefined,
      panelImageIds,
      inactivePanelFillImageId,
      wrapSingleFace,
      {
        title: request.internalProductTitle,
        description: request.internalProductDescription,
        tags: request.internalProductTags,
        onPayload: request.onPrintifyProductPayload,
        onCreated: request.onPrintifyProductCreated,
      },
    );

    if ("error" in createResult) {
      return {
        success: false,
        mockupUrls: [],
        mockupImages: [],
        source: "fallback",
        step: "temp_product",
        error: createResult.error,
      };
    }

    productId = createResult.productId;

    // Printify frequently returns the fully rendered mockup images inline in
    // the create-product response. For some blueprints (e.g. 353 / tumbler 20oz)
    // these inline images are the ONLY ones we ever get — the subsequent
    // GET /products/{id}.json poll never populates images[], so polling just
    // burns the full ~145s budget and then fails with "Preview unavailable".
    // Use the create-response images immediately when present; only fall back
    // to polling when the create response gave us nothing usable. This is
    // general (helps any blueprint that returns images inline), not
    // tumbler-specific.
    let mockupData: { urls: string[]; images: MockupImage[] } | undefined;
    if (createResult.images.length > 0) {
      console.log(
        `[Printify Mockup] Using ${createResult.images.length} image(s) returned inline in create-product response (skipping poll).`,
      );
      mockupData = {
        urls: createResult.images.map((img) => img.url),
        images: createResult.images,
      };
    }

    if (!mockupData) {
      const pollStarted = Date.now();
      try {
        mockupData = await pRetry(
          async (attemptNumber) => {
            const data = await getProductMockups(printifyShopId, productId!, printifyApiToken);
            if (!data || data.urls.length === 0) {
              console.log(`[Printify Mockup] Poll attempt ${attemptNumber}: images not ready yet`);
              throw new Error("Mockups not ready yet");
            }
            return data;
          },
          {
            // Async job pattern lets us wait well past the old App Proxy 30s limit.
            // Total budget ~120s: 0.5s + 1s + 2s*60 attempts.
            retries: 60,
            minTimeout: 500,
            maxTimeout: 2000,
            onFailedAttempt: (err) => {
              const message = err.error instanceof Error ? err.error.message : String(err.error);
              console.log(`[Printify Mockup] Poll ${err.attemptNumber}/${err.attemptNumber + err.retriesLeft}: ${message}`);
            },
          }
        );
      } catch (pollErr: any) {
        const elapsedSec = Math.round((Date.now() - pollStarted) / 1000);
        const placementSummary = effectiveAopPositions?.length
          ? `placeholder(s): ${effectiveAopPositions.map((p) => p.position).join(", ")}`
          : `placement: ${effectivePrintPlacement ?? (doubleSided ? "both" : "front")}`;
        throw new Error(
          `Printify did not return mockup images after ${elapsedSec}s for blueprint ${blueprintId}, provider ${providerId}, variant ${variantId} (${placementSummary}). This product may need its Printify placeholder mapping updated.`,
        );
      }
    }

    const placementForViews = !isAop ? effectivePrintPlacement : undefined;
    const selected = selectPreferredViews(mockupData.images, isAop, placementForViews);

    return {
      success: true,
      mockupUrls: selected.map((s) => s.url),
      mockupImages: selected,
      source: "printify",
    };
  } catch (error: any) {
    return {
      success: false,
      mockupUrls: [],
      mockupImages: [],
      source: "fallback",
      error: error.message || "Unknown error",
    };
  } finally {
    if (productId) {
      await deleteProduct(printifyShopId, productId, printifyApiToken);
    }
  }
}
