import { QueryClient, QueryFunction } from "@tanstack/react-query";

// ─────────────────────────────────────────────────────────────────────────────
// Session token — Shopify App Bridge v4
//
// window.shopify is injected by Shopify's CDN <script> when the app runs
// inside the Shopify Admin iframe.  We never cache it: idToken() always
// returns a fresh, short-lived JWT so we call it on every request.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wait up to `timeoutMs` for window.shopify.idToken to appear, then return
 * a fresh Shopify session token (JWT).  Returns null if unavailable.
 */
async function getSessionToken(timeoutMs = 5000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;

  // Inner retry loop — keeps trying every 50 ms until bridge is ready or deadline
  const attempt = async (): Promise<string | null> => {
    const shopify = (window as any).shopify;

    if (shopify && typeof shopify.idToken === "function") {
      try {
        const token = await Promise.race<string | null>([
          shopify.idToken() as Promise<string>,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);
        if (import.meta.env.DEV) {
          console.log("[apiFetch] session token obtained:", token ? "✓" : "null");
        }
        return token ?? null;
      } catch (e) {
        console.error("[apiFetch] idToken() threw:", e);
        return null;
      }
    }

    if (Date.now() >= deadline) {
      console.warn("[apiFetch] window.shopify not available within timeout");
      return null;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    return attempt();
  };

  return attempt();
}

async function buildAuthHeaders(): Promise<Record<string, string>> {
  const token = await getSessionToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// apiFetch — single fetch wrapper used by everything in the admin
// ─────────────────────────────────────────────────────────────────────────────

export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const authHeaders = await buildAuthHeaders();

  if (import.meta.env.DEV && typeof input === "string" && input.includes("/api/merchant")) {
    console.log("[apiFetch] /api/merchant Authorization present:", !!authHeaders.Authorization);
  }

  const headers = new Headers(init.headers);
  if (authHeaders.Authorization) {
    headers.set("Authorization", authHeaders.Authorization);
  }
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(input, { ...init, headers, credentials: "include" });
}

// ─────────────────────────────────────────────────────────────────────────────
// apiRequest — used by mutations (method + url + optional JSON body)
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

// Trigger refetch for all auth-gated queries (call after bridge becomes ready)
export function invalidateAuthQueries() {
  queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
  queryClient.invalidateQueries({ queryKey: ["/api/merchant"] });
  queryClient.invalidateQueries({ queryKey: ["/api/appai/customizer-pages"] });
  queryClient.invalidateQueries({ queryKey: ["/api/appai/plan"] });
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy compatibility — some callers still use setSessionTokenGetter.
// Keep the export so the compiler doesn't error, but make it a no-op since
// getSessionToken now reads window.shopify directly.
// ─────────────────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function setSessionTokenGetter(_getter: () => Promise<string | null>) {
  // no-op: token is obtained directly from window.shopify.idToken()
}
