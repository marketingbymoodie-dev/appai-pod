import type { Express, RequestHandler } from "express";
import * as jwt from "jsonwebtoken";

/**
 * Shopify-native auth (NO Replit OIDC)
 *
 * This replaces the old Replit OIDC + Passport session approach.
 * In Shopify Admin, your frontend must send a Shopify session token (JWT) on API calls:
 *
 *   Authorization: Bearer <sessionToken>
 *
 * Shopify signs session tokens with your app's API secret (HS256).
 */

type ShopifySessionTokenPayload = {
  iss?: string;
  dest?: string; // e.g. https://{shop}.myshopify.com
  aud?: string; // your SHOPIFY_API_KEY
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  sid?: string;
};

declare global {
  // Lightweight place to stash shop info for downstream handlers if needed.
  // (Avoids forcing you to refactor other files right now.)
  // eslint-disable-next-line no-var
  namespace Express {
    interface Request {
      shopDomain?: string;
      shopOrigin?: string;
      shopifySession?: ShopifySessionTokenPayload;
    }
  }
}

function getShopifyApiKey() {
  const key = process.env.SHOPIFY_API_KEY;
  if (!key) throw new Error("Missing env SHOPIFY_API_KEY");
  return key;
}

function getShopifyApiSecret() {
  const secret =
    process.env.SHOPIFY_API_SECRET ||
    process.env.SHOPIFY_API_SECRET_KEY ||
    process.env.SHOPIFY_API_SECRET_SECRET;

  if (!secret) {
    throw new Error("Missing env SHOPIFY_API_SECRET (or SHOPIFY_API_SECRET_KEY)");
  }
  return secret;
}

function getBearerToken(req: any): string | null {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (!header || typeof header !== "string") return null;

  const parts = header.split(" ");
  if (parts.length !== 2) return null;
  if (parts[0].toLowerCase() !== "bearer") return null;

  return parts[1] || null;
}

function parseShopFromDest(dest?: string): { shopDomain?: string; shopOrigin?: string } {
  if (!dest) return {};
  try {
    const u = new URL(dest);
    return { shopDomain: u.hostname, shopOrigin: u.origin };
  } catch {
    return {};
  }
}

/**
 * Core verifier used by middleware
 */
const verifyShopifySessionToken: RequestHandler = (req, res, next) => {
  const token = getBearerToken(req);

  if (!token) {
    return res.status(401).json({ message: "Unauthorized: missing session token" });
  }

  let payload: ShopifySessionTokenPayload;

  try {
    // Verify signature + exp/nbf
    const decoded = jwt.verify(token, getShopifyApiSecret(), {
      algorithms: ["HS256"],
    });

    // jsonwebtoken can return string | object
    if (!decoded || typeof decoded !== "object") {
      return res.status(401).json({ message: "Unauthorized: invalid token" });
    }

    payload = decoded as ShopifySessionTokenPayload;
  } catch (_err) {
    return res.status(401).json({ message: "Unauthorized: invalid token" });
  }

  // Validate audience matches our API key (Shopify sets aud = API key)
  const expectedAud = getShopifyApiKey();
  if (payload.aud !== expectedAud) {
    return res.status(401).json({ message: "Unauthorized: invalid audience" });
  }

  // Attach shop info for later handlers
  const { shopDomain, shopOrigin } = parseShopFromDest(payload.dest);
  req.shopDomain = shopDomain;
  req.shopOrigin = shopOrigin;
  req.shopifySession = payload;

  return next();
};

/**
 * Export name used by your app.
 * This makes the middleware plug-in simple: app.use("/api", isAuthenticated)
 */
export const isAuthenticated: RequestHandler = verifyShopifySessionToken;

/**
 * Legacy hook: some codebases call setupAuth(app).
 * With Shopify session tokens, we do not need to register any auth routes here.
 */
export async function setupAuth(_app: Express) {
  // no-op
}
