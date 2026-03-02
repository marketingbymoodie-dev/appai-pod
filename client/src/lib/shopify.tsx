/**
 * Shopify embedded-app detection and React context.
 *
 * Token auth is handled automatically by the App Bridge v4 CDN script
 * (app-bridge.js) which monkey-patches window.fetch.  This file only:
 *   1. Detects whether the app is running in the Shopify Admin iframe.
 *   2. Captures ?host= and ?shop= in sessionStorage before SPA navigation strips them.
 *   3. Waits for window.shopify (the v4 global) to be injected, then invalidates
 *      any queries that fired before the fetch patch was in place.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
} from "react";
import { invalidateAuthQueries } from "./queryClient";
import { PROXY_PREFIX } from "./urlBase";

// ─── Capture host + shop from the initial URL immediately at module load ─────
// Must happen before any SPA navigation removes the query params.
const _initialParams = new URLSearchParams(window.location.search);
const _initialHost = _initialParams.get("host");
const _initialShop = _initialParams.get("shop");
if (_initialHost) sessionStorage.setItem("shopify_host", _initialHost);
if (_initialShop) sessionStorage.setItem("shopify_shop", _initialShop);

// ─────────────────────────────────────────────────────────────────────────────
// isShopifyEmbedded — public helper used across the app
// ─────────────────────────────────────────────────────────────────────────────

export function isShopifyEmbedded(): boolean {
  if (typeof window === "undefined") return false;

  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);

  // Path-based: /s/* is storefront — NEVER embedded admin
  if (path.startsWith('/s/')) return false;
  // App Proxy path: /apps/appai/s/* — also storefront, never admin
  if (path.startsWith(`${PROXY_PREFIX}/s/`)) return false;

  // Legacy query-param guard: storefront=true is NOT admin embedded
  if (params.get("storefront") === "true") return false;

  // window.shopify is injected by the app-bridge.js CDN script when embedded
  if ((window as any).shopify) return true;

  // URL params present on initial load (before SPA navigation)
  if (
    sessionStorage.getItem("shopify_host") ||
    params.has("shop") ||
    params.has("host")
  ) {
    return true;
  }

  // Cross-origin iframe — accessing window.top throws a SecurityError
  try {
    return window.top !== window.self;
  } catch {
    return true; // SecurityError ⇒ definitely in a cross-origin iframe
  }
}

/** Returns the shop and host captured from the initial Shopify Admin URL. */
export function getShopifyParams() {
  return {
    shop:
      new URLSearchParams(window.location.search).get("shop") ||
      sessionStorage.getItem("shopify_shop") ||
      null,
    host:
      new URLSearchParams(window.location.search).get("host") ||
      sessionStorage.getItem("shopify_host") ||
      null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

interface ShopifyContextValue {
  isEmbedded: boolean;
  /** True once window.shopify exists and fetch is monkey-patched. */
  isReady: boolean;
}

const ShopifyContext = createContext<ShopifyContextValue>({
  isEmbedded: false,
  isReady: true,
});

export function useShopify() {
  return useContext(ShopifyContext);
}

// ─────────────────────────────────────────────────────────────────────────────
// ShopifyEmbeddedProvider
//
// Waits for window.shopify to be present (App Bridge v4 CDN script injects it).
// Once available, fetch is already monkey-patched, so we invalidate any queries
// that may have fired before the Authorization header was available.
// ─────────────────────────────────────────────────────────────────────────────

function ShopifyEmbeddedProvider({ children }: { children: ReactNode }) {
  const [isReady, setIsReady] = useState(() => !!(window as any).shopify);

  useEffect(() => {
    // Already available — mark ready immediately and refresh queries
    if ((window as any).shopify) {
      setIsReady(true);
      invalidateAuthQueries();
      return;
    }

    let cancelled = false;
    const startMs = Date.now();
    const maxWaitMs = 10_000;

    const check = () => {
      if (cancelled) return;
      if ((window as any).shopify) {
        setIsReady(true);
        invalidateAuthQueries();
        return;
      }
      if (Date.now() - startMs > maxWaitMs) {
        // App Bridge didn't load (slow CDN, offline dev) — unblock the app anyway
        console.warn("[ShopifyProvider] window.shopify not found after 10 s — proceeding without it");
        setIsReady(true);
        return;
      }
      setTimeout(check, 100);
    };

    setTimeout(check, 100);
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<ShopifyContextValue>(
    () => ({ isEmbedded: true, isReady }),
    [isReady],
  );

  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground text-sm">
          Loading…
        </div>
      </div>
    );
  }

  return (
    <ShopifyContext.Provider value={value}>{children}</ShopifyContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NonEmbeddedProvider — development / customer storefront
// ─────────────────────────────────────────────────────────────────────────────

function NonEmbeddedProvider({ children }: { children: ReactNode }) {
  const value = useMemo<ShopifyContextValue>(
    () => ({ isEmbedded: false, isReady: true }),
    [],
  );
  return (
    <ShopifyContext.Provider value={value}>{children}</ShopifyContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ShopifyProvider
//
// Evaluated ONCE per mount via useState so SPA navigation that strips ?host=
// from the URL never flips us to the wrong provider.
// ─────────────────────────────────────────────────────────────────────────────

export function ShopifyProvider({ children }: { children: ReactNode }) {
  const [embedded] = useState(() => isShopifyEmbedded());

  if (embedded) {
    return <ShopifyEmbeddedProvider>{children}</ShopifyEmbeddedProvider>;
  }
  return <NonEmbeddedProvider>{children}</NonEmbeddedProvider>;
}
