import pRetry from "p-retry";

interface MockupRequest {
  blueprintId: number;
  providerId: number;
  variantId: number;
  imageUrl: string;
  printifyApiToken: string;
  printifyShopId: string;
}

interface MockupResult {
  success: boolean;
  mockupUrls: string[];
  source: "printify" | "fallback";
  error?: string;
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

async function uploadImageToPrintify(
  imageUrl: string,
  apiToken: string
): Promise<PrintifyImage | null> {
  try {
    let requestBody: Record<string, string>;

    if (isDataUrl(imageUrl)) {
      const base64Data = extractBase64FromDataUrl(imageUrl);
      if (!base64Data) {
        console.error("Failed to extract base64 from data URL");
        return null;
      }
      requestBody = {
        file_name: `design-${Date.now()}.png`,
        contents: base64Data,
      };
    } else {
      requestBody = {
        file_name: `design-${Date.now()}.png`,
        url: imageUrl,
      };
    }

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
      console.error("Failed to upload image to Printify:", response.status, errorText);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error("Error uploading image to Printify:", error);
    return null;
  }
}

async function createTemporaryProduct(
  shopId: string,
  blueprintId: number,
  providerId: number,
  variantId: number,
  imageId: string,
  apiToken: string
): Promise<string | null> {
  try {
    const response = await fetch(
      `${PRINTIFY_API_BASE}/shops/${shopId}/products.json`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: `Mockup Preview - ${Date.now()}`,
          description: "Temporary product for mockup generation",
          blueprint_id: blueprintId,
          print_provider_id: providerId,
          variants: [
            {
              id: variantId,
              price: 100, // Minimum price required by Printify (in cents)
              is_enabled: true,
            },
          ],
          print_areas: [
            {
              variant_ids: [variantId],
              placeholders: [
                {
                  position: "front",
                  images: [
                    {
                      id: imageId,
                      x: 0.5,
                      y: 0.5,
                      scale: 1,
                      angle: 0,
                    },
                  ],
                },
              ],
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("Failed to create Printify product:", error);
      return null;
    }

    const product = await response.json();
    return product.id;
  } catch (error) {
    console.error("Error creating Printify product:", error);
    return null;
  }
}

async function getProductMockups(
  shopId: string,
  productId: string,
  apiToken: string
): Promise<string[] | null> {
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

    if (product.images && Array.isArray(product.images)) {
      for (const image of product.images) {
        if (image.src) {
          mockupUrls.push(image.src);
        }
      }
    }

    return mockupUrls.length > 0 ? mockupUrls : null;
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
  } = request;

  if (!printifyApiToken || !printifyShopId) {
    return {
      success: false,
      mockupUrls: [],
      source: "fallback",
      error: "Printify credentials not configured",
    };
  }

  let productId: string | null = null;

  try {
    const uploadedImage = await uploadImageToPrintify(imageUrl, printifyApiToken);
    if (!uploadedImage) {
      return {
        success: false,
        mockupUrls: [],
        source: "fallback",
        error: "Failed to upload image to Printify",
      };
    }

    productId = await createTemporaryProduct(
      printifyShopId,
      blueprintId,
      providerId,
      variantId,
      uploadedImage.id,
      printifyApiToken
    );

    if (!productId) {
      return {
        success: false,
        mockupUrls: [],
        source: "fallback",
        error: "Failed to create temporary product",
      };
    }

    const mockupUrls = await pRetry(
      async () => {
        const urls = await getProductMockups(printifyShopId, productId!, printifyApiToken);
        if (!urls || urls.length === 0) {
          throw new Error("Mockups not ready yet");
        }
        return urls;
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

    return {
      success: true,
      mockupUrls,
      source: "printify",
    };
  } catch (error) {
    console.error("Printify mockup generation failed:", error);
    return {
      success: false,
      mockupUrls: [],
      source: "fallback",
      error: error instanceof Error ? error.message : "Unknown error",
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
