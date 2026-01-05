import { useState, useRef, useCallback, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ArrowLeft, Upload, X, Loader2, Sparkles, ShoppingCart, Save, ZoomIn, Move, ChevronLeft, ChevronRight, Crosshair, Eye } from "lucide-react";
import type { Customer, Design, PrintSize, FrameColor, StylePreset } from "@shared/schema";

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
    black: { src: lifestyle11x14blk, frameArea: { top: 11.5, left: 29.5, width: 41, height: 52 } },
    white: { src: lifestyle11x14wht, frameArea: { top: 11.5, left: 29.5, width: 41, height: 52 } },
  },
  "12x16": {
    black: { src: lifestyle12x16blk, frameArea: { top: 10, left: 30, width: 40, height: 52 } },
    white: { src: lifestyle12x16wht, frameArea: { top: 10, left: 30, width: 40, height: 52 } },
  },
  "16x16": {
    black: { src: lifestyle16x16blk, frameArea: { top: 15, left: 8, width: 42, height: 42 } },
    white: { src: lifestyle16x16wht, frameArea: { top: 15, left: 8, width: 42, height: 42 } },
  },
  "16x20": {
    black: { src: lifestyle16x20blk, frameArea: { top: 13, left: 32, width: 36, height: 44 } },
    white: { src: lifestyle16x20wht, frameArea: { top: 13, left: 32, width: 36, height: 44 } },
  },
  "20x30": {
    black: { src: lifestyle20x30blk, frameArea: { top: 8, left: 28, width: 44, height: 64 } },
    white: { src: lifestyle20x30wht, frameArea: { top: 8, left: 28, width: 44, height: 64 } },
  },
};

interface Config {
  sizes: PrintSize[];
  frameColors: FrameColor[];
  stylePresets: StylePreset[];
  blueprintId: number;
}

