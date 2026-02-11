import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Sparkles, ImagePlus, ShoppingCart, RefreshCw, X, Save, LogIn, Share2, Upload, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  ProductMockup,
  ZoomControls,
  FrameColorSelector,
  SizeSelector,
  StyleSelector,
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
}

/**
 * Get the API base URL for the embed.
 * Priority:
 * 1. window.__APPAI_API_BASE__ (global override)
 * 2. data-appai-api-base attribute on script
 * 3. window.location.origin (iframe origin = Railway)
 * 4. Fallback to production Railway URL
 */
function getApiBase(): string {
  // Check global override
  if (typeof window !== 'undefined' && (window as any).__APPAI_API_BASE__) {
    return (window as any).__APPAI_API_BASE__;
  }

  // Check data attribute
  if (typeof document !== 'undefined') {
    const script = document.querySelector('script[data-appai-api-base]');
    if (script) {
      const base = script.getAttribute('data-appai-api-base');
      if (base) return base;
    }
  }

  // Use current origin (for iframe loaded from Railway)
  if (typeof window !== 'undefined' && window.location.origin) {
    // Only use origin if it looks like our Railway app
    const origin = window.location.origin;
    if (origin.includes('railway.app') || origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return origin;
    }
  }

  // Fallback to production Railway URL
  return 'https://appai-pod-production.up.railway.app';
}

// Get API base once at module load
const API_BASE = getApiBase();
console.log('[EmbedDesign] API Base URL:', API_BASE);
console.log('[EmbedDesign] window.location.origin:', typeof window !== 'undefined' ? window.location.origin : 'undefined');
console.log('[EmbedDesign] window.location.href:', typeof window !== 'undefined' ? window.location.href : 'undefined');

// DIAGNOSTIC: Quick sanity check on module load
if (typeof window !== 'undefined') {
  console.log('[EmbedDesign] === QUICK DIAGNOSTIC ===');
  const pingUrl = `${API_BASE}/api/storefront/ping`;
  const start = Date.now();
  fetch(pingUrl)
    .then(r => r.json())
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
  const isStorefront = params.get("storefront") === "true";
  const isEmbedded = params.get("embedded") === "true";
  const isShopify = params.get("shopify") === "true";

  // Storefront mode: explicitly set via storefront=true
  // This mode does NOT use session tokens - all APIs are public
  if (isStorefront) {
    return 'storefront';
  }

  // Admin embedded mode: embedded=true with shopify=true
  // This mode requires App Bridge and session tokens
  if (isEmbedded && isShopify) {
    return 'admin-embedded';
  }

  // Standalone mode: direct access without Shopify context
  return 'standalone';
}

