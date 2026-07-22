import type { Request } from "express";
import { normalizeMyshopifyShopDomain } from "./shopDomain";

/**
 * Platform-operator access (AppAI owner), not merchant admin.
 *
 * Production: shop domain must match OWNER_SHOP_DOMAIN or PLATFORM_ADMIN_SHOP_DOMAINS.
 * Development: always allowed so local calibration tools work without Shopify JWT.
 */
export function isPlatformAdminRequest(req: Pick<Request, "shopDomain">): boolean {
  if (process.env.NODE_ENV !== "production") return true;

  const shop = normalizeMyshopifyShopDomain((req as any).shopDomain);
  if (!shop) return false;

  const domains = new Set<string>();
  const owner = normalizeMyshopifyShopDomain(process.env.OWNER_SHOP_DOMAIN);
  if (owner) domains.add(owner);
  for (const d of (process.env.PLATFORM_ADMIN_SHOP_DOMAINS || "").split(",")) {
    const t = normalizeMyshopifyShopDomain(d);
    if (t) domains.add(t);
  }

  if (domains.size === 0) return false;

  return domains.has(shop);
}

export function requirePlatformAdmin(req: Pick<Request, "shopDomain">, res: any): boolean {
  if (isPlatformAdminRequest(req)) return true;
  res.status(403).json({
    error: "Platform operator access required",
    code: "PLATFORM_ADMIN_REQUIRED",
  });
  return false;
}
