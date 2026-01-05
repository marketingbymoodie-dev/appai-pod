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
import { ArrowLeft, Upload, X, Loader2, Sparkles, ShoppingCart, Save, ZoomIn, Move, ChevronLeft, ChevronRight, Crosshair } from "lucide-react";
import type { Customer, Design, PrintSize, FrameColor, StylePreset } from "@shared/schema";

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
  const [touchStart, setTouchStart] = useState<number | null>(null);
  
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

  const selectedSizeConfig = config?.sizes.find(s => s.id === selectedSize);
  const selectedFrameColorConfig = config?.frameColors.find(f => f.id === selectedFrameColor);

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
      className={`relative bg-muted rounded-md overflow-hidden flex items-center justify-center ${generatedDesign?.generatedImageUrl ? 'cursor-move select-none' : ''}`}
      style={{ 
        aspectRatio: selectedSizeConfig ? `${selectedSizeConfig.width}/${selectedSizeConfig.height}` : "3/4",
      }}
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

      {/* Desktop Layout - Two columns */}
      <main className="hidden lg:flex flex-1 overflow-hidden">
        <div className="w-full max-w-6xl mx-auto px-6 py-4 flex gap-8 h-full">
          {/* Left column: Controls */}
          <div className="w-80 shrink-0 overflow-y-auto space-y-5">
            {styleSelector}
            {sizeSelector}
            {promptInput}
            {generateButton}
          </div>
          
          {/* Right: Preview mockup with frame/zoom controls */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            <div className="flex-1 flex items-center justify-center min-h-0 py-2">
              <div className="max-h-full w-full max-w-md">
                {previewMockup}
              </div>
            </div>
            <div className="shrink-0 pt-4 space-y-4">
              <div className="flex items-end gap-4">
                <div className="flex-1">{zoomControls}</div>
                <div className="shrink-0">{frameColorSelector}</div>
              </div>
              {actionButtons}
            </div>
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
            {/* Slide 1: Style, Size, Prompt, Generate */}
            <div className="w-full h-full flex-shrink-0 overflow-y-auto p-4 space-y-4">
              {styleSelector}
              {sizeSelector}
              {promptInput}
              {generateButton}
            </div>
            
            {/* Slide 2: Preview with frame/zoom controls */}
            <div className="w-full h-full flex-shrink-0 overflow-y-auto p-4 space-y-3">
              <div className="flex items-end gap-3">
                <div className="flex-1">{zoomControls}</div>
                <div className="shrink-0">{frameColorSelector}</div>
              </div>
              {previewMockup}
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
