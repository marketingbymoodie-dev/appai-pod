import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import sharp from "sharp";
import { removeBackground } from "@imgly/background-removal-node";
import { storage } from "./storage";
import { setupAuth, isAuthenticated, registerAuthRoutes } from "./replit_integrations/auth";
import { PRINT_SIZES, FRAME_COLORS, STYLE_PRESETS, APPAREL_DARK_TIER_PROMPTS, type InsertDesign, getColorTier, type ColorTier } from "@shared/schema";
import { Modality } from "@google/genai";
import { ai } from "./replit_integrations/image/client";
import { registerShopifyRoutes } from "./shopify";
import { ObjectStorageService, registerObjectStorageRoutes, objectStorageClient } from "./replit_integrations/object_storage";

const objectStorage = new ObjectStorageService();

const THUMBNAIL_SIZE = 256; // Max dimension for thumbnails

async function generateThumbnail(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: 80 })
    .toBuffer();
}

interface SaveImageResult {
  imageUrl: string;
  thumbnailUrl: string;
}

interface TargetDimensions {
  width: number;
  height: number;
}

async function resizeToAspectRatio(buffer: Buffer, targetDims: TargetDimensions, outputFormat: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
  const metadata = await sharp(buffer).metadata();
  const srcWidth = metadata.width || 1024;
  const srcHeight = metadata.height || 1024;
  
  const targetRatio = targetDims.width / targetDims.height;
  const srcRatio = srcWidth / srcHeight;
  
  let cropWidth = srcWidth;
  let cropHeight = srcHeight;
  let cropLeft = 0;
  let cropTop = 0;
  
  if (srcRatio > targetRatio) {
    cropWidth = Math.round(srcHeight * targetRatio);
    cropLeft = Math.round((srcWidth - cropWidth) / 2);
  } else if (srcRatio < targetRatio) {
    cropHeight = Math.round(srcWidth / targetRatio);
    cropTop = Math.round((srcHeight - cropHeight) / 2);
  }
  
  const sharpInstance = sharp(buffer)
    .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
    .resize(targetDims.width, targetDims.height, { fit: 'fill' });
  
  if (outputFormat === 'jpeg') {
    return sharpInstance.jpeg({ quality: 90 }).toBuffer();
  }
  return sharpInstance.png().toBuffer();
}

/**
 * Remove background from an image using ML-based segmentation (ONNX model).
 * 
 * Uses @imgly/background-removal-node which provides production-quality
 * background removal using trained neural networks. This handles:
 * - Anti-aliasing correctly
 * - Preserves thin strokes and details
 * - Works with any background color
 * - No halos or artifacts
 * 
 * @param buffer - The image buffer to process
 * @returns Buffer with transparent background as PNG
 */
async function removeImageBackground(buffer: Buffer): Promise<Buffer> {
  console.log("Starting ML-based background removal...");
  const startTime = Date.now();
  
  try {
    // Convert buffer to Blob for the library
    const blob = new Blob([buffer], { type: 'image/png' });
    
    // Run ML background removal with small model for faster processing
    const resultBlob = await removeBackground(blob, {
      model: 'small',  // Use small model (44MB) for faster processing
      output: {
        format: 'image/png',
        quality: 1.0
      }
    });
    
    // Convert result blob back to buffer
    const arrayBuffer = await resultBlob.arrayBuffer();
    const resultBuffer = Buffer.from(arrayBuffer);
    
    const elapsed = Date.now() - startTime;
    console.log(`ML background removal complete in ${elapsed}ms`);
    
    return resultBuffer;
  } catch (error) {
    console.error("ML background removal failed, falling back to pixel-based:", error);
    // Fallback to pixel-based removal if ML fails
    return removeBackgroundFallback(buffer, false);
  }
}

/**
 * Fallback: Simple pixel-based background removal.
 * Used when ML-based removal fails or for legacy compatibility.
 * @param buffer - The image buffer to process
 * @param isDarkBackground - Whether the background is dark (charcoal) instead of white
 */
async function removeBackgroundFallback(buffer: Buffer, isDarkBackground: boolean = false): Promise<Buffer> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  
  const width = info.width;
  const height = info.height;
  const pixels = new Uint8Array(data);
  const totalPixels = width * height;
  
  // Thresholds for white background (luminance >= 245, low chroma)
  // Thresholds for dark background (luminance <= 60, low chroma)
  const LIGHT_LUMINANCE_THRESHOLD = 245;
  const DARK_LUMINANCE_THRESHOLD = 60;
  const MAX_CHROMA = 8;
  
  let pixelsRemoved = 0;
  
  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    const a = pixels[idx + 3];
    
    if (a === 0) continue;
    
    const luminance = (r + g + b) / 3;
    const maxRGB = Math.max(r, g, b);
    const minRGB = Math.min(r, g, b);
    const chromaDistance = maxRGB - minRGB;
    
    const shouldRemove = isDarkBackground
      ? (luminance <= DARK_LUMINANCE_THRESHOLD && chromaDistance <= MAX_CHROMA)
      : (luminance >= LIGHT_LUMINANCE_THRESHOLD && chromaDistance <= MAX_CHROMA);
    
    if (shouldRemove) {
      pixels[idx + 3] = 0;
      pixelsRemoved++;
    }
  }
  
  console.log(`Fallback background removal (${isDarkBackground ? 'dark' : 'light'}): removed ${pixelsRemoved} pixels (${(pixelsRemoved / totalPixels * 100).toFixed(1)}%)`);
  
  return sharp(Buffer.from(pixels), {
    raw: { width, height, channels: 4 }
  })
    .png()
    .toBuffer();
}

interface SaveImageOptions {
  isApparel?: boolean;
  targetDims?: TargetDimensions;
  colorTier?: ColorTier;
}

