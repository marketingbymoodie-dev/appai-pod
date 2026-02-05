import { createContext, useContext, useMemo, useState, useEffect, useCallback, ReactNode } from "react";
import { setSessionTokenGetter } from "./queryClient";

// Check if we're running inside Shopify Admin iframe
// The shopify global may not be immediately available, so we also check for iframe context
export function isShopifyEmbedded(): boolean {
  if (typeof window === "undefined") return false;

  // Check if shopify global exists
  if ("shopify" in window) return true;

  // Check if we're in an iframe with Shopify-related URL params
  const params = new URLSearchParams(window.location.search);
  if (params.has("shop") || params.has("embedded")) return true;

  // Check if parent is Shopify admin
  try {
    if (window.top !== window.self) {
      // We're in an iframe - assume Shopify context if no other indicators
      return document.referrer.includes("shopify.com") ||
             document.referrer.includes("myshopify.com");
    }
  } catch {
    // Cross-origin iframe - likely Shopify
    return true;
  }

  return false;
}

interface ShopifyContextValue {
  isEmbedded: boolean;
  isReady: boolean;
  getSessionToken: () => Promise<string | null>;
}

const ShopifyContext = createContext<ShopifyContextValue>({
  isEmbedded: false,
  isReady: true,
  getSessionToken: async () => null,
});

export function useShopify() {
  return useContext(ShopifyContext);
}

// Provider that uses Shopify App Bridge (global shopify object)
function ShopifyEmbeddedProvider({ children }: { children: ReactNode }) {
  const [isReady, setIsReady] = useState(false);
  const [shopifyGlobal, setShopifyGlobal] = useState<any>(null);

  // Poll for the shopify global to become available
  useEffect(() => {
    let attempts = 0;
    const maxAttempts = 50; // 5 seconds max wait

    const checkShopify = () => {
      const shopify = (window as any).shopify;

      if (shopify && typeof shopify.idToken === "function") {
        console.log("[ShopifyProvider] Shopify global found after", attempts, "attempts");
        setShopifyGlobal(shopify);
        return true;
      }

      attempts++;
      if (attempts >= maxAttempts) {
        console.error("[ShopifyProvider] Shopify global not found after", maxAttempts, "attempts");
        // Still mark as ready but with null shopify - will show landing page
        setIsReady(true);
        return true;
      }

      return false;
    };

    // Check immediately
    if (checkShopify()) return;

    // Poll every 100ms
    const interval = setInterval(() => {
      if (checkShopify()) {
        clearInterval(interval);
      }
    }, 100);

    return () => clearInterval(interval);
  }, []);

  // Create token getter that uses the current shopify global
  const getSessionToken = useCallback(async () => {
    const shopify = shopifyGlobal || (window as any).shopify;

    if (!shopify || typeof shopify.idToken !== "function") {
      console.error("[ShopifyProvider] Cannot get token - shopify.idToken not available");
      return null;
    }

    try {
      const token = await shopify.idToken();
      console.log("[ShopifyProvider] Got session token:", token ? "yes" : "no");
      return token || null;
    } catch (e) {
      console.error("[ShopifyProvider] Failed to get session token:", e);
      return null;
    }
  }, [shopifyGlobal]);

  // Set up the token getter when shopify becomes available
  useEffect(() => {
    if (shopifyGlobal) {
      console.log("[ShopifyProvider] Setting up token getter");
      setSessionTokenGetter(getSessionToken);
      setIsReady(true);
    }
  }, [shopifyGlobal, getSessionToken]);

  const value = useMemo<ShopifyContextValue>(() => ({
    isEmbedded: true,
    isReady,
    getSessionToken,
  }), [isReady, getSessionToken]);

  // Don't render children until we're ready
  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading Shopify...</div>
      </div>
    );
  }

  return (
    <ShopifyContext.Provider value={value}>
      {children}
    </ShopifyContext.Provider>
  );
}

// Non-embedded fallback (for development outside Shopify)
function NonEmbeddedProvider({ children }: { children: ReactNode }) {
  const value = useMemo<ShopifyContextValue>(() => ({
    isEmbedded: false,
    isReady: true,
    getSessionToken: async () => null,
  }), []);

  return (
    <ShopifyContext.Provider value={value}>
      {children}
    </ShopifyContext.Provider>
  );
}

interface ShopifyProviderProps {
  children: ReactNode;
}

export function ShopifyProvider({ children }: ShopifyProviderProps) {
  // In App Bridge v4, the shopify global is injected by Shopify when embedded
  // useAppBridge() returns this global or throws if not available
  if (!isShopifyEmbedded()) {
    return <NonEmbeddedProvider>{children}</NonEmbeddedProvider>;
  }

  return <ShopifyEmbeddedProvider>{children}</ShopifyEmbeddedProvider>;
}
