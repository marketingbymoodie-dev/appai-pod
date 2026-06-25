import { buildAppUrl } from "./urlBase";

/** Railway / central app origin for popup auth (not the Shopify app-proxy path). */
export function getCentralAppOrigin(): string {
  if (typeof window !== "undefined") {
    const injected = window.__APPAI_ASSET_BASE__?.replace(/\/$/, "");
    if (injected) return injected;
    return window.location.origin;
  }
  return "";
}

export function buildCentralAppUrl(path: string): string {
  const origin = getCentralAppOrigin();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${normalized}`;
}

/** API URL for requests from the Shopify app-proxy iframe. */
export function buildStorefrontApiUrl(path: string): string {
  return buildAppUrl(path);
}
