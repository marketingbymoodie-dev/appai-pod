import {
  createContext, useContext, useEffect, useMemo,
  useState, ReactNode,
} from "react";
import { invalidateAuthQueries } from "./queryClient";

// ─────────────────────────────────────────────────────────────────────────────
// isShopifyEmbedded
//
// Detects whether the app is running inside the Shopify Admin iframe.
// Evaluated lazily so it captures window.shopify even if injected late.
// ─────────────────────────────────────────────────────────────────────────────

export function isShopifyEmbedded(): boolean {
  if (typeof window === "undefined") return false;

  // window.shopify is injected by Shopify's App Bridge CDN script
  if ((window as any).shopify) return true;

  // URL params present on first load (before any SPA navigation)
  const params = new URLSearchParams(window.location.search);
  if (params.has("shop") || params.has("host") || params.has("embedded")) return true;

  // Cross-origin iframe — accessing window.top throws a SecurityError
  try {
    if (window.top !== window.self) {
      return (
        document.referrer.includes("shopify.com") ||
        document.referrer.includes("myshopify.com") ||
        true // if we're in any cross-origin iframe assume Shopify
      );
    }
  } catch {
    // SecurityError = cross-origin iframe → definitely embedded
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

interface ShopifyContextValue {
  isEmbedded: boolean;
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
// Waits for window.shopify to be present (Shopify injects it asynchronously
// via its CDN script), then marks the app as ready and triggers a refetch of
// all auth-gated queries so they pick up the now-available session token.
// ─────────────────────────────────────────────────────────────────────────────

function ShopifyEmbeddedProvider({ children }: { children: ReactNode }) {
  const [isReady, setIsReady] = useState(() => !!(window as any).shopify);

  useEffect(() => {
    if ((window as any).shopify) {
      setIsReady(true);
      // Queries that fired during loading will have returned 401/null.
      // Invalidate them so they retry now that the bridge is available.
      invalidateAuthQueries();
      return;
    }

    let cancelled = false;
    const startMs = Date.now();
    const maxWaitMs = 8000;

    const check = () => {
      if (cancelled) return;
      if ((window as any).shopify) {
        setIsReady(true);
        invalidateAuthQueries();
        return;
      }
      if (Date.now() - startMs > maxWaitMs) {
        console.warn("[ShopifyProvider] window.shopify not found after 8 s — marking ready anyway");
        setIsReady(true);
        return;
      }
      setTimeout(check, 100);
    };

    setTimeout(check, 100);
    return () => { cancelled = true; };
  }, []);

  const value = useMemo<ShopifyContextValue>(
    () => ({ isEmbedded: true, isReady }),
    [isReady],
  );

  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground text-sm">Loading…</div>
      </div>
    );
  }

  return (
    <ShopifyContext.Provider value={value}>
      {children}
    </ShopifyContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NonEmbeddedProvider — development / storefront outside Shopify Admin
// ─────────────────────────────────────────────────────────────────────────────

function NonEmbeddedProvider({ children }: { children: ReactNode }) {
  const value = useMemo<ShopifyContextValue>(
    () => ({ isEmbedded: false, isReady: true }),
    [],
  );
  return (
    <ShopifyContext.Provider value={value}>
      {children}
    </ShopifyContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ShopifyProvider — root wrapper; decides which provider to use.
//
// IMPORTANT: isShopifyEmbedded() is evaluated ONCE per mount via useState so
// a SPA navigation (which removes ?shop= from the URL) cannot flip us back to
// NonEmbeddedProvider and lose the bridge context.
// ─────────────────────────────────────────────────────────────────────────────

export function ShopifyProvider({ children }: { children: ReactNode }) {
  // Capture once at mount — never re-evaluate on re-renders / URL changes
  const [embedded] = useState(() => isShopifyEmbedded());

  if (embedded) {
    return <ShopifyEmbeddedProvider>{children}</ShopifyEmbeddedProvider>;
  }
  return <NonEmbeddedProvider>{children}</NonEmbeddedProvider>;
}
