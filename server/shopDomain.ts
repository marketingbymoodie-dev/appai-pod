/**
 * Normalize Shopify shop identifiers to `{handle}.myshopify.com`.
 * Accepts bare handles, full myshopify domains, and URLs with/without scheme.
 */
export function normalizeMyshopifyShopDomain(shop: string | null | undefined): string {
  let s = String(shop || "")
    .trim()
    .toLowerCase();
  if (!s) return "";

  // Strip scheme + path (dest/iss may be full URLs).
  s = s.replace(/^https?:\/\//, "");
  const slash = s.indexOf("/");
  if (slash >= 0) s = s.slice(0, slash);
  s = s.trim();
  if (!s) return "";

  if (s.endsWith(".myshopify.com")) return s;
  if (/^[a-z0-9][a-z0-9-]*$/.test(s)) return `${s}.myshopify.com`;
  return s;
}

/**
 * Extract shop domain from a Shopify session-token `dest` / `iss` claim.
 * Shopify docs show both `https://shop.myshopify.com` and bare `shop.myshopify.com`.
 */
export function shopDomainFromSessionClaim(
  dest?: string | null,
  iss?: string | null,
): { shopDomain?: string; shopOrigin?: string } {
  for (const raw of [dest, iss]) {
    if (!raw || typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    let hostname = "";
    try {
      hostname = new URL(trimmed).hostname;
    } catch {
      try {
        hostname = new URL(`https://${trimmed.replace(/^\/+/, "")}`).hostname;
      } catch {
        hostname = normalizeMyshopifyShopDomain(trimmed);
      }
    }

    const shopDomain = normalizeMyshopifyShopDomain(hostname);
    if (shopDomain.endsWith(".myshopify.com")) {
      return {
        shopDomain,
        shopOrigin: `https://${shopDomain}`,
      };
    }
  }
  return {};
}
