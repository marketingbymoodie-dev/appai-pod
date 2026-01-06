import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Sparkles, ImagePlus, ShoppingCart, RefreshCw, X } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface StylePreset {
  id: string;
  name: string;
  promptSuffix: string;
  thumbnailUrl?: string;
}

interface GeneratedDesign {
  id: string;
  imageUrl: string;
  prompt: string;
}

export default function EmbedDesign() {
  const searchParams = new URLSearchParams(window.location.search);
  
  const isEmbedded = searchParams.get("embedded") === "true";
  const isShopify = searchParams.get("shopify") === "true";
  const productId = searchParams.get("productId") || "";
  const productHandle = searchParams.get("productHandle") || "";
  const productTitle = decodeURIComponent(searchParams.get("productTitle") || "Custom Pillow");
  const showPresetsParam = searchParams.get("showPresets") !== "false";
  const sizesParam = searchParams.get("sizes") || "";
  const frameColorsParam = searchParams.get("frameColors") || "";
  const selectedVariantParam = searchParams.get("selectedVariant") || "";

  const sizes = sizesParam ? sizesParam.split(",").filter(Boolean) : [];
  const frameColors = frameColorsParam ? frameColorsParam.split(",").filter(Boolean) : [];

  const [prompt, setPrompt] = useState("");
  const [selectedSize, setSelectedSize] = useState(sizes[0] || "");
  const [selectedFrameColor, setSelectedFrameColor] = useState(frameColors[0] || "");
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);
  const [generatedDesign, setGeneratedDesign] = useState<GeneratedDesign | null>(null);
  const [isAddingToCart, setIsAddingToCart] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: config } = useQuery<{ stylePresets?: StylePreset[] }>({
    queryKey: ["/api/config"],
  });

  const stylePresets: StylePreset[] = config?.stylePresets || [];

  const shopDomain = searchParams.get("shop") || "";
  const [sessionToken, setSessionToken] = useState<string | null>(null);

  useEffect(() => {
    if (isShopify && shopDomain) {
      fetch("/api/shopify/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop: shopDomain,
          productId: productId,
          timestamp: Date.now().toString(),
        }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.sessionToken) {
            setSessionToken(data.sessionToken);
          }
        })
        .catch((error) => {
          console.error("Failed to get session token:", error);
        });
    }
  }, [isShopify, shopDomain, productId]);

  const generateMutation = useMutation({
    mutationFn: async (payload: {
      prompt: string;
      size: string;
      frameColor: string;
      stylePreset?: string;
      referenceImage?: string;
      shop?: string;
      sessionToken?: string;
    }) => {
      const endpoint = isShopify ? "/api/shopify/generate" : "/api/generate";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to generate design");
      }
      return response.json();
    },
    onSuccess: (data) => {
      setGeneratedDesign({
        id: data.designId || data.design?.id || crypto.randomUUID(),
        imageUrl: data.imageUrl || data.design?.generatedImageUrl,
        prompt: prompt,
      });
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
      const preset = stylePresets.find(p => p.id === selectedPreset);
      if (preset?.promptSuffix) {
        fullPrompt = `${prompt}. ${preset.promptSuffix}`;
      }
    }
    
    fullPrompt += ". Full-bleed design, edge-to-edge artwork, no borders or margins, seamless pattern that fills the entire canvas.";
    
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
          sizeMatch = options.some(opt => 
            opt?.toLowerCase().includes(selectedSize.toLowerCase()) ||
            selectedSize.toLowerCase().includes(opt?.toLowerCase())
          );
        }
        
        if (selectedFrameColor) {
          colorMatch = options.some(opt => 
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
      setVariantError("Unable to find matching product variant. Please select a valid size and frame color combination.");
      return;
    }
    
    setVariantError(null);
    setIsAddingToCart(true);
    
    window.parent.postMessage({
      type: "ai-art-studio:add-to-cart",
      variantId: variantId,
      artworkUrl: generatedDesign.imageUrl,
      designId: generatedDesign.id,
      size: selectedSize,
      frameColor: selectedFrameColor,
    }, "*");
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
          window.parent.postMessage({
            type: "ai-art-studio:resize",
            height: entry.contentRect.height + 40,
          }, "*");
        }
      });
      
      observer.observe(document.body);
      return () => observer.disconnect();
    }
  }, [isEmbedded]);

  return (
    <div className={`p-4 ${isEmbedded ? "bg-transparent" : "bg-background min-h-screen"}`}>
      <div className="max-w-2xl mx-auto space-y-6">
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
              className="min-h-[100px]"
            />
          </div>

          <div className="space-y-2">
            <Label data-testid="label-reference">
              Reference Image (optional)
            </Label>
            <div className="flex items-center gap-4">
              <Input
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
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-upload-reference"
              >
                <ImagePlus className="w-4 h-4 mr-2" />
                Upload Reference
              </Button>
              {referencePreview && (
                <div className="relative">
                  <img
                    src={referencePreview}
                    alt="Reference"
                    className="w-16 h-16 object-cover rounded-md"
                    data-testid="img-reference-preview"
                  />
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    className="absolute -top-2 -right-2 w-6 h-6"
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
            <div className="space-y-2">
              <Label data-testid="label-style">Style Preset</Label>
              <Select value={selectedPreset} onValueChange={setSelectedPreset}>
                <SelectTrigger data-testid="select-style">
                  <SelectValue placeholder="Choose a style (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" data-testid="select-style-none">None</SelectItem>
                  {stylePresets.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id} data-testid={`select-style-${preset.id}`}>
                      {preset.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            {sizes.length > 0 && (
              <div className="space-y-2">
                <Label data-testid="label-size">Size</Label>
                <Select value={selectedSize} onValueChange={setSelectedSize}>
                  <SelectTrigger data-testid="select-size">
                    <SelectValue placeholder="Select size" />
                  </SelectTrigger>
                  <SelectContent>
                    {sizes.map((size) => (
                      <SelectItem key={size} value={size} data-testid={`select-size-${size}`}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {frameColors.length > 0 && (
              <div className="space-y-2">
                <Label data-testid="label-frame">Frame Color</Label>
                <Select value={selectedFrameColor} onValueChange={setSelectedFrameColor}>
                  <SelectTrigger data-testid="select-frame">
                    <SelectValue placeholder="Select frame" />
                  </SelectTrigger>
                  <SelectContent>
                    {frameColors.map((color) => (
                      <SelectItem key={color} value={color} data-testid={`select-frame-${color}`}>
                        {color}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <Button
            onClick={handleGenerate}
            disabled={!prompt.trim() || generateMutation.isPending}
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
                Generate Artwork
              </>
            )}
          </Button>
        </div>

        {generateMutation.isError && (
          <Card className="border-destructive">
            <CardContent className="py-4">
              <p className="text-destructive text-sm" data-testid="text-error">
                {generateMutation.error?.message || "Failed to generate design. Please try again."}
              </p>
            </CardContent>
          </Card>
        )}

        {generatedDesign && (
          <Card data-testid="card-generated-design">
            <CardContent className="p-4 space-y-4">
              <div className="aspect-square relative overflow-hidden rounded-md bg-muted">
                <img
                  src={generatedDesign.imageUrl}
                  alt="Generated artwork"
                  className="w-full h-full object-cover"
                  data-testid="img-generated"
                />
              </div>
              
              {variantError && (
                <p className="text-destructive text-sm" data-testid="text-variant-error">
                  {variantError}
                </p>
              )}
              
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={handleGenerate}
                  disabled={generateMutation.isPending}
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
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
