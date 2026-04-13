import sharp from "sharp";
import pRetry from "p-retry";

const PRINTIFY_API_BASE = "https://api.printify.com/v1";
const MAX_RETRIES = 3;
const MAX_MOCKUP_VIEWS = 4;
const PREFERRED_LABELS = [
  "front",
  "back",
  "lifestyle",
  "on-person-1-front",
  "on-person-2-front",
  "on-person-3-front",
  "on-person-4-front",
  "on-person-5-front",
  "on-person-6-front",
  "on-person-7-front",
  "on-person-8-front",
  "on-person-9-front",
  "on-person-10-front",
  "on-person-11-front",
  "on-person-12-front",
  "on-person-13-front",
  "on-person-14-front",
  "on-person-15-front",
  "on-person-16-front",
  "on-person-17-front",
  "on-person-18-front",
  "on-person-19-front",
  "on-person-20-front",
  "on-person-21-front",
  "on-person-22-front",
  "on-person-23-front",
  "on-person-24-front",
  "on-person-25-front",
  "on-person-26-front",
  "on-person-27-front",
  "on-person-28-front",
  "on-person-29-front",
  "on-person-30-front",
  "on-person-31-front",
  "on-person-32-front",
  "on-person-33-front",
  "on-person-34-front",
  "on-person-35-front",
  "on-person-36-front",
  "on-person-37-front",
  "on-person-38-front",
  "on-person-39-front",
  "on-person-40-front",
  "on-person-41-front",
  "on-person-42-front",
  "on-person-43-front",
  "on-person-44-front",
  "on-person-45-front",
  "on-person-46-front",
  "on-person-47-front",
  "on-person-48-front",
  "on-person-49-front",
  "on-person-50-front",
  "on-person-51-front",
  "on-person-52-front",
  "on-person-53-front",
  "on-person-54-front",
  "on-person-55-front",
  "on-person-56-front",
  "on-person-57-front",
  "on-person-58-front",
  "on-person-59-front",
  "on-person-60-front",
  "on-person-61-front",
  "on-person-62-front",
  "on-person-63-front",
  "on-person-64-front",
  "on-person-65-front",
  "on-person-66-front",
  "on-person-67-front",
  "on-person-68-front",
  "on-person-69-front",
  "on-person-70-front",
  "on-person-71-front",
  "on-person-72-front",
  "on-person-73-front",
  "on-person-74-front",
  "on-person-75-front",
  "on-person-76-front",
  "on-person-77-front",
  "on-person-78-front",
  "on-person-79-front",
  "on-person-80-front",
  "on-person-81-front",
  "on-person-82-front",
  "on-person-83-front",
  "on-person-84-front",
  "on-person-85-front",
  "on-person-86-front",
  "on-person-87-front",
  "on-person-88-front",
  "on-person-89-front",
  "on-person-90-front",
  "on-person-91-front",
  "on-person-92-front",
  "on-person-93-front",
  "on-person-94-front",
  "on-person-95-front",
  "on-person-96-front",
  "on-person-97-front",
  "on-person-98-front",
  "on-person-99-front",
  "on-person-100-front",
];

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
  panelUrls?: { position: string; dataUrl: string }[];
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

function extractBase64FromDataUrl(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:image\/\w+;base64,(.+)$/);
  return match ? match[1] : null;
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

      const response = await fetch(
        `${PRINTIFY_API_BASE}/uploads/images.json`,
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
  return match ? match[1] : "front";
}

function selectPreferredViews(images: MockupImage[]): MockupImage[] {
  const selected: MockupImage[] = [];
  const seenLabels = new Set<string>();

  for (const label of PREFERRED_LABELS) {
    const match = images.find((img) => img.label === label);
    if (match && !seenLabels.has(label)) {
      selected.push(match);
      seenLabels.add(label);
      if (selected.length >= MAX_MOCKUP_VIEWS) break;
    }
  }

  if (selected.length === 0 && images.length > 0) {
    return images.slice(0, MAX_MOCKUP_VIEWS);
  }

  return selected;
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
      console.log(`[Printify AOP] Uploading ${request.panelUrls.length} per-panel images`);
      await Promise.all(request.panelUrls.map(async ({ position, dataUrl }) => {
        try {
          const b64 = extractBase64FromDataUrl(dataUrl);
          if (!b64) {
            console.warn(`[Printify AOP] Panel "${position}" has no valid base64 data`);
            return;
          }
          let buf = Buffer.from(b64, "base64");
          buf = await sharp(buf).png().toBuffer();
          const uploaded = await uploadImageToPrintify(buf, printifyApiToken);
          if (uploaded) {
            panelImageIds.set(position, uploaded.id);
            console.log(`[Printify AOP] Panel "${position}" uploaded: ${uploaded.id}`);
          } else {
            console.warn(`[Printify AOP] Panel "${position}" upload failed`);
          }
        } catch (panelErr: any) {
          console.warn(`[Printify AOP] Panel "${position}" error: ${panelErr.message}`);
        }
      }));
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
      async () => {
        const data = await getProductMockups(printifyShopId, productId!, printifyApiToken);
        if (!data || data.urls.length === 0) throw new Error("Mockups not ready yet");
        return data;
      },
      {
        retries: 5,
        minTimeout: 2000,
        maxTimeout: 5000,
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
