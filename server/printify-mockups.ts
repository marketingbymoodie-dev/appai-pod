import pRetry from "p-retry";
import sharp from "sharp";
import crypto from "crypto";
import { objectStorageClient, ObjectStorageService } from "./replit_integrations/object_storage";

const objectStorage = new ObjectStorageService();

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

async function duplicateImageSideBySide(imageUrl: string): Promise<Buffer> {
  let imageBuffer: Buffer;
  
  if (isDataUrl(imageUrl)) {
    const base64Data = extractBase64FromDataUrl(imageUrl);
    imageBuffer = Buffer.from(base64Data, 'base64');
  } else {
    if (!isAllowedImageUrl(imageUrl)) {
      throw new Error("Image URL not from allowed source");
    }
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    imageBuffer = Buffer.from(arrayBuffer);
  }
  
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 1024;
  const height = metadata.height || 1024;
  
  const duplicatedImage = await sharp({
    create: {
      width: width * 2,
      height: height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0 }
    }
  })
    .composite([
      { input: imageBuffer, left: 0, top: 0 },
      { input: imageBuffer, left: width, top: 0 }
    ])
    .png()
    .toBuffer();
  
  return duplicatedImage;
}

const MAX_RETRIES = 3;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function cacheMockupToStorage(printifyUrl: string, label: string): Promise<string | null> {
  try {
    const response = await fetch(printifyUrl);
    if (!response.ok) {
      console.warn(`[Mockup Cache] Failed to download mockup (${response.status}): ${printifyUrl.substring(0, 80)}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const hash = crypto.createHash("sha256").update(buffer).digest("hex").substring(0, 16);
    const mockupId = `${hash}_${label}`;

    const privateDir = objectStorage.getPrivateObjectDir();
    const fullPath = `${privateDir}/mockups/${mockupId}.jpg`;
    const pathWithSlash = fullPath.startsWith("/") ? fullPath : `/${fullPath}`;
    const pathParts = pathWithSlash.split("/").filter((p: string) => p.length > 0);

    if (pathParts.length < 2) {
      console.warn("[Mockup Cache] Invalid object path structure");
      return null;
    }

    const bucketName = pathParts[0];
    const objectName = pathParts.slice(1).join("/");
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);

    await file.save(buffer, {
      contentType: "image/jpeg",
      metadata: {
        metadata: {
          "custom:aclPolicy": JSON.stringify({ owner: "system", visibility: "public" }),
        },
      },
    });

    const cachedPath = `/objects/mockups/${mockupId}.jpg`;
    console.log(`[Mockup Cache] Cached mockup: ${cachedPath}`);
    return cachedPath;
  } catch (error) {
    console.warn("[Mockup Cache] Failed to cache mockup, using Printify URL as fallback:", error);
    return null;
  }
}

async function cacheMockupImages(
  mockupData: { urls: string[]; images: MockupImage[] }
): Promise<{ urls: string[]; images: MockupImage[] }> {
  const cachedUrls: string[] = [];
  const cachedImages: MockupImage[] = [];

  const results = await Promise.allSettled(
    mockupData.images.map((img) => cacheMockupToStorage(img.url, img.label))
  );

  for (let i = 0; i < mockupData.images.length; i++) {
    const result = results[i];
    const original = mockupData.images[i];

    if (result.status === "fulfilled" && result.value) {
      cachedUrls.push(result.value);
      cachedImages.push({ url: result.value, label: original.label });
    } else {
      cachedUrls.push(original.url);
      cachedImages.push(original);
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
  doubleSided: boolean = false
): Promise<{ productId: string } | { error: string }> {
  const printifyX = 0.5 + (x * 0.5);
  const printifyY = 0.5 + (y * 0.5);

  const placeholders = [
    {
      position: "front",
      images: [
        { id: imageId, x: printifyX, y: printifyY, scale: scale, angle: 0 },
      ],
    },
  ];

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
      console.log(`[Printify] Creating temp product (attempt ${attempt}/${MAX_RETRIES}):`, {
        shopId, blueprintId, providerId, variantId, imageId, scale, x: printifyX, y: printifyY,
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
    imageUrl,
    printifyApiToken,
    printifyShopId,
    scale = 1,
    x = 0,
    y = 0,
    doubleSided = false,
  } = request;

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
    let imageToUpload: string | Buffer = imageUrl;
    
    if (doubleSided) {
      console.log("Duplicating image side-by-side for double-sided product...");
      imageToUpload = await duplicateImageSideBySide(imageUrl);
      console.log("Image duplicated successfully, uploading to Printify...");
    }
    
    const uploadedImage = await uploadImageToPrintify(imageToUpload, printifyApiToken);
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
      doubleSided
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

    const mockupData = await pRetry(
      async () => {
        const data = await getProductMockups(printifyShopId, productId!, printifyApiToken);
        if (!data || data.urls.length === 0) {
          throw new Error("Mockups not ready yet");
        }
        return data;
      },
      {
        retries: 5,
        minTimeout: 2000,
        maxTimeout: 5000,
        onFailedAttempt: (error) => {
          console.log(`Attempt ${error.attemptNumber} failed. ${error.retriesLeft} retries left.`);
        },
      }
    );

    const cached = await cacheMockupImages(mockupData);

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
