import React, { useState, useRef, useCallback, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link, useLocation } from "wouter";
import {
  ArrowLeft,
  Upload,
  X,
  Loader2,
  Sparkles,
  ShoppingCart,
  Save,
  ZoomIn,
  Move,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Eye,
  Package,
  Copy,
} from "lucide-react";
import { CreditDisplay } from "@/components/credit-display";
import type { Customer, Design, PrintSize, FrameColor, StylePreset, ProductType } from "@shared/schema";
import { getColorTier, type ColorTier } from "@shared/colorUtils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface Config {
  sizes: PrintSize[];
  frameColors: FrameColor[];
  stylePresets: StylePreset[];
  blueprintId: number;
}

interface ProductDesignerConfig {
  id: number;
  name: string;
  description?: string;
  printifyBlueprintId?: number;
  aspectRatio: string;
  printShape: string;
  printAreaWidth?: number;
  printAreaHeight?: number;
  bleedMarginPercent: number;
  designerType: string;
  hasPrintifyMockups: boolean;
  baseMockupImages?: {
    front?: string;
    lifestyle?: string;
  };
  sizes: PrintSize[];
  frameColors: FrameColor[];
  canvasConfig: {
    maxDimension: number;
    width: number;
    height: number;
    safeZoneMargin: number;
  };
  variantMap?: Record<string, { printifyVariantId: number; providerId: number }>;
}

