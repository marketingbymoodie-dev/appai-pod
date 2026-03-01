/**
 * Centralized URL base for Shopify App Proxy context.
 *
 * When running through the proxy, the browser is on the Shopify store domain
 * and all requests must go through /apps/appai/... to be proxied to Railway.
 * When running directly on Railway (admin embed, standalone), no prefix is needed.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the proxy base.
 * All other modules import from here — no hardcoded "/apps/appai" elsewhere.
 */

export const PROXY_PREFIX = "/apps/appai";

function normalizeBase(base: string): string {
  if (!base) return "";
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function ensureLeadingSlash(p: string): string {
  return p.startsWith("/") ? p : `/${p}`;
}

/**
 * Detect if we're running inside the Shopify App Proxy context.
 * Returns "/apps/appai" or "".
 */
export function getProxyBase(): string {
  if (typeof window === "undefined") return "";

  // 1. Server-injected override (set in proxied index.html <head>)
  if ((window as any).__APPAI_API_BASE__ !== undefined) {
    return normalizeBase((window as any).__APPAI_API_BASE__);
  }

  // 2. data attribute on script tag
  if (typeof document !== "undefined") {
    const script = document.querySelector("script[data-appai-api-base]");
    if (script) {
      const base = script.getAttribute("data-appai-api-base");
      if (base !== null) return normalizeBase(base);
    }
  }

  // 3. Path-based detection
  if (window.location.pathname.startsWith(`${PROXY_PREFIX}/`)) {
    return PROXY_PREFIX;
  }

  // 4. Direct Railway or standalone — no prefix
  return "";
}

/**
 * Build a full app-relative URL, ensuring exactly one proxy prefix.
 * Catches and fixes accidental double-prefixing.
 *
 * Examples (proxy mode):
 *   buildAppUrl("/api/config")          → "/apps/appai/api/config"
 *   buildAppUrl("/s/designer")          → "/apps/appai/s/designer"
 *   buildAppUrl("/objects/designs/x.png") → "/apps/appai/objects/designs/x.png"
 *
 * Examples (direct Railway):
 *   buildAppUrl("/api/config")          → "/api/config"
 */
export function buildAppUrl(urlPath: string): string {
  const base = getProxyBase();
  const normalized = ensureLeadingSlash(urlPath);

  // If the path already starts with the proxy prefix, don't double it
  if (base && normalized.startsWith(`${base}/`)) {
    return normalized;
  }

  const result = base + normalized;

  // Runtime guard: catch double prefix in dev
  const doubled = `${PROXY_PREFIX}${PROXY_PREFIX}`;
  if (result.includes(doubled)) {
    const fixed = result.replace(doubled, PROXY_PREFIX);
    console.error(
      `[urlBase] Double proxy prefix detected! "${result}" → fixed to "${fixed}". ` +
      `This is a bug — check the call site.`
    );
    return fixed;
  }

  return result;
}

/** Pre-computed API base: "/apps/appai" in proxy mode, "" on Railway. */
export const API_BASE = getProxyBase();

/** Pre-computed router base for wouter: "/apps/appai" or "". */
export const ROUTER_BASE = (() => {
  if (typeof window === "undefined") return "";
  if ((window as any).__APPAI_ROUTER_BASE__) {
    return normalizeBase((window as any).__APPAI_ROUTER_BASE__);
  }
  return getProxyBase();
})();
