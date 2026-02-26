/**
 * Shopify App Bridge v3 — session token acquisition
 *
 * Why v3 (createApp + getSessionToken) instead of window.shopify.idToken():
 *
 *   The CDN-based App Bridge v4 script (app-bridge.js, loaded with `defer`)
 *   initialises window.shopify by reading `?host=` from the URL.  Our SPA
 *   navigates from `/?host=XXX` → `/admin` before that CDN script finishes
 *   loading, so `host` is gone by the time the script runs — window.shopify
 *   never gets a valid idToken provider.
 *
 *   App Bridge v3 is bundled with the app (no CDN dependency) and only needs
 *   `host` at createApp() time.  We capture it at module-evaluation (before
 *   any React navigation) so it is always available.
 */

import createApp from "@shopify/app-bridge";
import { getSessionToken } from "@shopify/app-bridge/utilities";

// ─── Read API key from the <meta name="shopify-api-key"> tag ────────────────
const API_KEY =
  (document.querySelector('meta[name="shopify-api-key"]') as HTMLMetaElement)
    ?.content ?? "6f6c83692d275fd284accad7d5a6fefd";

// ─── Capture host + shop ONCE at module load, before SPA navigation ──────────
const _initialParams = new URLSearchParams(window.location.search);
const _initialHost = _initialParams.get("host");
const _initialShop = _initialParams.get("shop");

// Persist in sessionStorage so they survive hard reloads but not cross-tab leaks
if (_initialHost) sessionStorage.setItem("shopify_host", _initialHost);
if (_initialShop) sessionStorage.setItem("shopify_shop", _initialShop);

function getStoredHost(): string | null {
  return (
    new URLSearchParams(window.location.search).get("host") ||
    sessionStorage.getItem("shopify_host") ||
    null
  );
}

function getStoredShop(): string | null {
  return (
    new URLSearchParams(window.location.search).get("shop") ||
    sessionStorage.getItem("shopify_shop") ||
    null
  );
}

// ─── Singleton App Bridge instance ──────────────────────────────────────────
let _bridge: ReturnType<typeof createApp> | null = null;

function getBridge(): ReturnType<typeof createApp> | null {
  if (_bridge) return _bridge;

  const host = getStoredHost();
  if (!host) return null;

  try {
    _bridge = createApp({ apiKey: API_KEY, host });
    if (import.meta.env.DEV) {
      console.log("[shopify-bridge] App Bridge initialised for host:", host.slice(0, 20) + "…");
    }
    return _bridge;
  } catch (e) {
    console.error("[shopify-bridge] createApp() failed:", e);
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** True when running inside the Shopify Admin iframe. */
export function isShopifyEmbedded(): boolean {
  if (typeof window === "undefined") return false;
  if (getStoredHost()) return true;
  // Cross-origin iframe check (SecurityError ⇒ definitely embedded)
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

/** Returns { shop, host } captured from the initial URL, or null values if unavailable. */
export function getShopifyParams() {
  return {
    shop: getStoredShop(),
    host: getStoredHost(),
  };
}

/**
 * Fetch a fresh Shopify session token via App Bridge v3 postMessage.
 * Returns null when not embedded or when the bridge is unavailable.
 */
export async function getShopifySessionToken(): Promise<string | null> {
  const bridge = getBridge();
  if (!bridge) {
    if (import.meta.env.DEV) {
      console.warn("[shopify-bridge] No bridge (not embedded or host missing)");
    }
    return null;
  }

  try {
    const token = await getSessionToken(bridge);
    if (import.meta.env.DEV) {
      console.log("[shopify-bridge] Token obtained:", token ? "✓" : "null");
    }
    return token || null;
  } catch (e) {
    console.error("[shopify-bridge] getSessionToken() failed:", e);
    return null;
  }
}
