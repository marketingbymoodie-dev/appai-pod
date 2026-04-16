import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { API_BASE, PROXY_PREFIX, buildAppUrl } from "@/lib/urlBase";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Loader2, Sparkles, ImagePlus, ShoppingCart, RefreshCw, RefreshCcw, X, Save, LogIn, Share2, Upload, ExternalLink, CheckCircle, ChevronLeft, ChevronRight, Info, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  ProductMockup,
  ZoomControls,
  FrameColorSelector,
  SizeSelector,
  StyleSelector,
  PatternCustomizer,
  type ImageTransform,
  type PrintSize,
  type FrameColor,
  type StylePreset,
  type DesignerType,
  type PrintShape,
  type CanvasConfig,
  type AopPlacementSettings,
} from "@/components/designer";

interface CustomerInfo {
  id: string;
  email?: string;
  credits: number;
  freeGenerationsUsed?: number;
  isLoggedIn: boolean;
}

interface GeneratedDesign {
  id: string;
  imageUrl: string;
  prompt: string;
}

interface ProductTypeConfig {
  id: number;
  name: string;
  description: string | null;
  aspectRatio: string;
  designerType?: DesignerType;
  printShape?: PrintShape;
  canvasConfig?: CanvasConfig;
  sizes: Array<{ id: string; name: string; width: number; height: number }>;
  frameColors: Array<{ id: string; name: string; hex: string }>;
  hasPrintifyMockups?: boolean;
  baseMockupImages?: Record<string, string>;
  isAllOverPrint?: boolean;
  placeholderPositions?: { position: string; width: number; height: number }[];
  panelFlatLayImages?: Record<string, string>;
  colorLabel?: string;
  printifyBlueprintId?: number;
}

// API_BASE and buildAppUrl imported from @/lib/urlBase

// Build stamp for deployment verification
const BUILD_TIMESTAMP = new Date().toISOString();
const BUILD_COMMIT = "cc5dfd6"; // Latest commit with printifyBlueprintId fix

console.log("[AOP BUILD]", {
  build: BUILD_TIMESTAMP,
  commit: BUILD_COMMIT,
  file: "embed-design.tsx",
  timestamp: Date.now(),
});

/**
 * Parse JSON from a Response, with a guard against HTML responses.
 * Throws a descriptive error instead of cryptic "Unexpected token <".
 */
async function safeJson<T = any>(res: Response, label?: string): Promise<T> {
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json") && !ct.includes("text/json")) {
    const text = await res.text().catch(() => "(unreadable)");
    throw new Error(
      `Expected JSON from ${label ?? res.url} but got ${ct || "no content-type"}. ` +
      `Status ${res.status}. Body: ${text.slice(0, 200)}`
    );
  }
  return res.json() as Promise<T>;
}

/** Check if a URL is a base64 data URL */
function isDataUrl(url: string): boolean {
  return !!url && url.startsWith("data:");
}

/**
 * Convert a CSS color string (rgb(), rgba(), or #hex) to an HSL string
 * in the format expected by the app's CSS variables: "H S% L%"
 * (no hsl() wrapper, just the values, as that's what Tailwind/shadcn use).
 * Returns null if the color cannot be parsed or is transparent.
 */
function cssColorToHSL(color: string | undefined | null): string | null {
  if (!color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return null;

  // Parse rgb(r, g, b) or rgba(r, g, b, a)
  const rgbMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/);
  if (rgbMatch) {
    let r = parseInt(rgbMatch[1]) / 255;
    let g = parseInt(rgbMatch[2]) / 255;
    let b = parseInt(rgbMatch[3]) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    const hDeg = Math.round(h * 360);
    const sPct = Math.round(s * 100);
    const lPct = Math.round(l * 100);
    return `${hDeg} ${sPct}% ${lPct}%`;
  }

  // Parse #hex or #rrggbb
  const hexMatch = color.match(/^#([0-9a-f]{3,8})$/i);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length === 6) {
      const r2 = parseInt(hex.slice(0, 2), 16) / 255;
      const g2 = parseInt(hex.slice(2, 4), 16) / 255;
      const b2 = parseInt(hex.slice(4, 6), 16) / 255;
      return cssColorToHSL(`rgb(${Math.round(r2*255)}, ${Math.round(g2*255)}, ${Math.round(b2*255)})`);
    }
  }

  return null;
}

/**
 * Given an HSL string "H S% L%", return a lighter or darker version
 * by adjusting lightness by the given delta (-100 to +100).
 */
function adjustHSLLightness(hsl: string, delta: number): string {
  const parts = hsl.match(/^(\d+)\s+(\d+)%\s+(\d+)%$/);
  if (!parts) return hsl;
  const h = parts[1], s = parts[2];
  const l = Math.max(0, Math.min(100, parseInt(parts[3]) + delta));
  return `${h} ${s}% ${l}%`;
}

/**
 * Resolve an image URL to an absolute URL suitable for sending to the backend.
 * Handles three cases:
 * - Already absolute (http/https) → pass through
 * - data: URL → pass through (caller MUST use ensureHostedUrl before sending to backend APIs)
 * - Relative path (/objects/...) → prepend API_BASE
 */
function toAbsoluteImageUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (isDataUrl(url)) return url;
  return buildAppUrl(url);
}

/**
 * Convert a data URL to a Blob for upload.
 */
function dataUrlToBlob(dataUrl: string): Blob {
  const [header, b64] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)?.[1] || "image/png";
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/**
 * Ensure a URL is a publicly-accessible hosted URL (https://...).
 * If the input is a data URL, uploads it to object storage first.
 * If the input is a relative path, resolves it to an absolute URL.
 * If the input is already an https URL, passes through.
 */
