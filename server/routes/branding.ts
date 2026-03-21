import { Router, Request, Response } from "express";
import { db } from "../db";
import { merchants } from "@shared/schema";
import { eq } from "drizzle-orm";
import { sniffThemeColors, getDefaultBranding } from "../theme-sniffer";
import { isAuthenticated } from "../replit_integrations/auth/replitAuth";

const router = Router();

/**
 * GET /api/branding - Get current branding settings
 */
router.get("/", isAuthenticated, async (req: Request, res: Response) => {
  try {
    const merchantId = (req as any).user?.merchantId;
    if (!merchantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
    });

    if (!merchant) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    res.json({
      branding: merchant.brandingSettings || getDefaultBranding(),
    });
  } catch (error) {
    console.error("Error getting branding settings:", error);
    res.status(500).json({ error: "Failed to get branding settings" });
  }
});

/**
 * POST /api/branding/sync-theme - Sync branding from Shopify theme
 */
router.post("/sync-theme", isAuthenticated, async (req: Request, res: Response) => {
  try {
    const merchantId = (req as any).user?.merchantId;
    if (!merchantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
    });

    if (!merchant) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    // Get the shop domain from the merchant
    const shopDomain = merchant.shopDomain;
    if (!shopDomain) {
      return res.status(400).json({ error: "No Shopify store connected" });
    }

    // Sniff the theme colors
    const branding = await sniffThemeColors(shopDomain);

    // Save to database
    await db
      .update(merchants)
      .set({
        brandingSettings: branding,
        updatedAt: new Date(),
      })
      .where(eq(merchants.id, merchantId));

    res.json({
      message: "Theme synced successfully",
      branding,
    });
  } catch (error) {
    console.error("Error syncing theme:", error);
    res.status(500).json({ error: "Failed to sync theme" });
  }
});

export default router;