export default function DesignPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  
  const [prompt, setPrompt] = useState("");
  const [selectedSize, setSelectedSize] = useState<string>("");
  const [selectedFrameColor, setSelectedFrameColor] = useState<string>("black");
  const [selectedStyle, setSelectedStyle] = useState<string>("none");
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [generatedDesign, setGeneratedDesign] = useState<Design | null>(null);
  
  const [imageScale, setImageScale] = useState(100);
  const [imagePosition, setImagePosition] = useState({ x: 50, y: 50 });
  const [mobileSlide, setMobileSlide] = useState(0);
  const [mobileViewMode, setMobileViewMode] = useState<"front" | "lifestyle">("front");
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [tweakPrompt, setTweakPrompt] = useState("");
  const [showTweak, setShowTweak] = useState(false);
  
  // Calibration mode for positioning lifestyle mockup artwork
  const [calibrationMode, setCalibrationMode] = useState(false);
  const [calibrationArea, setCalibrationArea] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const calibrationRef = useRef<HTMLDivElement>(null);
  const mockupImgRef = useRef<HTMLImageElement>(null);
  const [mockupDimensions, setMockupDimensions] = useState<{ width: number; height: number } | null>(null);
  const isCalibrationDragging = useRef(false);
  const calibrationDragStart = useRef({ x: 0, y: 0, top: 0, left: 0 });
  const isCalibrationResizing = useRef(false);
  const calibrationResizeStart = useRef({ x: 0, y: 0, width: 0, height: 0 });
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const carouselRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  const dragContainerRef = useRef<HTMLDivElement | null>(null);
  
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!generatedDesign?.generatedImageUrl) return;
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    dragContainerRef.current = e.currentTarget;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current || !dragContainerRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    
    const rect = dragContainerRef.current.getBoundingClientRect();
    
    if (rect.width === 0 || rect.height === 0) return;
    
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    
    if (dx === 0 && dy === 0) return;
    
    const deltaX = (dx / rect.width) * 100;
    const deltaY = (dy / rect.height) * 100;
    
    setImagePosition(prev => ({
      x: Math.max(-50, Math.min(150, prev.x + deltaX)),
      y: Math.max(-50, Math.min(150, prev.y + deltaY)),
    }));
    dragStartRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
    dragContainerRef.current = null;
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

  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
  });

  const { data: customer, isLoading: customerLoading } = useQuery<Customer>({
    queryKey: ["/api/customer"],
    enabled: isAuthenticated,
  });

  const generateMutation = useMutation({
    mutationFn: async (data: { prompt: string; stylePreset: string; size: string; frameColor: string; referenceImage?: string }) => {
      const response = await apiRequest("POST", "/api/generate", data);
      return response.json();
    },
    onSuccess: (data) => {
      const design = data.design;
      setGeneratedDesign(design);
      setSelectedSize(design.size);
      setSelectedFrameColor(design.frameColor);
      setImageScale(design.transformScale ?? 100);
      setImagePosition({ x: design.transformX ?? 50, y: design.transformY ?? 50 });
      queryClient.invalidateQueries({ queryKey: ["/api/customer"] });
      queryClient.invalidateQueries({ queryKey: ["/api/designs"] });
      toast({
        title: "Artwork generated!",
        description: `You have ${data.creditsRemaining} credits remaining.`,
      });
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
    setImageScale(100);
    setImagePosition({ x: 50, y: 50 });
  };

  const centerImage = () => {
    setImagePosition({ x: 50, y: 50 });
  };

  const handleSizeChange = (newSize: string) => {
    setSelectedSize(newSize);
  };

  const handleFrameColorChange = (newColor: string) => {
    setSelectedFrameColor(newColor);
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
    if (!generatedDesign?.generatedImageUrl) return;
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
    }, {
      onSuccess: () => {
        setTweakPrompt("");
        setShowTweak(false);
      }
    });
  };

  const selectedSizeConfig = config?.sizes.find(s => s.id === selectedSize);
  const selectedFrameColorConfig = config?.frameColors.find(f => f.id === selectedFrameColor);
  
  const getLifestyleMockup = () => {
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
        {config?.sizes.map((size) => (
          <Button
            key={size.id}
            variant={selectedSize === size.id ? "default" : "outline"}
            className="h-auto py-2 flex flex-col text-xs"
            onClick={() => handleSizeChange(size.id)}
            data-testid={`button-size-${size.id}`}
          >
            <span className="font-medium">{size.name}</span>
            <span className="text-[10px] opacity-70">{size.aspectRatio}</span>
          </Button>
        ))}
      </div>
    </div>
  );

  const frameColorSelector = (
    <div className="space-y-2">
      <Label className="text-sm font-medium">Frame</Label>
      <div className="flex gap-2">
        {config?.frameColors.map((color) => (
          <button
            key={color.id}
            className={`w-10 h-10 rounded-md border-2 transition-all ${
              selectedFrameColor === color.id
                ? "border-primary ring-2 ring-primary ring-offset-2"
                : "border-muted"
            }`}
            style={{ backgroundColor: color.hex }}
            onClick={() => handleFrameColorChange(color.id)}
            title={color.name}
            data-testid={`button-frame-${color.id}`}
          />
        ))}
      </div>
    </div>
  );

  const styleSelector = (
    <div className="space-y-2">
      <Label className="text-sm font-medium">Style</Label>
      <Select value={selectedStyle} onValueChange={setSelectedStyle}>
        <SelectTrigger data-testid="select-style" className="h-9">
          <SelectValue placeholder="Choose a style" />
        </SelectTrigger>
        <SelectContent>
          {config?.stylePresets.map((style) => (
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

  const zoomControls = generatedDesign?.generatedImageUrl && (
    <div className="flex items-center gap-2 p-2 bg-muted/50 rounded-md">
      <ZoomIn className="h-4 w-4 text-muted-foreground shrink-0" />
      <Slider
        value={[imageScale]}
        onValueChange={([value]) => setImageScale(value)}
        min={25}
        max={200}
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
    </div>
  );

  const actionButtons = generatedDesign && (
    <div className="flex gap-2">
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
      <Button className="flex-1" data-testid="button-order">
        <ShoppingCart className="h-4 w-4 mr-2" />
        Order Print
      </Button>
    </div>
  );

  const previewMockup = (
    <div 
      className={`relative bg-muted rounded-md flex items-center justify-center w-full h-full ${generatedDesign?.generatedImageUrl ? 'cursor-move select-none' : ''}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <div
        className="absolute inset-3 rounded-sm flex items-center justify-center"
        style={{ backgroundColor: selectedFrameColorConfig?.hex || "#1a1a1a", pointerEvents: 'none' }}
      >
        <div 
          className="absolute inset-4 bg-white dark:bg-gray-200 rounded-sm flex items-center justify-center overflow-hidden"
          style={{ pointerEvents: 'none' }}
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
    </div>
  );

  // Get the frame area to use (calibration or default)
  const activeFrameArea = calibrationMode && calibrationArea ? calibrationArea : currentLifestyle?.frameArea;

  // Calculate corrected overlay dimensions that maintain print aspect ratio
  // The issue: width% and height% map to different pixel lengths if container isn't square
  // Solution: Adjust height% to maintain correct visual aspect ratio based on container dimensions
  const getCorrectedFrameStyle = () => {
    if (!activeFrameArea) return {};
    
    const img = mockupImgRef.current;
    if (!img || img.clientWidth === 0 || img.clientHeight === 0) {
      return {
        top: `${activeFrameArea.top}%`,
        left: `${activeFrameArea.left}%`,
        width: `${activeFrameArea.width}%`,
        height: `${activeFrameArea.height}%`,
      };
    }
    
    const containerWidth = img.clientWidth;
    const containerHeight = img.clientHeight;
    
    // Get the print aspect ratio (width / height, e.g., 1 for square)
    const printAspectRatio = selectedSizeConfig 
      ? selectedSizeConfig.width / selectedSizeConfig.height 
      : 3 / 4;
    
    // Calculate width in pixels from percentage
    const widthPx = (activeFrameArea.width / 100) * containerWidth;
    
    // Calculate the height in pixels that maintains the print aspect ratio
    const heightPx = widthPx / printAspectRatio;
    
    // Convert height back to percentage of container height
    const correctedHeightPercent = (heightPx / containerHeight) * 100;
    
    return {
      top: `${activeFrameArea.top}%`,
      left: `${activeFrameArea.left}%`,
      width: `${activeFrameArea.width}%`,
      height: `${correctedHeightPercent}%`,
    };
  };

  const lifestyleMockup = currentLifestyle && (
    <div 
      ref={calibrationRef}
      className="relative w-full h-full"
      onMouseMove={calibrationMode ? handleCalibrationMouseMove : undefined}
      onMouseUp={calibrationMode ? handleCalibrationMouseUp : undefined}
      onMouseLeave={calibrationMode ? handleCalibrationMouseUp : undefined}
    >
      <img
        ref={mockupImgRef}
        src={currentLifestyle.src}
        alt="Lifestyle mockup"
        className="w-full h-full object-contain rounded-md"
        onLoad={(e) => {
          const img = e.currentTarget;
          setMockupDimensions({ width: img.clientWidth, height: img.clientHeight });
        }}
      />
      {activeFrameArea && (
        <div
          className={`absolute ${calibrationMode ? 'border-2 border-dashed border-blue-500 cursor-move' : 'overflow-hidden'}`}
          style={getCorrectedFrameStyle()}
          onMouseDown={calibrationMode ? handleCalibrationMouseDown : undefined}
        >
          {generatedDesign?.generatedImageUrl && (
            <img
              src={generatedDesign.generatedImageUrl}
              alt="Artwork in lifestyle"
              className={`absolute inset-0 w-full h-full ${calibrationMode ? 'opacity-70' : ''}`}
              style={{
                objectFit: 'cover',
              }}
            />
          )}
          {calibrationMode && (
            <>
              {/* Resize handle */}
              <div
                className="absolute bottom-0 right-0 w-4 h-4 bg-blue-500 cursor-se-resize"
                onMouseDown={handleCalibrationResizeMouseDown}
              />
              {/* Coordinate display */}
              <div className="absolute -top-6 left-0 text-xs bg-blue-500 text-white px-1 rounded whitespace-nowrap">
                T:{activeFrameArea.top.toFixed(1)} L:{activeFrameArea.left.toFixed(1)} W:{activeFrameArea.width.toFixed(1)} H:{activeFrameArea.height.toFixed(1)}
              </div>
            </>
          )}
        </div>
      )}
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

  const tweakPanel = showTweak && (
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
            {customerLoading ? (
              <Skeleton className="h-5 w-20" />
            ) : (
              <span className="text-sm text-muted-foreground" data-testid="text-credits">
                {customer?.credits ?? 0} credits
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Desktop Layout - Three columns */}
      <main className="hidden lg:flex flex-1 overflow-hidden">
        <div className="w-full max-w-6xl mx-auto px-4 py-3 flex flex-col h-full">
          <div className="flex-1 flex gap-4 min-h-0">
            {/* Left column: Controls */}
            <div className="w-72 shrink-0 space-y-3 overflow-y-auto">
              {styleSelector}
              {sizeSelector}
              {frameColorSelector}
              {promptInput}
              {generateButton}
            </div>
            
            {/* Center: Front view */}
            <div className="flex-1 flex flex-col items-center min-w-0">
              <h3 className="text-sm font-medium mb-2">Front</h3>
              <div className="flex-1 flex items-center justify-center min-h-0 w-full overflow-hidden">
                <div 
                  className="max-h-full max-w-full"
                  style={{ 
                    aspectRatio: selectedSizeConfig ? `${selectedSizeConfig.width}/${selectedSizeConfig.height}` : "3/4",
                    width: selectedSizeConfig && selectedSizeConfig.width >= selectedSizeConfig.height ? '100%' : 'auto',
                    height: selectedSizeConfig && selectedSizeConfig.height > selectedSizeConfig.width ? '100%' : 'auto',
                  }}
                >
                  {previewMockup}
                </div>
              </div>
              <div className="mt-1 h-6 flex items-center justify-center">
                {tweakLink}
              </div>
              {tweakPanel && <div className="mt-2 w-full max-w-xs">{tweakPanel}</div>}
            </div>
            
            {/* Right: Lifestyle view */}
            <div className="flex-1 flex flex-col items-center min-w-0">
              <h3 className="text-sm font-medium mb-2">Lifestyle</h3>
              <div className="flex-1 flex items-center justify-center min-h-0 w-full">
                <div className="max-h-full h-full max-w-full">
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
              {styleSelector}
              {sizeSelector}
              {frameColorSelector}
              {promptInput}
              {generateButton}
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
                  disabled={!currentLifestyle}
                  data-testid="button-view-lifestyle"
                >
                  Lifestyle
                </Button>
              </div>
              
              {zoomControls}
              
              {/* Conditionally show Front or Lifestyle */}
              {mobileViewMode === "front" ? (
                <div className="space-y-1">
                  <div className="w-full" style={{ aspectRatio: selectedSizeConfig ? `${selectedSizeConfig.width}/${selectedSizeConfig.height}` : "3/4" }}>
                    {previewMockup}
                  </div>
                  <div className="flex justify-center">{tweakLink}</div>
                  {tweakPanel}
                </div>
              ) : (
                <div className="w-full">
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
    </div>
  );
}
