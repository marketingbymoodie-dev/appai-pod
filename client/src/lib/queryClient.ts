/**
 * API client for all /api/* requests.
 *
 * Auth strategy:
 *   In embedded Shopify Admin, the App Bridge v4 CDN script (app-bridge.js)
 *   monkey-patches window.fetch to automatically inject an OIDC session token
 *   in the Authorization header on every same-origin request.
 *   We do NOT need to do anything special — just call fetch() normally.
 *
 *   In non-embedded mode (customer storefront, dev), cookie-based auth is
 *   used via credentials: "include".
 */
import { QueryClient, QueryFunction } from "@tanstack/react-query";

// ─────────────────────────────────────────────────────────────────────────────
// apiFetch — single fetch wrapper for all /api/* calls.
// App Bridge v4 patches window.fetch, so Authorization is injected for us.
// ─────────────────────────────────────────────────────────────────────────────

export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(input, { ...init, headers, credentials: "include" });
}

// ─────────────────────────────────────────────────────────────────────────────
// apiRequest — convenience wrapper for mutations
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

// Invalidate auth-gated queries (called once App Bridge patches fetch)
export function invalidateAuthQueries() {
  queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
  queryClient.invalidateQueries({ queryKey: ["/api/merchant"] });
  queryClient.invalidateQueries({ queryKey: ["/api/appai/customizer-pages"] });
  queryClient.invalidateQueries({ queryKey: ["/api/appai/plan"] });
}

// Legacy no-op kept so existing imports compile without changes
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function setSessionTokenGetter(_getter: () => Promise<string | null>) {
  // no-op: App Bridge v4 patches fetch automatically
}
