/**
 * Storefront-iframe-safe fetch wrapper.
 *
 * ROOT CAUSE (confirmed via diagnostic deploy 2026-03-02 — this comment kept
 * verbatim from the original location in `embed-design.tsx`):
 *   Shopify registers a service worker on the storefront domain that
 *   intercepts ALL window.fetch() calls via its `fetch` event handler. For
 *   App Proxy paths like /apps/appai/api/*, the SW does not know how to
 *   handle these requests and never responds — the fetch Promise hangs
 *   forever. XMLHttpRequest is NOT intercepted by service workers (SW only
 *   catches fetch events, not XHR). XHR resolves in ~855ms while every
 *   window.fetch() call times out at 30s with no network request visible.
 *
 * This module is the shared place to import `safeFetch` from. Any new code
 * that runs inside the storefront iframe (path starts with `/apps/appai/s/`)
 * must use `safeFetch` instead of `window.fetch` to avoid the SW hang.
 */

const _isStorefrontIframe =
  typeof window !== "undefined" &&
  window.location.pathname.startsWith("/apps/appai/s/");

/**
 * XHR-based fetch replacement. Wraps XMLHttpRequest in a Promise that
 * returns a `Response`-like object compatible with `.json()` / `.text()` /
 * `.blob()` / `.ok` / `.status`.
 */
function xhrFetch(url: string, options: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const method = (options.method || "GET").toUpperCase();
    xhr.open(method, url);
    // Always request a Blob so binary bodies (PNG, JPEG, SVG) are not corrupted.
    xhr.responseType = "blob";

    if (options.headers) {
      const h = options.headers as Record<string, string>;
      Object.keys(h).forEach((k) => xhr.setRequestHeader(k, h[k]));
    }

    xhr.onload = () => {
      const responseHeaders = new Headers();
      xhr.getAllResponseHeaders().trim().split(/[\r\n]+/).forEach((line) => {
        const parts = line.split(": ");
        if (parts.length >= 2) responseHeaders.append(parts[0], parts.slice(1).join(": "));
      });

      const resp = new Response(xhr.response as Blob, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers: responseHeaders,
      });
      resolve(resp);
    };
    xhr.onerror = () => reject(new TypeError("Network request failed"));
    xhr.ontimeout = () => reject(new DOMException("Request timed out", "AbortError"));

    if (options.signal) {
      const sig = options.signal;
      if (sig.aborted) {
        reject(new DOMException("Request aborted", "AbortError"));
        return;
      }
      sig.addEventListener(
        "abort",
        () => {
          xhr.abort();
          reject(new DOMException("Request aborted", "AbortError"));
        },
        { once: true },
      );
    }

    xhr.send((options.body as XMLHttpRequestBodyInit | null) ?? null);
  });
}

/**
 * Service-worker-safe fetch. Uses XHR in the storefront iframe (where
 * Shopify's SW breaks `window.fetch` for App Proxy paths) and `window.fetch`
 * everywhere else. Default timeout 30s.
 */
export const safeFetch = async (
  url: string | RequestInfo | URL,
  options: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> => {
  const controller = new AbortController();
  const started = Date.now();

  const timeoutId = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.log(
      "[safeFetch] timeout firing after",
      Date.now() - started,
      "ms for",
      String(url).substring(0, 100),
    );
    controller.abort();
  }, timeoutMs);

  const callerSignal = options.signal as AbortSignal | undefined | null;
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timeoutId);
      throw new DOMException("Request aborted", "AbortError");
    }
    callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const urlStr = String(url);
    const impl = _isStorefrontIframe ? "xhr" : "fetch";
    // eslint-disable-next-line no-console
    console.log(`[safeFetch] calling ${impl}`, urlStr.substring(0, 120));

    let res: Response;
    if (_isStorefrontIframe) {
      res = await xhrFetch(urlStr, { ...options, signal: controller.signal });
    } else {
      res = await window.fetch(url as RequestInfo, {
        ...options,
        signal: controller.signal,
        credentials: "same-origin",
      });
    }

    // eslint-disable-next-line no-console
    console.log("[safeFetch] resolved", urlStr, res.status, Date.now() - started, "ms");
    return res;
  } catch (err: unknown) {
    // eslint-disable-next-line no-console
    console.log(
      "[safeFetch] error",
      (err as { name?: string })?.name,
      Date.now() - started,
      "ms",
      String(url).substring(0, 100),
    );
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};

export const isStorefrontIframe = (): boolean => _isStorefrontIframe;