export default function DesignPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [selectedProductTypeId, setSelectedProductTypeId] = useState<number | null>(null);
  const [prompt, setPrompt] = useState("");
  const [selectedSize, setSelectedSize] = useState<string>("");
  const [selectedFrameColor, setSelectedFrameColor] = useState<string>("");
  const [selectedStyle, setSelectedStyle] = useState<string>("none");
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [generatedDesign, setGeneratedDesign] = useState<Design | null>(null);

  const [printifyMockups, setPrintifyMockups] = useState<string[]>([]);
  const [printifyMockupImages, setPrintifyMockupImages] = useState<{ url: string; label: string }[]>([]);
  const [mockupLoading, setMockupLoading] = useState(false);
  const [selectedMockupIndex, setSelectedMockupIndex] = useState<number>(0);

  const [imageScale, setImageScale] = useState(100);
  const [imagePosition, setImagePosition] = useState({ x: 50, y: 50 });

  const [mobileSlide, setMobileSlide] = useState(0);
  const [mobileViewMode, setMobileViewMode] = useState<"front" | "lifestyle">("front");
  const [touchStart, setTouchStart] = useState<number | null>(null);

  const [tweakPrompt, setTweakPrompt] = useState("");
  const [showTweak, setShowTweak] = useState(false);
  const [isTweakMode, setIsTweakMode] = useState(false);

  const [isReuseMode, setIsReuseMode] = useState(false);
  const [reuseSourceDesign, setReuseSourceDesign] = useState<Design | null>(null);

  const loadingFromUrlRef = useRef(false);
  const lastAutoFetchKeyRef = useRef<string | null>(null);

  // Color tier mismatch modal state
  const [showColorTierModal, setShowColorTierModal] = useState(false);
  const [pendingColorChange, setPendingColorChange] = useState<{ newColor: string; newTier: ColorTier } | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const carouselRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const dragContainerRef = useRef<HTMLDivElement | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [isHoveringMockup, setIsHoveringMockup] = useState(false);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!generatedDesign?.generatedImageUrl) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      startX: imagePosition.x,
      startY: imagePosition.y,
    };
    dragContainerRef.current = e.currentTarget;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging || !dragStartRef.current || !dragContainerRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = dragContainerRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;

    // Convert pixel movement to percentage of container
    const sensitivity = 0.5;
    const newX = Math.max(0, Math.min(100, dragStartRef.current.startX + (dx / rect.width) * 100 * sensitivity));
    const newY = Math.max(0, Math.min(100, dragStartRef.current.startY + (dy / rect.height) * 100 * sensitivity));

    setImagePosition({ x: newX, y: newY });
  };

  const handleMouseUp = () => {
    if (!isDragging) return;
    setIsDragging(false);
    dragStartRef.current = null;
    dragContainerRef.current = null;
  };

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    setTouchStart(e.touches[0].clientX);
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (touchStart === null) return;
      const touchEnd = e.changedTouches[0].clientX;
      const diff = touchStart - touchEnd;
      const threshold = 50;

      if (diff > threshold && mobileSlide < 1) {
        setMobileSlide(1);
      } else if (diff < -threshold && mobileSlide > 0) {
        setMobileSlide(0);
      }
      setTouchStart(null);
    },
    [touchStart, mobileSlide]
  );

  const { data: productTypes, isLoading: productTypesLoading } = useQuery<ProductType[]>({
    queryKey: ["/api/product-types"],
  });

  const { data: designerConfig, isLoading: designerConfigLoading, error: designerConfigError } = useQuery<ProductDesignerConfig>({
    queryKey: ["/api/product-types", selectedProductTypeId, "designer"],
    queryFn: async () => {
      const res = await fetch(`/api/product-types/${selectedProductTypeId}/designer`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load product configuration");
      return res.json();
    },
    enabled: !!selectedProductTypeId,
  });

  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
  });

  const { data: customer, isLoading: customerLoading } = useQuery<Customer>({
    queryKey: ["/api/customer"],
    enabled: isAuthenticated,
  });

  const activeSizes = designerConfig?.sizes || config?.sizes || [];
  const activeFrameColors = designerConfig?.frameColors || config?.frameColors || [];

  const selectedSizeConfig = activeSizes.find((s) => s.id === selectedSize);
  const selectedFrameColorConfig = activeFrameColors.find((c) => c.id === selectedFrameColor);

  const isApparel = designerConfig?.designerType === "apparel";
  const defaultZoom = isApparel ? 135 : 100;
  const maxZoom = isApparel ? 135 : 200;

  const isVariantAvailable = useCallback(
    (sizeId: string, colorId: string): boolean => {
      if (!designerConfig?.variantMap) return true;
      const key = `${sizeId}:${colorId}`;
      return key in designerConfig.variantMap;
    },
    [designerConfig?.variantMap]
  );

  const isCurrentSelectionValid =
    !designerConfig?.variantMap || !selectedSize || !selectedFrameColor ? true : isVariantAvailable(selectedSize, selectedFrameColor);

  const handleSelectProductType = (productType: ProductType) => {
    setSelectedProductTypeId(productType.id);

    const wasInTweakMode = isTweakMode;
    const wasInReuseMode = isReuseMode;

    if (!wasInReuseMode && !wasInTweakMode) {
      setGeneratedDesign(null);
      setPrompt("");
      setShowTweak(false);
      setTweakPrompt("");
    }

    if (wasInTweakMode) setIsTweakMode(false);

    setPrintifyMockups([]);
    setPrintifyMockupImages([]);
    setSelectedMockupIndex(0);
    lastAutoFetchKeyRef.current = null;

    if (!wasInReuseMode && !wasInTweakMode) {
      setSelectedSize("");
      setSelectedFrameColor("");
      setImageScale(defaultZoom);
      setImagePosition({ x: 50, y: 50 });
    }
  };

  // Apply defaults / validate size & color when designerConfig changes
  useEffect(() => {
    if (!designerConfig) return;

    if (loadingFromUrlRef.current) {
      loadingFromUrlRef.current = false;
      return;
    }

    const sizeIsValid = selectedSize && designerConfig.sizes.some((s) => s.id === selectedSize);
    if (designerConfig.sizes.length > 0 && !sizeIsValid) {
      setSelectedSize(designerConfig.sizes[0].id);
    }

    const colorIsValid =
      selectedFrameColor &&
      (designerConfig.frameColors.length === 0
        ? selectedFrameColor === "default"
        : designerConfig.frameColors.some((c) => c.id === selectedFrameColor));

    if (designerConfig.frameColors.length > 0 && !colorIsValid) {
      setSelectedFrameColor(designerConfig.frameColors[0].id);
    } else if (designerConfig.frameColors.length === 0 && !colorIsValid) {
      setSelectedFrameColor("default");
    }

    if (!generatedDesign) {
      setImageScale(designerConfig.designerType === "apparel" ? 135 : 100);
      setImagePosition({ x: 50, y: 50 });
    }
  }, [designerConfig, selectedSize, selectedFrameColor, generatedDesign]);

  // Load tweak/reuse from URL
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);

    const tweakId = urlParams.get("tweak");
    if (tweakId && tweakId !== "true") {
      const designId = parseInt(tweakId);
      if (!isNaN(designId)) {
        fetch(`/api/designs/${designId}`, { credentials: "include" })
          .then((res) => (res.ok ? res.json() : null))
          .then((design: Design | null) => {
            if (design) {
              loadingFromUrlRef.current = true;
              setIsTweakMode(true);
              if (design.productTypeId) setSelectedProductTypeId(design.productTypeId);

              setGeneratedDesign(design);
              setPrompt(design.prompt);
              setSelectedSize(design.size);
              setSelectedFrameColor(design.frameColor);
              setSelectedStyle(design.stylePreset || "none");
              setImageScale(design.transformScale ?? 100);
              setImagePosition({ x: design.transformX ?? 50, y: design.transformY ?? 50 });
              setShowTweak(true);

              setPrintifyMockups([]);
              setPrintifyMockupImages([]);
              setSelectedMockupIndex(0);
              lastAutoFetchKeyRef.current = null;
            }
            window.history.replaceState({}, "", "/design");
          })
          .catch((e) => console.error("Failed to load design:", e));
      }
    }

    const reuseId = urlParams.get("reuse");
    if (reuseId) {
      const designId = parseInt(reuseId);
      if (!isNaN(designId)) {
        fetch(`/api/designs/${designId}`, { credentials: "include" })
          .then((res) => (res.ok ? res.json() : null))
          .then((design: Design | null) => {
            if (design) {
              setReuseSourceDesign(design);
              setIsReuseMode(true);

              setGeneratedDesign({ ...design, id: 0 });
              setPrompt(design.prompt);
              setSelectedStyle(design.stylePreset || "none");
              setImageScale(design.transformScale ?? 100);
              setImagePosition({ x: design.transformX ?? 50, y: design.transformY ?? 50 });

              setPrintifyMockups([]);
              setPrintifyMockupImages([]);
              setSelectedMockupIndex(0);
              lastAutoFetchKeyRef.current = null;
            }
            window.history.replaceState({}, "", "/design");
          })
          .catch((e) => console.error("Failed to load design for reuse:", e));
      }
    }
  }, []);

  const fetchPrintifyMockups = useCallback(
    async (
      designImageUrl: string,
      productTypeId: number,
      sizeId: string,
      colorId: string,
      scale: number = 100,
      x: number = 50,
      y: number = 50
    ) => {
      setMockupLoading(true);

      const clampedX = Math.max(0, Math.min(100, x));
      const clampedY = Math.max(0, Math.min(100, y));
      const clampedScale = Math.max(10, Math.min(200, scale));

      try {
        const response = await apiRequest("POST", "/api/mockup/generate", {
          productTypeId,
          designImageUrl,
          sizeId,
          colorId,
          scale: clampedScale,
          x: clampedX,
          y: clampedY,
        });

        const result = await response.json();

        if (result.success && Array.isArray(result.mockupUrls)) {
          setPrintifyMockups(result.mockupUrls);
          setSelectedMockupIndex(0);
        }

        if (result.success && Array.isArray(result.mockupImages)) {
          setPrintifyMockupImages(result.mockupImages);
          setSelectedMockupIndex(0);
        }
      } catch (error) {
        console.error("Failed to generate mockups:", error);
      } finally {
        setMockupLoading(false);
      }
    },
    []
  );

  // Auto-fetch mockups (reuse/tweak) once we have everything we need
  useEffect(() => {
    if (
      (isReuseMode || showTweak) &&
      generatedDesign?.generatedImageUrl &&
      designerConfig?.hasPrintifyMockups &&
      selectedSize &&
      selectedFrameColor &&
      !mockupLoading &&
      printifyMockups.length === 0
    ) {
      const fetchKey = `${designerConfig.id}-${selectedSize}-${selectedFrameColor}-${generatedDesign.generatedImageUrl}-${imageScale}-${imagePosition.x}-${imagePosition.y}`;
      if (lastAutoFetchKeyRef.current !== fetchKey) {
        lastAutoFetchKeyRef.current = fetchKey;
        const imageUrl = window.location.origin + generatedDesign.generatedImageUrl;
        fetchPrintifyMockups(imageUrl, designerConfig.id, selectedSize, selectedFrameColor, imageScale, imagePosition.x, imagePosition.y);
      }
    }
  }, [
    isReuseMode,
    showTweak,
    generatedDesign?.generatedImageUrl,
    designerConfig,
    selectedSize,
    selectedFrameColor,
    mockupLoading,
    printifyMockups.length,
    imageScale,
    imagePosition.x,
    imagePosition.y,
    fetchPrintifyMockups,
  ]);

  const generateMutation = useMutation({
    mutationFn: async (data: {
      prompt: string;
      stylePreset: string;
      size: string;
      frameColor: string;
      referenceImage?: string;
      productTypeId?: number;
      tweakOfDesignId?: number;
    }) => {
      const response = await apiRequest("POST", "/api/generate", data);
      return response.json();
    },
    onSuccess: (data) => {
      const design: Design | undefined = data?.design;
      if (!design) return;

      setGeneratedDesign(design);
      setSelectedSize(design.size);
      setSelectedFrameColor(design.frameColor);

      const currentMax = designerConfig?.designerType === "apparel" ? 135 : 200;
      const currentDefault = designerConfig?.designerType === "apparel" ? 135 : 100;

      setImageScale(Math.min(design.transformScale ?? currentDefault, currentMax));
      setImagePosition({ x: design.transformX ?? 50, y: design.transformY ?? 50 });

      queryClient.invalidateQueries({ queryKey: ["/api/customer"] });
      queryClient.invalidateQueries({ queryKey: ["/api/designs"] });

      toast({
        title: "Artwork generated!",
        description: `You have ${data.creditsRemaining ?? "some"} credits remaining.`,
      });

      // Clear mockups first, then fetch
      setPrintifyMockups([]);
      setPrintifyMockupImages([]);
      setSelectedMockupIndex(0);
      lastAutoFetchKeyRef.current = null;

      if (designerConfig?.hasPrintifyMockups) {
        const imageUrl = window.location.origin + design.generatedImageUrl;
        fetchPrintifyMockups(imageUrl, designerConfig.id, design.size, design.frameColor, currentDefault, 50, 50);
      }
    },
    onError: (error: any) => {
      toast({
        title: "Generation failed",
        description: error?.message || "Failed to generate artwork",
        variant: "destructive",
      });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (data: {
      designId: number;
      transformScale?: number;
      transformX?: number;
      transformY?: number;
      size?: string;
      frameColor?: string;
    }) => {
      const { designId, ...updateData } = data;
      const response = await apiRequest("PATCH", `/api/designs/${designId}`, updateData);
      return response.json();
    },
    onSuccess: (design: Design) => {
      setGeneratedDesign(design);
      queryClient.invalidateQueries({ queryKey: ["/api/designs"] });
    },
    onError: (error: any) => {
      toast({
        title: "Save failed",
        description: error?.message || "Failed to save design",
        variant: "destructive",
      });
    },
  });

  const reuseMutation = useMutation({
    mutationFn: async (data: {
      sourceDesignId: number;
      productTypeId: number;
      size: string;
      frameColor: string;
      transformScale: number;
      transformX: number;
      transformY: number;
    }) => {
      const response = await apiRequest("POST", "/api/designs/reuse", data);
      return response.json();
    },
    onSuccess: (data) => {
      const design: Design | undefined = data?.design;
      if (design) setGeneratedDesign(design);
      setIsReuseMode(false);
      setReuseSourceDesign(null);
      queryClient.invalidateQueries({ queryKey: ["/api/designs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer"] });
      toast({ title: "Design saved!", description: "Your reused design has been saved to your gallery." });
    },
    onError: (error: any) => {
      toast({
        title: "Save failed",
        description: error?.message || "Failed to save reused design",
        variant: "destructive",
      });
    },
  });

  const handleSaveReusedDesign = () => {
    if (!reuseSourceDesign || !selectedProductTypeId || !selectedSize || !selectedFrameColor) {
      toast({
        title: "Missing selection",
        description: "Please select a product type, size, and color before saving.",
        variant: "destructive",
      });
      return;
    }

    if (!isCurrentSelectionValid) {
      toast({
        title: "Unavailable variant",
        description: "That size/color combination is not available for this product.",
        variant: "destructive",
      });
      return;
    }

    reuseMutation.mutate({
      sourceDesignId: reuseSourceDesign.id,
      productTypeId: selectedProductTypeId,
      size: selectedSize,
      frameColor: selectedFrameColor,
      transformScale: imageScale,
      transformX: imagePosition.x,
      transformY: imagePosition.y,
    });
  };

  const handleRegenerateMockup = useCallback(() => {
    if (!generatedDesign?.generatedImageUrl || !designerConfig?.hasPrintifyMockups || !selectedProductTypeId) return;
    if (!selectedSize || !selectedFrameColor) return;

    const imageUrl = window.location.origin + generatedDesign.generatedImageUrl;
    fetchPrintifyMockups(imageUrl, selectedProductTypeId, selectedSize, selectedFrameColor, imageScale, imagePosition.x, imagePosition.y);
  }, [
    generatedDesign?.generatedImageUrl,
    designerConfig?.hasPrintifyMockups,
    selectedProductTypeId,
    selectedSize,
    selectedFrameColor,
    imageScale,
    imagePosition.x,
    imagePosition.y,
    fetchPrintifyMockups,
  ]);

  // Debounced auto-update for mockups when scale/position changes
  const transformTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastTransformRef = useRef({ scale: imageScale, x: imagePosition.x, y: imagePosition.y });

  useEffect(() => {
    if (!designerConfig?.hasPrintifyMockups) return;
    if (!generatedDesign?.generatedImageUrl) return;
    if (printifyMockups.length === 0) return;

    const transformChanged =
      lastTransformRef.current.scale !== imageScale ||
      lastTransformRef.current.x !== imagePosition.x ||
      lastTransformRef.current.y !== imagePosition.y;

    if (!transformChanged) return;

    if (transformTimeoutRef.current) clearTimeout(transformTimeoutRef.current);

    transformTimeoutRef.current = setTimeout(() => {
      handleRegenerateMockup();
      lastTransformRef.current = { scale: imageScale, x: imagePosition.x, y: imagePosition.y };
    }, 1000);

    return () => {
      if (transformTimeoutRef.current) clearTimeout(transformTimeoutRef.current);
    };
  }, [imageScale, imagePosition.x, imagePosition.y, printifyMockups.length, designerConfig?.hasPrintifyMockups, generatedDesign?.generatedImageUrl, handleRegenerateMockup]);

  // Auth gates
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Skeleton className="h-32 w-32 rounded-full" />
      </div>
    );
  }

  if (!isAuthenticated) {
    window.location.href = "/";
    return null;
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "File too large", description: "Please upload an image under 5MB", variant: "destructive" });
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => setReferenceImage(reader.result as string);
    reader.readAsDataURL(file);
  };

  const resetTransform = () => {
    setImageScale(defaultZoom);
    setImagePosition({ x: 50, y: 50 });
  };

  const centerImage = () => setImagePosition({ x: 50, y: 50 });

  const handleSizeChange = (newSize: string) => {
    setSelectedSize(newSize);
    setImageScale(defaultZoom);
    setImagePosition({ x: 50, y: 50 });
    setPrintifyMockups([]);
    setPrintifyMockupImages([]);
    setSelectedMockupIndex(0);
    lastAutoFetchKeyRef.current = null;
  };

  const handleFrameColorChange = (newColor: string) => {
    // Color-tier mismatch check for apparel + existing design colorTier
    if (generatedDesign && designerConfig?.designerType === "apparel" && (generatedDesign as any).colorTier) {
      const colorConfig = activeFrameColors.find((c) => c.id === newColor);
      if (colorConfig?.hex) {
        const newTier = getColorTier(colorConfig.hex);
        const currentTier = (generatedDesign as any).colorTier as ColorTier;
        if (newTier !== currentTier) {
          setPendingColorChange({ newColor, newTier });
          setShowColorTierModal(true);
          return;
        }
      }
    }

    setSelectedFrameColor(newColor);
    setPrintifyMockups([]);
    setPrintifyMockupImages([]);
    setSelectedMockupIndex(0);
    lastAutoFetchKeyRef.current = null;
  };

  const handleColorTierRegenerate = async () => {
    if (!generatedDesign || !pendingColorChange) return;

    const designIdToUse = isReuseMode && reuseSourceDesign ? reuseSourceDesign.id : generatedDesign.id;
    if (!designIdToUse) {
      toast({
        title: "Cannot regenerate",
        description: "Please save the design first before regenerating for a different color.",
        variant: "destructive",
      });
      return;
    }

    setIsRegenerating(true);
    try {
      const response = await apiRequest("POST", "/api/generate/regenerate-tier", {
        designId: designIdToUse,
        newColorTier: pendingColorChange.newTier,
        newFrameColor: pendingColorChange.newColor,
      });

      const result = await response.json();
      if (result.design) {
        setGeneratedDesign(result.design);
        setSelectedFrameColor(pendingColorChange.newColor);

        setPrintifyMockups([]);
        setPrintifyMockupImages([]);
        setSelectedMockupIndex(0);
        lastAutoFetchKeyRef.current = null;

        queryClient.invalidateQueries({ queryKey: ["/api/designs"] });
        queryClient.invalidateQueries({ queryKey: ["/api/customer"] });

        toast({
          title: "Design regenerated!",
          description: `Your design has been optimized for ${pendingColorChange.newTier === "dark" ? "dark" : "light"} colored apparel.`,
        });

        setShowColorTierModal(false);
        setPendingColorChange(null);
      }
    } catch (error: any) {
      console.error("Failed to regenerate design:", error);
      const errorMsg = error?.message || "";
      const isInsufficientCredits = errorMsg.startsWith("402") || errorMsg.includes("Insufficient credits");
      toast({
        title: "Regeneration failed",
        description: isInsufficientCredits
          ? "You don't have enough credits to regenerate. Please purchase more credits."
          : "Could not regenerate the design. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleColorTierKeepOriginal = () => {
    setShowColorTierModal(false);
    setPendingColorChange(null);
  };

  const handleColorTierProceedAnyway = () => {
    if (pendingColorChange) {
      setSelectedFrameColor(pendingColorChange.newColor);
      setPrintifyMockups([]);
      setPrintifyMockupImages([]);
      setSelectedMockupIndex(0);
      lastAutoFetchKeyRef.current = null;
    }
    setShowColorTierModal(false);
    setPendingColorChange(null);
  };

  const handleSaveDesign = () => {
    if (!generatedDesign) return;

    // Don’t attempt PATCH on unsaved “id:0” placeholder
    if (generatedDesign.id === 0) {
      toast({
        title: "Not saved yet",
        description: "This design is in reuse mode. Use Save to create a new design in your gallery.",
        variant: "destructive",
      });
      return;
    }

    saveMutation.mutate(
      {
        designId: generatedDesign.id,
        transformScale: imageScale,
        transformX: imagePosition.x,
        transformY: imagePosition.y,
        size: selectedSize,
        frameColor: selectedFrameColor,
      },
      {
        onSuccess: () => {
          toast({ title: "Design saved!", description: "Your artwork adjustments have been saved." });
        },
      }
    );
  };

  const handleGenerate = () => {
  if (!prompt.trim()) {
    toast({
      title: "Prompt required",
      description: "Please enter a description of your artwork",
      variant: "destructive",
    });
    return;
  }

  if (!selectedSize) {
    toast({
      title: "Size required",
      description: "Please select a size first",
      variant: "destructive",
    });
    return;
  }

  if ((customer?.credits ?? 0) <= 0) {
    toast({
      title: "No credits",
      description: "Purchase more credits to continue",
      variant: "destructive",
    });
    return;
  }

  generateMutation.mutate({
    prompt: prompt.trim(),
    stylePreset: selectedStyle,
    size: selectedSize,
    frameColor: selectedFrameColor,
    referenceImage: referenceImage || undefined,
    productTypeId: selectedProductTypeId ?? undefined,
  });
};

  const handleTweak = () => {
    if (!generatedDesign?.generatedImageUrl || !generatedDesign?.id) {
      toast({ title: "Nothing to tweak", description: "Generate an image first.", variant: "destructive" });
      return;
    }
    if (!tweakPrompt.trim()) {
      toast({ title: "Tweak prompt required", description: "Tell us what to change.", variant: "destructive" });
      return;
    }
    if (!selectedProductTypeId) return;

    // Basic tweak strategy:
    // - Append tweak instructions to prompt
    // - Send tweakOfDesignId for backend (if supported)
    generateMutation.mutate({
      prompt: `${prompt}\n\nTWEAK: ${tweakPrompt}`,
      stylePreset: selectedStyle,
      size: selectedSize,
      frameColor: selectedFrameColor,
      referenceImage: referenceImage || undefined,
      productTypeId: selectedProductTypeId,
      tweakOfDesignId: generatedDesign.id,
    });

    setTweakPrompt("");
    setShowTweak(false);
  };

  const getStyleCategory = (): "decor" | "apparel" => {
    const designerType = designerConfig?.designerType || "";
    if (designerType === "apparel" || designerType.includes("shirt") || designerType.includes("hoodie")) return "apparel";
    return "decor";
  };

  const styleCategory = getStyleCategory();
  const filteredStyles =
    config?.stylePresets.filter((style) => (style as any).category === "all" || (style as any).category === styleCategory) || [];

  const sizeSelector = (
    <div className="space-y-2">
      <Label className="text-sm font-medium">Size</Label>
      <div className="grid grid-cols-3 gap-2">
        {activeSizes.map((size) => {
          const isAvailable = !selectedFrameColor || isVariantAvailable(size.id, selectedFrameColor);
          return (
            <Button
              key={size.id}
              variant={selectedSize === size.id ? "default" : "outline"}
              className={`h-auto py-2 text-xs ${!isAvailable ? "opacity-40" : ""}`}
              onClick={() => handleSizeChange(size.id)}
              disabled={!isAvailable}
              title={
                !isAvailable ? `Not available in ${activeFrameColors.find((c) => c.id === selectedFrameColor)?.name || "selected color"}` : undefined
              }
              data-testid={`button-size-${size.id}`}
            >
              <span className="font-medium">{size.name}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );

  const frameColorSelector = (
    <div className="space-y-2">
      <Label className="text-sm font-medium">{designerConfig?.designerType === "framed_print" ? "Frame" : "Color"}</Label>
      <div className="flex flex-wrap gap-2">
        {activeFrameColors.map((color) => {
          const isAvailable = !selectedSize || isVariantAvailable(selectedSize, color.id);
          return (
            <button
              key={color.id}
              className={`w-10 h-10 rounded-md border-2 transition-all ${
                selectedFrameColor === color.id ? "border-primary ring-2 ring-primary ring-offset-2" : "border-muted"
              } ${!isAvailable ? "opacity-40 cursor-not-allowed" : ""}`}
              style={{ backgroundColor: (color as any).hex }}
              onClick={() => isAvailable && handleFrameColorChange(color.id)}
              disabled={!isAvailable}
              title={!isAvailable ? `Not available in ${activeSizes.find((s) => s.id === selectedSize)?.name || "selected size"}` : color.name}
              data-testid={`button-frame-${color.id}`}
            />
          );
        })}
      </div>
      {!isCurrentSelectionValid && selectedSize && selectedFrameColor && (
        <p className="text-xs text-destructive">This size/color combination is not available. Please select a different option.</p>
      )}
    </div>
  );

  const styleSelector = (
    <div className="space-y-2">
      <Label className="text-sm font-medium">
        Style{" "}
        <span className="text-xs text-muted-foreground ml-1">({styleCategory === "apparel" ? "Apparel Artwork" : "Decor Artwork"})</span>
      </Label>
      <Select value={selectedStyle} onValueChange={setSelectedStyle}>
        <SelectTrigger data-testid="select-style" className="h-9">
          <SelectValue placeholder="Choose a style" />
        </SelectTrigger>
        <SelectContent>
          {filteredStyles.map((style) => (
            <SelectItem key={style.id} value={style.id}>
              {style.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const promptInput = (
    <div className="space-y-2">
      <Label className="text-sm font-medium">Describe Your Artwork</Label>
      <Textarea
        id="prompt"
        placeholder="A serene mountain landscape at sunset..."
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        className="min-h-[80px] text-sm"
        data-testid="input-prompt"
      />
      <div className="flex items-center gap-2">
        {referenceImage ? (
          <div className="relative inline-block">
            <img src={referenceImage} alt="Reference" className="h-12 w-12 object-cover rounded-md" />
            <Button
              variant="destructive"
              size="icon"
              className="absolute -top-1 -right-1 h-5 w-5"
              onClick={() => setReferenceImage(null)}
              data-testid="button-remove-reference"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} data-testid="button-upload-reference">
            <Upload className="h-3 w-3 mr-1" />
            Reference Image
          </Button>
        )}
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
      </div>
    </div>
  );

  const generateButton = (
    <Button size="default" className="w-full" onClick={handleGenerate} disabled={generateMutation.isPending} data-testid="button-generate">
      {generateMutation.isPending ? (
        <>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Generating...
        </>
      ) : (
        <>
          <Sparkles className="h-4 w-4 mr-2" />
          Generate (1 Credit)
        </>
      )}
    </Button>
  );

  const reuseSaveButton =
    isReuseMode && reuseSourceDesign ? (
      <Button
        size="default"
        className="w-full"
        onClick={handleSaveReusedDesign}
        disabled={reuseMutation.isPending || !selectedProductTypeId || !selectedSize || !selectedFrameColor}
        data-testid="button-save-reuse"
      >
        {reuseMutation.isPending ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Saving...
          </>
        ) : (
          <>
            <Save className="h-4 w-4 mr-2" />
            Save as New Design
          </>
        )}
      </Button>
    ) : null;

  const reuseBanner =
    isReuseMode && reuseSourceDesign ? (
      <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-3 mb-4">
        <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
          <Copy className="h-4 w-4 shrink-0" />
          <div className="text-sm">
            <strong>Reusing artwork:</strong> Select a product, size, and color to save this design to your gallery.
          </div>
        </div>
      </div>
    ) : null;

  const zoomControls =
    generatedDesign?.generatedImageUrl ? (
      <div className="flex items-center gap-2 p-2 bg-muted/50 rounded-md">
        <ZoomIn className="h-4 w-4 text-muted-foreground shrink-0" />
        <Slider
          value={[imageScale]}
          onValueChange={([value]) => setImageScale(value)}
          min={25}
          max={maxZoom}
          step={5}
          className="flex-1"
          data-testid="slider-scale"
        />
        <span className="text-xs text-muted-foreground w-10">{imageScale}%</span>
        <Button variant="outline" size="icon" onClick={centerImage} title="Center image" data-testid="button-center">
          <Crosshair className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={resetTransform} data-testid="button-reset-transform">
          Reset
        </Button>
        {printifyMockups.length > 0 && designerConfig?.hasPrintifyMockups && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleRegenerateMockup}
            disabled={mockupLoading}
            data-testid="button-update-mockup"
          >
            {mockupLoading ? (
              <>
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                Updating...
              </>
            ) : (
              <>
                <Eye className="h-3 w-3 mr-1" />
                Update Preview
              </>
            )}
          </Button>
        )}
      </div>
    ) : null;

  const actionButtons =
    generatedDesign ? (
      <div className="flex gap-2">
        {isReuseMode ? (
          <Button
            variant="outline"
            className="flex-1"
            onClick={handleSaveReusedDesign}
            disabled={reuseMutation.isPending || !selectedProductTypeId || !selectedSize || !selectedFrameColor}
            data-testid="button-save"
          >
            <Save className="h-4 w-4 mr-2" />
            {reuseMutation.isPending ? "Saving..." : "Save"}
          </Button>
        ) : (
          <Button variant="outline" className="flex-1" onClick={handleSaveDesign} disabled={saveMutation.isPending} data-testid="button-save">
            <Save className="h-4 w-4 mr-2" />
            {saveMutation.isPending ? "Saving..." : "Save"}
          </Button>
        )}
        <Button className="flex-1" data-testid="button-order">
          <ShoppingCart className="h-4 w-4 mr-2" />
          Order Print
        </Button>
      </div>
    ) : null;

  const hasBaseMockup = !!designerConfig?.baseMockupImages?.front;
  const reuseWaitingForMockups =
    isReuseMode && !!generatedDesign?.generatedImageUrl && !!designerConfig?.hasPrintifyMockups && printifyMockups.length === 0;
  const usePrintifyMockups = !!designerConfig?.hasPrintifyMockups && (printifyMockups.length > 0 || mockupLoading || reuseWaitingForMockups);
  const showApparelBaseWithArtwork =
    !!designerConfig?.hasPrintifyMockups && hasBaseMockup && !usePrintifyMockups && !!generatedDesign?.generatedImageUrl && !isReuseMode;

  const canDragDesign = !!generatedDesign?.generatedImageUrl && (usePrintifyMockups || showApparelBaseWithArtwork || hasBaseMockup);

  // FRONT preview area
  const previewMockup = (
    <div
      className="relative bg-muted rounded-md flex items-center justify-center w-full h-full select-none"
      style={{ cursor: canDragDesign ? (isDragging ? "grabbing" : "grab") : "default" }}
      onMouseEnter={() => setIsHoveringMockup(true)}
      onMouseLeave={() => {
        setIsHoveringMockup(false);
        handleMouseUp();
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {usePrintifyMockups ? (
        <div className="w-full h-full flex items-center justify-center" style={{ pointerEvents: "none" }}>
          {generateMutation.isPending ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" />
              <span className="text-xs">Creating artwork...</span>
            </div>
          ) : mockupLoading || reuseWaitingForMockups ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" />
              <span className="text-xs">Generating product preview...</span>
            </div>
          ) : printifyMockups.length > 0 ? (
            <div className="relative w-full h-full">
              <img src={printifyMockups[0]} alt="Product mockup" className="w-full h-full object-contain rounded-md" data-testid="img-printify-mockup" />
            </div>
          ) : (
            <div className="text-center text-muted-foreground p-4">
              <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-xs">Your artwork will appear here</p>
            </div>
          )}
        </div>
      ) : showApparelBaseWithArtwork ? (
        <div className="absolute inset-0 flex items-center justify-center" style={{ pointerEvents: "none" }}>
          <div className="relative w-full h-full">
            <img src={designerConfig!.baseMockupImages!.front!} alt="Product preview" className="w-full h-full object-contain rounded-md" data-testid="img-base-mockup" />
            <div
              className={`absolute overflow-hidden ${
                designerConfig?.designerType === "pillow" && designerConfig?.printShape === "circle" ? "rounded-full" : ""
              }`}
              style={
                designerConfig?.designerType === "pillow"
                  ? { top: "10%", left: "10%", width: "80%", height: "80%" }
                  : { top: "25%", left: "30%", width: "40%", height: "40%" }
              }
            >
              <img
                src={generatedDesign!.generatedImageUrl!}
                alt="Generated artwork"
                className="w-full h-full object-cover"
                style={{
                  transform: `scale(${imageScale / 100}) translate(${imagePosition.x - 50}%, ${imagePosition.y - 50}%)`,
                  borderRadius: designerConfig?.designerType === "pillow" && designerConfig?.printShape === "circle" ? "50%" : undefined,
                }}
                draggable={false}
                data-testid="img-generated"
              />
            </div>
          </div>
        </div>
      ) : hasBaseMockup ? (
        <div className="absolute inset-0 flex items-center justify-center" style={{ pointerEvents: "none" }}>
          {generateMutation.isPending ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" />
              <span className="text-xs">Creating...</span>
            </div>
          ) : (
            <div className="relative w-full h-full">
              <img src={designerConfig!.baseMockupImages!.front!} alt="Product preview" className="w-full h-full object-contain rounded-md" data-testid="img-base-mockup" />
              {generatedDesign?.generatedImageUrl && (
                <div
                  className={`absolute overflow-hidden ${
                    designerConfig?.designerType === "pillow" && designerConfig?.printShape === "circle" ? "rounded-full" : ""
                  }`}
                  style={
                    designerConfig?.designerType === "pillow"
                      ? { top: "10%", left: "10%", width: "80%", height: "80%", pointerEvents: "auto" }
                      : { top: "25%", left: "30%", width: "40%", height: "40%", pointerEvents: "auto" }
                  }
                >
                  <img
                    src={generatedDesign.generatedImageUrl}
                    alt="Generated artwork"
                    className="w-full h-full object-cover"
                    style={{
                      transform: `scale(${imageScale / 100}) translate(${imagePosition.x - 50}%, ${imagePosition.y - 50}%)`,
                      borderRadius: designerConfig?.designerType === "pillow" && designerConfig?.printShape === "circle" ? "50%" : undefined,
                    }}
                    draggable={false}
                    data-testid="img-generated"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="w-full h-full flex items-center justify-center" style={{ pointerEvents: "none" }}>
          {generateMutation.isPending ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" />
              <span className="text-xs">Creating artwork...</span>
            </div>
          ) : mockupLoading ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" />
              <span className="text-xs">Generating product preview...</span>
            </div>
          ) : generatedDesign?.generatedImageUrl ? (
            <img src={generatedDesign.generatedImageUrl} alt="Generated artwork" className="w-full h-full object-contain rounded-md" data-testid="img-generated" />
          ) : (
            <div className="text-center text-muted-foreground p-4">
              <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-xs">Your artwork will appear here</p>
            </div>
          )}
        </div>
      )}

      {/* Ghost overlay while dragging */}
      {isDragging && generatedDesign?.generatedImageUrl && canDragDesign && (
        <div
          className="absolute pointer-events-none z-10"
          style={{
            width: `${imageScale * 0.35}%`,
            height: `${imageScale * 0.35}%`,
            left: `${imagePosition.x}%`,
            top: `${imagePosition.y}%`,
            transform: "translate(-50%, -50%)",
          }}
        >
          <div className="w-full h-full border-2 border-primary border-dashed rounded-lg bg-primary/10 flex items-center justify-center">
            <img src={generatedDesign.generatedImageUrl} alt="Position preview" className="w-3/4 h-3/4 object-contain opacity-60" draggable={false} />
          </div>
        </div>
      )}

      {/* Hover indicator */}
      {canDragDesign && isHoveringMockup && !isDragging && !generateMutation.isPending && !mockupLoading && (
        <div className="absolute inset-0 bg-black/20 flex items-center justify-center transition-opacity pointer-events-none z-10 rounded-md">
          <div className="bg-background/90 rounded-full p-3 shadow-lg">
            <Move className="h-6 w-6 text-foreground" />
          </div>
        </div>
      )}
    </div>
  );

  const tweakLink = generatedDesign?.generatedImageUrl && !showTweak && (
    <button
      onClick={() => setShowTweak(true)}
      className="text-sm text-muted-foreground hover:text-foreground underline"
      data-testid="link-tweak"
    >
      Tweak This Image
    </button>
  );

  const tweakPanel = showTweak && generatedDesign?.generatedImageUrl && (
    <div className="space-y-2 p-2 bg-muted/50 rounded-md">
      <Textarea
        placeholder="e.g., Remove the text, change the sky to night, add more clouds..."
        value={tweakPrompt}
        onChange={(e) => setTweakPrompt(e.target.value)}
        className="min-h-[60px] text-sm"
        data-testid="input-tweak"
      />
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" onClick={handleTweak} disabled={generateMutation.isPending} data-testid="button-tweak">
          {generateMutation.isPending ? "Tweaking..." : "Apply Tweak (1 Credit)"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => { setShowTweak(false); setTweakPrompt(""); }} data-testid="button-cancel-tweak">
          Cancel
        </Button>
      </div>
    </div>
  );

  const productTypeSelector = (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold mb-2">Choose a Product</h2>
          <p className="text-muted-foreground">Select which product you would like to design</p>
        </div>

        {productTypesLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="overflow-hidden">
                <CardContent className="p-4">
                  <Skeleton className="h-32 w-full mb-3" />
                  <Skeleton className="h-5 w-3/4 mb-2" />
                  <Skeleton className="h-4 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : productTypes && productTypes.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {productTypes.map((productType) => (
              <Card
                key={productType.id}
                className="overflow-hidden hover-elevate cursor-pointer transition-all"
                onClick={() => handleSelectProductType(productType)}
                data-testid={`card-product-type-${productType.id}`}
              >
                <CardContent className="p-4">
                  <div className="h-32 bg-muted rounded-md flex items-center justify-center mb-3">
                    <Package className="h-12 w-12 text-muted-foreground" />
                  </div>
                  <CardTitle className="text-lg mb-1">{productType.name}</CardTitle>
                  <CardDescription className="text-sm line-clamp-2">
                    {productType.description
                      ? productType.description
                          .replace(/<[^>]*>/g, "")
                          .replace(/&lt;/g, "<")
                          .replace(/&gt;/g, ">")
                          .replace(/&amp;/g, "&")
                          .replace(/&quot;/g, '"')
                          .replace(/<[^>]*>/g, "")
                          .replace(/\s+/g, " ")
                          .trim()
                      : "Custom AI artwork design"}
                  </CardDescription>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="text-center py-12">
            <Package className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No Products Available</h3>
            <p className="text-muted-foreground mb-4">Products need to be imported from Printify in the Admin panel.</p>
            <Link href="/admin">
              <Button data-testid="button-go-to-admin">Go to Admin Panel</Button>
            </Link>
          </div>
        )}
      </div>
    </div>
  );

  const selectedProductTypeName = productTypes?.find((p) => p.id === selectedProductTypeId)?.name;

  if (!selectedProductTypeId) {
    return (
      <div className="h-screen flex flex-col bg-background overflow-hidden">
        <header className="border-b bg-background z-50 shrink-0">
          <div className="container mx-auto px-3 py-2 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Link href="/">
                <Button variant="ghost" size="icon" data-testid="button-back">
                  <ArrowLeft className="h-5 w-5" />
                </Button>
              </Link>
              <h1 className="text-base font-semibold">Create Design</h1>
            </div>
            <div className="flex items-center gap-4">
              <CreditDisplay customer={customer} isLoading={customerLoading} />
            </div>
          </div>
        </header>
        {productTypeSelector}
      </div>
    );
  }

  if (designerConfigLoading) {
    return (
      <div className="h-screen flex flex-col bg-background overflow-hidden">
        <header className="border-b bg-background z-50 shrink-0">
          <div className="container mx-auto px-3 py-2 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => setSelectedProductTypeId(null)} data-testid="button-back-to-products">
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <h1 className="text-base font-semibold">{selectedProductTypeName || "Loading..."}</h1>
            </div>
          </div>
        </header>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

 return (
    <div className="h-screen flex items-center justify-center bg-background">
      <p className="text-muted-foreground">
        Design page loaded
      </p>
    </div>
  );
}