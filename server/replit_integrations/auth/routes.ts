import type { Express, Request, Response } from "express";
import { isAuthenticated } from "./replitAuth";

/**
 * Auth routes for Shopify-native authentication.
 *
 * These endpoints provide user info and logout functionality
 * compatible with the client-side useAuth hook.
 */
export function registerAuthRoutes(app: Express) {
  // Get current authenticated user
  // Returns user info derived from Shopify session token
  app.get("/api/auth/user", isAuthenticated, (req: Request, res: Response) => {
    const shopDomain = req.shopDomain;
    const userId = req.user?.claims?.sub;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Return a user object compatible with the User type
    // For Shopify apps, we derive identity from the shop
    return res.json({
      id: userId,
      email: shopDomain ? `admin@${shopDomain}` : null,
      firstName: shopDomain ? shopDomain.replace(".myshopify.com", "") : "Merchant",
      lastName: null,
      profileImageUrl: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  // Logout endpoint
  // For Shopify embedded apps, we redirect to the Shopify admin
  app.get("/api/logout", (_req: Request, res: Response) => {
    // In a Shopify embedded app, the user is authenticated via Shopify.
    // "Logging out" means leaving the app context.
    // Redirect to Shopify admin or show a message.
    res.redirect("https://admin.shopify.com");
  });
}
