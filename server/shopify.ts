import type { Express, Request, Response } from "express";
import crypto from "crypto";
import { storage } from "./storage";

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || "";
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "";
const SHOPIFY_SCOPES = "read_products,write_products,read_themes,write_themes";

function getAppUrl(): string {
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }
  return process.env.APP_URL || `http://localhost:${process.env.PORT || 5000}`;
}

function verifyHmac(query: Record<string, any>): boolean {
  if (!SHOPIFY_API_SECRET) return false;
  
  const hmac = query.hmac;
  if (!hmac) return false;

  const params = { ...query };
  delete params.hmac;
  delete params.signature;

  const message = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join("&");

  const generatedHash = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");

  if (generatedHash.length !== hmac.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(generatedHash, "hex"),
    Buffer.from(hmac, "hex")
  );
}

function isValidShopDomain(shop: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

export function registerShopifyRoutes(app: Express): void {
  if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
    console.log("Shopify OAuth disabled - SHOPIFY_API_KEY/SECRET not configured");
    
    app.get("/shopify/install", (_req: Request, res: Response) => {
      res.status(503).send(`
        <h1>Shopify Integration Not Configured</h1>
        <p>To enable Shopify integration, set these environment variables:</p>
        <ul>
          <li>SHOPIFY_API_KEY</li>
          <li>SHOPIFY_API_SECRET</li>
        </ul>
        <p>Create a Shopify app in your <a href="https://partners.shopify.com">Shopify Partners Dashboard</a> to get these credentials.</p>
      `);
    });
    return;
  }

  app.get("/shopify/install", (req: Request, res: Response) => {
    const shop = req.query.shop as string;

    if (!shop || !isValidShopDomain(shop)) {
      return res.status(400).send(`
        <h1>Missing or Invalid Shop</h1>
        <p>Please use the format: <code>/shopify/install?shop=yourstore.myshopify.com</code></p>
      `);
    }

    const state = crypto.randomBytes(16).toString("hex");
    const redirectUri = `${getAppUrl()}/shopify/callback`;

    const authUrl = `https://${shop}/admin/oauth/authorize?` +
      `client_id=${SHOPIFY_API_KEY}&` +
      `scope=${SHOPIFY_SCOPES}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `state=${state}`;

    res.cookie("shopify_state", state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600000
    });

    res.redirect(authUrl);
  });

  app.get("/shopify/callback", async (req: Request, res: Response) => {
    const { shop, code, state } = req.query as Record<string, string>;
    const storedState = req.cookies?.shopify_state;

    if (!shop || !code) {
      return res.status(400).send("Missing shop or code parameter");
    }

    if (!isValidShopDomain(shop)) {
      return res.status(400).send("Invalid shop domain");
    }

    if (state !== storedState) {
      return res.status(403).send("State verification failed - possible CSRF attack");
    }

    if (!verifyHmac(req.query as Record<string, any>)) {
      return res.status(400).send("HMAC verification failed");
    }

    try {
      const accessTokenUrl = `https://${shop}/admin/oauth/access_token`;
      
      const response = await fetch(accessTokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: SHOPIFY_API_KEY,
          client_secret: SHOPIFY_API_SECRET,
          code
        })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("Shopify token exchange failed:", error);
        return res.status(500).send("Failed to get access token from Shopify");
      }

      const tokenData = await response.json();
      const { access_token, scope } = tokenData;
      
      console.log(`Shopify OAuth completed for ${shop}`);
      console.log(`Scopes granted: ${scope || 'NONE'}`);
      console.log(`Requested scopes were: ${SHOPIFY_SCOPES}`);

      let installation = await storage.getShopifyInstallationByShop(shop);
      
      if (installation) {
        await storage.updateShopifyInstallation(installation.id, {
          accessToken: access_token,
          scope: scope || "",
          status: "active",
          installedAt: new Date(),
          uninstalledAt: null,
        });
        console.log(`Updated existing installation for ${shop}`);
      } else {
        installation = await storage.createShopifyInstallation({
          shopDomain: shop,
          accessToken: access_token,
          scope: scope || "",
          status: "active",
          installedAt: new Date(),
        });
        console.log(`Created new installation for ${shop}`);
      }

      res.clearCookie("shopify_state");

      res.redirect(`https://${shop}/admin/apps`);
    } catch (error) {
      console.error("Shopify OAuth error:", error);
      res.status(500).send("Failed to complete Shopify installation");
    }
  });

  app.get("/shopify/status", async (req: Request, res: Response) => {
    const shop = req.query.shop as string;

    if (!shop) {
      return res.json({ installed: false, error: "No shop provided" });
    }

    const installation = await storage.getShopifyInstallationByShop(shop);

    res.json({
      installed: installation?.status === "active",
      shop: installation?.shopDomain,
      installedAt: installation?.installedAt,
    });
  });

  app.post("/shopify/webhooks/uninstall", async (req: Request, res: Response) => {
    const hmacHeader = req.headers["x-shopify-hmac-sha256"] as string;
    const topic = req.headers["x-shopify-topic"] as string;
    const shop = req.headers["x-shopify-shop-domain"] as string;

    if (topic !== "app/uninstalled") {
      return res.status(200).send("OK");
    }

    const body = JSON.stringify(req.body);
    const generatedHash = crypto
      .createHmac("sha256", SHOPIFY_API_SECRET)
      .update(body, "utf8")
      .digest("base64");

    if (generatedHash !== hmacHeader) {
      return res.status(401).send("HMAC verification failed");
    }

    const installation = await storage.getShopifyInstallationByShop(shop);
    if (installation) {
      await storage.updateShopifyInstallation(installation.id, {
        status: "uninstalled",
        uninstalledAt: new Date(),
      });
    }

    res.status(200).send("OK");
  });

  // Revoke token and redirect to reinstall (forces new permission prompt)
  app.get("/shopify/reinstall", async (req: Request, res: Response) => {
    const shop = req.query.shop as string;

    if (!shop || !isValidShopDomain(shop)) {
      return res.status(400).send("Invalid or missing shop domain");
    }

    try {
      const installation = await storage.getShopifyInstallationByShop(shop);
      
      if (installation?.accessToken) {
        // Revoke the existing token
        console.log(`Revoking token for ${shop} to force re-authorization`);
        
        const revokeResponse = await fetch(
          `https://${shop}/admin/api_permissions/current.json`,
          {
            method: "DELETE",
            headers: {
              "X-Shopify-Access-Token": installation.accessToken,
            },
          }
        );
        
        if (revokeResponse.ok) {
          console.log(`Token revoked successfully for ${shop}`);
          // Mark as needing reinstall
          await storage.updateShopifyInstallation(installation.id, {
            status: "pending_reinstall",
            accessToken: "",
            scope: "",
          });
        } else {
          console.log(`Token revoke response: ${revokeResponse.status}`);
        }
      }

      // Redirect to install flow
      res.redirect(`/shopify/install?shop=${encodeURIComponent(shop)}`);
    } catch (error) {
      console.error("Error revoking Shopify token:", error);
      // Still try to reinstall even if revoke failed
      res.redirect(`/shopify/install?shop=${encodeURIComponent(shop)}`);
    }
  });

  console.log("Shopify OAuth routes registered");
}
