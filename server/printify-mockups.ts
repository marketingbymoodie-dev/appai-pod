import sharp from "sharp";
import pRetry from "p-retry";

const PRINTIFY_API_BASE = "https://api.printify.com/v1";
const MAX_RETRIES = 3;
const MAX_PANEL_UPLOAD_CONCURRENCY = 5;
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

interface MockupRequest {
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
  wrapAround?: boolean;
  wrapDirection?: "horizontal" | "vertical";
  aopPositions?: { position: string; width: number; height: number }[];
  /** Per-panel canvas images (dataUrls) — already incorporate placement/mirror transforms. */
  panelUrls?: { position: string; dataUrl: string }[];
  /** Legacy: mirror flag. Client now bakes mirror into panelUrls so server-side handling is a no-op. */
  mirrorLegs?: boolean;
}

interface MockupImage {
  url: string;
  label: string;
}

interface MockupResult {
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

function normalizeImageUrl(url: string): string {
  if (typeof url !== "string") return url;
  const appUrl = process.env.APP_URL || "";
  if (appUrl && url.startsWith(appUrl) && url.includes("supabase.co")) {
    return url.replace(appUrl, "");
  }
  return url;
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
  aopPositions?: { position: string; width: number; height: number }[],
  mirroredImageId?: string,
  panelImageIds?: Map<string, string>
): Promise<{ productId: string } | { error: string }> {
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
      } else if (isRightPanel && mirroredImageId) {
        useImageId = mirroredImageId;
      } else {
        useImageId = imageId;
      }
      const entry = { ...imageEntry, id: useImageId };
      placeholders.push({ position: pos.position, images: [entry] });
    }
  } else {
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
      return { productId: product.id };
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
    if (!product.images || product.images.length === 0) return null;

    const images = product.images.map((img: any) => ({
      url: img.src,
      label: extractCameraLabel(img.src),
    }));

    return {
      urls: images.map((img: any) => img.url),
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

function selectPreferredViews(images: MockupImage[]): MockupImage[] {
  const selected: MockupImage[] = [];
  const seenUrls = new Set<string>();
  const annotated = images.map((img) => ({
    ...img,
    norm: normalizeMockupCameraLabel(img.label),
  }));

  for (const pref of PREFERRED_LABELS) {
    const prefNorm = normalizeMockupCameraLabel(pref);
    const match = annotated.find((img) => img.norm === prefNorm && !seenUrls.has(img.url));
    if (match) {
      selected.push({ url: match.url, label: match.label });
      seenUrls.add(match.url);
      if (selected.length >= MAX_MOCKUP_VIEWS) break;
    }
  }

  if (selected.length === 0 && images.length > 0) {
    return images.slice(0, MAX_MOCKUP_VIEWS);
  }

  return selected;
}

/** Test hook: same logic as internal mockup picker. */
export function pickPreferredMockupViews(images: { url: string; label: string }[]): { url: string; label: string }[] {
  return selectPreferredViews(images);
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

    if (isAop && request.panelUrls && request.panelUrls.length > 0) {
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

      const uploadResults = await mapWithConcurrency(
        request.panelUrls,
        MAX_PANEL_UPLOAD_CONCURRENCY,
        async ({ position, dataUrl }) => {
          try {
            const b64 = extractBase64FromDataUrl(dataUrl);
            if (!b64) {
              console.warn(`[Printify AOP] Panel "${position}" has no valid base64 data — skipping`);
              return { position, uploadedId: null as string | null };
            }

            let buf = Buffer.from(b64, "base64");
            const mime = getDataUrlMime(dataUrl);
            // Validate that the payload is a real image. Avoid re-encoding already-PNG
            // panels because the client now sends PNG mockup assets and re-encoding adds
            // server CPU time without improving the preview.
            await sharp(buf).metadata();
            if (mime !== "image/png") {
              buf = await sharp(buf).png().toBuffer();
            }

            console.log(`[Printify AOP] Panel "${position}" decoded: ${buf.length} bytes ${mime}`);
            const uploaded = await uploadImageToPrintify(buf, printifyApiToken);
            if (!uploaded) {
              console.warn(`[Printify AOP] Panel "${position}" upload returned null`);
              return { position, uploadedId: null as string | null };
            }

            console.log(
              `[Printify AOP] Panel "${position}" uploaded OK: id=${uploaded.id} ${uploaded.width}x${uploaded.height}`
            );
            return { position, uploadedId: uploaded.id };
          } catch (panelErr: any) {
            console.warn(`[Printify AOP] Panel "${position}" error: ${panelErr.message}`);
            return { position, uploadedId: null as string | null };
          }
        }
      );

      for (const result of uploadResults) {
        if (result.uploadedId) {
          panelImageIds.set(result.position, result.uploadedId);
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

      const expectedPositions = new Set((request.aopPositions ?? []).map((pos) => pos.position));
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
      uploadedImage = { id: panelImageIds.values().next().value as string };
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
      request.aopPositions,
      undefined,
      panelImageIds
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
    const mockupData = await pRetry(
      async (attemptNumber) => {
        const data = await getProductMockups(printifyShopId, productId!, printifyApiToken);
        if (!data || data.urls.length === 0) {
          console.log(`[Printify Mockup] Poll attempt ${attemptNumber}: images not ready yet`);
          throw new Error("Mockups not ready yet");
        }
        return data;
      },
      {
        retries: 20,
        minTimeout: 1000,
        maxTimeout: 4000,
        onFailedAttempt: (err) => {
          console.log(`[Printify Mockup] Poll ${err.attemptNumber}/${err.attemptNumber + err.retriesLeft}: ${err.message}`);
        },
      }
    );

    const selected = selectPreferredViews(mockupData.images);

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
