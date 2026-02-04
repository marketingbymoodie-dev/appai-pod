import { createContext, useContext, useMemo, useState, useEffect, ReactNode } from "react";
import { setSessionTokenGetter } from "./queryClient";

// Check if we're running inside Shopify Admin (shopify global exists)
export function isShopifyEmbedded(): boolean {
  return typeof window !== "undefined" && "shopify" in window;
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

  // Get the shopify global directly (injected by Shopify when embedded)
  const shopify = typeof window !== "undefined" ? (window as any).shopify : null;

  const getSessionToken = useMemo(() => async () => {
    if (!shopify) {
      console.error("Shopify global not available");
      return null;
    }
    try {
      const token = await shopify.idToken();
      return token || null;
    } catch (e) {
      console.error("Failed to get Shopify session token:", e);
      return null;
    }
  }, [shopify]);

  // Set up the token getter immediately on mount
  useEffect(() => {
    if (shopify) {
      setSessionTokenGetter(getSessionToken);
      setIsReady(true);
    }
  }, [shopify, getSessionToken]);

  const value = useMemo<ShopifyContextValue>(() => ({
    isEmbedded: true,
    isReady,
    getSessionToken,
  }), [isReady, getSessionToken]);

  // Don't render children until we're ready
  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
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
