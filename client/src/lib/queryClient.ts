import { QueryClient, QueryFunction } from "@tanstack/react-query";

// Global token getter - set by ShopifyProvider when mounted
let sessionTokenGetter: (() => Promise<string | null>) | null = null;

export function setSessionTokenGetter(getter: () => Promise<string | null>) {
  console.log("[QueryClient] setSessionTokenGetter called");
  sessionTokenGetter = getter;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  // --- Attempt 1: use the registered getter (set by ShopifyProvider once App Bridge is ready) ---
  if (sessionTokenGetter) {
    try {
      const tokenPromise = sessionTokenGetter();
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 5000)
      );
      const token = await Promise.race([tokenPromise, timeoutPromise]);
      if (token) return { Authorization: `Bearer ${token}` };
    } catch (e) {
      console.error("[QueryClient] sessionTokenGetter failed:", e);
    }
  }

  // --- Attempt 2: direct fallback — call window.shopify.idToken() when App Bridge is present
  // but setSessionTokenGetter hasn't been called yet (race on initial render) ---
  const shopify = (window as any).shopify;
  if (shopify && typeof shopify.idToken === "function") {
    try {
      const tokenPromise = shopify.idToken() as Promise<string | null>;
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 3000)
      );
      const token = await Promise.race([tokenPromise, timeoutPromise]);
      if (token) return { Authorization: `Bearer ${token}` };
    } catch (e) {
      console.error("[QueryClient] window.shopify.idToken() fallback failed:", e);
    }
  }

  return {};
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const authHeaders = await getAuthHeaders();
  const res = await fetch(url, {
    method,
    headers: {
      ...authHeaders,
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const url = queryKey[0] as string;
    console.log("[QueryClient] getQueryFn fetching:", url);

    try {
      const authHeaders = await getAuthHeaders();
      console.log("[QueryClient] Making request to:", url, "with auth:", !!authHeaders.Authorization);

      const res = await fetch(url, {
        credentials: "include",
        headers: authHeaders,
      });

      console.log("[QueryClient] Response for", url, "- status:", res.status);

      if (unauthorizedBehavior === "returnNull" && res.status === 401) {
        console.log("[QueryClient] Got 401, returning null for:", url);
        return null;
      }

      await throwIfResNotOk(res);
      const data = await res.json();
      console.log("[QueryClient] Success for:", url);
      return data;
    } catch (error) {
      console.error("[QueryClient] Error fetching:", url, error);
      if (unauthorizedBehavior === "returnNull") {
        console.log("[QueryClient] Returning null due to error for:", url);
        return null;
      }
      throw error;
    }
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

// Invalidate auth-related queries so they refetch with the new token getter
export function invalidateAuthQueries() {
  console.log("[QueryClient] invalidateAuthQueries called");
  queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
  queryClient.invalidateQueries({ queryKey: ["/api/merchant"] });
  queryClient.invalidateQueries({ queryKey: ["/api/customer"] });
}
