/** postMessage type for central Google auth popup → customizer iframe. */
export const STOREFRONT_GOOGLE_AUTH_MESSAGE = "APPAI_STOREFRONT_GOOGLE_AUTH";

export type StorefrontGoogleAuthMessage = {
  type: typeof STOREFRONT_GOOGLE_AUTH_MESSAGE;
  nonce: string;
  ok: boolean;
  customerId?: string;
  identityToken?: string;
  credits?: number;
  freeGenerationsUsed?: number;
  email?: string;
  error?: string;
};

export function isStorefrontGoogleAuthMessage(value: unknown): value is StorefrontGoogleAuthMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as StorefrontGoogleAuthMessage;
  return msg.type === STOREFRONT_GOOGLE_AUTH_MESSAGE && typeof msg.nonce === "string";
}

/** Origins allowed to receive auth results from the central popup. */
export function isAllowedStorefrontOpenerOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol !== "https:" && !(protocol === "http:" && hostname === "localhost")) return false;
    if (hostname === "localhost" || hostname === "127.0.0.1") return true;
    if (hostname.endsWith(".myshopify.com")) return true;
    if (hostname.endsWith(".shopify.com")) return true;
    if (hostname.endsWith(".railway.app")) return true;
    // Custom storefront domains — allow any HTTPS host (token is shop-scoped).
    return true;
  } catch {
    return false;
  }
}

/** Origins allowed to send auth results from the central popup (app host). */
export function isAllowedCentralAuthOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol !== "https:" && !(protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1"))) {
      return false;
    }
    if (hostname === "localhost" || hostname === "127.0.0.1") return true;
    if (hostname.endsWith(".railway.app")) return true;
    return false;
  } catch {
    return false;
  }
}
