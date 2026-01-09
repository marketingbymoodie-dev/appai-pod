import { useState, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Sparkles, ImagePlus, ShoppingCart, RefreshCw, X, Save, LogIn } from "lucide-react";
import {
  MockupPreview,
  ZoomControls,
  FrameColorSelector,
  SizeSelector,
  StyleSelector,
  type ImageTransform,
  type PrintSize,
  type FrameColor,
  type StylePreset,
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
  designerType?: string;
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
  const productTitle = decodeURIComponent(searchParams.get("productTitle") || "Custom Framed Print");
  const showPresetsParam = searchParams.get("showPresets") !== "false";
  const selectedVariantParam = searchParams.get("selectedVariant") || "";
  const shopifyCustomerId = searchParams.get("customerId") || "";
  const shopifyCustomerEmail = searchParams.get("customerEmail") || "";
  const shopifyCustomerName = searchParams.get("customerName") || "";

  const [prompt, setPrompt] = useState("");
  const [selectedSize, setSelectedSize] = useState("");
  const [selectedFrameColor, setSelectedFrameColor] = useState("");
  const [selectedPreset, setSelectedPreset] = useState<string>("none");
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);
  const [generatedDesign, setGeneratedDesign] = useState<GeneratedDesign | null>(null);
  const [isAddingToCart, setIsAddingToCart] = useState(false);
  const [transform, setTransform] = useState<ImageTransform>({ scale: 100, x: 50, y: 50 });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [stylePresets, setStylePresets] = useState<StylePreset[]>([]);
  const [productTypeConfig, setProductTypeConfig] = useState<ProductTypeConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [productTypeError, setProductTypeError] = useState<string | null>(null);

  const shopDomain = searchParams.get("shop") || "";
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [customer, setCustomer] = useState<CustomerInfo | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Computed zoom values based on product type (apparel uses 135%, others use 100%)
  const isApparel = productTypeConfig?.designerType === "apparel";
  const defaultZoom = isApparel ? 135 : 100;
  const maxZoom = isApparel ? 135 : 200;

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
        .then((res) => res.json())
        .then((data) => {
          if (data.sessionToken) {
            setSessionToken(data.sessionToken);
            if (data.customer) {
              setCustomer(data.customer);
            }
          }
          setSessionLoading(false);
        })
        .catch((error) => {
          console.error("Failed to get session token:", error);
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
      setTransform({ scale: zoomDefault, x: 50, y: 50 });
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
      const preset = stylePresets.find((p) => p.id === selectedPreset);
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

        {loginError && (
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-4">
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

            {showPresetsParam && stylePresets.length > 0 && (
              <StyleSelector
                stylePresets={[{ id: "none", name: "None", promptSuffix: "" }, ...stylePresets]}
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
              disabled={!prompt.trim() || generateMutation.isPending || !isLoggedIn || credits <= 0}
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
                  Generate (1 Credit)
                </>
              )}
            </Button>
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
              <MockupPreview
                imageUrl={generatedDesign?.imageUrl}
                isLoading={generateMutation.isPending}
                selectedSize={selectedSizeConfig}
                selectedFrameColor={selectedFrameColorConfig}
                transform={transform}
                onTransformChange={setTransform}
                enableDrag={!!generatedDesign?.imageUrl}
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
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={handleGenerate}
                  disabled={generateMutation.isPending || credits <= 0}
                  className="flex-1"
                  data-testid="button-regenerate"
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Regenerate
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
