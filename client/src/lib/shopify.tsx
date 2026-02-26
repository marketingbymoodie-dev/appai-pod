/**
 * React context for Shopify embedded-app state.
 *
 * Token acquisition lives in shopify-bridge.ts (App Bridge v3).
 * This file only provides the React context wrappers and re-exports
 * isShopifyEmbedded for components that need it.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
} from "react";
import { isShopifyEmbedded as _isEmbedded } from "./shopify-bridge";
import { invalidateAuthQueries } from "./queryClient";

// Re-export so existing imports of isShopifyEmbedded from "@/lib/shopify" keep working
export { isShopifyEmbedded } from "./shopify-bridge";

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

interface ShopifyContextValue {
  isEmbedded: boolean;
  /** True once the App Bridge has been initialised and queries should fire. */
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
// App Bridge v3 (createApp) is synchronous — there is nothing to wait for
// before the token getter is ready.  We mark ready immediately and invalidate
// any queries that may have fired before React mounted.
// ─────────────────────────────────────────────────────────────────────────────

function ShopifyEmbeddedProvider({ children }: { children: ReactNode }) {
  // Mark ready on first effect so queries have one render cycle to register
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    setIsReady(true);
    // Re-fire any queries that returned 401/null before the token was available
    invalidateAuthQueries();
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
// ShopifyProvider — evaluated ONCE at mount (useState) so SPA navigation that
// strips ?host= from the URL never flips us to the wrong provider.
// ─────────────────────────────────────────────────────────────────────────────

export function ShopifyProvider({ children }: { children: ReactNode }) {
  const [embedded] = useState(() => _isEmbedded());

  if (embedded) {
    return <ShopifyEmbeddedProvider>{children}</ShopifyEmbeddedProvider>;
  }
  return <NonEmbeddedProvider>{children}</NonEmbeddedProvider>;
}
