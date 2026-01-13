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
}

export default function EmbedDesign() {
  const searchParams = new URLSearchParams(window.location.search);

  const isEmbedded = searchParams.get("embedded") === "true";
  const isShopify = searchParams.get("shopify") === "true";
  const productTypeId = searchParams.get("productTypeId") || "1";
  const productId = searchParams.get("productId") || "";
  const productHandle = searchParams.get("productHandle") || "";
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
  const [selectedPreset, setSelectedPreset] = useState<string>("none");
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
    // First try the URL param (set by theme extension)
    const shopParam = searchParams.get("shop") || "";
    if (shopParam && shopParam.endsWith(".myshopify.com")) {
      return shopParam;
    }
    
    // If shop param is a custom domain or empty, try to get from referrer
    // The referrer in Shopify embeds is the product page URL
    try {
      const referrer = document.referrer;
      if (referrer) {
        const referrerUrl = new URL(referrer);
        // Check if referrer hostname is a myshopify.com domain
        if (referrerUrl.hostname.endsWith(".myshopify.com")) {
          return referrerUrl.hostname;
        }
        // Otherwise, return whatever shop param we have (could be custom domain)
        // Backend will try to resolve it
        if (shopParam) {
          return shopParam;
        }
        // Last resort: use referrer hostname
        return referrerUrl.hostname;
      }
    } catch (e) {
      console.warn("Failed to parse referrer for shop domain:", e);
    }
    
    // Return whatever we have
    return shopParam;
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
    if (selectedPreset && selectedPreset !== "none" && filteredStylePresets.length > 0) {
      const isValidPreset = filteredStylePresets.some(p => p.id === selectedPreset);
      if (!isValidPreset) {
        setSelectedPreset("none");
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
    Promise.all([
      fetch("/api/config").then(res => res.json()),
      // Use the designer endpoint to get proper designer config (same as design.tsx and admin pages)
      fetch(`/api/product-types/${productTypeId}/designer`).then(res => res.ok ? res.json() : null)
    ])
      .then(([configData, designerConfig]) => {
        if (configData.stylePresets) {
          setStylePresets(configData.stylePresets);
        }
        if (designerConfig) {
          // Designer endpoint returns properly formatted config
          setProductTypeConfig({
            id: designerConfig.id,
            name: designerConfig.name,
            description: designerConfig.description || null,
            aspectRatio: designerConfig.aspectRatio,
            designerType: designerConfig.designerType,
            printShape: designerConfig.printShape,
            canvasConfig: designerConfig.canvasConfig,
            sizes: designerConfig.sizes || [],
            frameColors: designerConfig.frameColors || []
          });
          if (designerConfig.sizes?.length > 0) setSelectedSize(designerConfig.sizes[0].id);
          if (designerConfig.frameColors?.length > 0) setSelectedFrameColor(designerConfig.frameColors[0].id);
        } else {
          setProductTypeConfig(defaultProductTypeConfig);
          setSelectedSize(defaultProductTypeConfig.sizes[0].id);
          setSelectedFrameColor(defaultProductTypeConfig.frameColors[0].id);
          setProductTypeError(`Product type "${productTypeId}" not found. Using default configuration.`);
        }
        setConfigLoading(false);
      })
      .catch(() => {
        setProductTypeConfig(defaultProductTypeConfig);
        setSelectedSize(defaultProductTypeConfig.sizes[0].id);
        setSelectedFrameColor(defaultProductTypeConfig.frameColors[0].id);
        setProductTypeError("Failed to load product configuration. Using default settings.");
        setConfigLoading(false);
      });
  }, [productTypeId]);

  // Load shared design if sharedDesignId is present in URL
  useEffect(() => {
    if (!sharedDesignId) {
      setIsLoadingSharedDesign(false);
      return;
    }

    fetch(`/api/shared-designs/${sharedDesignId}`)
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
        setSelectedPreset(sharedDesign.stylePreset || "none");
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
    if (isShopify && shopDomain) {
      fetch("/api/shopify/session", {
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
      })
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error || `Session failed: ${res.status}`);
          }
          return data;
        })
        .then((data) => {
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
          console.error("Failed to get session token:", error);
          setSessionError(error.message || "Failed to connect to store");
          setSessionLoading(false);
        });
    } else {
      setSessionLoading(false);
    }
  }, [isShopify, shopDomain, productId, shopifyCustomerId, shopifyCustomerEmail, shopifyCustomerName]);

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
      const endpoint = isShopify ? "/api/shopify/generate" : "/api/generate";
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
      setGeneratedDesign({
        id: data.designId || data.design?.id || crypto.randomUUID(),
        imageUrl: data.imageUrl || data.design?.generatedImageUrl,
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

    let fullPrompt = prompt;
    if (selectedPreset && selectedPreset !== "none") {
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
      size: selectedSize || "medium",
      frameColor: selectedFrameColor || "black",
      stylePreset: selectedPreset && selectedPreset !== "none" ? selectedPreset : undefined,
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
      const uploadUrlResponse = await fetch("/api/uploads/request-url", {
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

      // Step 2: Upload the file directly to storage
      const uploadResponse = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!uploadResponse.ok) {
        throw new Error("Failed to upload file");
      }

      // Step 3: Validate and get image metadata
      const importResponse = await fetch("/api/designs/import", {
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
      setGeneratedDesign({
        id: crypto.randomUUID(),
        imageUrl: importData.imageUrl,
        prompt: source === "kittl" ? `Imported from Kittl: ${file.name}` : `Uploaded design: ${file.name}`,
      });
      setPrompt(source === "kittl" ? `Imported from Kittl: ${file.name}` : `Uploaded design: ${file.name}`);
      setDesignSource(source);
      
      // Use conditional default zoom (135% for apparel, 100% for others)
      const zoomDefault = productTypeConfig?.designerType === "apparel" ? 135 : 100;
      setTransform({ scale: zoomDefault, x: 50, y: 50 });

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

  useEffect(() => {
    try {
      const variantsData = searchParams.get("variants");
      if (variantsData) {
        const parsed = JSON.parse(variantsData);
        if (Array.isArray(parsed)) {
          setVariants(parsed);
        }
      }
    } catch (e) {
      console.error("Failed to parse variants:", e);
    }
  }, []);

  const findVariantId = (): string | null => {
    if (!isShopify) return null;

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

        if (selectedFrameColor) {
          colorMatch = options.some(
            (opt) =>
              opt?.toLowerCase().includes(selectedFrameColor.toLowerCase()) ||
              selectedFrameColor.toLowerCase().includes(opt?.toLowerCase())
          );
        }

        return sizeMatch && colorMatch;
      });

      if (matchedVariant) {
        return matchedVariant.id?.toString() || null;
      }
    }

    return selectedVariantParam || null;
  };

  const handleAddToCart = () => {
    if (!generatedDesign || !isShopify) return;

    const variantId = findVariantId();

    if (!variantId) {
      setVariantError(
        "Unable to find matching product variant. Please select a valid size and frame color combination."
      );
      return;
    }

    setVariantError(null);
    setIsAddingToCart(true);

    window.parent.postMessage(
      {
        type: "ai-art-studio:add-to-cart",
        variantId: variantId,
        artworkUrl: generatedDesign.imageUrl,
        designId: generatedDesign.id,
        size: selectedSize,
        frameColor: selectedFrameColor,
      },
      "*"
    );
  };

  const handleShare = async () => {
    if (!generatedDesign) return;

    setIsSharing(true);
    try {
      const response = await fetch("/api/designs/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl: generatedDesign.imageUrl,
          prompt: generatedDesign.prompt,
          stylePreset: selectedPreset !== "none" ? selectedPreset : null,
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
        setIsAddingToCart(false);
        if (event.data.success) {
          setGeneratedDesign(null);
          setPrompt("");
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
        await apiRequest("PATCH", `/api/designs/${generatedDesign.id}`, {
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

  if (sessionLoading || configLoading) {
    return (
      <div className={`p-4 ${isEmbedded ? "bg-transparent" : "bg-background min-h-screen"}`}>
        <div className="max-w-2xl mx-auto space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
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

        {productTypeError && (
          <Card className="border-amber-500 bg-amber-50 dark:bg-amber-950">
            <CardContent className="py-3">
              <p className="text-amber-700 dark:text-amber-300 text-sm" data-testid="text-product-type-error">
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
          <div className="space-y-4">
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

                {showPresetsParam && filteredStylePresets.length > 0 && (
                  <StyleSelector
                    stylePresets={[{ id: "none", name: "None", promptSuffix: "" }, ...filteredStylePresets]}
                    selectedStyle={selectedPreset}
                    onStyleChange={setSelectedPreset}
                  />
                )}

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

                <Button
                  onClick={handleGenerate}
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

          <div className="space-y-3">
            <div
              className="w-full rounded-md overflow-hidden"
              style={{
                aspectRatio: selectedSizeConfig
                  ? `${selectedSizeConfig.width}/${selectedSizeConfig.height}`
                  : "3/4",
              }}
              data-testid="container-mockup"
            >
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

            {generatedDesign?.imageUrl && (
              <ZoomControls
                transform={transform}
                onTransformChange={setTransform}
                disabled={!generatedDesign?.imageUrl}
              />
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
              <div className="flex flex-col gap-2">
                {isSharedDesign && (
                  <div className="text-sm text-muted-foreground bg-muted/50 rounded-md p-2 text-center">
                    Viewing a shared design. Generate your own or add to cart!
                  </div>
                )}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={handleGenerate}
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

                  {isShopify && (
                    <Button
                      onClick={handleAddToCart}
                      disabled={isAddingToCart}
                      className="flex-1"
                      data-testid="button-add-to-cart"
                    >
                      {isAddingToCart ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Adding...
                        </>
                      ) : (
                        <>
                          <ShoppingCart className="w-4 h-4 mr-2" />
                          Add to Cart
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
