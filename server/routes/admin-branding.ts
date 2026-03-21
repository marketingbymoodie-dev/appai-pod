import { Router, Request, Response } from "express";
import { db } from "../db";
import { merchants } from "@shared/schema";
import { eq } from "drizzle-orm";
import { sniffThemeColors, getDefaultBranding } from "../theme-sniffer";
import { isAuthenticated } from "../replit_integrations/auth/replitAuth";

export function registerAdminBrandingRoutes(app: any) {
  /**
   * POST /api/admin/branding/sync-theme - Sync branding from Shopify theme
   */
  app.post("/api/admin/branding/sync-theme", isAuthenticated, async (req: Request, res: Response) => {
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
}
