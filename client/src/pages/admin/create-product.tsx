import { useState, useRef, useEffect, useMemo } from "react";
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
import { Sparkles, Upload, Loader2, ZoomIn, Send, Package, ExternalLink, Store, AlertTriangle, Check, Move } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  const [imageX, setImageX] = useState(50);
  const [imageY, setImageY] = useState(50);
  
  const [mockupImages, setMockupImages] = useState<{ url: string; label: string }[]>([]);
  const [mockupLoading, setMockupLoading] = useState(false);
  const [selectedMockupIndex, setSelectedMockupIndex] = useState<number | null>(null);
  
  // Import design state
  const [activeTab, setActiveTab] = useState<"generate" | "import">("generate");
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  
  // Shopify publishing state
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [shopDomain, setShopDomain] = useState("");
  const [isPublishing, setIsPublishing] = useState(false);
  const [selectedColorsForPublish, setSelectedColorsForPublish] = useState<Set<string>>(new Set());
  const [shopifyInstallations, setShopifyInstallations] = useState<Array<{ id: number; shopDomain: string; shopName: string }>>([]);
  const [installationsLoading, setInstallationsLoading] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);
  const customUploadInputRef = useRef<HTMLInputElement>(null);

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

  // Computed zoom values based on product type (apparel uses 135%, others use 100%)
  const isApparel = designerConfig?.designerType === "apparel";
  const defaultZoom = isApparel ? 135 : 100;
  const maxZoom = isApparel ? 135 : 200;

  // Get the selected product type object for variant filtering
  const selectedProductType = productTypes?.find(pt => pt.id === selectedProductTypeId);
  
  // Filter sizes/colors based on saved variant selections for the testing generator
  const filteredSizes = useMemo(() => {
    if (!designerConfig?.sizes) return [];
    if (!selectedProductType) return designerConfig.sizes;
    
    const savedSizeIds: string[] = typeof selectedProductType.selectedSizeIds === 'string' 
      ? JSON.parse(selectedProductType.selectedSizeIds || "[]") 
      : selectedProductType.selectedSizeIds || [];
    
    // If no saved selections, show all sizes (legacy behavior)
    if (savedSizeIds.length === 0) return designerConfig.sizes;
    
    const savedSizeSet = new Set(savedSizeIds);
    return designerConfig.sizes.filter(size => savedSizeSet.has(size.id));
  }, [designerConfig?.sizes, selectedProductType]);

  const filteredColors = useMemo(() => {
    if (!designerConfig?.frameColors) return [];
    if (!selectedProductType) return designerConfig.frameColors;
    
    const savedColorIds: string[] = typeof selectedProductType.selectedColorIds === 'string' 
      ? JSON.parse(selectedProductType.selectedColorIds || "[]") 
      : selectedProductType.selectedColorIds || [];
    
    // If no saved selections, show all colors (legacy behavior)
    if (savedColorIds.length === 0) return designerConfig.frameColors;
    
    const savedColorSet = new Set(savedColorIds);
    return designerConfig.frameColors.filter(color => savedColorSet.has(color.id));
  }, [designerConfig?.frameColors, selectedProductType]);

  // Track if we've set defaults for the current product type
  const [hasSetDefaults, setHasSetDefaults] = useState<number | null>(null);

  useEffect(() => {
    if (designerConfig) {
      // Only set defaults when product type changes (not on every re-render)
      const shouldSetDefaults = hasSetDefaults !== designerConfig.id;
      
      // Use filtered sizes based on saved variant selections
      if (filteredSizes.length > 0 && !selectedSize) {
        setSelectedSize(filteredSizes[0].id);
      }
      // Use filtered colors based on saved variant selections, or "default" for colorless products
      if (filteredColors.length > 0 && !selectedFrameColor) {
        setSelectedFrameColor(filteredColors[0].id);
      } else if (designerConfig.frameColors.length === 0) {
        setSelectedFrameColor("default");
      }
      // Set default zoom based on product type (135% for apparel, 100% for others)
      // Only set when product type changes, not on every size/color change
      if (shouldSetDefaults) {
        const newDefaultZoom = designerConfig.designerType === "apparel" ? 135 : 100;
        setImageScale(newDefaultZoom);
        setHasSetDefaults(designerConfig.id);
      }
    }
  }, [designerConfig, selectedSize, selectedFrameColor, hasSetDefaults, filteredSizes, filteredColors]);

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

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>, source: "kittl" | "upload") => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Reset the input so the same file can be selected again
    e.target.value = "";
    
    // Validate configuration is selected before importing
    if (!selectedProductTypeId || !selectedSize) {
      toast({ 
        title: "Select product first", 
        description: "Please select a product type and size before importing a design", 
        variant: "destructive" 
      });
      return;
    }
    
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

      // Request presigned upload URL
      const urlResponse = await fetch("/api/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ 
          name: file.name,
          contentType: file.type 
        }),
      });

      if (!urlResponse.ok) {
        throw new Error("Failed to get upload URL");
      }

      const { uploadURL, objectPath } = await urlResponse.json();

      // Upload the file
      const uploadResponse = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!uploadResponse.ok) {
        throw new Error("Failed to upload file");
      }

      // Validate and import the design
      const importResponse = await fetch("/api/designs/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          imageUrl: objectPath,
          name: file.name.replace(/\.[^/.]+$/, ""),
          source,
        }),
      });

      if (!importResponse.ok) {
        const error = await importResponse.json();
        throw new Error(error.error || "Failed to import design");
      }

      const importData = await importResponse.json();
      
      // Clear previous state before setting new design
      setMockupImages([]);
      setSelectedMockupIndex(null);
      
      // Reset mockup tracking refs so variant changes work properly
      lastAppliedScaleRef.current = null;
      lastAppliedSizeRef.current = null;
      lastAppliedColorRef.current = null;
      
      // Set the imported design as the generated image
      setGeneratedImageUrl(importData.imageUrl);

      toast({ 
        title: "Design imported!", 
        description: `Your ${source === "kittl" ? "Kittl" : "custom"} design is ready` 
      });

      // Generate mockups if available
      if (designerConfig?.hasPrintifyMockups && merchant?.printifyShopId) {
        await generateMockups(importData.imageUrl);
      }
    } catch (error: any) {
      setImportError(error.message);
      toast({ title: "Import failed", description: error.message, variant: "destructive" });
    } finally {
      setIsImporting(false);
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
    setSelectedMockupIndex(null);
    lastAppliedScaleRef.current = null;

    try {
      const response = await apiRequest("POST", "/api/generate", {
        prompt,
        size: selectedSize,
        frameColor: selectedFrameColor,
        stylePreset: selectedStyle,
        productTypeId: selectedProductTypeId,
        referenceImageBase64: referenceImage,
      });

      const data = await response.json();
      const imageUrl = data.design?.generatedImageUrl || data.generatedImageUrl;
      setGeneratedImageUrl(imageUrl);
      toast({ title: "Design generated!", description: "Your test design is ready" });

      // Generate mockups if available
      if (designerConfig?.hasPrintifyMockups && merchant?.printifyShopId && imageUrl) {
        await generateMockups(imageUrl);
      }
    } catch (error: any) {
      toast({ title: "Generation failed", description: error.message, variant: "destructive" });
    } finally {
      setIsGenerating(false);
    }
  };

  const generateMockups = async (imageUrl: string) => {
    if (!selectedProductTypeId || !selectedSize) return;

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
          colorId: selectedFrameColor || "default",
          scale: imageScale,
          x: imageX,
          y: imageY,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const mockups = data.mockupImages || data.mockups || [];
        if (mockups.length > 0) {
          setMockupImages(mockups.map((m: any) => ({
            url: m.url || m,
            label: m.label || "Mockup",
          })));
          // Auto-select first mockup to show artwork on product
          setSelectedMockupIndex(0);
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

  // Track last applied values to only regenerate when they actually change
  const lastAppliedScaleRef = useRef<number | null>(null);
  const lastAppliedSizeRef = useRef<string | null>(null);
  const lastAppliedColorRef = useRef<string | null>(null);
  const lastAppliedXRef = useRef<number | null>(null);
  const lastAppliedYRef = useRef<number | null>(null);
  
  // Drag state for position control
  const [isDragging, setIsDragging] = useState(false);
  const [isHoveringMockup, setIsHoveringMockup] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  
  // Regenerate mockups when zoom scale changes (debounced, queues if currently loading)
  useEffect(() => {
    // Skip if no image or no mockup support
    if (!generatedImageUrl || !designerConfig?.hasPrintifyMockups) return;
    
    // Skip if scale hasn't actually changed since last application
    if (lastAppliedScaleRef.current === imageScale) return;
    
    // Skip on initial render (mockups will be generated after design generation)
    if (lastAppliedScaleRef.current === null && mockupImages.length > 0) {
      lastAppliedScaleRef.current = imageScale;
      return;
    }
    
    // Skip if we don't have mockups yet (initial generation will handle it)
    if (mockupImages.length === 0) return;
    
    // If currently loading, wait for it to complete - effect will re-run when mockupLoading changes
    if (mockupLoading) return;
    
    const timer = setTimeout(() => {
      lastAppliedScaleRef.current = imageScale;
      generateMockups(generatedImageUrl);
    }, 500); // 500ms debounce
    
    return () => clearTimeout(timer);
  }, [imageScale, generatedImageUrl, designerConfig?.hasPrintifyMockups, mockupImages.length, mockupLoading]);
  
  // Regenerate mockups when size or color variant changes (debounced)
  useEffect(() => {
    // Skip if no image or no mockup support
    if (!generatedImageUrl || !designerConfig?.hasPrintifyMockups) return;
    
    // Skip if we don't have mockups yet (initial generation will handle it)
    if (mockupImages.length === 0) return;
    
    // Initialize refs on first run
    if (lastAppliedSizeRef.current === null) {
      lastAppliedSizeRef.current = selectedSize;
      lastAppliedColorRef.current = selectedFrameColor;
      return;
    }
    
    // Check if size or color has changed
    const sizeChanged = lastAppliedSizeRef.current !== selectedSize;
    const colorChanged = lastAppliedColorRef.current !== selectedFrameColor;
    
    if (!sizeChanged && !colorChanged) return;
    
    // If currently loading, wait for it to complete
    if (mockupLoading) return;
    
    const timer = setTimeout(() => {
      lastAppliedSizeRef.current = selectedSize;
      lastAppliedColorRef.current = selectedFrameColor;
      generateMockups(generatedImageUrl);
    }, 300); // 300ms debounce for variant changes
    
    return () => clearTimeout(timer);
  }, [selectedSize, selectedFrameColor, generatedImageUrl, designerConfig?.hasPrintifyMockups, mockupImages.length, mockupLoading]);
  
  // Regenerate mockups when position changes (after drag ends)
  useEffect(() => {
    // Skip if no image or no mockup support
    if (!generatedImageUrl || !designerConfig?.hasPrintifyMockups) return;
    
    // Skip if we don't have mockups yet (initial generation will handle it)
    if (mockupImages.length === 0) return;
    
    // Skip while dragging
    if (isDragging) return;
    
    // Initialize refs on first run
    if (lastAppliedXRef.current === null) {
      lastAppliedXRef.current = imageX;
      lastAppliedYRef.current = imageY;
      return;
    }
    
    // Check if position has changed
    const xChanged = lastAppliedXRef.current !== imageX;
    const yChanged = lastAppliedYRef.current !== imageY;
    
    if (!xChanged && !yChanged) return;
    
    // If currently loading, wait for it to complete
    if (mockupLoading) return;
    
    const timer = setTimeout(() => {
      lastAppliedXRef.current = imageX;
      lastAppliedYRef.current = imageY;
      generateMockups(generatedImageUrl);
    }, 500); // 500ms debounce for position changes
    
    return () => clearTimeout(timer);
  }, [imageX, imageY, isDragging, generatedImageUrl, designerConfig?.hasPrintifyMockups, mockupImages.length, mockupLoading]);
  
  const filteredStyles = config?.stylePresets.filter(style => 
    style.category === "all" || style.category === styleCategory
  ) || [];

  // Load saved variant selections from product type
  const [savedVariantCount, setSavedVariantCount] = useState(0);

  // Fetch Shopify installations when dialog opens
  useEffect(() => {
    const fetchInstallations = async () => {
      setInstallationsLoading(true);
      try {
        const response = await fetch("/api/shopify/installations", { credentials: "include" });
        if (response.ok) {
          const data = await response.json();
          setShopifyInstallations(data.installations || []);
          // Auto-fill if there's only one installation - use shopDomain (the canonical domain)
          if (data.installations && data.installations.length === 1) {
            // Strip .myshopify.com suffix for the input format
            const domain = data.installations[0].shopDomain || "";
            setShopDomain(domain.replace(".myshopify.com", ""));
          }
        }
      } catch (error) {
        console.error("Failed to fetch Shopify installations:", error);
      } finally {
        setInstallationsLoading(false);
      }
    };

    if (showPublishDialog) {
      fetchInstallations();
    }
  }, [showPublishDialog]);

  useEffect(() => {
    if (showPublishDialog && selectedProductType) {
      // Parse saved selections from product type
      const savedSizeIds: string[] = typeof selectedProductType.selectedSizeIds === 'string' 
        ? JSON.parse(selectedProductType.selectedSizeIds || "[]") 
        : selectedProductType.selectedSizeIds || [];
      const savedColorIds: string[] = typeof selectedProductType.selectedColorIds === 'string' 
        ? JSON.parse(selectedProductType.selectedColorIds || "[]") 
        : selectedProductType.selectedColorIds || [];
      
      // Use saved selections, only fall back to all available if nothing saved
      const totalSizes = designerConfig?.sizes.length || 0;
      const totalColors = designerConfig?.frameColors.length || 0;
      
      // Use saved size count if available, otherwise fall back to all sizes
      const sizeCount = savedSizeIds.length > 0 ? savedSizeIds.length : totalSizes;
      // Use saved color count if available, otherwise fall back to all colors (or 1 if no colors exist)
      const colorCount = savedColorIds.length > 0 ? savedColorIds.length : (totalColors > 0 ? totalColors : 1);
      
      // Calculate count: sizes × colors
      const count = sizeCount * colorCount;
      setSavedVariantCount(count);
      
      // Keep selectedColorsForPublish in sync for the API call
      if (savedColorIds.length > 0) {
        setSelectedColorsForPublish(new Set(savedColorIds));
      } else if (totalColors > 0) {
        setSelectedColorsForPublish(new Set(designerConfig?.frameColors.map(c => c.id) || []));
      }
    }
  }, [showPublishDialog, selectedProductType, designerConfig]);

  const SHOPIFY_VARIANT_LIMIT = 100;
  const variantCount = savedVariantCount;
  const isOverLimit = variantCount > SHOPIFY_VARIANT_LIMIT;

  // Publish product to Shopify
  const handlePublishToShopify = async () => {
    if (!selectedProductTypeId || !shopDomain) {
      toast({
        title: "Missing information",
        description: "Please select a product type and enter your Shopify store domain",
        variant: "destructive",
      });
      return;
    }

    // Format shop domain
    let formattedDomain = shopDomain.trim().toLowerCase();
    if (!formattedDomain.endsWith(".myshopify.com")) {
      formattedDomain = `${formattedDomain}.myshopify.com`;
    }

    // Check variant limit
    if (isOverLimit) {
      toast({
        title: "Too many variants",
        description: `Shopify allows up to ${SHOPIFY_VARIANT_LIMIT} variants. Please deselect some colors.`,
        variant: "destructive",
      });
      return;
    }

    setIsPublishing(true);
    try {
      const response = await apiRequest("POST", "/api/shopify/products", {
        productTypeId: selectedProductTypeId,
        shopDomain: formattedDomain,
        selectedColorIds: designerConfig?.frameColors.length ? Array.from(selectedColorsForPublish) : undefined,
      });

      const data = await response.json();
      
      setShowPublishDialog(false);
      toast({
        title: "Product created!",
        description: "Your product has been created as a draft in Shopify. Set your prices and publish when ready.",
      });

      // Open Shopify admin in new tab
      if (data.adminUrl) {
        window.open(data.adminUrl, "_blank");
      }
    } catch (error: any) {
      toast({
        title: "Failed to create product",
        description: error.message || "Please check your Shopify connection and try again",
        variant: "destructive",
      });
    } finally {
      setIsPublishing(false);
    }
  };

  // Drag handlers for position control on mockup
  const handleDragStart = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!mockupImages.length) return;
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      startX: imageX,
      startY: imageY,
    };
  };

  const handleDragMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging || !dragStartRef.current) return;
    
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    
    // Convert pixel movement to percentage (adjust sensitivity)
    const sensitivity = 0.25;
    const newX = Math.max(0, Math.min(100, dragStartRef.current.startX + dx * sensitivity));
    const newY = Math.max(0, Math.min(100, dragStartRef.current.startY + dy * sensitivity));
    
    setImageX(Math.round(newX));
    setImageY(Math.round(newY));
  };

  const handleDragEnd = () => {
    if (isDragging) {
      setIsDragging(false);
      dragStartRef.current = null;
    }
  };

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
                          {filteredSizes.map((size) => (
                            <SelectItem key={size.id} value={size.id}>
                              {size.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {filteredColors.length > 0 && (
                      <div className="space-y-2">
                        <Label>{designerConfig.designerType === "framed-print" ? "Frame Color" : "Color"}</Label>
                        <div className="flex flex-wrap gap-2">
                          {filteredColors.map((color) => (
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
              <CardContent className="pt-6">
                <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "generate" | "import")}>
                  <TabsList className="grid w-full grid-cols-2 mb-4">
                    <TabsTrigger value="generate" data-testid="tab-ai-generate">
                      <Sparkles className="h-4 w-4 mr-2" />
                      AI Generate
                    </TabsTrigger>
                    <TabsTrigger value="import" data-testid="tab-import-design">
                      <Upload className="h-4 w-4 mr-2" />
                      Import Design
                    </TabsTrigger>
                  </TabsList>
                  
                  <TabsContent value="generate" className="space-y-4">
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
                  </TabsContent>
                  
                  <TabsContent value="import" className="space-y-4">
                    {(!selectedProductTypeId || !selectedSize) && (
                      <div className="p-3 bg-muted rounded-lg text-sm text-muted-foreground text-center">
                        Please select a product type and size above before importing
                      </div>
                    )}
                    <Card className="border-dashed">
                      <CardContent className="pt-4 space-y-4">
                        <div className="text-center space-y-2">
                          <h4 className="font-medium">Import from Kittl</h4>
                          <p className="text-sm text-muted-foreground">
                            Design in Kittl, then export as PNG to upload here
                          </p>
                        </div>
                        
                        <a
                          href="https://www.kittl.com/editor"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-center gap-2 text-sm text-primary hover:underline"
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
                          disabled={isImporting || !selectedProductTypeId || !selectedSize}
                          className="w-full"
                          data-testid="button-import-kittl"
                        >
                          {isImporting ? (
                            <>
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              Importing...
                            </>
                          ) : (
                            <>
                              <Upload className="h-4 w-4 mr-2" />
                              Upload Kittl Design
                            </>
                          )}
                        </Button>
                      </CardContent>
                    </Card>

                    <div className="border-t pt-4">
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
                        disabled={isImporting || !selectedProductTypeId || !selectedSize}
                        className="w-full"
                        data-testid="button-import-custom"
                      >
                        <Upload className="h-4 w-4 mr-2" />
                        Upload Custom Design
                      </Button>
                    </div>
                    
                    {importError && (
                      <p className="text-sm text-destructive text-center">{importError}</p>
                    )}

                    <div className="text-xs text-muted-foreground space-y-1">
                      <p>Supported formats: PNG, JPG, WebP</p>
                      <p>Maximum file size: 10MB</p>
                      <p>For best results, export from Kittl as high-resolution PNG</p>
                    </div>
                  </TabsContent>
                </Tabs>
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
                    <div 
                      className="relative aspect-square bg-muted rounded-lg overflow-hidden select-none"
                      onMouseEnter={() => setIsHoveringMockup(true)}
                      onMouseLeave={() => { setIsHoveringMockup(false); handleDragEnd(); }}
                      onMouseDown={handleDragStart}
                      onMouseMove={handleDragMove}
                      onMouseUp={handleDragEnd}
                      style={{ cursor: mockupImages.length > 0 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
                    >
                      <img 
                        src={selectedMockupIndex !== null && mockupImages[selectedMockupIndex] ? mockupImages[selectedMockupIndex].url : generatedImageUrl} 
                        alt="Selected preview" 
                        className="w-full h-full object-contain pointer-events-none"
                        data-testid="img-generated-design"
                        draggable={false}
                      />
                      
                      {isDragging && generatedImageUrl && mockupImages.length > 0 && (
                        <div 
                          className="absolute pointer-events-none transition-none"
                          style={{
                            width: `${imageScale * 0.4}%`,
                            height: `${imageScale * 0.4}%`,
                            left: `${imageX}%`,
                            top: `${imageY}%`,
                            transform: 'translate(-50%, -50%)',
                          }}
                        >
                          <div className="w-full h-full border-2 border-primary border-dashed rounded-lg bg-primary/10 flex items-center justify-center">
                            <img 
                              src={generatedImageUrl} 
                              alt="Position preview" 
                              className="w-3/4 h-3/4 object-contain opacity-60"
                              draggable={false}
                            />
                          </div>
                        </div>
                      )}
                      
                      {mockupImages.length > 0 && isHoveringMockup && !isDragging && !mockupLoading && (
                        <div className="absolute inset-0 bg-black/20 flex items-center justify-center transition-opacity pointer-events-none">
                          <div className="bg-background/90 rounded-full p-3 shadow-lg">
                            <Move className="h-6 w-6 text-foreground" />
                          </div>
                        </div>
                      )}
                      
                      {mockupLoading && (
                        <div className="absolute inset-0 bg-background/80 flex items-center justify-center">
                          <div className="flex flex-col items-center gap-2">
                            <Loader2 className="h-8 w-8 animate-spin text-primary" />
                            <p className="text-sm text-muted-foreground">Updating mockup...</p>
                          </div>
                        </div>
                      )}
                    </div>

                    {designerConfig?.hasPrintifyMockups && (
                      <div className="space-y-3">
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <ZoomIn className="h-4 w-4" />
                            <Label className="text-sm">Zoom: {imageScale}%</Label>
                          </div>
                          <Slider
                            value={[imageScale]}
                            onValueChange={(v) => setImageScale(v[0])}
                            min={25}
                            max={maxZoom}
                            step={5}
                            data-testid="slider-zoom"
                          />
                        </div>
                        
                        {mockupImages.length > 0 && (imageX !== 50 || imageY !== 50) && (
                          <Button 
                            variant="outline" 
                            size="sm" 
                            onClick={() => { setImageX(50); setImageY(50); }}
                            className="w-full"
                            data-testid="button-reset-position"
                          >
                            Reset Position
                          </Button>
                        )}
                        
                        {mockupImages.length > 0 && (
                          <p className="text-xs text-muted-foreground text-center">
                            Drag the mockup to reposition the design
                          </p>
                        )}
                      </div>
                    )}

                    {mockupLoading ? (
                      <div className="space-y-3" data-testid="mockup-loading-container">
                        <div className="flex items-center justify-center gap-2 text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <p className="text-sm" data-testid="text-mockup-loading">Generating mockups...</p>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          {[1, 2].map((i) => (
                            <Skeleton key={i} className="aspect-square rounded-lg flex items-center justify-center" data-testid={`skeleton-mockup-${i}`}>
                              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/50" />
                            </Skeleton>
                          ))}
                        </div>
                        <p className="text-xs text-center text-muted-foreground">This may take a few seconds</p>
                      </div>
                    ) : mockupImages.length > 0 ? (
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground">Click a mockup to view it larger</p>
                        <div className="grid grid-cols-2 gap-2">
                          <div 
                            className={`space-y-1 cursor-pointer rounded-lg p-1 ${selectedMockupIndex === null ? 'ring-2 ring-primary' : 'hover-elevate'}`}
                            onClick={() => setSelectedMockupIndex(null)}
                            data-testid="mockup-thumbnail-original"
                          >
                            <img 
                              src={generatedImageUrl} 
                              alt="Original design"
                              className="w-full aspect-square object-contain rounded-lg border"
                            />
                            <p className="text-xs text-center text-muted-foreground">original</p>
                          </div>
                          {mockupImages.map((mockup, i) => (
                            <div 
                              key={i} 
                              className={`space-y-1 cursor-pointer rounded-lg p-1 ${selectedMockupIndex === i ? 'ring-2 ring-primary' : 'hover-elevate'}`}
                              onClick={() => setSelectedMockupIndex(i)}
                              data-testid={`mockup-thumbnail-${i}`}
                            >
                              <img 
                                src={mockup.url} 
                                alt={mockup.label}
                                className="w-full aspect-square object-contain rounded-lg border"
                              />
                              <p className="text-xs text-center text-muted-foreground">{mockup.label}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : designerConfig?.baseMockupImages?.front ? (
                  <div className="space-y-4">
                    <div className="aspect-square bg-muted rounded-lg overflow-hidden">
                      <img 
                        src={designerConfig.baseMockupImages.front} 
                        alt="Product preview" 
                        className="w-full h-full object-contain"
                        data-testid="img-product-placeholder"
                      />
                    </div>
                    {designerConfig.baseMockupImages.lifestyle && (
                      <div className="grid grid-cols-2 gap-2">
                        <div className="aspect-square bg-muted rounded-lg overflow-hidden">
                          <img 
                            src={designerConfig.baseMockupImages.front} 
                            alt="Front view" 
                            className="w-full h-full object-contain"
                          />
                        </div>
                        <div className="aspect-square bg-muted rounded-lg overflow-hidden">
                          <img 
                            src={designerConfig.baseMockupImages.lifestyle} 
                            alt="Lifestyle view" 
                            className="w-full h-full object-contain"
                          />
                        </div>
                      </div>
                    )}
                    <p className="text-center text-sm text-muted-foreground">Enter a prompt and generate to see your custom design</p>
                  </div>
                ) : (
                  <div className="aspect-square bg-muted rounded-lg flex items-center justify-center">
                    <div className="text-center text-muted-foreground">
                      <Package className="h-12 w-12 mx-auto mb-2" />
                      <p className="text-sm">Select a product type to see preview</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Show "Send to Store" card when a product type is selected */}
            {selectedProductTypeId && designerConfig && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Publish to Shopify</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Ready to add this product to your store? This will create a draft product with the design studio widget embedded.
                  </p>
                  <Button 
                    className="w-full" 
                    onClick={() => setShowPublishDialog(true)}
                    data-testid="button-send-to-store"
                  >
                    <Store className="h-4 w-4 mr-2" />
                    Send to Store
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Creates a draft product on Shopify with variants, mockup images, and the design studio. You'll set prices before publishing.
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      {/* Publish to Shopify Dialog */}
      <Dialog open={showPublishDialog} onOpenChange={setShowPublishDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish to Shopify</DialogTitle>
            <DialogDescription>
              Enter your Shopify store domain to create this product as a draft.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="shop-domain">Store</Label>
              {installationsLoading ? (
                <Skeleton className="h-10 w-full" />
              ) : shopifyInstallations.length > 1 ? (
                <Select 
                  value={shopDomain} 
                  onValueChange={setShopDomain}
                >
                  <SelectTrigger data-testid="select-shop-domain">
                    <SelectValue placeholder="Select your store" />
                  </SelectTrigger>
                  <SelectContent>
                    {shopifyInstallations.map((inst) => {
                      const domainSlug = (inst.shopDomain || "").replace(".myshopify.com", "");
                      return (
                        <SelectItem key={inst.id} value={domainSlug}>
                          {inst.shopDomain || `${domainSlug}.myshopify.com`}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              ) : shopifyInstallations.length === 1 ? (
                <div className="flex items-center gap-2 p-2 bg-muted rounded-md">
                  <Check className="h-4 w-4 text-green-600" />
                  <span className="text-sm font-medium">{shopifyInstallations[0].shopDomain}</span>
                </div>
              ) : (
                <div className="flex gap-2 items-center">
                  <Input
                    id="shop-domain"
                    placeholder="your-store"
                    value={shopDomain}
                    onChange={(e) => setShopDomain(e.target.value)}
                    data-testid="input-shop-domain"
                  />
                  <span className="text-sm text-muted-foreground whitespace-nowrap">.myshopify.com</span>
                </div>
              )}
              {shopifyInstallations.length === 0 && !installationsLoading && (
                <p className="text-xs text-muted-foreground">
                  No connected stores found. Enter your store name manually or{' '}
                  <a href="/shopify/install" className="underline text-primary">connect your Shopify store</a> first.
                </p>
              )}
            </div>

            {designerConfig && (
              <div className="space-y-3">
                <div className="bg-muted p-3 rounded-lg space-y-2">
                  <p className="text-sm font-medium">Product: {designerConfig.name}</p>
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      Selected variants for Shopify
                    </p>
                    <span className={`text-lg font-bold ${
                      isOverLimit 
                        ? 'text-red-600' 
                        : 'text-green-600'
                    }`}>
                      {variantCount}
                    </span>
                  </div>
                </div>

                {isOverLimit && (
                  <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-md">
                    <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
                    <div className="text-sm text-red-700 dark:text-red-300">
                      <p className="font-medium">Too many variants ({variantCount})</p>
                      <p className="text-xs mt-1">
                        Shopify allows maximum {SHOPIFY_VARIANT_LIMIT} variants per product.
                        <a href="/admin/products" className="underline ml-1">
                          Edit variants on the Products page
                        </a>
                      </p>
                    </div>
                  </div>
                )}

                {!isOverLimit && variantCount > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Need to change which sizes or colors are included?{' '}
                    <a href="/admin/products" className="underline">
                      Edit variants on the Products page
                    </a>
                  </p>
                )}
              </div>
            )}

            <div className="text-sm text-muted-foreground space-y-1">
              <p>This will:</p>
              <ul className="list-disc list-inside space-y-1 text-xs">
                <li>Create a draft product in your Shopify store</li>
                <li>Add all size and color variants</li>
                <li>Include mockup images</li>
                <li>Enable the design studio widget</li>
                <li>Leave prices at $0 for you to set</li>
              </ul>
            </div>
          </div>

          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => setShowPublishDialog(false)}
              data-testid="button-cancel-publish"
            >
              Cancel
            </Button>
            <Button 
              onClick={handlePublishToShopify} 
              disabled={isPublishing || !shopDomain.trim() || isOverLimit || variantCount === 0}
              data-testid="button-confirm-publish"
            >
              {isPublishing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  Create Product
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
