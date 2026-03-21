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
import { Loader2, Sparkles, ImagePlus, ShoppingCart, RefreshCw, RefreshCcw, X, Save, LogIn, Share2, Upload, ExternalLink, CheckCircle, ChevronLeft, ChevronRight, Info } from "lucide-react";
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
} from "@/components/designer";

interface CustomerInfo {
  id: string;
  credits: number;
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
}

// API_BASE and buildAppUrl imported from @/lib/urlBase

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

    return () => { __embedInstanceActive = false; };
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

  const [prompt, setPrompt] = useState("");
  const [isLoadingSharedDesign, setIsLoadingSharedDesign] = useState(!!sharedDesignId);
  const [sharedDesignError, setSharedDesignError] = useState<string | null>(null);
  const [isSharedDesign, setIsSharedDesign] = useState(false);
  const [selectedSize, setSelectedSize] = useState("");
  const [selectedFrameColor, setSelectedFrameColor] = useState("");
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [selectedStyleOption, setSelectedStyleOption] = useState<string>("");
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);
  const [generatedDesign, setGeneratedDesign] = useState<GeneratedDesign | null>(null);
  const [isAddingToCart, setIsAddingToCart] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const debugBridge = searchParams.get("debugBridge") === "1";
  const [transform, setTransform] = useState<ImageTransform>({ scale: 100, x: 50, y: 50 });
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
  const [customer, setCustomer] = useState<CustomerInfo | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [freeLimitReached, setFreeLimitReached] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [isSharing, setIsSharing] = useState(false);
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
  const [mockupError, setMockupError] = useState<string | null>(null);
  const [mockupFailed, setMockupFailed] = useState(false);
  const [selectedMockupIndex, setSelectedMockupIndex] = useState(0);
  const [mockupsStale, setMockupsStale] = useState(false);

  // AOP (All-Over-Print) pattern step state
  const [showPatternStep, setShowPatternStep] = useState(false);
  const [aopPendingMotifUrl, setAopPendingMotifUrl] = useState<string | null>(null);
  const [aopPatternUrl, setAopPatternUrl] = useState<string | null>(null);

  // Per-color mockup cache: instantly swap mockups when the user picks a different frame color
  const mockupColorCacheRef = useRef<Record<string, { urls: string[]; images: { url: string; label: string }[] }>>({});
  const currentMockupColorRef = useRef<string>('');
  
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

  // Restore design state from sessionStorage on load (survives page refresh / back navigation)
  useEffect(() => {
    // Don't restore if we already have a design (e.g., from shared link) or are loading one
    if (generatedDesign || sharedDesignId || isLoadingSharedDesign) return;
    try {
      const stateKey = `aiart:design:${shopDomain || 'local'}:${productHandle || 'unknown'}`;
      const saved = sessionStorage.getItem(stateKey);
      if (!saved) return;
      const state = JSON.parse(saved);
      // Only restore if saved within the last 30 minutes
      if (state.savedAt && Date.now() - state.savedAt < 30 * 60 * 1000 && state.imageUrl) {
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

  const fetchPrintifyMockups = useCallback(async (
    designImageUrl: string,
    ptId: number,
    sizeId: string,
    colorId: string,
    scale: number = 100,
    x: number = 50,
    y: number = 50,
    patternUrl?: string,
    mirrorLegs?: boolean
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
      });
      
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
        setSelectedMockupIndex(0);
        sendMockupsToParent(absUrls);
        currentMockupColorRef.current = colorId;
        mockupColorCacheRef.current[colorId] = { urls: absUrls, images: absImages };
        console.log('[Mockups] Stored', absUrls.length, 'mockup URLs for color', colorId);
      } else if (!result.success) {
        throw new Error(result.message || "Mockup generation returned unsuccessful");
      }
    } catch (error) {
      console.error("Failed to generate Printify mockups:", error);
      setMockupError(error instanceof Error ? error.message : "Failed to generate product preview");
      setMockupFailed(true);
    } finally {
      setMockupLoading(false);
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
      setSelectedMockupIndex(0);
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
    const properties: Record<string, string> = {
      '_design_id': String(generatedDesign.id || ''),
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
      size: string;
      frameColor: string;
      stylePreset?: string;
      referenceImage?: string;
      baseImageUrl?: string;
      shop?: string;
      sessionToken?: string;
      productTypeId?: string;
      sessionId?: string;
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
              return { ...status, imageUrl: abs(status.imageUrl), thumbnailUrl: abs(status.thumbnailUrl) };
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
        }
        throw new Error(data.error || "Failed to generate design");
      }
      return data;
    },
    onSuccess: (data) => {
      const imageUrl = data.imageUrl || data.design?.generatedImageUrl;
      const designId = data.designId || data.design?.id || crypto.randomUUID();
      setAddedToCart(false);
      setGeneratedDesign({
        id: designId,
        imageUrl: imageUrl,
        prompt: prompt,
      });
      if (data.creditsRemaining !== undefined && customer) {
        setCustomer({ ...customer, credits: data.creditsRemaining });
      }
      // Use conditional default zoom (135% for apparel, 100% for others)
      const zoomDefault = productTypeConfig?.designerType === "apparel" ? 135 : 100;
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
    const file = e.target.files?.[0];
    if (file) {
      setReferenceImage(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setReferencePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const clearReferenceImage = () => {
    setReferenceImage(null);
    setReferencePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    
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

    let referenceImageBase64: string | undefined;
    if (referenceImage) {
      referenceImageBase64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(referenceImage);
      });
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

    generateMutation.mutate({
      prompt: fullPrompt,
      size: selectedSize,
      frameColor: selectedFrameColor || "black",
      stylePreset: selectedPreset && selectedPreset !== "" ? selectedPreset : undefined,
      referenceImage: referenceImageBase64,
      baseImageUrl: resolvedBaseImageUrl || undefined,
      shop: (isShopify || isStorefront) ? shopDomain : undefined,
      sessionToken: (isShopify && !isStorefront) ? sessionToken || undefined : undefined,
      productTypeId: productTypeConfig?.id ? String(productTypeConfig.id) : productTypeId,
      sessionId: isStorefront ? anonSessionId : undefined,
    });
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
      
      // Use conditional default zoom (135% for apparel, 100% for others)
      const zoomDefault = productTypeConfig?.designerType === "apparel" ? 135 : 100;
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
        const options = [v.option1, v.option2, v.option3].filter(Boolean);

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
    const properties: Record<string, string> = {
      '_design_id': generatedDesign.id,
      'Artwork': 'Custom AI Design',
    };
    if (artworkFullUrl) properties['_artwork_url'] = artworkFullUrl;
    if (mockupFullUrl) properties['_mockup_url'] = mockupFullUrl;
    if (selectedSize) properties['Size'] = selectedSize;
    if (selectedFrameColor) properties['Color'] = selectedFrameColor;

    // Update variant image for checkout display — await so Shopify has the correct
    // image before /cart/add.js fires and the cart drawer renders.
    if (mockupFullUrl && mockupFullUrl.startsWith('https://') && productId && shopDomain) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const imgRes = await safeFetch(`${API_BASE}/api/storefront/variant-image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shop: shopDomain,
            productId,
            variantId: normalizedVariant,
            mockupUrl: mockupFullUrl,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!imgRes.ok) {
          console.warn('[Design Studio] Variant image update failed:', imgRes.status);
        } else {
          console.log('[Design Studio] Variant image updated successfully before cart add.');
        }
      } catch (e: any) {
        console.warn('[Design Studio] Variant image update failed/timed out:', e?.message || e);
      }
    }

    // Storefront mode: use postMessage to parent (AJAX cart, no navigation)
    if (isStorefront) {
      try {
        const result = await addToCartStorefront({
          variantId: normalizedVariant,
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
          items: [{ id: Number(normalizedVariant), quantity: 1, properties }],
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
      cartParams.set('id', normalizedVariant);
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
        // Send ACK so parent stops the heartbeat
        window.parent.postMessage({
          type: 'AI_ART_STUDIO_BRIDGE_ACK',
          _bridgeVersion: '1.0.0',
        }, '*');
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
    const sendHeight = () => {
      const h = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
        document.documentElement.offsetHeight
      );
      window.parent.postMessage({ type: 'ai-art-studio:resize', height: h }, '*');
    };
    const observer = new ResizeObserver(sendHeight);
    observer.observe(document.body);
    sendHeight(); // send immediately on mount
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

  // Only wait for config to load - session can load in background
  // Session is only needed for generating, not for viewing the UI
  if (configLoading) {
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

  const isLoggedIn = customer?.isLoggedIn ?? false;
  const credits = customer?.credits ?? 0;

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
      <div className="max-w-6xl mx-auto space-y-4">
        {/* Login / credits info — only shown in standalone (non-Shopify, non-storefront) mode */}
        {!isShopify && !isStorefront && (
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold" data-testid="text-title">
              Create Your Design
            </h2>
            {isLoggedIn ? (
              <span className="text-sm text-muted-foreground" data-testid="text-credits">
                {credits} credits
              </span>
            ) : (
              <span className="text-sm text-muted-foreground flex items-center gap-1" data-testid="text-login-prompt">
                <LogIn className="w-4 h-4" />
                Log in to create
              </span>
            )}
          </div>
        )}

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

        {/* Only show login errors for standalone (non-Shopify, non-storefront) mode */}
        {!isShopify && !isStorefront && loginError && (
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Generator/form panel — right on desktop, first on mobile */}
          <div className="space-y-4 order-1 md:order-2">
            {/* Product title + price */}
            {(isStorefront || isShopify) && (
              <div className="space-y-1">
                <h1 className="text-xl font-bold leading-tight" data-testid="text-product-title">
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
              {/* Row 1: Generate + Upload side-by-side */}
              <div className="flex flex-col sm:flex-row gap-2">
                {/* Generate button — left, wider */}
                <div className="flex-[3] min-w-0">
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
                    disabled={!prompt.trim() || generateMutation.isPending || freeLimitReached || (!isShopify && !isStorefront && (!isLoggedIn || credits <= 0))}
                    className="w-full h-11 text-base font-medium"
                    data-testid="button-generate"
                  >
                    {generateMutation.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4 mr-2" />
                        {isShopify ? "Generate Design" : "Generate Design"}
                      </>
                    )}
                  </Button>
                  {(isShopify || isStorefront) && (
                    <p className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-1">
                      10 Free artworks
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
                  )}
                </div>

                {/* Upload reference image — right, narrower */}
                <div className="flex-[2] min-w-0">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
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
                    data-testid="button-upload-reference"
                  >
                    <ImagePlus className="w-4 h-4 mr-2 shrink-0" />
                    {isImporting ? "Importing..." : "Upload"}
                  </Button>
                  <p className="text-xs text-muted-foreground mt-1 text-center">
                    Reference Image (optional)
                  </p>
                  {referencePreview && (
                    <div className="flex items-center gap-2 mt-1">
                      <div className="relative shrink-0">
                        <img
                          src={referencePreview}
                          alt="Reference"
                          className="w-8 h-8 object-cover rounded"
                          data-testid="img-reference-preview"
                        />
                        <Button
                          type="button"
                          variant="destructive"
                          size="icon"
                          className="absolute -top-1.5 -right-1.5 w-4 h-4"
                          onClick={clearReferenceImage}
                          data-testid="button-clear-reference"
                        >
                          <X className="w-2.5 h-2.5" />
                        </Button>
                      </div>
                      <span className="text-xs text-muted-foreground truncate">Image selected</span>
                    </div>
                  )}
                  {importError && (
                    <p className="text-destructive text-xs mt-1" data-testid="text-import-error">
                      {importError}
                    </p>
                  )}
                </div>
              </div>

              {/* Style Selection */}
              {showPresetsParam && filteredStylePresets.length > 0 && (
                <div className="space-y-2">
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

              {/* Style Sub-Options */}
              {showPresetsParam && selectedPreset !== "" && (() => {
                const activePreset = filteredStylePresets.find(p => p.id === selectedPreset);
                if (!activePreset?.options) return null;
                const { label, choices } = activePreset.options;
                return (
                  <div className="space-y-2">
                    <Label>{label}</Label>
                    <div className="flex flex-wrap gap-2">
                      {choices.map((choice) => (
                        <button
                          key={choice.id}
                          type="button"
                          onClick={() => setSelectedStyleOption(choice.id)}
                          className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                            selectedStyleOption === choice.id
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-background text-foreground border-border hover:border-primary/60"
                          }`}
                        >
                          {choice.name}
                        </button>
                      ))}
                    </div>
                    {activePreset.options.required && selectedStyleOption === "" && (
                      <p className="text-xs text-muted-foreground">Please choose a layout to continue</p>
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
              <div className="space-y-2">
                <Label htmlFor="prompt" data-testid="label-prompt">
                  Describe your artwork
                </Label>
                <Textarea
                  id="prompt"
                  data-testid="input-prompt"
                  placeholder={(() => {
                    const activePreset = filteredStylePresets.find(p => p.id === selectedPreset);
                    return activePreset?.promptPlaceholder || "Describe the artwork you want to create... e.g., 'A serene sunset over mountains with golden clouds'";
                  })()}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  className="min-h-[80px]"
                />
              </div>

              {/* Size + Frame Color on same row */}
              {(printSizes.length > 0 || frameColorObjects.length > 0) && (
                <div className={`grid gap-3 ${printSizes.length > 0 && frameColorObjects.length > 0 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
                  {printSizes.length > 0 && (
                    <div>
                      <SizeSelector
                        sizes={printSizes}
                        selectedSize={selectedSize}
                        onSizeChange={(sizeId) => {
                          setSelectedSize(sizeId);
                          setTransform({ scale: defaultZoom, x: 50, y: 50 });
                        }}
                      />
                      {selectedSize === "" && (
                        <p className="text-xs text-muted-foreground mt-1">Please select a size</p>
                      )}
                    </div>
                  )}
                  {frameColorObjects.length > 0 && (
                    <FrameColorSelector
                      frameColors={frameColorObjects}
                      selectedFrameColor={selectedFrameColor}
                      onFrameColorChange={setSelectedFrameColor}
                      colorLabel={productTypeConfig?.colorLabel || "Color"}
                    />
                  )}
                </div>
              )}

              {/* AOP Pattern Step — shown after generation for all-over-print products */}
              {showPatternStep && aopPendingMotifUrl && (
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
                        options.mirrorLegs
                      );
                    }
                  }}
                  isLoading={mockupLoading}
                />
              )}

              {/* Add to Cart — moved above fold in the form panel (right column on desktop) */}
              {(isShopify || isStorefront) && generatedDesign && (
                <div className="flex flex-col gap-2">
                  {addedToCart ? (
                    <>
                      <Button
                        className="w-full h-12 text-base font-medium bg-green-600 hover:bg-green-700 text-white"
                        onClick={() => { window.parent.location.href = '/cart'; }}
                        data-testid="button-view-cart"
                      >
                        <CheckCircle className="w-5 h-5 mr-2" />
                        Added to Cart — View Cart
                      </Button>
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => { setAddedToCart(false); setGeneratedDesign(null); setPrompt(""); }}
                      >
                        Create Another Design
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        onClick={handleAddToCart}
                        disabled={isAddingToCart || atcWaitingForMockups || mockupsStale}
                        className="w-full h-11 text-base font-medium"
                        data-testid="button-add-to-cart"
                      >
                        {isAddingToCart ? (
                          <>
                            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                            Adding to Cart...
                          </>
                        ) : atcWaitingForMockups ? (
                          <>
                            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                            Generating preview…
                          </>
                        ) : mockupsStale ? (
                          <>
                            <ShoppingCart className="w-5 h-5 mr-2" />
                            Refresh Mockups to Continue
                          </>
                        ) : isStorefront && bridgeError ? (
                          <>
                            <ShoppingCart className="w-5 h-5 mr-2" />
                            Add to Cart (unavailable)
                          </>
                        ) : (
                          <>
                            <ShoppingCart className="w-5 h-5 mr-2" />
                            Add to Cart
                          </>
                        )}
                      </Button>
                      {isStorefront && bridgeError && (
                        <p className="text-destructive text-xs text-center" data-testid="text-bridge-error">
                          {bridgeError}
                        </p>
                      )}
                    </>
                  )}
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
                  // For product types with dimensional sizes (width/height > 0), use those
                  if (selectedSizeConfig && selectedSizeConfig.width > 0 && selectedSizeConfig.height > 0) {
                    return `${selectedSizeConfig.width}/${selectedSizeConfig.height}`;
                  }
                  // Otherwise use the product type's aspectRatio string (e.g., "4:3" for mugs/tumblers)
                  const ar = productTypeConfig?.aspectRatio || "3:4";
                  return ar.replace(":", "/");
                })(),
              }}
              data-testid="container-mockup"
            >
              <div className="absolute inset-0">
                {(() => {
                  const isGeneratingArtwork = generateMutation.isPending;
                  const isGeneratingMockups = isStorefront && mockupLoading && !getPreferredMockupUrl();
                  const loadingStage: "generating" | "mockups" | null =
                    isGeneratingArtwork ? "generating" : isGeneratingMockups ? "mockups" : null;

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
                      isLoading={isGeneratingArtwork || isGeneratingMockups}
                      loadingStage={loadingStage}
                      selectedSize={selectedSizeConfig}
                      selectedFrameColor={selectedFrameColorConfig}
                      transform={transform}
                      onTransformChange={setTransform}
                      enableDrag={!!generatedDesign?.imageUrl && selectedMockupIndex === 0}
                      designerType={productTypeConfig?.designerType || "generic"}
                      printShape={productTypeConfig?.printShape || "rectangle"}
                      canvasConfig={productTypeConfig?.canvasConfig}
                      blankImageUrl={productTypeConfig?.baseMockupImages?.front || null}
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

            {generatedDesign?.imageUrl && (
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

            {generateMutation.isError && (
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

            {/* Product Details — shown below gallery when in storefront/shopify mode */}
            {(isStorefront || isShopify) && productTypeConfig?.description && (
              <div className="border-t pt-4 mt-2 space-y-2" data-testid="container-product-details">
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
    </div>
  );
}
