import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { getShopifySessionToken } from "./shopify-bridge";

// ─────────────────────────────────────────────────────────────────────────────
// Auth headers
//
// Uses App Bridge v3 getSessionToken(app) — postMessage to the Shopify Admin
// parent frame.  Works regardless of URL params after SPA navigation.
// ─────────────────────────────────────────────────────────────────────────────

async function buildAuthHeaders(): Promise<Record<string, string>> {
  const token = await getShopifySessionToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// apiFetch — single authenticated fetch wrapper for all /api/* calls
// ─────────────────────────────────────────────────────────────────────────────

export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const authHeaders = await buildAuthHeaders();

  if (import.meta.env.DEV) {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/merchant")) {
      console.log(
        "[apiFetch] /api/merchant — Authorization present:",
        !!authHeaders.Authorization,
      );
    }
  }

  const headers = new Headers(init.headers);
  if (authHeaders.Authorization) {
    headers.set("Authorization", authHeaders.Authorization);
  }
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(input, { ...init, headers, credentials: "include" });
}

// ─────────────────────────────────────────────────────────────────────────────
// apiRequest — convenience wrapper for mutations (method + url + JSON body)
// ─────────────────────────────────────────────────────────────────────────────

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown,
): Promise<Response> {
  const res = await apiFetch(url, {
    method,
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });
  await throwIfResNotOk(res);
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// React Query helpers
// ─────────────────────────────────────────────────────────────────────────────

type UnauthorizedBehavior = "returnNull" | "throw";

export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const url = queryKey[0] as string;
    const res = await apiFetch(url);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return res.json();
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

// Invalidate auth-gated queries (called when App Bridge becomes available)
export function invalidateAuthQueries() {
  queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
  queryClient.invalidateQueries({ queryKey: ["/api/merchant"] });
  queryClient.invalidateQueries({ queryKey: ["/api/appai/customizer-pages"] });
  queryClient.invalidateQueries({ queryKey: ["/api/appai/plan"] });
}

// Legacy no-op — token acquisition no longer uses a registered getter
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function setSessionTokenGetter(_getter: () => Promise<string | null>) {
  // no-op: token is obtained directly via getShopifySessionToken()
}
