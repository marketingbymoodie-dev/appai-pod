import type { Express, Request, Response } from "express";
import { isAuthenticated } from "./replitAuth";

/**
 * Auth routes for Shopify-native authentication.
 *
 * These endpoints provide user info and logout functionality
 * compatible with the client-side useAuth hook.
 */
export function registerAuthRoutes(app: Express) {
  // ─────────────────────────────────────────────────────────────────────────
  // DEV-ONLY BYPASS: return a mock merchant user without a Shopify session.
  // This is ONLY active in development (NODE_ENV=development) and is never
  // reachable in production.
  // ─────────────────────────────────────────────────────────────────────────
  if (process.env.NODE_ENV === "development") {
    console.log("[auth] DEV MODE: /api/auth/user bypass active — no Shopify session required");

    app.get("/api/auth/user", (_req: Request, res: Response) => {
      return res.json({
        id: "dev:merchant:localhost",
        email: "dev@localhost",
        firstName: "Dev",
        lastName: "Merchant",
        profileImageUrl: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    // Dev logout just redirects home
    app.get("/api/logout", (_req: Request, res: Response) => {
      res.redirect("/");
    });

    return; // skip registering the real Shopify auth routes in dev
  }

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
