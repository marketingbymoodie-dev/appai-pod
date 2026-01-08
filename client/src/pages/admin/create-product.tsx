import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Sparkles, Upload, Loader2, ZoomIn, Send, Package } from "lucide-react";
import AdminLayout from "@/components/admin-layout";
import type { ProductType, Merchant } from "@shared/schema";

interface DesignerConfig {
  id: number;
  name: string;
  description: string | null;
  printifyBlueprintId: number | null;
  aspectRatio: string;
  printShape: string;
  printAreaWidth: number | null;
  printAreaHeight: number | null;
  bleedMarginPercent: number;
  designerType: string;
  sizeType: string;
  hasPrintifyMockups: boolean;
  baseMockupImages: { front?: string; lifestyle?: string };
  sizes: Array<{ id: string; name: string; width: number; height: number; aspectRatio?: string }>;
  frameColors: Array<{ id: string; name: string; hex: string }>;
  canvasConfig: { maxDimension: number; width: number; height: number; safeZoneMargin: number };
  variantMap?: Record<string, { printifyVariantId: number; providerId: number }>;
}

interface Config {
  stylePresets: Array<{ id: string; name: string; promptPrefix: string; category: string }>;
}

export default function AdminCreateProduct() {
  const { toast } = useToast();
  const searchParams = new URLSearchParams(window.location.search);
  const initialProductTypeId = searchParams.get("productTypeId");
  
  const [selectedProductTypeId, setSelectedProductTypeId] = useState<number | null>(
    initialProductTypeId ? parseInt(initialProductTypeId) : null
  );
  const [prompt, setPrompt] = useState("");
  const [selectedSize, setSelectedSize] = useState<string>("");
  const [selectedFrameColor, setSelectedFrameColor] = useState<string>("");
  const [selectedStyle, setSelectedStyle] = useState<string>("none");
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [imageScale, setImageScale] = useState(100);
  
  const [mockupImages, setMockupImages] = useState<{ url: string; label: string }[]>([]);
  const [mockupLoading, setMockupLoading] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: merchant } = useQuery<Merchant>({
    queryKey: ["/api/merchant"],
  });

  const { data: productTypes, isLoading: productTypesLoading } = useQuery<ProductType[]>({
    queryKey: ["/api/product-types"],
  });

  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
  });

  const { data: designerConfig, isLoading: designerConfigLoading } = useQuery<DesignerConfig>({
    queryKey: ["/api/product-types", selectedProductTypeId, "designer"],
    enabled: !!selectedProductTypeId,
  });

  useEffect(() => {
    if (designerConfig) {
      if (designerConfig.sizes.length > 0 && !selectedSize) {
        setSelectedSize(designerConfig.sizes[0].id);
      }
      if (designerConfig.frameColors.length > 0 && !selectedFrameColor) {
        setSelectedFrameColor(designerConfig.frameColors[0].id);
      }
    }
  }, [designerConfig, selectedSize, selectedFrameColor]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        setReferenceImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleGenerate = async () => {
    if (!prompt || !selectedProductTypeId || !selectedSize) {
      toast({ title: "Missing information", description: "Please fill in all required fields", variant: "destructive" });
      return;
    }

    setIsGenerating(true);
    setGeneratedImageUrl(null);
    setMockupImages([]);

    try {
      const response = await apiRequest("POST", "/api/designs/generate", {
        prompt,
        size: selectedSize,
        frameColor: selectedFrameColor,
        stylePreset: selectedStyle,
        productTypeId: selectedProductTypeId,
        referenceImageBase64: referenceImage,
      });

      const data = await response.json();
      setGeneratedImageUrl(data.generatedImageUrl);
      toast({ title: "Design generated!", description: "Your test design is ready" });

      // Generate mockups if available
      if (designerConfig?.hasPrintifyMockups && merchant?.printifyShopId) {
        await generateMockups(data.generatedImageUrl);
      }
    } catch (error: any) {
      toast({ title: "Generation failed", description: error.message, variant: "destructive" });
    } finally {
      setIsGenerating(false);
    }
  };

  const generateMockups = async (imageUrl: string) => {
    if (!selectedProductTypeId || !selectedSize || !selectedFrameColor) return;

    setMockupLoading(true);
    try {
      const response = await fetch("/api/mockup/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          productTypeId: selectedProductTypeId,
          designImageUrl: imageUrl,
          sizeId: selectedSize,
          colorId: selectedFrameColor,
          scale: imageScale,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.mockups && data.mockups.length > 0) {
          setMockupImages(data.mockups.map((m: any) => ({
            url: m.url || m,
            label: m.label || "Mockup",
          })));
        }
      }
    } catch (error) {
      console.error("Mockup generation failed:", error);
    } finally {
      setMockupLoading(false);
    }
  };

  const [styleCategory, setStyleCategory] = useState<"decor" | "apparel">("decor");
  
  // Auto-set style category based on designer type when config loads
  useEffect(() => {
    if (designerConfig) {
      const designerType = designerConfig.designerType || "";
      if (designerType === "apparel" || designerType.includes("shirt") || designerType.includes("hoodie")) {
        setStyleCategory("apparel");
      } else {
        setStyleCategory("decor");
      }
    }
  }, [designerConfig]);
  
  const filteredStyles = config?.stylePresets.filter(style => 
    style.category === "all" || style.category === styleCategory
  ) || [];

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-create-product-title">Create New Product</h1>
          <p className="text-muted-foreground">Test the AI generator for a product type before publishing to your store</p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Product Configuration</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Product Type</Label>
                  {productTypesLoading ? (
                    <Skeleton className="h-10 w-full" />
                  ) : (
                    <Select 
                      value={selectedProductTypeId?.toString() || ""} 
                      onValueChange={(v) => {
                        setSelectedProductTypeId(parseInt(v));
                        setSelectedSize("");
                        setSelectedFrameColor("");
                        setGeneratedImageUrl(null);
                        setMockupImages([]);
                      }}
                    >
                      <SelectTrigger data-testid="select-product-type">
                        <SelectValue placeholder="Select a product type" />
                      </SelectTrigger>
                      <SelectContent>
                        {productTypes?.map((pt) => (
                          <SelectItem key={pt.id} value={pt.id.toString()}>
                            {pt.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                {designerConfig && (
                  <>
                    <div className="space-y-2">
                      <Label>Size</Label>
                      <Select value={selectedSize} onValueChange={setSelectedSize}>
                        <SelectTrigger data-testid="select-size">
                          <SelectValue placeholder="Select size" />
                        </SelectTrigger>
                        <SelectContent>
                          {designerConfig.sizes.map((size) => (
                            <SelectItem key={size.id} value={size.id}>
                              {size.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {designerConfig.frameColors.length > 0 && (
                      <div className="space-y-2">
                        <Label>{designerConfig.designerType === "framed-print" ? "Frame Color" : "Color"}</Label>
                        <div className="flex flex-wrap gap-2">
                          {designerConfig.frameColors.map((color) => (
                            <button
                              key={color.id}
                              className={`w-10 h-10 rounded-md border-2 transition-all ${
                                selectedFrameColor === color.id
                                  ? "border-primary ring-2 ring-primary ring-offset-2"
                                  : "border-muted"
                              }`}
                              style={{ backgroundColor: color.hex }}
                              onClick={() => setSelectedFrameColor(color.id)}
                              title={color.name}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Style</Label>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant={styleCategory === "decor" ? "default" : "outline"}
                        size="sm"
                        onClick={() => setStyleCategory("decor")}
                        data-testid="button-style-decor"
                      >
                        Decor
                      </Button>
                      <Button
                        type="button"
                        variant={styleCategory === "apparel" ? "default" : "outline"}
                        size="sm"
                        onClick={() => setStyleCategory("apparel")}
                        data-testid="button-style-apparel"
                      >
                        Apparel
                      </Button>
                    </div>
                  </div>
                  <Select value={selectedStyle} onValueChange={setSelectedStyle}>
                    <SelectTrigger data-testid="select-style">
                      <SelectValue placeholder="Choose a style" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No Style</SelectItem>
                      {filteredStyles.map((style) => (
                        <SelectItem key={style.id} value={style.id}>
                          {style.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Design Prompt</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="prompt">Describe Your Artwork</Label>
                  <Textarea
                    id="prompt"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="A majestic golden retriever wearing a royal crown..."
                    rows={4}
                    data-testid="input-prompt"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Reference Image (optional)</Label>
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    accept="image/*"
                    className="hidden"
                  />
                  {referenceImage ? (
                    <div className="relative">
                      <img src={referenceImage} alt="Reference" className="w-full h-32 object-contain rounded-lg border" />
                      <Button
                        variant="outline"
                        size="sm"
                        className="absolute top-2 right-2"
                        onClick={() => setReferenceImage(null)}
                      >
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full"
                      data-testid="button-upload-reference"
                    >
                      <Upload className="h-4 w-4 mr-2" />
                      Upload Reference Image
                    </Button>
                  )}
                </div>

                <Button
                  onClick={handleGenerate}
                  disabled={isGenerating || !prompt || !selectedProductTypeId || !selectedSize}
                  className="w-full"
                  data-testid="button-generate"
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4 mr-2" />
                      Generate Test Design
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Preview</CardTitle>
                <CardDescription>Generated design and product mockups</CardDescription>
              </CardHeader>
              <CardContent>
                {generatedImageUrl ? (
                  <div className="space-y-4">
                    <div className="aspect-square bg-muted rounded-lg overflow-hidden">
                      <img 
                        src={generatedImageUrl} 
                        alt="Generated design" 
                        className="w-full h-full object-contain"
                        data-testid="img-generated-design"
                      />
                    </div>

                    {designerConfig?.hasPrintifyMockups && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <ZoomIn className="h-4 w-4" />
                          <Label className="text-sm">Zoom: {imageScale}%</Label>
                        </div>
                        <Slider
                          value={[imageScale]}
                          onValueChange={(v) => setImageScale(v[0])}
                          min={50}
                          max={150}
                          step={5}
                          data-testid="slider-zoom"
                        />
                      </div>
                    )}

                    {mockupLoading ? (
                      <div className="grid grid-cols-2 gap-2">
                        {[1, 2].map((i) => (
                          <Skeleton key={i} className="aspect-square rounded-lg" />
                        ))}
                      </div>
                    ) : mockupImages.length > 0 ? (
                      <div className="grid grid-cols-2 gap-2">
                        {mockupImages.map((mockup, i) => (
                          <div key={i} className="space-y-1">
                            <img 
                              src={mockup.url} 
                              alt={mockup.label}
                              className="w-full aspect-square object-contain rounded-lg border"
                            />
                            <p className="text-xs text-center text-muted-foreground">{mockup.label}</p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="aspect-square bg-muted rounded-lg flex items-center justify-center">
                    <div className="text-center text-muted-foreground">
                      <Package className="h-12 w-12 mx-auto mb-2" />
                      <p className="text-sm">Generate a design to see preview</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {generatedImageUrl && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Next Steps</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Once you're happy with how the generator works for this product type, you can publish it to your Shopify store.
                  </p>
                  <Button className="w-full" data-testid="button-send-to-store">
                    <Send className="h-4 w-4 mr-2" />
                    Send to Store
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    This will create a new product page on your Shopify store with the product info, images, and specs from Printify.
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
