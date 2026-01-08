import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import sharp from "sharp";
import { storage } from "./storage";
import { setupAuth, isAuthenticated, registerAuthRoutes } from "./replit_integrations/auth";
import { PRINT_SIZES, FRAME_COLORS, STYLE_PRESETS, type InsertDesign } from "@shared/schema";
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

async function saveImageToStorage(base64Data: string, mimeType: string): Promise<SaveImageResult> {
  const imageId = crypto.randomUUID();
  const extension = mimeType.includes("png") ? "png" : "jpg";
  const privateDir = objectStorage.getPrivateObjectDir();
  
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
  
  const buffer = Buffer.from(base64Data, "base64");
  const thumbnailBuffer = await generateThumbnail(buffer);
  
  const bucket = objectStorageClient.bucket(bucketName);
  
  // Save original image
  const file = bucket.file(objectName);
  await file.save(buffer, {
    contentType: mimeType,
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

      const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));

      const updateData: Partial<typeof design> = {
        transformScale: clamp(transformScale ?? design.transformScale ?? 100, 50, 200),
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

      const { prompt, stylePreset, size, frameColor, referenceImage, productTypeId } = req.body;

      if (!prompt || !size) {
        return res.status(400).json({ error: "Prompt and size are required" });
      }

      // Load product type if provided
      let productType = null;
      if (productTypeId) {
        productType = await storage.getProductType(parseInt(productTypeId));
      }

      // Find size config - check product type sizes first, then fall back to PRINT_SIZES
      let sizeConfig = PRINT_SIZES.find(s => s.id === size);
      
      if (!sizeConfig && productType) {
        // Try to find size in product type's sizes (for apparel, etc.)
        const productSizes = JSON.parse(productType.sizes || "[]");
        const productSize = productSizes.find((s: any) => s.id === size);
        if (productSize) {
          // Create a compatible size config from product type size
          sizeConfig = {
            id: productSize.id,
            name: productSize.name,
            width: productSize.width || 12,
            height: productSize.height || 16,
            aspectRatio: productType.aspectRatio || "1:1",
            genWidth: 1024,
            genHeight: 1024,
          } as any;
        }
      }
      
      if (!sizeConfig) {
        // Default fallback for unknown sizes
        sizeConfig = { id: size, name: size, width: 12, height: 16, aspectRatio: "1:1", genWidth: 1024, genHeight: 1024 } as any;
      }

      // Now sizeConfig is guaranteed to be defined
      const finalSizeConfig = sizeConfig!;
      const aspectRatioStr = (finalSizeConfig as any).aspectRatio || "1:1";

      // The frontend already incorporates style prompts, so we use the prompt as-is
      let fullPrompt = prompt;

      // CRITICAL: Hardcoded sizing and full-bleed requirements for ALL generations
      const sizingRequirements = `

MANDATORY IMAGE REQUIREMENTS - FOLLOW EXACTLY:
1. FULL-BLEED: The image MUST extend edge-to-edge, filling the ENTIRE canvas with NO margins, borders, frames, or empty space around the edges.
2. NO FLOATING: The subject must NOT appear to be floating or cropped. The artwork must have a complete background that extends to all edges.
3. NO PICTURE FRAMES: Do NOT include any decorative borders, picture frames, drop shadows, or vignettes around the image. The image will be printed and framed separately.
4. COMPOSITION: ${aspectRatioStr === "1:1" ? "Square 1:1 composition" : `Vertical portrait ${aspectRatioStr} composition`} - the artwork fills the entire canvas.
5. SAFE ZONE: Keep all important elements (text, faces, key subjects) within the central 75% of the image to ensure nothing is cut off when framed.
6. BACKGROUND: The background/scene must extend fully to all four edges of the image with NO visible canvas edges or cutoffs.
7. PRINT-READY: This is for high-quality wall art printing - create a complete, finished artwork that fills the entire image area.
`;

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
      
      // Save image to object storage instead of base64
      let generatedImageUrl: string;
      let thumbnailImageUrl: string | undefined;
      try {
        const result = await saveImageToStorage(imagePart.inlineData.data, mimeType);
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

  // Rate limiting for Shopify generation (per shop per hour)
  const shopifyGenerationRateLimits = new Map<string, { count: number; resetAt: number }>();
  const SHOPIFY_RATE_LIMIT = 100; // 100 generations per shop per hour
  const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
  
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
  // Security: Validates referer header matches shop domain, requires active installation
  app.post("/api/shopify/session", async (req: Request, res: Response) => {
    try {
      const { shop, productId, timestamp, customerId, customerEmail, customerName } = req.body;

      if (!shop) {
        return res.status(400).json({ error: "Shop domain required" });
      }

      // Validate shop domain format
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
        return res.status(400).json({ error: "Invalid shop domain format" });
      }

      // Verify referer header matches the claimed shop domain
      // This provides defense-in-depth since the iframe is loaded from Shopify
      const referer = req.headers.referer || req.headers.origin || "";
      const shopBaseUrl = shop.replace(".myshopify.com", "");
      const validRefererPatterns = [
        `https://${shop}`,
        `https://${shopBaseUrl}.myshopify.com`,
        new RegExp(`^https://${shopBaseUrl}[a-z0-9-]*\\.myshopify\\.com`),
      ];
      
      const isValidReferer = validRefererPatterns.some(pattern => {
        if (typeof pattern === "string") {
          return referer.startsWith(pattern);
        }
        return pattern.test(referer);
      });

      // In production, require valid referer. Allow bypass in development for testing
      const isDevelopment = process.env.NODE_ENV === "development";
      if (!isValidReferer && !isDevelopment) {
        console.warn(`Shopify session: Invalid referer ${referer} for shop ${shop}`);
        return res.status(403).json({ error: "Invalid request origin" });
      }

      // Verify shop is installed
      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }

      // Verify timestamp is recent (within 5 minutes)
      const now = Date.now();
      const requestTimestamp = parseInt(timestamp) || 0;
      if (Math.abs(now - requestTimestamp) > 5 * 60 * 1000) {
        return res.status(400).json({ error: "Request timestamp expired" });
      }

      // Generate session token with IP binding for additional security
      const clientIp = req.ip || req.headers["x-forwarded-for"] || "unknown";
      const sessionToken = crypto.randomBytes(32).toString("hex");
      
      // Create session data
      const sessionData: ShopifySession = {
        shop,
        expiresAt: now + SESSION_TOKEN_EXPIRY_MS,
        clientIp: typeof clientIp === "string" ? clientIp : clientIp[0],
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
      const { prompt, stylePreset, size, frameColor, referenceImage, shop, sessionToken } = req.body;

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

      // Load product type config if provided
      let productType = null;
      if (productTypeId) {
        productType = await storage.getProductType(parseInt(productTypeId));
      }

      // Find size config - use default if not matching internal sizes
      let sizeConfig = PRINT_SIZES.find(s => s.id === size);
      if (!sizeConfig) {
        // For Shopify generation, use a sensible default
        sizeConfig = PRINT_SIZES[0];
      }

      // The frontend already incorporates style prompts, so we use the prompt as-is
      let fullPrompt = prompt;

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
      
      // Save image to object storage instead of base64
      let imageUrl: string;
      let thumbnailUrl: string | undefined;
      try {
        const result = await saveImageToStorage(imagePart.inlineData.data, mimeType);
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

  // Import a Printify blueprint as a product type
  app.post("/api/admin/printify/import", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { blueprintId, name, description } = req.body;
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
              // Frame colors
              "black": "#1a1a1a",
              "white": "#f5f5f5",
              "walnut": "#5D4037",
              "natural": "#D7CCC8",
              "brown": "#795548",
              "gold": "#FFD700",
              "silver": "#C0C0C0",
              "oak": "#C4A35A",
              "cherry": "#9B2335",
              "mahogany": "#4E2728",
              "espresso": "#3C2415",
              "grey": "#9E9E9E",
              "gray": "#9E9E9E",
              // Basic apparel colors
              "navy": "#1B2838",
              "navy blue": "#1B2838",
              "midnight navy": "#191970",
              "red": "#C41E3A",
              "cardinal red": "#C41230",
              "blue": "#2563EB",
              "royal": "#4169E1",
              "royal blue": "#4169E1",
              "light blue": "#87CEEB",
              "cool blue": "#4A90D9",
              "tahiti blue": "#3AB09E",
              "green": "#22C55E",
              "forest green": "#228B22",
              "kelly green": "#4CBB17",
              "military green": "#4B5320",
              "olive": "#808000",
              "yellow": "#FACC15",
              "banana cream": "#FFE9A1",
              "orange": "#F97316",
              "pink": "#EC4899",
              "light pink": "#FFB6C1",
              "desert pink": "#EDC9AF",
              "purple": "#A855F7",
              "purple rush": "#9B59B6",
              "maroon": "#800000",
              "burgundy": "#800020",
              "charcoal": "#36454F",
              "heavy metal": "#3D3D3D",
              "heather grey": "#9CA3AF",
              "heather gray": "#9CA3AF",
              "light grey": "#D3D3D3",
              "light gray": "#D3D3D3",
              "dark chocolate": "#3D2314",
              "cream": "#FFFDD0",
              "beige": "#F5F5DC",
              "tan": "#D2B48C",
              "sand": "#C2B280",
              "khaki": "#C3B091",
              "indigo": "#4B0082",
              "turquoise": "#40E0D0",
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
      
      let aspectRatio = "1:1"; // Default for label-only or square products
      if (!isApparelProduct && hasDimensionalSizes && sizes.length > 0) {
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
        aspectRatio,
        printShape,
        printAreaWidth: maxWidth || null,
        printAreaHeight: maxHeight || null,
        bleedMarginPercent,
        designerType,
        sizeType,
        hasPrintifyMockups: true,
        baseMockupImages: JSON.stringify(baseMockupImages),
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
      const { productTypeId, designImageUrl, sizeId, colorId, scale } = req.body;

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
      });

      res.json(result);
    } catch (error) {
      console.error("Error generating mockup:", error);
      res.status(500).json({ error: "Failed to generate mockup" });
    }
  });

  return httpServer;
}