export default function EmbedDesign() {
  const searchParams = new URLSearchParams(window.location.search);

  // Detect runtime mode
  const runtimeMode = detectRuntimeMode(searchParams);

  // Legacy params - kept for backwards compatibility
  const isEmbedded = searchParams.get("embedded") === "true";
  const isShopify = searchParams.get("shopify") === "true";
  const isStorefront = runtimeMode === 'storefront';

  // Key behavioral flags based on runtime mode
  const requiresSessionToken = runtimeMode === 'admin-embedded';
  const usesPublicStorefrontApi = runtimeMode === 'storefront';

  const productTypeId = searchParams.get("productTypeId") || "1";
  const productId = searchParams.get("productId") || "";

  // Log all URL parameters for debugging
  console.log('[EmbedDesign] === INITIALIZATION ===');
  console.log('[EmbedDesign] Full URL:', window.location.href);
  console.log('[EmbedDesign] Runtime mode:', runtimeMode);
  console.log('[EmbedDesign] productTypeId from URL:', searchParams.get("productTypeId"), '(using:', productTypeId, ')');
  console.log('[EmbedDesign] shop from URL:', searchParams.get("shop"));
  console.log('[EmbedDesign] isStorefront:', isStorefront, 'requiresSessionToken:', requiresSessionToken);
  
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
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);
  const [generatedDesign, setGeneratedDesign] = useState<GeneratedDesign | null>(null);
  const [isAddingToCart, setIsAddingToCart] = useState(false);
  const [transform, setTransform] = useState<ImageTransform>({ scale: 100, x: 50, y: 50 });
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Track the initial transform to detect changes for auto-save
  const initialTransformRef = useRef<ImageTransform | null>(null);

  const [stylePresets, setStylePresets] = useState<StylePreset[]>([]);
  const [productTypeConfig, setProductTypeConfig] = useState<ProductTypeConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [productTypeError, setProductTypeError] = useState<string | null>(null);

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
  const [selectedMockupIndex, setSelectedMockupIndex] = useState(0);
  const mockupRegenerationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
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
     * Robust fetch with timeout.
     * - Each call creates its own AbortController (linked to master)
     * - Timeout ALSO aborts the fetch (doesn't leave it hanging)
     * - Uses completed flag to prevent race conditions
     * - Properly cleans up all resources
     */
    const fetchWithTimeout = async (url: string, timeout = 30000): Promise<Response> => {
      const fullUrl = url.startsWith('http') ? url : `${API_BASE}${url}`;
      const reqId = Math.random().toString(36).substring(2, 6);
      const startTime = Date.now();
      const logPrefix = `[EmbedDesign] [${sessionId}/${reqId}]`;

      // Each request gets its own AbortController
      const requestAbort = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let completed = false;

      // Check if already cancelled before starting
      if (masterAbort.signal.aborted || isCancelled) {
        console.log(`${logPrefix} Skipping - already cancelled`);
        throw new DOMException('Request aborted', 'AbortError');
      }

      // Link request abort to master - if master aborts, abort this request too
      const onMasterAbort = () => {
        if (!completed) {
          console.log(`${logPrefix} Master abort received`);
          requestAbort.abort();
        }
      };
      masterAbort.signal.addEventListener('abort', onMasterAbort);

      // Log FULL URL including query params - critical for debugging
      console.log(`${logPrefix} START FULL URL: ${fullUrl}`);

      try {
        const response = await new Promise<Response>((resolve, reject) => {
          // Set up timeout - IMPORTANT: also aborts the fetch when it fires
          timeoutId = setTimeout(() => {
            if (!completed) {
              completed = true;
              console.error(`${logPrefix} TIMEOUT after ${timeout}ms - aborting fetch`);
              requestAbort.abort(); // Abort the fetch so it doesn't keep running
              reject(new Error(`Request timed out after ${timeout}ms`));
            }
          }, timeout);

          // Start the actual fetch
          fetch(fullUrl, { signal: requestAbort.signal })
            .then(res => {
              if (!completed) {
                completed = true;
                const elapsed = Date.now() - startTime;
                console.log(`${logPrefix} OK ${res.status} in ${elapsed}ms`);
                if (timeoutId) clearTimeout(timeoutId);
                resolve(res);
              }
            })
            .catch(err => {
              if (!completed) {
                completed = true;
                if (timeoutId) clearTimeout(timeoutId);
                reject(err);
              }
            });
        });

        return response;
      } finally {
        completed = true;
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
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
      const cacheBuster = `_t=${Date.now()}`;
      const myshopifyDomain = getMyShopifyDomain();
      console.log('[EmbedDesign] Loading config - productTypeId:', productTypeId, 'productHandle:', productHandle, 'shop:', myshopifyDomain);

      // Step 1: Resolve productTypeId if it's the default "1" and we have a product handle
      let resolvedProductTypeId = productTypeId;
      let resolveSource = "url_param";

      if ((productTypeId === "1" || !searchParams.get("productTypeId")) && productHandle && myshopifyDomain) {
        console.log('[EmbedDesign] ProductTypeId is default, attempting to resolve from handle:', productHandle);
        try {
          const resolveRes = await fetchWithRetry(
            `/api/storefront/resolve-product-type?shop=${encodeURIComponent(myshopifyDomain)}&handle=${encodeURIComponent(productHandle)}&${cacheBuster}`
          );
          if (resolveRes.ok) {
            const resolved = await resolveRes.json();
            resolvedProductTypeId = String(resolved.productTypeId);
            resolveSource = resolved.reason || "resolver";
            console.log('[EmbedDesign] Resolved productTypeId:', resolvedProductTypeId, 'via:', resolveSource);
          } else {
            const errorData = await resolveRes.json().catch(() => ({}));
            console.warn('[EmbedDesign] Resolver returned error:', errorData);
            // If resolver fails with 404, we'll show a specific error
            if (resolveRes.status === 404 && errorData.availableProductTypes) {
              setProductTypeError(
                `No product type found for "${productHandle}". ` +
                `Available product types: ${errorData.availableProductTypes.map((pt: any) => `${pt.name} (ID: ${pt.id})`).join(', ')}. ` +
                `Please set the correct productTypeId in the product metafield.`
              );
              setConfigLoading(false);
              return;
            }
          }
        } catch (err) {
          console.warn('[EmbedDesign] Resolver failed:', err);
          // Continue with original productTypeId
        }
      }

      // Step 2: Fetch config and designer data
      try {
        if (isCancelled) return;

        const designerUrl = `/api/storefront/product-types/${resolvedProductTypeId}/designer?shop=${encodeURIComponent(myshopifyDomain || '')}&${cacheBuster}`;
        console.log('[EmbedDesign] Designer fetch URL:', `${API_BASE}${designerUrl}`);

        const [configRes, designerRes] = await Promise.all([
          fetchWithTimeout(`/api/config?${cacheBuster}`).then(res => res.json()).catch(() => ({ stylePresets: [] })),
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

  // Load shared design if sharedDesignId is present in URL
  useEffect(() => {
    if (!sharedDesignId) {
      setIsLoadingSharedDesign(false);
      return;
    }

    fetch(`${API_BASE}/api/shared-designs/${sharedDesignId}`)
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

      fetch(`${API_BASE}/api/shopify/session`, {
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
      // Use "*" for targetOrigin to support Shopify preview environments
      // Origin validation is done on the receiving end in ai-art-embed.liquid
      window.parent.postMessage({
        type: "AI_ART_STUDIO_MOCKUPS",
        mockupUrls,
        productId,
        productHandle,
      }, "*");
      console.log("[EmbedDesign] Sent mockups to parent:", mockupUrls.length);
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
    y: number = 50
  ) => {
    setMockupLoading(true);
    // Clamp values to valid ranges
    const clampedX = Math.max(0, Math.min(100, x));
    const clampedY = Math.max(0, Math.min(100, y));
    const clampedScale = Math.max(10, Math.min(200, scale));
    
    try {
      // Use Shopify-specific endpoint if in Shopify mode
      const endpoint = isShopify ? `${API_BASE}/api/shopify/mockup` : `${API_BASE}/api/mockup/generate`;
      const payload = isShopify ? {
        productTypeId: ptId,
        designImageUrl,
        sizeId,
        colorId,
        scale: clampedScale,
        x: clampedX,
        y: clampedY,
        shop: shopDomain,
        sessionToken,
      } : {
        productTypeId: ptId,
        designImageUrl,
        sizeId,
        colorId,
        scale: clampedScale,
        x: clampedX,
        y: clampedY,
      };

      setMockupError(null);
      console.log('[EmbedDesign] Fetching mockup from:', endpoint);
      const response = await fetch(endpoint, {
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
        setPrintifyMockups(result.mockupUrls);
        setSelectedMockupIndex(0);
        // Send mockups to parent Shopify page
        sendMockupsToParent(result.mockupUrls);
      } else if (!result.success) {
        throw new Error(result.message || "Mockup generation returned unsuccessful");
      }
      if (result.success && result.mockupImages?.length > 0) {
        setPrintifyMockupImages(result.mockupImages);
        setSelectedMockupIndex(0);
      }
    } catch (error) {
      console.error("Failed to generate Printify mockups:", error);
      setMockupError(error instanceof Error ? error.message : "Failed to generate product preview");
    } finally {
      setMockupLoading(false);
    }
  }, [isShopify, shopDomain, sessionToken, sendMockupsToParent]);

  // Fetch Printify mockups for shared designs once product config is loaded
  useEffect(() => {
    if (
      isSharedDesign &&
      generatedDesign?.imageUrl &&
      productTypeConfig?.hasPrintifyMockups &&
      selectedSize &&
      printifyMockups.length === 0 &&
      !mockupLoading
    ) {
      const fullImageUrl = generatedDesign.imageUrl.startsWith("http") 
        ? generatedDesign.imageUrl 
        : API_BASE + generatedDesign.imageUrl;
      fetchPrintifyMockups(
        fullImageUrl, 
        productTypeConfig.id, 
        selectedSize, 
        selectedFrameColor || 'default', 
        transform.scale, 
        transform.x, 
        transform.y
      );
    }
  }, [isSharedDesign, generatedDesign?.imageUrl, productTypeConfig, selectedSize, selectedFrameColor, printifyMockups.length, mockupLoading, transform, fetchPrintifyMockups]);

  // Debounced regeneration of Printify mockups when transform changes
  useEffect(() => {
    // Only regenerate if we already have mockups and user is adjusting placement
    if (
      !productTypeConfig?.hasPrintifyMockups ||
      !generatedDesign?.imageUrl ||
      !selectedSize ||
      printifyMockups.length === 0
    ) {
      return;
    }

    // Clear any existing timeout
    if (mockupRegenerationTimeoutRef.current) {
      clearTimeout(mockupRegenerationTimeoutRef.current);
    }

    // Debounce the regeneration by 1 second after user stops adjusting
    mockupRegenerationTimeoutRef.current = setTimeout(() => {
      const fullImageUrl = generatedDesign.imageUrl.startsWith("http") 
        ? generatedDesign.imageUrl 
        : API_BASE + generatedDesign.imageUrl;
      fetchPrintifyMockups(
        fullImageUrl, 
        productTypeConfig.id, 
        selectedSize, 
        selectedFrameColor || 'default', 
        transform.scale, 
        transform.x, 
        transform.y
      );
    }, 1000);

    // Cleanup timeout on unmount or when deps change
    return () => {
      if (mockupRegenerationTimeoutRef.current) {
        clearTimeout(mockupRegenerationTimeoutRef.current);
      }
    };
  }, [transform.scale, transform.x, transform.y, productTypeConfig, generatedDesign?.imageUrl, selectedSize, selectedFrameColor, printifyMockups.length, fetchPrintifyMockups]);

  const generateMutation = useMutation({
    mutationFn: async (payload: {
      prompt: string;
      size: string;
      frameColor: string;
      stylePreset?: string;
      referenceImage?: string;
      shop?: string;
      sessionToken?: string;
      productTypeId?: string;
    }) => {
      const endpoint = isShopify ? `${API_BASE}/api/shopify/generate` : `${API_BASE}/api/generate`;
      console.log('[EmbedDesign] Generating design via:', endpoint);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
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
      setGeneratedDesign({
        id: data.designId || data.design?.id || crypto.randomUUID(),
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
      
      // Clear any existing mockups and fetch new Printify composite mockups
      setPrintifyMockups([]);
      setPrintifyMockupImages([]);
      if (productTypeConfig?.hasPrintifyMockups && imageUrl && selectedSize) {
        const fullImageUrl = imageUrl.startsWith("http") ? imageUrl : API_BASE + imageUrl;
        fetchPrintifyMockups(fullImageUrl, productTypeConfig.id, selectedSize, selectedFrameColor || 'default', zoomDefault, 50, 50);
      }
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

    let fullPrompt = prompt;
    if (selectedPreset && selectedPreset !== "") {
      const preset = filteredStylePresets.find((p) => p.id === selectedPreset);
      if (preset?.promptSuffix) {
        fullPrompt = `${prompt}. ${preset.promptSuffix}`;
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

    generateMutation.mutate({
      prompt: fullPrompt,
      size: selectedSize,
      frameColor: selectedFrameColor || "black",
      stylePreset: selectedPreset && selectedPreset !== "" ? selectedPreset : undefined,
      referenceImage: referenceImageBase64,
      shop: isShopify ? shopDomain : undefined,
      sessionToken: isShopify ? sessionToken || undefined : undefined,
      productTypeId: productTypeId,
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
      const uploadUrlResponse = await fetch(`${API_BASE}/api/uploads/request-url`, {
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
      const uploadResponse = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!uploadResponse.ok) {
        throw new Error("Failed to upload file");
      }

      // Step 3: Validate and get image metadata
      const importResponse = await fetch(`${API_BASE}/api/designs/import`, {
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
      
      // Clear any existing mockups and fetch Printify composite mockups for imported design
      setPrintifyMockups([]);
      setPrintifyMockupImages([]);
      if (productTypeConfig?.hasPrintifyMockups && importedImageUrl && selectedSize) {
        const fullImageUrl = importedImageUrl.startsWith("http") ? importedImageUrl : API_BASE + importedImageUrl;
        fetchPrintifyMockups(fullImageUrl, productTypeConfig.id, selectedSize, selectedFrameColor || 'default', zoomDefault, 50, 50);
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

  const [variants, setVariants] = useState<any[]>([]);
  const [variantError, setVariantError] = useState<string | null>(null);
  const [variantsFetched, setVariantsFetched] = useState(false);

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
    if (variantsFetched || !isShopify) return;
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
    fetch(fetchUrl)
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
  }, [isShopify, productHandle, productTypeId, selectedVariantParam, variantsFetched]);

  const findVariantId = (): string | null => {
    if (!isShopify) return null;

    console.log('[Design Studio] Finding variant. selectedVariantParam:', selectedVariantParam, 
                'variants:', variants.length, 'selectedSize:', selectedSize, 
                'selectedFrameColor:', selectedFrameColor, 'hasColors:', frameColorObjects.length > 0);

    // First priority: use selectedVariantParam if provided (most reliable from theme)
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

  const handleAddToCart = () => {
    if (!generatedDesign || !isShopify) return;

    const variantId = findVariantId();

    if (!variantId) {
      // Show context-aware error message
      const hasColors = frameColorObjects.length > 0;
      const errorMsg = hasColors
        ? "Unable to find matching product variant. Please select a valid size and color combination."
        : "Unable to find matching product variant. Please select a valid size.";
      setVariantError(errorMsg);
      return;
    }

    // Validate shop domain is available
    if (!shopDomain) {
      setVariantError("Unable to add to cart: Shop information is missing. Please refresh the page.");
      return;
    }

    setVariantError(null);
    setIsAddingToCart(true);

    // Build the full artwork URL (needs to be absolute and publicly accessible for Printify)
    // The /objects/ URLs are served publicly from object storage
    let artworkFullUrl = generatedDesign.imageUrl;
    if (!artworkFullUrl.startsWith('http')) {
      // Use API_BASE for public access to object storage
      artworkFullUrl = `${API_BASE}${generatedDesign.imageUrl}`;
    }

    // Get the rendered mockup URL if available (for cart display)
    // Try printifyMockups first, then fall back to printifyMockupImages
    let mockupFullUrl = '';
    if (printifyMockups.length > 0) {
      const mockupUrl = printifyMockups[selectedMockupIndex] || printifyMockups[0];
      mockupFullUrl = mockupUrl.startsWith('http')
        ? mockupUrl
        : `${API_BASE}${mockupUrl}`;
    } else if (printifyMockupImages.length > 0) {
      const mockupUrl = printifyMockupImages[selectedMockupIndex]?.url || printifyMockupImages[0]?.url;
      if (mockupUrl) {
        mockupFullUrl = mockupUrl.startsWith('http')
          ? mockupUrl
          : `${API_BASE}${mockupUrl}`;
      }
    }

    // Build Shopify cart URL with line item properties
    // Properties will be attached to the order for Printify fulfillment
    const cartParams = new URLSearchParams();
    cartParams.set('id', String(variantId));
    cartParams.set('quantity', '1');
    cartParams.set('properties[_artwork_url]', artworkFullUrl);
    cartParams.set('properties[_design_id]', generatedDesign.id);
    cartParams.set('properties[Artwork]', 'Custom AI Design');
    if (mockupFullUrl) {
      cartParams.set('properties[_mockup_url]', mockupFullUrl);
    }
    if (selectedSize) {
      cartParams.set('properties[Size]', selectedSize);
    }
    if (selectedFrameColor) {
      cartParams.set('properties[Color]', selectedFrameColor);
    }

    const cartUrl = `https://${shopDomain}/cart/add?${cartParams.toString()}`;

    console.log('[Design Studio] Redirecting to cart:', cartUrl);

    // Navigate to cart - try multiple approaches for iframe compatibility
    try {
      if (window.top && window.top !== window) {
        // In iframe - try to navigate the top window
        window.top.location.href = cartUrl;
      } else if (window.parent && window.parent !== window) {
        window.parent.location.href = cartUrl;
      } else {
        window.location.href = cartUrl;
      }
    } catch (e) {
      // If navigation is blocked (sandbox restrictions), try opening in new tab
      console.log('[Design Studio] Navigation blocked, opening in new tab:', e);
      const newWindow = window.open(cartUrl, '_blank');
      if (!newWindow) {
        // Popup blocked - show error
        setIsAddingToCart(false);
        setVariantError("Unable to open cart. Please disable popup blocker and try again.");
      } else {
        setIsAddingToCart(false);
        setGeneratedDesign(null);
      }
    }
  };

  const handleShare = async () => {
    if (!generatedDesign) return;

    setIsSharing(true);
    try {
      const response = await fetch(`${API_BASE}/api/designs/share`, {
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
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === "ai-art-studio:cart-updated") {
        // Clear the timeout since we got a response
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
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  useEffect(() => {
    if (isEmbedded) {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          window.parent.postMessage(
            {
              type: "ai-art-studio:resize",
              height: entry.contentRect.height + 40,
            },
            "*"
          );
        }
      });

      observer.observe(document.body);
      return () => observer.disconnect();
    }
  }, [isEmbedded]);

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

  return (
    <div className={`p-4 ${isEmbedded ? "bg-transparent" : "bg-background min-h-screen"}`}>
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold" data-testid="text-title">
            Create Your Design
          </h2>
          {/* Only show login/credits info for non-Shopify mode */}
          {!isShopify && (
            isLoggedIn ? (
              <span className="text-sm text-muted-foreground" data-testid="text-credits">
                {credits} credits
              </span>
            ) : (
              <span className="text-sm text-muted-foreground flex items-center gap-1" data-testid="text-login-prompt">
                <LogIn className="w-4 h-4" />
                Log in to create
              </span>
            )
          )}
        </div>

        {/* Only show login errors for non-Shopify mode */}
        {!isShopify && loginError && (
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Form panel - shows second on mobile when design exists */}
          <div className={`space-y-4 ${generatedDesign ? "order-2 md:order-1" : ""}`}>
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "generate" | "import")}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="generate" data-testid="tab-generate">
                  <Sparkles className="w-4 h-4 mr-2" />
                  AI Generate
                </TabsTrigger>
                <TabsTrigger value="import" data-testid="tab-import">
                  <Upload className="w-4 h-4 mr-2" />
                  Import Design
                </TabsTrigger>
              </TabsList>

              <TabsContent value="generate" className="space-y-4 mt-4">
                {/* Style Selection - Required, at top */}
                {showPresetsParam && filteredStylePresets.length > 0 && (
                  <div className="space-y-2">
                    <StyleSelector
                      stylePresets={filteredStylePresets}
                      selectedStyle={selectedPreset}
                      onStyleChange={setSelectedPreset}
                    />
                    {selectedPreset === "" && (
                      <p className="text-xs text-muted-foreground">Please select a style before generating</p>
                    )}
                  </div>
                )}

                {/* Reference Image Upload */}
                <div className="space-y-2">
                  <Label data-testid="label-reference">Reference Image (optional)</Label>
                  <div className="flex items-center gap-4 flex-wrap">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleFileChange}
                      className="hidden"
                      data-testid="input-reference-file"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      data-testid="button-upload-reference"
                    >
                      <ImagePlus className="w-4 h-4 mr-2" />
                      Upload
                    </Button>
                    {referencePreview && (
                      <div className="relative">
                        <img
                          src={referencePreview}
                          alt="Reference"
                          className="w-12 h-12 object-cover rounded-md"
                          data-testid="img-reference-preview"
                        />
                        <Button
                          type="button"
                          variant="destructive"
                          size="icon"
                          className="absolute -top-2 -right-2 w-5 h-5"
                          onClick={clearReferenceImage}
                          data-testid="button-clear-reference"
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Prompt Description */}
                <div className="space-y-2">
                  <Label htmlFor="prompt" data-testid="label-prompt">
                    Describe your artwork
                  </Label>
                  <Textarea
                    id="prompt"
                    data-testid="input-prompt"
                    placeholder="Describe the artwork you want to create... e.g., 'A serene sunset over mountains with golden clouds'"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    className="min-h-[80px]"
                  />
                </div>

                {/* Size Selection - Required */}
                {printSizes.length > 0 && (
                  <div className="space-y-2">
                    <SizeSelector
                      sizes={printSizes}
                      selectedSize={selectedSize}
                      onSizeChange={(sizeId) => {
                        setSelectedSize(sizeId);
                        setTransform({ scale: defaultZoom, x: 50, y: 50 });
                      }}
                    />
                    {selectedSize === "" && (
                      <p className="text-xs text-muted-foreground">Please select a size before generating</p>
                    )}
                  </div>
                )}

                {frameColorObjects.length > 0 && (
                  <FrameColorSelector
                    frameColors={frameColorObjects}
                    selectedFrameColor={selectedFrameColor}
                    onFrameColorChange={setSelectedFrameColor}
                  />
                )}

                <Button
                  onClick={() => {
                    // Validation for required fields
                    if (showPresetsParam && filteredStylePresets.length > 0 && selectedPreset === "") {
                      alert("Please select a style before generating");
                      return;
                    }
                    if (printSizes.length > 0 && selectedSize === "") {
                      alert("Please select a size before generating");
                      return;
                    }
                    handleGenerate();
                  }}
                  disabled={!prompt.trim() || generateMutation.isPending || (!isShopify && (!isLoggedIn || credits <= 0))}
                  className="w-full"
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
                      {isShopify ? "Generate Design" : "Generate (1 Credit)"}
                    </>
                  )}
                </Button>
              </TabsContent>

              <TabsContent value="import" className="space-y-4 mt-4">
                <Card>
                  <CardContent className="pt-6 space-y-4">
                    <div className="text-center space-y-2">
                      <h3 className="font-medium">Import from Kittl</h3>
                      <p className="text-sm text-muted-foreground">
                        Export your design from Kittl as PNG or SVG, then upload it here.
                      </p>
                    </div>
                    
                    <div className="flex flex-col gap-3">
                      <a
                        href="https://www.kittl.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary flex items-center justify-center gap-1 hover:underline"
                        data-testid="link-kittl"
                      >
                        <ExternalLink className="w-3 h-3" />
                        Open Kittl Designer
                      </a>
                      
                      <input
                        ref={importFileInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/jpg,image/webp"
                        onChange={(e) => handleImportFile(e, "kittl")}
                        className="hidden"
                        data-testid="input-import-kittl"
                      />
                      
                      <Button
                        variant="default"
                        onClick={() => importFileInputRef.current?.click()}
                        disabled={isImporting}
                        className="w-full"
                        data-testid="button-import-kittl"
                      >
                        {isImporting ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Importing...
                          </>
                        ) : (
                          <>
                            <Upload className="w-4 h-4 mr-2" />
                            Upload Kittl Design
                          </>
                        )}
                      </Button>
                    </div>

                    {importError && (
                      <p className="text-destructive text-sm text-center" data-testid="text-import-error">
                        {importError}
                      </p>
                    )}

                    <div className="border-t pt-4 mt-4">
                      <p className="text-xs text-muted-foreground text-center mb-3">
                        Or upload any custom design
                      </p>
                      <input
                        ref={customUploadInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/jpg,image/webp"
                        onChange={(e) => handleImportFile(e, "upload")}
                        className="hidden"
                        data-testid="input-import-custom"
                      />
                      <Button
                        variant="outline"
                        onClick={() => customUploadInputRef.current?.click()}
                        disabled={isImporting}
                        className="w-full"
                        data-testid="button-import-custom"
                      >
                        <ImagePlus className="w-4 h-4 mr-2" />
                        Upload Custom Design
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                <div className="text-xs text-muted-foreground space-y-1">
                  <p>Supported formats: PNG, JPG, WebP</p>
                  <p>Maximum file size: 10MB</p>
                  <p>For best results, export from Kittl as high-resolution PNG</p>
                </div>

                {printSizes.length > 0 && (
                  <SizeSelector
                    sizes={printSizes}
                    selectedSize={selectedSize}
                    onSizeChange={(sizeId) => {
                      setSelectedSize(sizeId);
                      setTransform({ scale: defaultZoom, x: 50, y: 50 });
                    }}
                  />
                )}

                {frameColorObjects.length > 0 && (
                  <FrameColorSelector
                    frameColors={frameColorObjects}
                    selectedFrameColor={selectedFrameColor}
                    onFrameColorChange={setSelectedFrameColor}
                  />
                )}
              </TabsContent>
            </Tabs>
          </div>

          {/* Design preview panel - shows first on mobile when design exists */}
          <div className={`space-y-3 ${generatedDesign ? "order-1 md:order-2" : ""}`}>
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
                <ProductMockup
                  imageUrl={generatedDesign?.imageUrl}
                  isLoading={generateMutation.isPending}
                  selectedSize={selectedSizeConfig}
                  selectedFrameColor={selectedFrameColorConfig}
                  transform={transform}
                  onTransformChange={setTransform}
                  enableDrag={!!generatedDesign?.imageUrl}
                  designerType={productTypeConfig?.designerType || "generic"}
                  printShape={productTypeConfig?.printShape || "rectangle"}
                  canvasConfig={productTypeConfig?.canvasConfig}
                />
              </div>
            </div>

            {generatedDesign?.imageUrl && (
              <ZoomControls
                transform={transform}
                onTransformChange={setTransform}
                disabled={!generatedDesign?.imageUrl}
              />
            )}

            {/* Mockup generation status - shown only in Shopify embed mode */}
            {isShopify && productTypeConfig?.hasPrintifyMockups && generatedDesign?.imageUrl && (
              <div className="border-t pt-3" data-testid="container-mockup-status">
                {mockupLoading ? (
                  <div className="flex items-center justify-center gap-2 py-3 bg-muted/50 rounded-md">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span className="text-sm text-muted-foreground">Rendering product mockups...</span>
                  </div>
                ) : mockupError ? (
                  <div className="flex items-center justify-center gap-2 py-3 bg-destructive/10 rounded-md">
                    <span className="text-sm text-destructive">Preview unavailable - design ready for cart</span>
                  </div>
                ) : printifyMockups.length > 0 ? (
                  <div className="flex items-center justify-center gap-2 py-3 bg-green-500/10 rounded-md">
                    <span className="text-sm text-green-600">Product images updated above</span>
                  </div>
                ) : null}
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

            {generatedDesign && (
              <div className="flex flex-col gap-3">
                {isSharedDesign && (
                  <div className="text-sm text-muted-foreground bg-muted/50 rounded-md p-2 text-center">
                    Viewing a shared design. Generate your own or add to cart!
                  </div>
                )}
                
                {/* Shopify Add to Cart - Prominent, styled like native button */}
                {isShopify && (
                  <Button
                    onClick={handleAddToCart}
                    disabled={isAddingToCart}
                    className="w-full h-12 text-base font-medium"
                    data-testid="button-add-to-cart"
                  >
                    {isAddingToCart ? (
                      <>
                        <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                        Adding to Cart...
                      </>
                    ) : (
                      <>
                        <ShoppingCart className="w-5 h-5 mr-2" />
                        Add to Cart
                      </>
                    )}
                  </Button>
                )}
                
                {/* Secondary actions */}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      // Validation for required fields
                      if (showPresetsParam && filteredStylePresets.length > 0 && selectedPreset === "") {
                        alert("Please select a style before generating");
                        return;
                      }
                      if (printSizes.length > 0 && selectedSize === "") {
                        alert("Please select a size before generating");
                        return;
                      }
                      handleGenerate();
                    }}
                    disabled={generateMutation.isPending || (!isShopify && credits <= 0)}
                    className="flex-1"
                    data-testid="button-regenerate"
                  >
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Regenerate
                  </Button>

                  <Button
                    variant="outline"
                    onClick={handleShare}
                    disabled={isSharing}
                    data-testid="button-share"
                  >
                    {isSharing ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Share2 className="w-4 h-4" />
                    )}
                  </Button>
                </div>
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
