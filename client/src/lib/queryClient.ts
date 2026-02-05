import { QueryClient, QueryFunction } from "@tanstack/react-query";

// Global token getter - set by ShopifyProvider when mounted
let sessionTokenGetter: (() => Promise<string | null>) | null = null;

export function setSessionTokenGetter(getter: () => Promise<string | null>) {
  console.log("[QueryClient] setSessionTokenGetter called");
  sessionTokenGetter = getter;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  console.log("[QueryClient] getAuthHeaders called, hasTokenGetter:", !!sessionTokenGetter);
  if (!sessionTokenGetter) {
    console.log("[QueryClient] No token getter, returning empty headers");
    return {};
  }
  try {
    console.log("[QueryClient] Calling sessionTokenGetter...");
    // Add overall timeout for the token getter
    const tokenPromise = sessionTokenGetter();
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => {
        console.warn("[QueryClient] Token getter timed out after 8s");
        resolve(null);
      }, 8000)
    );
    const token = await Promise.race([tokenPromise, timeoutPromise]);
    console.log("[QueryClient] getAuthHeaders got token:", token ? "yes" : "no");
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  } catch (e) {
    console.error("[QueryClient] Error getting token:", e);
    return {};
  }
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
    const authHeaders = await getAuthHeaders();
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
      headers: authHeaders,
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
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
