import { useState, useRef, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Sparkles, ImagePlus, RefreshCw, X, Info } from "lucide-react";
import { StyleSelector } from "./StyleSelector";
import { useDesignerState } from "./useDesignerState";
import type {
  ProductDesignerConfig,
  StylePreset,
  ImageTransform,
  PrintShape,
  DesignerType,
  CanvasConfig,
  FrameColor,
  PrintSize,
} from "./types";

export interface ProductAdapter {
  renderControls: (props: ControlsProps) => JSX.Element;
  renderMockup: (props: MockupProps) => JSX.Element;
  getDefaultTransform: () => ImageTransform;
}

export interface ControlsProps {
  selectedSize: string;
  setSelectedSize: (size: string) => void;
  selectedVariant: string;
  setSelectedVariant: (variant: string) => void;
  sizes: PrintSize[];
  variants: FrameColor[];
}

export interface MockupProps {
  imageUrl: string | null;
  transform: ImageTransform;
  setTransform: (transform: ImageTransform) => void;
  printShape: PrintShape;
  canvasConfig: CanvasConfig;
  selectedSize: string;
  selectedVariant: string;
  variants: FrameColor[];
  designerType: DesignerType;
  showSafeZone: boolean;
}

interface BaseDesignerProps {
  productTypeId: string;
  adapter: ProductAdapter;
  shop?: string;
  sessionToken?: string | null;
  onGenerate?: (design: { id: string; imageUrl: string; prompt: string }) => void;
  onError?: (error: string) => void;
  showStylePresets?: boolean;
}