async function saveImageToStorage(base64Data: string, mimeType: string, options?: SaveImageOptions): Promise<SaveImageResult> {
  const { isApparel = false, targetDims, colorTier } = options || {};
  const imageId = crypto.randomUUID();
  let actualMimeType = mimeType.toLowerCase();
  let extension = actualMimeType.includes("png") ? "png" : "jpg";
  const privateDir = objectStorage.getPrivateObjectDir();
  
  let buffer = Buffer.from(base64Data, "base64");
  
  // For apparel, remove background using ML-based segmentation
  if (isApparel) {
    console.log("Removing background for apparel image using ML...");
    buffer = await removeImageBackground(buffer);
    // Force PNG for transparency support
    extension = "png";
    actualMimeType = "image/png";
    console.log("Background removal complete - image now has transparency");
  } else if (targetDims && (targetDims.width !== targetDims.height)) {
    // Only resize for non-apparel (apparel stays square)
    const outputFormat = actualMimeType.includes("jpeg") || actualMimeType.includes("jpg") ? 'jpeg' : 'png';
    buffer = await resizeToAspectRatio(buffer, targetDims, outputFormat);
    extension = outputFormat === 'jpeg' ? 'jpg' : 'png';
    actualMimeType = outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
  }
  
  // privateDir is like /bucket-name/.private, we need to parse it correctly
  const fullPath = `${privateDir}/designs/${imageId}.${extension}`;
  const thumbPath = `${privateDir}/designs/thumb_${imageId}.jpg`;
  
  // Parse the path: first segment is bucket name, rest is object name
  const pathWithSlash = fullPath.startsWith("/") ? fullPath : `/${fullPath}`;
  const pathParts = pathWithSlash.split("/").filter(p => p.length > 0);
  
  if (pathParts.length < 2) {
    throw new Error("Invalid object path structure");
  }
  
  const bucketName = pathParts[0];
  const objectName = pathParts.slice(1).join("/");
  const thumbObjectName = `.private/designs/thumb_${imageId}.jpg`;
  const thumbnailBuffer = await generateThumbnail(buffer);
  
  const bucket = objectStorageClient.bucket(bucketName);
  
  // Save original image
  const file = bucket.file(objectName);
  await file.save(buffer, {
    contentType: actualMimeType,
    metadata: {
      metadata: {
        "custom:aclPolicy": JSON.stringify({ owner: "system", visibility: "public" })
      }
    }
  });
  
  // Save thumbnail
  const thumbFile = bucket.file(thumbObjectName);
  await thumbFile.save(thumbnailBuffer, {
    contentType: "image/jpeg",
    metadata: {
      metadata: {
        "custom:aclPolicy": JSON.stringify({ owner: "system", visibility: "public" })
      }
    }
  });
  
  // Return paths that the /objects/* route expects
  return {
    imageUrl: `/objects/designs/${imageId}.${extension}`,
    thumbnailUrl: `/objects/designs/thumb_${imageId}.jpg`
  };
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<globalThis.Response> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const delay = retryAfter 
          ? parseInt(retryAfter) * 1000 
          : baseDelay * Math.pow(2, attempt);
        
        if (attempt < maxRetries) {
          console.log(`Rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
      
      return response;
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`Fetch error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}):`, error);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError || new Error('Max retries exceeded');
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await setupAuth(app);
  registerAuthRoutes(app);
  registerShopifyRoutes(app);
  registerObjectStorageRoutes(app);

  // Get product configuration
  app.get("/api/config", async (_req: Request, res: Response) => {
    try {
      // Get all active style presets from database
      const dbStyles = await storage.getAllActiveStylePresets();
      
      // Convert database styles to the format expected by the frontend
      // If no database styles exist, fall back to hardcoded presets with consistent shape
      const stylePresets = dbStyles.length > 0 
        ? dbStyles.map(s => ({
            id: s.id.toString(),
            name: s.name,
            promptSuffix: s.promptPrefix,
            category: s.category || "all",
          }))
        : STYLE_PRESETS.map(s => ({
            id: s.id,
            name: s.name,
            promptSuffix: s.promptPrefix,
            category: s.category,
          }));
      
      res.json({
        sizes: PRINT_SIZES,
        frameColors: FRAME_COLORS,
        stylePresets,
        blueprintId: 540,
      });
    } catch (error) {
      console.error("Error fetching config:", error);
      // Fallback to hardcoded presets on error with consistent shape
      res.json({
        sizes: PRINT_SIZES,
        frameColors: FRAME_COLORS,
        stylePresets: STYLE_PRESETS.map(s => ({
          id: s.id,
          name: s.name,
          promptSuffix: s.promptPrefix,
          category: s.category,
        })),
        blueprintId: 540,
      });
    }
  });

  // Get or create customer profile
  app.get("/api/customer", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      let customer = await storage.getCustomerByUserId(userId);
      
      if (!customer) {
        customer = await storage.createCustomer({
          userId,
          credits: 5,
          freeGenerationsUsed: 0,
          totalGenerations: 0,
          totalSpent: "0.00",
        });
      }
      
      res.json(customer);
    } catch (error) {
      console.error("Error fetching customer:", error);
      res.status(500).json({ error: "Failed to fetch customer" });
    }
  });

  // Get customer's designs (paginated)
  app.get("/api/designs", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const customer = await storage.getCustomerByUserId(userId);
      
      if (!customer) {
        return res.json({ designs: [], total: 0, hasMore: false });
      }
      
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 12;
      const offset = (page - 1) * limit;
      
      const { designs, total } = await storage.getDesignsByCustomerPaginated(customer.id, limit, offset);
      const hasMore = offset + designs.length < total;
      
      res.json({ designs, total, hasMore });
    } catch (error) {
      console.error("Error fetching designs:", error);
      res.status(500).json({ error: "Failed to fetch designs" });
    }
  });

  // Get single design
  app.get("/api/designs/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const designId = parseInt(req.params.id);
      const design = await storage.getDesign(designId);
      
      if (!design) {
        return res.status(404).json({ error: "Design not found" });
      }
      
      res.json(design);
    } catch (error) {
      console.error("Error fetching design:", error);
      res.status(500).json({ error: "Failed to fetch design" });
    }
  });

  // Update design transforms
  app.patch("/api/designs/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const designId = parseInt(req.params.id);
      const { transformScale, transformX, transformY, size, frameColor } = req.body;
      
      const design = await storage.getDesign(designId);
      if (!design) {
        return res.status(404).json({ error: "Design not found" });
      }

      const customer = await storage.getCustomerByUserId(userId);
      if (!customer || design.customerId !== customer.id) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const clamp = (val: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, val)));

      const updateData: Partial<typeof design> = {
        transformScale: clamp(transformScale ?? design.transformScale ?? 135, 25, 135),
        transformX: clamp(transformX ?? design.transformX ?? 50, 0, 100),
        transformY: clamp(transformY ?? design.transformY ?? 50, 0, 100),
      };

      if (size !== undefined) {
        updateData.size = size;
      }
      if (frameColor !== undefined) {
        updateData.frameColor = frameColor;
      }

      const updated = await storage.updateDesign(designId, updateData);

      res.json(updated);
    } catch (error) {
      console.error("Error updating design:", error);
      res.status(500).json({ error: "Failed to update design" });
    }
  });

  // Generate artwork
  app.post("/api/generate", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      let customer = await storage.getCustomerByUserId(userId);
      
      if (!customer) {
        customer = await storage.createCustomer({
          userId,
          credits: 5,
          freeGenerationsUsed: 0,
          totalGenerations: 0,
          totalSpent: "0.00",
        });
      }

      // Check credits
      if (customer.credits <= 0) {
        return res.status(400).json({ 
          error: "No credits remaining. Please purchase more credits.",
          needsCredits: true 
        });
      }

      // Check design gallery limit (50 max)
      const designCount = await storage.getDesignCountByCustomer(customer.id);
      if (designCount >= 50) {
        return res.status(400).json({ 
          error: "Your design gallery is full (50 designs max). Please delete some designs to save new ones.",
          galleryFull: true 
        });
      }

      const { prompt, stylePreset, size, frameColor, referenceImage, productTypeId, bgRemovalSensitivity } = req.body;

      if (!prompt || !size) {
        return res.status(400).json({ error: "Prompt and size are required" });
      }

      // Load product type if provided (needed for style lookup)
      let productType = null;
      if (productTypeId) {
        productType = await storage.getProductType(parseInt(productTypeId));
      }

      // Look up style preset and get its promptSuffix
      let stylePromptPrefix = "";
      if (stylePreset) {
        // Use product type's merchant for style lookup (merchant-scoped styles)
        const merchantId = productType?.merchantId;
        if (merchantId) {
          const dbStyles = await storage.getStylePresetsByMerchant(merchantId);
          const selectedStyle = dbStyles.find((s: { id: number; promptPrefix: string | null }) => s.id.toString() === stylePreset);
          if (selectedStyle && selectedStyle.promptPrefix) {
            stylePromptPrefix = selectedStyle.promptPrefix;
          }
        }
        // Fall back to hardcoded STYLE_PRESETS only if no merchant context or no match
        if (!stylePromptPrefix) {
          const hardcodedStyle = STYLE_PRESETS.find(s => s.id === stylePreset);
          if (hardcodedStyle && hardcodedStyle.promptPrefix) {
            stylePromptPrefix = hardcodedStyle.promptPrefix;
          }
        }
      }


      // Find size config - check product type sizes first, then fall back to PRINT_SIZES
      let sizeConfig = PRINT_SIZES.find(s => s.id === size);
      
      // Helper function to calculate generation dimensions from aspect ratio
      const calculateGenDimensions = (aspectRatioStr: string): { genWidth: number; genHeight: number } => {
        const [w, h] = aspectRatioStr.split(":").map(Number);
        if (!w || !h || isNaN(w) || isNaN(h)) {
          return { genWidth: 1024, genHeight: 1024 };
        }
        const ratio = w / h;
        const maxDim = 1024;
        if (ratio >= 1) {
          // Landscape or square
          return { genWidth: maxDim, genHeight: Math.round(maxDim / ratio) };
        } else {
          // Portrait
          return { genWidth: Math.round(maxDim * ratio), genHeight: maxDim };
        }
      };

      if (!sizeConfig && productType) {
        // Try to find size in product type's sizes (for apparel, etc.)
        const productSizes = JSON.parse(productType.sizes || "[]");
        const productSize = productSizes.find((s: any) => s.id === size);
        if (productSize) {
          // Use size-specific aspect ratio if available, otherwise fall back to product type's
          const aspectRatioStr = productSize.aspectRatio || productType.aspectRatio || "3:4";
          const genDims = calculateGenDimensions(aspectRatioStr);
          
          sizeConfig = {
            id: productSize.id,
            name: productSize.name,
            width: productSize.width || 12,
            height: productSize.height || 16,
            aspectRatio: aspectRatioStr,
            genWidth: genDims.genWidth,
            genHeight: genDims.genHeight,
          } as any;
        }
      }
      
      if (!sizeConfig) {
        // Default fallback - use product type's aspect ratio if available
        const aspectRatioStr = productType?.aspectRatio || "3:4";
        const genDims = calculateGenDimensions(aspectRatioStr);
        sizeConfig = { id: size, name: size, width: 12, height: 16, aspectRatio: aspectRatioStr, genWidth: genDims.genWidth, genHeight: genDims.genHeight } as any;
      }

      // Now sizeConfig is guaranteed to be defined
      const finalSizeConfig = sizeConfig!;
      const aspectRatioStr = (finalSizeConfig as any).aspectRatio || "1:1";
      
      // Check if this is an apparel product - either from productType or from style preset category
      let isApparel = productType?.designerType === "apparel";
      
      // Also detect apparel from style preset category if no productType
      if (!isApparel && stylePreset) {
        const hardcodedStyle = STYLE_PRESETS.find(s => s.id === stylePreset);
        if (hardcodedStyle && hardcodedStyle.category === "apparel") {
          isApparel = true;
        }
      }

      // Determine color tier for apparel products
      let colorTier: ColorTier = "light"; // Default to light (dark designs on white background)
      
      if (isApparel && frameColor) {
        // Look up the color's hex value from product type's frameColors
        let colorHex = "#f5f5f5"; // Default to white/light
        
        if (productType) {
          const frameColors = JSON.parse(productType.frameColors || "[]");
          const selectedColor = frameColors.find((c: { id: string; hex: string }) => c.id === frameColor);
          if (selectedColor?.hex) {
            colorHex = selectedColor.hex;
          }
        } else {
          // Fall back to FRAME_COLORS for framed prints
          const selectedColor = FRAME_COLORS.find(c => c.id === frameColor);
          if (selectedColor?.hex) {
            colorHex = selectedColor.hex;
          }
        }
        
        colorTier = getColorTier(colorHex);
        console.log(`[Generate] Apparel color tier: ${colorTier} (color: ${frameColor}, hex: ${colorHex})`);
      }

      // Apply style prompt prefix - use dark tier variant for apparel on dark colors
      let fullPrompt: string;
      
      if (isApparel && colorTier === "dark" && stylePreset && APPAREL_DARK_TIER_PROMPTS[stylePreset]) {
        // Use dark tier prompt for dark apparel (light designs on dark background)
        const darkTierPrompt = APPAREL_DARK_TIER_PROMPTS[stylePreset];
        fullPrompt = darkTierPrompt ? `${darkTierPrompt} ${prompt}` : prompt;
        console.log(`[Generate] Using dark tier prompt for ${stylePreset}`);
      } else {
        fullPrompt = stylePromptPrefix 
          ? `${stylePromptPrefix} ${prompt}` 
          : prompt;
      }

      // Different requirements for apparel vs wall art
      let sizingRequirements: string;
      
      if (isApparel) {
        // Apparel needs centered isolated designs with contrasting backgrounds (for easy removal)
        const isDarkTier = colorTier === "dark";
        const bgColor = isDarkTier ? "DARK CHARCOAL GRAY (#333333)" : "PURE WHITE (#FFFFFF)";
        const designColors = isDarkTier 
          ? "BRIGHT, VIBRANT colors including white and light tones. AVOID dark and black colors in the design."
          : "VIBRANT colors. AVOID white and light colors in the design.";
        
        sizingRequirements = `

MANDATORY IMAGE REQUIREMENTS FOR APPAREL PRINTING - FOLLOW EXACTLY:
1. ISOLATED DESIGN: Create a SINGLE, centered graphic design that is ISOLATED from any background scenery.
2. SOLID ${bgColor} BACKGROUND: The design MUST be on a ${bgColor} background. DO NOT create scenic backgrounds, landscapes, or detailed environments. The solid background can be easily removed for printing.
3. DESIGN COLORS: Use ${designColors}
4. CENTERED COMPOSITION: The main design subject should be centered and take up approximately 60-70% of the canvas, leaving clean space around it.
5. CLEAN EDGES: The design must have crisp, clean edges suitable for printing on fabric. No fuzzy or gradient edges that blend into the background.
6. NO RECTANGULAR FRAMES: Do NOT put the design inside a rectangular box, border, or frame. The design should stand alone on the solid background.
7. PRINT-READY: This is for t-shirt/apparel printing - create an isolated graphic that can be printed on fabric.
8. SQUARE FORMAT: Create a 1:1 square composition with the design centered.
`;
      } else {
        // Wall art needs full-bleed edge-to-edge designs
        sizingRequirements = `

MANDATORY IMAGE REQUIREMENTS - FOLLOW EXACTLY:
1. FULL-BLEED: The image MUST extend edge-to-edge, filling the ENTIRE canvas with NO margins, borders, frames, or empty space around the edges.
2. NO FLOATING: The subject must NOT appear to be floating or cropped. The artwork must have a complete background that extends to all edges.
3. NO PICTURE FRAMES: Do NOT include any decorative borders, picture frames, drop shadows, or vignettes around the image. The image will be printed and framed separately.
4. COMPOSITION: ${aspectRatioStr === "1:1" ? "Square 1:1 composition" : `Vertical portrait ${aspectRatioStr} composition`} - the artwork fills the entire canvas.
5. SAFE ZONE: Keep all important elements (text, faces, key subjects) within the central 75% of the image to ensure nothing is cut off when framed.
6. BACKGROUND: The background/scene must extend fully to all four edges of the image with NO visible canvas edges or cutoffs.
7. PRINT-READY: This is for high-quality wall art printing - create a complete, finished artwork that fills the entire image area.
`;
      }

      // Append sizing requirements to prompt
      fullPrompt += sizingRequirements;

      // Generate image using Nano Banana
      const contents: any[] = [{ role: "user", parts: [{ text: fullPrompt }] }];
      
      // Add reference image if provided
      if (referenceImage) {
        const base64Data = referenceImage.replace(/^data:image\/\w+;base64,/, "");
        contents[0].parts.unshift({
          inlineData: {
            mimeType: "image/png",
            data: base64Data,
          },
        });
      }

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents,
        config: {
          responseModalities: [Modality.TEXT, Modality.IMAGE],
        },
      });

      const candidate = response.candidates?.[0];
      const imagePart = candidate?.content?.parts?.find(
        (part: any) => part.inlineData
      );

      if (!imagePart?.inlineData?.data) {
        await storage.createGenerationLog({
          customerId: customer.id,
          promptLength: prompt.length,
          hadReferenceImage: !!referenceImage,
          stylePreset,
          size,
          success: false,
          errorMessage: "No image data in response",
        });
        return res.status(500).json({ error: "Failed to generate image" });
      }

      const mimeType = imagePart.inlineData.mimeType || "image/png";
      
      // Get target dimensions for resizing - skip for apparel (keep square)
      let targetDims: TargetDimensions | undefined;
      if (!isApparel) {
        const genWidth = (finalSizeConfig as any).genWidth || 1024;
        const genHeight = (finalSizeConfig as any).genHeight || 1024;
        targetDims = { width: genWidth, height: genHeight };
      }
      
      // Save image to object storage (with background removal for apparel, aspect ratio resizing for wall art)
      let generatedImageUrl: string;
      let thumbnailImageUrl: string | undefined;
      try {
        const result = await saveImageToStorage(imagePart.inlineData.data, mimeType, { 
          isApparel, 
          targetDims,
          colorTier: isApparel ? colorTier : undefined
        });
        generatedImageUrl = result.imageUrl;
        thumbnailImageUrl = result.thumbnailUrl;
      } catch (storageError) {
        console.error("Failed to save to object storage, falling back to base64:", storageError);
        generatedImageUrl = `data:${mimeType};base64,${imagePart.inlineData.data}`;
      }

      // Create design record
      const design = await storage.createDesign({
        customerId: customer.id,
        prompt,
        stylePreset: stylePreset || null,
        referenceImageUrl: referenceImage ? "uploaded" : null,
        generatedImageUrl,
        thumbnailImageUrl,
        size,
        frameColor: frameColor || "black",
        aspectRatio: aspectRatioStr,
        colorTier: isApparel ? colorTier : null,
        status: "completed",
      });

      // Deduct credit
      await storage.updateCustomer(customer.id, {
        credits: customer.credits - 1,
        totalGenerations: customer.totalGenerations + 1,
      });

      // Log generation
      await storage.createGenerationLog({
        customerId: customer.id,
        designId: design.id,
        promptLength: prompt.length,
        hadReferenceImage: !!referenceImage,
        stylePreset,
        size,
        success: true,
      });

      // Create credit transaction
      await storage.createCreditTransaction({
        customerId: customer.id,
        type: "generation",
        amount: -1,
        description: `Generated artwork: ${prompt.substring(0, 50)}...`,
      });

      res.json({
        design,
        creditsRemaining: customer.credits - 1,
      });
    } catch (error) {
      console.error("Error generating artwork:", error);
      res.status(500).json({ error: "Failed to generate artwork" });
    }
  });

  // Regenerate design for a different color tier (costs 1 credit)
  // Used when user switches between light/dark apparel colors
  app.post("/api/generate/regenerate-tier", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const customer = await storage.getCustomerByUserId(userId);
      
      if (!customer) {
        return res.status(401).json({ error: "Customer not found" });
      }

      const { designId, newColorTier, newFrameColor } = req.body;
      
      if (!designId || !newColorTier) {
        return res.status(400).json({ error: "Design ID and new color tier are required" });
      }

      // Check credits (regeneration costs 1 credit)
      if (customer.credits < 1) {
        return res.status(402).json({ 
          error: "Insufficient credits", 
          creditsRequired: 1,
          creditsRemaining: customer.credits
        });
      }

      // Get the original design
      const originalDesign = await storage.getDesign(designId);
      if (!originalDesign) {
        return res.status(404).json({ error: "Design not found" });
      }

      // Verify ownership
      if (originalDesign.customerId !== customer.id) {
        return res.status(403).json({ error: "Not authorized to modify this design" });
      }

      // Get the product type for style lookup
      let productType = null;
      if (originalDesign.productTypeId) {
        productType = await storage.getProductType(originalDesign.productTypeId);
      }

      // Look up the original style preset
      let stylePromptPrefix = "";
      const stylePreset = originalDesign.stylePreset;
      
      if (stylePreset) {
        // For dark tier, use the dark tier prompt variants
        if (newColorTier === "dark" && APPAREL_DARK_TIER_PROMPTS[stylePreset]) {
          stylePromptPrefix = APPAREL_DARK_TIER_PROMPTS[stylePreset];
        } else {
          // Use regular prompt
          const hardcodedStyle = STYLE_PRESETS.find(s => s.id === stylePreset);
          if (hardcodedStyle && hardcodedStyle.promptPrefix) {
            stylePromptPrefix = hardcodedStyle.promptPrefix;
          }
        }
      }

      // Build the prompt
      const prompt = originalDesign.prompt;
      let fullPrompt = stylePromptPrefix ? `${stylePromptPrefix} ${prompt}` : prompt;
      
      // Add sizing requirements based on color tier
      const isDarkTier = newColorTier === "dark";
      const bgColor = isDarkTier ? "DARK CHARCOAL GRAY (#333333)" : "PURE WHITE (#FFFFFF)";
      const designColors = isDarkTier 
        ? "BRIGHT, VIBRANT colors including white and light tones. AVOID dark and black colors in the design."
        : "VIBRANT colors. AVOID white and light colors in the design.";
      
      fullPrompt += `

MANDATORY IMAGE REQUIREMENTS FOR APPAREL PRINTING - FOLLOW EXACTLY:
1. ISOLATED DESIGN: Create a SINGLE, centered graphic design that is ISOLATED from any background scenery.
2. SOLID ${bgColor} BACKGROUND: The design MUST be on a ${bgColor} background. DO NOT create scenic backgrounds, landscapes, or detailed environments. The solid background can be easily removed for printing.
3. DESIGN COLORS: Use ${designColors}
4. CENTERED COMPOSITION: The main design subject should be centered and take up approximately 60-70% of the canvas, leaving clean space around it.
5. CLEAN EDGES: The design must have crisp, clean edges suitable for printing on fabric. No fuzzy or gradient edges that blend into the background.
6. NO RECTANGULAR FRAMES: Do NOT put the design inside a rectangular box, border, or frame. The design should stand alone on the solid background.
7. PRINT-READY: This is for t-shirt/apparel printing - create an isolated graphic that can be printed on fabric.
8. SQUARE FORMAT: Create a 1:1 square composition with the design centered.
`;

      console.log(`[Regenerate-Tier] Regenerating design ${designId} for ${newColorTier} tier`);

      // Generate the new image
      const contents: any[] = [{ role: "user", parts: [{ text: fullPrompt }] }];
      
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents,
        config: {
          responseModalities: [Modality.TEXT, Modality.IMAGE],
        },
      });

      const candidate = response.candidates?.[0];
      const imagePart = candidate?.content?.parts?.find(
        (part: any) => part.inlineData
      );

      if (!imagePart?.inlineData?.data) {
        return res.status(500).json({ error: "Failed to regenerate image" });
      }

      const mimeType = imagePart.inlineData.mimeType || "image/png";

      // Save image with background removal
      let generatedImageUrl: string;
      let thumbnailImageUrl: string | undefined;
      try {
        const result = await saveImageToStorage(imagePart.inlineData.data, mimeType, { 
          isApparel: true, 
          colorTier: newColorTier as ColorTier
        });
        generatedImageUrl = result.imageUrl;
        thumbnailImageUrl = result.thumbnailUrl;
      } catch (storageError) {
        console.error("Failed to save regenerated image:", storageError);
        generatedImageUrl = `data:${mimeType};base64,${imagePart.inlineData.data}`;
      }

      // Store the current image as alternate before updating
      const updateData: any = {
        colorTier: newColorTier,
        frameColor: newFrameColor || originalDesign.frameColor,
      };

      // If we have an existing image and it's different from the new one, store it as alternate
      if (originalDesign.generatedImageUrl && !originalDesign.generatedImageUrl.startsWith('data:')) {
        updateData.alternateImageUrl = originalDesign.generatedImageUrl;
      }
      
      updateData.generatedImageUrl = generatedImageUrl;
      if (thumbnailImageUrl) {
        updateData.thumbnailImageUrl = thumbnailImageUrl;
      }

      // Update the design with new image and tier
      const updatedDesign = await storage.updateDesign(designId, updateData);

      // Deduct 1 credit for regeneration
      await storage.updateCustomer(customer.id, { credits: customer.credits - 1 });

      // Log the regeneration
      await storage.createGenerationLog({
        customerId: customer.id,
        designId: designId,
        promptLength: prompt.length,
        hadReferenceImage: false,
        stylePreset,
        size: originalDesign.size,
        success: true,
      });

      // Create credit transaction
      await storage.createCreditTransaction({
        customerId: customer.id,
        type: "generation",
        amount: -1,
        description: `Regenerated design for ${newColorTier} apparel colors`,
      });

      console.log(`[Regenerate-Tier] Successfully regenerated design ${designId} for ${newColorTier} tier (1 credit deducted)`);

      res.json({
        design: updatedDesign,
        creditsRemaining: customer.credits - 1,
        message: `Design regenerated for ${newColorTier} colored apparel`,
      });
    } catch (error) {
      console.error("Error regenerating design for tier:", error);
      res.status(500).json({ error: "Failed to regenerate design" });
    }
  });

  // Rate limiting for Shopify generation (per shop per hour)
  const shopifyGenerationRateLimits = new Map<string, { count: number; resetAt: number }>();
  const SHOPIFY_RATE_LIMIT = 100; // 100 generations per shop per hour
  const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
  
  // Rate limiting for Shopify session creation (per IP per minute)
  const shopifySessionRateLimits = new Map<string, { count: number; resetAt: number }>();
  const SESSION_RATE_LIMIT = 10; // 10 session requests per IP per minute
  const SESSION_RATE_WINDOW_MS = 60 * 1000; // 1 minute
  
  // Session token store for Shopify storefronts (token -> { shop, expiresAt, clientIp, customerId?, customerEmail? })
  interface ShopifySession {
    shop: string;
    expiresAt: number;
    clientIp: string;
    customerId?: string;
    customerEmail?: string;
    customerName?: string;
    internalCustomerId?: string;
  }
  const shopifySessionTokens = new Map<string, ShopifySession>();
  const SESSION_TOKEN_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

  // Generate session token for Shopify storefront (called from iframe)
  // Security layers:
  // 1. Origin validation (requests must come from our app's embed page)
  // 2. Shop domain format validation (must be valid *.myshopify.com)
  // 3. Active installation check (shop must be installed in our system)
  // 4. Timestamp validation (request must be within 5 minutes)
  // 5. Rate limiting (10 requests per IP per minute)
  // 6. IP binding on session tokens
  app.post("/api/shopify/session", async (req: Request, res: Response) => {
    try {
      const { shop, productId, timestamp, customerId, customerEmail, customerName } = req.body;

      if (!shop) {
        return res.status(400).json({ error: "Shop domain required" });
      }

      // Log the session request for debugging
      const referer = req.headers.referer || req.headers.origin || "";
      const host = req.headers.host || "";
      console.log(`Shopify session request: shop=${shop}, referer=${referer}, host=${host}`);
      
      // Note: Origin validation is relaxed to allow Shopify storefronts (custom domains, CDN, etc.)
      // Security is enforced by verifying the shop installation exists and is active (below)

      // Validate shop domain format - accept myshopify.com domains
      // Custom domains are also accepted and will be looked up
      const isMyshopifyDomain = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
      if (!isMyshopifyDomain) {
        console.log(`Shopify session: Non-myshopify domain received: ${shop}, will attempt to look up`);
      }

      // Rate limit session creation per IP to prevent abuse
      const clientIp = req.ip || req.headers["x-forwarded-for"] || "unknown";
      const ipKey = typeof clientIp === "string" ? clientIp : clientIp[0];
      const now = Date.now();
      const sessionRateLimit = shopifySessionRateLimits.get(ipKey);
      if (sessionRateLimit) {
        if (now < sessionRateLimit.resetAt) {
          if (sessionRateLimit.count >= SESSION_RATE_LIMIT) {
            console.warn(`Shopify session rate limit exceeded for IP: ${ipKey}`);
            return res.status(429).json({ error: "Too many requests. Please wait before trying again." });
          }
          sessionRateLimit.count++;
        } else {
          shopifySessionRateLimits.set(ipKey, { count: 1, resetAt: now + SESSION_RATE_WINDOW_MS });
        }
      } else {
        shopifySessionRateLimits.set(ipKey, { count: 1, resetAt: now + SESSION_RATE_WINDOW_MS });
      }

      // Verify shop is installed first (this is the primary security check)
      // We check installation before referer since custom domains won't match myshopify.com patterns
      let installation = await storage.getShopifyInstallationByShop(shop);
      
      // If not found and it's not a myshopify domain, the frontend might be passing a custom domain
      // Log this for debugging and return a helpful error
      if (!installation && !isMyshopifyDomain) {
        console.log(`Shopify session: No installation found for custom domain: ${shop}`);
        // Try to give a helpful error - the theme extension needs to pass the myshopify.com domain
        return res.status(403).json({ 
          error: "Shop not authorized",
          details: "Custom domain detected. Theme extension may need to be updated to pass the myshopify.com domain."
        });
      }
      
      if (!installation || installation.status !== "active") {
        console.log(`Shopify session: Installation not found or inactive for: ${shop}`);
        return res.status(403).json({ error: "Shop not authorized" });
      }

      // Verify timestamp is recent (within 5 minutes)
      const requestTimestamp = parseInt(timestamp) || 0;
      if (Math.abs(now - requestTimestamp) > 5 * 60 * 1000) {
        return res.status(400).json({ error: "Request timestamp expired" });
      }

      // Generate session token with IP binding for additional security
      const sessionToken = crypto.randomBytes(32).toString("hex");
      
      // Create session data (ipKey is already extracted for rate limiting)
      const sessionData: ShopifySession = {
        shop,
        expiresAt: now + SESSION_TOKEN_EXPIRY_MS,
        clientIp: ipKey,
      };
      
      // If customer is logged in, create/get their customer record
      let internalCustomer = null;
      if (customerId) {
        try {
          internalCustomer = await storage.getOrCreateShopifyCustomer(shop, customerId, customerEmail);
          sessionData.customerId = customerId;
          sessionData.customerEmail = customerEmail;
          sessionData.customerName = customerName;
          sessionData.internalCustomerId = internalCustomer.id;
        } catch (e) {
          console.error("Error creating Shopify customer:", e);
        }
      }
      
      shopifySessionTokens.set(sessionToken, sessionData);

      // Clean up expired tokens periodically
      const tokenEntries = Array.from(shopifySessionTokens.entries());
      for (const [token, data] of tokenEntries) {
        if (data.expiresAt < now) {
          shopifySessionTokens.delete(token);
        }
      }

      res.json({ 
        sessionToken, 
        expiresIn: SESSION_TOKEN_EXPIRY_MS / 1000,
        customer: internalCustomer ? {
          id: internalCustomer.id,
          credits: internalCustomer.credits,
          isLoggedIn: true,
        } : {
          isLoggedIn: false,
          credits: 0,
        }
      });
    } catch (error) {
      console.error("Error creating Shopify session:", error);
      res.status(500).json({ error: "Failed to create session" });
    }
  });

  // Shopify Storefront Generate (for embedded design studio)
  // Requires valid session token from /api/shopify/session
  app.post("/api/shopify/generate", async (req: Request, res: Response) => {
    try {
      const { prompt, stylePreset, size, frameColor, referenceImage, shop, sessionToken, bgRemovalSensitivity } = req.body;

      if (!shop) {
        return res.status(400).json({ error: "Shop domain required" });
      }

      // Validate shop domain format
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
        return res.status(400).json({ error: "Invalid shop domain format" });
      }

      // Verify session token
      if (!sessionToken) {
        return res.status(401).json({ error: "Session token required" });
      }

      const session = shopifySessionTokens.get(sessionToken);
      if (!session) {
        return res.status(401).json({ error: "Invalid session token" });
      }

      if (Date.now() > session.expiresAt) {
        shopifySessionTokens.delete(sessionToken);
        return res.status(401).json({ error: "Session token expired" });
      }

      if (session.shop !== shop) {
        return res.status(403).json({ error: "Session token mismatch" });
      }

      // Verify shop is installed
      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }

      // Check if customer is logged in and has credits - atomic decrement to prevent race conditions
      let customer = null;
      let creditDeducted = false;
      if (session.internalCustomerId) {
        customer = await storage.getCustomer(session.internalCustomerId);
        if (!customer || customer.credits <= 0) {
          return res.status(403).json({ 
            error: "No credits remaining. Please log in to your account to purchase more credits.",
            requiresCredits: true,
            credits: customer?.credits || 0
          });
        }
        
        // Atomically decrement credits BEFORE generation to prevent race conditions
        const updatedCustomer = await storage.decrementCreditsIfAvailable(customer.id);
        if (!updatedCustomer) {
          return res.status(403).json({ 
            error: "No credits remaining. Please try again later.",
            requiresCredits: true,
            credits: 0
          });
        }
        customer = updatedCustomer;
        creditDeducted = true;
      } else {
        // Require customer login to generate
        return res.status(401).json({ 
          error: "Please log in to your account to create designs.",
          requiresLogin: true
        });
      }

      // Rate limiting per shop
      const now = Date.now();
      let rateLimit = shopifyGenerationRateLimits.get(shop);
      
      if (!rateLimit || now > rateLimit.resetAt) {
        rateLimit = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
        shopifyGenerationRateLimits.set(shop, rateLimit);
      }
      
      if (rateLimit.count >= SHOPIFY_RATE_LIMIT) {
        return res.status(429).json({ 
          error: "Rate limit exceeded. Please try again later.",
          retryAfter: Math.ceil((rateLimit.resetAt - now) / 1000)
        });
      }
      
      rateLimit.count++;

      const { productTypeId } = req.body;

      if (!prompt || !size) {
        return res.status(400).json({ error: "Prompt and size are required" });
      }

      // Look up style preset and get its promptSuffix
      let stylePromptPrefix = "";
      if (stylePreset && installation.merchantId) {
        // Try to find in database styles first
        const dbStyles = await storage.getStylePresetsByMerchant(installation.merchantId);
        const selectedStyle = dbStyles.find((s: { id: number; promptPrefix: string | null }) => s.id.toString() === stylePreset);
        if (selectedStyle && selectedStyle.promptPrefix) {
          stylePromptPrefix = selectedStyle.promptPrefix;
        }
        // Fall back to hardcoded STYLE_PRESETS if not found in database
        if (!stylePromptPrefix) {
          const hardcodedStyle = STYLE_PRESETS.find(s => s.id === stylePreset);
          if (hardcodedStyle && hardcodedStyle.promptPrefix) {
            stylePromptPrefix = hardcodedStyle.promptPrefix;
          }
        }
      }

      // Load product type config if provided
      let productType = null;
      if (productTypeId) {
        productType = await storage.getProductType(parseInt(productTypeId));
      }

      // Helper function to calculate generation dimensions from aspect ratio
      const calculateGenDimensions = (aspectRatioStr: string): { genWidth: number; genHeight: number } => {
        const [w, h] = aspectRatioStr.split(":").map(Number);
        if (!w || !h || isNaN(w) || isNaN(h)) {
          return { genWidth: 1024, genHeight: 1024 };
        }
        const ratio = w / h;
        const maxDim = 1024;
        if (ratio >= 1) {
          return { genWidth: maxDim, genHeight: Math.round(maxDim / ratio) };
        } else {
          return { genWidth: Math.round(maxDim * ratio), genHeight: maxDim };
        }
      };

      // Find size config - check product type first, then fall back to PRINT_SIZES
      let sizeConfig = PRINT_SIZES.find(s => s.id === size);
      
      if (!sizeConfig && productType) {
        // Use size-specific or product type's aspect ratio to calculate proper generation dimensions
        const productSizes = JSON.parse(productType.sizes || "[]");
        const productSize = productSizes.find((s: any) => s.id === size);
        const aspectRatioStr = productSize?.aspectRatio || productType.aspectRatio || "3:4";
        const genDims = calculateGenDimensions(aspectRatioStr);
        
        sizeConfig = {
          id: productSize?.id || size,
          name: productSize?.name || size,
          width: productSize?.width || 12,
          height: productSize?.height || 16,
          aspectRatio: aspectRatioStr,
          genWidth: genDims.genWidth,
          genHeight: genDims.genHeight,
        } as any;
      }
      
      if (!sizeConfig) {
        // Default fallback
        sizeConfig = PRINT_SIZES[0];
      }

      // Apply style prompt prefix if available
      let fullPrompt = stylePromptPrefix 
        ? `${stylePromptPrefix} ${prompt}` 
        : prompt;

      // Build shape-specific safe zone instructions
      const printShape = productType?.printShape || "rectangle";
      const bleedMargin = productType?.bleedMarginPercent || 5;
      const safeZonePercent = 100 - (bleedMargin * 2);
      
      let shapeInstructions = "";
      if (printShape === "circle") {
        shapeInstructions = `
CIRCULAR PRINT AREA: This design is for a CIRCULAR product (like a round pillow or coaster).
- Center all important elements (faces, text, focal points) within the inner ${safeZonePercent}% of the circle
- Keep a ${bleedMargin}% margin from the circular edge for manufacturing bleed
- The corners of the canvas will be cropped to a circle - nothing important should be in the corners
- Design with radial/circular composition in mind`;
      } else if (printShape === "square") {
        shapeInstructions = `
SQUARE PRINT AREA: This design is for a square product.
- Center important elements within the inner ${safeZonePercent}% of the canvas
- Keep a ${bleedMargin}% margin from all edges for bleed`;
      } else {
        shapeInstructions = `
- Keep important elements within the inner ${safeZonePercent}% of the canvas
- Maintain a ${bleedMargin}% margin from edges for bleed`;
      }

      // CRITICAL: Full-bleed requirements for ALL generations
      const sizingRequirements = `

MANDATORY IMAGE REQUIREMENTS - FOLLOW EXACTLY:
1. FULL-BLEED: The image MUST extend edge-to-edge, filling the ENTIRE canvas with NO margins, borders, frames, or empty space around the edges.
2. NO FLOATING: The subject must NOT appear to be floating or cropped. The artwork must have a complete background that extends to all edges.
3. NO PICTURE FRAMES: Do NOT include any decorative borders, picture frames, drop shadows, or vignettes around the image.
4. COMPOSITION: ${sizeConfig.aspectRatio === "1:1" ? "Square 1:1 composition" : `Vertical portrait ${sizeConfig.aspectRatio} composition`} - the artwork fills the entire canvas.
5. SAFE ZONE: ${shapeInstructions}
6. BACKGROUND: The background/scene must extend fully to all four edges.
7. PRINT-READY: This is for high-quality printing - create a complete, finished artwork.
`;

      fullPrompt += sizingRequirements;

      // Generate image
      const contents: any[] = [{ role: "user", parts: [{ text: fullPrompt }] }];
      
      if (referenceImage) {
        const base64Data = referenceImage.replace(/^data:image\/\w+;base64,/, "");
        contents[0].parts.unshift({
          inlineData: {
            mimeType: "image/png",
            data: base64Data,
          },
        });
      }

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents,
        config: {
          responseModalities: [Modality.TEXT, Modality.IMAGE],
        },
      });

      const candidate = response.candidates?.[0];
      const imagePart = candidate?.content?.parts?.find(
        (part: any) => part.inlineData
      );

      if (!imagePart?.inlineData?.data) {
        return res.status(500).json({ error: "Failed to generate image" });
      }

      const mimeType = imagePart.inlineData.mimeType || "image/png";
      
      // Check if this is an apparel product
      let isApparel = productType?.designerType === "apparel";
      
      // Also detect apparel from style preset category if no productType
      if (!isApparel && stylePreset) {
        const hardcodedStyle = STYLE_PRESETS.find(s => s.id === stylePreset);
        if (hardcodedStyle && hardcodedStyle.category === "apparel") {
          isApparel = true;
        }
      }
      
      // Get target dimensions for resizing - skip for apparel (keep square)
      let targetDims: TargetDimensions | undefined;
      if (!isApparel) {
        const genWidth = (sizeConfig as any).genWidth || 1024;
        const genHeight = (sizeConfig as any).genHeight || 1024;
        targetDims = { width: genWidth, height: genHeight };
      }
      
      // Save image to object storage (with background removal for apparel, aspect ratio resizing for wall art)
      let imageUrl: string;
      let thumbnailUrl: string | undefined;
      try {
        const result = await saveImageToStorage(imagePart.inlineData.data, mimeType, { isApparel, targetDims });
        imageUrl = result.imageUrl;
        thumbnailUrl = result.thumbnailUrl;
      } catch (storageError) {
        console.error("Failed to save to object storage, falling back to base64:", storageError);
        imageUrl = `data:${mimeType};base64,${imagePart.inlineData.data}`;
      }
      
      const designId = `shopify-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Log the generation (credit was already deducted atomically above)
      await storage.createCreditTransaction({
        customerId: customer!.id,
        type: "generation",
        amount: -1,
        description: `Shopify artwork: ${prompt.substring(0, 50)}...`,
      });

      res.json({
        imageUrl,
        thumbnailUrl,
        designId,
        prompt,
        creditsRemaining: customer!.credits,
      });
    } catch (error) {
      console.error("Error generating Shopify artwork:", error);
      // Note: Credit was already deducted. In production, consider refunding on failure.
      res.status(500).json({ error: "Failed to generate artwork" });
    }
  });

  // ==================== SHOPIFY PRODUCT CREATION ====================
  // Create a draft product in merchant's Shopify store with design studio widget
  app.post("/api/shopify/products", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(403).json({ error: "Merchant not found" });
      }

      const { productTypeId, shopDomain, selectedColorIds } = req.body;

      if (!productTypeId) {
        return res.status(400).json({ error: "Product type ID is required" });
      }

      if (!shopDomain) {
        return res.status(400).json({ error: "Shop domain is required" });
      }

      // Validate shop domain format
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
        return res.status(400).json({ error: "Invalid shop domain format" });
      }

      // Get the Shopify installation for this shop
      const installation = await storage.getShopifyInstallationByShop(shopDomain);
      if (!installation || installation.status !== "active") {
        return res.status(400).json({ 
          error: "Shopify store not connected",
          details: "Please install the app on your Shopify store first"
        });
      }

      // Security: Verify the installation belongs to this merchant
      // If merchantId is set, it must match. If not set, link it to this merchant.
      if (installation.merchantId && installation.merchantId !== merchant.id) {
        return res.status(403).json({ 
          error: "Access denied",
          details: "This Shopify store is linked to a different merchant account"
        });
      }
      
      // Link unlinked installations to the current merchant
      if (!installation.merchantId) {
        await storage.updateShopifyInstallation(installation.id, {
          merchantId: merchant.id,
        });
      }

      // Get the product type data
      const productType = await storage.getProductType(productTypeId);
      if (!productType) {
        return res.status(404).json({ error: "Product type not found" });
      }

      // Security: Verify the product type belongs to this merchant
      if (productType.merchantId && productType.merchantId !== merchant.id) {
        return res.status(403).json({ 
          error: "Access denied",
          details: "This product type belongs to a different merchant"
        });
      }

      // Parse product type data
      const allSizes = typeof productType.sizes === 'string' 
        ? JSON.parse(productType.sizes) 
        : productType.sizes || [];
      const allColors = typeof productType.frameColors === 'string' 
        ? JSON.parse(productType.frameColors) 
        : productType.frameColors || [];
      const baseMockupImages = typeof productType.baseMockupImages === 'string'
        ? JSON.parse(productType.baseMockupImages)
        : productType.baseMockupImages || {};
      const variantMap = typeof productType.variantMap === 'string'
        ? JSON.parse(productType.variantMap)
        : productType.variantMap || {};
      
      // Parse saved variant selections from product type
      const savedSizeIds: string[] = typeof productType.selectedSizeIds === 'string'
        ? JSON.parse(productType.selectedSizeIds || "[]")
        : productType.selectedSizeIds || [];
      const savedColorIds: string[] = typeof productType.selectedColorIds === 'string'
        ? JSON.parse(productType.selectedColorIds || "[]")
        : productType.selectedColorIds || [];

      // Build variants for Shopify
      // For products with both sizes and colors, create a variant for each combination
      // For products with only sizes (no colors), create a variant for each size
      const shopifyVariants: Array<{
        option1: string;
        option2?: string;
        price: string;
        sku: string;
        inventory_management: null;
        inventory_policy: string;
      }> = [];

      // Use saved selections if available, otherwise use request params or all available
      const sizeIdsToUse = savedSizeIds.length > 0 ? savedSizeIds : allSizes.map((s: { id: string }) => s.id);
      const colorIdsToUse = selectedColorIds && selectedColorIds.length > 0 
        ? selectedColorIds 
        : savedColorIds.length > 0 
          ? savedColorIds 
          : allColors.map((c: { id: string }) => c.id);

      // Filter sizes and colors based on selections
      const sizesToUse = allSizes.filter((s: { id: string }) => sizeIdsToUse.includes(s.id));
      const colorsToUse = allColors.filter((c: { id: string }) => colorIdsToUse.includes(c.id));

      if (colorsToUse.length > 0) {
        // Product has both sizes and colors
        for (const size of sizesToUse) {
          for (const color of colorsToUse) {
            const variantKey = `${size.id}:${color.id}`;
            if (variantMap[variantKey]) {
              shopifyVariants.push({
                option1: size.name,
                option2: color.name,
                price: "0.00", // Merchant sets pricing
                sku: `${productType.printifyBlueprintId || 'PT'}-${size.id}-${color.id}`,
                inventory_management: null,
                inventory_policy: "continue", // Allow overselling (POD)
              });
            }
          }
        }
      } else if (allColors.length === 0) {
        // Product has only sizes (e.g., phone cases)
        for (const size of sizesToUse) {
          const variantKey = `${size.id}:default`;
          if (variantMap[variantKey]) {
            shopifyVariants.push({
              option1: size.name,
              price: "0.00", // Merchant sets pricing
              sku: `${productType.printifyBlueprintId || 'PT'}-${size.id}`,
              inventory_management: null,
              inventory_policy: "continue", // Allow overselling (POD)
            });
          }
        }
      }

      // Validate Shopify's 100 variant limit
      const SHOPIFY_VARIANT_LIMIT = 100;
      if (shopifyVariants.length > SHOPIFY_VARIANT_LIMIT) {
        return res.status(400).json({ 
          error: `Too many variants (${shopifyVariants.length})`,
          details: `Shopify allows a maximum of ${SHOPIFY_VARIANT_LIMIT} variants per product. Please select fewer colors.`
        });
      }

      if (shopifyVariants.length === 0) {
        return res.status(400).json({ 
          error: "No variants to create",
          details: "Please select at least one color to include in the product."
        });
      }

      // Build product options
      const productOptions: Array<{ name: string; values: string[] }> = [];
      
      if (allSizes.length > 0) {
        productOptions.push({
          name: "Size",
          values: Array.from(new Set(shopifyVariants.map(v => v.option1))),
        });
      }
      
      if (allColors.length > 0) {
        productOptions.push({
          name: "Color",
          values: Array.from(new Set(shopifyVariants.filter(v => v.option2).map(v => v.option2!))),
        });
      }

      // Build images array from mockups
      const images: Array<{ src: string; alt: string }> = [];
      if (baseMockupImages.front) {
        images.push({ src: baseMockupImages.front, alt: `${productType.name} - Front` });
      }
      if (baseMockupImages.lifestyle) {
        images.push({ src: baseMockupImages.lifestyle, alt: `${productType.name} - Lifestyle` });
      }

      // Strip HTML from description for cleaner Shopify display
      const cleanDescription = (productType.description || "")
        .replace(/<[^>]*>/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();

      // Get the app URL for the design studio embed
      const appUrl = process.env.REPLIT_DEV_DOMAIN 
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : process.env.APP_URL || `http://localhost:${process.env.PORT || 5000}`;

      // Create display name for dynamic text (strip "Custom" prefix if product title would have it)
      const displayName = productType.name;

      // Create the product in Shopify with template suffix for automatic configuration
      const shopifyProduct = {
        product: {
          title: `Custom ${productType.name}`,
          body_html: `
            <p>${cleanDescription}</p>
            <p><strong>This product features our AI Design Studio.</strong> Create your own unique artwork using AI, or upload your own design!</p>
          `,
          vendor: merchant.storeName || "AI Art Studio",
          product_type: productType.name,
          status: "draft", // Leave as draft so merchant can set pricing
          published: false,
          template_suffix: "ai-art-studio", // Use pre-configured template
          tags: ["custom-design", "ai-artwork", "design-studio"],
          options: productOptions.length > 0 ? productOptions : undefined,
          variants: shopifyVariants.length > 0 ? shopifyVariants : [{ price: "0.00" }],
          images: images.length > 0 ? images : undefined,
          metafields: [
            {
              namespace: "ai_art_studio",
              key: "product_type_id",
              value: String(productType.id),
              type: "single_line_text_field",
            },
            {
              namespace: "ai_art_studio", 
              key: "app_url",
              value: appUrl,
              type: "single_line_text_field",
            },
            {
              namespace: "ai_art_studio", 
              key: "display_name",
              value: displayName,
              type: "single_line_text_field",
            },
            {
              namespace: "ai_art_studio", 
              key: "description",
              value: `Use AI to generate a unique artwork for your ${displayName.toLowerCase()}. Describe your vision and our AI will bring it to life.`,
              type: "single_line_text_field",
            },
            {
              namespace: "ai_art_studio", 
              key: "design_studio_url",
              value: `${appUrl}/embed/design?productTypeId=${productType.id}`,
              type: "single_line_text_field",
            },
            {
              namespace: "ai_art_studio",
              key: "hide_add_to_cart",
              value: "true",
              type: "single_line_text_field",
            },
          ],
        },
      };

      // Call Shopify Admin API to create the product
      const shopifyResponse = await fetch(
        `https://${shopDomain}/admin/api/2024-01/products.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": installation.accessToken,
          },
          body: JSON.stringify(shopifyProduct),
        }
      );

      if (!shopifyResponse.ok) {
        const errorText = await shopifyResponse.text();
        console.error("Shopify API error:", errorText);
        return res.status(shopifyResponse.status).json({ 
          error: "Failed to create Shopify product",
          details: errorText
        });
      }

      const createdProduct = await shopifyResponse.json();
      const shopifyProductId = createdProduct.product.id;
      
      console.log(`Created Shopify product ${shopifyProductId} for product type ${productType.id}`);

      // Publish to Online Store only (not POS) by finding and using the Online Store publication
      try {
        // Get all publications (sales channels)
        const publicationsResponse = await fetch(
          `https://${shopDomain}/admin/api/2024-01/publications.json`,
          {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": installation.accessToken,
            },
          }
        );

        if (publicationsResponse.ok) {
          const publicationsData = await publicationsResponse.json();
          const onlineStorePublication = publicationsData.publications?.find(
            (pub: { name: string; id: number }) => pub.name === "Online Store"
          );

          if (onlineStorePublication) {
            // Publish to Online Store
            await fetch(
              `https://${shopDomain}/admin/api/2024-01/publications/${onlineStorePublication.id}/product_listings.json`,
              {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  "X-Shopify-Access-Token": installation.accessToken,
                },
                body: JSON.stringify({
                  product_listing: {
                    product_id: shopifyProductId,
                  },
                }),
              }
            );
            console.log(`Published product ${shopifyProductId} to Online Store`);
          }
        }
      } catch (pubError) {
        // Non-critical - product is created, just not auto-published to channel
        console.log("Could not auto-publish to Online Store:", pubError);
      }

      // Save Shopify product ID to the product type for future updates
      await storage.updateProductType(productType.id, {
        shopifyProductId: String(shopifyProductId),
        shopifyProductUrl: `https://${shopDomain}/admin/products/${shopifyProductId}`,
        lastPushedToShopify: new Date(),
      });

      res.json({
        success: true,
        shopifyProductId: shopifyProductId,
        shopifyProductHandle: createdProduct.product.handle,
        adminUrl: `https://${shopDomain}/admin/products/${shopifyProductId}`,
        message: "Product created and configured automatically. Set your retail prices and publish when ready.",
      });

    } catch (error) {
      console.error("Error creating Shopify product:", error);
      res.status(500).json({ error: "Failed to create Shopify product" });
    }
  });

  // ==================== MERCHANT SHOPIFY INSTALLATIONS ====================
  // Get all Shopify stores connected to the current merchant (for auto-fill in publish dialog)
  app.get("/api/shopify/installations", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.json({ installations: [] });
      }

      // Get all installations for this merchant
      const installations = await storage.getShopifyInstallationsByMerchant(merchant.id);
      
      // Filter to active installations only and return minimal data
      const activeInstallations = installations
        .filter(inst => inst.status === "active")
        .map(inst => ({
          id: inst.id,
          shopDomain: inst.shopDomain,
          shopName: inst.shopDomain.replace(".myshopify.com", ""),
          installedAt: inst.installedAt,
        }));

      res.json({ 
        installations: activeInstallations,
        hasInstallations: activeInstallations.length > 0,
      });
    } catch (error) {
      console.error("Error fetching Shopify installations:", error);
      res.status(500).json({ error: "Failed to fetch Shopify installations" });
    }
  });

  // ==================== SHOPIFY PRODUCT UPDATE ====================
  // Update an existing Shopify product with new variants/info from local product type
  app.put("/api/shopify/products/:productTypeId", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      const productTypeId = parseInt(req.params.productTypeId);
      
      if (!merchant) {
        return res.status(403).json({ error: "Merchant not found" });
      }

      const { shopDomain } = req.body;

      if (!shopDomain) {
        return res.status(400).json({ error: "Shop domain is required" });
      }

      // Validate shop domain format
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
        return res.status(400).json({ error: "Invalid shop domain format" });
      }

      // Get the product type
      const productType = await storage.getProductType(productTypeId);
      if (!productType) {
        return res.status(404).json({ error: "Product type not found" });
      }

      // Security: Verify ownership - must match current merchant
      // Reject unowned product types - they need to be claimed via proper import flow first
      if (!productType.merchantId) {
        return res.status(403).json({ 
          error: "Product not linked to merchant",
          details: "This product type is not associated with any merchant. Please re-import it from Printify."
        });
      }
      
      if (productType.merchantId !== merchant.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Check if product was pushed to Shopify
      if (!productType.shopifyProductId) {
        return res.status(400).json({ 
          error: "Product not yet published to Shopify",
          details: "Use 'Send to Store' first to create the product in Shopify"
        });
      }

      // Get installation
      const installation = await storage.getShopifyInstallationByShop(shopDomain);
      if (!installation || installation.status !== "active") {
        return res.status(400).json({ error: "Shopify store not connected" });
      }

      // Security: Verify the installation belongs to this merchant
      if (!installation.merchantId) {
        // Link unlinked installations to the current merchant
        await storage.updateShopifyInstallation(installation.id, {
          merchantId: merchant.id,
        });
      } else if (installation.merchantId !== merchant.id) {
        return res.status(403).json({ 
          error: "Access denied",
          details: "This Shopify store is linked to a different merchant account"
        });
      }

      // Parse product type data
      const allSizes = JSON.parse(productType.sizes || "[]");
      const allColors = JSON.parse(productType.frameColors || "[]");
      const savedSizeIds: string[] = JSON.parse(productType.selectedSizeIds || "[]");
      const savedColorIds: string[] = JSON.parse(productType.selectedColorIds || "[]");
      const variantMap = JSON.parse(productType.variantMap || "{}");
      const baseMockupImages = JSON.parse(productType.baseMockupImages || "{}");

      // Build variants
      const shopifyVariants: Array<{
        option1: string;
        option2?: string;
        price: string;
        sku: string;
        inventory_management: null;
        inventory_policy: string;
      }> = [];

      const sizeIdsToUse = savedSizeIds.length > 0 ? savedSizeIds : allSizes.map((s: { id: string }) => s.id);
      const colorIdsToUse = savedColorIds.length > 0 ? savedColorIds : allColors.map((c: { id: string }) => c.id);
      
      const sizesToUse = allSizes.filter((s: { id: string }) => sizeIdsToUse.includes(s.id));
      const colorsToUse = allColors.filter((c: { id: string }) => colorIdsToUse.includes(c.id));

      if (colorsToUse.length > 0) {
        for (const size of sizesToUse) {
          for (const color of colorsToUse) {
            const variantKey = `${size.id}:${color.id}`;
            if (variantMap[variantKey]) {
              shopifyVariants.push({
                option1: size.name,
                option2: color.name,
                price: "0.00",
                sku: `${productType.printifyBlueprintId || 'PT'}-${size.id}-${color.id}`,
                inventory_management: null,
                inventory_policy: "continue",
              });
            }
          }
        }
      } else if (allColors.length === 0) {
        for (const size of sizesToUse) {
          const variantKey = `${size.id}:default`;
          if (variantMap[variantKey]) {
            shopifyVariants.push({
              option1: size.name,
              price: "0.00",
              sku: `${productType.printifyBlueprintId || 'PT'}-${size.id}`,
              inventory_management: null,
              inventory_policy: "continue",
            });
          }
        }
      }

      // Validate variant limit
      if (shopifyVariants.length > 100) {
        return res.status(400).json({ 
          error: `Too many variants (${shopifyVariants.length})`,
          details: "Shopify allows a maximum of 100 variants per product."
        });
      }

      // Build product options
      const productOptions: Array<{ name: string; values: string[] }> = [];
      
      if (allSizes.length > 0) {
        productOptions.push({
          name: "Size",
          values: Array.from(new Set(shopifyVariants.map(v => v.option1))),
        });
      }
      
      if (allColors.length > 0) {
        productOptions.push({
          name: "Color",
          values: Array.from(new Set(shopifyVariants.filter(v => v.option2).map(v => v.option2!))),
        });
      }

      // Build images
      const images: Array<{ src: string; alt: string }> = [];
      if (baseMockupImages.front) {
        images.push({ src: baseMockupImages.front, alt: `${productType.name} - Front` });
      }
      if (baseMockupImages.lifestyle) {
        images.push({ src: baseMockupImages.lifestyle, alt: `${productType.name} - Lifestyle` });
      }

      // Update product in Shopify (Note: Shopify doesn't allow updating variants directly, 
      // we update what we can: description, images, etc.)
      const cleanDescription = (productType.description || "")
        .replace(/<[^>]*>/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();

      const updatePayload = {
        product: {
          id: productType.shopifyProductId,
          body_html: `
            <p>${cleanDescription}</p>
            <p><strong>This product features our AI Design Studio.</strong> Create your own unique artwork using AI, or upload your own design!</p>
          `,
          images: images.length > 0 ? images : undefined,
        },
      };

      const shopifyResponse = await fetch(
        `https://${shopDomain}/admin/api/2024-01/products/${productType.shopifyProductId}.json`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": installation.accessToken,
          },
          body: JSON.stringify(updatePayload),
        }
      );

      if (!shopifyResponse.ok) {
        const errorText = await shopifyResponse.text();
        console.error("Shopify API error:", errorText);
        return res.status(shopifyResponse.status).json({ 
          error: "Failed to update Shopify product",
          details: errorText
        });
      }

      const updatedProduct = await shopifyResponse.json();

      // Update last pushed timestamp
      await storage.updateProductType(productType.id, {
        lastPushedToShopify: new Date(),
      });

      res.json({
        success: true,
        message: "Product updated in Shopify. Note: Variant changes may require recreating the product.",
        adminUrl: `https://${shopDomain}/admin/products/${productType.shopifyProductId}`,
      });

    } catch (error) {
      console.error("Error updating Shopify product:", error);
      res.status(500).json({ error: "Failed to update Shopify product" });
    }
  });

  // Get merchant's connected Shopify shops
  app.get("/api/shopify/shops", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.json({ shops: [] });
      }

      // Get installations linked to this merchant
      const installations = await storage.getShopifyInstallationsByMerchant(merchant.id);
      
      res.json({
        shops: installations.map((i: { id: number; shopDomain: string; installedAt: Date }) => ({
          id: i.id,
          shopDomain: i.shopDomain,
          installedAt: i.installedAt,
        })),
      });
    } catch (error) {
      console.error("Error fetching Shopify shops:", error);
      res.status(500).json({ error: "Failed to fetch connected shops" });
    }
  });

  // Get detailed Shopify installations for admin settings
  app.get("/api/shopify/installations", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.json([]);
      }

      // Get installations linked to this merchant
      const installations = await storage.getShopifyInstallationsByMerchant(merchant.id);
      
      // Also get unlinked installations (for first-time linking)
      const allInstallations = await storage.getAllShopifyInstallations();
      const unlinkedInstallations = allInstallations.filter(
        (i: { merchantId: string | null }) => !i.merchantId
      );
      
      const combined = [...installations, ...unlinkedInstallations];
      
      res.json(combined.map((i: { id: number; shopDomain: string; status: string; scope: string | null }) => ({
        id: i.id,
        shopDomain: i.shopDomain,
        status: i.status,
        scope: i.scope,
      })));
    } catch (error) {
      console.error("Error fetching Shopify installations:", error);
      res.status(500).json({ error: "Failed to fetch installations" });
    }
  });

  // Product Types API (public endpoint for Shopify embed)
  app.get("/api/product-types", async (_req: Request, res: Response) => {
    try {
      const types = await storage.getActiveProductTypes();
      res.json(types);
    } catch (error) {
      console.error("Error fetching product types:", error);
      res.status(500).json({ error: "Failed to fetch product types" });
    }
  });

  app.get("/api/product-types/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const productType = await storage.getProductType(id);
      if (!productType) {
        return res.status(404).json({ error: "Product type not found" });
      }
      res.json(productType);
    } catch (error) {
      console.error("Error fetching product type:", error);
      res.status(500).json({ error: "Failed to fetch product type" });
    }
  });

  app.get("/api/product-types/:id/designer", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const productType = await storage.getProductType(id);
      if (!productType) {
        return res.status(404).json({ error: "Product type not found" });
      }

      const sizes = typeof productType.sizes === 'string' 
        ? JSON.parse(productType.sizes) 
        : productType.sizes || [];
      const frameColors = typeof productType.frameColors === 'string' 
        ? JSON.parse(productType.frameColors) 
        : productType.frameColors || [];

      const [aspectW, aspectH] = (productType.aspectRatio || "1:1").split(":").map(Number);
      const aspectRatio = aspectW / aspectH;

      const maxDimension = 1024;
      let canvasWidth: number, canvasHeight: number;
      if (aspectRatio >= 1) {
        canvasWidth = maxDimension;
        canvasHeight = Math.round(maxDimension / aspectRatio);
      } else {
        canvasHeight = maxDimension;
        canvasWidth = Math.round(maxDimension * aspectRatio);
      }

      const bleedMarginPercent = productType.bleedMarginPercent || 5;
      const safeZoneMargin = Math.round(Math.min(canvasWidth, canvasHeight) * (bleedMarginPercent / 100));

      // Determine sizeType (dimensional vs label-only)
      const sizeType = (productType as any).sizeType || "dimensional";

      // Parse base mockup images if available
      const baseMockupImages = typeof productType.baseMockupImages === 'string'
        ? JSON.parse(productType.baseMockupImages)
        : productType.baseMockupImages || {};

      // Parse variant map for size/color availability
      const variantMap = typeof productType.variantMap === 'string'
        ? JSON.parse(productType.variantMap)
        : productType.variantMap || {};

      const designerConfig = {
        id: productType.id,
        name: productType.name,
        description: productType.description,
        printifyBlueprintId: productType.printifyBlueprintId,
        aspectRatio: productType.aspectRatio,
        printShape: productType.printShape || "rectangle",
        printAreaWidth: productType.printAreaWidth,
        printAreaHeight: productType.printAreaHeight,
        bleedMarginPercent,
        designerType: productType.designerType || "generic",
        sizeType,
        hasPrintifyMockups: productType.hasPrintifyMockups || false,
        baseMockupImages,
        primaryMockupIndex: productType.primaryMockupIndex || 0,
        doubleSidedPrint: productType.doubleSidedPrint || false,
        sizes: sizes.map((s: any) => {
          // Calculate aspect ratio from dimensions if available
          let sizeAspectRatio = s.aspectRatio || productType.aspectRatio;
          if (sizeType === "dimensional" && s.width && s.height) {
            // Calculate proper aspect ratio from dimensions
            const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
            const divisor = gcd(s.width, s.height);
            sizeAspectRatio = `${s.width / divisor}:${s.height / divisor}`;
          }
          return {
            id: s.id,
            name: s.name,
            width: s.width || 0,
            height: s.height || 0,
            aspectRatio: sizeType === "dimensional" ? sizeAspectRatio : undefined,
          };
        }),
        frameColors: frameColors.map((c: any) => ({
          id: c.id,
          name: c.name,
          hex: c.hex,
        })),
        canvasConfig: {
          maxDimension,
          width: canvasWidth,
          height: canvasHeight,
          safeZoneMargin,
        },
        variantMap,
      };

      res.json(designerConfig);
    } catch (error) {
      console.error("Error fetching designer config:", error);
      res.status(500).json({ error: "Failed to fetch designer configuration" });
    }
  });

  // Admin endpoints for product types (requires authentication)
  app.post("/api/admin/product-types", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) {
        return res.status(403).json({ error: "Merchant not found" });
      }

      const { name, description, printifyBlueprintId, mockupTemplateUrl, sizes, frameColors, aspectRatio } = req.body;
      
      const newProductType = await storage.createProductType({
        merchantId: merchant.id,
        name,
        description,
        printifyBlueprintId,
        mockupTemplateUrl,
        sizes: JSON.stringify(sizes || []),
        frameColors: JSON.stringify(frameColors || []),
        aspectRatio: aspectRatio || "3:4",
        isActive: true,
        sortOrder: 0,
      });

      res.json(newProductType);
    } catch (error) {
      console.error("Error creating product type:", error);
      res.status(500).json({ error: "Failed to create product type" });
    }
  });

  app.patch("/api/admin/product-types/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;
      
      if (updates.sizes && Array.isArray(updates.sizes)) {
        updates.sizes = JSON.stringify(updates.sizes);
      }
      if (updates.frameColors && Array.isArray(updates.frameColors)) {
        updates.frameColors = JSON.stringify(updates.frameColors);
      }

      const updated = await storage.updateProductType(id, updates);
      if (!updated) {
        return res.status(404).json({ error: "Product type not found" });
      }
      res.json(updated);
    } catch (error) {
      console.error("Error updating product type:", error);
      res.status(500).json({ error: "Failed to update product type" });
    }
  });

  app.delete("/api/admin/product-types/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      await storage.deleteProductType(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting product type:", error);
      res.status(500).json({ error: "Failed to delete product type" });
    }
  });

  app.post("/api/admin/product-types/seed", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) {
        return res.status(403).json({ error: "Merchant not found" });
      }

      const existing = await storage.getProductTypesByMerchant(merchant.id);
      if (existing.length > 0) {
        return res.json({ message: "Product types already exist", productTypes: existing });
      }

      const defaultProductTypes = [
        {
          merchantId: merchant.id,
          name: "Framed Prints",
          description: "Museum-quality framed artwork with premium materials",
          printifyBlueprintId: 540,
          aspectRatio: "3:4",
          sizes: JSON.stringify([
            { id: "11x14", name: "11\" x 14\"", width: 11, height: 14 },
            { id: "12x16", name: "12\" x 16\"", width: 12, height: 16 },
            { id: "16x20", name: "16\" x 20\"", width: 16, height: 20 },
            { id: "18x24", name: "18\" x 24\"", width: 18, height: 24 },
            { id: "24x32", name: "24\" x 32\"", width: 24, height: 32 },
          ]),
          frameColors: JSON.stringify([
            { id: "black", name: "Black", hex: "#1a1a1a" },
            { id: "white", name: "White", hex: "#f5f5f5" },
            { id: "natural", name: "Natural Wood", hex: "#d4a574" },
          ]),
          isActive: true,
          sortOrder: 0,
        },
        {
          merchantId: merchant.id,
          name: "Throw Pillows",
          description: "Cozy decorative throw pillows with custom artwork",
          printifyBlueprintId: 83,
          aspectRatio: "1:1",
          sizes: JSON.stringify([
            { id: "16x16", name: "16\" x 16\"", width: 16, height: 16 },
            { id: "18x18", name: "18\" x 18\"", width: 18, height: 18 },
            { id: "20x20", name: "20\" x 20\"", width: 20, height: 20 },
          ]),
          frameColors: JSON.stringify([]),
          isActive: true,
          sortOrder: 1,
        },
        {
          merchantId: merchant.id,
          name: "Ceramic Mugs",
          description: "Premium ceramic mugs with wraparound artwork",
          printifyBlueprintId: 19,
          aspectRatio: "3:2",
          sizes: JSON.stringify([
            { id: "11oz", name: "11 oz", width: 11, height: 11 },
            { id: "15oz", name: "15 oz", width: 15, height: 15 },
          ]),
          frameColors: JSON.stringify([]),
          isActive: true,
          sortOrder: 2,
        },
      ];

      const created = [];
      for (const pt of defaultProductTypes) {
        const newPt = await storage.createProductType(pt);
        created.push(newPt);
      }

      res.json({ message: "Default product types seeded", productTypes: created });
    } catch (error) {
      console.error("Error seeding product types:", error);
      res.status(500).json({ error: "Failed to seed product types" });
    }
  });

  // Delete design
  app.delete("/api/designs/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const designId = parseInt(req.params.id);
      const userId = req.user.claims.sub;
      const customer = await storage.getCustomerByUserId(userId);
      
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }

      const design = await storage.getDesign(designId);
      if (!design || design.customerId !== customer.id) {
        return res.status(404).json({ error: "Design not found" });
      }

      await storage.deleteDesign(designId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting design:", error);
      res.status(500).json({ error: "Failed to delete design" });
    }
  });

  // Create share link for a design (public endpoint for Shopify embed)
  app.post("/api/designs/share", async (req: Request, res: Response) => {
    try {
      const { 
        imageUrl,
        thumbnailUrl,
        prompt,
        stylePreset,
        size,
        frameColor,
        transformScale,
        transformX,
        transformY,
        productTypeId,
        shopDomain,
        productId,
        productHandle,
      } = req.body;

      if (!imageUrl || !prompt || !size || !frameColor) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      // Validate image URL is from our storage domain (security check)
      // Use strict hostname matching to prevent bypass via subdomains
      const allowedDomains = [
        "storage.googleapis.com",
        "storage.cloud.google.com",
        process.env.REPL_SLUG ? `${process.env.REPL_SLUG}.replit.app` : null,
        "localhost",
      ].filter(Boolean) as string[];
      
      try {
        const imageUrlObj = new URL(imageUrl);
        // Require https for non-localhost URLs
        if (imageUrlObj.hostname !== "localhost" && imageUrlObj.protocol !== "https:") {
          return res.status(400).json({ error: "Image URL must use HTTPS" });
        }
        // Strict hostname matching: exact match or ends with .domain
        const isAllowedDomain = allowedDomains.some(domain => {
          const hostname = imageUrlObj.hostname;
          return hostname === domain || hostname.endsWith(`.${domain}`);
        });
        if (!isAllowedDomain) {
          return res.status(400).json({ error: "Invalid image URL" });
        }
      } catch {
        return res.status(400).json({ error: "Invalid image URL format" });
      }

      // Generate unique share token
      const shareToken = crypto.randomBytes(16).toString("hex");
      
      // Set expiration to 30 days from now
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      const sharedDesign = await storage.createSharedDesign({
        designId: null, // Nullable for unsaved designs
        shareToken,
        imageUrl,
        thumbnailUrl: thumbnailUrl || null,
        prompt,
        stylePreset: stylePreset || null,
        size,
        frameColor,
        transformScale: Math.round(transformScale ?? 100),
        transformX: Math.round(transformX ?? 50),
        transformY: Math.round(transformY ?? 50),
        productTypeId: productTypeId || null,
        shopDomain: shopDomain || null,
        productId: productId || null,
        productHandle: productHandle || null,
        expiresAt,
        viewCount: 0,
      });

      // Build share URL
      let shareUrl = "";
      if (shopDomain && productHandle) {
        // For Shopify embeds, return the merchant's product page URL with design ID
        shareUrl = `https://${shopDomain}/products/${productHandle}?sharedDesignId=${sharedDesign.id}`;
      } else {
        // For non-Shopify, use our embed design page
        shareUrl = `/embed/design?productTypeId=${productTypeId}&sharedDesignId=${sharedDesign.id}`;
      }

      res.json({ 
        sharedDesignId: sharedDesign.id,
        shareToken: sharedDesign.shareToken,
        shareUrl,
        expiresAt: sharedDesign.expiresAt,
      });
    } catch (error) {
      console.error("Error creating share link:", error);
      res.status(500).json({ error: "Failed to create share link" });
    }
  });

  // Get shared design by ID (public endpoint)
  app.get("/api/shared-designs/:id", async (req: Request, res: Response) => {
    try {
      const sharedDesign = await storage.getSharedDesign(req.params.id);
      
      if (!sharedDesign) {
        return res.status(404).json({ error: "Shared design not found" });
      }

      // Check if expired
      if (sharedDesign.expiresAt && new Date(sharedDesign.expiresAt) < new Date()) {
        return res.status(410).json({ error: "This shared design has expired" });
      }

      // Increment view count
      await storage.incrementSharedDesignViewCount(sharedDesign.id);

      res.json({
        id: sharedDesign.id,
        imageUrl: sharedDesign.imageUrl,
        thumbnailUrl: sharedDesign.thumbnailUrl,
        prompt: sharedDesign.prompt,
        stylePreset: sharedDesign.stylePreset,
        size: sharedDesign.size,
        frameColor: sharedDesign.frameColor,
        transformScale: sharedDesign.transformScale,
        transformX: sharedDesign.transformX,
        transformY: sharedDesign.transformY,
        productTypeId: sharedDesign.productTypeId,
        shopDomain: sharedDesign.shopDomain,
        productId: sharedDesign.productId,
        productHandle: sharedDesign.productHandle,
        viewCount: sharedDesign.viewCount + 1,
        createdAt: sharedDesign.createdAt,
      });
    } catch (error) {
      console.error("Error fetching shared design:", error);
      res.status(500).json({ error: "Failed to fetch shared design" });
    }
  });

  // Validate and prepare imported design (for Kittl/custom uploads)
  // This endpoint validates the uploaded image and returns metadata for previewing
  app.post("/api/designs/import", async (req: Request, res: Response) => {
    try {
      const { 
        imageUrl, 
        source = "upload",
        name = "Imported Design",
      } = req.body;

      if (!imageUrl) {
        return res.status(400).json({ error: "Missing image URL" });
      }

      // Validate source
      const validSources = ["upload", "kittl"];
      if (!validSources.includes(source)) {
        return res.status(400).json({ error: "Invalid design source" });
      }

      // SECURITY: Only accept internal /objects/ paths from our upload system
      // This prevents users from importing arbitrary external URLs
      if (!imageUrl.startsWith("/objects/")) {
        return res.status(400).json({ error: "Invalid image path - please upload your design first" });
      }

      // Additional validation: ensure path is under expected upload directory
      const expectedPrefix = "/objects/uploads/";
      if (!imageUrl.startsWith(expectedPrefix)) {
        return res.status(400).json({ error: "Invalid upload path" });
      }

      // Fetch the image to validate it and get dimensions
      let width = 0;
      let height = 0;
      let contentType = "";
      let finalImageUrl = imageUrl;
      
      try {
        // Resolve internal path to full URL for fetching
        const baseUrl = process.env.REPLIT_DEV_DOMAIN 
          ? `https://${process.env.REPLIT_DEV_DOMAIN}` 
          : `http://localhost:${process.env.PORT || 5000}`;
        const fetchUrl = `${baseUrl}${imageUrl}`;

        const response = await fetch(fetchUrl);
        if (!response.ok) {
          return res.status(400).json({ error: "Could not fetch uploaded image" });
        }

        contentType = response.headers.get("content-type") || "";
        // SECURITY: Reject SVG files to avoid XSS risks from embedded scripts
        // Only allow safe raster image formats
        const allowedTypes = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
        if (contentType.includes("svg")) {
          return res.status(400).json({ error: "SVG files are not supported. Please upload PNG, JPG, or WebP images." });
        }
        if (!allowedTypes.some(type => contentType.includes(type))) {
          return res.status(400).json({ error: "Invalid file type. Please upload PNG, JPG, or WebP images." });
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        // Check file size (max 10MB)
        const MAX_SIZE = 10 * 1024 * 1024; // 10MB
        if (buffer.length > MAX_SIZE) {
          return res.status(400).json({ error: "File too large. Maximum size is 10MB." });
        }

        // For raster images, get dimensions using sharp
        {
          // For raster images, just get dimensions
          const metadata = await sharp(buffer).metadata();
          width = metadata.width || 0;
          height = metadata.height || 0;
        }
      } catch (fetchError) {
        console.error("Error validating image:", fetchError);
        return res.status(400).json({ error: "Could not validate uploaded image" });
      }

      // Calculate aspect ratio
      let aspectRatio = "1:1";
      if (width && height) {
        const ratio = width / height;
        if (ratio > 1.3) aspectRatio = "4:3";
        else if (ratio > 1.1) aspectRatio = "1:1";
        else if (ratio > 0.9) aspectRatio = "1:1";
        else if (ratio > 0.7) aspectRatio = "3:4";
        else aspectRatio = "2:3";
      }

      res.json({
        success: true,
        imageUrl: finalImageUrl,
        name,
        source,
        width,
        height,
        aspectRatio,
        contentType,
      });
    } catch (error) {
      console.error("Error importing design:", error);
      res.status(500).json({ error: "Failed to import design" });
    }
  });

  // Reuse existing artwork on a different product/size/color
  // Creates a new design record using the same image from an existing design
  app.post("/api/designs/reuse", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      let customer = await storage.getCustomerByUserId(userId);
      
      if (!customer) {
        customer = await storage.createCustomer({
          userId,
          credits: 5,
          freeGenerationsUsed: 0,
          totalGenerations: 0,
          totalSpent: "0.00",
        });
      }

      // Check design gallery limit (50 max)
      const designCount = await storage.getDesignCountByCustomer(customer.id);
      if (designCount >= 50) {
        return res.status(400).json({ 
          error: "Your design gallery is full (50 designs max). Please delete some designs to save new ones.",
          galleryFull: true 
        });
      }

      const { 
        sourceDesignId, 
        productTypeId, 
        size, 
        frameColor,
        transformScale = 100,
        transformX = 50,
        transformY = 50,
      } = req.body;

      if (!sourceDesignId) {
        return res.status(400).json({ error: "Source design ID is required" });
      }

      if (!productTypeId || !size || !frameColor) {
        return res.status(400).json({ error: "Product type, size, and color are required" });
      }

      // Fetch the source design
      const sourceDesign = await storage.getDesign(parseInt(sourceDesignId));
      if (!sourceDesign) {
        return res.status(404).json({ error: "Source design not found" });
      }

      // Verify the user owns the source design
      if (sourceDesign.customerId !== customer.id) {
        return res.status(403).json({ error: "You can only reuse your own designs" });
      }

      // Create a new design record with the same image
      // Ensure transform values are integers (database columns are integer type)
      const newDesign = await storage.createDesign({
        customerId: customer.id,
        prompt: sourceDesign.prompt,
        stylePreset: sourceDesign.stylePreset,
        size,
        frameColor: frameColor || sourceDesign.frameColor,
        generatedImageUrl: sourceDesign.generatedImageUrl,
        thumbnailImageUrl: sourceDesign.thumbnailImageUrl,
        transformScale: Math.round(transformScale),
        transformX: Math.round(transformX),
        transformY: Math.round(transformY),
        productTypeId: parseInt(productTypeId),
        designSource: "ai", // Mark as AI-generated since it came from an AI design
      });

      res.json({
        success: true,
        design: newDesign,
        message: "Design saved to your gallery",
      });
    } catch (error) {
      console.error("Error reusing design:", error);
      res.status(500).json({ error: "Failed to save reused design" });
    }
  });

  // Purchase credits
  app.post("/api/credits/purchase", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { package: creditPackage } = req.body;
      
      let customer = await storage.getCustomerByUserId(userId);
      if (!customer) {
        customer = await storage.createCustomer({
          userId,
          credits: 5,
          freeGenerationsUsed: 0,
          totalGenerations: 0,
          totalSpent: "0.00",
        });
      }

      // Credit packages: $1 for 5 credits
      let creditsToAdd = 0;
      let priceInCents = 0;
      
      if (creditPackage === "5") {
        creditsToAdd = 5;
        priceInCents = 100; // $1.00
      } else {
        return res.status(400).json({ error: "Invalid credit package" });
      }

      // Update customer credits
      const newCredits = customer.credits + creditsToAdd;
      const newTotalSpent = parseFloat(customer.totalSpent) + (priceInCents / 100);
      
      await storage.updateCustomer(customer.id, {
        credits: newCredits,
        totalSpent: newTotalSpent.toFixed(2),
      });

      // Log transaction
      await storage.createCreditTransaction({
        customerId: customer.id,
        type: "purchase",
        amount: creditsToAdd,
        priceInCents,
        description: `Purchased ${creditsToAdd} credits`,
      });

      res.json({
        success: true,
        credits: newCredits,
        charged: priceInCents,
      });
    } catch (error) {
      console.error("Error purchasing credits:", error);
      res.status(500).json({ error: "Failed to purchase credits" });
    }
  });

  // Get credit transactions
  app.get("/api/credits/transactions", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const customer = await storage.getCustomerByUserId(userId);
      
      if (!customer) {
        return res.json([]);
      }

      const transactions = await storage.getCreditTransactionsByCustomer(customer.id);
      res.json(transactions);
    } catch (error) {
      console.error("Error fetching transactions:", error);
      res.status(500).json({ error: "Failed to fetch transactions" });
    }
  });

  // Get customer orders
  app.get("/api/orders", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const customer = await storage.getCustomerByUserId(userId);
      
      if (!customer) {
        return res.json([]);
      }

      const orders = await storage.getOrdersByCustomer(customer.id);
      res.json(orders);
    } catch (error) {
      console.error("Error fetching orders:", error);
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  });

  // Create order (add to cart / checkout)
  app.post("/api/orders", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { designId, shippingAddress } = req.body;
      
      const customer = await storage.getCustomerByUserId(userId);
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }

      const design = await storage.getDesign(designId);
      if (!design || design.customerId !== customer.id) {
        return res.status(404).json({ error: "Design not found" });
      }

      // Calculate credit refund (max $1.00 = 100 cents)
      const transactions = await storage.getCreditTransactionsByCustomer(customer.id);
      const purchasedCreditsSpent = transactions
        .filter(t => t.type === "purchase")
        .reduce((sum, t) => sum + (t.priceInCents || 0), 0);
      
      const creditRefundInCents = Math.min(purchasedCreditsSpent, 100);

      // Get price based on size (mock prices for now - would come from Printify API)
      const sizeConfig = PRINT_SIZES.find(s => s.id === design.size);
      const basePrices: Record<string, number> = {
        "11x14": 3999,
        "12x16": 4499,
        "16x20": 5499,
        "16x24": 5999,
        "20x30": 7999,
        "16x16": 4999,
      };
      const priceInCents = basePrices[design.size] || 4999;
      const shippingInCents = 899; // $8.99 flat rate USA

      const order = await storage.createOrder({
        designId: design.id,
        customerId: customer.id,
        status: "pending",
        size: design.size,
        frameColor: design.frameColor,
        quantity: 1,
        priceInCents,
        shippingInCents,
        creditRefundInCents,
        shippingAddress: JSON.stringify(shippingAddress),
      });

      res.json({
        order,
        totalInCents: priceInCents + shippingInCents - creditRefundInCents,
      });
    } catch (error) {
      console.error("Error creating order:", error);
      res.status(500).json({ error: "Failed to create order" });
    }
  });

  // ==================== MERCHANT ADMIN ENDPOINTS ====================

  // Get or create merchant profile
  app.get("/api/merchant", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      let merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        merchant = await storage.createMerchant({
          userId,
          useBuiltInNanoBanana: true,
          subscriptionTier: "free",
          monthlyGenerationLimit: 100,
          generationsThisMonth: 0,
        });
      }
      
      res.json(merchant);
    } catch (error) {
      console.error("Error fetching merchant:", error);
      res.status(500).json({ error: "Failed to fetch merchant" });
    }
  });

  // Update merchant settings
  app.put("/api/merchant", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      let merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        merchant = await storage.createMerchant({
          userId,
          useBuiltInNanoBanana: true,
          subscriptionTier: "free",
          monthlyGenerationLimit: 100,
          generationsThisMonth: 0,
        });
      }

      const { printifyApiToken, printifyShopId, useBuiltInNanoBanana, customNanoBananaToken } = req.body;
      
      const updated = await storage.updateMerchant(merchant.id, {
        printifyApiToken: printifyApiToken || merchant.printifyApiToken,
        printifyShopId: printifyShopId || merchant.printifyShopId,
        useBuiltInNanoBanana: useBuiltInNanoBanana !== undefined ? useBuiltInNanoBanana : merchant.useBuiltInNanoBanana,
        customNanoBananaToken: customNanoBananaToken || merchant.customNanoBananaToken,
      });

      res.json(updated);
    } catch (error) {
      console.error("Error updating merchant:", error);
      res.status(500).json({ error: "Failed to update merchant" });
    }
  });

  // Get merchant generation stats
  app.get("/api/admin/stats", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.json({ total: 0, successful: 0, failed: 0 });
      }

      // Get stats for the last 30 days
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);

      const stats = await storage.getGenerationStats(merchant.id, startDate, endDate);
      res.json(stats);
    } catch (error) {
      console.error("Error fetching stats:", error);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  // Migrate existing designs to have thumbnails (and migrate base64 to object storage)
  app.post("/api/admin/migrate-thumbnails", isAuthenticated, async (req: any, res: Response) => {
    try {
      const batchSize = req.body.batchSize || 10;
      const designs = await storage.getDesignsNeedingThumbnails(batchSize);
      
      if (designs.length === 0) {
        return res.json({ migrated: 0, message: "No designs need thumbnail migration" });
      }

      // Get bucket info once
      const privateDir = objectStorage.getPrivateObjectDir();
      const pathWithSlash = privateDir.startsWith("/") ? privateDir : `/${privateDir}`;
      const pathParts = pathWithSlash.split("/").filter(p => p.length > 0);
      const bucketName = pathParts[0];
      const bucket = objectStorageClient.bucket(bucketName);

      let migratedCount = 0;
      const errors: string[] = [];

      for (const design of designs) {
        try {
          const imageUrl = design.generatedImageUrl;
          
          if (!imageUrl) continue;
          
          let buffer: Buffer;
          let imageId: string;
          let newGeneratedImageUrl: string | undefined;
          
          if (imageUrl.startsWith("data:")) {
            // Base64 image - extract, decode, and migrate to object storage
            const base64Match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
            if (!base64Match) {
              errors.push(`Design ${design.id}: Invalid base64 format`);
              continue;
            }
            const imageFormat = base64Match[1];
            const extension = imageFormat === "png" ? "png" : "jpg";
            buffer = Buffer.from(base64Match[2], "base64");
            
            // Generate a new ID for both original and thumbnail
            imageId = crypto.randomUUID();
            
            // Save original to object storage (migrating from base64)
            const originalObjectPath = `.private/designs/${imageId}.${extension}`;
            const originalFile = bucket.file(originalObjectPath);
            await originalFile.save(buffer, {
              contentType: `image/${imageFormat}`,
              metadata: {
                metadata: {
                  "custom:aclPolicy": JSON.stringify({ owner: "system", visibility: "public" })
                }
              }
            });
            newGeneratedImageUrl = `/objects/designs/${imageId}.${extension}`;
            
          } else if (imageUrl.startsWith("/objects/")) {
            // Object storage URL - extract existing ID from filename
            const filenameMatch = imageUrl.match(/\/objects\/designs\/([^.]+)\.(png|jpg)$/);
            if (!filenameMatch) {
              errors.push(`Design ${design.id}: Could not extract ID from URL`);
              continue;
            }
            imageId = filenameMatch[1];
            const extension = filenameMatch[2];
            
            // Fetch the original image
            const objectPath = `.private/designs/${imageId}.${extension}`;
            const file = bucket.file(objectPath);
            
            const [exists] = await file.exists();
            if (!exists) {
              errors.push(`Design ${design.id}: Source image not found at ${objectPath}`);
              continue;
            }
            
            const [contents] = await file.download();
            buffer = contents;
            
          } else {
            errors.push(`Design ${design.id}: Unknown image URL format`);
            continue;
          }

          // Generate thumbnail
          const thumbnailBuffer = await generateThumbnail(buffer);
          
          // Save thumbnail with matching ID pattern
          const thumbObjectPath = `.private/designs/thumb_${imageId}.jpg`;
          const thumbFile = bucket.file(thumbObjectPath);
          
          await thumbFile.save(thumbnailBuffer, {
            contentType: "image/jpeg",
            metadata: {
              metadata: {
                "custom:aclPolicy": JSON.stringify({ owner: "system", visibility: "public" })
              }
            }
          });
          
          const thumbnailUrl = `/objects/designs/thumb_${imageId}.jpg`;
          
          // Update design with new URLs
          const updateData: { thumbnailImageUrl: string; generatedImageUrl?: string } = { 
            thumbnailImageUrl: thumbnailUrl 
          };
          if (newGeneratedImageUrl) {
            updateData.generatedImageUrl = newGeneratedImageUrl;
          }
          await storage.updateDesign(design.id, updateData);
          migratedCount++;
          
        } catch (err) {
          errors.push(`Design ${design.id}: ${(err as Error).message}`);
        }
      }

      res.json({
        migrated: migratedCount,
        total: designs.length,
        errors: errors.length > 0 ? errors : undefined,
        hasMore: designs.length === batchSize
      });
    } catch (error) {
      console.error("Error migrating thumbnails:", error);
      res.status(500).json({ error: "Failed to migrate thumbnails" });
    }
  });

  // Backfill product type for existing designs (defaults to Framed Vertical Poster with ID 20)
  app.post("/api/admin/backfill-product-types", isAuthenticated, async (req: any, res: Response) => {
    try {
      const batchSize = req.body.batchSize || 50;
      const defaultProductTypeId = req.body.defaultProductTypeId || 20; // Framed Vertical Poster
      
      const designs = await storage.getDesignsNeedingProductType(batchSize);
      
      if (designs.length === 0) {
        return res.json({ updated: 0, message: "No designs need product type backfill" });
      }

      let updatedCount = 0;
      const errors: string[] = [];

      for (const design of designs) {
        try {
          await storage.updateDesign(design.id, { productTypeId: defaultProductTypeId });
          updatedCount++;
        } catch (err) {
          errors.push(`Design ${design.id}: ${(err as Error).message}`);
        }
      }

      res.json({
        updated: updatedCount,
        total: designs.length,
        errors: errors.length > 0 ? errors : undefined,
        hasMore: designs.length === batchSize
      });
    } catch (error) {
      console.error("Error backfilling product types:", error);
      res.status(500).json({ error: "Failed to backfill product types" });
    }
  });

  // ==================== COUPON MANAGEMENT ====================

  // Get merchant's coupons
  app.get("/api/admin/coupons", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.json([]);
      }

      const coupons = await storage.getCouponsByMerchant(merchant.id);
      res.json(coupons);
    } catch (error) {
      console.error("Error fetching coupons:", error);
      res.status(500).json({ error: "Failed to fetch coupons" });
    }
  });

  // Create coupon
  app.post("/api/admin/coupons", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const { code, creditAmount, maxUses, expiresAt } = req.body;
      
      if (!code || !creditAmount) {
        return res.status(400).json({ error: "Code and credit amount are required" });
      }

      // Check if code already exists
      const existingCoupon = await storage.getCouponByCode(code);
      if (existingCoupon) {
        return res.status(400).json({ error: "Coupon code already exists" });
      }

      const coupon = await storage.createCoupon({
        merchantId: merchant.id,
        code,
        creditAmount: parseInt(creditAmount),
        maxUses: maxUses ? parseInt(maxUses) : null,
        isActive: true,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      });

      res.json(coupon);
    } catch (error) {
      console.error("Error creating coupon:", error);
      res.status(500).json({ error: "Failed to create coupon" });
    }
  });

  // Update coupon
  app.patch("/api/admin/coupons/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const couponId = parseInt(req.params.id);
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const coupon = await storage.getCoupon(couponId);
      if (!coupon || coupon.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Coupon not found" });
      }

      const { isActive, maxUses, expiresAt } = req.body;
      
      const updated = await storage.updateCoupon(couponId, {
        isActive: isActive !== undefined ? isActive : coupon.isActive,
        maxUses: maxUses !== undefined ? maxUses : coupon.maxUses,
        expiresAt: expiresAt ? new Date(expiresAt) : coupon.expiresAt,
      });

      res.json(updated);
    } catch (error) {
      console.error("Error updating coupon:", error);
      res.status(500).json({ error: "Failed to update coupon" });
    }
  });

  // Delete coupon
  app.delete("/api/admin/coupons/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const couponId = parseInt(req.params.id);
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const coupon = await storage.getCoupon(couponId);
      if (!coupon || coupon.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Coupon not found" });
      }

      await storage.deleteCoupon(couponId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting coupon:", error);
      res.status(500).json({ error: "Failed to delete coupon" });
    }
  });

  // Redeem coupon (customer endpoint)
  app.post("/api/coupons/redeem", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { code } = req.body;
      
      if (!code) {
        return res.status(400).json({ error: "Coupon code is required" });
      }

      const customer = await storage.getCustomerByUserId(userId);
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }

      const coupon = await storage.getCouponByCode(code);
      if (!coupon) {
        return res.status(404).json({ error: "Invalid coupon code" });
      }

      if (!coupon.isActive) {
        return res.status(400).json({ error: "Coupon is no longer active" });
      }

      if (coupon.expiresAt && new Date() > coupon.expiresAt) {
        return res.status(400).json({ error: "Coupon has expired" });
      }

      if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
        return res.status(400).json({ error: "Coupon has reached maximum uses" });
      }

      // Add credits to customer
      await storage.updateCustomer(customer.id, {
        credits: customer.credits + coupon.creditAmount,
      });

      // Record redemption
      await storage.createCouponRedemption({
        couponId: coupon.id,
        customerId: customer.id,
      });

      // Update coupon usage count
      await storage.updateCoupon(coupon.id, {
        usedCount: coupon.usedCount + 1,
      });

      // Log credit transaction
      await storage.createCreditTransaction({
        customerId: customer.id,
        type: "coupon",
        amount: coupon.creditAmount,
        description: `Redeemed coupon: ${coupon.code}`,
      });

      res.json({
        success: true,
        creditsAdded: coupon.creditAmount,
        newBalance: customer.credits + coupon.creditAmount,
      });
    } catch (error) {
      console.error("Error redeeming coupon:", error);
      res.status(500).json({ error: "Failed to redeem coupon" });
    }
  });

  // ==================== STYLE PRESET MANAGEMENT ====================

  // Get merchant's style presets
  app.get("/api/admin/styles", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.json([]);
      }

      const presets = await storage.getStylePresetsByMerchant(merchant.id);
      res.json(presets);
    } catch (error) {
      console.error("Error fetching style presets:", error);
      res.status(500).json({ error: "Failed to fetch style presets" });
    }
  });

  // Create style preset
  app.post("/api/admin/styles", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const { name, promptPrefix, category, isActive, sortOrder } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: "Style name is required" });
      }

      const preset = await storage.createStylePreset({
        merchantId: merchant.id,
        name,
        promptPrefix: promptPrefix || "",
        category: category || "all",
        isActive: isActive !== undefined ? isActive : true,
        sortOrder: sortOrder || 0,
      });

      res.json(preset);
    } catch (error) {
      console.error("Error creating style preset:", error);
      res.status(500).json({ error: "Failed to create style preset" });
    }
  });

  // Update style preset
  app.patch("/api/admin/styles/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const presetId = parseInt(req.params.id);
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const preset = await storage.getStylePreset(presetId);
      if (!preset || preset.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Style preset not found" });
      }

      const { name, promptPrefix, category, isActive, sortOrder } = req.body;
      
      const updated = await storage.updateStylePreset(presetId, {
        name: name !== undefined ? name : preset.name,
        promptPrefix: promptPrefix !== undefined ? promptPrefix : preset.promptPrefix,
        category: category !== undefined ? category : preset.category,
        isActive: isActive !== undefined ? isActive : preset.isActive,
        sortOrder: sortOrder !== undefined ? sortOrder : preset.sortOrder,
      });

      res.json(updated);
    } catch (error) {
      console.error("Error updating style preset:", error);
      res.status(500).json({ error: "Failed to update style preset" });
    }
  });

  // Delete style preset
  app.delete("/api/admin/styles/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const presetId = parseInt(req.params.id);
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const preset = await storage.getStylePreset(presetId);
      if (!preset || preset.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Style preset not found" });
      }

      await storage.deleteStylePreset(presetId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting style preset:", error);
      res.status(500).json({ error: "Failed to delete style preset" });
    }
  });


  // Seed default styles for merchant (on first admin load)
  app.post("/api/admin/styles/seed", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      // Check if merchant already has styles
      const existingStyles = await storage.getStylePresetsByMerchant(merchant.id);
      if (existingStyles.length > 0) {
        return res.json({ message: "Styles already seeded", styles: existingStyles });
      }

      // Seed default styles with their categories
      const defaultStyles = STYLE_PRESETS.map((style, index) => ({
        merchantId: merchant.id,
        name: style.name,
        promptPrefix: style.promptPrefix,
        category: style.category,
        isActive: true,
        sortOrder: index,
      }));

      const createdStyles = [];
      for (const style of defaultStyles) {
        const created = await storage.createStylePreset(style);
        createdStyles.push(created);
      }

      res.json({ message: "Default styles seeded", styles: createdStyles });
    } catch (error) {
      console.error("Error seeding styles:", error);
      res.status(500).json({ error: "Failed to seed styles" });
    }
  });

  // Reseed styles - update existing styles with proper categories and add missing ones
  app.post("/api/admin/styles/reseed", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const existingStyles = await storage.getStylePresetsByMerchant(merchant.id);
      const existingByName = new Map(existingStyles.map(s => [s.name, s]));
      
      const updatedStyles = [];
      const createdStyles = [];

      for (let i = 0; i < STYLE_PRESETS.length; i++) {
        const preset = STYLE_PRESETS[i];
        const existing = existingByName.get(preset.name);
        
        if (existing) {
          // Update existing style with correct category
          const updated = await storage.updateStylePreset(existing.id, {
            category: preset.category,
            promptPrefix: preset.promptPrefix,
            sortOrder: i,
          });
          if (updated) updatedStyles.push(updated);
        } else {
          // Create missing style
          const created = await storage.createStylePreset({
            merchantId: merchant.id,
            name: preset.name,
            promptPrefix: preset.promptPrefix,
            category: preset.category,
            isActive: true,
            sortOrder: i,
          });
          createdStyles.push(created);
        }
      }

      res.json({ 
        message: "Styles reseeded successfully",
        updated: updatedStyles.length,
        created: createdStyles.length,
        styles: [...updatedStyles, ...createdStyles]
      });
    } catch (error) {
      console.error("Error reseeding styles:", error);
      res.status(500).json({ error: "Failed to reseed styles" });
    }
  });

  // ==================== PRINTIFY CATALOG INTEGRATION ====================

  // Cache for provider location mappings (provider_id -> location data)
  const providerLocationCache = new Map<string, { location?: { country: string }, fulfillment_countries: string[] }>();
  
  // Cache for blueprint provider IDs (blueprint_id -> provider_ids[])
  const blueprintProviderCache = new Map<number, number[]>();
  
  // Track cache warm-up state
  let cacheWarmUpInProgress = false;
  let cacheLastWarmedAt: Date | null = null;
  
  // Endpoint to warm up Printify provider and blueprint caches
  // This runs in background when admin opens Printify tab
  app.post("/api/admin/printify/warm-cache", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant || !merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }
      
      // Return immediately if cache is already warm (within last 10 minutes)
      const cacheAge = cacheLastWarmedAt ? Date.now() - cacheLastWarmedAt.getTime() : Infinity;
      if (cacheAge < 10 * 60 * 1000 && providerLocationCache.size > 0 && blueprintProviderCache.size > 0) {
        return res.json({ 
          status: "ready",
          providers: providerLocationCache.size,
          blueprints: blueprintProviderCache.size
        });
      }
      
      // Return immediately if warm-up is already in progress
      if (cacheWarmUpInProgress) {
        return res.json({ status: "warming" });
      }
      
      // Start warming in background
      cacheWarmUpInProgress = true;
      res.json({ status: "warming" });
      
      // Background warm-up process
      (async () => {
        try {
          const pLimit = (await import('p-limit')).default;
          const limit = pLimit(5);
          
          // Step 1: Fetch all providers and their details
          const providersResponse = await fetch("https://api.printify.com/v1/catalog/print_providers.json", {
            headers: {
              "Authorization": `Bearer ${merchant.printifyApiToken}`,
              "Content-Type": "application/json"
            }
          });
          
          if (providersResponse.ok) {
            const allProviders = await providersResponse.json();
            
            await Promise.all(
              allProviders.map((provider: any) => 
                limit(async () => {
                  try {
                    const detailResponse = await fetchWithRetry(
                      `https://api.printify.com/v1/catalog/print_providers/${provider.id}.json`,
                      {
                        headers: {
                          "Authorization": `Bearer ${merchant.printifyApiToken}`,
                          "Content-Type": "application/json"
                        }
                      },
                      2,
                      2000
                    );
                    
                    if (detailResponse.ok) {
                      const details = await detailResponse.json();
                      providerLocationCache.set(String(provider.id), {
                        location: details.location,
                        fulfillment_countries: details.fulfillment_countries || [],
                      });
                    }
                  } catch (err) {
                    console.error(`Error caching provider ${provider.id}:`, err);
                  }
                })
              )
            );
          }
          
          // Step 2: Fetch all blueprints and their provider mappings
          const blueprintsResponse = await fetch("https://api.printify.com/v1/catalog/blueprints.json", {
            headers: {
              "Authorization": `Bearer ${merchant.printifyApiToken}`,
              "Content-Type": "application/json"
            }
          });
          
          if (blueprintsResponse.ok) {
            const allBlueprints = await blueprintsResponse.json();
            
            await Promise.all(
              allBlueprints.map((blueprint: any) =>
                limit(async () => {
                  try {
                    const provResponse = await fetchWithRetry(
                      `https://api.printify.com/v1/catalog/blueprints/${blueprint.id}/print_providers.json`,
                      {
                        headers: {
                          "Authorization": `Bearer ${merchant.printifyApiToken}`,
                          "Content-Type": "application/json"
                        }
                      },
                      2,
                      2000
                    );
                    
                    if (provResponse.ok) {
                      const providers = await provResponse.json();
                      blueprintProviderCache.set(blueprint.id, providers.map((p: any) => p.id));
                    }
                  } catch (err) {
                    console.error(`Error caching blueprint ${blueprint.id} providers:`, err);
                  }
                })
              )
            );
          }
          
          cacheLastWarmedAt = new Date();
          console.log(`Cache warm-up complete: ${providerLocationCache.size} providers, ${blueprintProviderCache.size} blueprints`);
        } catch (err) {
          console.error("Cache warm-up error:", err);
        } finally {
          cacheWarmUpInProgress = false;
        }
      })();
    } catch (error) {
      console.error("Error starting cache warm-up:", error);
      res.status(500).json({ error: "Failed to start cache warm-up" });
    }
  });
  
  // Check cache status
  app.get("/api/admin/printify/cache-status", isAuthenticated, async (req: any, res: Response) => {
    res.json({
      status: cacheWarmUpInProgress ? "warming" : (providerLocationCache.size > 0 ? "ready" : "cold"),
      providers: providerLocationCache.size,
      blueprints: blueprintProviderCache.size,
      lastWarmed: cacheLastWarmedAt?.toISOString() || null
    });
  });

  // Fetch all blueprints from Printify catalog with optional location filtering
  app.get("/api/admin/printify/blueprints", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const locationFilter = req.query.location as string | undefined;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant || !merchant.printifyApiToken) {
        return res.status(400).json({ 
          error: "Printify API token not configured",
          message: "Please add your Printify API token in Settings first"
        });
      }

      const response = await fetch("https://api.printify.com/v1/catalog/blueprints.json", {
        headers: {
          "Authorization": `Bearer ${merchant.printifyApiToken}`,
          "Content-Type": "application/json"
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          return res.status(401).json({ error: "Invalid Printify API token" });
        }
        throw new Error(`Printify API error: ${response.status}`);
      }

      let blueprints = await response.json();
      
      // If location filter provided, filter using cached data only (no API calls)
      if (locationFilter && locationFilter !== "all") {
        // Check if cache is ready
        if (blueprintProviderCache.size === 0 || providerLocationCache.size === 0) {
          // Cache not ready - return error asking to wait
          return res.status(202).json({
            error: "cache_not_ready",
            message: "Provider data is still loading. Please wait a moment.",
            cacheStatus: {
              providers: providerLocationCache.size,
              blueprints: blueprintProviderCache.size,
              warming: cacheWarmUpInProgress
            }
          });
        }
        
        // Filter blueprints locally using cached data (no API calls!)
        blueprints = blueprints.filter((blueprint: any) => {
          const providerIds = blueprintProviderCache.get(blueprint.id);
          if (!providerIds || providerIds.length === 0) return false;
          
          // Check if any provider matches the location filter
          return providerIds.some((providerId: number) => {
            const providerData = providerLocationCache.get(String(providerId));
            if (!providerData) return false;
            
            const locationCountry = providerData.location?.country || "";
            const fulfillmentCountries = providerData.fulfillment_countries || [];
            
            return locationCountry.includes(locationFilter) || 
                   fulfillmentCountries.some((c: string) => c.includes(locationFilter));
          });
        });
      }
      
      res.json(blueprints);
    } catch (error) {
      console.error("Error fetching Printify blueprints:", error);
      res.status(500).json({ error: "Failed to fetch Printify catalog" });
    }
  });

  // Batch fetch provider location data for multiple blueprints (for on-demand geo-filtering)
  app.post("/api/admin/printify/blueprints/batch-providers", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { blueprintIds } = req.body;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant || !merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      if (!Array.isArray(blueprintIds) || blueprintIds.length === 0) {
        return res.status(400).json({ error: "blueprintIds array is required" });
      }

      // Limit to 100 blueprints at a time to prevent abuse
      const idsToFetch = blueprintIds.slice(0, 100);
      
      const pLimit = (await import('p-limit')).default;
      const limit = pLimit(5); // Concurrency limit to avoid rate limits
      
      // Fetch provider lists for each blueprint
      const blueprintProviderMap: Record<number, number[]> = {};
      const providersToFetch = new Set<number>();
      
      await Promise.all(
        idsToFetch.map((blueprintId: number) =>
          limit(async () => {
            try {
              // Check cache first
              if (blueprintProviderCache.has(blueprintId)) {
                const providerIds = blueprintProviderCache.get(blueprintId)!;
                blueprintProviderMap[blueprintId] = providerIds;
                providerIds.forEach((id: number) => {
                  if (!providerLocationCache.has(String(id))) {
                    providersToFetch.add(id);
                  }
                });
                return;
              }
              
              const response = await fetchWithRetry(
                `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers.json`,
                {
                  headers: {
                    "Authorization": `Bearer ${merchant.printifyApiToken}`,
                    "Content-Type": "application/json"
                  }
                },
                2,
                1000
              );
              
              if (response.ok) {
                const providers = await response.json();
                const providerIds = providers.map((p: any) => p.id);
                blueprintProviderMap[blueprintId] = providerIds;
                blueprintProviderCache.set(blueprintId, providerIds);
                providerIds.forEach((id: number) => {
                  if (!providerLocationCache.has(String(id))) {
                    providersToFetch.add(id);
                  }
                });
              }
            } catch (err) {
              console.error(`Error fetching providers for blueprint ${blueprintId}:`, err);
            }
          })
        )
      );
      
      // Fetch location details for any providers not yet cached
      if (providersToFetch.size > 0) {
        await Promise.all(
          Array.from(providersToFetch).map((providerId) =>
            limit(async () => {
              try {
                const response = await fetchWithRetry(
                  `https://api.printify.com/v1/catalog/print_providers/${providerId}.json`,
                  {
                    headers: {
                      "Authorization": `Bearer ${merchant.printifyApiToken}`,
                      "Content-Type": "application/json"
                    }
                  },
                  2,
                  1000
                );
                
                if (response.ok) {
                  const details = await response.json();
                  providerLocationCache.set(String(providerId), {
                    location: details.location,
                    fulfillment_countries: details.fulfillment_countries || [],
                  });
                }
              } catch (err) {
                console.error(`Error fetching provider ${providerId} details:`, err);
              }
            })
          )
        );
      }
      
      // Build response with blueprint -> location data mapping
      const result: Record<number, { providerIds: number[]; locations: string[] }> = {};
      
      for (const [bpId, providerIds] of Object.entries(blueprintProviderMap)) {
        const locations = new Set<string>();
        
        for (const providerId of providerIds as number[]) {
          const providerData = providerLocationCache.get(String(providerId));
          if (providerData) {
            if (providerData.location?.country) {
              locations.add(providerData.location.country);
            }
            providerData.fulfillment_countries?.forEach((c: string) => locations.add(c));
          }
        }
        
        result[Number(bpId)] = {
          providerIds: providerIds as number[],
          locations: Array.from(locations)
        };
      }
      
      res.json(result);
    } catch (error) {
      console.error("Error batch fetching blueprint providers:", error);
      res.status(500).json({ error: "Failed to fetch provider data" });
    }
  });

  // Fetch specific blueprint details from Printify
  app.get("/api/admin/printify/blueprints/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const blueprintId = req.params.id;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant || !merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      const response = await fetch(`https://api.printify.com/v1/catalog/blueprints/${blueprintId}.json`, {
        headers: {
          "Authorization": `Bearer ${merchant.printifyApiToken}`,
          "Content-Type": "application/json"
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          return res.status(401).json({ error: "Invalid Printify API token" });
        }
        if (response.status === 404) {
          return res.status(404).json({ error: "Blueprint not found" });
        }
        throw new Error(`Printify API error: ${response.status}`);
      }

      const blueprint = await response.json();
      res.json(blueprint);
    } catch (error) {
      console.error("Error fetching Printify blueprint:", error);
      res.status(500).json({ error: "Failed to fetch blueprint details" });
    }
  });

  // Fetch print providers for a blueprint with enriched location data
  app.get("/api/admin/printify/blueprints/:id/providers", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const blueprintId = req.params.id;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant || !merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      // Fetch blueprint-specific providers
      const response = await fetch(`https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers.json`, {
        headers: {
          "Authorization": `Bearer ${merchant.printifyApiToken}`,
          "Content-Type": "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(`Printify API error: ${response.status}`);
      }

      const providers = await response.json();
      
      // Fetch detailed info for each provider to get location data
      const enrichedProviders = await Promise.all(
        providers.map(async (provider: any) => {
          try {
            const detailResponse = await fetch(
              `https://api.printify.com/v1/catalog/print_providers/${provider.id}.json`,
              {
                headers: {
                  "Authorization": `Bearer ${merchant.printifyApiToken}`,
                  "Content-Type": "application/json"
                }
              }
            );
            
            if (detailResponse.ok) {
              const details = await detailResponse.json();
              return {
                ...provider,
                location: details.location,
                fulfillment_countries: details.fulfillment_countries || [],
              };
            }
          } catch (err) {
            console.error(`Error fetching provider ${provider.id} details:`, err);
          }
          return provider;
        })
      );
      
      res.json(enrichedProviders);
    } catch (error) {
      console.error("Error fetching print providers:", error);
      res.status(500).json({ error: "Failed to fetch print providers" });
    }
  });

  // Fetch all print providers with location data for filtering
  app.get("/api/admin/printify/providers", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant || !merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      const response = await fetch("https://api.printify.com/v1/catalog/print_providers.json", {
        headers: {
          "Authorization": `Bearer ${merchant.printifyApiToken}`,
          "Content-Type": "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(`Printify API error: ${response.status}`);
      }

      const providers = await response.json();
      
      // Fetch detailed info for each provider to get location data
      const enrichedProviders = await Promise.all(
        providers.map(async (provider: any) => {
          try {
            const detailResponse = await fetch(
              `https://api.printify.com/v1/catalog/print_providers/${provider.id}.json`,
              {
                headers: {
                  "Authorization": `Bearer ${merchant.printifyApiToken}`,
                  "Content-Type": "application/json"
                }
              }
            );
            
            if (detailResponse.ok) {
              const details = await detailResponse.json();
              return {
                ...provider,
                location: details.location,
                fulfillment_countries: details.fulfillment_countries || [],
              };
            }
          } catch (err) {
            console.error(`Error fetching provider ${provider.id} details:`, err);
          }
          return provider;
        })
      );
      
      res.json(enrichedProviders);
    } catch (error) {
      console.error("Error fetching all print providers:", error);
      res.status(500).json({ error: "Failed to fetch print providers" });
    }
  });

  // Fetch variants for a blueprint from a specific provider
  app.get("/api/admin/printify/blueprints/:blueprintId/providers/:providerId/variants", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { blueprintId, providerId } = req.params;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant || !merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      const response = await fetch(
        `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json`,
        {
          headers: {
            "Authorization": `Bearer ${merchant.printifyApiToken}`,
            "Content-Type": "application/json"
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Printify API error: ${response.status}`);
      }

      const variants = await response.json();
      res.json(variants);
    } catch (error) {
      console.error("Error fetching variants:", error);
      res.status(500).json({ error: "Failed to fetch variants" });
    }
  });

  // Fetch parsed variant options (sizes/colors) for import wizard
  app.get("/api/admin/printify/blueprints/:blueprintId/variants", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { blueprintId } = req.params;
      const { providerId } = req.query;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant || !merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      // Get providers if no providerId specified
      let actualProviderId = providerId;
      if (!actualProviderId) {
        const providersResponse = await fetch(
          `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers.json`,
          {
            headers: {
              "Authorization": `Bearer ${merchant.printifyApiToken}`,
              "Content-Type": "application/json"
            }
          }
        );
        if (providersResponse.ok) {
          const providers = await providersResponse.json();
          if (providers && providers.length > 0) {
            actualProviderId = providers[0].id;
          }
        }
      }

      if (!actualProviderId) {
        return res.status(400).json({ error: "No provider available for this blueprint" });
      }

      const response = await fetch(
        `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers/${actualProviderId}/variants.json`,
        {
          headers: {
            "Authorization": `Bearer ${merchant.printifyApiToken}`,
            "Content-Type": "application/json"
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Printify API error: ${response.status}`);
      }

      const variantsData = await response.json();
      const variants = variantsData.variants || variantsData || [];
      
      // Parse variants to extract sizes and colors (simplified version of import logic)
      const sizesMap = new Map<string, { id: string; name: string; width: number; height: number }>();
      const colorsMap = new Map<string, { id: string; name: string; hex: string }>();
      
      const apparelSizes = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "XXL", "XXXL"];
      const apparelSizesLower = apparelSizes.map(s => s.toLowerCase());
      const namedSizes = ["small", "medium", "large", "extra large", "king", "queen", "twin", "full", "one size"];
      
      const looksLikeSize = (str: string): boolean => {
        const lower = str.toLowerCase().trim();
        if (lower.match(/^\d+[""']?\s*[xX×]\s*\d+[""']?$/)) return true;
        if (apparelSizesLower.includes(lower)) return true;
        if (namedSizes.includes(lower)) return true;
        if (lower.match(/^\d+\s*oz$/i)) return true;
        if (lower.match(/^iphone\s+(\d|x|xs|xr|se|pro|plus|max)/i)) return true;
        if (lower.match(/^galaxy\s+(s\d|a\d|note|z\s*(fold|flip)|ultra)/i)) return true;
        if (lower.match(/^pixel\s+(\d|fold|pro)/i)) return true;
        if (lower.match(/^(youth|kid'?s?|toddler|infant|baby)\s/i)) return true;
        return false;
      };
      
      for (const variant of variants) {
        const title = variant.title || "";
        const options = variant.options || {};
        
        const normalizedTitle = title
          .replace(/[″″‶‴]/g, '"')
          .replace(/[′′‵]/g, "'")
          .replace(/[""]/g, '"')
          .replace(/['']/g, "'");
        
        let extractedSizeId = "";
        
        // Try dimensional sizes
        const dimMatch = normalizedTitle.match(/(\d+)[""']?\s*[xX×]\s*(\d+)[""']?/);
        if (dimMatch) {
          const width = parseInt(dimMatch[1]);
          const height = parseInt(dimMatch[2]);
          extractedSizeId = `${width}x${height}`;
          const sizeName = `${width}" x ${height}"`;
          if (!sizesMap.has(extractedSizeId)) {
            sizesMap.set(extractedSizeId, { id: extractedSizeId, name: sizeName, width, height });
          }
        }
        
        // Check options for size
        if (!extractedSizeId && (options.size || options.Size)) {
          const sizeVal = options.size || options.Size;
          extractedSizeId = sizeVal.toLowerCase().replace(/\s+/g, '_');
          if (!sizesMap.has(extractedSizeId)) {
            sizesMap.set(extractedSizeId, { id: extractedSizeId, name: sizeVal, width: 0, height: 0 });
          }
        }
        
        // Try title parts
        if (!extractedSizeId && title && title.includes("/")) {
          const parts = title.split("/").map((p: string) => p.trim());
          for (const part of parts) {
            const volumeMatch = part.match(/^(\d+)\s*oz$/i);
            if (volumeMatch) {
              extractedSizeId = `${volumeMatch[1]}oz`;
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: `${volumeMatch[1]}oz`, width: 0, height: 0 });
              }
              break;
            }
            if (apparelSizesLower.includes(part.toLowerCase())) {
              extractedSizeId = part.toLowerCase();
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: part, width: 0, height: 0 });
              }
              break;
            }
          }
        }
        
        // Extract color
        let colorName = "";
        if (options.color || options.colour || options.Color || options.Colour || options.frame_color) {
          colorName = options.color || options.colour || options.Color || options.Colour || options.frame_color;
        } else if (title.includes("/")) {
          const parts = title.split("/").map((p: string) => p.trim());
          for (let i = parts.length - 1; i >= 0; i--) {
            if (!looksLikeSize(parts[i])) {
              colorName = parts[i];
              break;
            }
          }
        }
        
        if (colorName && !colorsMap.has(colorName.toLowerCase())) {
          const colorId = colorName.toLowerCase().replace(/\s+/g, '_');
          // Comprehensive color hex lookup - Printify API doesn't provide hex codes
          const colorHexMap: Record<string, string> = {
            // Basic colors
            "black": "#1a1a1a", "white": "#f5f5f5", "red": "#C41E3A", "blue": "#2563EB",
            "navy": "#1B2838", "green": "#22C55E", "yellow": "#FACC15", "orange": "#F97316",
            "pink": "#EC4899", "purple": "#A855F7", "gray": "#9E9E9E", "grey": "#9E9E9E",
            "brown": "#795548", "beige": "#F5F5DC", "cream": "#FFFDD0", "tan": "#D2B48C",
            // Solid prefix variants
            "solid black": "#1a1a1a", "solid white": "#f5f5f5", "solid red": "#C41E3A",
            "solid blue": "#2563EB", "solid navy": "#1B2838", "solid green": "#22C55E",
            // Heather variants
            "heather grey": "#9CA3AF", "heather gray": "#9CA3AF", "dark heather": "#4B5563",
            "heather navy": "#374151", "heather blue": "#60A5FA", "heather red": "#F87171",
            "heather forest": "#166534", "heather purple": "#A855F7", "heather orange": "#FB923C",
            // Common apparel colors
            "arctic white": "#F8FAFC", "jet black": "#0a0a0a", "charcoal": "#36454F",
            "burgundy": "#800020", "maroon": "#800000", "cardinal red": "#C41E3A",
            "fire red": "#FF3131", "scarlet": "#FF2400", "coral": "#FF7F50",
            "hot pink": "#FF69B4", "baby pink": "#F4C2C2", "light pink": "#FFB6C1",
            "magenta": "#FF00FF", "fuchsia": "#FF00FF", "rose": "#FF007F",
            "sky blue": "#87CEEB", "light blue": "#ADD8E6", "royal blue": "#4169E1",
            "navy blue": "#000080", "cobalt": "#0047AB", "steel blue": "#4682B4",
            "oxford navy": "#1C2541", "indigo": "#4B0082",
            "kelly green": "#4CBB17", "forest green": "#228B22", "military green": "#4B5320",
            "olive": "#808000", "sage": "#9DC183", "mint": "#98FF98", "lime": "#32CD32",
            "bottle green": "#006A4E", "dark green": "#006400", "emerald": "#50C878",
            "gold": "#FFD700", "mustard": "#FFDB58", "lemon": "#FFF44F",
            "light yellow": "#FFFFE0", "sun yellow": "#FFE81F", "canary": "#FFEF00",
            "orange crush": "#FF6600", "burnt orange": "#CC5500", "peach": "#FFCBA4",
            "rust": "#B7410E", "terracotta": "#E2725B", "pumpkin": "#FF7518",
            "lavender": "#E6E6FA", "violet": "#EE82EE", "plum": "#DDA0DD",
            "lilac": "#C8A2C8", "grape": "#6F2DA8", "eggplant": "#614051",
            "hot chocolate": "#4A2C2A", "chocolate": "#7B3F00", "coffee": "#6F4E37",
            "mocha": "#967969", "espresso": "#4E312D", "walnut": "#773F1A",
            "sand": "#C2B280", "khaki": "#C3B091", "taupe": "#483C32",
            "camel": "#C19A6B", "nude": "#E3BC9A", "champagne": "#F7E7CE",
            "silver": "#C0C0C0", "ash": "#B2BEB5", "slate": "#708090",
            "steel grey": "#71797E", "gunmetal": "#2A3439", "anthracite": "#293133",
            "teal": "#008080", "cyan": "#00FFFF", "aqua": "#00FFFF",
            "turquoise": "#40E0D0", "seafoam": "#93E9BE",
            "ivory": "#FFFFF0", "pearl": "#FDEEF4", "natural": "#FAF0E6",
            "oatmeal": "#D5C4A1", "ecru": "#C2B280",
            // Sport specific
            "athletic heather": "#B8B8B8", "sport grey": "#9E9E9E",
            "dark grey heather": "#4B4B4B", "ice grey": "#D3D3D3",
            "vintage black": "#2B2B2B", "vintage navy": "#2C3E50",
            "washed black": "#3D3D3D", "stonewash blue": "#5DADE2"
          };
          // Try exact match first, then try partial matches
          let hex = colorHexMap[colorName.toLowerCase()];
          if (!hex) {
            // Try to find a partial match (e.g., "Solid Cream" matches "cream")
            const lowerName = colorName.toLowerCase();
            for (const [key, value] of Object.entries(colorHexMap)) {
              if (lowerName.includes(key) || key.includes(lowerName)) {
                hex = value;
                break;
              }
            }
          }
          hex = hex || "#888888";
          colorsMap.set(colorName.toLowerCase(), { id: colorId, name: colorName, hex });
        }
      }

      res.json({
        sizes: Array.from(sizesMap.values()),
        colors: Array.from(colorsMap.values())
      });
    } catch (error) {
      console.error("Error fetching variant options:", error);
      res.status(500).json({ error: "Failed to fetch variant options" });
    }
  });

  // Update variant selection for a product type
  app.patch("/api/admin/product-types/:id/variants", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const productTypeId = parseInt(req.params.id);
      const { selectedSizeIds, selectedColorIds } = req.body;
      
      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const productType = await storage.getProductType(productTypeId);
      if (!productType) {
        return res.status(404).json({ error: "Product type not found" });
      }

      // Verify merchant ownership
      if (productType.merchantId && productType.merchantId !== merchant.id) {
        return res.status(403).json({ error: "Not authorized to modify this product" });
      }

      // Validate variant count
      const sizeCount = Array.isArray(selectedSizeIds) ? selectedSizeIds.length : 0;
      const colorCount = Array.isArray(selectedColorIds) ? selectedColorIds.length : 0;
      const totalVariants = sizeCount * (colorCount || 1);
      
      if (totalVariants > 100) {
        return res.status(400).json({ 
          error: "Too many variants",
          details: `Selected options would create ${totalVariants} variants. Maximum is 100.`
        });
      }

      const updated = await storage.updateProductType(productTypeId, {
        selectedSizeIds: JSON.stringify(selectedSizeIds || []),
        selectedColorIds: JSON.stringify(selectedColorIds || []),
      });

      res.json(updated);
    } catch (error) {
      console.error("Error updating variant selection:", error);
      res.status(500).json({ error: "Failed to update variant selection" });
    }
  });

  // Import a Printify blueprint as a product type
  app.post("/api/admin/printify/import", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { blueprintId, name, description, selectedSizeIds, selectedColorIds } = req.body;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      if (!merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      if (!blueprintId || !name) {
        return res.status(400).json({ error: "Blueprint ID and name are required" });
      }

      // Check if this blueprint is already imported
      const existingTypes = await storage.getProductTypes();
      const alreadyImported = existingTypes.find(pt => pt.printifyBlueprintId === parseInt(blueprintId));
      if (alreadyImported) {
        return res.status(400).json({ 
          error: "Blueprint already imported",
          existingProductType: alreadyImported
        });
      }

      // Fetch print providers for this blueprint with retry logic
      const providersResponse = await fetchWithRetry(
        `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers.json`,
        {
          headers: {
            "Authorization": `Bearer ${merchant.printifyApiToken}`,
            "Content-Type": "application/json"
          }
        },
        3,
        1500
      );

      if (!providersResponse.ok) {
        throw new Error(`Failed to fetch providers: ${providersResponse.status}`);
      }

      const providers = await providersResponse.json();
      if (!providers || providers.length === 0) {
        return res.status(400).json({ error: "No print providers available for this blueprint" });
      }

      // Use provided provider ID or default to first provider
      const providerId = req.body.providerId || providers[0].id;

      // Fetch blueprint details to get color hex codes from options
      const blueprintResponse = await fetchWithRetry(
        `https://api.printify.com/v1/catalog/blueprints/${blueprintId}.json`,
        {
          headers: {
            "Authorization": `Bearer ${merchant.printifyApiToken}`,
            "Content-Type": "application/json"
          }
        },
        3,
        1500
      );

      let blueprintColors: Record<string, string> = {}; // colorName -> hex
      if (blueprintResponse.ok) {
        const blueprintData = await blueprintResponse.json();
        // Extract colors from blueprint options if available
        const colorOptions = blueprintData.options?.find((opt: any) => 
          opt.type === 'color' || opt.name?.toLowerCase() === 'color' || opt.name?.toLowerCase() === 'colors'
        );
        if (colorOptions?.values) {
          for (const colorVal of colorOptions.values) {
            const colorName = (colorVal.title || colorVal.name || '').toLowerCase();
            // Prefer colors array with hex, or hex_code field, or try to extract from value
            if (colorVal.colors && colorVal.colors.length > 0) {
              blueprintColors[colorName] = colorVal.colors[0];
            } else if (colorVal.hex_code) {
              blueprintColors[colorName] = colorVal.hex_code;
            } else if (colorVal.value && colorVal.value.startsWith('#')) {
              blueprintColors[colorName] = colorVal.value;
            }
          }
        }
        console.log(`Extracted ${Object.keys(blueprintColors).length} colors from blueprint options:`, Object.keys(blueprintColors).slice(0, 5).join(', '), '...');
      } else {
        console.log(`Blueprint options API - color extraction: no color options found or options missing`);
      }

      // Fetch variants for this provider with retry logic
      const variantsResponse = await fetchWithRetry(
        `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json`,
        {
          headers: {
            "Authorization": `Bearer ${merchant.printifyApiToken}`,
            "Content-Type": "application/json"
          }
        },
        3,
        1500
      );

      if (!variantsResponse.ok) {
        throw new Error(`Failed to fetch variants: ${variantsResponse.status}`);
      }

      const variantsData = await variantsResponse.json();
      const variants = variantsData.variants || variantsData || [];

      // Parse variants to extract sizes and colors
      // Sizes are purely catalog metadata - variant info goes in variantMap
      const sizesMap = new Map<string, { id: string; name: string; width: number; height: number }>();
      const colorsMap = new Map<string, { id: string; name: string; hex: string }>();
      // Map of "sizeId:colorId" -> printifyVariantId for accurate mockup generation
      const variantMap: Record<string, { printifyVariantId: number; providerId: number }> = {};
      let maxWidth = 0;
      let maxHeight = 0;

      // Known size patterns for various product types
      const apparelSizes = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "XXL", "XXXL"];
      const apparelSizesLower = apparelSizes.map(s => s.toLowerCase());
      const namedSizes = ["small", "medium", "large", "extra large", "king", "queen", "twin", "full", "one size"];
      
      // Helper function to check if a string looks like a size (not a color)
      const looksLikeSize = (str: string): boolean => {
        const lower = str.toLowerCase().trim();
        // Dimensional (8x10, 12"x16")
        if (lower.match(/^\d+[""']?\s*[xX×]\s*\d+[""']?$/)) return true;
        // Apparel sizes (S, M, L, XL, 2XL)
        if (apparelSizesLower.includes(lower)) return true;
        // Named sizes (Small, Medium, Large, King, Queen)
        if (namedSizes.includes(lower)) return true;
        // Volume sizes (11oz, 15 oz)
        if (lower.match(/^\d+\s*oz$/i)) return true;
        // Device models - must have model identifier after brand
        // Don't match just "Galaxy" as it could be a color name like "Galaxy Blue"
        // iPhone: iPhone 14, iPhone X, iPhone XS, iPhone SE, iPhone Pro Max, etc.
        if (lower.match(/^iphone\s+(\d|x|xs|xr|se|pro|plus|max)/i)) return true;
        // Galaxy: Galaxy S23, Galaxy A54, Galaxy Note, Galaxy Z Fold/Flip, etc.
        if (lower.match(/^galaxy\s+(s\d|a\d|note|z\s*(fold|flip)|ultra)/i)) return true;
        // Pixel: Pixel 7, Pixel Fold, Pixel Pro, etc.
        if (lower.match(/^pixel\s+(\d|fold|pro)/i)) return true;
        // Samsung with model identifiers
        if (lower.match(/^samsung\s+(galaxy|note)/i)) return true;
        // OnePlus with model numbers
        if (lower.match(/^oneplus\s+\d/i)) return true;
        // Generic "for iPhone/Galaxy/etc" patterns often seen in case listings
        if (lower.match(/^for\s+(iphone|galaxy|pixel|samsung)/i)) return true;
        // Youth/Kids sizes
        if (lower.match(/^(youth|kid'?s?|toddler|infant|baby)\s/i)) return true;
        // Size with numbers (14x14, 50x60, etc for blankets/pillows)
        if (lower.match(/^\d+\s*["'']?\s*[xX×]\s*\d+/)) return true;
        return false;
      };
      
      for (const variant of variants) {
        const title = variant.title || "";
        const options = variant.options || {};
        
        // Normalize Unicode quotes/primes to standard characters
        const normalizedTitle = title
          .replace(/[″″‶‴]/g, '"')
          .replace(/[′′‵]/g, "'")
          .replace(/[""]/g, '"')
          .replace(/['']/g, "'");
        
        // Track the extracted sizeId for this variant (used for variantMap)
        let extractedSizeId = "";
        
        // 1. Try dimensional sizes (8x10, 12"x16", etc.) for prints, pillows, blankets
        const dimMatch = normalizedTitle.match(/(\d+)[""']?\s*[xX×]\s*(\d+)[""']?/);
        if (dimMatch) {
          const width = parseInt(dimMatch[1]);
          const height = parseInt(dimMatch[2]);
          extractedSizeId = `${width}x${height}`;
          const sizeName = `${width}" x ${height}"`;
          
          // Sizes are purely catalog metadata - no variant-specific fields
          if (!sizesMap.has(extractedSizeId)) {
            sizesMap.set(extractedSizeId, { id: extractedSizeId, name: sizeName, width, height });
          }
          if (width > maxWidth) maxWidth = width;
          if (height > maxHeight) maxHeight = height;
        }
        
        // 2. Check options for size (normalize various key names)
        if (!extractedSizeId && (options.size || options.Size)) {
          const sizeVal = options.size || options.Size;
          extractedSizeId = sizeVal.toLowerCase().replace(/\s+/g, '_');
          if (!sizesMap.has(extractedSizeId)) {
            sizesMap.set(extractedSizeId, { id: extractedSizeId, name: sizeVal, width: 0, height: 0 });
          }
        }
        
        // 3. Try to extract from title for other patterns
        if (!extractedSizeId && title) {
          const parts = title.split("/").map((p: string) => p.trim());
          
          for (const part of parts) {
            // Check for volume sizes (11oz, 15oz for mugs)
            const volumeMatch = part.match(/^(\d+)\s*oz$/i);
            if (volumeMatch) {
              extractedSizeId = `${volumeMatch[1]}oz`;
              const sizeName = `${volumeMatch[1]}oz`;
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: sizeName, width: 0, height: 0 });
              }
              break;
            }
            
            // Check apparel sizes (S, M, L, XL, 2XL, etc.)
            if (apparelSizesLower.includes(part.toLowerCase())) {
              extractedSizeId = part.toLowerCase();
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: part, width: 0, height: 0 });
              }
              break;
            }
            
            // Check named sizes (Small, Medium, Large, King, Queen)
            if (namedSizes.includes(part.toLowerCase())) {
              extractedSizeId = part.toLowerCase().replace(/\s+/g, '_');
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: part, width: 0, height: 0 });
              }
              break;
            }
            
            // Check youth/kids sizes
            if (part.match(/^(youth|kid'?s?|toddler|infant|baby)\s/i)) {
              extractedSizeId = part.toLowerCase().replace(/\s+/g, '_').replace(/'/g, '');
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: part, width: 0, height: 0 });
              }
              break;
            }
            
            // Check device models (iPhone 14, Galaxy S23, etc. for phone cases)
            // Must have model identifier to avoid matching colors like "Galaxy Blue"
            if (part.match(/^iphone\s+(\d|x|xs|xr|se|pro|plus|max)/i) || 
                part.match(/^galaxy\s+(s\d|a\d|note|z\s*(fold|flip)|ultra)/i) || 
                part.match(/^pixel\s+(\d|fold|pro)/i) ||
                part.match(/^samsung\s+(galaxy|note)/i) ||
                part.match(/^oneplus\s+\d/i) ||
                part.match(/^for\s+(iphone|galaxy|pixel|samsung)/i)) {
              extractedSizeId = part.toLowerCase().replace(/\s+/g, '_');
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: part, width: 0, height: 0 });
              }
              break;
            }
          }
        }
        
        // 4. Fallback: If still no size and title has parts, use first non-color part
        if (!extractedSizeId && title && title.includes("/")) {
          const parts = title.split("/").map((p: string) => p.trim());
          // Take the first part as size if it's not obviously a color
          const firstPart = parts[0];
          if (firstPart && !firstPart.match(/^(black|white|red|blue|green|yellow|pink|purple|orange|gray|grey|navy|brown|beige|cream|tan)/i)) {
            extractedSizeId = firstPart.toLowerCase().replace(/\s+/g, '_');
            if (!sizesMap.has(extractedSizeId)) {
              sizesMap.set(extractedSizeId, { id: extractedSizeId, name: firstPart, width: 0, height: 0 });
            }
          }
        }

        // Try to extract color from title (after the "/" or from options)
        let colorName = "";
        // First check options object (normalize various color option names)
        if (options.color) {
          colorName = options.color;
        } else if (options.colour) {
          colorName = options.colour;
        } else if (options.frame_color) {
          colorName = options.frame_color;
        } else if (options.Color) {
          colorName = options.Color;
        } else if (options.Colour) {
          colorName = options.Colour;
        } else if (title.includes("/")) {
          // For titles like "S / Black" or "8x10 / White", color is usually after last "/"
          const parts = title.split("/").map((p: string) => p.trim());
          // Find the last part that looks like a color (not a size)
          for (let i = parts.length - 1; i >= 0; i--) {
            const part = parts[i];
            // Skip if it looks like a size (using comprehensive check)
            if (looksLikeSize(part)) {
              continue;
            }
            colorName = part;
            break;
          }
        }

        // Extract color and track the extractedColorId for this variant
        let extractedColorId = "";
        if (colorName) {
          extractedColorId = colorName.toLowerCase().replace(/\s+/g, '_');
          
          if (!colorsMap.has(colorName.toLowerCase())) {
            // Map common color names to hex values (frames + apparel)
            // Normalize "Solid X" pattern by extracting base color name
            const baseColorName = colorName.toLowerCase()
              .replace(/^solid\s+/i, '')
              .replace(/^heather\s+/i, 'heather ')
              .trim();
            
            const colorHexMap: Record<string, string> = {
              // Basic colors
              "black": "#1a1a1a", "white": "#f5f5f5", "red": "#C41E3A", "blue": "#2563EB",
              "navy": "#1B2838", "green": "#22C55E", "yellow": "#FACC15", "orange": "#F97316",
              "pink": "#EC4899", "purple": "#A855F7", "gray": "#9E9E9E", "grey": "#9E9E9E",
              "brown": "#795548", "beige": "#F5F5DC", "cream": "#FFFDD0", "tan": "#D2B48C",
              // Frame colors
              "walnut": "#5D4037", "natural": "#D7CCC8", "gold": "#FFD700", "silver": "#C0C0C0",
              "oak": "#C4A35A", "cherry": "#9B2335", "mahogany": "#4E2728", "espresso": "#3C2415",
              // Heather variants
              "heather grey": "#9CA3AF", "heather gray": "#9CA3AF", "dark heather": "#4B5563",
              "heather navy": "#374151", "heather blue": "#60A5FA", "heather red": "#F87171",
              "heather forest": "#166534", "heather purple": "#A855F7", "heather orange": "#FB923C",
              // Common apparel colors
              "arctic white": "#F8FAFC", "jet black": "#0a0a0a", "charcoal": "#36454F",
              "burgundy": "#800020", "maroon": "#800000", "cardinal red": "#C41E3A",
              "fire red": "#FF3131", "scarlet": "#FF2400", "coral": "#FF7F50",
              "hot pink": "#FF69B4", "baby pink": "#F4C2C2", "light pink": "#FFB6C1",
              "magenta": "#FF00FF", "fuchsia": "#FF00FF", "rose": "#FF007F",
              "sky blue": "#87CEEB", "light blue": "#ADD8E6", "royal blue": "#4169E1",
              "royal": "#4169E1", "navy blue": "#000080", "cobalt": "#0047AB", "steel blue": "#4682B4",
              "oxford navy": "#1C2541", "indigo": "#4B0082", "midnight navy": "#191970",
              "cool blue": "#4A90D9", "tahiti blue": "#3AB09E",
              "kelly green": "#4CBB17", "forest green": "#228B22", "military green": "#4B5320",
              "olive": "#808000", "sage": "#9DC183", "mint": "#98FF98", "lime": "#32CD32",
              "bottle green": "#006A4E", "dark green": "#006400", "emerald": "#50C878",
              "mustard": "#FFDB58", "lemon": "#FFF44F", "banana cream": "#FFE9A1",
              "light yellow": "#FFFFE0", "sun yellow": "#FFE81F", "canary": "#FFEF00",
              "orange crush": "#FF6600", "burnt orange": "#CC5500", "peach": "#FFCBA4",
              "rust": "#B7410E", "terracotta": "#E2725B", "pumpkin": "#FF7518",
              "lavender": "#E6E6FA", "violet": "#EE82EE", "plum": "#DDA0DD",
              "lilac": "#C8A2C8", "grape": "#6F2DA8", "eggplant": "#614051", "purple rush": "#9B59B6",
              "hot chocolate": "#4A2C2A", "chocolate": "#7B3F00", "coffee": "#6F4E37",
              "mocha": "#967969", "dark chocolate": "#3D2314",
              "sand": "#C2B280", "khaki": "#C3B091", "taupe": "#483C32",
              "camel": "#C19A6B", "nude": "#E3BC9A", "champagne": "#F7E7CE", "desert pink": "#EDC9AF",
              "ash": "#B2BEB5", "slate": "#708090",
              "steel grey": "#71797E", "gunmetal": "#2A3439", "anthracite": "#293133",
              "light grey": "#D3D3D3", "light gray": "#D3D3D3", "heavy metal": "#3D3D3D",
              "teal": "#008080", "cyan": "#00FFFF", "aqua": "#00FFFF",
              "turquoise": "#40E0D0", "seafoam": "#93E9BE",
              "ivory": "#FFFFF0", "pearl": "#FDEEF4", "oatmeal": "#D5C4A1", "ecru": "#C2B280",
              // Sport specific
              "athletic heather": "#B8B8B8", "sport grey": "#9E9E9E",
              "dark grey heather": "#4B4B4B", "ice grey": "#D3D3D3",
              "vintage black": "#2B2B2B", "vintage navy": "#2C3E50",
              "washed black": "#3D3D3D", "stonewash blue": "#5DADE2"
            };
            
            // Priority: 1) Blueprint API colors, 2) Fallback hex map (normalized), 3) Fallback hex map (full name), 4) Gray default
            let hex = blueprintColors[colorName.toLowerCase()];
            let source = "blueprint";
            if (!hex) {
              hex = colorHexMap[baseColorName];
              source = "normalized";
            }
            if (!hex) {
              hex = colorHexMap[colorName.toLowerCase()];
              source = "full";
            }
            if (!hex) {
              hex = "#888888";
              source = "fallback";
              console.log(`Color not found in map: "${colorName}" (normalized: "${baseColorName}")`);
            }
            colorsMap.set(colorName.toLowerCase(), { 
              id: extractedColorId, 
              name: colorName, 
              hex 
            });
          }
        }

        // Store the size+color -> variant mapping for mockup generation
        // Use the extractedSizeId and extractedColorId captured during this iteration
        // Only add to variantMap if we have at least a size or color - no fallback keys
        if (extractedSizeId || extractedColorId) {
          const mapKey = `${extractedSizeId || 'default'}:${extractedColorId || 'default'}`;
          variantMap[mapKey] = { printifyVariantId: variant.id, providerId };
        } else {
          // Neither size nor color could be extracted - skip this variant for mockup generation
          // This ensures we never send the wrong variant to Printify
          console.warn(`Skipping variant for mockup mapping - could not extract size or color: ${title} (id: ${variant.id})`);
        }
      }

      // Convert maps to arrays
      const sizes = Array.from(sizesMap.values());
      const frameColors = Array.from(colorsMap.values());

      // Fetch base mockup images (placeholder images) from the first variant
      // This gives us product preview images before any design is applied
      let baseMockupImages: { front?: string; lifestyle?: string; variantImages?: Record<string, string> } = {};
      const firstVariant = variants[0];
      if (firstVariant?.id) {
        try {
          // Fetch variant placeholder images from Printify
          const placeholderResponse = await fetchWithRetry(
            `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants/${firstVariant.id}/placeholders.json`,
            {
              headers: {
                "Authorization": `Bearer ${merchant.printifyApiToken}`,
                "Content-Type": "application/json"
              }
            },
            2,
            1000
          );
          
          if (placeholderResponse.ok) {
            const placeholderData = await placeholderResponse.json();
            console.log(`Placeholder API response for blueprint ${blueprintId}, variant ${firstVariant.id}:`, JSON.stringify(placeholderData).slice(0, 500));
            
            const placeholders = placeholderData.placeholders || placeholderData || [];
            
            // Find front and lifestyle images
            for (const placeholder of placeholders) {
              const position = (placeholder.position || "").toLowerCase();
              const images = placeholder.images || [];
              
              if (images.length > 0) {
                const imgUrl = images[0].src || images[0].url;
                if (position === "front" || position.includes("front")) {
                  baseMockupImages.front = imgUrl;
                } else if (position === "lifestyle" || position.includes("lifestyle")) {
                  baseMockupImages.lifestyle = imgUrl;
                } else if (!baseMockupImages.front) {
                  // Use first available position as front if no explicit front
                  baseMockupImages.front = imgUrl;
                }
              }
            }
            console.log(`Fetched base mockup images for blueprint ${blueprintId}:`, Object.keys(baseMockupImages));
          } else {
            console.warn(`Placeholder API returned ${placeholderResponse.status} for blueprint ${blueprintId}`);
          }
        } catch (e) {
          console.warn("Could not fetch base mockup placeholders:", e);
        }
      }

      // Detect product type FIRST to determine sizeType
      // This is more reliable than checking dimensions since some dimensional products
      // may not have dimensions in the variant data
      const lowerName = name.toLowerCase();
      const lowerDesc = (description || "").toLowerCase();
      const combined = `${lowerName} ${lowerDesc}`;
      
      // Helper function for word boundary matching (prevents "bra" matching "bracelet")
      const matchesWord = (text: string, word: string): boolean => {
        const regex = new RegExp(`\\b${word}\\b`, 'i');
        return regex.test(text);
      };
      
      // Apparel-like products use label sizes (S/M/L/XL)
      const apparelKeywords = [
        "shirt", "t-shirt", "tshirt", "hoodie", "sweatshirt", "tank top",
        "tee", "apparel", "jersey", "jacket", "leggings", "shorts", 
        "dress", "skirt", "polo", "onesie", "bodysuit", "sweater", 
        "pants", "joggers", "romper", "blouse", "cardigan", "vest", 
        "coat", "bikini", "swimsuit", "underwear", "boxers", "briefs", 
        "socks", "apron", "scrubs"
      ];
      const isApparelProduct = apparelKeywords.some(kw => matchesWord(combined, kw));
      
      // Known dimensional products that may not have dimension data in variants
      const dimensionalKeywords = [
        "pillow", "cushion", "blanket", "throw", "mug", "cup", "tumbler",
        "poster", "print", "canvas", "frame", "artwork", "wall art",
        "phone case", "iphone", "samsung", "bag", "tote", "backpack", 
        "towel", "mat", "rug", "coaster", "mousepad", "sticker", "magnet",
        "puzzle", "ornament", "clock"
      ];
      const isDimensionalProduct = dimensionalKeywords.some(kw => matchesWord(combined, kw));
      
      // Check if we have dimensional sizes as backup
      const hasDimensionalSizes = sizes.some(s => s.width > 0 && s.height > 0);
      
      // Determine sizeType:
      // 1. Apparel always uses labels
      // 2. Known dimensional products use dimensional (even without parsed dimensions)
      // 3. Products with parsed dimensions use dimensional
      // 4. Unknown products without dimensions default to label
      let sizeType: string;
      if (isApparelProduct) {
        sizeType = "label";
      } else if (isDimensionalProduct || hasDimensionalSizes) {
        sizeType = "dimensional";
      } else {
        sizeType = "label";
      }

      // Determine aspect ratio using GCD for accurate ratio
      const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
      
      // Detect phone cases for special aspect ratio handling
      const isPhoneCase = combined.includes("phone") || combined.includes("iphone") || 
                          combined.includes("samsung") || combined.includes("case");
      
      // Start with product-type-appropriate defaults
      let aspectRatio: string;
      if (isApparelProduct) {
        // Apparel print areas are typically portrait ~2:3
        aspectRatio = "2:3";
      } else if (isPhoneCase) {
        // Phone cases are tall portrait ~9:16
        aspectRatio = "9:16";
      } else {
        // Default for other products
        aspectRatio = "3:4";
      }
      
      // Override with calculated dimensions if available
      if (hasDimensionalSizes && sizes.length > 0) {
        const firstDimensionalSize = sizes.find(s => s.width > 0 && s.height > 0);
        if (firstDimensionalSize) {
          const w = firstDimensionalSize.width;
          const h = firstDimensionalSize.height;
          const divisor = gcd(w, h);
          const simplifiedW = w / divisor;
          const simplifiedH = h / divisor;
          aspectRatio = `${simplifiedW}:${simplifiedH}`;
        }
      }

      // Product type detection for designer type, shape, and bleed margin
      // IMPORTANT: Check apparel FIRST because descriptions often contain "print" (e.g. "print surface")
      // which would incorrectly match framed-print if checked first
      
      let designerType: string = "generic";
      let printShape: string = "rectangle";
      let bleedMarginPercent = 5;
      
      // Detect apparel FIRST (before framed-print check)
      if (isApparelProduct) {
        designerType = "apparel";
        printShape = "rectangle";
        bleedMarginPercent = 5;
      }
      // Detect pillows
      else if (combined.includes("pillow") || combined.includes("cushion")) {
        designerType = "pillow";
        if (combined.includes("round") || combined.includes("circle") || combined.includes("circular")) {
          printShape = "circle";
          bleedMarginPercent = 8;
        } else if (maxWidth === maxHeight && maxWidth > 0) {
          printShape = "square";
          bleedMarginPercent = 5;
        } else {
          printShape = "rectangle";
          bleedMarginPercent = 5;
        }
      }
      // Detect blankets
      else if (combined.includes("blanket") || combined.includes("throw")) {
        designerType = "pillow";
        printShape = "rectangle";
        bleedMarginPercent = 5;
      }
      // Detect mugs
      else if (combined.includes("mug") || combined.includes("cup") || combined.includes("tumbler")) {
        designerType = "mug";
        printShape = "rectangle";
        bleedMarginPercent = 3;
      }
      // Detect framed prints AFTER apparel (to avoid false positives from "print surface" in descriptions)
      else if (combined.includes("frame") || combined.includes("poster") || combined.includes("canvas") || 
               matchesWord(combined, "print") || combined.includes("wall art")) {
        designerType = "framed-print";
        printShape = "rectangle";
        bleedMarginPercent = 3;
      }
      // Detect round products
      else if (combined.includes("round") || combined.includes("circle") || combined.includes("coaster")) {
        printShape = "circle";
        bleedMarginPercent = 8;
      }

      // Detect double-sided print from description
      const doubleSidedPrint = combined.includes("double sided") || 
                               combined.includes("double-sided") || 
                               combined.includes("two sided") ||
                               combined.includes("two-sided") ||
                               combined.includes("both sides");

      // Create the product type with parsed data
      const productType = await storage.createProductType({
        merchantId: merchant.id,
        name,
        description: description || null,
        printifyBlueprintId: parseInt(blueprintId),
        printifyProviderId: providerId,
        sizes: JSON.stringify(sizes),
        frameColors: JSON.stringify(frameColors),
        variantMap: JSON.stringify(variantMap),
        selectedSizeIds: JSON.stringify(selectedSizeIds || sizes.map((s: { id: string }) => s.id)),
        selectedColorIds: JSON.stringify(selectedColorIds || frameColors.map((c: { id: string }) => c.id)),
        aspectRatio,
        printShape,
        printAreaWidth: maxWidth || null,
        printAreaHeight: maxHeight || null,
        bleedMarginPercent,
        designerType,
        sizeType,
        hasPrintifyMockups: true,
        baseMockupImages: JSON.stringify(baseMockupImages),
        primaryMockupIndex: 0,
        doubleSidedPrint,
        isActive: true,
        sortOrder: existingTypes.length,
      });

      res.json(productType);
    } catch (error) {
      console.error("Error importing Printify blueprint:", error);
      res.status(500).json({ error: "Failed to import blueprint" });
    }
  });

  // DELETE /api/admin/product-types/:id - Delete a product type
  app.delete("/api/admin/product-types/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const productTypeId = parseInt(req.params.id);

      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const productType = await storage.getProductType(productTypeId);
      if (!productType || productType.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Product type not found" });
      }

      await storage.deleteProductType(productTypeId);
      res.json({ success: true, message: "Product type deleted" });
    } catch (error) {
      console.error("Error deleting product type:", error);
      res.status(500).json({ error: "Failed to delete product type" });
    }
  });

  // POST /api/admin/product-types/:id/refresh-images - Refresh product images from Printify
  app.post("/api/admin/product-types/:id/refresh-images", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const productTypeId = parseInt(req.params.id);

      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      if (!merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      const productType = await storage.getProductType(productTypeId);
      if (!productType || productType.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Product type not found" });
      }

      if (!productType.printifyBlueprintId || !productType.printifyProviderId) {
        return res.status(400).json({ error: "Product type is not linked to Printify" });
      }

      // Helper to extract URL from image entry (handles both string and object formats)
      const extractImageUrl = (img: any): string | undefined => {
        if (typeof img === 'string') return img;
        if (img && typeof img === 'object') return img.src || img.url;
        return undefined;
      };

      let baseMockupImages: { front?: string; lifestyle?: string } = {};

      // First, fetch blueprint details which contains product images
      const blueprintResponse = await fetch(
        `https://api.printify.com/v1/catalog/blueprints/${productType.printifyBlueprintId}.json`,
        {
          headers: {
            "Authorization": `Bearer ${merchant.printifyApiToken}`,
            "Content-Type": "application/json"
          }
        }
      );

      if (blueprintResponse.ok) {
        const blueprintData = await blueprintResponse.json();
        const images = blueprintData.images || [];
        
        // Blueprint images are product mockups - use first as front, second as lifestyle if available
        if (images.length > 0) {
          baseMockupImages.front = extractImageUrl(images[0]);
        }
        if (images.length > 1) {
          baseMockupImages.lifestyle = extractImageUrl(images[1]);
        }
      }

      // If no images from blueprint, try print provider specific endpoint
      if (!baseMockupImages.front) {
        const providerResponse = await fetch(
          `https://api.printify.com/v1/catalog/blueprints/${productType.printifyBlueprintId}/print_providers/${productType.printifyProviderId}.json`,
          {
            headers: {
              "Authorization": `Bearer ${merchant.printifyApiToken}`,
              "Content-Type": "application/json"
            }
          }
        );

        if (providerResponse.ok) {
          const providerData = await providerResponse.json();
          // Provider data may have location-specific images
          if (providerData.image) {
            baseMockupImages.front = extractImageUrl(providerData.image);
          }
        }
      }

      // Also fetch placeholder data for print-area/safe-zone information
      const variantsResponse = await fetch(
        `https://api.printify.com/v1/catalog/blueprints/${productType.printifyBlueprintId}/print_providers/${productType.printifyProviderId}/variants.json`,
        {
          headers: {
            "Authorization": `Bearer ${merchant.printifyApiToken}`,
            "Content-Type": "application/json"
          }
        }
      );

      if (variantsResponse.ok) {
        const variantsData = await variantsResponse.json();
        const variants = variantsData.variants || [];
        
        if (variants.length > 0) {
          const firstVariant = variants[0];
          const variantId = firstVariant.variant_id || firstVariant.id;
          
          if (variantId) {
            const placeholderResponse = await fetch(
              `https://api.printify.com/v1/catalog/blueprints/${productType.printifyBlueprintId}/print_providers/${productType.printifyProviderId}/variants/${variantId}/placeholders.json`,
              {
                headers: {
                  "Authorization": `Bearer ${merchant.printifyApiToken}`,
                  "Content-Type": "application/json"
                }
              }
            );

            if (placeholderResponse.ok) {
              const placeholderData = await placeholderResponse.json();
              const placeholders = placeholderData.placeholders || [];
              
              // Fallback: If no images from blueprint/provider, try to extract from placeholder images
              if (!baseMockupImages.front || !baseMockupImages.lifestyle) {
                for (const placeholder of placeholders) {
                  const position = placeholder.position?.toLowerCase() || "";
                  const images = placeholder.images || [];
                  
                  if (images.length > 0) {
                    const imgUrl = extractImageUrl(images[0]);
                    if (imgUrl) {
                      if (!baseMockupImages.front && (position === "front" || position.includes("front"))) {
                        baseMockupImages.front = imgUrl;
                      } else if (!baseMockupImages.lifestyle && (position === "lifestyle" || position.includes("lifestyle"))) {
                        baseMockupImages.lifestyle = imgUrl;
                      } else if (!baseMockupImages.front) {
                        // Use first available image as front if no specific position match yet
                        baseMockupImages.front = imgUrl;
                      } else if (!baseMockupImages.lifestyle) {
                        // Use subsequent image as lifestyle if front is already set
                        baseMockupImages.lifestyle = imgUrl;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      // Check if we found any images
      if (!baseMockupImages.front && !baseMockupImages.lifestyle) {
        return res.status(400).json({ 
          error: "No product images available from Printify for this blueprint",
          hint: "This product type may not have catalog images. You can add a custom mockup template URL instead."
        });
      }

      // Update the product type with new images
      const updated = await storage.updateProductType(productTypeId, {
        baseMockupImages: JSON.stringify(baseMockupImages)
      });

      res.json({ 
        success: true, 
        baseMockupImages,
        productType: updated 
      });
    } catch (error) {
      console.error("Error refreshing product images:", error);
      res.status(500).json({ error: "Failed to refresh images" });
    }
  });

  // POST /api/admin/product-types/:id/refresh-colors - Refresh color hex values using local lookup map
  // This only updates hex values - does NOT modify size/color selections
  // Note: Does NOT require Printify API token - uses local color lookup map
  app.post("/api/admin/product-types/:id/refresh-colors", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const productTypeId = parseInt(req.params.id);

      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const productType = await storage.getProductType(productTypeId);
      if (!productType || productType.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Product type not found" });
      }

      // Comprehensive color hex lookup - Printify API doesn't provide hex codes
      const colorHexMap: Record<string, string> = {
        // Basic colors
        "black": "#1a1a1a", "white": "#f5f5f5", "red": "#C41E3A", "blue": "#2563EB",
        "navy": "#1B2838", "green": "#22C55E", "yellow": "#FACC15", "orange": "#F97316",
        "pink": "#EC4899", "purple": "#A855F7", "gray": "#9E9E9E", "grey": "#9E9E9E",
        "brown": "#795548", "beige": "#F5F5DC", "cream": "#FFFDD0", "tan": "#D2B48C",
        // Frame colors
        "walnut": "#5D4037", "natural": "#D7CCC8", "gold": "#FFD700", "silver": "#C0C0C0",
        "oak": "#C4A35A", "cherry": "#9B2335", "mahogany": "#4E2728", "espresso": "#3C2415",
        // Heather variants
        "heather grey": "#9CA3AF", "heather gray": "#9CA3AF", "dark heather": "#4B5563",
        "heather navy": "#374151", "heather blue": "#60A5FA", "heather red": "#F87171",
        "heather forest": "#166534", "heather purple": "#A855F7", "heather orange": "#FB923C",
        // Common apparel colors
        "arctic white": "#F8FAFC", "jet black": "#0a0a0a", "charcoal": "#36454F",
        "burgundy": "#800020", "maroon": "#800000", "cardinal red": "#C41E3A",
        "fire red": "#FF3131", "scarlet": "#FF2400", "coral": "#FF7F50",
        "hot pink": "#FF69B4", "baby pink": "#F4C2C2", "light pink": "#FFB6C1",
        "magenta": "#FF00FF", "fuchsia": "#FF00FF", "rose": "#FF007F",
        "sky blue": "#87CEEB", "light blue": "#ADD8E6", "royal blue": "#4169E1",
        "royal": "#4169E1", "navy blue": "#000080", "cobalt": "#0047AB", "steel blue": "#4682B4",
        "oxford navy": "#1C2541", "indigo": "#4B0082", "midnight navy": "#191970",
        "cool blue": "#4A90D9", "tahiti blue": "#3AB09E",
        "kelly green": "#4CBB17", "forest green": "#228B22", "military green": "#4B5320",
        "olive": "#808000", "sage": "#9DC183", "mint": "#98FF98", "lime": "#32CD32",
        "bottle green": "#006A4E", "dark green": "#006400", "emerald": "#50C878",
        "mustard": "#FFDB58", "lemon": "#FFF44F", "banana cream": "#FFE9A1",
        "light yellow": "#FFFFE0", "sun yellow": "#FFE81F", "canary": "#FFEF00",
        "orange crush": "#FF6600", "burnt orange": "#CC5500", "peach": "#FFCBA4",
        "rust": "#B7410E", "terracotta": "#E2725B", "pumpkin": "#FF7518",
        "lavender": "#E6E6FA", "violet": "#EE82EE", "plum": "#DDA0DD",
        "lilac": "#C8A2C8", "grape": "#6F2DA8", "eggplant": "#614051", "purple rush": "#9B59B6",
        "hot chocolate": "#4A2C2A", "chocolate": "#7B3F00", "coffee": "#6F4E37",
        "mocha": "#967969", "dark chocolate": "#3D2314",
        "sand": "#C2B280", "khaki": "#C3B091", "taupe": "#483C32",
        "camel": "#C19A6B", "nude": "#E3BC9A", "champagne": "#F7E7CE", "desert pink": "#EDC9AF",
        "ash": "#B2BEB5", "slate": "#708090",
        "steel grey": "#71797E", "gunmetal": "#2A3439", "anthracite": "#293133",
        "light grey": "#D3D3D3", "light gray": "#D3D3D3", "heavy metal": "#3D3D3D",
        "teal": "#008080", "cyan": "#00FFFF", "aqua": "#00FFFF",
        "turquoise": "#40E0D0", "seafoam": "#93E9BE",
        "ivory": "#FFFFF0", "pearl": "#FDEEF4", "oatmeal": "#D5C4A1", "ecru": "#C2B280",
        // Sport specific
        "athletic heather": "#B8B8B8", "sport grey": "#9E9E9E",
        "dark grey heather": "#4B4B4B", "ice grey": "#D3D3D3",
        "vintage black": "#2B2B2B", "vintage navy": "#2C3E50",
        "washed black": "#3D3D3D", "stonewash blue": "#5DADE2"
      };

      // Get existing colors
      const existingColors: Array<{ id: string; name: string; hex: string }> = JSON.parse(productType.frameColors || "[]");
      
      // Update each color's hex value using the lookup map
      let updatedCount = 0;
      const updatedColors = existingColors.map(color => {
        const colorName = color.name.toLowerCase();
        const baseColorName = colorName
          .replace(/^solid\s+/i, '')
          .replace(/^heather\s+/i, 'heather ')
          .trim();
        
        // Try to find a matching hex: 1) exact match, 2) normalized match, 3) partial match
        let newHex = colorHexMap[colorName] || colorHexMap[baseColorName];
        
        // Partial matching if no exact match
        if (!newHex) {
          for (const [mapKey, mapHex] of Object.entries(colorHexMap)) {
            if (baseColorName.includes(mapKey) || mapKey.includes(baseColorName)) {
              newHex = mapHex;
              break;
            }
          }
        }
        
        if (newHex && newHex !== color.hex) {
          updatedCount++;
          return { ...color, hex: newHex };
        }
        return color;
      });

      // Update the product type
      const updated = await storage.updateProductType(productTypeId, {
        frameColors: JSON.stringify(updatedColors)
      });

      res.json({ 
        success: true, 
        message: `Updated ${updatedCount} color${updatedCount !== 1 ? 's' : ''} with new hex values`,
        updatedCount,
        frameColors: updatedColors,
        productType: updated 
      });
    } catch (error) {
      console.error("Error refreshing product colors:", error);
      res.status(500).json({ error: "Failed to refresh colors" });
    }
  });

  // GET /api/admin/printify/shops - Fetch available Printify shops using API token
  app.get("/api/admin/printify/shops", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      // Check if we have a Printify API token
      const apiToken = merchant.printifyApiToken;
      if (!apiToken) {
        return res.status(400).json({ 
          error: "Printify API token not configured",
          message: "Please save your Printify API token first, then try detecting your shop."
        });
      }

      // Call Printify API to list shops
      const response = await fetch("https://api.printify.com/v1/shops.json", {
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          return res.status(401).json({ 
            error: "Invalid API token",
            message: "Your Printify API token appears to be invalid. Please check it and try again."
          });
        }
        throw new Error(`Printify API error: ${response.status}`);
      }

      const responseData = await response.json();
      
      // Printify API returns shops directly as an array (not wrapped in {data:...})
      const shops = Array.isArray(responseData) ? responseData : (responseData.data || responseData || []);
      
      if (!Array.isArray(shops) || shops.length === 0) {
        return res.json({ 
          shops: [],
          message: "No shops found. You need to create a shop in Printify first.",
          instructions: [
            "1. Go to printify.com and log in",
            "2. Click 'Add new store' or go to 'My Stores'",
            "3. Choose 'Manual orders' or 'Other' as your platform",
            "4. Name your store and complete setup",
            "5. Come back here and click 'Detect Shop ID' again"
          ]
        });
      }

      // Return the list of shops
      res.json({ 
        shops: shops.map((shop: any) => ({
          id: shop.id,
          title: shop.title,
          sales_channel: shop.sales_channel
        })),
        message: shops.length === 1 
          ? "Found your shop! Click to use this Shop ID."
          : `Found ${shops.length} shops. Select the one you want to use.`
      });
    } catch (error) {
      console.error("Error fetching Printify shops:", error);
      res.status(500).json({ error: "Failed to fetch shops from Printify" });
    }
  });

  // POST /api/mockup/generate - Generate Printify mockup for a design
  app.post("/api/mockup/generate", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { productTypeId, designImageUrl, sizeId, colorId, scale, x, y } = req.body;

      if (!productTypeId || !designImageUrl) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      // Convert relative URLs to absolute URLs for Printify
      let absoluteImageUrl = designImageUrl;
      if (designImageUrl.startsWith("/objects/")) {
        // Get the host from request headers or use REPLIT_DEV_DOMAIN
        const host = req.get("host") || process.env.REPLIT_DEV_DOMAIN;
        const protocol = req.protocol || "https";
        absoluteImageUrl = `${protocol}://${host}${designImageUrl}`;
        console.log("Converting image URL for Printify:", absoluteImageUrl);
      }

      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const productType = await storage.getProductType(parseInt(productTypeId));
      if (!productType || productType.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Product type not found" });
      }

      // Check if we have Printify credentials and blueprint ID
      if (!merchant.printifyApiToken || !merchant.printifyShopId || !productType.printifyBlueprintId) {
        // Return fallback response with local template suggestion
        const { getLocalMockupTemplate } = await import("./printify-mockups.js");
        const localTemplate = getLocalMockupTemplate(productType.designerType || "pillow");
        
        return res.json({
          success: false,
          mockupUrls: [],
          source: "fallback",
          localTemplate,
          message: "Printify not configured, using local preview",
        });
      }

      // Generate Printify mockup
      const { generatePrintifyMockup } = await import("./printify-mockups.js");
      
      // Look up the correct variant from the variantMap using server-side data only
      const variantMapData = JSON.parse(productType.variantMap as string || "{}");
      const variantKey = `${sizeId || 'default'}:${colorId || 'default'}`;
      
      // Try exact match first, then fallback to partial matches, then any available variant
      const variantData = variantMapData[variantKey] || 
                          variantMapData[`${sizeId || 'default'}:default`] ||
                          variantMapData[`default:${colorId || 'default'}`] ||
                          variantMapData['default:default'] ||
                          Object.values(variantMapData)[0];
      
      if (!variantData || !variantData.printifyVariantId) {
        return res.status(400).json({ 
          error: "Could not resolve product variant for the selected options",
          availableKeys: Object.keys(variantMapData)
        });
      }
      
      const providerId = variantData.providerId || productType.printifyProviderId || 1;
      const targetVariantId = variantData.printifyVariantId;

      const result = await generatePrintifyMockup({
        blueprintId: productType.printifyBlueprintId,
        providerId,
        variantId: targetVariantId,
        imageUrl: absoluteImageUrl,
        printifyApiToken: merchant.printifyApiToken,
        printifyShopId: merchant.printifyShopId,
        scale: scale ? scale / 100 : 1, // Convert from percentage to 0-2 range
        x: x !== undefined ? (x - 50) / 50 : 0, // Convert from 0-100 to -1 to 1 range (0 = center)
        y: y !== undefined ? (y - 50) / 50 : 0, // Convert from 0-100 to -1 to 1 range (0 = center)
        doubleSided: productType.doubleSidedPrint || false, // Send to front and back for pillows, etc.
      });

      res.json(result);
    } catch (error) {
      console.error("Error generating mockup:", error);
      res.status(500).json({ error: "Failed to generate mockup" });
    }
  });

  return httpServer;
}
