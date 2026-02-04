import { createContext, useContext, useMemo, useEffect, ReactNode } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { setSessionTokenGetter } from "./queryClient";

// Check if we're running inside Shopify Admin (shopify global exists)
export function isShopifyEmbedded(): boolean {
  return typeof window !== "undefined" && "shopify" in window;
}

interface ShopifyContextValue {
  isEmbedded: boolean;
  getSessionToken: () => Promise<string | null>;
}

const ShopifyContext = createContext<ShopifyContextValue>({
  isEmbedded: false,
  getSessionToken: async () => null,
});

export function useShopify() {
  return useContext(ShopifyContext);
}

// Provider that uses Shopify App Bridge
function ShopifyEmbeddedProvider({ children }: { children: ReactNode }) {
  const shopify = useAppBridge();

  const getSessionToken = useMemo(() => async () => {
    try {
      const token = await shopify.idToken();
      return token || null;
    } catch (e) {
      console.error("Failed to get Shopify session token:", e);
      return null;
    }
  }, [shopify]);

  // Register the token getter globally so queryClient can use it
  useEffect(() => {
    setSessionTokenGetter(getSessionToken);
  }, [getSessionToken]);

  const value = useMemo<ShopifyContextValue>(() => ({
    isEmbedded: true,
    getSessionToken,
  }), [getSessionToken]);

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