export function BaseDesigner({
  productTypeId,
  adapter,
  shop,
  sessionToken,
  onGenerate,
  onError,
  showStylePresets = true,
}: BaseDesignerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: designerConfig, isLoading: configLoading } = useQuery<ProductDesignerConfig>({
    queryKey: ["/api/product-types", productTypeId, "designer"],
    enabled: !!productTypeId,
  });

  const { data: stylePresetsData } = useQuery<{ stylePresets: StylePreset[] }>({
    queryKey: ["/api/config"],
  });

  const allStylePresets = stylePresetsData?.stylePresets || [];
  
  // Filter styles based on designerType
  // - framed-print, pillow, mug -> "decor" category (full-bleed artwork)
  // - apparel -> "apparel" category (centered graphics)
  // - generic -> show all styles
  // During initial load (no designerConfig yet), return empty to prevent briefly showing wrong styles
  const stylePresets = useMemo(() => {
    if (!designerConfig) return [];
    
    const designerType = designerConfig.designerType;
    let targetCategory: "decor" | "apparel" | null = null;
    
    if (designerType === "apparel") {
      targetCategory = "apparel";
    } else if (designerType === "framed-print" || designerType === "pillow" || designerType === "mug") {
      targetCategory = "decor";
    }
    
    if (!targetCategory) return allStylePresets;
    
    // Return styles that match the category or are "all" (universal styles)
    return allStylePresets.filter(s => 
      s.category === targetCategory || s.category === "all" || !s.category
    );
  }, [allStylePresets, designerConfig]);

  const state = useDesignerState(designerConfig || null);
  const {
    state: designerState,
    setPrompt,
    setSelectedPreset,
    setSelectedSize,
    setSelectedFrameColor,
    setTransform,
    setIsGenerating,
    handleReferenceChange,
    handleGenerationSuccess,
  } = state;

  const [showSafeZone, setShowSafeZone] = useState(false);

  const generateMutation = useMutation({
    mutationFn: async (payload: {
      prompt: string;
      size: string;
      frameColor?: string;
      stylePreset?: string;
      referenceImage?: string | null;
      shop?: string;
      sessionToken?: string;
      productTypeId?: string;
    }) => {
      const endpoint = shop ? "/api/shopify/generate" : "/api/generate";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to generate design");
      }
      return data;
    },
    onSuccess: (data) => {
      handleGenerationSuccess(data.imageUrl, data.id);
      if (onGenerate) {
        onGenerate({ id: data.id, imageUrl: data.imageUrl, prompt: designerState.prompt });
      }
    },
    onError: (error: Error) => {
      setIsGenerating(false);
      if (onError) {
        onError(error.message);
      }
    },
  });

  const handleGenerate = async () => {
    if (!designerState.prompt.trim()) return;

    const stylePreset = stylePresets.find(s => s.id === designerState.selectedPreset);
    let fullPrompt = designerState.prompt;
    if (stylePreset && stylePreset.promptSuffix) {
      fullPrompt = `${designerState.prompt} ${stylePreset.promptSuffix}`;
    }

    let referenceImageBase64: string | null = null;
    if (designerState.referenceImage) {
      referenceImageBase64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(designerState.referenceImage!);
      });
    }

    setIsGenerating(true);
    generateMutation.mutate({
      prompt: fullPrompt,
      size: designerState.selectedSize || "medium",
      frameColor: designerState.selectedFrameColor,
      stylePreset: designerState.selectedPreset !== "none" ? designerState.selectedPreset : undefined,
      referenceImage: referenceImageBase64,
      shop,
      sessionToken: sessionToken || undefined,
      productTypeId,
    });
  };

  const handleReferenceUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    handleReferenceChange(file || null);
  };

  const clearReferenceImage = () => {
    handleReferenceChange(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  if (configLoading) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!designerConfig) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        Failed to load designer configuration
      </div>
    );
  }

  const canvasConfig = designerConfig.canvasConfig;
  const printShape = designerConfig.printShape;

  return (
    <div className="flex flex-col lg:flex-row gap-6 p-4">
      <div className="flex-1 flex flex-col gap-4">
        <div className="space-y-2">
          <Label htmlFor="prompt" className="text-sm font-medium">
            Describe your design
          </Label>
          <Textarea
            id="prompt"
            data-testid="input-prompt"
            value={designerState.prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="A serene mountain landscape at sunset with vibrant orange and purple colors..."
            className="min-h-24 resize-none"
          />
        </div>

        {showStylePresets && stylePresets.length > 0 && (
          <StyleSelector
            stylePresets={stylePresets}
            selectedStyle={designerState.selectedPreset}
            onStyleChange={setSelectedPreset}
          />
        )}

        <div className="space-y-2">
          <Label className="text-sm font-medium">Reference Image (Optional)</Label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleReferenceUpload}
            className="hidden"
          />
          {designerState.referencePreview ? (
            <div className="relative inline-block">
              <img
                src={designerState.referencePreview}
                alt="Reference"
                className="h-20 w-20 object-cover rounded-md border"
              />
              <Button
                size="icon"
                variant="destructive"
                className="absolute -top-2 -right-2 h-6 w-6"
                onClick={clearReferenceImage}
                data-testid="button-clear-reference"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              className="gap-2"
              data-testid="button-upload-reference"
            >
              <ImagePlus className="h-4 w-4" />
              Upload Reference
            </Button>
          )}
        </div>

        {adapter.renderControls({
          selectedSize: designerState.selectedSize,
          setSelectedSize,
          selectedVariant: designerState.selectedFrameColor,
          setSelectedVariant: setSelectedFrameColor,
          sizes: designerConfig.sizes,
          variants: designerConfig.frameColors,
        })}

        <div className="flex gap-2 flex-wrap">
          <Button
            onClick={handleGenerate}
            disabled={!designerState.prompt.trim() || designerState.isGenerating}
            className="flex-1 gap-2"
            data-testid="button-generate"
          >
            {designerState.isGenerating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Generate Design
              </>
            )}
          </Button>

          {designerState.generatedImageUrl && (
            <Button
              variant="outline"
              onClick={handleGenerate}
              disabled={designerState.isGenerating}
              data-testid="button-regenerate"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          )}
        </div>

        {printShape === "circle" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Info className="h-3 w-3" />
            <span>Circular product - corners will be cropped</span>
          </div>
        )}
      </div>

      <div className="flex-1 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-sm font-medium">Preview</Label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowSafeZone(!showSafeZone)}
            className={showSafeZone ? "text-primary" : "text-muted-foreground"}
            data-testid="button-toggle-safezone"
          >
            {showSafeZone ? "Hide" : "Show"} Safe Zone
          </Button>
        </div>

        <Card className="overflow-hidden">
          <CardContent className="p-0 flex items-center justify-center bg-muted min-h-64">
            {designerState.isGenerating ? (
              <div className="flex flex-col items-center gap-2 p-8">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">Creating your design...</span>
              </div>
            ) : (
              adapter.renderMockup({
                imageUrl: designerState.generatedImageUrl,
                transform: designerState.transform,
                setTransform,
                printShape,
                canvasConfig,
                selectedSize: designerState.selectedSize,
                selectedVariant: designerState.selectedFrameColor,
                variants: designerConfig.frameColors,
                designerType: designerConfig.designerType,
                showSafeZone,
              })
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

