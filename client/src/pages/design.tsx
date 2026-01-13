import { useState, useRef, useCallback, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link, useLocation } from "wouter";
import { ArrowLeft, Upload, X, Loader2, Sparkles, ShoppingCart, Save, ZoomIn, Move, ChevronLeft, ChevronRight, Crosshair, Eye, Package, Copy } from "lucide-react";
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

import lifestyle11x14blk from "@assets/11x14blk_1767584656742.png";
import lifestyle11x14wht from "@assets/11x14wht_1767584656741.png";
import lifestyle12x16blk from "@assets/12x16blk_1767584656742.png";
import lifestyle12x16wht from "@assets/12x16wht_1767584656741.png";
import lifestyle16x16blk from "@assets/16x16blk_1767584656744.png";
import lifestyle16x16wht from "@assets/16x16wht_1767584656740.png";
import lifestyle16x20blk from "@assets/16x20blk_1767584656743.png";
import lifestyle16x20wht from "@assets/16x20wht_1767584656740.png";
import lifestyle20x30blk from "@assets/20x30blk_1767584656743.png";
import lifestyle20x30wht from "@assets/20x30wht_1767584656740.png";

const lifestyleMockups: Record<string, Record<string, { src: string; frameArea: { top: number; left: number; width: number; height: number } }>> = {
  "11x14": {
    black: { src: lifestyle11x14blk, frameArea: { top: 18.6, left: 46.0, width: 30.7, height: 39.0 } },
    white: { src: lifestyle11x14wht, frameArea: { top: 18.6, left: 46.0, width: 30.7, height: 39.0 } },
  },
  "12x16": {
    black: { src: lifestyle12x16blk, frameArea: { top: 15.6, left: 45.1, width: 33.3, height: 44.4 } },
    white: { src: lifestyle12x16wht, frameArea: { top: 15.6, left: 45.1, width: 33.3, height: 44.4 } },
  },
  "16x16": {
    black: { src: lifestyle16x16blk, frameArea: { top: 14.3, left: 39.8, width: 44.2, height: 44.2 } },
    white: { src: lifestyle16x16wht, frameArea: { top: 14.3, left: 39.8, width: 44.2, height: 44.2 } },
  },
  "16x20": {
    black: { src: lifestyle16x20blk, frameArea: { top: 23.9, left: 39.5, width: 24.8, height: 31.0 } },
    white: { src: lifestyle16x20wht, frameArea: { top: 23.9, left: 39.5, width: 24.8, height: 31.0 } },
  },
  "20x30": {
    black: { src: lifestyle20x30blk, frameArea: { top: 15.8, left: 37.2, width: 31.4, height: 47.1 } },
    white: { src: lifestyle20x30wht, frameArea: { top: 15.8, left: 37.2, width: 31.4, height: 47.1 } },
  },
};

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
  const [selectedFrameColor, setSelectedFrameColor] = useState<string>("black");
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
  
  // Calibration mode for positioning lifestyle mockup artwork
  const [calibrationMode, setCalibrationMode] = useState(false);
  const [calibrationArea, setCalibrationArea] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const calibrationRef = useRef<HTMLDivElement>(null);
  const mockupImgRef = useRef<HTMLImageElement>(null);
  const isCalibrationDragging = useRef(false);
  const calibrationDragStart = useRef({ x: 0, y: 0, top: 0, left: 0 });
  const isCalibrationResizing = useRef(false);
  const calibrationResizeStart = useRef({ x: 0, y: 0, width: 0, height: 0 });
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const carouselRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const dragContainerRef = useRef<HTMLDivElement | null>(null);
  
  // Drag state for visual feedback (ghost overlay and cursor)
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
    // Constrain to 0-100 range to match Printify API expectations
    const sensitivity = 0.5;
    const newX = Math.max(0, Math.min(100, dragStartRef.current.startX + (dx / rect.width) * 100 * sensitivity));
    const newY = Math.max(0, Math.min(100, dragStartRef.current.startY + (dy / rect.height) * 100 * sensitivity));
    
    setImagePosition({ x: newX, y: newY });
  };

  const handleMouseUp = () => {
    if (isDragging) {
      setIsDragging(false);
      dragStartRef.current = null;
      dragContainerRef.current = null;
    }
  };

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    setTouchStart(e.touches[0].clientX);
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
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
  }, [touchStart, mobileSlide]);

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

  // Computed zoom values based on product type
  const isApparel = designerConfig?.designerType === "apparel";
  const defaultZoom = isApparel ? 135 : 100;
  const maxZoom = isApparel ? 135 : 200;

  const handleSelectProductType = (productType: ProductType) => {
    setSelectedProductTypeId(productType.id);
    // In reuse or tweak mode, preserve the design - we're applying same artwork to different product
    if (!isReuseMode && !isTweakMode) {
      setGeneratedDesign(null);
      setPrompt("");
      // Reset tweak state when switching products without a design
      setShowTweak(false);
      setTweakPrompt("");
    }
    // Clear tweak mode after first product selection (design is now associated with this product)
    if (isTweakMode) {
      setIsTweakMode(false);
    }
    setPrintifyMockups([]);
    setPrintifyMockupImages([]);
    lastAutoFetchKeyRef.current = null;
    setSelectedSize("");
    setSelectedFrameColor("");
    setImageScale(100); // Will be updated by useEffect when designerConfig loads
    setImagePosition({ x: 50, y: 50 });
  };

  useEffect(() => {
    if (designerConfig) {
      // Skip setting defaults if we're loading from URL (tweak/reuse)
      // The URL load effect will set the proper values
      if (loadingFromUrlRef.current) {
        loadingFromUrlRef.current = false;
        return;
      }
      if (designerConfig.sizes.length > 0 && !selectedSize) {
        setSelectedSize(designerConfig.sizes[0].id);
      }
      if (designerConfig.frameColors.length > 0 && !selectedFrameColor) {
        setSelectedFrameColor(designerConfig.frameColors[0].id);
      } else if (designerConfig.frameColors.length === 0 && !selectedFrameColor) {
        // For products with no colors (phone cases, pillows), use "default" to match variantMap
        setSelectedFrameColor("default");
      }
      // Only set default zoom when no design is loaded (fresh start)
      // Don't overwrite saved/user-adjusted transformScale
      if (!generatedDesign) {
        const newDefaultZoom = designerConfig.designerType === "apparel" ? 135 : 100;
        setImageScale(newDefaultZoom);
      }
    }
  }, [designerConfig, selectedSize, selectedFrameColor, generatedDesign]);

  // Load design from URL when coming from "Tweak" button in gallery
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const tweakId = urlParams.get("tweak");
    if (tweakId && tweakId !== "true") {
      const designId = parseInt(tweakId);
      if (!isNaN(designId)) {
        fetch(`/api/designs/${designId}`, { credentials: "include" })
          .then(res => res.ok ? res.json() : null)
          .then((design: Design | null) => {
            if (design) {
              // Mark that we're loading from URL to prevent default values from overwriting
              loadingFromUrlRef.current = true;
              // Set tweak mode to preserve design when user selects a product
              setIsTweakMode(true);
              // Set product type first so designer config loads
              if (design.productTypeId) {
                setSelectedProductTypeId(design.productTypeId);
              }
              setGeneratedDesign(design);
              setPrompt(design.prompt);
              setSelectedSize(design.size);
              setSelectedFrameColor(design.frameColor);
              setSelectedStyle(design.stylePreset || "none");
              setImageScale(design.transformScale ?? 100);
              setImagePosition({ x: design.transformX ?? 50, y: design.transformY ?? 50 });
              setShowTweak(true);
              // Clear any stale mockups so auto-fetch can generate new ones
              setPrintifyMockups([]);
              setPrintifyMockupImages([]);
              lastAutoFetchKeyRef.current = null;
            }
            // Clean up URL
            window.history.replaceState({}, "", "/design");
          })
          .catch(e => console.error("Failed to load design:", e));
      }
    }
    
    // Handle reuse query param - load artwork for applying to different product/size
    const reuseId = urlParams.get("reuse");
    if (reuseId) {
      const designId = parseInt(reuseId);
      if (!isNaN(designId)) {
        fetch(`/api/designs/${designId}`, { credentials: "include" })
          .then(res => res.ok ? res.json() : null)
          .then((design: Design | null) => {
            if (design) {
              setReuseSourceDesign(design);
              setIsReuseMode(true);
              // Set the artwork as the current design for preview
              // but keep prompt editable for the new design
              setGeneratedDesign({
                ...design,
                id: 0, // Mark as unsaved new design
              });
              setPrompt(design.prompt);
              // Don't set product type - let user choose a new one
              // Don't set size/color - let them choose
              setImageScale(design.transformScale ?? 100);
              setImagePosition({ x: design.transformX ?? 50, y: design.transformY ?? 50 });
              // Clear any stale mockups so auto-fetch can generate new ones when user selects product/size
              setPrintifyMockups([]);
              setPrintifyMockupImages([]);
              lastAutoFetchKeyRef.current = null;
            }
            // Clean up URL
            window.history.replaceState({}, "", "/design");
          })
          .catch(e => console.error("Failed to load design for reuse:", e));
      }
    }
  }, []);

  const fetchPrintifyMockups = useCallback(async (designImageUrl: string, productTypeId: number, sizeId: string, colorId: string, scale: number = 100, x: number = 50, y: number = 50) => {
    setMockupLoading(true);
    // Clamp x/y to 0-100 range expected by backend conversion
    // Our drag allows -50 to 150 but Printify expects centered positioning
    const clampedX = Math.max(0, Math.min(100, x));
    const clampedY = Math.max(0, Math.min(100, y));
    // Clamp scale to reasonable Printify range (10-200%)
    const clampedScale = Math.max(10, Math.min(200, scale));
    // Don't clear existing mockups - preserve them while loading new ones
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
      if (result.success && result.mockupUrls?.length > 0) {
        setPrintifyMockups(result.mockupUrls);
        setSelectedMockupIndex(0); // Auto-select first mockup
      }
      if (result.success && result.mockupImages?.length > 0) {
        setPrintifyMockupImages(result.mockupImages);
        setSelectedMockupIndex(0); // Auto-select first mockup
      }
    } catch (error) {
      console.error("Failed to generate mockups:", error);
    } finally {
      setMockupLoading(false);
    }
  }, []);

  // Auto-fetch Printify mockups in reuse/tweak mode when design, product, and selection are ready
  useEffect(() => {
    if (
      (isReuseMode || showTweak) &&
      generatedDesign?.generatedImageUrl &&
      designerConfig &&
      designerConfig.designerType !== "framed-print" &&
      designerConfig.designerType !== "framed_print" &&
      designerConfig.hasPrintifyMockups &&
      selectedSize &&
      selectedFrameColor &&
      !mockupLoading &&
      printifyMockups.length === 0
    ) {
      // Create a unique key for this combination to prevent redundant fetches
      // Include position in key since we now pass it to Printify
      const fetchKey = `${designerConfig.id}-${selectedSize}-${selectedFrameColor}-${generatedDesign.generatedImageUrl}-${imageScale}-${imagePosition.x}-${imagePosition.y}`;
      // Only fetch if we haven't already fetched for this exact combination
      if (lastAutoFetchKeyRef.current !== fetchKey) {
        lastAutoFetchKeyRef.current = fetchKey;
        const imageUrl = window.location.origin + generatedDesign.generatedImageUrl;
        fetchPrintifyMockups(imageUrl, designerConfig.id, selectedSize, selectedFrameColor, imageScale, imagePosition.x, imagePosition.y);
      }
    }
  }, [isReuseMode, showTweak, generatedDesign?.generatedImageUrl, designerConfig, selectedSize, selectedFrameColor, mockupLoading, printifyMockups.length, imageScale, imagePosition.x, imagePosition.y, fetchPrintifyMockups]);

  const generateMutation = useMutation({
    mutationFn: async (data: { prompt: string; stylePreset: string; size: string; frameColor: string; referenceImage?: string; productTypeId?: number }) => {
      const response = await apiRequest("POST", "/api/generate", data);
      return response.json();
    },
    onSuccess: (data) => {
      const design = data.design;
      setGeneratedDesign(design);
      setSelectedSize(design.size);
      setSelectedFrameColor(design.frameColor);
      // Use conditional max based on product type
      const currentMax = designerConfig?.designerType === "apparel" ? 135 : 200;
      const currentDefault = designerConfig?.designerType === "apparel" ? 135 : 100;
      setImageScale(Math.min(design.transformScale ?? currentDefault, currentMax));
      setImagePosition({ x: design.transformX ?? 50, y: design.transformY ?? 50 });
      queryClient.invalidateQueries({ queryKey: ["/api/customer"] });
      queryClient.invalidateQueries({ queryKey: ["/api/designs"] });
      toast({
        title: "Artwork generated!",
        description: `You have ${data.creditsRemaining} credits remaining.`,
      });
      
      if (designerConfig && designerConfig.designerType !== "framed-print" && designerConfig.hasPrintifyMockups) {
        const imageUrl = window.location.origin + design.generatedImageUrl;
        fetchPrintifyMockups(imageUrl, designerConfig.id, design.size, design.frameColor, currentDefault, 50, 50);
      }
    },
    onError: (error: any) => {
      toast({
        title: "Generation failed",
        description: error.message || "Failed to generate artwork",
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
    onSuccess: (design) => {
      setGeneratedDesign(design);
      queryClient.invalidateQueries({ queryKey: ["/api/designs"] });
    },
    onError: (error: any) => {
      toast({
        title: "Save failed",
        description: error.message || "Failed to save design",
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
      const design = data.design;
      setGeneratedDesign(design);
      setIsReuseMode(false);
      setReuseSourceDesign(null);
      queryClient.invalidateQueries({ queryKey: ["/api/designs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer"] });
      toast({
        title: "Design saved!",
        description: "Your reused design has been saved to your gallery.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Save failed",
        description: error.message || "Failed to save reused design",
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
    if (generatedDesign && designerConfig && selectedProductTypeId) {
      const imageUrl = window.location.origin + generatedDesign.generatedImageUrl;
      fetchPrintifyMockups(imageUrl, selectedProductTypeId, selectedSize, selectedFrameColor, imageScale, imagePosition.x, imagePosition.y);
    }
  }, [generatedDesign, designerConfig, selectedProductTypeId, selectedSize, selectedFrameColor, imageScale, imagePosition.x, imagePosition.y, fetchPrintifyMockups]);

  // Debounced auto-update for mockups when scale or position changes
  const transformTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastTransformRef = useRef({ scale: imageScale, x: imagePosition.x, y: imagePosition.y });
  
  useEffect(() => {
    // Only trigger if we have mockups and transform actually changed
    if (printifyMockups.length > 0 && designerConfig?.hasPrintifyMockups && generatedDesign) {
      const transformChanged = 
        lastTransformRef.current.scale !== imageScale ||
        lastTransformRef.current.x !== imagePosition.x ||
        lastTransformRef.current.y !== imagePosition.y;
        
      if (transformChanged) {
        // Clear any existing timeout
        if (transformTimeoutRef.current) {
          clearTimeout(transformTimeoutRef.current);
        }
        // Set new timeout for 1 second after adjustment stops
        transformTimeoutRef.current = setTimeout(() => {
          handleRegenerateMockup();
          lastTransformRef.current = { scale: imageScale, x: imagePosition.x, y: imagePosition.y };
        }, 1000);
      }
    }
    // Cleanup on unmount
    return () => {
      if (transformTimeoutRef.current) {
        clearTimeout(transformTimeoutRef.current);
      }
    };
  }, [imageScale, imagePosition.x, imagePosition.y, printifyMockups.length, designerConfig?.hasPrintifyMockups, generatedDesign, handleRegenerateMockup]);

  // Initialize calibration area when size/frame changes in calibration mode
  // Note: We compute currentLifestyle inline here since we can't call it before hooks
  const calibrationLifestyle = selectedSize && lifestyleMockups[selectedSize]
    ? lifestyleMockups[selectedSize][lifestyleMockups[selectedSize][selectedFrameColor] ? selectedFrameColor : "black"]
    : null;
  
  useEffect(() => {
    if (calibrationLifestyle && calibrationMode) {
      setCalibrationArea({ ...calibrationLifestyle.frameArea });
    }
  }, [calibrationLifestyle?.src, calibrationMode]);

  // These need to be defined before early returns to satisfy Rules of Hooks
  const activeSizes = designerConfig?.sizes || config?.sizes || [];
  const activeFrameColors = designerConfig?.frameColors || config?.frameColors || [];
  
  // Helper to check if a size/color combination is available
  const isVariantAvailable = useCallback((sizeId: string, colorId: string): boolean => {
    if (!designerConfig?.variantMap) return true; // If no variant map, assume all available
    const key = `${sizeId}:${colorId}`;
    return key in designerConfig.variantMap;
  }, [designerConfig?.variantMap]);
  
  // Get available colors for current size
  const getAvailableColorsForSize = useCallback((sizeId: string): string[] => {
    if (!designerConfig?.variantMap) return activeFrameColors.map(c => c.id);
    return activeFrameColors
      .filter(color => isVariantAvailable(sizeId, color.id))
      .map(c => c.id);
  }, [designerConfig?.variantMap, activeFrameColors, isVariantAvailable]);
  
  // Get available sizes for current color
  const getAvailableSizesForColor = useCallback((colorId: string): string[] => {
    if (!designerConfig?.variantMap) return activeSizes.map(s => s.id);
    return activeSizes
      .filter(size => isVariantAvailable(size.id, colorId))
      .map(s => s.id);
  }, [designerConfig?.variantMap, activeSizes, isVariantAvailable]);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Skeleton className="h-32 w-32 rounded-full" />
      </div>
    );
  }

  if (!isAuthenticated) {
    window.location.href = "/api/login";
    return null;
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        toast({
          title: "File too large",
          description: "Please upload an image under 5MB",
          variant: "destructive",
        });
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        setReferenceImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const resetTransform = () => {
    setImageScale(defaultZoom);
    setImagePosition({ x: 50, y: 50 });
  };

  const centerImage = () => {
    setImagePosition({ x: 50, y: 50 });
  };

  const handleSizeChange = (newSize: string) => {
    setSelectedSize(newSize);
    setImageScale(defaultZoom);
    setImagePosition({ x: 50, y: 50 });
    // Clear mockups so new ones can be fetched for the new size
    setPrintifyMockups([]);
    setPrintifyMockupImages([]);
    lastAutoFetchKeyRef.current = null;
  };

  const handleFrameColorChange = (newColor: string) => {
    // Check for color tier mismatch only for apparel products with an existing design
    if (generatedDesign && designerConfig?.designerType === "apparel" && generatedDesign.colorTier) {
      const colorConfig = activeFrameColors.find(c => c.id === newColor);
      if (colorConfig?.hex) {
        const newTier = getColorTier(colorConfig.hex);
        const currentTier = generatedDesign.colorTier as ColorTier;
        
        if (newTier !== currentTier) {
          // Show modal to warn about tier mismatch
          setPendingColorChange({ newColor, newTier });
          setShowColorTierModal(true);
          return;
        }
      }
    }
    
    setSelectedFrameColor(newColor);
    // Clear mockups so new ones can be fetched for the new color
    setPrintifyMockups([]);
    setPrintifyMockupImages([]);
    lastAutoFetchKeyRef.current = null;
  };
  
  const handleColorTierRegenerate = async () => {
    if (!generatedDesign || !pendingColorChange) return;
    
    // In reuse mode, use the source design ID; otherwise use the current design ID
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
        // Clear mockups so new ones can be fetched for the regenerated design
        setPrintifyMockups([]);
        setPrintifyMockupImages([]);
        lastAutoFetchKeyRef.current = null;
        queryClient.invalidateQueries({ queryKey: ["/api/designs"] });
        queryClient.invalidateQueries({ queryKey: ["/api/customer"] });
        toast({
          title: "Design regenerated!",
          description: `Your design has been optimized for ${pendingColorChange.newTier === "dark" ? "dark" : "light"} colored apparel.`,
        });
        // Success - close modal and clean up
        setIsRegenerating(false);
        setShowColorTierModal(false);
        setPendingColorChange(null);
      }
    } catch (error: any) {
      console.error("Failed to regenerate design:", error);
      // Error format from apiRequest is "${status}: ${responseText}"
      const errorMsg = error?.message || "";
      const isInsufficientCredits = errorMsg.startsWith("402") || errorMsg.includes("Insufficient credits");
      const errorMessage = isInsufficientCredits 
        ? "You don't have enough credits to regenerate. Please purchase more credits."
        : "Could not regenerate the design. Please try again.";
      toast({
        title: "Regeneration failed",
        description: errorMessage,
        variant: "destructive",
      });
      setIsRegenerating(false);
      // Keep modal open on failure so user can retry or cancel
      // Don't clear pendingColorChange so they can try again after buying credits
    }
  };
  
  const handleColorTierKeepOriginal = () => {
    // Cancel the color change - keep the current color that matches the design
    setShowColorTierModal(false);
    setPendingColorChange(null);
  };
  
  const handleColorTierProceedAnyway = () => {
    // User wants to proceed with the mismatched color without regenerating
    if (pendingColorChange) {
      setSelectedFrameColor(pendingColorChange.newColor);
      // Clear mockups so new ones can be fetched for the new color
      setPrintifyMockups([]);
      setPrintifyMockupImages([]);
      lastAutoFetchKeyRef.current = null;
    }
    setShowColorTierModal(false);
    setPendingColorChange(null);
  };

  const handleSaveDesign = () => {
    if (!generatedDesign) return;
    saveMutation.mutate({
      designId: generatedDesign.id,
      transformScale: imageScale,
      transformX: imagePosition.x,
      transformY: imagePosition.y,
      size: selectedSize,
      frameColor: selectedFrameColor,
    }, {
      onSuccess: () => {
        toast({
          title: "Design saved!",
          description: "Your artwork adjustments have been saved.",
        });
      }
    });
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
        description: "Please select a print size first",
        variant: "destructive",
      });
      return;
    }
    if ((customer?.credits ?? 0) <= 0) {
      toast({
        title: "No credits",
        description: "Purchase more credits to continue creating",
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
      productTypeId: designerConfig?.id,
    });
  };

  const handleTweak = () => {
    if (!tweakPrompt.trim()) {
      toast({
        title: "Tweak description required",
        description: "Please describe what you want to change",
        variant: "destructive",
      });
      return;
    }
    if (!generatedDesign?.generatedImageUrl) {
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

    const tweakFullPrompt = `${prompt.trim()}. Modification: ${tweakPrompt.trim()}`;
    
    generateMutation.mutate({
      prompt: tweakFullPrompt,
      stylePreset: selectedStyle,
      size: selectedSize,
      frameColor: selectedFrameColor,
      referenceImage: generatedDesign.generatedImageUrl,
      productTypeId: designerConfig?.id,
    }, {
      onSuccess: () => {
        setTweakPrompt("");
        setShowTweak(false);
      }
    });
  };

  // Check if current selection is valid
  const isCurrentSelectionValid = selectedSize && selectedFrameColor 
    ? isVariantAvailable(selectedSize, selectedFrameColor) 
    : true;
  
  const selectedSizeConfig = activeSizes.find(s => s.id === selectedSize);
  const selectedFrameColorConfig = activeFrameColors.find(f => f.id === selectedFrameColor);
  
  // Only return framed print lifestyle mockups for framed product types
  const getLifestyleMockup = () => {
    // Only use framed lifestyle mockups for framed print products
    const isFramed = designerConfig?.designerType === "framed-print" || designerConfig?.designerType === "framed_print";
    if (!isFramed) return null;
    if (!selectedSize) return null;
    const sizeConfig = lifestyleMockups[selectedSize];
    if (!sizeConfig) return null;
    const colorKey = sizeConfig[selectedFrameColor] ? selectedFrameColor : "black";
    return sizeConfig[colorKey] || null;
  };
  
  const currentLifestyle = getLifestyleMockup();

  // Calibration drag handlers
  const handleCalibrationMouseDown = (e: React.MouseEvent) => {
    if (!calibrationArea || !calibrationRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    isCalibrationDragging.current = true;
    calibrationDragStart.current = { 
      x: e.clientX, 
      y: e.clientY, 
      top: calibrationArea.top, 
      left: calibrationArea.left 
    };
  };

  const handleCalibrationResizeMouseDown = (e: React.MouseEvent) => {
    if (!calibrationArea || !calibrationRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    isCalibrationResizing.current = true;
    calibrationResizeStart.current = { 
      x: e.clientX, 
      y: e.clientY, 
      width: calibrationArea.width, 
      height: calibrationArea.height 
    };
  };

  const handleCalibrationMouseMove = (e: React.MouseEvent) => {
    if (!calibrationRef.current) return;
    const rect = calibrationRef.current.getBoundingClientRect();
    
    if (isCalibrationDragging.current && calibrationArea) {
      const dx = ((e.clientX - calibrationDragStart.current.x) / rect.width) * 100;
      const dy = ((e.clientY - calibrationDragStart.current.y) / rect.height) * 100;
      setCalibrationArea(prev => prev ? {
        ...prev,
        top: Math.max(0, Math.min(100 - prev.height, calibrationDragStart.current.top + dy)),
        left: Math.max(0, Math.min(100 - prev.width, calibrationDragStart.current.left + dx)),
      } : null);
    }
    
    if (isCalibrationResizing.current && calibrationArea) {
      // Lock aspect ratio based on print size
      const aspectRatio = selectedSizeConfig 
        ? selectedSizeConfig.width / selectedSizeConfig.height 
        : 3 / 4;
      
      // Calculate delta from drag
      const dx = ((e.clientX - calibrationResizeStart.current.x) / rect.width) * 100;
      
      // Calculate unconstrained new dimensions based on width drag
      let newWidth = calibrationResizeStart.current.width + dx;
      let newHeight = newWidth / aspectRatio;
      
      // Calculate maximum allowed dimensions based on position
      const maxWidth = 100 - calibrationArea.left;
      const maxHeight = 100 - calibrationArea.top;
      
      // Constrain to bounds while preserving aspect ratio
      // If either dimension hits its max, scale both down proportionally
      if (newWidth > maxWidth) {
        newWidth = maxWidth;
        newHeight = newWidth / aspectRatio;
      }
      if (newHeight > maxHeight) {
        newHeight = maxHeight;
        newWidth = newHeight * aspectRatio;
      }
      
      // Apply minimum size while preserving aspect ratio
      const minSize = 5;
      if (newWidth < minSize) {
        newWidth = minSize;
        newHeight = newWidth / aspectRatio;
      }
      if (newHeight < minSize) {
        newHeight = minSize;
        newWidth = newHeight * aspectRatio;
      }
      
      setCalibrationArea(prev => prev ? {
        ...prev,
        width: newWidth,
        height: newHeight,
      } : null);
    }
  };

  const handleCalibrationMouseUp = () => {
    isCalibrationDragging.current = false;
    isCalibrationResizing.current = false;
  };

  const copyCalibrationCoords = () => {
    if (!calibrationArea) return;
    const coords = `{ top: ${calibrationArea.top.toFixed(1)}, left: ${calibrationArea.left.toFixed(1)}, width: ${calibrationArea.width.toFixed(1)}, height: ${calibrationArea.height.toFixed(1)} }`;
    navigator.clipboard.writeText(coords);
    toast({ title: "Copied!", description: coords });
  };

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
              className={`h-auto py-2 text-xs ${!isAvailable ? 'opacity-40' : ''}`}
              onClick={() => handleSizeChange(size.id)}
              disabled={!isAvailable}
              title={!isAvailable ? `Not available in ${activeFrameColors.find(c => c.id === selectedFrameColor)?.name || 'selected color'}` : undefined}
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
                selectedFrameColor === color.id
                  ? "border-primary ring-2 ring-primary ring-offset-2"
                  : "border-muted"
              } ${!isAvailable ? 'opacity-40 cursor-not-allowed' : ''}`}
              style={{ backgroundColor: color.hex }}
              onClick={() => isAvailable && handleFrameColorChange(color.id)}
              disabled={!isAvailable}
              title={!isAvailable ? `Not available in ${activeSizes.find(s => s.id === selectedSize)?.name || 'selected size'}` : color.name}
              data-testid={`button-frame-${color.id}`}
            />
          );
        })}
      </div>
      {!isCurrentSelectionValid && selectedSize && selectedFrameColor && (
        <p className="text-xs text-destructive">
          This size/color combination is not available. Please select a different option.
        </p>
      )}
    </div>
  );

  // Determine which style category to show based on product type
  const getStyleCategory = (): "decor" | "apparel" => {
    const designerType = designerConfig?.designerType || "";
    if (designerType === "apparel" || designerType.includes("shirt") || designerType.includes("hoodie")) {
      return "apparel";
    }
    return "decor";
  };
  
  const styleCategory = getStyleCategory();
  const filteredStyles = config?.stylePresets.filter(style => 
    (style as any).category === "all" || (style as any).category === styleCategory
  ) || [];
  
  const styleSelector = (
    <div className="space-y-2">
      <Label className="text-sm font-medium">
        Style 
        <span className="text-xs text-muted-foreground ml-1">
          ({styleCategory === "apparel" ? "Apparel Artwork" : "Decor Artwork"})
        </span>
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
            <img
              src={referenceImage}
              alt="Reference"
              className="h-12 w-12 object-cover rounded-md"
            />
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            data-testid="button-upload-reference"
          >
            <Upload className="h-3 w-3 mr-1" />
            Reference Image
          </Button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileUpload}
        />
      </div>
    </div>
  );

  const generateButton = (
    <Button
      size="default"
      className="w-full"
      onClick={handleGenerate}
      disabled={generateMutation.isPending}
      data-testid="button-generate"
    >
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

  const reuseSaveButton = isReuseMode && reuseSourceDesign && (
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
  );

  const reuseBanner = isReuseMode && reuseSourceDesign && (
    <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-3 mb-4">
      <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
        <Copy className="h-4 w-4 shrink-0" />
        <div className="text-sm">
          <strong>Reusing artwork:</strong> Select a product, size, and color to save this design to your gallery.
        </div>
      </div>
    </div>
  );

  const zoomControls = generatedDesign?.generatedImageUrl && (
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
      <Button 
        variant="outline" 
        size="icon"
        onClick={centerImage}
        title="Center image"
        data-testid="button-center"
      >
        <Crosshair className="h-4 w-4" />
      </Button>
      <Button 
        variant="outline" 
        size="sm" 
        onClick={resetTransform}
        data-testid="button-reset-transform"
      >
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
  );

  const actionButtons = generatedDesign && (
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
        <Button 
          variant="outline" 
          className="flex-1" 
          onClick={handleSaveDesign}
          disabled={saveMutation.isPending}
          data-testid="button-save"
        >
          <Save className="h-4 w-4 mr-2" />
          {saveMutation.isPending ? "Saving..." : "Save"}
        </Button>
      )}
      <Button className="flex-1" data-testid="button-order">
        <ShoppingCart className="h-4 w-4 mr-2" />
        Order Print
      </Button>
    </div>
  );

  const getFrameInsets = () => {
    if (selectedSize === "11x14") {
      return { outer: '0.5rem', inner: '1.5rem' };
    } else if (["12x16", "16x16"].includes(selectedSize)) {
      return { outer: '0.625rem', inner: '1.25rem' };
    }
    return { outer: '0.75rem', inner: '1rem' };
  };
  const frameInsets = getFrameInsets();

  // Determine if we should show a framed preview or a base product mockup
  const isFramedProduct = designerConfig?.designerType === "framed-print" || designerConfig?.designerType === "framed_print";
  const hasBaseMockup = designerConfig?.baseMockupImages?.front;
  // For products with Printify mockups, prefer showing those over static base mockup
  // In reuse mode: always show loading/mockups flow (not base overlay) when we have a design
  // This prevents the confusing base image flash before mockups generate
  const reuseWaitingForMockups = isReuseMode && generatedDesign?.generatedImageUrl && designerConfig?.hasPrintifyMockups && printifyMockups.length === 0;
  const usePrintifyMockups = designerConfig?.hasPrintifyMockups && (printifyMockups.length > 0 || mockupLoading || reuseWaitingForMockups);
  // For apparel with hasPrintifyMockups but no mockups loaded yet, show artwork on base template
  // Don't show base overlay in reuse mode - use the loading/mockups flow instead
  const showApparelBaseWithArtwork = designerConfig?.hasPrintifyMockups && hasBaseMockup && !usePrintifyMockups && generatedDesign?.generatedImageUrl && !isReuseMode;
  // Can drag if we have artwork and (have mockups OR showing base with artwork)
  const canDragDesign = generatedDesign?.generatedImageUrl && (usePrintifyMockups || showApparelBaseWithArtwork || hasBaseMockup);

  const previewMockup = (
    <div 
      className={`relative bg-muted rounded-md flex items-center justify-center w-full h-full select-none`}
      style={{ cursor: canDragDesign ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
      onMouseEnter={() => setIsHoveringMockup(true)}
      onMouseLeave={() => { setIsHoveringMockup(false); handleMouseUp(); }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {isFramedProduct ? (
        // Framed print preview with frame and mat
        <div
          className="absolute rounded-sm flex items-center justify-center"
          style={{ backgroundColor: selectedFrameColorConfig?.hex || "#1a1a1a", pointerEvents: 'none', inset: frameInsets.outer }}
        >
          <div 
            className="absolute bg-white dark:bg-gray-200 rounded-sm flex items-center justify-center overflow-hidden"
            style={{ pointerEvents: 'none', inset: frameInsets.inner }}
          >
            {generateMutation.isPending ? (
              <div className="flex flex-col items-center gap-2 text-muted-foreground" style={{ pointerEvents: 'none' }}>
                <Loader2 className="h-8 w-8 animate-spin" />
                <span className="text-xs">Creating...</span>
              </div>
            ) : generatedDesign?.generatedImageUrl ? (
              <img
                src={generatedDesign.generatedImageUrl}
                alt="Generated artwork"
                className="select-none absolute"
                style={{
                  width: `${imageScale}%`,
                  height: `${imageScale}%`,
                  objectFit: 'cover',
                  left: `${imagePosition.x}%`,
                  top: `${imagePosition.y}%`,
                  transform: 'translate(-50%, -50%)',
                  pointerEvents: 'none',
                }}
                draggable={false}
                data-testid="img-generated"
              />
            ) : (
              <div className="text-center text-muted-foreground p-4" style={{ pointerEvents: 'none' }}>
                <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-xs">Your artwork will appear here</p>
              </div>
            )}
          </div>
        </div>
      ) : usePrintifyMockups ? (
        // Show Printify mockups for products with hasPrintifyMockups enabled
        <div className="w-full h-full flex items-center justify-center" style={{ pointerEvents: 'none' }}>
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
              <img
                src={printifyMockups[0]}
                alt="Product mockup"
                className="w-full h-full object-contain rounded-md"
                data-testid="img-printify-mockup"
              />
            </div>
          ) : (
            <div className="text-center text-muted-foreground p-4">
              <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-xs">Your artwork will appear here</p>
            </div>
          )}
        </div>
      ) : showApparelBaseWithArtwork ? (
        // Product with hasPrintifyMockups but mockups not yet loaded - show artwork on base template
        <div className="absolute inset-0 flex items-center justify-center" style={{ pointerEvents: 'none' }}>
          <div className="relative w-full h-full">
            <img
              src={designerConfig!.baseMockupImages!.front!}
              alt="Product preview"
              className="w-full h-full object-contain rounded-md"
              data-testid="img-base-mockup"
            />
            {/* Overlay generated artwork - different positioning for pillows vs apparel */}
            <div 
              className={`absolute overflow-hidden ${designerConfig?.designerType === 'pillow' && designerConfig?.printShape === 'circle' ? 'rounded-full' : ''}`}
              style={designerConfig?.designerType === 'pillow' ? {
                // Pillow: larger centered area to accommodate the full pillow print surface
                top: '10%',
                left: '10%',
                width: '80%',
                height: '80%',
              } : {
                // Apparel: smaller centered print area on chest
                top: '25%',
                left: '30%',
                width: '40%',
                height: '40%',
              }}
            >
              <img
                src={generatedDesign!.generatedImageUrl!}
                alt="Generated artwork"
                className="w-full h-full object-cover"
                style={{
                  transform: `scale(${imageScale / 100}) translate(${(imagePosition.x - 50)}%, ${(imagePosition.y - 50)}%)`,
                  borderRadius: designerConfig?.designerType === 'pillow' && designerConfig?.printShape === 'circle' ? '50%' : undefined,
                }}
                draggable={false}
                data-testid="img-generated"
              />
            </div>
          </div>
        </div>
      ) : hasBaseMockup ? (
        // Base product mockup (for apparel, etc.) with optional generated artwork overlay
        <div className="absolute inset-0 flex items-center justify-center" style={{ pointerEvents: 'none' }}>
          {generateMutation.isPending ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" />
              <span className="text-xs">Creating...</span>
            </div>
          ) : (
            <div className="relative w-full h-full">
              <img
                src={designerConfig.baseMockupImages!.front!}
                alt="Product preview"
                className="w-full h-full object-contain rounded-md"
                data-testid="img-base-mockup"
              />
              {/* Overlay generated artwork on the product mockup - different positioning for pillows vs other products */}
              {generatedDesign?.generatedImageUrl && (
                <div 
                  className={`absolute overflow-hidden ${designerConfig?.designerType === 'pillow' && designerConfig?.printShape === 'circle' ? 'rounded-full' : ''}`}
                  style={designerConfig?.designerType === 'pillow' ? {
                    top: '10%',
                    left: '10%',
                    width: '80%',
                    height: '80%',
                    pointerEvents: 'auto',
                  } : {
                    top: '25%',
                    left: '30%',
                    width: '40%',
                    height: '40%',
                    pointerEvents: 'auto',
                  }}
                >
                  <img
                    src={generatedDesign.generatedImageUrl}
                    alt="Generated artwork"
                    className="w-full h-full object-cover"
                    style={{
                      transform: `scale(${imageScale / 100}) translate(${(imagePosition.x - 50)}%, ${(imagePosition.y - 50)}%)`,
                      borderRadius: designerConfig?.designerType === 'pillow' && designerConfig?.printShape === 'circle' ? '50%' : undefined,
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
        // Generic placeholder or Printify mockups
        <div className="w-full h-full flex items-center justify-center" style={{ pointerEvents: 'none' }}>
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
          ) : printifyMockups.length > 0 ? (
            <div className="relative w-full h-full">
              <img
                src={printifyMockups[0]}
                alt="Product mockup"
                className="w-full h-full object-contain rounded-md"
                data-testid="img-printify-mockup"
              />
              {/* Loading overlay when updating mockups */}
              {mockupLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/60 rounded-md">
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-6 w-6 animate-spin" />
                    <span className="text-xs">Updating...</span>
                  </div>
                </div>
              )}
            </div>
          ) : generatedDesign?.generatedImageUrl ? (
            <img
              src={generatedDesign.generatedImageUrl}
              alt="Generated artwork"
              className="w-full h-full object-contain rounded-md"
              data-testid="img-generated"
            />
          ) : (
            <div className="text-center text-muted-foreground p-4">
              <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-xs">Your artwork will appear here</p>
            </div>
          )}
        </div>
      )}
      
      {/* Ghost overlay while dragging - shows design position in real-time */}
      {isDragging && generatedDesign?.generatedImageUrl && canDragDesign && (
        <div 
          className="absolute pointer-events-none z-10"
          style={{
            width: `${imageScale * 0.35}%`,
            height: `${imageScale * 0.35}%`,
            left: `${imagePosition.x}%`,
            top: `${imagePosition.y}%`,
            transform: 'translate(-50%, -50%)',
          }}
        >
          <div className="w-full h-full border-2 border-primary border-dashed rounded-lg bg-primary/10 flex items-center justify-center">
            <img 
              src={generatedDesign.generatedImageUrl} 
              alt="Position preview" 
              className="w-3/4 h-3/4 object-contain opacity-60"
              draggable={false}
            />
          </div>
        </div>
      )}
      
      {/* Hover indicator - shows move icon when hovering over draggable area */}
      {canDragDesign && isHoveringMockup && !isDragging && !generateMutation.isPending && !mockupLoading && (
        <div className="absolute inset-0 bg-black/20 flex items-center justify-center transition-opacity pointer-events-none z-10 rounded-md">
          <div className="bg-background/90 rounded-full p-3 shadow-lg">
            <Move className="h-6 w-6 text-foreground" />
          </div>
        </div>
      )}
    </div>
  );

  // Get the frame area to use (calibration or default)
  const activeFrameArea = calibrationMode && calibrationArea ? calibrationArea : currentLifestyle?.frameArea;
  
  // For non-framed products, use base mockup lifestyle image if available
  const hasBaseLifestyleMockup = designerConfig?.baseMockupImages?.lifestyle;
  
  // Check if we have additional Printify mockups to show
  const hasPrintifyLifestyleMockup = printifyMockups.length > 1;
  
  // In reuse mode waiting for mockups, show loading instead of base lifestyle
  const showLifestyleLoading = reuseWaitingForMockups || (mockupLoading && !hasPrintifyLifestyleMockup);

  const lifestyleMockup = (currentLifestyle || hasBaseLifestyleMockup || hasPrintifyLifestyleMockup || showLifestyleLoading) && (
    <div 
      ref={calibrationRef}
      className="relative w-full flex items-center justify-center"
      onMouseMove={calibrationMode ? handleCalibrationMouseMove : undefined}
      onMouseUp={calibrationMode ? handleCalibrationMouseUp : undefined}
      onMouseLeave={calibrationMode ? handleCalibrationMouseUp : undefined}
    >
      <div className="relative">
        {showLifestyleLoading && !currentLifestyle && !hasPrintifyLifestyleMockup ? (
          // Loading state for reuse mode
          <div className="w-full h-64 flex items-center justify-center bg-muted rounded-md">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" />
              <span className="text-xs">Generating preview...</span>
            </div>
          </div>
        ) : currentLifestyle ? (
          // Framed product lifestyle with artwork overlay
          <>
            <img
              ref={mockupImgRef}
              src={currentLifestyle.src}
              alt="Lifestyle mockup"
              className="w-full h-auto rounded-md"
            />
            {activeFrameArea && (
              <div
                className={`absolute ${calibrationMode ? 'border-2 border-dashed border-blue-500 cursor-move' : 'overflow-hidden'}`}
                style={{
                  top: `${activeFrameArea.top}%`,
                  left: `${activeFrameArea.left}%`,
                  width: `${activeFrameArea.width}%`,
                  height: `${activeFrameArea.height}%`,
                }}
                onMouseDown={calibrationMode ? handleCalibrationMouseDown : undefined}
              >
                {generatedDesign?.generatedImageUrl && (
                  <img
                    src={generatedDesign.generatedImageUrl}
                    alt="Artwork in lifestyle"
                    className={`absolute ${calibrationMode ? 'opacity-70' : ''}`}
                    style={{
                      width: `${imageScale}%`,
                      height: `${imageScale}%`,
                      left: `${imagePosition.x - imageScale / 2}%`,
                      top: `${imagePosition.y - imageScale / 2}%`,
                      objectFit: 'cover',
                    }}
                  />
                )}
                {calibrationMode && (
                  <>
                    <div
                      className="absolute bottom-0 right-0 w-4 h-4 bg-blue-500 cursor-se-resize"
                      onMouseDown={handleCalibrationResizeMouseDown}
                    />
                    <div className="absolute -top-6 left-0 text-xs bg-blue-500 text-white px-1 rounded whitespace-nowrap">
                      T:{activeFrameArea.top.toFixed(1)} L:{activeFrameArea.left.toFixed(1)} W:{activeFrameArea.width.toFixed(1)} H:{activeFrameArea.height.toFixed(1)}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        ) : hasPrintifyLifestyleMockup ? (
          // Printify-generated lifestyle mockup
          <div className="relative">
            <img
              src={printifyMockups[1]}
              alt="Lifestyle preview"
              className="w-full h-auto rounded-md"
              data-testid="img-printify-lifestyle"
            />
            {/* Loading overlay when updating mockups */}
            {mockupLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/60 rounded-md">
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-6 w-6 animate-spin" />
                  <span className="text-xs">Updating...</span>
                </div>
              </div>
            )}
          </div>
        ) : hasBaseLifestyleMockup ? (
          // Base product lifestyle mockup with generated artwork overlay - different positioning for pillows
          <div className="relative">
            <img
              src={designerConfig!.baseMockupImages!.lifestyle!}
              alt="Lifestyle preview"
              className="w-full h-auto rounded-md"
              data-testid="img-base-lifestyle"
            />
            {/* Overlay generated artwork on lifestyle mockup */}
            {generatedDesign?.generatedImageUrl && (
              <div 
                className={`absolute overflow-hidden ${designerConfig?.designerType === 'pillow' && designerConfig?.printShape === 'circle' ? 'rounded-full' : ''}`}
                style={designerConfig?.designerType === 'pillow' ? {
                  // Pillow lifestyle has pillow in center - adjust for typical lifestyle image
                  top: '15%',
                  left: '20%',
                  width: '60%',
                  height: '60%',
                } : {
                  // Apparel lifestyle positioning
                  top: '20%',
                  left: '25%',
                  width: '50%',
                  height: '50%',
                }}
              >
                <img
                  src={generatedDesign.generatedImageUrl}
                  alt="Artwork in lifestyle"
                  className="w-full h-full object-cover"
                  style={{
                    transform: `scale(${imageScale / 100}) translate(${(imagePosition.x - 50)}%, ${(imagePosition.y - 50)}%)`,
                    borderRadius: designerConfig?.designerType === 'pillow' && designerConfig?.printShape === 'circle' ? '50%' : undefined,
                  }}
                  data-testid="img-generated-lifestyle"
                />
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );

  // Calibration controls panel
  const calibrationPanel = (
    <div className="flex items-center gap-2 text-xs">
      <Button
        variant={calibrationMode ? "default" : "outline"}
        size="sm"
        onClick={() => {
          setCalibrationMode(!calibrationMode);
          if (!calibrationMode && currentLifestyle) {
            setCalibrationArea({ ...currentLifestyle.frameArea });
          }
        }}
        data-testid="button-calibration-toggle"
      >
        {calibrationMode ? "Exit Calibrate" : "Calibrate"}
      </Button>
      {calibrationMode && calibrationArea && (
        <Button
          variant="outline"
          size="sm"
          onClick={copyCalibrationCoords}
          data-testid="button-copy-coords"
        >
          Copy Coords
        </Button>
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
        <Button
          size="sm"
          className="flex-1"
          onClick={handleTweak}
          disabled={generateMutation.isPending}
          data-testid="button-tweak"
        >
          {generateMutation.isPending ? "Tweaking..." : "Apply Tweak (1 Credit)"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setShowTweak(false); setTweakPrompt(""); }}
          data-testid="button-cancel-tweak"
        >
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
                          .replace(/<[^>]*>/g, '') // Strip HTML tags
                          .replace(/&lt;/g, '<').replace(/&gt;/g, '>') // Decode entities
                          .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
                          .replace(/<[^>]*>/g, '') // Strip again after decoding
                          .replace(/\s+/g, ' ').trim() // Normalize whitespace
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
            <p className="text-muted-foreground mb-4">
              Products need to be imported from Printify in the Admin panel.
            </p>
            <Link href="/admin">
              <Button data-testid="button-go-to-admin">
                Go to Admin Panel
              </Button>
            </Link>
          </div>
        )}
      </div>
    </div>
  );

  const selectedProductTypeName = productTypes?.find(p => p.id === selectedProductTypeId)?.name;

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
              <Button 
                variant="ghost" 
                size="icon" 
                onClick={() => setSelectedProductTypeId(null)}
                data-testid="button-back-to-products"
              >
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

  if (designerConfigError) {
    return (
      <div className="h-screen flex flex-col bg-background overflow-hidden">
        <header className="border-b bg-background z-50 shrink-0">
          <div className="container mx-auto px-3 py-2 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Button 
                variant="ghost" 
                size="icon" 
                onClick={() => setSelectedProductTypeId(null)}
                data-testid="button-back-to-products"
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <h1 className="text-base font-semibold">{selectedProductTypeName || "Error"}</h1>
            </div>
          </div>
        </header>
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <p className="text-muted-foreground">Failed to load product configuration</p>
          <Button onClick={() => setSelectedProductTypeId(null)} data-testid="button-try-again">
            Choose a Different Product
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <header className="border-b bg-background z-50 shrink-0">
        <div className="container mx-auto px-3 py-2 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => setSelectedProductTypeId(null)}
              data-testid="button-back-to-products"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-base font-semibold">{selectedProductTypeName || "Design"}</h1>
              <button 
                onClick={() => setSelectedProductTypeId(null)}
                className="text-xs text-muted-foreground hover:underline"
                data-testid="link-change-product"
              >
                Change product
              </button>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <CreditDisplay customer={customer} isLoading={customerLoading} />
          </div>
        </div>
      </header>

      {/* Desktop Layout - Three columns */}
      <main className="hidden lg:flex flex-1 overflow-hidden">
        <div className="w-full max-w-6xl mx-auto px-4 py-3 flex flex-col h-full">
          <div className="flex-1 flex gap-4 min-h-0">
            {/* Left column: Controls */}
            <div className="w-72 shrink-0 space-y-3 overflow-y-auto">
              {reuseBanner}
              {styleSelector}
              {sizeSelector}
              {frameColorSelector}
              {promptInput}
              {isReuseMode ? reuseSaveButton : generateButton}
            </div>
            
            {/* Center: Main preview - shows selected mockup or front view */}
            <div className="flex-1 flex flex-col items-center min-w-0">
              <h3 className="text-sm font-medium mb-2">
                {printifyMockupImages.length > 0 && selectedMockupIndex < printifyMockupImages.length
                  ? printifyMockupImages[selectedMockupIndex].label.charAt(0).toUpperCase() + printifyMockupImages[selectedMockupIndex].label.slice(1).replace(/-/g, ' ')
                  : "Front"}
              </h3>
              <div className="flex-1 flex items-center justify-center min-h-0 w-full overflow-hidden">
                <div 
                  key={`front-${selectedSize}-${selectedMockupIndex}`}
                  className="max-h-full max-w-full"
                  style={{ 
                    aspectRatio: selectedSizeConfig ? `${selectedSizeConfig.width}/${selectedSizeConfig.height}` : "3/4",
                    width: selectedSizeConfig && selectedSizeConfig.width >= selectedSizeConfig.height ? '100%' : 'auto',
                    height: selectedSizeConfig && selectedSizeConfig.height > selectedSizeConfig.width ? '100%' : 'auto',
                  }}
                >
                  {/* Show selected Printify mockup if available, otherwise show regular previewMockup */}
                  {printifyMockups.length > 0 && selectedMockupIndex < printifyMockups.length ? (
                    <div className="relative w-full h-full">
                      <img
                        src={printifyMockups[selectedMockupIndex]}
                        alt={printifyMockupImages[selectedMockupIndex]?.label || "Mockup preview"}
                        className="w-full h-full object-contain rounded-md"
                        data-testid="img-selected-mockup"
                      />
                      {mockupLoading && (
                        <div className="absolute inset-0 flex items-center justify-center bg-background/60 rounded-md">
                          <div className="flex flex-col items-center gap-2 text-muted-foreground">
                            <Loader2 className="h-6 w-6 animate-spin" />
                            <span className="text-xs">Updating...</span>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    previewMockup
                  )}
                </div>
              </div>
              <div className="mt-1 h-6 flex items-center justify-center">
                {tweakLink}
              </div>
              {tweakPanel && <div className="mt-2 w-full max-w-xs">{tweakPanel}</div>}
            </div>
            
            {/* Right: Secondary view OR Mockup Gallery when there are many mockups */}
            <div className="flex-1 flex flex-col items-center min-w-0">
              {printifyMockupImages.length > 2 ? (
                /* Mockup gallery when there are 3+ mockups */
                <>
                  <h3 className="text-sm font-medium mb-2">All Views ({printifyMockupImages.length})</h3>
                  <div className="flex-1 w-full overflow-y-auto">
                    <div className="grid grid-cols-2 gap-2 p-1">
                      {printifyMockupImages.map((mockup, index) => (
                        <div
                          key={index}
                          onClick={() => setSelectedMockupIndex(index)}
                          className={`cursor-pointer rounded-lg p-1 transition-all ${
                            selectedMockupIndex === index 
                              ? 'ring-2 ring-primary bg-primary/10' 
                              : 'hover-elevate'
                          }`}
                          data-testid={`mockup-thumbnail-${index}`}
                        >
                          <img
                            src={mockup.url}
                            alt={mockup.label}
                            className="w-full aspect-square object-contain rounded-md border"
                          />
                          <p className="text-xs text-center text-muted-foreground mt-1 truncate">
                            {mockup.label.charAt(0).toUpperCase() + mockup.label.slice(1).replace(/-/g, ' ')}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                /* Show secondary mockup for 1-2 mockups or lifestyle for framed prints */
                <>
                  <h3 className="text-sm font-medium mb-2">
                    {printifyMockupImages.length > 1 
                      ? printifyMockupImages[1].label.charAt(0).toUpperCase() + printifyMockupImages[1].label.slice(1).replace(/-/g, ' ')
                      : currentLifestyle ? "Lifestyle" : "Preview"}
                  </h3>
                  <div className="flex-1 flex items-center justify-center min-h-0 w-full overflow-hidden">
                    <div 
                      key={`lifestyle-${selectedSize}-${selectedFrameColor}`} 
                      className="max-h-full max-w-full flex items-center justify-center"
                      style={{ 
                        aspectRatio: selectedSizeConfig ? `${selectedSizeConfig.width}/${selectedSizeConfig.height}` : "3/4",
                        width: selectedSizeConfig && selectedSizeConfig.width >= selectedSizeConfig.height ? '100%' : 'auto',
                        height: selectedSizeConfig && selectedSizeConfig.height > selectedSizeConfig.width ? '100%' : 'auto',
                      }}
                    >
                      {lifestyleMockup || (
                        <div className="h-full w-full flex items-center justify-center bg-muted rounded-md">
                          <p className="text-xs text-muted-foreground">Select a size to see lifestyle view</p>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="mt-1 h-6 flex items-center justify-center">
                    {/* Calibration panel hidden - enable when needed for positioning adjustments */}
                    {/* {currentLifestyle && calibrationPanel} */}
                  </div>
                </>
              )}
            </div>
          </div>
          
          {/* Bottom: Zoom and action buttons */}
          <div className="shrink-0 pt-3 flex items-center gap-4">
            <div className="flex-1">{zoomControls}</div>
            <div className="w-72">{actionButtons}</div>
          </div>
        </div>
      </main>

      {/* Mobile Layout - Swipeable */}
      <main className="lg:hidden flex-1 overflow-hidden flex flex-col">
        <div 
          ref={carouselRef}
          className="flex-1 relative overflow-hidden"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <div 
            className="flex h-full transition-transform duration-300 ease-out"
            style={{ transform: `translateX(-${mobileSlide * 100}%)` }}
          >
            {/* Slide 1: Style, Size, Frame, Prompt, Generate */}
            <div className="w-full h-full flex-shrink-0 overflow-y-auto p-4 space-y-4">
              {reuseBanner}
              {styleSelector}
              {sizeSelector}
              {frameColorSelector}
              {promptInput}
              {isReuseMode ? reuseSaveButton : generateButton}
            </div>
            
            {/* Slide 2: Preview with Front/Lifestyle toggle */}
            <div className="w-full h-full flex-shrink-0 overflow-y-auto p-4 space-y-3">
              {sizeSelector}
              {frameColorSelector}
              
              {/* Front/Lifestyle Toggle */}
              <div className="flex justify-center gap-2">
                <Button
                  variant={mobileViewMode === "front" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setMobileViewMode("front")}
                  data-testid="button-view-front"
                >
                  Front
                </Button>
                <Button
                  variant={mobileViewMode === "lifestyle" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setMobileViewMode("lifestyle")}
                  disabled={!currentLifestyle && printifyMockupImages.length < 2}
                  data-testid="button-view-lifestyle"
                >
                  {printifyMockupImages.length > 1 
                    ? printifyMockupImages[1].label.charAt(0).toUpperCase() + printifyMockupImages[1].label.slice(1).replace(/-/g, ' ')
                    : currentLifestyle ? "Lifestyle" : "Preview"}
                </Button>
              </div>
              
              {zoomControls}
              
              {/* Conditionally show Front or Lifestyle */}
              {mobileViewMode === "front" ? (
                <div className="space-y-1">
                  <div key={`mobile-front-${selectedSize}`} className="w-full" style={{ aspectRatio: selectedSizeConfig ? `${selectedSizeConfig.width}/${selectedSizeConfig.height}` : "3/4" }}>
                    {previewMockup}
                  </div>
                  <div className="flex justify-center">{tweakLink}</div>
                  {tweakPanel}
                </div>
              ) : (
                <div key={`mobile-lifestyle-${selectedSize}-${selectedFrameColor}`} className="w-full">
                  {lifestyleMockup || (
                    <div className="w-full aspect-square flex items-center justify-center bg-muted rounded-md">
                      <p className="text-xs text-muted-foreground">Select a size to see lifestyle view</p>
                    </div>
                  )}
                </div>
              )}
              
              {actionButtons}
            </div>
          </div>
        </div>
        
        {/* Mobile Navigation Indicators */}
        <div className="shrink-0 border-t bg-background p-3 flex items-center justify-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileSlide(0)}
            disabled={mobileSlide === 0}
            className={mobileSlide === 0 ? "opacity-30" : ""}
            data-testid="button-prev-slide"
          >
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <div className="flex gap-2">
            <button
              onClick={() => setMobileSlide(0)}
              className={`w-2 h-2 rounded-full transition-colors ${mobileSlide === 0 ? 'bg-primary' : 'bg-muted-foreground/30'}`}
              data-testid="indicator-controls"
            />
            <button
              onClick={() => setMobileSlide(1)}
              className={`w-2 h-2 rounded-full transition-colors ${mobileSlide === 1 ? 'bg-primary' : 'bg-muted-foreground/30'}`}
              data-testid="indicator-preview"
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileSlide(1)}
            disabled={mobileSlide === 1}
            className={mobileSlide === 1 ? "opacity-30" : ""}
            data-testid="button-next-slide"
          >
            <ChevronRight className="h-5 w-5" />
          </Button>
        </div>
      </main>
      
      {/* Color Tier Mismatch Modal */}
      <AlertDialog open={showColorTierModal} onOpenChange={(open) => { if (!open && !isRegenerating) handleColorTierKeepOriginal(); }}>
        <AlertDialogContent data-testid="dialog-color-tier">
          <AlertDialogHeader>
            <AlertDialogTitle>Design Colors May Not Match</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingColorChange?.newTier === "dark" ? (
                <>
                  This design was created with <strong>dark colors</strong> for light-colored apparel. 
                  For best results on <strong>dark-colored</strong> apparel, the design should use lighter, brighter colors.
                </>
              ) : (
                <>
                  This design was created with <strong>light/bright colors</strong> for dark-colored apparel. 
                  For best results on <strong>light-colored</strong> apparel, the design should use darker colors.
                </>
              )}
              <br /><br />
              Would you like to regenerate this design with optimized colors? This costs <strong>1 credit</strong> and uses the same prompt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <AlertDialogCancel 
              onClick={handleColorTierKeepOriginal}
              disabled={isRegenerating}
              data-testid="button-cancel-color-change"
            >
              Cancel
            </AlertDialogCancel>
            <Button
              variant="outline"
              onClick={handleColorTierProceedAnyway}
              disabled={isRegenerating}
              data-testid="button-proceed-anyway"
            >
              Use Anyway
            </Button>
            <AlertDialogAction 
              onClick={handleColorTierRegenerate}
              disabled={isRegenerating}
              data-testid="button-regenerate-tier"
            >
              {isRegenerating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Regenerating...
                </>
              ) : (
                "Regenerate (1 Credit)"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