async function ensureHostedUrl(url: string): Promise<string> {
  if (!url) throw new Error("No image URL provided");

  // Already hosted — pass through
  if (url.startsWith("https://") || url.startsWith("http://")) return url;

  // Relative path — resolve to absolute (buildAppUrl prevents double-prefix)
  if (url.startsWith("/")) return buildAppUrl(url);

  // data: URL — upload directly to server storage
  if (isDataUrl(url)) {
    console.log("[EmbedDesign] Converting data URL to hosted URL via direct upload...");
    const uploadRes = await safeFetch(`${API_BASE}/api/uploads/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: url, name: `design-${Date.now()}.png` }),
    });
    if (!uploadRes.ok) throw new Error("Failed to upload design image to storage");
    const { objectPath } = await uploadRes.json();
    const hostedUrl = buildAppUrl(objectPath);
    console.log("[EmbedDesign] Data URL uploaded, hosted URL:", hostedUrl);
    return hostedUrl;
  }

  throw new Error(`Unsupported URL format: ${url.substring(0, 30)}...`);
}

/**
 * Normalise a Shopify variant ID to its numeric form.
 * Accepts GID format ("gid://shopify/ProductVariant/12345") or plain numeric ("12345").
 * Returns the numeric string, or the original value if it can't be parsed.
 */
function normalizeVariantId(raw: string | number): string {
  const s = String(raw);
  // GID format: gid://shopify/ProductVariant/12345
  const gidMatch = s.match(/\/(\d+)$/);
  if (gidMatch) return gidMatch[1];
  // Already numeric
  if (/^\d+$/.test(s)) return s;
  // Fallback — return as-is and let Shopify reject if invalid
  console.warn('[Design Studio] Unexpected variant ID format:', s);
  return s;
}

/**
 * Safe fetch that bypasses Shopify App Bridge's monkey-patched window.fetch.
 *
 * App Bridge intercepts fetch() to inject session tokens via postMessage to the
 * Shopify admin parent. In STOREFRONT mode there is no admin parent, so the
 * token handshake hangs forever and every fetch() silently blocks.
 *
 * The hidden iframe must stay in the DOM — removing it kills the browsing context
 * and makes the extracted fetch silently hang (the original bug).
 */
/**
 * XHR-based fetch replacement for Shopify storefront iframes.
 *
 * ROOT CAUSE (confirmed via diagnostic deploy 2026-03-02):
 * Shopify registers a service worker on the storefront domain that intercepts
 * ALL window.fetch() calls via its `fetch` event handler. For App Proxy paths
 * like /apps/appai/api/*, the SW does not know how to handle these requests
 * and never responds — the fetch Promise hangs forever.
 *
 * XMLHttpRequest is NOT intercepted by service workers (SW only catches fetch
 * events, not XHR). Our diagnostic proved XHR resolves in ~855ms while every
 * window.fetch() call times out at 30s with no network request visible.
 *
 * This function wraps XHR in a Promise that returns a Response-like object
 * compatible with our existing .json() / .text() / .ok / .status usage.
 */
function xhrFetch(url: string, options: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const method = (options.method || 'GET').toUpperCase();
    xhr.open(method, url);

    if (options.headers) {
      const h = options.headers as Record<string, string>;
      Object.keys(h).forEach(k => xhr.setRequestHeader(k, h[k]));
    }

    xhr.onload = () => {
      const responseHeaders = new Headers();
      xhr.getAllResponseHeaders().trim().split(/[\r\n]+/).forEach(line => {
        const parts = line.split(': ');
        if (parts.length >= 2) responseHeaders.append(parts[0], parts.slice(1).join(': '));
      });

      const body = xhr.responseText;
      const resp = new Response(body, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers: responseHeaders,
      });
      resolve(resp);
    };
    xhr.onerror = () => reject(new TypeError('Network request failed'));
    xhr.ontimeout = () => reject(new DOMException('Request timed out', 'AbortError'));

    if (options.signal) {
      const sig = options.signal;
      if (sig.aborted) {
        reject(new DOMException('Request aborted', 'AbortError'));
        return;
      }
      sig.addEventListener('abort', () => { xhr.abort(); reject(new DOMException('Request aborted', 'AbortError')); }, { once: true });
    }

    xhr.send(options.body as XMLHttpRequestBodyInit | null ?? null);
  });
}

const _isStorefrontIframe = typeof window !== 'undefined' &&
  window.location.pathname.startsWith('/apps/appai/s/');

/**
 * Core fetch wrapper — uses XHR in Shopify storefront iframes (where window.fetch
 * is broken by Shopify's service worker) and window.fetch everywhere else.
 */
const safeFetch = async (url: string | RequestInfo | URL, options: RequestInit = {}, timeoutMs = 30000): Promise<Response> => {
  const controller = new AbortController();
  const started = Date.now();

  const timeoutId = setTimeout(() => {
    console.log("[safeFetch] timeout firing after", Date.now() - started, "ms for", String(url).substring(0, 100));
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
    const urlStr = String(url).substring(0, 120);
    const impl = _isStorefrontIframe ? 'xhr' : 'fetch';
    console.log(`[safeFetch] calling ${impl}`, urlStr);

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

    console.log("[safeFetch] resolved", urlStr, res.status, Date.now() - started, "ms");
    return res;
  } catch (err: any) {
    console.log("[safeFetch] error", err?.name, Date.now() - started, "ms", String(url).substring(0, 100));
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * Module-scoped timeout wrapper for use outside of useEffect closures (e.g. useMutation).
 * Does not depend on any closure state; safe to call anywhere in the component.
 * clearTimeout runs in finally — guaranteed regardless of how the promise settles.
 */
async function fetchWithTimeoutSimple(
  url: string,
  options: RequestInit = {},
  timeout = 90000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await safeFetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    return res;
  } catch (err: any) {
    if (controller.signal.aborted) {
      throw new Error(`Request to ${url.substring(0, 80)} timed out after ${timeout}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Module-level singleton guard — prevents re-initialization if the module is
// evaluated more than once or if React StrictMode double-mounts the component.
let __embedInstanceActive = false;

console.log('[EmbedDesign] API Base URL:', API_BASE, '| path:', typeof window !== 'undefined' ? window.location.pathname : 'ssr');
console.log('[EmbedDesign] safeFetch impl:', _isStorefrontIframe ? 'XHR (storefront iframe)' : 'window.fetch');

// DIAGNOSTIC: Quick sanity check on module load using safeFetch (runs once)
if (typeof window !== 'undefined' && !(window as any).__APP_AI_EMBED_PINGED__) {
  (window as any).__APP_AI_EMBED_PINGED__ = true;
  const pingUrl = `${API_BASE}/api/storefront/ping`;
  const start = Date.now();
  safeFetch(pingUrl)
    .then(r => safeJson(r, '/api/storefront/ping'))
    .then(data => console.log(`[EmbedDesign] Ping OK in ${Date.now() - start}ms:`, data))
    .catch(err => console.error(`[EmbedDesign] Ping FAILED in ${Date.now() - start}ms:`, err.message));
}


/**
 * Runtime mode detection for the embed.
 *
 * Modes:
 * - storefront: Embedded on Shopify storefront (storefront=true). NO session token, uses public /api/storefront/* endpoints.
 * - admin-embedded: Embedded in Shopify admin (embedded=true, shopify=true). Uses App Bridge and session tokens.
 * - standalone: Direct access without Shopify context. Uses standard auth.
 */
type RuntimeMode = 'storefront' | 'admin-embedded' | 'standalone';

function detectRuntimeMode(params: URLSearchParams): RuntimeMode {
  const path = window.location.pathname;

  // App Proxy path: /apps/appai/s/designer (iframe on Shopify domain via proxy)
  if (path.startsWith(`${PROXY_PREFIX}/s/`)) return 'storefront';

  // Direct Railway path: /s/designer
  if (path.startsWith('/s/')) return 'storefront';

  // Admin embedded
  if (path.startsWith('/admin/') || path === '/admin') return 'admin-embedded';

  // Legacy query-param fallback for /embed/design URLs
  if (params.get("storefront") === "true") return 'storefront';
  if (params.get("embedded") === "true" && params.get("shopify") === "true") return 'admin-embedded';

  return 'standalone';
}

export default function EmbedDesign() {
  const searchParams = new URLSearchParams(window.location.search);

  // Detect runtime mode
  const runtimeMode = detectRuntimeMode(searchParams);

  // Legacy params - kept for backwards compatibility
  // Storefront mode must override embedded Shopify mode: when both
  // storefront=true and shopify=true appear in the URL, storefront wins.
  const isEmbedded = searchParams.get("embedded") === "true";
  const isStorefront = runtimeMode === 'storefront';
  const isShopify = !isStorefront && searchParams.get("shopify") === "true";

  // Key behavioral flags based on runtime mode
  const requiresSessionToken = runtimeMode === 'admin-embedded';
  const usesPublicStorefrontApi = runtimeMode === 'storefront';

  // Anonymous session ID for storefront free-generation tracking.
  // Persisted in localStorage so it survives page refreshes.
  const [anonSessionId] = useState(() => {
    if (!isStorefront) return '';
    const key = 'appai_session';
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  });

  // Ref for the pre-shadow product poll timer — declared early so the mount cleanup can reference it.
  const preShadowPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Merge anonymous session into customer account when customer is logged in.
  // Fire once on mount; backend is idempotent so re-merging is safe.
  const mergeSessionRan = useRef(false);
  useEffect(() => {
    const custId = searchParams.get("customerId") || '';
    if (!isStorefront || !anonSessionId || !custId || mergeSessionRan.current) return;
    mergeSessionRan.current = true;

    const shop = searchParams.get("shop") || '';
    if (!shop) return;

    safeFetch(`${API_BASE}/api/storefront/merge-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: anonSessionId, customerId: custId, shop }),
    }).then(r => {
      if (r.ok) console.log('[EmbedDesign] Session merged into customer', custId);
      else console.warn('[EmbedDesign] merge-session failed:', r.status);
    }).catch(e => console.warn('[EmbedDesign] merge-session error:', e));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const productTypeId = searchParams.get("productTypeId") || "1";
  const productId = searchParams.get("productId") || "";

  // Log all URL parameters for debugging
  // Compute endpoint prefixes once for logging and assertions
  const storefrontApiPrefix = `${API_BASE}/api/storefront`;
  const shopifyApiPrefix = `${API_BASE}/api/shopify`;
  const endpointBase = isStorefront ? storefrontApiPrefix : isShopify ? shopifyApiPrefix : `${API_BASE}/api`;

  // Singleton guard — prevents the heavy init work from running if a second
  // instance of this component mounts (e.g. StrictMode double-mount or stale iframe).
  const isDuplicate = useRef(false);
  useEffect(() => {
    if (__embedInstanceActive) {
      isDuplicate.current = true;
      console.warn('[EmbedDesign] Duplicate mount detected — skipping init');
      return;
    }
    __embedInstanceActive = true;
    isDuplicate.current = false;

    console.log('[EmbedDesign] === INITIALIZATION ===');
    console.log('[EmbedDesign] Full URL:', window.location.href);
    console.log('[EmbedDesign] Runtime mode:', runtimeMode);
    console.log('[EmbedDesign] Endpoints: generate=%s/generate, mockup=%s/mockup', endpointBase, endpointBase);
    console.log('[EmbedDesign] productTypeId from URL:', searchParams.get("productTypeId"), '(using:', productTypeId, ')');
    console.log('[EmbedDesign] shop from URL:', searchParams.get("shop"));
    console.log('[EmbedDesign] isStorefront:', isStorefront, 'requiresSessionToken:', requiresSessionToken);
    if (isStorefront && requiresSessionToken) {
      console.error('[EmbedDesign] BUG: isStorefront=true but requiresSessionToken=true — this should never happen');
    }

    return () => {
      __embedInstanceActive = false;
      // Clean up pre-shadow poll timer on unmount
      if (preShadowPollRef.current) clearTimeout(preShadowPollRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  
  // Get productHandle from URL params, or extract from referrer if not provided
  const getProductHandle = (): string => {
    const handleFromParams = searchParams.get("productHandle") || "";
    if (handleFromParams) {
      console.log('[Design Studio] Using productHandle from params:', handleFromParams);
      return handleFromParams;
    }
    
    // Try to extract from referrer (e.g., https://store.myshopify.com/products/custom-tumbler-20oz)
    try {
      const referrer = document.referrer;
      console.log('[Design Studio] Attempting to extract productHandle from referrer:', referrer);
      if (referrer) {
        const match = referrer.match(/\/products\/([^/?#]+)/);
        if (match && match[1]) {
          console.log('[Design Studio] Extracted productHandle from referrer:', match[1]);
          return match[1];
        } else {
          console.log('[Design Studio] No /products/ path found in referrer');
        }
      } else {
        console.log('[Design Studio] Referrer is empty');
      }
    } catch (e) {
      console.log('[Design Studio] Error extracting productHandle from referrer:', e);
    }
    console.log('[Design Studio] Could not determine productHandle');
    return "";
  };
  const productHandle = getProductHandle();
  
  const productTitle = decodeURIComponent(searchParams.get("productTitle") || "Custom Product");
  const displayName = decodeURIComponent(searchParams.get("displayName") || productTitle.replace("Custom ", ""));
  const showPresetsParam = searchParams.get("showPresets") !== "false";
  const selectedVariantParam = searchParams.get("selectedVariant") || "";
  const shopifyCustomerId = searchParams.get("customerId") || "";
  const shopifyCustomerEmail = searchParams.get("customerEmail") || "";
  const shopifyCustomerName = searchParams.get("customerName") || "";
  const sharedDesignId = searchParams.get("sharedDesignId") || "";
  const loadDesignId = searchParams.get("loadDesignId") || "";
  // parentLoadDesignId: read loadDesignId directly from the parent page URL.
  // The iframe is served on the same Shopify domain as the parent, so window.parent.location
  // is accessible (no cross-origin restriction). This bypasses the Shopify CDN-cached liquid file.
  const parentLoadDesignId = (() => {
    try {
      const parentParams = new URLSearchParams(window.parent.location.search);
      return parentParams.get('loadDesignId') || '';
    } catch {
      return ''; // cross-origin guard (shouldn't happen on same domain)
    }
  })();
  // bridgeLoadDesignId is set when the parent page sends AI_ART_STUDIO_LOAD_DESIGN via postMessage
  const [bridgeLoadDesignId, setBridgeLoadDesignId] = useState("");
  // The effective loadDesignId — prefer parent URL (most reliable), then bridge, then iframe URL param
  const effectiveLoadDesignId = parentLoadDesignId || bridgeLoadDesignId || loadDesignId;

  const [prompt, setPrompt] = useState("");
  const [isLoadingSharedDesign, setIsLoadingSharedDesign] = useState(!!sharedDesignId);
  const [sharedDesignError, setSharedDesignError] = useState<string | null>(null);
  const [isSharedDesign, setIsSharedDesign] = useState(false);
  const [selectedSize, setSelectedSize] = useState("");
  const [selectedFrameColor, setSelectedFrameColor] = useState("");
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [selectedStyleOption, setSelectedStyleOption] = useState<string>("");
  const [referenceImages, setReferenceImages] = useState<File[]>([]);
  const [referencePreviews, setReferencePreviews] = useState<string[]>([]);
  const [generatedDesign, setGeneratedDesign] = useState<GeneratedDesign | null>(null);
  const [isAddingToCart, setIsAddingToCart] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const debugBridge = searchParams.get("debugBridge") === "1";
  const [transform, setTransform] = useState<ImageTransform>({ scale: 100, x: 50, y: 50 });
  // Sequential box guide: 0 = off, 1-4 = which box is currently pulsing
  const [guideActiveBox, setGuideActiveBox] = useState<0 | 1 | 2 | 3 | 4>(0);
  const guideStoppedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Track the initial transform to detect changes for auto-save
  const initialTransformRef = useRef<ImageTransform | null>(null);

  // Ref for the artwork column — used to auto-scroll on mobile after generation
  const artworkColumnRef = useRef<HTMLDivElement | null>(null);

  const [stylePresets, setStylePresets] = useState<StylePreset[]>([]);
  const [productTypeConfig, setProductTypeConfig] = useState<ProductTypeConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [productTypeError, setProductTypeError] = useState<string | null>(null);
  const [brandingSettings, setBrandingSettings] = useState<any>(null);

  // Resolve shop domain - try URL param first, then try to extract from referrer
  // This handles cases where the theme extension hasn't been redeployed with the latest changes
  const resolveShopDomain = (): string => {
    // First try the URL param (set by theme extension via window.Shopify.shop)
    const shopParam = searchParams.get("shop") || "";
    if (shopParam && shopParam.endsWith(".myshopify.com")) {
      return shopParam;
    }
    
    // Try to get myshopify.com domain from referrer
    try {
      const referrer = document.referrer;
      if (referrer) {
        const referrerUrl = new URL(referrer);
        if (referrerUrl.hostname.endsWith(".myshopify.com")) {
          return referrerUrl.hostname;
        }
      }
    } catch (e) {
      console.warn("Failed to parse referrer for shop domain:", e);
    }
    
    // Return shopParam even if it's a custom domain - server will validate
    // Custom domains are supported for session/auth but not for variant fetching
    return shopParam;
  };
  
  // Get the myshopify.com domain specifically for API calls that require it
  const getMyShopifyDomain = (): string | null => {
    const shopParam = searchParams.get("shop") || "";
    
    // If already has .myshopify.com suffix, use it
    if (shopParam && shopParam.endsWith(".myshopify.com")) {
      return shopParam;
    }
    
    // If shop param looks like just a store name (alphanumeric with hyphens), append .myshopify.com
    if (shopParam && /^[a-z0-9][a-z0-9-]*$/i.test(shopParam)) {
      console.log('[Design Studio] Appending .myshopify.com to shop param:', shopParam);
      return `${shopParam.toLowerCase()}.myshopify.com`;
    }
    
    // Try to get from referrer
    try {
      const referrer = document.referrer;
      if (referrer) {
        const referrerUrl = new URL(referrer);
        if (referrerUrl.hostname.endsWith(".myshopify.com")) {
          return referrerUrl.hostname;
        }
      }
    } catch (e) {
      // Ignore
    }
    
    console.log('[Design Studio] Could not determine myshopify.com domain from shop param:', shopParam);
    return null;
  };
  
  const shopDomain = resolveShopDomain();
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [customer, setCustomer] = useState<CustomerInfo | null>(() => {
    try {
      const saved = localStorage.getItem('appai_customer');
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });
  const [sessionLoading, setSessionLoading] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [freeLimitReached, setFreeLimitReached] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  // OTP login state for storefront — restore from localStorage if available
  const [showOtpLogin, setShowOtpLogin] = useState(false);
  const [otpEmail, setOtpEmail] = useState(() => {
    try { return localStorage.getItem('appai_otp_email') || ''; } catch { return ''; }
  });
  const [otpCode, setOtpCode] = useState("");
  const [otpStep, setOtpStep] = useState<"email" | "code">("email");
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [storefrontCustomerId, setStorefrontCustomerId] = useState<string | null>(() => {
    try { return localStorage.getItem('appai_customer_id') || null; } catch { return null; }
  });
  const [savedDesigns, setSavedDesigns] = useState<Array<{id: string; artworkUrl: string; mockupUrls?: string[]; designState?: Record<string, any> | null; prompt: string; stylePreset?: string | null; size?: string | null; frameColor?: string | null; baseTitle: string | null; pageHandle: string | null; productTypeId: string | null; customerId?: string | null; createdAt: string}>>([]);
  const [showGalleryFullModal, setShowGalleryFullModal] = useState(false);
  const [savedDesignsLoading, setSavedDesignsLoading] = useState(false);
  const [galleryLimit, setGalleryLimit] = useState(20);
  const [showSavedDesigns, setShowSavedDesigns] = useState(false);
  const [showCouponInput, setShowCouponInput] = useState(false);
  const [couponCode, setCouponCode] = useState('');
  const [couponLoading, setCouponLoading] = useState(false);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponSuccess, setCouponSuccess] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"generate" | "import">("generate");
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [designSource, setDesignSource] = useState<"ai" | "upload" | "kittl">("ai");
  const importFileInputRef = useRef<HTMLInputElement>(null);
  const customUploadInputRef = useRef<HTMLInputElement>(null);
  
  // Printify composite mockup state
  const [printifyMockups, setPrintifyMockups] = useState<string[]>([]);
  const [printifyMockupImages, setPrintifyMockupImages] = useState<{ url: string; label: string }[]>([]);
  const [mockupLoading, setMockupLoading] = useState(false);
  // mockupTriggered: set true synchronously in onSuccess before fetchPrintifyMockups is called,
  // so there's no render-cycle gap between generateMutation.isPending=false and mockupLoading=true.
  const [mockupTriggered, setMockupTriggered] = useState(false);
  const [mockupError, setMockupError] = useState<string | null>(null);
  const [mockupFailed, setMockupFailed] = useState(false);
  const [selectedMockupIndex, setSelectedMockupIndex] = useState(0);
  const [mockupsStale, setMockupsStale] = useState(false);

  // AOP (All-Over-Print) pattern step state
  const [showPatternStep, setShowPatternStep] = useState(false);
  const [aopPendingMotifUrl, setAopPendingMotifUrl] = useState<string | null>(null);
  const [aopPatternUrl, setAopPatternUrl] = useState<string | null>(null);
  // Persisted PatternCustomizer settings — survive close/reopen of the overlay
  const [aopPatternSettings, setAopPatternSettings] = useState<{
    tilesAcross: number;
    pattern: "grid" | "brick" | "half";
    bgColor: string;
  }>({ tilesAcross: 4, pattern: "grid", bgColor: "#ffffff" });
  // Persisted Place on Item placement — survive close/reopen
  const [aopPlacementSettings, setAopPlacementSettings] = useState<AopPlacementSettings | undefined>(undefined);

  // Per-color mockup cache: instantly swap mockups when the user picks a different frame color
  const mockupColorCacheRef = useRef<Record<string, { urls: string[]; images: { url: string; label: string }[] }>>({});
  const currentMockupColorRef = useRef<string>('');
  // Suppress the stale-on-transform effect during design loading (applyLoadedDesign sets transform
  // and mockups in the same batch; we don't want that to mark the freshly-loaded mockups as stale)
  const suppressMockupStaleRef = useRef(false);
  const savedJobIdRef = useRef<string | null>(null); // tracks the jobId of the most recently generated design
  
  const [addedToCart, setAddedToCart] = useState(false);
  const { toast } = useToast();

  // Computed zoom values based on product type (apparel uses 135%, others use 100%)
  const isApparel = productTypeConfig?.designerType === "apparel";
  const defaultZoom = isApparel ? 135 : 100;
  const maxZoom = isApparel ? 135 : 200;

  // Filter styles based on designerType
  // - framed-print, pillow, mug -> "decor" category (full-bleed artwork)
  // - apparel -> "apparel" category (centered graphics)
  // - generic -> show all styles
  const filteredStylePresets = useMemo(() => {
    if (!productTypeConfig?.designerType) return stylePresets;
    
    const designerType = productTypeConfig.designerType;
    let targetCategory: "decor" | "apparel" | null = null;
    
    if (designerType === "framed-print" || designerType === "pillow" || designerType === "mug") {
      targetCategory = "decor";
    } else if (designerType === "apparel") {
      targetCategory = "apparel";
    }
    // For "generic" or unknown types, show all styles
    
    if (!targetCategory) return stylePresets;
    
    // Return styles that match the category or are "all" (universal styles)
    return stylePresets.filter(s => 
      s.category === targetCategory || s.category === "all" || !s.category
    );
  }, [stylePresets, productTypeConfig]);

  // Reset selectedPreset if it's not in the filtered list (e.g., after product type loads)
  useEffect(() => {
    if (selectedPreset && selectedPreset !== "" && filteredStylePresets.length > 0) {
      const isValidPreset = filteredStylePresets.some(p => p.id === selectedPreset);
      if (!isValidPreset) {
        setSelectedPreset("");
      }
    }
  }, [filteredStylePresets, selectedPreset]);

  const defaultProductTypeConfig: ProductTypeConfig = {
    id: 0,
    name: "Custom Print",
    description: null,
    aspectRatio: "3:4",
    designerType: "framed-print", // Default to framed print (non-apparel)
    sizes: [
      { id: "11x14", name: "11\" x 14\"", width: 11, height: 14 },
      { id: "12x16", name: "12\" x 16\"", width: 12, height: 16 },
      { id: "16x20", name: "16\" x 20\"", width: 16, height: 20 },
    ],
    frameColors: [
      { id: "black", name: "Black", hex: "#1a1a1a" },
      { id: "white", name: "White", hex: "#f5f5f5" },
      { id: "natural", name: "Natural Wood", hex: "#d4a574" },
    ],
  };

  useEffect(() => {
    // Unique session ID for tracing this effect run
    const sessionId = Math.random().toString(36).substring(2, 8);
    console.log(`[EmbedDesign] [${sessionId}] useEffect START`);

    // Master abort controller for this entire effect session
    const masterAbort = new AbortController();
    let isCancelled = false;

    /**
     * Fetch with timeout + master-abort linkage.
     *
     * Replaces the old new Promise((resolve,reject)=>{...}) pattern which had
     * a race condition: if safeFetch resolved after the completed flag was set
     * by any other path, neither resolve() nor reject() would be called and
     * the Promise would hang until the timeout fired.
     *
     * This version uses plain async/await so there is no executor race:
     * - timeout only calls controller.abort() — it does NOT call reject()
     * - the single await safeFetch(...) either returns, throws AbortError, or
     *   throws another network error — all paths are handled in the catch
     * - clearTimeout runs in finally so it ALWAYS fires after fetch settles
     */
    const fetchWithTimeout = async (url: string, timeout = 60000): Promise<Response> => {
      // Normalise URL — relative paths must be prefixed
      let fullUrl: string;
      if (url.startsWith('http') || url.startsWith('/apps/')) {
        fullUrl = url;
      } else if (url.startsWith('/')) {
        console.error(`[EmbedDesign] BUG: Relative URL passed to fetchWithTimeout: ${url} — auto-fixing with buildAppUrl`);
        fullUrl = buildAppUrl(url);
      } else {
        fullUrl = url;
      }

      const reqId = Math.random().toString(36).substring(2, 6);
      const startTime = Date.now();
      const logPrefix = `[EmbedDesign] [${sessionId}/${reqId}]`;

      // Bail early if master context is already cancelled
      if (masterAbort.signal.aborted || isCancelled) {
        console.log(`${logPrefix} Skipping — already cancelled`);
        throw new DOMException('Request aborted', 'AbortError');
      }

      const controller = new AbortController();

      // Forward master abort into this request's controller
      const onMasterAbort = () => controller.abort();
      masterAbort.signal.addEventListener('abort', onMasterAbort, { once: true });

      // Timeout fires the abort signal — it does NOT reject the promise directly.
      // That way clearTimeout in finally always wins; no dual-settle possible.
      const timeoutId = setTimeout(() => {
        console.error(`${logPrefix} TIMEOUT after ${timeout}ms — aborting`);
        controller.abort();
      }, timeout);

      console.log(`${logPrefix} START: ${fullUrl}`);

      try {
        const res = await safeFetch(fullUrl, { signal: controller.signal });
        const elapsed = Date.now() - startTime;

        if (!res.ok) {
          const body = await res.text().catch(() => res.statusText);
          console.error(`${logPrefix} HTTP ${res.status} in ${elapsed}ms`);
          throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
        }

        console.log(`${logPrefix} OK ${res.status} in ${elapsed}ms`);
        return res;
      } catch (err: any) {
        const elapsed = Date.now() - startTime;
        // Translate AbortError into a human-readable timeout message
        if (controller.signal.aborted) {
          throw new Error(`Request to ${fullUrl.substring(0, 80)} timed out after ${timeout}ms`);
        }
        console.error(`${logPrefix} FAILED in ${elapsed}ms:`, err.message);
        throw err;
      } finally {
        // Always clear — this fires whether fetch resolved, rejected, or was aborted
        clearTimeout(timeoutId);
        masterAbort.signal.removeEventListener('abort', onMasterAbort);
      }
    };

    /**
     * Retry wrapper with cancellable delays.
     * CRITICAL: The URL must be preserved EXACTLY as passed in - never modified.
     */
    const fetchWithRetry = async (urlInput: string, retries = 2): Promise<Response> => {
      // FREEZE the URL at entry - this exact string must be used for ALL retries
      const frozenUrl = String(urlInput);
      const logPrefix = `[EmbedDesign] [${sessionId}]`;
      let lastError: Error | null = null;

      // GUARD: If this is a designer endpoint call, it MUST have shop= parameter
      if (frozenUrl.includes('/designer') && !frozenUrl.includes('shop=')) {
        const errorMsg = `CRITICAL BUG: Designer endpoint called without shop parameter! URL: ${frozenUrl}`;
        console.error(`${logPrefix} ${errorMsg}`);
        throw new Error(errorMsg);
      }

      // Log the FULL URL including query params for debugging
      console.log(`${logPrefix} fetchWithRetry called with FULL URL: ${frozenUrl}`);

      for (let i = 0; i <= retries; i++) {
        // Check cancellation at start of each attempt
        if (isCancelled || masterAbort.signal.aborted) {
          console.log(`${logPrefix} Retry cancelled before attempt ${i + 1}`);
          throw new DOMException('Request cancelled', 'AbortError');
        }

        try {
          // Log FULL URL for each attempt (not stripped)
          console.log(`${logPrefix} Attempt ${i + 1}/${retries + 1} FULL URL: ${frozenUrl}`);
          // Pass the FROZEN URL - never reconstruct or modify
          const response = await fetchWithTimeout(frozenUrl);
          console.log(`${logPrefix} SUCCESS on attempt ${i + 1}`);
          return response;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          console.warn(`${logPrefix} Attempt ${i + 1} FAILED: ${lastError.message}`);

          // Don't retry if aborted/cancelled
          if (lastError.name === 'AbortError' || isCancelled || masterAbort.signal.aborted) {
            throw lastError;
          }

          // Cancellable delay before retry
          if (i < retries) {
            console.log(`${logPrefix} Waiting 1s before retry...`);
            try {
              await new Promise<void>((resolve, reject) => {
                if (masterAbort.signal.aborted) {
                  reject(new DOMException('Cancelled during delay', 'AbortError'));
                  return;
                }
                const delayTimer = setTimeout(resolve, 1000);
                const onAbort = () => {
                  clearTimeout(delayTimer);
                  reject(new DOMException('Cancelled during delay', 'AbortError'));
                };
                masterAbort.signal.addEventListener('abort', onAbort, { once: true });
              });
            } catch (delayErr) {
              throw delayErr; // Re-throw abort error
            }
          }
        }
      }

      throw lastError || new Error('All retries failed');
    };

    const loadConfig = async () => {
      const logPrefix = `[EmbedDesign] [${sessionId}]`;
      if (isCancelled || masterAbort.signal.aborted) {
        console.log(`${logPrefix} loadConfig skipped - already cancelled`);
        return;
      }

      // ⚡ INLINE CONFIG FAST PATH: When the parent embed passes designerConfig directly
      // via the inlineDesignerConfig URL param, skip ALL /api/storefront/product-types/* calls.
      // This is the primary path for /pages/:handle customizer pages.
      const inlineParam = searchParams.get('inlineDesignerConfig');
      if (inlineParam) {
        try {
          const dc = JSON.parse(inlineParam);
          console.log(`${logPrefix} INLINE CONFIG: using inlineDesignerConfig, skipping designer fetch. id=${dc.id} name="${dc.name}"`);
          setProductTypeConfig({
            id: dc.id,
            name: dc.name,
            description: dc.description || null,
            aspectRatio: dc.aspectRatio,
            designerType: dc.designerType,
            printShape: dc.printShape,
            canvasConfig: dc.canvasConfig,
            sizes: dc.sizes || [],
            frameColors: dc.frameColors || [],
            hasPrintifyMockups: dc.hasPrintifyMockups || false,
            baseMockupImages: dc.baseMockupImages || undefined,
            isAllOverPrint: dc.isAllOverPrint || false,
            placeholderPositions: dc.placeholderPositions || [],
            panelFlatLayImages: dc.panelFlatLayImages || {},
            colorLabel: dc.colorLabel || "Color",
            printifyBlueprintId: dc.printifyBlueprintId,
          });
          if (dc.frameColors?.length > 0) {
            setSelectedFrameColor(dc.frameColors[0].id);
          }
          setProductTypeError(null);
          // Still fetch style presets — lightweight, non-blocking
          fetchWithTimeout(`${API_BASE}/api/config?_t=${Date.now()}`, 8000)
            .then(r => safeJson(r, '/api/config'))
            .then(c => { if (!isCancelled && c.stylePresets) setStylePresets(c.stylePresets); })
            .catch(() => {});
          if (!isCancelled) setConfigLoading(false);
          return;
        } catch (e) {
          console.warn(`${logPrefix} Failed to parse inlineDesignerConfig, falling back to fetch:`, e);
        }
      }

      const cacheBuster = `_t=${Date.now()}`;
      const myshopifyDomain = getMyShopifyDomain();
      console.log('[EmbedDesign] Loading config - productTypeId:', productTypeId, 'productHandle:', productHandle, 'shop:', myshopifyDomain);

      // Step 1: Resolve productTypeId — only call the resolver when we don't already
      // have a valid (non-zero) productTypeId.  When the config supplies a real ID
      // (e.g. from the customizer-page proxy endpoint) we skip this call entirely,
      // preventing the 30s timeout chain that caused /pages/:handle to hang.
      let resolvedProductTypeId = productTypeId;
      let resolveSource = "url_param";

      const hasValidProductTypeId = productTypeId && productTypeId !== "0" && parseInt(productTypeId, 10) > 0;

      if (!hasValidProductTypeId && productHandle && myshopifyDomain) {
        console.log('[EmbedDesign] productTypeId is 0/missing — attempting resolver with handle:', productHandle);
        try {
          // Short timeout (8s) and single retry for the resolver — it is non-fatal.
          const resolveRes = await fetchWithRetry(
            `${API_BASE}/api/storefront/resolve-product-type?shop=${encodeURIComponent(myshopifyDomain)}&handle=${encodeURIComponent(productHandle)}&${cacheBuster}`,
            1  // 1 retry = 2 total attempts max
          );
          if (resolveRes.ok) {
            const resolved = await resolveRes.json();
            resolvedProductTypeId = String(resolved.productTypeId);
            resolveSource = resolved.reason || "resolver";
            console.log('[EmbedDesign] Resolved productTypeId:', resolvedProductTypeId, 'via:', resolveSource);
          } else {
            const errorData = await resolveRes.json().catch(() => ({}));
            console.warn('[EmbedDesign] Resolver returned error (non-fatal):', errorData);
          }
        } catch (err) {
          console.warn('[EmbedDesign] Resolver failed (non-fatal):', err);
        }
      } else if (hasValidProductTypeId) {
        console.log('[EmbedDesign] Skipping resolver — valid productTypeId provided:', productTypeId);
      }

      // Step 2: Fetch config and designer data
      try {
        if (isCancelled) return;

        // GUARD: Ensure we have a valid shop domain before calling designer endpoint
        if (!myshopifyDomain) {
          console.error('[EmbedDesign] CRITICAL: No shop domain available for designer API call');
          setProductTypeError('Unable to determine shop domain. Please ensure the shop parameter is provided in the URL.');
          setConfigLoading(false);
          return;
        }

        const designerParams = new URLSearchParams({
          shop: myshopifyDomain,
          _t: String(Date.now()),
        });
        if (productHandle) designerParams.set('productHandle', productHandle);
        if (displayName) designerParams.set('displayName', displayName);
        const designerUrl = `${API_BASE}/api/storefront/product-types/${resolvedProductTypeId}/designer?${designerParams.toString()}`;
        console.log('[EmbedDesign] Designer fetch URL:', designerUrl);

        const [configRes, designerRes] = await Promise.all([
          fetchWithTimeout(`${API_BASE}/api/config?${cacheBuster}`, 8000).then(res => safeJson(res, '/api/config')).catch(() => ({ stylePresets: [] })),
          fetchWithRetry(designerUrl)
        ]);

        if (isCancelled) return;

        // Handle style presets
        if (configRes.stylePresets) {
          setStylePresets(configRes.stylePresets);
        }

        // Handle designer config
        console.log('[EmbedDesign] Designer API response status:', designerRes.status, designerRes.statusText);

        if (designerRes.ok) {
          // Parse JSON with explicit error handling
          console.log('[EmbedDesign] Parsing designer response body...');
          const responseText = await designerRes.text();
          console.log('[EmbedDesign] Response text length:', responseText.length);

          if (isCancelled) return;

          let designerConfig;
          try {
            designerConfig = JSON.parse(responseText);
          } catch (parseErr) {
            console.error('[EmbedDesign] JSON parse error:', parseErr, 'Response text:', responseText.substring(0, 500));
            throw new Error('Failed to parse designer config JSON');
          }

          console.log('[EmbedDesign] Designer config loaded:', designerConfig.name, 'designerType:', designerConfig.designerType);

          // Log if the backend resolved to a different productTypeId (fallback)
          if (designerConfig.resolvedProductTypeId && designerConfig.requestedProductTypeId !== designerConfig.resolvedProductTypeId) {
            console.warn(`[EmbedDesign] ⚠️ Backend resolved productTypeId: requested=${designerConfig.requestedProductTypeId} → resolved=${designerConfig.resolvedProductTypeId} reason=${designerConfig.resolutionReason}`);
          }

          setProductTypeConfig({
            id: designerConfig.id,
            name: designerConfig.name,
            description: designerConfig.description || null,
            aspectRatio: designerConfig.aspectRatio,
            designerType: designerConfig.designerType,
            printShape: designerConfig.printShape,
            canvasConfig: designerConfig.canvasConfig,
            sizes: designerConfig.sizes || [],
            frameColors: designerConfig.frameColors || [],
            hasPrintifyMockups: designerConfig.hasPrintifyMockups || false,
            baseMockupImages: designerConfig.baseMockupImages || undefined,
            isAllOverPrint: designerConfig.isAllOverPrint || false,
            placeholderPositions: designerConfig.placeholderPositions || [],
            panelFlatLayImages: designerConfig.panelFlatLayImages || {},
            colorLabel: designerConfig.colorLabel || "Color",
            printifyBlueprintId: designerConfig.printifyBlueprintId,
          });

          if (designerConfig.frameColors?.length > 0) {
            setSelectedFrameColor(designerConfig.frameColors[0].id);
          }
          setProductTypeError(null);
        } else {
          // Designer endpoint failed - show explicit error, NO DEFAULT FALLBACK
          const errorBody = await designerRes.text();
          let errorMessage = `Product type "${resolvedProductTypeId}" not found.`;

          try {
            const errorData = JSON.parse(errorBody);
            console.error('[EmbedDesign] Designer API error:', errorData);

            if (errorData.debug?.availableIdsForMerchant) {
              errorMessage += ` Available IDs for this shop: ${errorData.debug.availableIdsForMerchant.join(', ')}.`;
            }
            if (errorData.error) {
              errorMessage = errorData.error + '. ' + errorMessage;
            }
          } catch (e) {
            console.error('[EmbedDesign] Designer API raw error:', errorBody);
          }

          errorMessage += ' Please check the productTypeId in your product metafield.';
          setProductTypeError(errorMessage);
          // DO NOT set default config - leave productTypeConfig as null
        }
      } catch (err) {
        // Don't set error state if we were cancelled
        if (isCancelled) {
          console.log('[EmbedDesign] Config loading was cancelled, ignoring error');
          return;
        }

        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        console.error('[EmbedDesign] Config loading failed:', errorMessage, err);

        // Don't show error for abort
        if (err instanceof Error && err.name === 'AbortError') {
          console.log('[EmbedDesign] Request was aborted, not showing error');
          return;
        }

        setProductTypeError(`Failed to load configuration: ${errorMessage}. Please refresh and try again.`);
        // DO NOT set default config - leave productTypeConfig as null
      }

      if (!isCancelled) {
        setConfigLoading(false);
      }
    };

    loadConfig();

    // Cleanup function: cancel in-flight requests when dependencies change or unmount
    return () => {
      console.log('[EmbedDesign] useEffect cleanup - aborting any in-flight requests');
      isCancelled = true;
      masterAbort.abort();
    };
  }, [productTypeId, productHandle]);

  // Fetch merchant's branding settings and apply to designer
  useEffect(() => {
    if (!shopDomain) return;

    const fetchBranding = async () => {
      try {
        const res = await safeFetch(`${API_BASE}/api/admin/branding`);
        if (res.ok) {
          const data = await res.json();
          setBrandingSettings(data.brandingSettings);
          
          // Apply branding to CSS variables
          if (data.brandingSettings) {
            const root = document.documentElement.style;
            const bs = data.brandingSettings;
            
            // Convert hex colors to HSL for CSS variables
            const primaryHSL = cssColorToHSL(bs.primaryColor);
            const textHSL = cssColorToHSL(bs.textColor);
            const bgHSL = cssColorToHSL(bs.backgroundColor);
            const borderHSL = cssColorToHSL(bs.borderColor);
            
            if (primaryHSL) {
              root.setProperty('--primary', primaryHSL);
              root.setProperty('--ring', primaryHSL);
            }
            if (textHSL) {
              root.setProperty('--foreground', textHSL);
              root.setProperty('--card-foreground', textHSL);
            }
            if (bgHSL) {
              root.setProperty('--background', bgHSL);
            }
            if (borderHSL) {
              root.setProperty('--border', borderHSL);
              root.setProperty('--input', borderHSL);
            }
            if (bs.fontFamily) {
              root.setProperty('--font-sans', bs.fontFamily);
            }
          }
        }
      } catch (err) {
        console.warn('[EmbedDesign] Failed to fetch branding settings:', err);
      }
    };

    fetchBranding();
  }, [shopDomain]);

  // Load shared design if sharedDesignId is present in URL
  useEffect(() => {
    if (!sharedDesignId) {
      setIsLoadingSharedDesign(false);
      return;
    }

    safeFetch(`${API_BASE}/api/shared-designs/${sharedDesignId}`)
      .then(res => {
        if (!res.ok) {
          if (res.status === 410) {
            throw new Error("This shared design has expired");
          }
          throw new Error("Shared design not found");
        }
        return res.json();
      })
      .then(sharedDesign => {
        // Load the shared design data into state
        setGeneratedDesign({
          id: sharedDesign.id,
          imageUrl: sharedDesign.imageUrl,
          prompt: sharedDesign.prompt,
        });
        setPrompt(sharedDesign.prompt);
        setSelectedPreset(sharedDesign.stylePreset || "");
        setSelectedSize(sharedDesign.size);
        setSelectedFrameColor(sharedDesign.frameColor);
        setTransform({
          scale: sharedDesign.transformScale || 100,
          x: sharedDesign.transformX || 50,
          y: sharedDesign.transformY || 50,
        });
        setIsSharedDesign(true);
        setIsLoadingSharedDesign(false);
      })
      .catch(err => {
        console.error("Failed to load shared design:", err);
        setSharedDesignError(err.message);
        setIsLoadingSharedDesign(false);
      });
  }, [sharedDesignId]);

  // Load saved design from loadDesignId URL param (navigated from Saved Designs panel)
  // Helper to apply a saved design record to the UI state
  const applyLoadedDesign = (designId: string, imageUrl: string, promptText: string, ds: Record<string, any> | null | undefined, topLevel: { size?: string | null; frameColor?: string | null; stylePreset?: string | null; mockupUrls?: string[] | null }) => {
    const abs = (u?: string) => u && u.startsWith('/') ? buildAppUrl(u) : u;
    const absUrl = abs(imageUrl);
    if (!absUrl) return;
    setGeneratedDesign({ id: designId, imageUrl: absUrl, prompt: promptText || '' });
    if (promptText) setPrompt(promptText);
    savedJobIdRef.current = designId;
    // Immediately poll for a pre-existing shadow product for this design.
    // If the shadow product was created within the last 7 days, it will be returned
    // instantly and the Add to Cart will be instant without calling resolve-design-variant.
    if (isStorefront && shopDomain) {
      startShadowVariantPoll(designId, shopDomain, 0);
    }
    if (ds && typeof ds === 'object') {
      console.log('[LoadDesign] Restoring designState:', ds);
      if (ds.scale !== undefined || ds.x !== undefined || ds.y !== undefined) {
        const restoredTransform = {
          scale: typeof ds.scale === 'number' ? ds.scale : 100,
          x: typeof ds.x === 'number' ? ds.x : 50,
          y: typeof ds.y === 'number' ? ds.y : 50,
        };
        suppressMockupStaleRef.current = true; // prevent stale-on-transform during load
        setTransform(restoredTransform);
        initialTransformRef.current = restoredTransform;
      }
      if (ds.selectedSize) setSelectedSize(ds.selectedSize);
      if (ds.selectedFrameColor) setSelectedFrameColor(ds.selectedFrameColor);
      if (ds.stylePreset) setSelectedPreset(ds.stylePreset);
    } else {
      if (topLevel.size) setSelectedSize(topLevel.size);
      if (topLevel.frameColor) setSelectedFrameColor(topLevel.frameColor);
      if (topLevel.stylePreset) setSelectedPreset(topLevel.stylePreset);
    }
    const mockups = topLevel.mockupUrls;
    if (mockups?.length) {
      const absMockups = mockups.map((u: string) => u.startsWith('/') ? buildAppUrl(u) : u);
      setPrintifyMockups(absMockups);
      setPrintifyMockupImages(absMockups.map((url: string, i: number) => ({ url, label: `Mockup ${i + 1}` })));
      setSelectedMockupIndex(1); // Auto-show first mockup when loading a saved design
      // The loaded mockups are already correct for this design — mark them fresh.
      // Without this, setTransform() called above triggers the stale-on-transform
      // effect (which fires because transform deps changed) and sets mockupsStale=true,
      // blocking _mockup_url from being included in add-to-cart for the 2nd+ design.
      setMockupsStale(false);
      // Sync the color ref so the colorMatches guard in handleAddToCart doesn't
      // incorrectly block the mockup URL when a saved design is loaded.
      // topLevel.frameColor is the restored frame color for this design.
      currentMockupColorRef.current = topLevel.frameColor || '';
      sendMockupsToParent(absMockups);
    }
  };

  // Track whether we've already restored the loadDesignId so we don't do it twice
  const loadDesignAppliedRef = useRef(false);

  // Reset the applied flag whenever loadDesignId changes so we restore the new design
  useEffect(() => {
    loadDesignAppliedRef.current = false;
    if (effectiveLoadDesignId) {
      // Clear current design state to prevent "takeover" while loading a new saved design
      setGeneratedDesign(null);
      setDesignSource(null);
    }
  }, [effectiveLoadDesignId]);

  // Primary path: restore from savedDesigns list once it's populated
  useEffect(() => {
    if (!effectiveLoadDesignId || loadDesignAppliedRef.current) return;
    if (!savedDesigns.length) return; // wait until list is loaded
    console.log('[LoadDesign] savedDesigns IDs:', savedDesigns.map(x => x.id), 'looking for:', effectiveLoadDesignId);
    const d = savedDesigns.find(x => x.id === effectiveLoadDesignId);
    if (!d) {
      console.warn('[LoadDesign] Design not found in savedDesigns list! loadDesignId:', effectiveLoadDesignId);
      return;
    }
    console.log('[LoadDesign] Found design:', d.id, 'artworkUrl:', d.artworkUrl);
    loadDesignAppliedRef.current = true;
    applyLoadedDesign(d.id, d.artworkUrl, d.prompt, d.designState, { size: d.size, frameColor: d.frameColor, stylePreset: d.stylePreset, mockupUrls: d.mockupUrls });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveLoadDesignId, savedDesigns]);

  // Fallback path: if savedDesigns list is empty (not logged in, or list not yet fetched),
  // fetch the job status directly from the server
  useEffect(() => {
    if (!effectiveLoadDesignId || !shopDomain || loadDesignAppliedRef.current) return;
    // Only run fallback after a short delay to give savedDesigns time to populate
    const timer = setTimeout(() => {
      if (loadDesignAppliedRef.current) return; // already restored from list
      console.log('[LoadDesign] Fallback: fetching status for', effectiveLoadDesignId);
      const shop = shopDomain;
      safeFetch(`${API_BASE}/api/storefront/generate/status?jobId=${encodeURIComponent(effectiveLoadDesignId)}&shop=${encodeURIComponent(shop)}&t=${Date.now()}`)
        .then(res => res.ok ? res.json() : null)
        .then(status => {
          if (!status || status.status !== 'complete') return;
          if (loadDesignAppliedRef.current) return; // list restored it in the meantime
          loadDesignAppliedRef.current = true;
          applyLoadedDesign(effectiveLoadDesignId, status.imageUrl, status.prompt || '', status.designState, { size: status.size, frameColor: status.frameColor, stylePreset: status.stylePreset, mockupUrls: status.mockupUrls });
        })
        .catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveLoadDesignId, shopDomain]);

  // Clear sessionStorage when the user navigates away so returning to the page
  // starts fresh (blank mockup). The entry only survives a hard refresh (F5).
  useEffect(() => {
    const stateKey = `aiart:design:${shopDomain || 'local'}:${productHandle || 'unknown'}`;
    const clearOnExit = () => {
      try { sessionStorage.removeItem(stateKey); } catch (_) {}
    };
    window.addEventListener('beforeunload', clearOnExit);
    window.addEventListener('pagehide', clearOnExit); // mobile Safari
    return () => {
      window.removeEventListener('beforeunload', clearOnExit);
      window.removeEventListener('pagehide', clearOnExit);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopDomain, productHandle]);

  // Restore design state from sessionStorage on load (survives hard refresh only)
  useEffect(() => {
    // Don't restore if we already have a design (e.g., from shared link) or are loading one
    // Also skip if loadDesignId is present — the saved design restore will handle it instead
    if (generatedDesign || sharedDesignId || isLoadingSharedDesign || effectiveLoadDesignId) return;
    try {
      const stateKey = `aiart:design:${shopDomain || 'local'}:${productHandle || 'unknown'}`;
      const saved = sessionStorage.getItem(stateKey);
      if (!saved) return;
      const state = JSON.parse(saved);
      // Only restore if saved within the last 5 minutes (hard refresh window only)
      if (state.savedAt && Date.now() - state.savedAt < 5 * 60 * 1000 && state.imageUrl) {
        console.log('[Design Studio] Restoring design from sessionStorage:', state.designId);
        setGeneratedDesign({
          id: state.designId || crypto.randomUUID(),
          imageUrl: state.imageUrl,
          prompt: state.prompt || '',
        });
        if (state.prompt) setPrompt(state.prompt);
        if (state.selectedSize) setSelectedSize(state.selectedSize);
        if (state.selectedFrameColor) setSelectedFrameColor(state.selectedFrameColor);
      } else {
        // Expired — clean up
        sessionStorage.removeItem(stateKey);
      }
    } catch (e) {
      // sessionStorage may be unavailable
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount only

  useEffect(() => {
    // IMPORTANT: Only request session token for admin-embedded mode
    // Storefront mode uses public /api/storefront/* endpoints - NO session token required
    if (requiresSessionToken && shopDomain) {
      console.log('[EmbedDesign] Starting session request for admin-embedded mode, shop:', shopDomain);

      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.warn('[EmbedDesign] Session request timed out after 10s');
        controller.abort();
      }, 10000);

      safeFetch(`${API_BASE}/api/shopify/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop: shopDomain,
          productId: productId,
          timestamp: Date.now().toString(),
          customerId: shopifyCustomerId || undefined,
          customerEmail: shopifyCustomerEmail || undefined,
          customerName: shopifyCustomerName || undefined,
        }),
        signal: controller.signal,
      })
        .then(async (res) => {
          clearTimeout(timeoutId);
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error || `Session failed: ${res.status}`);
          }
          return data;
        })
        .then((data) => {
          console.log('[EmbedDesign] Session established successfully');
          if (data.sessionToken) {
            setSessionToken(data.sessionToken);
            if (data.customer) {
              setCustomer(data.customer);
            }
          }
          setSessionError(null);
          setSessionLoading(false);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          if (error.name === 'AbortError') {
            console.error('[EmbedDesign] Session request aborted (timeout)');
            setSessionError("Connection timed out - please refresh");
          } else {
            console.error("[EmbedDesign] Failed to get session token:", error);
            setSessionError(error.message || "Failed to connect to store");
          }
          setSessionLoading(false);
        });
    } else {
      // Storefront mode or standalone mode - no session token needed
      console.log('[EmbedDesign] Skipping session - runtimeMode:', runtimeMode, 'requiresSessionToken:', requiresSessionToken, 'shopDomain:', shopDomain);
      setSessionLoading(false);
    }
  }, [requiresSessionToken, runtimeMode, shopDomain, productId, shopifyCustomerId, shopifyCustomerEmail, shopifyCustomerName]);

  // Fetch Printify composite mockups (artwork overlaid on product photos)
  // Send mockup URLs to parent Shopify page via postMessage
  const sendMockupsToParent = useCallback((mockupUrls: string[]) => {
    // Send mockups for both storefront and admin-embedded modes (both use iframes)
    if (runtimeMode === 'standalone') return;

    try {
      // Convert relative /objects/... paths to absolute Railway URLs so the
      // Shopify parent page (a different domain) can load the images.
      const absoluteUrls = mockupUrls.map(toAbsoluteImageUrl);

      // Use "*" for targetOrigin to support Shopify preview environments
      // Origin validation is done on the receiving end in ai-art-embed.liquid
      window.parent.postMessage({
        type: "AI_ART_STUDIO_MOCKUPS",
        mockupUrls: absoluteUrls,
        productId,
        productHandle,
      }, "*");
      console.log("[EmbedDesign] Sent mockups to parent:", absoluteUrls.length);
    } catch (error) {
      console.error("[EmbedDesign] Failed to send mockups to parent:", error);
    }
  }, [runtimeMode, productId, productHandle]);

  // Poll for the pre-created shadow variant for a given jobId.
  // Once ready, stores shadowVariantId and shadowProductId in state so Add to Cart is instant.
  // initialDelay: ms before first poll (5000 for new designs, 0 for loaded saved designs)
  const startShadowVariantPoll = useCallback((jobId: string | null, shop: string, initialDelay = 0) => {
    if (!jobId || !shop) return;
    setPreShadowVariantId(null);
    setPreShadowProductId(null);
    if (preShadowPollRef.current) clearTimeout(preShadowPollRef.current);
    let pollAttempts = 0;
    const maxAttempts = 12;
    const pollShadow = async () => {
      try {
        const r = await safeFetch(`${API_BASE}/api/storefront/shadow-variant/${jobId}?shop=${encodeURIComponent(shop)}`);
        if (r.ok) {
          const data = await r.json();
          if (data.ready && data.shadowVariantId) {
            console.log('[PreShadow] Shadow variant ready:', data.shadowVariantId, 'product:', data.shadowProductId);
            setPreShadowVariantId(data.shadowVariantId);
            setPreShadowProductId(data.shadowProductId || null);
            return;
          }
        }
      } catch (_) { /* non-fatal */ }
      pollAttempts++;
      if (pollAttempts < maxAttempts) {
        preShadowPollRef.current = setTimeout(pollShadow, 5000);
      } else {
        console.log('[PreShadow] Shadow variant not ready after max polls — will create on demand');
      }
    };
     preShadowPollRef.current = setTimeout(pollShadow, initialDelay);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);



  // ── Sequential box guide ────────────────────────────────────────────────────
  // Read the theme's border colour once and set --appai-guide-color on the root element
  useEffect(() => {
    if (!isStorefront && !isShopify) return;
    const timer = setTimeout(() => {
      try {
        // Try to read the border colour from a rendered select or input on the page
        const el = document.querySelector('select, input[type="text"], textarea, button') as HTMLElement | null;
        if (!el) return;
        const borderColor = getComputedStyle(el).borderColor;
        if (borderColor && borderColor !== 'rgba(0, 0, 0, 0)') {
          document.documentElement.style.setProperty('--appai-guide-color', borderColor);
        }
      } catch (_) {}
    }, 600);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStorefront, isShopify]);

  // Pulses a border glow on boxes 1→2→3→4 in order to guide new customers.
  // Stops permanently the first time the user interacts with any of the boxes.
  useEffect(() => {
    if (!isStorefront && !isShopify) return;
    // Only run once per page load (guideStoppedRef resets on each mount)

    const BOXES: Array<0 | 1 | 2 | 3 | 4> = [1, 2, 3, 4];
    // Each box gets 2 pulses at 600ms each = 1.2s, plus 100ms gap between boxes
    const BOX_DURATION = 2400; // ms per box — matches the 2s CSS sweep animation + 400ms gap
    const PAUSE_AFTER_CYCLE = 2000; // ms pause before repeating

    let cycleTimeout: ReturnType<typeof setTimeout> | null = null;
    let boxIdx = 0;

    function runCycle() {
      if (guideStoppedRef.current) return;
      boxIdx = 0;
      stepBox();
    }

    function stepBox() {
      if (guideStoppedRef.current) return;
      if (boxIdx >= BOXES.length) {
        // End of cycle — pause then repeat
        setGuideActiveBox(0);
        cycleTimeout = setTimeout(runCycle, PAUSE_AFTER_CYCLE);
        return;
      }
      setGuideActiveBox(BOXES[boxIdx]);
      cycleTimeout = setTimeout(() => {
        boxIdx++;
        stepBox();
      }, BOX_DURATION);
    }

    // Start after a short delay to let the page settle
    cycleTimeout = setTimeout(runCycle, 800);

    // Stop on any user interaction with the form boxes
    function stopGuide() {
      guideStoppedRef.current = true;
      setGuideActiveBox(0);
      if (cycleTimeout) clearTimeout(cycleTimeout);
      // guideStoppedRef already set above — no sessionStorage needed
    }

    const events = ['click', 'focus', 'keydown', 'touchstart'] as const;
    events.forEach(ev => document.addEventListener(ev, stopGuide, { once: true, passive: true }));

    return () => {
      guideStoppedRef.current = true;
      if (cycleTimeout) clearTimeout(cycleTimeout);
      events.forEach(ev => document.removeEventListener(ev, stopGuide));
    };
   // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStorefront, isShopify]);

  // Deferred BRIDGE_ACK: send ACK only after the React UI is fully rendered
  // (configLoading === false). This keeps the parent loading screen visible
  // until the customizer content is ready, preventing the brief blank overlay.
  const bridgeAckSentRef = useRef(false);
  useEffect(() => {
    if (!bridgeReady || configLoading || bridgeAckSentRef.current) return;
    bridgeAckSentRef.current = true;
    window.parent.postMessage({
      type: 'AI_ART_STUDIO_BRIDGE_ACK',
      _bridgeVersion: '1.0.0',
    }, '*');
    console.log('[Design Studio] Deferred BRIDGE_ACK sent (configLoading resolved)');
  }, [bridgeReady, configLoading]);

  const fetchPrintifyMockups = useCallback(async (
    designImageUrl: string,
    ptId: number,
    sizeId: string,
    colorId: string,
    scale: number = 100,
    x: number = 50,
    y: number = 50,
    patternUrl?: string,
    mirrorLegs?: boolean,
    panelUrls?: { position: string; dataUrl: string }[]
  ) => {
    // Guard: never call the mockup endpoint without a real design image.
    if (!designImageUrl) {
      console.warn('[EmbedDesign] fetchPrintifyMockups called without designImageUrl — skipping');
      return;
    }

    setMockupLoading(true);
    setMockupsStale(false);
    // Notify parent page so it can show the "Artwork Generating" overlay
    if (runtimeMode !== 'standalone') {
      window.parent.postMessage({ type: 'AI_ART_STUDIO_MOCKUP_LOADING', loading: true }, '*');
    }
    // Clamp values to valid ranges
    const clampedX = Math.max(0, Math.min(100, x));
    const clampedY = Math.max(0, Math.min(100, y));
    const clampedScale = Math.max(10, Math.min(200, scale));

    try {
      // The server's uploadImageToPrintify() handles data URLs natively
      // (extracts base64 and sends directly to Printify). No client-side
      // conversion needed — this allows mockups to work even when our
      // object storage is down.
      const hostedUrl = designImageUrl;

      // Use Shopify-specific endpoint if in Shopify mode
      const endpoint = isStorefront
        ? `${API_BASE}/api/storefront/mockup`
        : isShopify
          ? `${API_BASE}/api/shopify/mockup`
          : `${API_BASE}/api/mockup/generate`;
      const payload = isStorefront ? {
        productTypeId: ptId,
        designImageUrl: hostedUrl,
        patternUrl: patternUrl || undefined,
        panelUrls: panelUrls && panelUrls.length > 0 ? panelUrls : undefined,
        mirrorLegs: mirrorLegs ?? false,
        sizeId,
        colorId,
        scale: clampedScale,
        x: clampedX,
        y: clampedY,
        shop: shopDomain,
      } : isShopify ? {
        productTypeId: ptId,
        designImageUrl: hostedUrl,
        patternUrl: patternUrl || undefined,
        panelUrls: panelUrls && panelUrls.length > 0 ? panelUrls : undefined,
        mirrorLegs: mirrorLegs ?? false,
        sizeId,
        colorId,
        scale: clampedScale,
        x: clampedX,
        y: clampedY,
        shop: shopDomain,
        sessionToken,
      } : {
        productTypeId: ptId,
        designImageUrl: hostedUrl,
        patternUrl: patternUrl || undefined,
        panelUrls: panelUrls && panelUrls.length > 0 ? panelUrls : undefined,
        mirrorLegs: mirrorLegs ?? false,
        sizeId,
        colorId,
        scale: clampedScale,
        x: clampedX,
        y: clampedY,
      };

      setMockupError(null);
      console.log('[EmbedDesign] Fetching mockup from:', endpoint);
      const response = await safeFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }, 60000);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Mockup generation failed (${response.status})`);
      }

      const result = await response.json();
      
      if (result.success && result.mockupUrls?.length > 0) {
        const absUrls = result.mockupUrls.map(toAbsoluteImageUrl);
        const absImages = (result.mockupImages || []).map((img: { url: string; label: string }) => ({
          ...img,
          url: toAbsoluteImageUrl(img.url),
        }));
        setPrintifyMockups(absUrls);
        setPrintifyMockupImages(absImages);
        setSelectedMockupIndex(1); // Auto-show first mockup (not raw artwork)
        sendMockupsToParent(absUrls);
        currentMockupColorRef.current = colorId;
        mockupColorCacheRef.current[colorId] = { urls: absUrls, images: absImages };
        console.log('[Mockups] Stored', absUrls.length, 'mockup URLs for color', colorId);
        // Persist mockup URLs on the job record so saved designs can be re-loaded with mockups.
        // Also pass base product/variant info so the server can pre-create the shadow product
        // in the background — enabling instant Add to Cart.
        if (isStorefront && savedJobIdRef.current && shopDomain) {
          const baseVariantForShadow = selectedVariantParam || overrideVariantId || '';
          console.log('[Mockups] Saving permanent mockup URLs to job:', savedJobIdRef.current);
          safeFetch(`${API_BASE}/api/storefront/save-mockups`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jobId: savedJobIdRef.current,
              shop: shopDomain,
              mockupUrls: result.mockupUrls,
              ...(productId && baseVariantForShadow ? { baseProductId: productId, baseVariantId: baseVariantForShadow } : {}),
            }),
          }).then(r => r.json()).then(saved => {
            console.log('[Mockups] save-mockups response:', saved);
            if (saved.saved) {
              // Refresh saved designs list so the new mockup shows up in the dropdown
              setSavedDesignsLoading(true);
              safeFetch(`${API_BASE}/api/storefront/customizer/my-designs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shop: shopDomain, customerId: storefrontCustomerId }),
              })
                .then(r => r.json()).then(d => { 
                  if (d.designs) {
                    setSavedDesigns(d.designs);
                    // Notify parent to refresh its gallery view
                    console.log('[Mockups] Notifying parent to refresh gallery');
                    window.parent.postMessage({ type: 'APPAI_REFRESH_GALLERY' }, '*');
                  }
                })
                .catch(() => {}).finally(() => setSavedDesignsLoading(false));
            }
          }).catch((e) => { console.error('[Mockups] save-mockups error:', e); });

          // Poll for the pre-created shadow variant (server creates it in background ~5-15s)
          // Once ready, store it so Add to Cart can use it instantly.
          if (productId && baseVariantForShadow) {
            const jobIdForPoll = savedJobIdRef.current;
            startShadowVariantPoll(jobIdForPoll, shopDomain, 5000);
          }
        }
      } else if (!result.success) {
        throw new Error(result.message || "Mockup generation returned unsuccessful");
      }
    } catch (error) {
      console.error("Failed to generate Printify mockups:", error);
      setMockupError(error instanceof Error ? error.message : "Failed to generate product preview");
      setMockupFailed(true);
    } finally {
      setMockupLoading(false);
      setMockupTriggered(false);
      // Clear the "Artwork Generating" overlay on the parent page
      if (runtimeMode !== 'standalone') {
        window.parent.postMessage({ type: 'AI_ART_STUDIO_MOCKUP_LOADING', loading: false }, '*');
      }
    }
  }, [isShopify, isStorefront, shopDomain, sessionToken, sendMockupsToParent, runtimeMode]);

  // Reset mockupFailed when a new design image becomes available so the
  // useEffect hooks below can trigger a fresh mockup attempt.
  const prevMockupImageUrlRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (generatedDesign?.imageUrl && generatedDesign.imageUrl !== prevMockupImageUrlRef.current) {
      prevMockupImageUrlRef.current = generatedDesign.imageUrl;
      setMockupFailed(false);
    }
  }, [generatedDesign?.imageUrl]);

  // Fetch Printify mockups for shared designs once product config is loaded.
  // For AOP products: show Pattern Customizer instead of auto-fetching mockups (same as post-generation).
  useEffect(() => {
    if (
      isSharedDesign &&
      generatedDesign?.imageUrl &&
      productTypeConfig?.hasPrintifyMockups &&
      selectedSize &&
      printifyMockups.length === 0 &&
      !mockupLoading &&
      !mockupFailed
    ) {
      if (productTypeConfig.isAllOverPrint) {
        console.log('[EmbedDesign] First useEffect: Triggering AOP Pattern Customizer');
        setAopPendingMotifUrl(toAbsoluteImageUrl(generatedDesign.imageUrl));
        setAopPatternUrl(null);
        setShowPatternStep(true);
      } else {
        fetchPrintifyMockups(
          toAbsoluteImageUrl(generatedDesign.imageUrl),
          productTypeConfig.id,
          selectedSize,
          selectedFrameColor || 'default',
          transform.scale,
          transform.x,
          transform.y
        );
      }
    }
  }, [isSharedDesign, generatedDesign?.imageUrl, productTypeConfig, selectedSize, selectedFrameColor, printifyMockups.length, mockupLoading, mockupFailed, transform, fetchPrintifyMockups]);

  // Fallback: trigger mockups if generation completed but productTypeConfig wasn't ready during onSuccess.
  // Also handles session restore. For AOP: show Pattern Customizer instead of auto-fetching mockups.
  useEffect(() => {
    if (
      !isStorefront ||
      !generatedDesign?.imageUrl ||
      !productTypeConfig?.hasPrintifyMockups ||
      !selectedSize ||
      printifyMockups.length > 0 ||
      printifyMockupImages.length > 0 ||
      mockupLoading ||
      mockupFailed
    ) return;

    if (productTypeConfig.isAllOverPrint) {
      console.log('[EmbedDesign] AOP Fallback: Triggering Pattern Customizer');
      setAopPendingMotifUrl(toAbsoluteImageUrl(generatedDesign.imageUrl));
      setAopPatternUrl(null);
      setShowPatternStep(true);
      return;
    }

    console.log('[Mockups] Fallback trigger: config loaded after generation');
    fetchPrintifyMockups(
      toAbsoluteImageUrl(generatedDesign.imageUrl),
      productTypeConfig.id,
      selectedSize,
      selectedFrameColor || 'default',
      transform.scale,
      transform.x,
      transform.y
    );
  }, [isStorefront, generatedDesign?.imageUrl, productTypeConfig, selectedSize, selectedFrameColor, printifyMockups.length, printifyMockupImages.length, mockupLoading, mockupFailed, transform, fetchPrintifyMockups]);

  // Mark mockups as stale when transform changes and mockups already exist
  useEffect(() => {
    if (suppressMockupStaleRef.current) {
      // Transform changed during design load — mockups are already correct, don't mark stale
      suppressMockupStaleRef.current = false;
      return;
    }
    const hasMockups = printifyMockups.length > 0 || printifyMockupImages.length > 0;
    if (hasMockups && !mockupLoading) {
      setMockupsStale(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transform.scale, transform.x, transform.y]);

  // When frame color changes, swap mockups from the per-color cache or mark stale
  useEffect(() => {
    const hasMockups = printifyMockups.length > 0 || printifyMockupImages.length > 0;
    if (!hasMockups || !selectedFrameColor || mockupLoading) return;
    if (selectedFrameColor === currentMockupColorRef.current) return;

    const cached = mockupColorCacheRef.current[selectedFrameColor];
    if (cached && cached.images.length > 0) {
      setPrintifyMockups(cached.urls);
      setPrintifyMockupImages(cached.images);
      currentMockupColorRef.current = selectedFrameColor;
      setSelectedMockupIndex(prev => prev === 0 ? 1 : prev); // Keep mockup view when swapping colors
      setMockupsStale(false);
      console.log('[Mockups] Swapped to cached mockups for color', selectedFrameColor);
    } else {
      setMockupsStale(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFrameColor]);

  // Background prefetch: after primary mockups load, fetch other frame colors silently
  useEffect(() => {
    if (
      !generatedDesign?.imageUrl ||
      !productTypeConfig?.hasPrintifyMockups ||
      !selectedSize ||
      printifyMockupImages.length === 0 ||
      mockupLoading ||
      !productTypeConfig?.frameColors?.length
    ) return;

    const otherColors = productTypeConfig.frameColors.filter(
      (c: { id: string }) => c.id !== currentMockupColorRef.current && !mockupColorCacheRef.current[c.id]
    );
    if (otherColors.length === 0) return;

    console.log('[Mockups] Background prefetch queued for colors:', otherColors.map((c: { id: string }) => c.id));
    const controller = new AbortController();

    (async () => {
      // Wait before starting background fetches so they don't compete with
      // primary content rendering and initial page interactions.
      await new Promise(r => setTimeout(r, 3000));
      if (controller.signal.aborted) return;

      const imageUrl = toAbsoluteImageUrl(generatedDesign!.imageUrl);
      const endpoint = isStorefront
        ? `${API_BASE}/api/storefront/mockup`
        : isShopify
          ? `${API_BASE}/api/shopify/mockup`
          : `${API_BASE}/api/mockup/generate`;

      for (const color of otherColors) {
        if (controller.signal.aborted) break;
        if (mockupColorCacheRef.current[color.id]) continue;

        try {
          const payload: Record<string, unknown> = {
            productTypeId: productTypeConfig!.id,
            designImageUrl: imageUrl,
            sizeId: selectedSize,
            colorId: color.id,
            scale: Math.max(10, Math.min(200, transform.scale)),
            x: Math.max(0, Math.min(100, transform.x)),
            y: Math.max(0, Math.min(100, transform.y)),
          };
          if (isStorefront || isShopify) payload.shop = shopDomain;
          if (isShopify) payload.sessionToken = sessionToken;

          const response = await safeFetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal,
          }, 60000);

          if (!response.ok) continue;
          const result = await response.json();

          if (result.success && result.mockupUrls?.length > 0) {
            const absUrls = result.mockupUrls.map(toAbsoluteImageUrl);
            const absImages = (result.mockupImages || []).map((img: { url: string; label: string }) => ({
              ...img,
              url: toAbsoluteImageUrl(img.url),
            }));
            mockupColorCacheRef.current[color.id] = { urls: absUrls, images: absImages };
            console.log('[Mockups] Background cached color', color.id, '—', absUrls.length, 'mockups');
          }
        } catch {
          // Silently fail for background prefetch
        }
      }
    })();

    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printifyMockupImages.length, mockupLoading]);

  // Variants state — must be declared BEFORE the AI_ART_STUDIO_CART_STATE useEffect
  // that includes `variants` in its dependency array (avoids TDZ ReferenceError in production bundle)
  const [variants, setVariants] = useState<any[]>([]);
  const [variantError, setVariantError] = useState<string | null>(null);
  const [variantsFetched, setVariantsFetched] = useState(false);

  // Variant selected by the storefront parent via AI_ART_STUDIO_VARIANT_CHANGE postMessage.
  // Takes precedence over selectedVariantParam so the customer's dropdown choice is honoured.
  const [overrideVariantId, setOverrideVariantId] = useState<string | null>(null);

  // Pre-created shadow variant ID — set after save-mockups triggers background shadow product creation.
  // When set, Add to Cart uses this directly instead of calling resolve-design-variant (instant).
  const [preShadowVariantId, setPreShadowVariantId] = useState<string | null>(null);
  const [preShadowProductId, setPreShadowProductId] = useState<string | null>(null);

  // Shopify variants with prices delivered from the embed parent via BRIDGE_ACK postMessage.
  // Used to render a variant selector inside the generator on customizer pages.
  const [shopifyVariants, setShopifyVariants] = useState<Array<{ id: string; title: string; price: string }>>([]);
  const [shopifyVariantId, setShopifyVariantId] = useState<string | null>(null);

  const getPreferredMockupUrl = useCallback((): string => {
    const frontImage = printifyMockupImages.find(img => img.label === 'front');
    if (frontImage?.url) return toAbsoluteImageUrl(frontImage.url);
    if (printifyMockups.length > 0) return toAbsoluteImageUrl(printifyMockups[0]);
    if (printifyMockupImages.length > 0 && printifyMockupImages[0]?.url) {
      return toAbsoluteImageUrl(printifyMockupImages[0].url);
    }
    return '';
  }, [printifyMockups, printifyMockupImages]);

  // Sync cart state with the parent page's Add to Cart button (storefront mode only)
  useEffect(() => {
    if (!isStorefront) return;

    const hasMockups = productTypeConfig?.hasPrintifyMockups;
    const mockupsReady = printifyMockups.length > 0 || printifyMockupImages.length > 0;
    const waitingForMockups = !!(hasMockups && generatedDesign?.imageUrl && mockupLoading && !mockupsReady);

    if (!generatedDesign) {
      window.parent.postMessage({
        type: 'AI_ART_STUDIO_CART_STATE',
        ready: false,
        disabled: true,
        label: 'Create your design first',
        payload: null,
      }, '*');
      return;
    }

    const rawVariantId = findVariantId();
    if (!rawVariantId) {
      window.parent.postMessage({
        type: 'AI_ART_STUDIO_CART_STATE',
        ready: false,
        disabled: true,
        label: 'Select options to continue',
        payload: null,
      }, '*');
      return;
    }

    // Normalize to numeric (strip GID prefix if present) — /cart/add.js requires numeric IDs
    const variantId = normalizeVariantId(rawVariantId);

    // Build cart properties (sync — only hosted URLs, no async ensureHostedUrl)
    // Build a human-readable design label: "Product Type · Style #xxxx"
    const activePresetForLabel = filteredStylePresets.find(p => p.id === selectedPreset);
    const styleLabel = activePresetForLabel?.name || '';
    const productLabel = displayName || productTitle || '';
    const rawId = String(generatedDesign.id || '');
    // Hash the full ID so every unique design gets a unique suffix — avoids
    // collisions when a hard refresh regenerates a new ID with a similar tail.
    const shortHash = (() => {
      let h = 0;
      for (let i = 0; i < rawId.length; i++) { h = (Math.imul(31, h) + rawId.charCodeAt(i)) | 0; }
      return Math.abs(h).toString(36).slice(0, 4);
    })();
    const readableDesignId = [productLabel, styleLabel].filter(Boolean).join(' · ') + (shortHash ? ` #${shortHash}` : '');
    const properties: Record<string, string> = {
      '_design_id': readableDesignId || rawId,
      'Artwork': 'Custom AI Design',
    };
    const artworkUrl = generatedDesign.imageUrl;
    if (artworkUrl && !artworkUrl.startsWith('data:')) {
      properties['_artwork_url'] = toAbsoluteImageUrl(artworkUrl);
    }

    const mockupFullUrl = mockupsStale ? '' : getPreferredMockupUrl();
    if (mockupFullUrl) properties['_mockup_url'] = mockupFullUrl;
    if (selectedSize) properties['Size'] = selectedSize;
    if (selectedFrameColor) properties['Color'] = selectedFrameColor;

    const shouldDisable = waitingForMockups || isAddingToCart || mockupsStale;
    const label = waitingForMockups
      ? 'Generating preview\u2026'
      : mockupsStale
        ? 'Refresh Mockups to Continue'
        : 'Add to Cart';

    window.parent.postMessage({
      type: 'AI_ART_STUDIO_CART_STATE',
      ready: !waitingForMockups && !mockupsStale,
      disabled: shouldDisable,
      waitingForMockups,
      label,
      payload: {
        variantId,
        quantity: 1,
        properties,
      },
    }, '*');
  }, [isStorefront, runtimeMode, generatedDesign, mockupLoading, getPreferredMockupUrl, isAddingToCart, selectedSize, selectedFrameColor, productTypeConfig, bridgeReady, variants, overrideVariantId, shopifyVariantId, mockupsStale]);

  const generateMutation = useMutation({
    mutationFn: async (payload: {
      prompt: string;
      userPrompt?: string;
      size: string;
      frameColor: string;
      stylePreset?: string;
      referenceImages?: string[];
      baseImageUrl?: string;
      shop?: string;
      sessionToken?: string;
      productTypeId?: string;
      sessionId?: string;
      customerId?: string;
    }) => {
      const endpoint = isStorefront
        ? `${API_BASE}/api/storefront/generate`
        : isShopify
          ? `${API_BASE}/api/shopify/generate`
          : `${API_BASE}/api/generate`;
      console.log('[EmbedDesign] Generating design via:', endpoint, '(mode:', runtimeMode, ')');

      // ── Storefront uses async job model (POST → jobId, then poll status) ──
      if (isStorefront) {
        const raceTimeout = <T,>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
          Promise.race([
            promise,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
            ),
          ]);

        // Phase 1: submit job
        const reqId = crypto.randomUUID();
        console.log('[SF UI] POST', endpoint, { reqId, shop: payload.shop, runtimeMode, apiBase: API_BASE, ts: Date.now() });
        const postStart = Date.now();
        const fetchPromise = safeFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Req-Id": reqId },
          body: JSON.stringify(payload),
        });
        const jobRes = await raceTimeout(fetchPromise, 60_000, 'POST /generate');
        console.log('[SF UI] POST complete — status', jobRes.status, 'in', Date.now() - postStart, 'ms');
        const jobData = await safeJson(jobRes, 'POST /generate');
        if (!jobRes.ok) {
          if (jobData.error === 'FREE_LIMIT_REACHED') {
            setFreeLimitReached(true);
            throw new Error(jobData.message || "Free generation limit reached. Please create an account to continue.");
          }
          if (jobData.error === 'GALLERY_FULL') {
            setShowGalleryFullModal(true);
            throw new Error('GALLERY_FULL');
          }
          if (!isStorefront) {
            if (jobData.requiresLogin) setLoginError("Please log in to your account to create designs.");
            else if (jobData.requiresCredits) setLoginError("No credits remaining. Please purchase more credits to continue.");
          }
          throw new Error(jobData.error || "Failed to start generation");
        }
        setFreeLimitReached(false);

        const { jobId } = jobData;
        if (!jobId) throw new Error("Server did not return a jobId");
        console.log('[EmbedDesign] Job submitted:', jobId, '— polling for completion');

        // Phase 2: poll GET /generate/status every 2s, max 5 minutes
        const shop = payload.shop || new URLSearchParams(window.location.search).get('shop') || '';
        if (!shop) throw new Error('Shop domain is required for generation. Please reload the page.');
        const statusUrl = `${API_BASE}/api/storefront/generate/status?jobId=${encodeURIComponent(jobId)}&shop=${encodeURIComponent(shop)}`;
        const deadline = Date.now() + 5 * 60 * 1000;
        let consecutiveErrors = 0;

        while (Date.now() < deadline) {
          await new Promise<void>(r => setTimeout(r, 2000));
          try {
            const statusRes = await raceTimeout(
              safeFetch(statusUrl, { headers: { "X-Req-Id": reqId } }),
              15_000,
              'GET /generate/status',
            );
            if (!statusRes.ok) {
              console.warn('[EmbedDesign] Status poll HTTP error', statusRes.status);
              consecutiveErrors++;
              if (consecutiveErrors > 5) throw new Error(`Status polling failed ${consecutiveErrors} times`);
              continue;
            }
            consecutiveErrors = 0;
            const status = await safeJson(statusRes, 'GET /generate/status');
            console.log('[EmbedDesign] Job status:', status.status, jobId);
            if (status.status === 'complete') {
              const abs = (u?: string) => u && u.startsWith('/') ? buildAppUrl(u) : u;
              return { ...status, jobId, imageUrl: abs(status.imageUrl), thumbnailUrl: abs(status.thumbnailUrl) };
            }
            if (status.status === 'failed') throw new Error(status.error || 'Generation failed');
          } catch (pollErr: any) {
            consecutiveErrors++;
            console.warn('[EmbedDesign] Poll error:', pollErr.message, `(${consecutiveErrors}/5)`);
            if (consecutiveErrors > 5) throw new Error(`Status polling failed: ${pollErr.message}`);
            // Keep polling on transient errors
          }
        }
        throw new Error('Generation timed out after 5 minutes');
      }

      // ── Non-storefront: synchronous request (unchanged) ──
      const response = await fetchWithTimeoutSimple(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }, 90000);
      const data = await response.json();
      if (!response.ok) {
        if (data.requiresLogin) {
          setLoginError("Please log in to your account to create designs.");
        } else if (data.requiresCredits) {
          setLoginError("No credits remaining. Please purchase more credits to continue.");
        } else if (data.error === 'GALLERY_FULL') {
          setShowGalleryFullModal(true);
          throw new Error('GALLERY_FULL');
        }
        throw new Error(data.error || "Failed to generate design");
      }
      return data;
    },
    onSuccess: (data, variables) => {
      const imageUrl = data.imageUrl || data.design?.generatedImageUrl;
      const designId = data.designId || data.design?.id || crypto.randomUUID();
      setAddedToCart(false);
      setGeneratedDesign({
        id: designId,
        imageUrl: imageUrl,
        prompt: prompt,
      });
      // Update credits from the response
      if (data.creditsRemaining !== undefined) {
        console.log('[EmbedDesign] Updating credits from', customer?.credits, 'to', data.creditsRemaining);
        if (customer) {
          const updatedCust = { ...customer, credits: data.creditsRemaining };
          setCustomer(updatedCust);
          try { localStorage.setItem('appai_customer', JSON.stringify(updatedCust)); } catch {}
        } else {
          // If no customer object yet, create one with the credits
          setCustomer({
            id: 'anonymous',
            credits: data.creditsRemaining,
            isLoggedIn: false,
          });
        }
        // Show remaining credits notification
        if (data.creditsRemaining > 0) {
          toast({
            title: storefrontCustomerId
              ? `${data.creditsRemaining} Artwork${data.creditsRemaining === 1 ? '' : 's'} Remaining`
              : `${data.creditsRemaining} Free Artwork${data.creditsRemaining === 1 ? '' : 's'} Remaining`,
            description: storefrontCustomerId
              ? 'Credits are refunded when you complete a purchase.'
              : "Tap \u24D8 next to 'Free artworks' for details on getting more.",
            duration: 5000,
          });
        } else {
          toast({
            title: "All Free Generations Used",
            description: "Create an account or purchase more credits to continue designing.",
            variant: "destructive",
            duration: 8000,
          });
        }
      }
      // Use conditional default zoom based on product type for better coverage
      let zoomDefault = 100;
      if (productTypeConfig?.designerType === "apparel") {
        zoomDefault = 135;
      } else if (productTypeConfig?.designerType === "pillow" || productTypeConfig?.name?.toLowerCase().includes("pillow") || productTypeConfig?.name?.toLowerCase().includes("cushion")) {
        zoomDefault = 120;
      } else if (productTypeConfig?.designerType === "framed-print" || productTypeConfig?.name?.toLowerCase().includes("frame") || productTypeConfig?.name?.toLowerCase().includes("framed")) {
        zoomDefault = 110;
      } else if (productTypeConfig?.aspectRatio) {
        // Landscape products (wider than tall, e.g. 4:3, 16:9) need 110% zoom to avoid white bands
        const [arW, arH] = productTypeConfig.aspectRatio.split(':').map(Number);
        if (arW && arH && arW > arH) zoomDefault = 110;
      }
      console.log('[EmbedDesign] Auto-zoom:', zoomDefault, 'designerType:', productTypeConfig?.designerType, 'name:', productTypeConfig?.name);
      const newTransform = { scale: zoomDefault, x: 50, y: 50 };
      setTransform(newTransform);
      // Reset the initial transform ref for the new design
      initialTransformRef.current = newTransform;
      setLoginError(null);

      // Auto-scroll to artwork column on mobile after generation completes
      if (typeof window !== 'undefined' && window.innerWidth < 768 && artworkColumnRef.current) {
        setTimeout(() => {
          artworkColumnRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 300);
      }

      // Persist design state to sessionStorage so refresh doesn't lose it
      try {
        const stateKey = `aiart:design:${shopDomain || 'local'}:${productHandle || 'unknown'}`;
        sessionStorage.setItem(stateKey, JSON.stringify({
          designId,
          imageUrl,
          prompt,
          selectedSize,
          selectedFrameColor,
          savedAt: Date.now(),
        }));
      } catch (e) { /* sessionStorage may be unavailable */ }

      // Auto-save design to account if user is logged in (storefront mode)
      // Use variables.customerId (from the mutation payload) to avoid stale closure issues
      const saveCustomerId = variables.customerId || storefrontCustomerId;
      const saveShop = variables.shop || shopDomain;
      // Store jobId for mockup saving after fetchPrintifyMockups completes
      if (data.jobId) savedJobIdRef.current = data.jobId;
      // Reset pre-created shadow variant for this new design
      setPreShadowVariantId(null);
      if (preShadowPollRef.current) { clearTimeout(preShadowPollRef.current); preShadowPollRef.current = null; }
      console.log('[AutoSave] isStorefront:', isStorefront, 'customerId:', saveCustomerId, 'jobId:', data.jobId);
      if (isStorefront && saveCustomerId && data.jobId) {
        safeFetch(`${API_BASE}/api/storefront/save-design`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: data.jobId, customerId: saveCustomerId, shop: saveShop }),
        }).then(r => r.json()).then(saved => {
          console.log('[AutoSave] save-design response:', saved);
          if (saved.saved) {
            // Refresh saved designs list
            setSavedDesignsLoading(true);
            safeFetch(`${API_BASE}/api/storefront/customizer/my-designs`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ shop: saveShop, customerId: saveCustomerId }),
            })
              .then(r => r.json()).then(d => { 
                console.log('[AutoSave] my-designs response:', d); 
                if (d.designs) {
                  setSavedDesigns(d.designs);
                  // Notify parent to refresh its gallery view
                  window.parent.postMessage({ type: 'APPAI_REFRESH_GALLERY' }, '*');
                }
              })
              .catch(() => {}).finally(() => setSavedDesignsLoading(false));
          }
        }).catch((e) => { console.error('[AutoSave] save-design error:', e); }); // log errors for debugging

        // Also save the full design state (transform, size, color, preset) so it can be fully restored
        safeFetch(`${API_BASE}/api/storefront/save-state`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId: data.jobId,
            shop: saveShop,
            designState: {
              scale: newTransform.scale,
              x: newTransform.x,
              y: newTransform.y,
              selectedSize,
              selectedFrameColor,
              stylePreset: selectedPreset || null,
              prompt,
            },
          }),
        }).catch(() => {}); // fire-and-forget
      }

      // Clear any existing mockups and fetch new Printify composite mockups
      setPrintifyMockups([]);
      setPrintifyMockupImages([]);
      setSelectedMockupIndex(0);
      mockupColorCacheRef.current = {};
      currentMockupColorRef.current = '';
      const shouldFetchMockups = !!(productTypeConfig?.hasPrintifyMockups) && !!imageUrl && !!selectedSize;
      console.log('[Mockups] onSuccess check:', {
        hasPrintifyMockups: productTypeConfig?.hasPrintifyMockups,
        imageUrl: imageUrl?.substring(0, 80),
        selectedSize,
        willFetch: shouldFetchMockups,
      });
      if (shouldFetchMockups) {
        if (productTypeConfig?.isAllOverPrint) {
          // AOP: show pattern customizer step first
          setAopPendingMotifUrl(toAbsoluteImageUrl(imageUrl));
          setAopPatternUrl(null);
          setShowPatternStep(true);
        } else {
          console.log('[Mockups] Triggering mockup generation');
          // Set mockupTriggered synchronously so the overlay stays up between
          // generateMutation.isPending=false and mockupLoading=true (no gap flash).
          setMockupTriggered(true);
          fetchPrintifyMockups(toAbsoluteImageUrl(imageUrl), productTypeConfig!.id, selectedSize, selectedFrameColor || 'default', zoomDefault, 50, 50);
        }
      }
    },
    onError: (err: any) => {
      console.error('[EmbedDesign] Generation error:', err?.message ?? err);
      // React Query already sets isPending=false on rejection, stopping the spinner.
      // Clear any stale login error so it doesn't block the next attempt.
      setLoginError(null);
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setReferenceImages(prev => {
      const remaining = 5 - prev.length;
      return [...prev, ...files.slice(0, remaining)];
    });
    files.slice(0, 5).forEach(file => {
      const reader = new FileReader();
      reader.onloadend = () => {
        setReferencePreviews(prev => {
          if (prev.length >= 5) return prev;
          return [...prev, reader.result as string];
        });
      };
      reader.readAsDataURL(file);
    });
    // Reset input so same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  };
  const clearReferenceImage = (index?: number) => {
    if (index !== undefined) {
      setReferenceImages(prev => prev.filter((_, i) => i !== index));
      setReferencePreviews(prev => prev.filter((_, i) => i !== index));
    } else {
      setReferenceImages([]);
      setReferencePreviews([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleGenerate = async () => {
    const activePresetForCheck = filteredStylePresets.find(p => p.id === selectedPreset);
    if (!prompt.trim() && !activePresetForCheck?.descriptionOptional) return;

    // Pre-check: block generation immediately if gallery is full
    if (savedDesigns.length >= galleryLimit) {
      setShowGalleryFullModal(true);
      // Scroll to top so the modal is visible on mobile (fixed positioning
      // inside an iframe doesn't work relative to the viewport)
      window.scrollTo({ top: 0, behavior: 'smooth' });
      // Also try to scroll the parent frame if embedded
      try { window.parent?.scrollTo({ top: 0, behavior: 'smooth' }); } catch {}
      return;
    }
    
    // Validate required fields
    if (showPresetsParam && filteredStylePresets.length > 0 && selectedPreset === "") {
      alert("Please select a style before generating");
      return;
    }
    if (printSizes.length > 0 && selectedSize === "") {
      alert("Please select a size before generating");
      return;
    }

    // Validate required style sub-option
    const activePreset = filteredStylePresets.find(p => p.id === selectedPreset);
    if (activePreset?.options?.required && selectedStyleOption === "") {
      alert(`Please choose a ${activePreset.options.label.toLowerCase()} before generating`);
      return;
    }

    // Build the prompt: prepend selected option fragment if present
    let fullPrompt = prompt;
    let resolvedBaseImageUrl: string | undefined;
    if (activePreset?.options && selectedStyleOption !== "") {
      const selectedChoice = activePreset.options.choices.find(c => c.id === selectedStyleOption);
      if (selectedChoice) {
        fullPrompt = `${selectedChoice.promptFragment}. ${prompt}`;
        if (selectedChoice.baseImageUrl) resolvedBaseImageUrl = selectedChoice.baseImageUrl;
      }
    }
    if (!resolvedBaseImageUrl && (activePreset as any)?.baseImageUrl) {
      resolvedBaseImageUrl = (activePreset as any).baseImageUrl;
    }
    if (selectedPreset && selectedPreset !== "") {
      const preset = filteredStylePresets.find((p) => p.id === selectedPreset);
      if (preset?.promptSuffix) {
        fullPrompt = `${fullPrompt}. ${preset.promptSuffix}`;
      }
    }

    fullPrompt +=
      ". Full-bleed design, edge-to-edge artwork, no borders or margins, seamless pattern that fills the entire canvas.";

    // Convert all reference images to base64
    const referenceImagesBase64: string[] = [];
    for (const imgFile of referenceImages) {
      const b64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(imgFile);
      });
      if (b64 && b64.length > 5 * 1024 * 1024) {
        throw new Error('One or more reference images are too large. Please use smaller images (max 5MB each).');
      }
      referenceImagesBase64.push(b64);
    }

    console.log('[Generate] clicked', {
      prompt: fullPrompt.substring(0, 80),
      selectedSize,
      selectedFrameColor,
      shopifyVariantId,
      productTypeId: productTypeConfig?.id ?? productTypeId,
      isStorefront,
      shop: (isShopify || isStorefront) ? shopDomain : undefined,
    });

    console.log('[Generate] Mutating with payload size:', {
      prompt: fullPrompt.length,
      referenceImages: referenceImagesBase64.length,
      shop: (isShopify || isStorefront) ? shopDomain : undefined,
    });

    try {
      generateMutation.mutate({
        prompt: fullPrompt,
        userPrompt: prompt, // raw user text — stored separately so it can be restored cleanly
        size: selectedSize,
        frameColor: selectedFrameColor || "black",
        stylePreset: selectedPreset && selectedPreset !== "" ? selectedPreset : undefined,
        referenceImages: referenceImagesBase64.length > 0 ? referenceImagesBase64 : undefined,
        baseImageUrl: resolvedBaseImageUrl || undefined,
        shop: (isShopify || isStorefront) ? shopDomain : undefined,
        sessionToken: (isShopify && !isStorefront) ? sessionToken || undefined : undefined,
        productTypeId: productTypeConfig?.id ? String(productTypeConfig.id) : productTypeId,
        sessionId: isStorefront ? anonSessionId : undefined,
        customerId: storefrontCustomerId || undefined,
      });
    } catch (err: any) {
      console.error('[Generate] Mutation trigger failed:', err);
      toast({
        title: "Generation Failed",
        description: err.message || "An unexpected error occurred while starting generation.",
        variant: "destructive",
      });
    }
    setDesignSource("ai");
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>, source: "upload" | "kittl") => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    setImportError(null);

    try {
      // Check file type (SVG not supported for security reasons)
      const allowedTypes = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
      if (!allowedTypes.includes(file.type)) {
        throw new Error("Please upload a PNG, JPG, or WebP image.");
      }

      // Check file size (max 10MB)
      const MAX_SIZE = 10 * 1024 * 1024;
      if (file.size > MAX_SIZE) {
        throw new Error("File too large. Maximum size is 10MB.");
      }

      // Step 1: Get presigned upload URL
      const uploadUrlResponse = await safeFetch(`${API_BASE}/api/uploads/request-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          contentType: file.type,
        }),
      });

      if (!uploadUrlResponse.ok) {
        throw new Error("Failed to get upload URL");
      }

      const { uploadURL, objectPath } = await uploadUrlResponse.json();

      // Step 2: Upload the file directly to storage (uploadURL is already absolute)
      const uploadResponse = await safeFetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!uploadResponse.ok) {
        throw new Error("Failed to upload file");
      }

      // Step 3: Validate and get image metadata
      const importResponse = await safeFetch(`${API_BASE}/api/designs/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl: objectPath,
          source,
          name: file.name,
        }),
      });

      if (!importResponse.ok) {
        const data = await importResponse.json();
        throw new Error(data.error || "Failed to import design");
      }

      const importData = await importResponse.json();

      // Step 4: Set the imported design as the current design
      const importedImageUrl = importData.imageUrl;
      setAddedToCart(false);
      setGeneratedDesign({
        id: crypto.randomUUID(),
        imageUrl: importedImageUrl,
        prompt: source === "kittl" ? `Imported from Kittl: ${file.name}` : `Uploaded design: ${file.name}`,
      });
      setPrompt(source === "kittl" ? `Imported from Kittl: ${file.name}` : `Uploaded design: ${file.name}`);
      setDesignSource(source);
      
      // Use conditional default zoom based on product type for better coverage
      let zoomDefault = 100;
      if (productTypeConfig?.designerType === "apparel") {
        zoomDefault = 135;
      } else if (productTypeConfig?.designerType === "pillow" || productTypeConfig?.name?.toLowerCase().includes("pillow") || productTypeConfig?.name?.toLowerCase().includes("cushion")) {
        zoomDefault = 120;
      } else if (productTypeConfig?.designerType === "framed-print" || productTypeConfig?.name?.toLowerCase().includes("frame") || productTypeConfig?.name?.toLowerCase().includes("framed")) {
        zoomDefault = 110;
      } else if (productTypeConfig?.aspectRatio) {
        // Landscape products (wider than tall, e.g. 4:3, 16:9) need 110% zoom to avoid white bands
        const [arW, arH] = productTypeConfig.aspectRatio.split(':').map(Number);
        if (arW && arH && arW > arH) zoomDefault = 110;
      }
      setTransform({ scale: zoomDefault, x: 50, y: 50 });
      
      // Persist design state to sessionStorage so refresh doesn't lose it
      try {
        const stateKey = `aiart:design:${shopDomain || 'local'}:${productHandle || 'unknown'}`;
        sessionStorage.setItem(stateKey, JSON.stringify({
          designId: crypto.randomUUID(),
          imageUrl: importedImageUrl,
          prompt: source === "kittl" ? `Imported from Kittl: ${file.name}` : `Uploaded design: ${file.name}`,
          selectedSize,
          selectedFrameColor,
          savedAt: Date.now(),
        }));
      } catch (e) { /* sessionStorage may be unavailable */ }

      // Clear any existing mockups. For AOP: show Pattern Customizer; else fetch Printify mockups.
      setPrintifyMockups([]);
      setPrintifyMockupImages([]);
      setSelectedMockupIndex(0);
      mockupColorCacheRef.current = {};
      currentMockupColorRef.current = '';
      if (productTypeConfig?.hasPrintifyMockups && importedImageUrl && selectedSize) {
        if (productTypeConfig.isAllOverPrint) {
          setAopPendingMotifUrl(toAbsoluteImageUrl(importedImageUrl));
          setAopPatternUrl(null);
          setShowPatternStep(true);
        } else {
          fetchPrintifyMockups(toAbsoluteImageUrl(importedImageUrl), productTypeConfig.id, selectedSize, selectedFrameColor || 'default', zoomDefault, 50, 50);
        }
      }

      toast({
        title: "Design imported!",
        description: "Your design is now ready to preview on the product.",
      });

      // Switch back to generate tab to show the mockup
      setActiveTab("generate");
    } catch (error: any) {
      console.error("Import error:", error);
      setImportError(error.message || "Failed to import design");
      toast({
        variant: "destructive",
        title: "Import failed",
        description: error.message || "Failed to import design. Please try again.",
      });
    } finally {
      setIsImporting(false);
      // Reset file inputs
      if (importFileInputRef.current) {
        importFileInputRef.current.value = "";
      }
      if (customUploadInputRef.current) {
        customUploadInputRef.current.value = "";
      }
    }
  };

  // Parse variants from URL params first
  useEffect(() => {
    try {
      const variantsData = searchParams.get("variants");
      if (variantsData) {
        const parsed = JSON.parse(variantsData);
        if (Array.isArray(parsed)) {
          setVariants(parsed);
          setVariantsFetched(true);
          console.log('[Design Studio] Parsed variants from URL:', parsed.length);
        }
      }
    } catch (e) {
      console.error("Failed to parse variants:", e);
    }
  }, []);

  // Fetch variants from server if not provided in URL (works for all themes)
  useEffect(() => {
    if (variantsFetched || (!isShopify && !isStorefront)) return;
    if (selectedVariantParam) {
      // If we have a selected variant, we don't need to fetch all variants
      setVariantsFetched(true);
      return;
    }
    
    // Use the myshopify.com domain specifically for variant API calls
    const myShopifyDomain = getMyShopifyDomain();
    if (!myShopifyDomain) {
      console.log('[Design Studio] Could not determine myshopify.com domain, skipping variant fetch');
      setVariantsFetched(true);
      return;
    }
    
    // Build the fetch URL - prefer productHandle but fall back to productTypeId
    let fetchUrl: string;
    if (productHandle) {
      console.log('[Design Studio] Fetching variants using productHandle:', productHandle);
      fetchUrl = `${API_BASE}/api/shopify/product-variants?shop=${encodeURIComponent(myShopifyDomain)}&handle=${encodeURIComponent(productHandle)}`;
    } else if (productTypeId) {
      console.log('[Design Studio] Fetching variants using productTypeId:', productTypeId);
      fetchUrl = `${API_BASE}/api/shopify/product-variants?shop=${encodeURIComponent(myShopifyDomain)}&productTypeId=${encodeURIComponent(productTypeId)}`;
    } else {
      console.log('[Design Studio] No productHandle or productTypeId available, skipping variant fetch');
      setVariantsFetched(true);
      return;
    }

    console.log('[Design Studio] Fetching variants from:', fetchUrl);
    safeFetch(fetchUrl)
      .then(res => {
        if (!res.ok) {
          console.log('[Design Studio] Variant fetch failed with status:', res.status);
          return { variants: [] };
        }
        return res.json();
      })
      .then(data => {
        if (data.variants && Array.isArray(data.variants)) {
          console.log('[Design Studio] Fetched variants from server:', data.variants.length);
          setVariants(data.variants);
        }
        setVariantsFetched(true);
      })
      .catch(err => {
        console.error('[Design Studio] Failed to fetch variants:', err);
        setVariantsFetched(true);
      });
  }, [isShopify, isStorefront, productHandle, productTypeId, selectedVariantParam, variantsFetched]);

  const findVariantId = (): string | null => {
    if (!isShopify && !isStorefront) return null;

    console.log('[Design Studio] Finding variant. selectedVariantParam:', selectedVariantParam, 
                'variants:', variants.length, 'selectedSize:', selectedSize, 
                'selectedFrameColor:', selectedFrameColor, 'hasColors:', frameColorObjects.length > 0);

    // Highest priority: variant chosen by storefront dropdown via postMessage
    if (overrideVariantId) {
      console.log('[Design Studio] Using overrideVariantId from parent:', overrideVariantId);
      return overrideVariantId;
    }

    // Second priority: use selectedVariantParam if provided (most reliable from theme)
    if (selectedVariantParam) {
      console.log('[Design Studio] Using selectedVariantParam:', selectedVariantParam);
      return selectedVariantParam;
    }

    // Second: try to match using variant options from Shopify
    if (variants.length > 0 && (selectedSize || selectedFrameColor)) {
      const matchedVariant = variants.find((v: any) => {
        // Only use option1 and option2 for matching — option3 is the 'Design' option
        // and including it would cause design variants to be selected accidentally.
        const options = [v.option1, v.option2].filter(Boolean);

        let sizeMatch = true;
        let colorMatch = true;

        if (selectedSize) {
          sizeMatch = options.some(
            (opt) =>
              opt?.toLowerCase().includes(selectedSize.toLowerCase()) ||
              selectedSize.toLowerCase().includes(opt?.toLowerCase())
          );
        }

        // Only check color if the product has frame colors
        if (selectedFrameColor && frameColorObjects.length > 0) {
          colorMatch = options.some(
            (opt) =>
              opt?.toLowerCase().includes(selectedFrameColor.toLowerCase()) ||
              selectedFrameColor.toLowerCase().includes(opt?.toLowerCase())
          );
        }

        return sizeMatch && colorMatch;
      });

      if (matchedVariant) {
        console.log('[Design Studio] Matched variant from options:', matchedVariant.id);
        return matchedVariant.id?.toString() || null;
      }
    }

    // Third: for single-variant products, use the first variant
    if (variants.length === 1) {
      console.log('[Design Studio] Using single variant:', variants[0].id);
      return variants[0].id?.toString() || null;
    }

    // Fourth: fall back to shopifyVariantId received via postMessage from the parent page
    if (shopifyVariantId) {
      console.log('[Design Studio] Falling back to shopifyVariantId:', shopifyVariantId);
      return shopifyVariantId;
    }

    console.log('[Design Studio] No variant found');
    return null;
  };

  /**
   * Send add-to-cart via postMessage to the parent Shopify storefront page.
   * The parent's theme extension script handles the actual /cart/add.js fetch.
   * Returns a promise that resolves when the parent confirms the cart update.
   */
  const addToCartStorefront = (payload: {
    variantId: string;
    baseVariantId?: string;
    quantity: number;
    properties: Record<string, string>;
  }): Promise<{ success: boolean; error?: string }> => {
    // Log bridge state for diagnostics but don't fail fast — allow postMessage attempt
    // The parent sends BRIDGE_READY every 500ms, so React state may lag real connectivity
    if (!bridgeReady && !(window as any).__aiArtBridgeReady) {
      console.warn('[Design Studio] addToCartStorefront: bridge not confirmed yet, attempting anyway');
    }

    return new Promise((resolve) => {
      const correlationId = `cart_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const TIMEOUT_MS = 12_000;

      const cleanup = () => {
        window.removeEventListener('message', handler);
        clearTimeout(timer);
      };

      const handler = (event: MessageEvent) => {
        if (
          event.data?.type === 'AI_ART_STUDIO_ADD_TO_CART_RESULT' &&
          event.data?.correlationId === correlationId
        ) {
          cleanup();
          const isOk = !!(event.data.ok || event.data.success);
          console.log('[Design Studio] Received cart result:', {
            ok: isOk,
            error: event.data.error,
            bridgeVersion: event.data._bridgeVersion,
            origin: event.origin,
          });
          resolve({
            success: isOk,
            error: event.data.error,
          });
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        console.error('[Design Studio] Add-to-cart postMessage timed out after', TIMEOUT_MS, 'ms');
        console.error('[Design Studio] Timeout diagnostics:', {
          correlationId,
          variantId: payload.variantId,
          parentExists: window.parent !== window,
          topExists: window.top !== window,
          bridgeReady: bridgeReady || !!(window as any).__aiArtBridgeReady,
          locationOrigin: window.location.origin,
        });
        resolve({ success: false, error: 'Cart update timed out. The storefront page may not have the add-to-cart handler loaded. Please refresh and try again.' });
      }, TIMEOUT_MS);

      window.addEventListener('message', handler);

      const message = {
        type: 'AI_ART_STUDIO_ADD_TO_CART',
        correlationId,
        variantId: payload.variantId,
        baseVariantId: payload.baseVariantId,
        quantity: payload.quantity,
        properties: payload.properties,
        _bridgeVersion: '1.0.0',
      };

      // Send to parent (primary target)
      console.log('[Design Studio] Sending add-to-cart postMessage:', {
        correlationId,
        variantId: payload.variantId,
        propertyKeys: Object.keys(payload.properties),
        sentTo: 'parent',
        origin: window.location.origin,
      });
      window.parent.postMessage(message, '*');

      // Also send to top if different from parent (nested iframe scenario)
      try {
        if (window.top && window.top !== window.parent) {
          console.log('[Design Studio] Also sending to window.top (nested iframe)');
          window.top.postMessage(message, '*');
        }
      } catch (e) {
        // Cross-origin access to window.top — ignore
      }
    });
  };

  const handleAddToCart = async () => {
    if (!generatedDesign || (!isShopify && !isStorefront)) return;
    if (isAddingToCart) return; // double-click guard
    if (mockupsStale) {
      setVariantError("Please refresh mockups before adding to cart — your frame color selection has changed.");
      return;
    }

    const variantId = findVariantId();

    if (!variantId) {
      const hasColors = frameColorObjects.length > 0;
      const errorMsg = hasColors
        ? "Unable to find matching product variant. Please select a valid size and color combination."
        : "Unable to find matching product variant. Please select a valid size.";
      setVariantError(errorMsg);
      return;
    }

    if (!shopDomain) {
      setVariantError("Unable to add to cart: Shop information is missing. Please refresh the page.");
      return;
    }

    setVariantError(null);

    // If the product needs mockups but none are loaded yet (e.g. older saved design
    // with no stored mockupUrls), trigger a fresh mockup generation before proceeding.
    // This sets mockupsStale=false and loads new mockups; the button's onClick will
    // re-run handleAddToCart once mockups are ready via the atcWaitingForMockups path.
    const hasMockupProduct = !!(productTypeConfig?.hasPrintifyMockups);
    const hasMockups = printifyMockups.length > 0 || printifyMockupImages.length > 0;
    if (hasMockupProduct && !hasMockups && generatedDesign?.imageUrl && productTypeConfig && selectedSize) {
      console.log('[Design Studio] No mockups loaded for saved design — triggering fresh mockup generation before cart add');
      setMockupError(null);
      setMockupFailed(false);
      setMockupsStale(true); // will show "Refresh Mockups to Continue" then auto-proceed
      // Trigger mockup generation — once done, atcWaitingForMockups will clear
      // and the user can click Add to Cart again (or we auto-proceed via the button state)
      fetchPrintifyMockups(
        toAbsoluteImageUrl(generatedDesign.imageUrl),
        productTypeConfig.id,
        selectedSize,
        selectedFrameColor || 'default',
        transform.scale,
        transform.x,
        transform.y
      );
      return; // don't proceed with cart add yet — wait for mockups
    }

    setIsAddingToCart(true);

    // Normalize variant ID (strip GID prefix if present)
    const normalizedVariant = normalizeVariantId(variantId);

    // Build the full artwork URL — try to get hosted with a 10s cap, but don't block cart add
    let artworkFullUrl = '';
    try {
      artworkFullUrl = await Promise.race([
        ensureHostedUrl(generatedDesign.imageUrl),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('ensureHostedUrl timed out after 10s')), 10_000)
        ),
      ]);
      // If we had to upload, also update stored design
      if (artworkFullUrl !== toAbsoluteImageUrl(generatedDesign.imageUrl)) {
        setGeneratedDesign(prev => prev ? { ...prev, imageUrl: artworkFullUrl } : prev);
      }
    } catch (e: any) {
      console.warn('[Design Studio] ensureHostedUrl failed, proceeding without _artwork_url:', e.message);
      // If it's already a hosted URL (not data:), use it as-is
      if (!isDataUrl(generatedDesign.imageUrl)) {
        artworkFullUrl = toAbsoluteImageUrl(generatedDesign.imageUrl);
      }
      // else: data URL too large for Shopify cart property (255 char limit) — omit
    }

    // Guard: only use the mockup URL if it belongs to the currently selected color.
    // Without this, changing frame color and adding to cart before mockups refresh
    // would send the previous color's mockup to the cart.
    const colorMatches = !selectedFrameColor || currentMockupColorRef.current === selectedFrameColor;
    const mockupFullUrl = colorMatches ? getPreferredMockupUrl() : '';
    if (!mockupFullUrl) {
      console.warn('[Design Studio] No mockup URL available for cart. colorMatches:', colorMatches,
        'currentColor:', currentMockupColorRef.current, 'selected:', selectedFrameColor,
        'printifyMockups:', printifyMockups.length, 'printifyMockupImages:', printifyMockupImages.length);
    } else {
      console.log('[Design Studio] Mockup URL for cart:', mockupFullUrl.substring(0, 120));
    }

    // Build line item properties for Printify fulfillment
    // Use the same human-readable label as the cart-state broadcast so both
    // code paths produce an identical _design_id (required for variant dedup).
    const _activePreset = filteredStylePresets.find(p => p.id === selectedPreset);
    const _styleLabel = _activePreset?.name || '';
    const _productLabel = displayName || productTitle || '';
    const _rawId = String(generatedDesign.id || '');
    const _shortHash = (() => {
      let h = 0;
      for (let i = 0; i < _rawId.length; i++) { h = (Math.imul(31, h) + _rawId.charCodeAt(i)) | 0; }
      return Math.abs(h).toString(36).slice(0, 4);
    })();
    const _readableDesignId = [_productLabel, _styleLabel].filter(Boolean).join(' · ') + (_shortHash ? ` #${_shortHash}` : '');
    const properties: Record<string, string> = {
      '_design_id': _readableDesignId || _rawId,
      'Artwork': 'Custom AI Design',
    };
    if (artworkFullUrl) properties['_artwork_url'] = artworkFullUrl;
    if (mockupFullUrl) properties['_mockup_url'] = mockupFullUrl;
    if (selectedSize) properties['Size'] = selectedSize;
    if (selectedFrameColor) properties['Color'] = selectedFrameColor;

    // Resolve the unique design variant before adding to cart.
    // Fast path: use pre-created shadow variant if available (created in background after mockups).
    // Slow path: call resolve-design-variant on demand (creates shadow product synchronously).
    let finalVariantId = normalizedVariant;
    if (preShadowVariantId) {
      // Instant — shadow product was pre-created in the background
      finalVariantId = preShadowVariantId;
      console.log('[Design Studio] Using pre-created shadow variant (instant):', finalVariantId);
      // Extend the shadow product expiry to 7 days now that it's been added to cart
      if (preShadowProductId && shopDomain) {
        safeFetch(`${API_BASE}/api/storefront/shadow-product/cart-added`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shop: shopDomain, shadowProductId: preShadowProductId }),
        }).catch(() => {});
      }
    } else if (mockupFullUrl && mockupFullUrl.startsWith('https://') && productId && shopDomain) {
      try {
        console.log('[Design Studio] Resolving unique design variant before cart add (on demand)...');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000); // 20s timeout for variant creation
        const resolveRes = await safeFetch(`${API_BASE}/api/storefront/resolve-design-variant`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shop: shopDomain,
            productId,
            variantId: normalizedVariant,
            designId: properties['_design_id'],
            mockupUrl: mockupFullUrl,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (resolveRes.ok) {
          const data = await resolveRes.json();
          if (data.success && data.variantId) {
            finalVariantId = data.variantId;
            console.log('[Design Studio] Resolved unique variant (on demand):', finalVariantId);
          }
        } else {
          console.warn('[Design Studio] resolve-design-variant failed:', resolveRes.status);
        }
      } catch (e: any) {
        console.warn('[Design Studio] resolve-design-variant error/timeout:', e?.message || e);
      }
    }

    // Storefront mode: use postMessage to parent (AJAX cart, no navigation)
    if (isStorefront) {
      try {
        const result = await addToCartStorefront({
          variantId: finalVariantId,
          baseVariantId: normalizedVariant,
          quantity: 1,
          properties,
        });

        if (result.success) {
          console.log('[Design Studio] Storefront add-to-cart success');
          setAddedToCart(true);
          toast({
            title: "Added to cart!",
            description: "Your custom design has been added to the cart.",
          });
          // Tell parent to re-run cart image swap after a short delay so the
          // freshly-added item's DOM element is in place.
          if (mockupFullUrl) {
            window.parent.postMessage({
              type: 'AI_ART_STUDIO_REPLACE_CART_IMAGES',
              mockupUrl: mockupFullUrl,
              variantId: normalizedVariant,
            }, '*');
          }
          // Persist design state
          try {
            const stateKey = `aiart:last_design:${shopDomain}:${productHandle || 'unknown'}:${normalizedVariant}`;
            sessionStorage.setItem(stateKey, JSON.stringify({
              designId: generatedDesign.id,
              imageUrl: generatedDesign.imageUrl,
              prompt: generatedDesign.prompt,
              addedAt: Date.now(),
            }));
          } catch (e) {
            // sessionStorage may be unavailable in some iframe contexts
            console.warn('[Design Studio] Could not persist design state:', e);
          }
          // Auto-reset the form after 2.5 s so the user can immediately start a new design
          // without needing to click "Start Fresh Design" again.
          setTimeout(() => {
            setAddedToCart(false);
            setGeneratedDesign(null);
            setDesignSource(null);
            loadDesignAppliedRef.current = false;
            setBridgeLoadDesignId('');
            setReferenceImages([]);
            setReferencePreviews([]);
            if (fileInputRef.current) fileInputRef.current.value = '';
            setSelectedPreset('');
            setSelectedStyleOption('');
            setSelectedSize('');
            setSelectedFrameColor('');
            try {
              const stateKey = `aiart:design:${shopDomain || 'local'}:${productHandle || 'unknown'}`;
              sessionStorage.removeItem(stateKey);
            } catch (_) { /* sessionStorage may be unavailable */ }
            const url = new URL(window.location.href);
            url.searchParams.delete('loadDesignId');
            window.history.replaceState({}, '', url.toString());
            // Also clear loadDesignId from the PARENT page URL.
            // parentLoadDesignId reads window.parent.location.search directly, so if the
            // parent URL still has loadDesignId after the reset, effectiveLoadDesignId stays
            // set and isLoadingSaved becomes true → infinite shimmer.
            try {
              const parentUrl = new URL(window.parent.location.href);
              parentUrl.searchParams.delete('loadDesignId');
              window.parent.history.replaceState({}, '', parentUrl.toString());
            } catch (_) { /* cross-origin guard */ }
          }, 2500);
        } else {
          setVariantError(`Failed to add to cart: ${result.error || 'Unknown error'}`);
        }
      } catch (e: any) {
        console.error('[Design Studio] Add-to-cart error:', e);
        setVariantError(`Failed to add to cart: ${e.message || 'Unknown error'}`);
      } finally {
        setIsAddingToCart(false);
      }
      return;
    }

    // Admin-embedded / standalone mode: use AJAX cart add via Shopify API
    // Avoids navigating to a blank page which can lose state
    try {
      const cartApiUrl = `https://${shopDomain}/cart/add.js`;
      console.log('[Design Studio] Admin-embedded cart add via AJAX:', cartApiUrl);
      const cartResponse = await fetch(cartApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          items: [{ id: Number(finalVariantId), quantity: 1, properties }],
        }),
        credentials: 'include',
      });

      if (cartResponse.ok) {
        console.log('[Design Studio] Admin-embedded cart add success');
        setAddedToCart(true);
        toast({
          title: "Added to cart!",
          description: "Your custom design has been added to the cart.",
        });
      } else {
        const errorData = await cartResponse.json().catch(() => ({}));
        const errorMsg = errorData.description || errorData.message || `HTTP ${cartResponse.status}`;
        setVariantError(`Failed to add to cart: ${errorMsg}`);
      }
    } catch (e: any) {
      console.warn('[Design Studio] AJAX cart add failed, falling back to navigation:', e);
      // Fallback: open cart URL in a new tab (never navigate the current iframe)
      const cartParams = new URLSearchParams();
      cartParams.set('id', finalVariantId);
      cartParams.set('quantity', '1');
      for (const [key, value] of Object.entries(properties)) {
        cartParams.set(`properties[${key}]`, value);
      }
      const cartUrl = `https://${shopDomain}/cart/add?${cartParams.toString()}`;
      window.open(cartUrl, '_blank');
    } finally {
      setIsAddingToCart(false);
    }
  };

  const handleShare = async () => {
    if (!generatedDesign) return;

    setIsSharing(true);
    try {
      const response = await safeFetch(`${API_BASE}/api/designs/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl: generatedDesign.imageUrl,
          prompt: generatedDesign.prompt,
          stylePreset: selectedPreset !== "" ? selectedPreset : null,
          size: selectedSize,
          frameColor: selectedFrameColor,
          transformScale: transform.scale,
          transformX: transform.x,
          transformY: transform.y,
          productTypeId: parseInt(productTypeId) || null,
          shopDomain: shopDomain || null,
          productId: productId || null,
          productHandle: productHandle || null,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to create share link");
      }

      const data = await response.json();
      const shareUrl = data.shareUrl;

      // Use Web Share API if available
      if (navigator.share) {
        await navigator.share({
          title: `Custom ${productTitle} Design`,
          text: `Check out this custom design I created: "${prompt}"`,
          url: shareUrl,
        });
        toast({
          title: "Shared!",
          description: "Your design was shared successfully.",
        });
      } else {
        // Fallback: copy to clipboard
        await navigator.clipboard.writeText(shareUrl);
        toast({
          title: "Link Copied!",
          description: "Share link copied to clipboard.",
        });
      }
    } catch (err: any) {
      // Don't show error if user cancelled share dialog
      if (err?.name !== "AbortError") {
        console.error("Share failed:", err);
        toast({
          title: "Share Failed",
          description: "Unable to share design. Please try again.",
          variant: "destructive",
        });
      }
    } finally {
      setIsSharing(false);
    }
  };

  useEffect(() => {
    const DB = debugBridge;
    if (DB) console.log('[Bridge Debug] Setting up bridge listeners, isStorefront:', isStorefront);

    const handleMessage = (event: MessageEvent) => {
      const type = event.data?.type;
      if (!type) return;

      // Debug: log all AI_ART_STUDIO messages
      if (DB && typeof type === 'string' && type.indexOf('AI_ART_STUDIO') === 0) {
        console.log('[Bridge Debug] MSG:', type, 'origin:', event.origin, 'data:', JSON.stringify(event.data).substring(0, 300));
      }

      // Legacy cart-updated handler (backwards compat)
      if (type === "ai-art-studio:cart-updated") {
        if ((window as any).__addToCartTimeout) {
          clearTimeout((window as any).__addToCartTimeout);
          delete (window as any).__addToCartTimeout;
        }
        setIsAddingToCart(false);
        if (event.data.success) {
          setGeneratedDesign(null);
          setPrompt("");
        } else if (event.data.error) {
          setVariantError(`Failed to add to cart: ${event.data.error}`);
        }
      }

      // BRIDGE_READY from parent — the parent's message listener is active
      if (type === "AI_ART_STUDIO_BRIDGE_READY") {
        console.log('[Design Studio] BRIDGE_READY received from parent!',
          'parentVersion:', event.data._bridgeVersion,
          'heartbeat:', event.data.heartbeat);
        setBridgeReady(true);
        setBridgeError(null);
        (window as any).__aiArtBridgeReady = true;
        // ACK is deferred — sent only after configLoading is false (see deferred ACK useEffect below)
        // so the parent loading screen stays visible until the React UI is fully rendered.
      }

      // Legacy PING from parent — respond with PONG (backwards compat)
      if (type === "AI_ART_STUDIO_PING") {
        console.log('[Design Studio] Received PING from parent, sending PONG');
        (window as any).__aiArtBridgeReady = true;
        setBridgeReady(true);
        setBridgeError(null);
        window.parent.postMessage({
          type: 'AI_ART_STUDIO_PONG',
          _bridgeVersion: '1.0.0',
          pingTimestamp: event.data.timestamp,
        }, '*');
      }

      // Variant selected by the storefront variant dropdown
      if (type === "AI_ART_STUDIO_VARIANT_CHANGE" && event.data.variantId) {
        const vid = String(event.data.variantId);
        console.log('[Design Studio] VARIANT_CHANGE from parent, variantId=', vid);
        setOverrideVariantId(vid);
      }

      // Shopify variants with prices pushed by parent after bridge handshake
      if (type === "AI_ART_STUDIO_SHOPIFY_VARIANTS" && Array.isArray(event.data.variants)) {
        console.log('[Design Studio] SHOPIFY_VARIANTS received:', event.data.variants.length, 'variants');
        setShopifyVariants(event.data.variants);
        const base = event.data.baseVariantId ? String(event.data.baseVariantId) : null;
        if (base) {
          setShopifyVariantId(base);
          setOverrideVariantId(base);
        } else if (event.data.variants.length > 0) {
          setShopifyVariantId(String(event.data.variants[0].id));
          setOverrideVariantId(String(event.data.variants[0].id));
        }
      }

      // Style presets pushed by parent after bridge handshake (avoids /api/config round-trip)
      if (type === "AI_ART_STUDIO_STYLE_PRESETS" && Array.isArray(event.data.stylePresets)) {
        console.log('[Design Studio] STYLE_PRESETS received:', event.data.stylePresets.length, 'presets');
        setStylePresets(event.data.stylePresets);
      }

      // Store theme: apply merchant's colors, fonts and radius to the iframe's CSS variables
      if (type === "AI_ART_STUDIO_THEME" && event.data.theme) {
        const t = event.data.theme as Record<string, string>;
        const root = document.documentElement.style;

        // -- Background & text --
        const bgHSL = cssColorToHSL(t.backgroundColor);
        const fgHSL = cssColorToHSL(t.textColor);
        if (bgHSL) root.setProperty('--background', bgHSL);
        if (fgHSL) {
          root.setProperty('--foreground', fgHSL);
          root.setProperty('--card-foreground', fgHSL);
        }

        // -- Primary button --
        const btnBgHSL = cssColorToHSL(t.buttonBg);
        const btnFgHSL = cssColorToHSL(t.buttonColor);
        if (btnBgHSL) {
          root.setProperty('--primary', btnBgHSL);
          root.setProperty('--ring', btnBgHSL);
          root.setProperty('--sidebar-primary', btnBgHSL);
          // Derive primary-border as slightly darker
          root.setProperty('--primary-border', adjustHSLLightness(btnBgHSL, -8));
        }
        if (btnFgHSL) {
          root.setProperty('--primary-foreground', btnFgHSL);
        }
        if (t.buttonRadius) {
          // Shopify buttons may have e.g. "4px" or "24px"; map to --radius
          root.setProperty('--radius', t.buttonRadius);
        }

        // -- Fonts --
        if (t.fontFamily) {
          root.setProperty('--font-sans', t.fontFamily);
        }
        if (t.headingFontFamily && t.headingFontFamily !== t.fontFamily) {
          root.setProperty('--font-heading', t.headingFontFamily);
        }

        // -- Input border --
        const inputBorderHSL = cssColorToHSL(t.inputBorderColor);
        if (inputBorderHSL) {
          root.setProperty('--border', inputBorderHSL);
          root.setProperty('--input', inputBorderHSL);
        }
        const inputBgHSL = cssColorToHSL(t.inputBg);
        if (inputBgHSL) {
          root.setProperty('--card', inputBgHSL);
        }

        // -- Accent (links) --
        const accentHSL = cssColorToHSL(t.accentColor);
        if (accentHSL) {
          root.setProperty('--accent', accentHSL);
        }

        // -- Derived secondary/muted colors from background --
        if (bgHSL) {
          // Secondary is slightly off-background (darker in light mode)
          root.setProperty('--secondary', adjustHSLLightness(bgHSL, -6));
          root.setProperty('--secondary-border', adjustHSLLightness(bgHSL, -14));
          // Muted is a subtle mid-tone
          root.setProperty('--muted', adjustHSLLightness(bgHSL, -8));
          // Card backgrounds
          root.setProperty('--popover', adjustHSLLightness(bgHSL, -3));
        }
        if (fgHSL) {
          // Muted foreground is a lighter version of the text color
          root.setProperty('--muted-foreground', adjustHSLLightness(fgHSL, 30));
          root.setProperty('--secondary-foreground', fgHSL);
        }

        console.log('[Design Studio] Applied store theme CSS variables');
      }

      // Load saved design sent via postMessage from the parent page bridge
      // This is the primary mechanism — more reliable than URL params which can be cached by Shopify CDN
      if (type === "AI_ART_STUDIO_LOAD_DESIGN" && event.data.loadDesignId) {
        const bridgeLoadId = String(event.data.loadDesignId);
        console.log('[LoadDesign] Received LOAD_DESIGN via postMessage:', bridgeLoadId);
        // Reset the applied ref so the restore effect will run
        loadDesignAppliedRef.current = false;
        // Set the bridge-provided loadDesignId into state so the restore effect can use it
        setBridgeLoadDesignId(bridgeLoadId);
      }
    };

    window.addEventListener("message", handleMessage);

    // Bridge handshake: retry IFRAME_READY every 2s until parent responds with BRIDGE_READY
    let bridgeTimeout: ReturnType<typeof setTimeout> | null = null;
    let iframeReadyTimer: ReturnType<typeof setInterval> | null = null;
    if (isStorefront) {
      const sendIframeReady = () => {
        if ((window as any).__aiArtBridgeReady) return; // already connected
        console.log('[Design Studio] Sending IFRAME_READY to parent');
        window.parent.postMessage({
          type: 'AI_ART_STUDIO_IFRAME_READY',
          _bridgeVersion: '1.0.0',
        }, '*');
        try {
          if (window.top && window.top !== window.parent) {
            window.top.postMessage({
              type: 'AI_ART_STUDIO_IFRAME_READY',
              _bridgeVersion: '1.0.0',
            }, '*');
          }
        } catch (e) {
          // Cross-origin access — ignore
        }
      };

      // Send immediately, then retry every 2s for 20s (handles slow parent load)
      sendIframeReady();
      iframeReadyTimer = setInterval(() => {
        if ((window as any).__aiArtBridgeReady) {
          if (iframeReadyTimer) { clearInterval(iframeReadyTimer); iframeReadyTimer = null; }
          return;
        }
        sendIframeReady();
      }, 2_000);

      // Optimistic fallback: if BRIDGE_READY hasn't arrived in 4s, assume the parent
      // is listening and allow the ATC button to proceed. The postMessage attempt will
      // either succeed or time out gracefully.
      setTimeout(() => {
        if (!(window as any).__aiArtBridgeReady) {
          console.warn('[Design Studio] No BRIDGE_READY in 4s — enabling ATC optimistically');
          setBridgeReady(true);
          (window as any).__aiArtBridgeReady = true;
        }
      }, 4_000);

      // If bridge doesn't connect in 20s, show actionable error
      bridgeTimeout = setTimeout(() => {
        if (iframeReadyTimer) { clearInterval(iframeReadyTimer); iframeReadyTimer = null; }
        if (!(window as any).__aiArtBridgeReady) {
          console.error('[Design Studio] Bridge timeout: no BRIDGE_READY after 20s');
          setBridgeError('Storefront bridge not detected. The add-to-cart feature requires the AI Art Studio theme extension to be enabled on your product page. Please contact the store owner.');
        }
      }, 20_000);
    }

    return () => {
      window.removeEventListener("message", handleMessage);
      if (bridgeTimeout) clearTimeout(bridgeTimeout);
      if (iframeReadyTimer) clearInterval(iframeReadyTimer);
    };
  }, [isStorefront, debugBridge]);

  useEffect(() => {
    if (!isEmbedded && !isStorefront) return;
    // Send resize messages so the parent container grows with our content (no scrollbar).
    // Debounced to 60ms to prevent layout thrashing on rapid content changes (e.g. image load).
    let rafId: number | null = null;
    const sendHeight = () => {
      if (rafId !== null) return; // already scheduled
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const h = Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
          document.documentElement.offsetHeight
        );
        window.parent.postMessage({ type: 'ai-art-studio:resize', height: h }, '*');
      });
    };
    const observer = new ResizeObserver(sendHeight);
    observer.observe(document.body);
    sendHeight(); // send immediately on mount
    return () => { observer.disconnect(); if (rafId !== null) cancelAnimationFrame(rafId); };
  }, [isEmbedded, isStorefront]);

  // Wheel event forwarding: when the mouse is over the iframe but NOT inside an open
  // Radix dropdown, forward wheel events to the parent page so it can scroll normally.
  // This also fixes the initial scroll glitch where the first few scrolls are swallowed.
  useEffect(() => {
    if (!isEmbedded && !isStorefront) return;
    const handleWheel = (e: WheelEvent) => {
      // Check if a Radix dropdown/popover is currently open
      const isRadixOpen = !!document.querySelector(
        '[data-radix-select-content],[data-radix-popper-content-wrapper],[data-radix-dropdown-menu-content],[data-radix-popover-content]'
      );
      if (isRadixOpen) {
        // A dropdown is open — check if the wheel target is INSIDE the dropdown
        const target = e.target as Element | null;
        const insideDropdown = target?.closest(
          '[data-radix-select-content],[data-radix-popper-content-wrapper],[data-radix-dropdown-menu-content],[data-radix-popover-content]'
        );
        if (insideDropdown) return; // let the dropdown scroll naturally
        // Mouse is outside the dropdown but a dropdown is open — still forward to parent
        // so the background page can scroll while the dropdown is open
      }
      // Forward wheel event to parent page
      window.parent.postMessage({
        type: 'ai-art-studio:wheel',
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaZ: e.deltaZ,
        deltaMode: e.deltaMode,
      }, '*');
    };
    // Use passive:false so we can call preventDefault if needed, but we don't
    // preventDefault here — we want the iframe to also process the event
    window.addEventListener('wheel', handleWheel, { passive: true });
    return () => window.removeEventListener('wheel', handleWheel);
  }, [isEmbedded, isStorefront]);

  // Counteract Radix UI's body scroll lock in iframe context.
  // Radix adds overflow:hidden + padding-right to body[data-scroll-locked] when
  // a Select/Dialog opens. In an iframe this prevents the dropdown from scrolling.
  // We use a MutationObserver to immediately remove these styles.
  useEffect(() => {
    if (!isEmbedded && !isStorefront) return;
    const observer = new MutationObserver(() => {
      const body = document.body;
      if (body.hasAttribute('data-scroll-locked')) {
        // Radix locked the body — remove the inline styles it added
        // but keep the attribute so Radix's own logic still works
        const style = body.style;
        if (style.overflow === 'hidden') style.overflow = '';
        if (style.overflowX === 'hidden') style.overflowX = '';
        if (style.overflowY === 'hidden') style.overflowY = '';
        // Remove padding-right compensation (not needed in iframe)
        if (style.paddingRight) style.paddingRight = '';
        if (style.marginRight) style.marginRight = '';
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-scroll-locked', 'style'] });
    return () => observer.disconnect();
  }, [isEmbedded, isStorefront]);

  // Set initial transform when design is loaded/created
  useEffect(() => {
    if (generatedDesign?.id && !initialTransformRef.current) {
      initialTransformRef.current = { ...transform };
    }
  }, [generatedDesign?.id]);

  // Debounced save of transform changes for owned designs
  useEffect(() => {
    // Only save if we have a real design ID (not a crypto UUID which means imported/shared)
    // and if the design is not a shared design from another user
    if (!generatedDesign?.id || isSharedDesign) return;
    
    // Skip if ID is a UUID string (imported designs use crypto.randomUUID())
    // Real database IDs are numeric
    const designId = String(generatedDesign.id);
    if (isNaN(parseInt(designId, 10)) || designId.includes("-")) return;
    
    // Don't save if this is the initial load
    if (!initialTransformRef.current) return;
    
    // Check if transform actually changed
    const hasChanged = 
      transform.scale !== initialTransformRef.current.scale ||
      transform.x !== initialTransformRef.current.x ||
      transform.y !== initialTransformRef.current.y;
    
    if (!hasChanged) return;
    
    // Debounce the save - wait 1 second after last change
    const timer = setTimeout(async () => {
      try {
        await apiRequest("PATCH", `${API_BASE}/api/designs/${generatedDesign.id}`, {
          transformScale: transform.scale,
          transformX: transform.x,
          transformY: transform.y,
        });
        // Update the initial ref to the new saved values
        initialTransformRef.current = { ...transform };
      } catch (error) {
        console.error("Failed to save transform:", error);
        // Silent fail - don't interrupt user experience
      }
    }, 1000);
    
    return () => clearTimeout(timer);
  }, [transform, generatedDesign?.id, isSharedDesign]);

  const printSizes: PrintSize[] = (productTypeConfig?.sizes || []).map((s) => ({
    id: s.id,
    name: s.name,
    width: s.width,
    height: s.height,
    aspectRatio: productTypeConfig?.aspectRatio || "3:4",
  }));

  const frameColorObjects: FrameColor[] = (productTypeConfig?.frameColors || []).map((c) => ({
    id: c.id,
    name: c.name,
    hex: c.hex,
  }));

  const selectedSizeConfig = printSizes.find((s) => s.id === selectedSize) || null;
  const selectedFrameColorConfig = frameColorObjects.find((f) => f.id === selectedFrameColor) || null;

  // Build a price map from shopifyVariants, keyed by size id
  const buildPriceMap = useCallback((): Record<string, number> => {
    const priceMap: Record<string, number> = {};
    if (!shopifyVariants || shopifyVariants.length === 0) return priceMap;
    
    console.log('[buildPriceMap] shopifyVariants:', shopifyVariants);
    console.log('[buildPriceMap] printSizes:', printSizes);
    
    // For each size, find a matching variant and get its price
    for (const size of printSizes) {
      const matchedVariant = shopifyVariants.find((v: any) => {
        const options = [v.title].filter(Boolean);
        return options.some(
          (opt) =>
            opt?.toLowerCase().includes(size.name.toLowerCase()) ||
            size.name.toLowerCase().includes(opt?.toLowerCase())
        );
      });
      
      if (matchedVariant && matchedVariant.price) {
        // Convert price string to cents (multiply by 100)
        const priceInCents = Math.round(parseFloat(matchedVariant.price) * 100);
        priceMap[size.id] = priceInCents;
        console.log(`[buildPriceMap] Matched ${size.name} (${size.id}) to variant ${matchedVariant.title}: $${matchedVariant.price}`);
      }
    }
    
    console.log('[buildPriceMap] Final priceMap:', priceMap);
    return priceMap;
  }, [shopifyVariants, printSizes])

  // Auto-resolve the Shopify variant that matches the currently selected size + frame color.
  // Runs whenever size, frame color, or the variants list changes.
  // This drives the price display and the overrideVariantId used for add-to-cart.
  useEffect(() => {
    if (!isStorefront || shopifyVariants.length === 0) return;

    const sizeName = printSizes.find(s => s.id === selectedSize)?.name ?? selectedSize ?? '';
    const frameName = frameColorObjects.find(f => f.id === selectedFrameColor)?.name ?? selectedFrameColor ?? '';

    // 1. Try to match variant title containing both size name and frame name
    let match = shopifyVariants.find(v => {
      const t = v.title.toLowerCase();
      const hasSize = !sizeName || t.includes(sizeName.toLowerCase());
      const hasFrame = !frameName || frameColorObjects.length === 0
        || t.includes(frameName.toLowerCase());
      return hasSize && hasFrame;
    });

    // 2. Fallback: match size only (frame color may not be a variant axis in Shopify)
    if (!match && sizeName) {
      match = shopifyVariants.find(v =>
        v.title.toLowerCase().includes(sizeName.toLowerCase())
      );
    }

    // 3. Fallback: first variant
    if (!match) match = shopifyVariants[0];

    if (match) {
      setShopifyVariantId(match.id);
      setOverrideVariantId(match.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSize, selectedFrameColor, shopifyVariants, isStorefront]);

  // Fetch saved designs when logged in
  const isLoggedIn = customer?.isLoggedIn ?? !!storefrontCustomerId;
  const credits = customer?.credits ?? 0;
  useEffect(() => {
    if (!isLoggedIn || !storefrontCustomerId || !shopDomain) return;
    setSavedDesignsLoading(true);
    safeFetch(`${API_BASE}/api/storefront/customizer/my-designs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shop: shopDomain, customerId: storefrontCustomerId }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.designs) setSavedDesigns(data.designs);
        if (data.limit) setGalleryLimit(data.limit);
      })
      .catch(() => {})
      .finally(() => setSavedDesignsLoading(false));
  }, [isLoggedIn, storefrontCustomerId, shopDomain]);

  // Only wait for config to load - session can load in background
  // Session is only needed for generating, not for viewing the UI
  if (configLoading) {
    // In storefront/Shopify mode the bridge loading screen already covers the page,
    // so returning anything here causes a double-up. Return a transparent placeholder.
    if (isStorefront || isShopify) {
      return <div className="bg-transparent" data-testid="container-loading" />;
    }
    return (
      <div className={`p-4 ${isEmbedded ? "bg-transparent" : "bg-background min-h-screen"}`}>
        <div className="max-w-2xl mx-auto space-y-4">
          <div className="flex items-center justify-center gap-2 py-4" data-testid="container-loading">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <span className="text-sm font-medium">Loading design studio...</span>
          </div>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    );
  }

  // Derived values for the ATC button state — computed at render scope to avoid IIFE in JSX
  const atcHasMockups = productTypeConfig?.hasPrintifyMockups;
  const atcMockupsReady = printifyMockups.length > 0 || printifyMockupImages.length > 0;
  const atcWaitingForMockups = !!(
    atcHasMockups &&
    generatedDesign?.imageUrl &&
    mockupLoading &&
    !atcMockupsReady
  );

  return (
    <div className={`p-4 ${isEmbedded || isStorefront ? "bg-transparent" : "bg-background min-h-screen"}`}>
      {/* Guide box shimmer + title shimmer animations */}
      <style>{`
        /* Single graceful left-to-right shimmer sweep on guide boxes */
        @keyframes appai-guide-sweep {
          0%   { transform: translateX(-120%); }
          100% { transform: translateX(220%); }
        }
        [data-guide-box="active"] {
          position: relative;
          overflow: hidden;
          border-radius: 6px;
        }
        [data-guide-box="active"]::before {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(
            105deg,
            transparent 30%,
            rgba(255,255,255,0.45) 50%,
            transparent 70%
          );
          width: 60%;
          animation: appai-guide-sweep 2s ease-in-out 1 forwards;
          pointer-events: none;
          z-index: 10;
        }

      `}</style>
      <div className="max-w-6xl mx-auto space-y-4">
        {/* Free generation limit reached — prompt to create account */}
        {freeLimitReached && (
          <Card className="border-orange-500 bg-orange-50 dark:bg-orange-950">
            <CardContent className="py-3">
              <p className="text-orange-700 dark:text-orange-300 text-sm font-medium">
                You've used all 10 free generations. Create an account to continue designing!
              </p>
            </CardContent>
          </Card>
        )}

        {/* Login errors */}
        {loginError && (
          <Card className="border-amber-500 bg-amber-50 dark:bg-amber-950">
            <CardContent className="py-3">
              <p className="text-amber-700 dark:text-amber-300 text-sm" data-testid="text-login-error">
                {loginError}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Fatal error: no product type config loaded - stop rendering here */}
        {!productTypeConfig && productTypeError && (
          <Card className="border-destructive bg-destructive/10">
            <CardContent className="py-4">
              <div className="flex items-start gap-3">
                <div className="text-destructive mt-0.5">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-destructive font-semibold text-sm">Configuration Error</h3>
                  <p className="text-destructive/90 text-sm mt-1" data-testid="text-product-type-error">
                    {productTypeError}
                  </p>
                  <p className="text-destructive/70 text-xs mt-2">
                    Product handle: {productHandle || 'unknown'} | Shop: {searchParams.get("shop") || 'unknown'}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* If fatal error, don't show the rest of the UI */}
        {!productTypeConfig && productTypeError ? null : (
          <>
        {/* Warning: product type config loaded but with issues */}
        {productTypeConfig && productTypeError && (
          <Card className="border-amber-500 bg-amber-50 dark:bg-amber-950">
            <CardContent className="py-3">
              <p className="text-amber-700 dark:text-amber-300 text-sm" data-testid="text-product-type-warning">
                {productTypeError}
              </p>
            </CardContent>
          </Card>
        )}

        {sharedDesignError && (
          <Card className="border-destructive bg-destructive/10">
            <CardContent className="py-3">
              <p className="text-destructive text-sm" data-testid="text-shared-design-error">
                {sharedDesignError}. You can still create a new design below.
              </p>
            </CardContent>
          </Card>
        )}

        {sessionError && isShopify && (
          <Card className="border-destructive bg-destructive/10">
            <CardContent className="py-3">
              <p className="text-destructive text-sm" data-testid="text-session-error">
                Unable to connect: {sessionError}. Please ensure the app is properly installed on your store.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Build Badge for Deployment Verification */}
        <div
          style={{
            position: "fixed",
            bottom: 8,
            right: 8,
            zIndex: 999999,
            background: "#ff6b6b",
            color: "white",
            padding: "4px 8px",
            fontSize: "10px",
            borderRadius: "3px",
            fontFamily: "monospace",
            whiteSpace: "nowrap",
          }}
        >
          BUILD: cc5dfd6
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Generator/form panel — right on desktop, first on mobile */}
          <div className="space-y-4 order-1 md:order-2">
            {/* User account pills — shown above form on desktop, top of page on mobile */}
            {(isStorefront || (!isShopify && !isStorefront)) && (
              <div className="relative">
                {isLoggedIn ? (
                  <div className="flex flex-nowrap gap-2 overflow-x-auto" data-testid="user-actions">
                    {/* Combined account button: shows email on hover, click signs out */}
                    <div className="relative group flex-shrink-0">
                      <button
                        onClick={() => {
                          setCustomer(null);
                          setStorefrontCustomerId(null);
                          setOtpEmail('');
                          try { localStorage.removeItem('appai_customer_id'); localStorage.removeItem('appai_otp_email'); localStorage.removeItem('appai_customer'); } catch {}
                          setShowSavedDesigns(false);
                          setShowCouponInput(false);
                        }}
                        className="px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition-colors cursor-pointer whitespace-nowrap flex items-center gap-1.5"
                        title={customer?.email}
                      >
                        {/* Default label: Sign out */}
                        <span className="group-hover:hidden">Sign out</span>
                        {/* Hover label: show email */}
                        <span className="hidden group-hover:inline truncate max-w-[160px]">{customer?.email || 'Signed in'}</span>
                      </button>
                    </div>
                    <button
                      onClick={() => { setShowSavedDesigns(!showSavedDesigns); setShowCouponInput(false); }}
                      className="px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition-colors cursor-pointer whitespace-nowrap flex-shrink-0"
                    >
                      Saved Designs{savedDesigns.length > 0 ? ` (${savedDesigns.length})` : ''}
                    </button>
                    <button
                      onClick={() => { setShowCouponInput(!showCouponInput); setShowSavedDesigns(false); setCouponError(null); setCouponSuccess(null); }}
                      className="px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition-colors cursor-pointer whitespace-nowrap flex-shrink-0"
                    >
                      Redeem Code
                    </button>
                    {credits > 0 && (
                      <div className="px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 whitespace-nowrap flex-shrink-0">
                        {credits} credit{credits !== 1 ? 's' : ''}
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => setShowOtpLogin(true)}
                    className="px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition-colors cursor-pointer flex items-center gap-1.5"
                    data-testid="text-login-prompt"
                  >
                    <LogIn className="w-4 h-4" />
                    Sign in to save designs
                  </button>
                )}

                {/* OTP Login — absolute overlay, doesn't push content */}
                {showOtpLogin && (
                  <div className="absolute left-0 top-full mt-2 z-50" style={{ maxWidth: '400px', width: '100%' }}>
                    <Card className="border-primary bg-background shadow-lg">
                      <CardContent className="py-4">
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="text-sm font-semibold">Sign in with Email</h3>
                          <button
                            onClick={() => { setShowOtpLogin(false); setOtpStep('email'); setOtpError(null); setOtpCode(''); }}
                            className="text-muted-foreground hover:text-foreground bg-transparent border-none cursor-pointer p-1"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                        {otpError && (
                          <p className="text-destructive text-xs mb-2">{otpError}</p>
                        )}
                        {otpStep === 'email' ? (
                          <div className="flex gap-2">
                            <input
                              type="email"
                              placeholder="Enter your email"
                              value={otpEmail}
                              onChange={(e) => setOtpEmail(e.target.value)}
                              className="flex-1 px-3 py-2 text-sm border rounded-md bg-background"
                              disabled={otpLoading}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && otpEmail.trim()) {
                                  e.preventDefault();
                                  setOtpLoading(true);
                                  setOtpError(null);
                                  safeFetch(`${API_BASE}/api/storefront/auth/request-otp`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ email: otpEmail.trim(), shop: shopDomain }),
                                  })
                                    .then(r => r.json())
                                    .then(data => {
                                      if (data.ok) { setOtpStep('code'); }
                                      else { setOtpError(data.error || 'Failed to send code'); }
                                    })
                                    .catch(() => setOtpError('Failed to send code'))
                                    .finally(() => setOtpLoading(false));
                                }
                              }}
                            />
                            <Button
                              size="sm"
                              disabled={!otpEmail.trim() || otpLoading}
                              onClick={() => {
                                setOtpLoading(true);
                                setOtpError(null);
                                safeFetch(`${API_BASE}/api/storefront/auth/request-otp`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ email: otpEmail.trim(), shop: shopDomain }),
                                })
                                  .then(r => r.json())
                                  .then(data => {
                                    if (data.ok) { setOtpStep('code'); }
                                    else { setOtpError(data.error || 'Failed to send code'); }
                                  })
                                  .catch(() => setOtpError('Failed to send code'))
                                  .finally(() => setOtpLoading(false));
                              }}
                            >
                              {otpLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send Code'}
                            </Button>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <p className="text-xs text-muted-foreground">Enter the 6-digit code sent to {otpEmail}</p>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                placeholder="000000"
                                value={otpCode}
                                maxLength={6}
                                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                                className="flex-1 px-3 py-2 text-sm border rounded-md bg-background tracking-widest text-center"
                                disabled={otpLoading}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && otpCode.length === 6) {
                                    e.preventDefault();
                                    setOtpLoading(true);
                                    setOtpError(null);
                                    safeFetch(`${API_BASE}/api/storefront/auth/verify-otp`, {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ email: otpEmail.trim(), code: otpCode, shop: shopDomain }),
                                    })
                                      .then(r => r.json())
                                      .then(data => {
                                        if (data.ok) {
                                          const newCustomerId = data.customerId;
                                          setStorefrontCustomerId(newCustomerId);
                                          setCustomer({ email: otpEmail.trim(), id: newCustomerId, credits: data.credits || 0, freeGenerationsUsed: data.freeGenerationsUsed ?? 0, isLoggedIn: true });
                                          setGalleryLimit(data.galleryLimit || 10);
                                          try {
                                            localStorage.setItem('appai_customer_id', newCustomerId);
                                            localStorage.setItem('appai_otp_email', otpEmail.trim());
                                            localStorage.setItem('appai_customer', JSON.stringify({ email: otpEmail.trim(), id: newCustomerId }));
                                          } catch {}
                                          setShowOtpLogin(false);
                                          setOtpStep('email');
                                          setOtpCode('');
                                          if (anonSessionId && shopDomain) {
                                            safeFetch(`${API_BASE}/api/storefront/merge-session`, {
                                              method: 'POST',
                                              headers: { 'Content-Type': 'application/json' },
                                              body: JSON.stringify({ sessionId: anonSessionId, customerId: newCustomerId, shop: shopDomain }),
                                            }).catch(() => {});
                                          }
                                          if (shopDomain) {
                                            setSavedDesignsLoading(true);
                                            safeFetch(`${API_BASE}/api/storefront/customizer/my-designs?shop=${encodeURIComponent(shopDomain)}&customerId=${encodeURIComponent(newCustomerId)}`)
                                              .then(r => r.json()).then(d => { if (d.designs) setSavedDesigns(d.designs); })
                                              .catch(() => {}).finally(() => setSavedDesignsLoading(false));
                                          }
                                        } else {
                                          setOtpError(data.error || 'Invalid code');
                                        }
                                      })
                                      .catch(() => setOtpError('Verification failed'))
                                      .finally(() => setOtpLoading(false));
                                  }
                                }}
                              />
                              <Button
                                size="sm"
                                disabled={otpCode.length !== 6 || otpLoading}
                                onClick={() => {
                                  setOtpLoading(true);
                                  setOtpError(null);
                                  safeFetch(`${API_BASE}/api/storefront/auth/verify-otp`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ email: otpEmail.trim(), code: otpCode, shop: shopDomain }),
                                  })
                                    .then(r => r.json())
                                    .then(data => {
                                      if (data.ok) {
                                        const newCustomerId = data.customerId;
                                        setStorefrontCustomerId(newCustomerId);
                                        setCustomer({ email: otpEmail.trim(), id: newCustomerId, credits: data.credits || 0, freeGenerationsUsed: data.freeGenerationsUsed ?? 0, isLoggedIn: true });
                                        setGalleryLimit(data.galleryLimit || 10);
                                        try {
                                          localStorage.setItem('appai_customer_id', newCustomerId);
                                          localStorage.setItem('appai_otp_email', otpEmail.trim());
                                          localStorage.setItem('appai_customer', JSON.stringify({ email: otpEmail.trim(), id: newCustomerId }));
                                        } catch {}
                                        setShowOtpLogin(false);
                                        setOtpStep('email');
                                        setOtpCode('');
                                        if (anonSessionId && shopDomain) {
                                          safeFetch(`${API_BASE}/api/storefront/merge-session`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ sessionId: anonSessionId, customerId: newCustomerId, shop: shopDomain }),
                                          }).catch(() => {});
                                        }
                                        if (shopDomain) {
                                          setSavedDesignsLoading(true);
                                          safeFetch(`${API_BASE}/api/storefront/customizer/my-designs?shop=${encodeURIComponent(shopDomain)}&customerId=${encodeURIComponent(newCustomerId)}`)
                                            .then(r => r.json()).then(d => { if (d.designs) setSavedDesigns(d.designs); })
                                            .catch(() => {}).finally(() => setSavedDesignsLoading(false));
                                        }
                                      } else {
                                        setOtpError(data.error || 'Invalid code');
                                      }
                                    })
                                    .catch(() => setOtpError('Verification failed'))
                                    .finally(() => setOtpLoading(false));
                                }}
                              >
                                {otpLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Verify'}
                              </Button>
                            </div>
                            <button
                              onClick={() => { setOtpStep('email'); setOtpCode(''); setOtpError(null); }}
                              className="text-xs text-muted-foreground hover:text-foreground bg-transparent border-none cursor-pointer p-0"
                            >
                              Use a different email
                            </button>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                )}

                {/* Saved Designs dropdown panel */}
                {showSavedDesigns && isLoggedIn && (
                  <div className="absolute left-0 top-full mt-2 z-50" style={{ maxWidth: '500px', width: '100%' }}>
                    <Card className="border bg-background shadow-lg">
                      <CardContent className="py-4">
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="text-sm font-semibold">Saved Designs ({savedDesigns.length}/{galleryLimit})</h3>
                          <button
                            onClick={() => setShowSavedDesigns(false)}
                            className="text-muted-foreground hover:text-foreground bg-transparent border-none cursor-pointer p-1"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                        {savedDesigns.length >= galleryLimit - 4 && savedDesigns.length < galleryLimit && (
                          <div className="mb-3 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-800">
                            You're almost at your {galleryLimit}-design limit. Delete unwanted designs to make room.
                          </div>
                        )}
                        {savedDesigns.length >= galleryLimit && (
                          <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-800">
                            Gallery full ({galleryLimit}/{galleryLimit}). Delete a design before generating a new one.
                          </div>
                        )}
                        {savedDesignsLoading ? (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Loading your designs...
                          </div>
                        ) : savedDesigns.length === 0 ? (
                          <p className="text-sm text-muted-foreground py-2">No saved designs yet. Generate a design to see it here.</p>
                        ) : (
                          <div
                            className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-[360px] overflow-y-auto overscroll-contain pr-1"
                            onWheel={(e) => {
                              const el = e.currentTarget;
                              const atTop = el.scrollTop === 0;
                              const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
                              // Prevent scroll from bubbling to the parent page (iframe boundary)
                              if (!(atTop && e.deltaY < 0) && !(atBottom && e.deltaY > 0)) {
                                e.stopPropagation();
                              }
                            }}
                          >
                            {savedDesigns.map((d: any) => (
                              <div key={d.id} className="relative group">
                                <div
                                  className="rounded-md overflow-hidden border border-border cursor-pointer hover:border-primary transition-colors"
                                  onClick={() => {
                                    setShowSavedDesigns(false);
                                    // If this design belongs to a different product type, navigate
                                    // the parent page to the correct customizer page first.
                                    const currentProductTypeId = productTypeId ? String(productTypeId) : null;
                                    const designProductTypeId = d.productTypeId ? String(d.productTypeId) : null;
                                    const needsNavigation = d.pageHandle && designProductTypeId && currentProductTypeId && designProductTypeId !== currentProductTypeId;
                                    if (needsNavigation) {
                                      // Navigate parent to the correct customizer page with loadDesignId
                                      try {
                                        const parentUrl = new URL(window.parent.location.href);
                                        parentUrl.pathname = `/pages/${d.pageHandle}`;
                                        parentUrl.searchParams.set('loadDesignId', d.id);
                                        window.parent.location.href = parentUrl.toString();
                                      } catch {
                                        // Fallback: reload current page (cross-origin guard)
                                        const params = new URLSearchParams(window.location.search);
                                        params.set('loadDesignId', d.id);
                                        window.history.replaceState({}, '', `${window.location.pathname}?${params}`);
                                        window.location.reload();
                                      }
                                    } else {
                                      // Update both the parent page URL and the iframe URL so
                                      // parentLoadDesignId (which takes priority) picks up the
                                      // correct design after the iframe reloads.
                                      try {
                                        const parentUrl = new URL(window.parent.location.href);
                                        parentUrl.searchParams.set('loadDesignId', d.id);
                                        window.parent.history.replaceState({}, '', parentUrl.toString());
                                      } catch {
                                        // cross-origin guard — fall back to iframe-only
                                      }
                                      const params = new URLSearchParams(window.location.search);
                                      params.set('loadDesignId', d.id);
                                      window.history.replaceState({}, '', `${window.location.pathname}?${params}`);
                                      window.location.reload();
                                    }
                                  }}
                                >
                                  <div className="aspect-square relative bg-muted">
                                    {(() => {
                                      const mockupSrc = d.mockupUrls && d.mockupUrls.length > 0 ? d.mockupUrls[0] : null;
                                      const displaySrc = mockupSrc || d.artworkUrl;
                                      return displaySrc ? (
                                        <img
                                          src={displaySrc}
                                          alt={d.baseTitle || 'Saved design'}
                                          className="w-full h-full object-cover"
                                          onError={(e) => {
                                            // If mockup URL fails, fall back to artwork URL
                                            const img = e.target as HTMLImageElement;
                                            if (mockupSrc && d.artworkUrl && img.src !== d.artworkUrl) {
                                              img.src = d.artworkUrl;
                                            } else {
                                              img.style.display = 'none';
                                            }
                                          }}
                                        />
                                      ) : (
                                        <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">No preview</div>
                                      );
                                    })()}
                                  </div>
                                  <div className="px-2 py-1.5">
                                    {d.baseTitle && (
                                      <p className="text-xs font-medium truncate">{d.baseTitle}</p>
                                    )}
                                    {d.prompt && (
                                      <p className="text-[10px] text-muted-foreground truncate">{d.prompt}</p>
                                    )}
                                  </div>
                                </div>
                                {/* Delete button — visible on hover (desktop) or always visible (mobile) */}
                                <button
                                  className="absolute top-1 right-1 z-10 w-5 h-5 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity hover:bg-red-600"
                                  title="Delete design"
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    if (!confirm('Delete this saved design?')) return;
                                    try {
                                      const effectiveCustomerId = storefrontCustomerId || d.customerId || '';
                                      const deleteParams = new URLSearchParams();
                                      if (shopDomain) deleteParams.set('shop', shopDomain);
                                      if (effectiveCustomerId) deleteParams.set('customerId', effectiveCustomerId);
                                      const r = await safeFetch(`${API_BASE}/api/storefront/customizer/my-designs/${d.id}?${deleteParams.toString()}`, {
                                        method: 'DELETE',
                                        headers: { 'Content-Type': 'application/json' },
                                      });
                                      if (r.ok) {
                                        setSavedDesigns(prev => prev.filter(x => x.id !== d.id));
                                        // Notify parent to refresh its gallery view
                                        window.parent.postMessage({ type: 'APPAI_REFRESH_GALLERY' }, '*');
                                      }
                                    } catch {}
                                  }}
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                )}

                {/* Coupon Code dropdown panel */}
                {showCouponInput && isLoggedIn && (
                  <div className="absolute left-0 top-full mt-2 z-50" style={{ maxWidth: '400px', width: '100%' }}>
                    <Card className="border bg-background shadow-lg">
                      <CardContent className="py-4">
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="text-sm font-semibold">Redeem Credit Code</h3>
                          <button
                            onClick={() => { setShowCouponInput(false); setCouponError(null); setCouponSuccess(null); }}
                            className="text-muted-foreground hover:text-foreground bg-transparent border-none cursor-pointer p-1"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                        {couponError && <p className="text-destructive text-xs mb-2">{couponError}</p>}
                        {couponSuccess && <p className="text-green-600 text-xs mb-2">{couponSuccess}</p>}
                        <div className="flex gap-2">
                          <input
                            type="text"
                            placeholder="Enter code"
                            value={couponCode}
                            onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                            className="flex-1 px-3 py-2 text-sm border rounded-md bg-background"
                            disabled={couponLoading}
                          />
                          <Button
                            size="sm"
                            disabled={!couponCode.trim() || couponLoading}
                            onClick={() => {
                              setCouponLoading(true);
                              setCouponError(null);
                              setCouponSuccess(null);
                              safeFetch(`${API_BASE}/api/storefront/auth/redeem-coupon`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ code: couponCode.trim(), customerId: storefrontCustomerId, shop: shopDomain }),
                              })
                                .then(r => r.json())
                                .then(data => {
                                  if (data.ok) {
                                    setCouponSuccess(`${data.creditsAdded} credit${data.creditsAdded !== 1 ? 's' : ''} added!`);
                                    setCustomer(prev => prev ? { ...prev, credits: data.newBalance } : prev);
                                    setCouponCode('');
                                  } else {
                                    setCouponError(data.error || 'Invalid code');
                                  }
                                })
                                .catch(() => setCouponError('Failed to redeem code'))
                                .finally(() => setCouponLoading(false));
                            }}
                          >
                            {couponLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Redeem'}
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                )}
              </div>
            )}
            {/* Product title + price */}
            {(isStorefront || isShopify) && (
              <div className="space-y-1">
                <h1
                  className="text-xl font-bold leading-tight"
                  data-testid="text-product-title"
                >
                  {productTypeConfig?.name || displayName || productTitle}
                </h1>
                {shopifyVariants.length > 0 && (() => {
                  const activeId = shopifyVariantId || shopifyVariants[0]?.id || '';
                  const selected = shopifyVariants.find(v => v.id === activeId) || shopifyVariants[0];
                  if (!selected || !selected.price || parseFloat(selected.price) <= 0) return null;
                  return (
                    <p className="text-lg font-semibold text-muted-foreground" data-testid="text-product-price">
                      ${parseFloat(selected.price).toFixed(2)}
                    </p>
                  );
                })()}
              </div>
            )}
            <div className="space-y-4 mt-4">
              {/* Row 1: Generate/AddToCart + Upload side-by-side */}
              <div className="flex flex-col sm:flex-row gap-2">
                {/* Primary action button — left, wider: Generate OR Add to Cart */}
                <div className="flex-1 min-w-0">
                  {(isShopify || isStorefront) && generatedDesign ? (
                    /* ── Add to Cart state ── */
                    addedToCart ? (
                      <Button
                        className="w-full h-11 text-base font-medium bg-green-600 hover:bg-green-700 text-white"
                        onClick={() => { window.parent.location.href = '/cart'; }}
                        data-testid="button-view-cart"
                      >
                        <CheckCircle className="w-5 h-5 mr-2" />
                        Added to Cart — View Cart
                      </Button>
                    ) : (
                      <Button
                        onClick={() => {
                          if (mockupsStale) {
                            // Refresh mockups first, then the button will switch to Add to Cart
                            if (generatedDesign?.imageUrl && productTypeConfig && selectedSize) {
                              setMockupError(null);
                              setMockupFailed(false);
                              setPrintifyMockups([]);
                              setPrintifyMockupImages([]);
                              setSelectedMockupIndex(0);
                              setMockupsStale(false);
                              mockupColorCacheRef.current = {};
                              currentMockupColorRef.current = '';
                              fetchPrintifyMockups(
                                toAbsoluteImageUrl(generatedDesign.imageUrl),
                                productTypeConfig.id,
                                selectedSize,
                                selectedFrameColor || 'default',
                                transform.scale,
                                transform.x,
                                transform.y
                              );
                            }
                          } else {
                            handleAddToCart();
                          }
                        }}
                        disabled={isAddingToCart || atcWaitingForMockups || mockupLoading || (productTypeConfig?.isAllOverPrint && !aopPatternUrl)}
                        className="w-full h-11 text-base font-medium bg-black text-white border-black hover:bg-black/90 dark:bg-black dark:text-white dark:border-black disabled:opacity-50 disabled:cursor-not-allowed"
                        data-testid="button-add-to-cart"
                      >
                        {isAddingToCart ? (
                          <>
                            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                            <span className="shimmer-text-white">Adding to Cart...</span>
                          </>
                        ) : atcWaitingForMockups || (mockupsStale && mockupLoading) ? (
                          <>
                            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                            <span className="shimmer-text-white">Refreshing Mockups…</span>
                          </>
                        ) : mockupsStale ? (
                          <>
                            <RefreshCcw className="w-5 h-5 mr-2" />
                            <span className="shimmer-text-white">Refresh Mockups to Continue</span>
                          </>
                        ) : productTypeConfig?.isAllOverPrint && !aopPatternUrl ? (
                          <>
                            <span className="shimmer-text-white">Apply Pattern to Continue</span>
                          </>
                        ) : (
                          <>
                            <ShoppingCart className="w-5 h-5 mr-2" />
                            <span className="shimmer-text-white">Add to Cart</span>
                          </>
                        )}
                      </Button>
                    )
                  ) : (
                    /* ── Generate state ── */
                    <Button
                      onClick={() => {
                        if (showPresetsParam && filteredStylePresets.length > 0 && selectedPreset === "") {
                          alert("Please select a style before generating");
                          return;
                        }
                        const activePreset = filteredStylePresets.find(p => p.id === selectedPreset);
                        if (activePreset?.options?.required && selectedStyleOption === "") {
                          alert(`Please choose a ${activePreset.options.label.toLowerCase()} before generating`);
                          return;
                        }
                        if (printSizes.length > 0 && selectedSize === "") {
                          alert("Please select a size before generating");
                          return;
                        }
                        handleGenerate();
                      }}
                      disabled={!!effectiveLoadDesignId || (!prompt.trim() && !filteredStylePresets.find(p => p.id === selectedPreset)?.descriptionOptional) || generateMutation.isPending || freeLimitReached || credits <= 0}
                      className="w-full h-11 text-base font-medium bg-black text-white border-black hover:bg-black/90 dark:bg-black dark:text-white dark:border-black"
                      data-testid="button-generate"
                    >
                      {generateMutation.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          <span className="shimmer-text-white">Generating...</span>
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-4 h-4 mr-2" />
                          <span className="shimmer-text-white">Generate Design</span>
                        </>
                      )}
                    </Button>
                  )}
                  {/* Credits label — shown under Generate; Start Fresh — shown after generation */}
                  {(isShopify || isStorefront) && generatedDesign ? (
                    <div className="mt-1 flex flex-col items-center gap-1">
                      {variantError && (
                        <p className="text-destructive text-xs text-center" data-testid="text-variant-error-atc">{variantError}</p>
                      )}
                      {isStorefront && bridgeError && (
                        <p className="text-destructive text-xs text-center" data-testid="text-bridge-error">{bridgeError}</p>
                      )}
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 bg-transparent border-none cursor-pointer p-0 flex items-center gap-1"
                        onClick={() => {
                          setGeneratedDesign(null);
                          setDesignSource(null);
                          setAddedToCart(false);
                          loadDesignAppliedRef.current = false;
                          setBridgeLoadDesignId('');
                          setReferenceImages([]);
                          setReferencePreviews([]);
                          if (fileInputRef.current) fileInputRef.current.value = '';
                          setSelectedPreset('');
                          setSelectedStyleOption('');
                          setSelectedSize('');
                          setSelectedFrameColor('');
                          try {
                            const stateKey = `aiart:design:${shopDomain || 'local'}:${productHandle || 'unknown'}`;
                            sessionStorage.removeItem(stateKey);
                          } catch (_) {}
                          const url = new URL(window.location.href);
                          url.searchParams.delete('loadDesignId');
                          window.history.replaceState({}, '', url.toString());
                          try {
                            const parentUrl = new URL(window.parent.location.href);
                            parentUrl.searchParams.delete('loadDesignId');
                            window.parent.history.replaceState({}, '', parentUrl.toString());
                          } catch (_) {}
                        }}
                      >
                        <Plus className="w-3 h-3" />
                        Start Fresh Design
                      </button>
                    </div>
                  ) : (
                    (isShopify || isStorefront) && (
                      <p className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-1">
                        {(() => {
                          if (storefrontCustomerId && credits > 0) return `${credits} artwork${credits !== 1 ? 's' : ''} remaining`;
                          if (credits > 0) return `${credits} free artwork${credits !== 1 ? 's' : ''}`;
                          if (customer) return '0 artworks remaining';
                          return '10 free artworks';
                        })()}
                        <Popover>
                          <PopoverTrigger asChild>
                            <button type="button" className="inline-flex items-center" aria-label="Pricing info">
                              <Info className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground transition-colors" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent className="text-sm space-y-2 w-72" side="bottom" align="start">
                            <p className="font-medium">Artwork Credits</p>
                            <p className="text-muted-foreground">You get 10 free AI-generated artworks to try.</p>
                            <p className="text-muted-foreground">After that, it&apos;s just $1 for 10 more credits.</p>
                            <p className="text-muted-foreground">Credits are fully refunded when you complete a physical product purchase!</p>
                          </PopoverContent>
                        </Popover>
                      </p>
                    )
                  )}
                </div>

                {/* Upload reference image — right, narrower */}
                <div className="flex-1 min-w-0" data-guide-box={guideActiveBox === 4 ? "active" : undefined}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleFileChange}
                    className="hidden"
                    data-testid="input-reference-file"
                  />
                  <input
                    ref={importFileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/jpg,image/webp"
                    onChange={(e) => handleImportFile(e, "kittl")}
                    className="hidden"
                    data-testid="input-import-kittl"
                  />
                  <input
                    ref={customUploadInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/jpg,image/webp"
                    onChange={(e) => handleImportFile(e, "upload")}
                    className="hidden"
                    data-testid="input-import-custom"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full h-11"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={referenceImages.length >= 5}
                    data-testid="button-upload-reference"
                  >
                    <ImagePlus className="w-4 h-4 mr-2 shrink-0" />
                    {isImporting ? "Importing..." : referenceImages.length >= 5 ? "Max 5 images" : "Upload"}
                  </Button>
                  <p className="text-xs text-muted-foreground mt-1 text-center">
                    Reference Images (optional, up to 5)
                  </p>
                  {referencePreviews.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {referencePreviews.map((preview, idx) => (
                        <div key={idx} className="relative shrink-0">
                          <img
                            src={preview}
                            alt={`Reference ${idx + 1}`}
                            className="w-9 h-9 object-cover rounded"
                            data-testid={`img-reference-preview-${idx}`}
                          />
                          <Button
                            type="button"
                            variant="destructive"
                            size="icon"
                            className="absolute -top-1.5 -right-1.5 w-4 h-4"
                            onClick={() => clearReferenceImage(idx)}
                            data-testid={`button-clear-reference-${idx}`}
                          >
                            <X className="w-2.5 h-2.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  {importError && (
                    <p className="text-destructive text-xs mt-1" data-testid="text-import-error">
                      {importError}
                    </p>
                  )}
                </div>
              </div>

              {/* Style + Size side-by-side on desktop, stacked on mobile */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Style Selection */}
                {showPresetsParam && filteredStylePresets.length > 0 && (
                  <div className="space-y-1" data-guide-box={guideActiveBox === 1 ? "active" : undefined}>
                    <StyleSelector
                      stylePresets={filteredStylePresets}
                      selectedStyle={selectedPreset}
                      onStyleChange={(id) => { setSelectedPreset(id); setSelectedStyleOption(""); }}
                    />
                    {selectedPreset === "" && (
                      <p className="text-xs text-muted-foreground">Please select a style before generating</p>
                    )}
                  </div>
                )}

                {/* Size Selector */}
                {printSizes.length > 0 && (
                  <div className="space-y-1" data-guide-box={guideActiveBox === 2 ? "active" : undefined}>
                    <SizeSelector
                      sizes={printSizes}
                      selectedSize={selectedSize}
                      onSizeChange={(sizeId) => {
                        setSelectedSize(sizeId);
                        setTransform({ scale: defaultZoom, x: 50, y: 50 });
                      }}
                      prices={buildPriceMap()}
                    />
                    {selectedSize === "" && (
                      <p className="text-xs text-muted-foreground mt-1">Please select a size</p>
                    )}
                  </div>
                )}

                {/* Frame Color (full width if no style selector, otherwise second column) */}
                {frameColorObjects.length > 0 && (
                  <div className={showPresetsParam && filteredStylePresets.length > 0 && printSizes.length > 0 ? "sm:col-span-2" : ""}>
                    <FrameColorSelector
                      frameColors={frameColorObjects}
                      selectedFrameColor={selectedFrameColor}
                      onFrameColorChange={setSelectedFrameColor}
                      colorLabel={productTypeConfig?.colorLabel || "Color"}
                    />
                  </div>
                )}
              </div>

              {/* Style Sub-Options */}
              {showPresetsParam && selectedPreset !== "" && (() => {
                const activePreset = filteredStylePresets.find(p => p.id === selectedPreset);
                if (!activePreset?.options) return null;
                const { label, choices } = activePreset.options;
                return (
                  <div style={{ border: '1px solid #d1d5db', borderRadius: '6px', padding: '12px', marginTop: '4px' }}>
                    <Label style={{ display: 'block', marginBottom: '8px' }}>{label}</Label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      {choices.map((choice) => {
                        const isSelected = selectedStyleOption === choice.id;
                        return (
                          <button
                            key={choice.id}
                            type="button"
                            onClick={() => setSelectedStyleOption(choice.id)}
                            style={isSelected
                              ? { backgroundColor: '#111827', color: '#ffffff', border: '2px solid #111827', borderRadius: '9999px', padding: '5px 14px', fontSize: '12px', fontWeight: 600, cursor: 'pointer', outline: 'none' }
                              : { backgroundColor: 'transparent', color: '#374151', border: '1px solid #9ca3af', borderRadius: '9999px', padding: '5px 14px', fontSize: '12px', fontWeight: 500, cursor: 'pointer', outline: 'none' }
                            }
                          >
                            {choice.name}
                          </button>
                        );
                      })}
                    </div>
                    {activePreset.options.required && selectedStyleOption === "" && (
                      <p style={{ fontSize: '12px', color: '#d97706', fontWeight: 500, marginTop: '6px' }}>Please choose a style option to continue</p>
                    )}
                  </div>
                );
              })()}

              {/* Style base image preview */}
              {(() => {
                const activePreset = filteredStylePresets.find(p => p.id === selectedPreset);
                let previewUrl: string | undefined;
                if (selectedStyleOption !== "" && activePreset?.options) {
                  const choice = activePreset.options.choices.find((c: any) => c.id === selectedStyleOption);
                  if ((choice as any)?.baseImageUrl) previewUrl = (choice as any).baseImageUrl;
                }
                if (!previewUrl && (activePreset as any)?.baseImageUrl) previewUrl = (activePreset as any).baseImageUrl;
                if (!previewUrl) return null;
                return (
                  <div className="flex items-center gap-2 p-2 rounded-md bg-muted/50 border">
                    <img src={previewUrl} alt="Style reference" className="w-10 h-10 rounded object-cover" />
                    <span className="text-xs text-muted-foreground">Style reference — AI will use this as visual inspiration</span>
                  </div>
                );
              })()}

              {/* Prompt Description */}
              {(() => {
                const _activePresetForLabel = filteredStylePresets.find(p => p.id === selectedPreset);
                const _descOptional = !!_activePresetForLabel?.descriptionOptional;
                return (
              <div className="space-y-2" data-guide-box={guideActiveBox === 3 ? "active" : undefined}>
                <Label htmlFor="prompt" data-testid="label-prompt">
                  Describe your artwork
                  {_descOptional && (
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">(optional)</span>
                  )}
                </Label>
                <Textarea
                  id="prompt"
                  data-testid="input-prompt"
                  placeholder={(() => {
                    const activePreset = filteredStylePresets.find(p => p.id === selectedPreset);
                    if (activePreset?.descriptionOptional) {
                      return activePreset.promptPlaceholder || "Leave blank to let the style speak for itself, or describe what you'd like...";
                    }
                    return activePreset?.promptPlaceholder || "Describe the artwork you want to create... e.g., 'A serene sunset over mountains with golden clouds'";
                  })()}
                  value={prompt}
                  onChange={(e) => {
                    // If the user starts typing while a saved design is loaded, silently
                    // trigger "Start Fresh Design" first so they can't accidentally
                    // add the old saved design to cart with a new prompt.
                    if (generatedDesign && loadDesignAppliedRef.current && effectiveLoadDesignId) {
                      setGeneratedDesign(null);
                      setDesignSource(null);
                      setAddedToCart(false);
                      loadDesignAppliedRef.current = false;
                      setBridgeLoadDesignId('');
                      setPrintifyMockups([]);
                      setPrintifyMockupImages([]);
                      setSelectedMockupIndex(0);
                      try {
                        const stateKey = `aiart:design:${shopDomain || 'local'}:${productHandle || 'unknown'}`;
                        sessionStorage.removeItem(stateKey);
                      } catch (_) {}
                      const url = new URL(window.location.href);
                      url.searchParams.delete('loadDesignId');
                      window.history.replaceState({}, '', url.toString());
                      try {
                        const parentUrl = new URL(window.parent.location.href);
                        parentUrl.searchParams.delete('loadDesignId');
                        window.parent.history.replaceState({}, '', parentUrl.toString());
                      } catch (_) {}
                    }
                    setPrompt(e.target.value);
                  }}
                  className="min-h-[80px]"
                />
              </div>
                );
              })()}

              {/* Product Details — desktop only, shown below prompt textarea in right panel */}
              {(isStorefront || isShopify) && productTypeConfig?.description && (
                <div className="hidden md:block space-y-1.5">
                  <Label>Product Details</Label>
                  <div
                    className="rounded-md border-2 border-foreground bg-background px-3 py-2 text-sm leading-relaxed prose prose-sm max-w-none overflow-y-auto"
                    style={{ maxHeight: '220px', color: 'inherit' }}
                    onWheel={(e) => {
                      const el = e.currentTarget;
                      const atTop = el.scrollTop === 0 && e.deltaY < 0;
                      const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 1 && e.deltaY > 0;
                      if (!atTop && !atBottom) {
                        e.stopPropagation();
                      }
                    }}
                    dangerouslySetInnerHTML={{ __html: productTypeConfig.description }}
                  />
                </div>
              )}




            </div>
          </div>

          {/* Artwork preview panel — left on desktop, second on mobile */}
          <div ref={artworkColumnRef} className="space-y-3 order-2 md:order-1">
            {/* Main interactive canvas - full size, always visible for editing */}
            <div
              className="w-full rounded-md overflow-hidden relative"
              style={{
                aspectRatio: (() => {
                  // Mugs/tumblers: the blank product photo is a tall portrait shot.
                  // The DB aspectRatio for mugs is the wrap-around print area (wide),
                  // but the container should be portrait so the full tumbler is visible.
                  if (productTypeConfig?.designerType === "mug") return "3/4";
                  // For product types with dimensional sizes (width/height > 0), use those
                  if (selectedSizeConfig && selectedSizeConfig.width > 0 && selectedSizeConfig.height > 0) {
                    return `${selectedSizeConfig.width}/${selectedSizeConfig.height}`;
                  }
                  // Otherwise use the product type's aspectRatio string (e.g., "4:3" for mugs/tumblers)
                  const ar = productTypeConfig?.aspectRatio || "3:4";
                  return ar.replace(":", "/");
                })(),
                // Cap height so tall/portrait products (phone cases, body pillows, etc.)
                // don't push the form controls off-screen. The aspect-ratio still governs
                // the natural proportions; maxHeight just prevents extreme cases.
                maxHeight: "520px",
              }}
              data-testid="container-mockup"
            >
              <div className="absolute inset-0">
                {(() => {
                  const isGeneratingArtwork = generateMutation.isPending;
                  // mockupTriggered bridges the gap between isPending=false and mockupLoading=true
                  const isGeneratingMockups = isStorefront && (mockupLoading || mockupTriggered) && !getPreferredMockupUrl();
                  const isAopProduct = !!(productTypeConfig?.isAllOverPrint);
                  // isAopReapplying: AOP product is regenerating mockups after a pattern re-apply.
                  // Unlike the first apply, getPreferredMockupUrl() returns the OLD mockup URL so
                  // isGeneratingMockups is false — but we still need to show the blue shimmer.
                  const isAopReapplying = isStorefront && isAopProduct && (mockupLoading || mockupTriggered) && !!aopPatternUrl;
                  // isLoadingSaved: true while a shared design OR a saved design (loadDesignId) is
                  // being restored and generatedDesign hasn't been set yet — shows skeleton shimmer
                  // instead of the blank product mockup.
                  // IMPORTANT: only show skeleton while the design is still being applied
                  // (loadDesignAppliedRef.current === false). Once applied, even if the user
                  // clicks "Start Fresh Design" (clearing generatedDesign), we must NOT re-show
                  // the skeleton — otherwise it runs infinitely after add-to-cart resets state.
                  const isLoadingSaved = isLoadingSharedDesign || (
                    !!effectiveLoadDesignId &&
                    !generatedDesign?.imageUrl &&
                    !loadDesignAppliedRef.current
                  );
                  const loadingStage: "generating" | "mockups" | "pattern" | null =
                    isGeneratingArtwork ? "generating"
                    : (isGeneratingMockups || isAopReapplying) && isAopProduct ? "pattern"
                    : isGeneratingMockups ? "mockups"
                    : null;

                  // Resolve which mockup URL to show based on gallery selection.
                  // selectedMockupIndex 0 = raw artwork; 1+ = mockup at that index.
                  const galleryMockups: string[] =
                    printifyMockupImages.length > 0
                      ? printifyMockupImages.map(img => img.url)
                      : printifyMockups;
                  const selectedMockupUrl =
                    isStorefront && selectedMockupIndex > 0 && galleryMockups.length >= selectedMockupIndex
                      ? galleryMockups[selectedMockupIndex - 1]
                      : isStorefront && selectedMockupIndex === 0 && galleryMockups.length === 0
                        ? (getPreferredMockupUrl() || null)
                        : null;

                  return (
                    <ProductMockup
                      imageUrl={generatedDesign?.imageUrl}
                      mockupUrl={selectedMockupUrl}
                      isLoading={isGeneratingArtwork || isGeneratingMockups || isAopReapplying || isLoadingSaved}
                      loadingStage={loadingStage}
                      isAop={isAopProduct}
                      selectedSize={selectedSizeConfig}
                      selectedFrameColor={selectedFrameColorConfig}
                      transform={transform}
                      onTransformChange={setTransform}
                      enableDrag={!!generatedDesign?.imageUrl && selectedMockupIndex === 0}
                      designerType={productTypeConfig?.designerType || "generic"}
                      printShape={productTypeConfig?.printShape || "rectangle"}
                      canvasConfig={productTypeConfig?.canvasConfig}
                      blankImageUrl={productTypeConfig?.baseMockupImages?.front || null}
                      aspectRatio={productTypeConfig?.aspectRatio}
                    />
                  );
                })()}
              </div>

              {/* Left/right arrow navigation — only when mockups are available */}
              {isStorefront && generatedDesign?.imageUrl && (() => {
                const galleryMockupCount = printifyMockupImages.length > 0
                  ? printifyMockupImages.slice(0, 3).length
                  : printifyMockups.slice(0, 3).length;
                const totalItems = 1 + galleryMockupCount;
                if (totalItems <= 1) return null;
                return (
                  <>
                    <button
                      type="button"
                      aria-label="Previous"
                      onClick={() => setSelectedMockupIndex(i => (i - 1 + totalItems) % totalItems)}
                      className="absolute left-1 top-1/2 -translate-y-1/2 z-10 flex items-center justify-center w-8 h-8 rounded-full bg-black/30 hover:bg-black/60 text-white animate-pulse hover:[animation:none] transition-colors"
                    >
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                    <button
                      type="button"
                      aria-label="Next"
                      onClick={() => setSelectedMockupIndex(i => (i + 1) % totalItems)}
                      className="absolute right-1 top-1/2 -translate-y-1/2 z-10 flex items-center justify-center w-8 h-8 rounded-full bg-black/30 hover:bg-black/60 text-white animate-pulse hover:[animation:none] transition-colors"
                    >
                      <ChevronRight className="w-5 h-5" />
                    </button>
                  </>
                );
              })()}

              {/* Stale mockups overlay */}
              {mockupsStale && !mockupLoading && generatedDesign?.imageUrl && (
                <div className="absolute inset-0 flex items-end justify-center pb-3 pointer-events-none z-20">
                  <span className="text-white text-sm font-semibold bg-black/60 rounded-full px-3 py-1 animate-pulse">
                    Refresh your Mockups
                  </span>
                </div>
              )}

              {/* AOP Pattern Step — solid overlay on top of the canvas, no bleed-through */}
              {showPatternStep && aopPendingMotifUrl && (
                <div className="absolute inset-0 z-30 bg-background rounded-md overflow-hidden">
                  <PatternCustomizer
                    motifUrl={aopPendingMotifUrl}
                    productWidth={(() => {
                      const positions = productTypeConfig?.placeholderPositions || [];
                      return positions.reduce((max: number, p: { width: number }) => Math.max(max, p.width), 2000);
                    })()}
                    productHeight={(() => {
                      const positions = productTypeConfig?.placeholderPositions || [];
                      return positions.reduce((max: number, p: { height: number }) => Math.max(max, p.height), 2000);
                    })()}
                    hasPairedPanels={(() => {
                      const positions = (productTypeConfig?.placeholderPositions || []).map((p: { position: string }) => p.position);
                      return positions.some((p: string) => p.startsWith("left")) && positions.some((p: string) => p.startsWith("right"));
                    })()}
                    panelPositions={productTypeConfig?.placeholderPositions || []}
                    panelFlatLayImages={productTypeConfig?.printifyBlueprintId === 1050 ? {
                      "left_leg"            : "https://images.printify.com/api/catalog/627268e348bb29a669061ca2.svg",
                      "right_leg"           : "https://images.printify.com/api/catalog/627268d3ae9e71e7850a0ff1.svg",
                    } : productTypeConfig?.panelFlatLayImages || {}}
                    fetchFn={(url, options) => safeFetch(url, options, 60000)}
                    initialTilesAcross={aopPatternSettings.tilesAcross}
                    initialPattern={aopPatternSettings.pattern}
                    initialBgColor={aopPatternSettings.bgColor}
                    onSettingsChange={(s) => setAopPatternSettings(s)}
                    initialPlacement={aopPlacementSettings}
                    onPlacementChange={(p) => setAopPlacementSettings(p)}
                    onApply={async (appliedPatternUrl: string, options) => {
                      setAopPatternUrl(appliedPatternUrl);
                      setShowPatternStep(false);
                      if (productTypeConfig) {
                        fetchPrintifyMockups(
                          aopPendingMotifUrl,
                          productTypeConfig.id,
                          selectedSize,
                          selectedFrameColor || 'default',
                          defaultZoom,
                          50,
                          50,
                          appliedPatternUrl,
                          options.mirrorLegs,
                          options.panelUrls
                        );
                      }
                    }}
                    isLoading={mockupLoading}
                  />
                </div>
              )}
            </div>

            {/* Carousel indicators with labels — directly under image */}
            {(isShopify || isStorefront) && productTypeConfig?.hasPrintifyMockups && generatedDesign?.imageUrl && (() => {
              const galleryMockups: Array<{ url: string; label: string }> =
                printifyMockupImages.length > 0
                  ? printifyMockupImages
                  : printifyMockups.map((url, i) => ({ url, label: i === 0 ? "Front" : i === 1 ? "Back" : `View ${i + 1}` }));
              const hasMockups = galleryMockups.length > 0;
              if (!hasMockups) return null;
              const totalItems = 1 + galleryMockups.slice(0, 3).length;
              const getLabel = (idx: number) => idx === 0 ? "Artwork" : (galleryMockups[idx - 1]?.label || `View ${idx}`);
              return (
                <div className="flex justify-center gap-3 mt-1">
                  {Array.from({ length: totalItems }).map((_, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setSelectedMockupIndex(idx)}
                      aria-label={getLabel(idx)}
                      className={`flex flex-col items-center gap-0.5 transition-all duration-200 ${
                        selectedMockupIndex === idx ? "opacity-100" : "opacity-40 hover:opacity-70"
                      }`}
                    >
                      <span className={`rounded-full transition-all duration-200 ${
                        selectedMockupIndex === idx
                          ? "w-4 h-2 bg-foreground"
                          : "w-2 h-2 bg-foreground/60"
                      }`} />
                      <span className={`text-[10px] leading-tight font-medium ${
                        selectedMockupIndex === idx ? "text-foreground" : "text-muted-foreground"
                      }`}>{getLabel(idx)}</span>
                    </button>
                  ))}
                </div>
              );
            })()}

            {generatedDesign?.imageUrl && !productTypeConfig?.isAllOverPrint && (
              <ZoomControls
                transform={transform}
                onTransformChange={setTransform}
                disabled={!generatedDesign?.imageUrl}
                extraActions={
                  <div className="flex items-center gap-2">
                    {(isShopify || isStorefront) && productTypeConfig?.hasPrintifyMockups && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (generatedDesign?.imageUrl && productTypeConfig && selectedSize) {
                            setMockupError(null);
                            setMockupFailed(false);
                            setPrintifyMockups([]);
                            setPrintifyMockupImages([]);
                            setSelectedMockupIndex(0);
                            setMockupsStale(false);
                            mockupColorCacheRef.current = {};
                            currentMockupColorRef.current = '';
                            fetchPrintifyMockups(
                              toAbsoluteImageUrl(generatedDesign.imageUrl),
                              productTypeConfig.id,
                              selectedSize,
                              selectedFrameColor || 'default',
                              transform.scale,
                              transform.x,
                              transform.y
                            );
                          }
                        }}
                        disabled={mockupLoading || !generatedDesign?.imageUrl}
                        title="Refresh Mockups"
                        data-testid="button-refresh-mockups"
                        className="shrink-0"
                      >
                        {mockupLoading ? (
                          <Loader2 className="w-4 h-4 animate-spin mr-1" />
                        ) : (
                          <RefreshCcw className="w-4 h-4 mr-1" />
                        )}
                        <span className="text-xs">Refresh Mockups</span>
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleShare}
                      disabled={isSharing || !generatedDesign?.imageUrl}
                      data-testid="button-share"
                      className="shrink-0"
                    >
                      {isSharing ? (
                        <Loader2 className="w-4 h-4 animate-spin mr-1" />
                      ) : (
                        <Share2 className="w-4 h-4 mr-1" />
                      )}
                      <span className="text-xs">Share</span>
                    </Button>
                  </div>
                }
              />
            )}

            {/* AOP-only bottom bar: Edit Pattern + Share (no zoom/refresh) */}
            {generatedDesign?.imageUrl && productTypeConfig?.isAllOverPrint && (
              <div className="flex items-center justify-between pt-2 border-t gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowPatternStep(true)}
                  className="shrink-0"
                  data-testid="button-edit-pattern"
                >
                  <RefreshCw className="w-4 h-4 mr-1" />
                  <span className="text-xs">Edit Pattern</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleShare}
                  disabled={isSharing || !generatedDesign?.imageUrl}
                  data-testid="button-share-aop"
                  className="shrink-0"
                >
                  {isSharing ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-1" />
                  ) : (
                    <Share2 className="w-4 h-4 mr-1" />
                  )}
                  <span className="text-xs">Share</span>
                </Button>
              </div>
            )}

            {/* Mockup error status */}
            {(isShopify || isStorefront) && productTypeConfig?.hasPrintifyMockups && generatedDesign?.imageUrl && mockupError && (
              <div className="border-t pt-3" data-testid="container-mockup-status">
                <div className="flex items-center gap-2 py-2 px-3 bg-destructive/10 rounded-md">
                  <span className="text-sm text-destructive flex-1">Preview unavailable — you can still add to cart</span>
                  <button
                    type="button"
                    className="text-xs text-destructive underline shrink-0"
                    onClick={() => {
                      if (generatedDesign?.imageUrl && productTypeConfig && selectedSize) {
                        setMockupError(null);
                        fetchPrintifyMockups(
                          toAbsoluteImageUrl(generatedDesign.imageUrl),
                          productTypeConfig.id,
                          selectedSize,
                          selectedFrameColor || 'default',
                          transform.scale,
                          50,
                          50
                        );
                      }
                    }}
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}

            {generateMutation.isError && generateMutation.error?.message !== 'GALLERY_FULL' && (
              <p className="text-destructive text-sm" data-testid="text-error">
                {generateMutation.error?.message || "Failed to generate design. Please try again."}
              </p>
            )}

            {variantError && (
              <p className="text-destructive text-sm" data-testid="text-variant-error">
                {variantError}
              </p>
            )}

            {isSharedDesign && generatedDesign && (
              <div className="text-sm text-muted-foreground bg-muted/50 rounded-md p-2 text-center">
                Viewing a shared design. Generate your own or add to cart!
              </div>
            )}

            {/* Product Details — shown below gallery on mobile only (desktop version is in the right panel) */}
            {(isStorefront || isShopify) && productTypeConfig?.description && (
              <div className="md:hidden border-t pt-4 mt-2 space-y-2" data-testid="container-product-details">
                <h3 className="text-sm font-semibold">Product Details</h3>
                <div
                  className="text-sm text-muted-foreground leading-relaxed prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: productTypeConfig.description }}
                />
              </div>
            )}
          </div>
        </div>
        </>
        )}
      </div>

      {/* Gallery Full Modal */}
      {showGalleryFullModal && (
      <div
        className="fixed inset-0 z-[9999] flex items-start justify-center p-4 pt-8 sm:items-center sm:pt-4"
        style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
        onClick={() => setShowGalleryFullModal(false)}
      >
        <div
          className="bg-background rounded-xl shadow-2xl max-w-sm w-full p-6 space-y-4"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
              </div>
              <h2 className="text-base font-semibold">Your design gallery is full</h2>
            </div>
            <button
              onClick={() => setShowGalleryFullModal(false)}
              className="text-muted-foreground hover:text-foreground bg-transparent border-none cursor-pointer p-1 flex-shrink-0"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <p className="text-sm text-muted-foreground">
            You've reached your {galleryLimit}-design limit. To generate a new design, open your <strong>Saved Designs</strong> gallery and delete one or more designs you no longer need.
          </p>
          <div className="flex gap-2 pt-1">
            <button
              className="flex-1 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
              onClick={() => { setShowGalleryFullModal(false); setShowSavedDesigns(true); }}
            >
              Open Saved Designs
            </button>
            <button
              className="px-4 py-2 rounded-md border text-sm font-medium hover:bg-muted transition-colors"
              onClick={() => setShowGalleryFullModal(false)}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    )}
    </div>
  );
}
