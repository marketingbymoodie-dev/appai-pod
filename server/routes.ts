import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
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

  // Shopify Storefront Generate (for embedded design studio)
  // This endpoint accepts generations from Shopify storefronts without Replit auth
  // Uses shop domain verification instead
  app.post("/api/shopify/generate", async (req: Request, res: Response) => {
    try {
      const { prompt, stylePreset, size, frameColor, referenceImage, shop, shopifyCustomerId } = req.body;

      if (!shop) {
        return res.status(400).json({ error: "Shop domain required" });
      }

      // Verify shop is installed
      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }

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

      res.json({
        imageUrl: generatedImageUrl,
        designId,
        prompt,
      });
    } catch (error) {
      console.error("Error generating Shopify artwork:", error);
      res.status(500).json({ error: "Failed to generate artwork" });
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
