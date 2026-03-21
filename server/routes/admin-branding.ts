import { Request, Response } from "express";
import { storage } from "../storage";
import { sniffThemeColors } from "../theme-sniffer";
import { isAuthenticated } from "../replit_integrations/auth";

/**
 * Wrap an async Express handler so rejected promises are forwarded to next(err)
 */
function asyncHandler(fn: (req: any, res: Response, next: any) => Promise<any>) {
  return (req: any, res: Response, next: any) => {
    fn(req, res, next).catch(next);
  };
}

export function registerAdminBrandingRoutes(app: any) {
  // GET branding settings for current merchant
  app.get("/api/admin/branding", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    const userId = req.user.claims.sub;
    const merchant = await storage.getMerchantByUserId(userId);
    
    if (!merchant) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    res.json({
      brandingSettings: merchant.brandingSettings || {
        primaryColor: "#000000",
        secondaryColor: "#f5f5f5",
        textColor: "#000000",
        borderColor: "#000000",
        backgroundColor: "#ffffff",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }
    });
  }));

  // POST sync theme - detect colors and fonts from Shopify theme
  app.post("/api/admin/branding/sync-theme", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    const userId = req.user.claims.sub;
    const merchant = await storage.getMerchantByUserId(userId);
    
    if (!merchant) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    // Get the first connected Shopify store
    const installations = await storage.getShopifyInstallationsByMerchant(merchant.id);
    if (!installations || installations.length === 0) {
      return res.status(400).json({ error: "No Shopify store connected" });
    }

    const installation = installations[0];
    
    try {
      // Fetch theme CSS from Shopify store to sniff colors and fonts
      const themeSettings = await sniffThemeColors(installation.shopDomain);
      
      if (!themeSettings) {
        return res.status(400).json({ error: "Could not detect theme settings" });
      }

      // Update merchant branding settings
      const updatedMerchant = await storage.updateMerchant(merchant.id, {
        brandingSettings: {
          ...themeSettings,
          syncedAt: new Date().toISOString(),
        }
      });

      res.json({
        message: "Theme synced successfully",
        brandingSettings: updatedMerchant.brandingSettings
      });
    } catch (error) {
      console.error("Error syncing theme:", error);
      res.status(500).json({ error: "Failed to sync theme" });
    }
  }));
}
