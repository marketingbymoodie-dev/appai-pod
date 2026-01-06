import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import { storage } from "./storage";
import { setupAuth, isAuthenticated, registerAuthRoutes } from "./replit_integrations/auth";
import { PRINT_SIZES, FRAME_COLORS, STYLE_PRESETS, type InsertDesign } from "@shared/schema";
import { Modality } from "@google/genai";
import { ai } from "./replit_integrations/image/client";
import { registerShopifyRoutes } from "./shopify";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await setupAuth(app);
  registerAuthRoutes(app);
  registerShopifyRoutes(app);

  // Get product configuration
  app.get("/api/config", (_req: Request, res: Response) => {
    res.json({
      sizes: PRINT_SIZES,
      frameColors: FRAME_COLORS,
      stylePresets: STYLE_PRESETS,
      blueprintId: 540,
    });
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

      const { prompt, stylePreset, size, frameColor, referenceImage } = req.body;

      if (!prompt || !size) {
        return res.status(400).json({ error: "Prompt and size are required" });
      }

      // Find size config
      const sizeConfig = PRINT_SIZES.find(s => s.id === size);
      if (!sizeConfig) {
        return res.status(400).json({ error: "Invalid size" });
      }

      // Build prompt with style
      const styleConfig = STYLE_PRESETS.find(s => s.id === stylePreset);
      let fullPrompt = prompt;
      if (styleConfig && styleConfig.promptPrefix) {
        fullPrompt = `${styleConfig.promptPrefix} ${prompt}`;
      }

      // CRITICAL: Hardcoded sizing and full-bleed requirements for ALL generations
      const sizingRequirements = `

MANDATORY IMAGE REQUIREMENTS - FOLLOW EXACTLY:
1. FULL-BLEED: The image MUST extend edge-to-edge, filling the ENTIRE canvas with NO margins, borders, frames, or empty space around the edges.
2. NO FLOATING: The subject must NOT appear to be floating or cropped. The artwork must have a complete background that extends to all edges.
3. NO PICTURE FRAMES: Do NOT include any decorative borders, picture frames, drop shadows, or vignettes around the image. The image will be printed and framed separately.
4. COMPOSITION: ${sizeConfig.aspectRatio === "1:1" ? "Square 1:1 composition" : `Vertical portrait ${sizeConfig.aspectRatio} composition`} - the artwork fills the entire canvas.
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
      const generatedImageUrl = `data:${mimeType};base64,${imagePart.inlineData.data}`;

      // Create design record
      const design = await storage.createDesign({
        customerId: customer.id,
        prompt,
        stylePreset: stylePreset || null,
        referenceImageUrl: referenceImage ? "uploaded" : null,
        generatedImageUrl,
        size,
        frameColor: frameColor || "black",
        aspectRatio: sizeConfig.aspectRatio,
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

      if (!prompt || !size) {
        return res.status(400).json({ error: "Prompt and size are required" });
      }

      // Find size config - use default if not matching internal sizes
      let sizeConfig = PRINT_SIZES.find(s => s.id === size);
      if (!sizeConfig) {
        // Use medium as default for Shopify custom sizes
        sizeConfig = PRINT_SIZES.find(s => s.id === "medium") || PRINT_SIZES[0];
      }

      // Build prompt with style
      const styleConfig = STYLE_PRESETS.find(s => s.id === stylePreset);
      let fullPrompt = prompt;
      if (styleConfig && styleConfig.promptPrefix) {
        fullPrompt = `${styleConfig.promptPrefix} ${prompt}`;
      }

      // CRITICAL: Full-bleed requirements for ALL generations
      const sizingRequirements = `

MANDATORY IMAGE REQUIREMENTS - FOLLOW EXACTLY:
1. FULL-BLEED: The image MUST extend edge-to-edge, filling the ENTIRE canvas with NO margins, borders, frames, or empty space around the edges.
2. NO FLOATING: The subject must NOT appear to be floating or cropped. The artwork must have a complete background that extends to all edges.
3. NO PICTURE FRAMES: Do NOT include any decorative borders, picture frames, drop shadows, or vignettes around the image.
4. COMPOSITION: ${sizeConfig.aspectRatio === "1:1" ? "Square 1:1 composition" : `Vertical portrait ${sizeConfig.aspectRatio} composition`} - the artwork fills the entire canvas.
5. SAFE ZONE: Keep all important elements within the central 75% of the image.
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
      const generatedImageUrl = `data:${mimeType};base64,${imagePart.inlineData.data}`;
      const designId = `shopify-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Log the generation (credit was already deducted atomically above)
      await storage.createCreditTransaction({
        customerId: customer!.id,
        type: "generation",
        amount: -1,
        description: `Shopify artwork: ${prompt.substring(0, 50)}...`,
      });

      res.json({
        imageUrl: generatedImageUrl,
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

      // Check if customer already used this coupon
      const existingRedemption = await storage.getCouponRedemption(coupon.id, customer.id);
      if (existingRedemption) {
        return res.status(400).json({ error: "You have already used this coupon" });
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

      const { name, promptPrefix, isActive, sortOrder } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: "Style name is required" });
      }

      const preset = await storage.createStylePreset({
        merchantId: merchant.id,
        name,
        promptPrefix: promptPrefix || "",
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

      const { name, promptPrefix, isActive, sortOrder } = req.body;
      
      const updated = await storage.updateStylePreset(presetId, {
        name: name !== undefined ? name : preset.name,
        promptPrefix: promptPrefix !== undefined ? promptPrefix : preset.promptPrefix,
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

      // Seed default styles
      const defaultStyles = STYLE_PRESETS.map((style, index) => ({
        merchantId: merchant.id,
        name: style.name,
        promptPrefix: style.promptPrefix,
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

  return httpServer;
}
