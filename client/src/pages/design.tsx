import { useState, useRef, useCallback } from "react";
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
import { ArrowLeft, Upload, X, Loader2, Sparkles, ShoppingCart, Save, ZoomIn, Move } from "lucide-react";
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
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!generatedDesign?.generatedImageUrl) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
  }, [generatedDesign]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging || !previewContainerRef.current) return;
    
    const container = previewContainerRef.current;
    const rect = container.getBoundingClientRect();
    const deltaX = ((e.clientX - dragStart.x) / rect.width) * 100;
    const deltaY = ((e.clientY - dragStart.y) / rect.height) * 100;
    
    setImagePosition(prev => ({
      x: Math.max(0, Math.min(100, prev.x + deltaX)),
      y: Math.max(0, Math.min(100, prev.y + deltaY)),
    }));
    setDragStart({ x: e.clientX, y: e.clientY });
  }, [isDragging, dragStart]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

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
      setGeneratedDesign(data.design);
      setImageScale(100);
      setImagePosition({ x: 50, y: 50 });
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
    mutationFn: async (data: { designId: number; transformScale: number; transformX: number; transformY: number }) => {
      const response = await apiRequest("PATCH", `/api/designs/${data.designId}`, {
        transformScale: data.transformScale,
        transformX: data.transformX,
        transformY: data.transformY,
      });
      return response.json();
    },
    onSuccess: (data) => {
      setGeneratedDesign(data);
      queryClient.invalidateQueries({ queryKey: ["/api/designs"] });
      toast({
        title: "Design saved!",
        description: "Your artwork adjustments have been saved.",
      });
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

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 bg-background z-50">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link href="/">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <h1 className="text-lg font-semibold">Create Design</h1>
          </div>
          <div className="flex items-center gap-4">
            {customerLoading ? (
              <Skeleton className="h-6 w-24" />
            ) : (
              <span className="text-sm text-muted-foreground" data-testid="text-credits">
                {customer?.credits ?? 0} credits
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>1. Select Size</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {config?.sizes.map((size) => (
                    <Button
                      key={size.id}
                      variant={selectedSize === size.id ? "default" : "outline"}
                      className="h-auto py-3 flex flex-col toggle-elevate"
                      onClick={() => setSelectedSize(size.id)}
                      data-testid={`button-size-${size.id}`}
                    >
                      <span className="font-medium">{size.name}</span>
                      <span className="text-xs opacity-70">{size.aspectRatio}</span>
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>2. Frame Color</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex gap-3">
                  {config?.frameColors.map((color) => (
                    <button
                      key={color.id}
                      className={`w-12 h-12 rounded-md border-2 transition-all ${
                        selectedFrameColor === color.id
                          ? "border-primary ring-2 ring-primary ring-offset-2"
                          : "border-muted"
                      }`}
                      style={{ backgroundColor: color.hex }}
                      onClick={() => setSelectedFrameColor(color.id)}
                      title={color.name}
                      data-testid={`button-frame-${color.id}`}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>3. Style Preset</CardTitle>
              </CardHeader>
              <CardContent>
                <Select value={selectedStyle} onValueChange={setSelectedStyle}>
                  <SelectTrigger data-testid="select-style">
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
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>4. Describe Your Artwork</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="prompt">What do you want to create?</Label>
                  <Textarea
                    id="prompt"
                    placeholder="A serene mountain landscape at sunset with a calm lake in the foreground..."
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    className="mt-2 min-h-[100px]"
                    data-testid="input-prompt"
                  />
                </div>
                
                <div>
                  <Label>Reference Image (Optional)</Label>
                  <p className="text-xs text-muted-foreground mb-2">
                    Upload an image for the AI to use as inspiration
                  </p>
                  
                  {referenceImage ? (
                    <div className="relative inline-block">
                      <img
                        src={referenceImage}
                        alt="Reference"
                        className="max-h-32 rounded-md"
                      />
                      <Button
                        variant="destructive"
                        size="icon"
                        className="absolute -top-2 -right-2 h-6 w-6"
                        onClick={() => setReferenceImage(null)}
                        data-testid="button-remove-reference"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={() => fileInputRef.current?.click()}
                      data-testid="button-upload-reference"
                    >
                      <Upload className="h-4 w-4 mr-2" />
                      Upload Reference
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
              </CardContent>
            </Card>

            <Button
              size="lg"
              className="w-full"
              onClick={handleGenerate}
              disabled={generateMutation.isPending}
              data-testid="button-generate"
            >
              {generateMutation.isPending ? (
                <>
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles className="h-5 w-5 mr-2" />
                  Generate Artwork (1 Credit)
                </>
              )}
            </Button>

            {(customer?.credits ?? 0) <= 0 && (
              <p className="text-sm text-destructive text-center">
                You're out of credits. Purchase more to continue creating.
              </p>
            )}
          </div>

          <div className="lg:sticky lg:top-20 lg:self-start space-y-4">
            <Card className="overflow-hidden">
              <CardHeader>
                <CardTitle>Preview</CardTitle>
              </CardHeader>
              <CardContent>
                <div 
                  ref={previewContainerRef}
                  className={`relative bg-muted rounded-md overflow-hidden flex items-center justify-center ${generatedDesign?.generatedImageUrl ? 'cursor-move' : ''}`}
                  style={{ 
                    aspectRatio: selectedSizeConfig ? `${selectedSizeConfig.width}/${selectedSizeConfig.height}` : "3/4",
                  }}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseUp}
                >
                  <div
                    className="absolute inset-2 rounded-sm flex items-center justify-center"
                    style={{ backgroundColor: selectedFrameColorConfig?.hex || "#1a1a1a" }}
                  >
                    <div className="bg-white dark:bg-gray-200 w-[calc(100%-16px)] h-[calc(100%-16px)] rounded-sm flex items-center justify-center overflow-hidden">
                      {generateMutation.isPending ? (
                        <div className="flex flex-col items-center gap-3 text-muted-foreground">
                          <Loader2 className="h-12 w-12 animate-spin" />
                          <span className="text-sm">Creating your artwork...</span>
                        </div>
                      ) : generatedDesign?.generatedImageUrl ? (
                        <img
                          src={generatedDesign.generatedImageUrl}
                          alt="Generated artwork"
                          className="select-none pointer-events-none absolute"
                          style={{
                            width: `${imageScale}%`,
                            height: `${imageScale}%`,
                            objectFit: 'cover',
                            left: `${imagePosition.x}%`,
                            top: `${imagePosition.y}%`,
                            transform: 'translate(-50%, -50%)',
                          }}
                          draggable={false}
                          data-testid="img-generated"
                        />
                      ) : (
                        <div className="text-center text-muted-foreground p-4">
                          <Sparkles className="h-12 w-12 mx-auto mb-3 opacity-50" />
                          <p className="text-sm">Your artwork will appear here</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {selectedSizeConfig && (
                  <p className="text-center text-sm text-muted-foreground mt-4">
                    {selectedSizeConfig.name} - {selectedFrameColorConfig?.name} Frame
                  </p>
                )}

                {generatedDesign && (
                  <div className="mt-4 flex gap-3">
                    <Button 
                      variant="outline" 
                      className="flex-1" 
                      onClick={() => saveMutation.mutate({
                        designId: generatedDesign.id,
                        transformScale: imageScale,
                        transformX: imagePosition.x,
                        transformY: imagePosition.y,
                      })}
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
                )}
              </CardContent>
            </Card>

            {generatedDesign?.generatedImageUrl && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Move className="h-4 w-4" />
                    Adjust Printable Area
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-4">
                      <Label className="flex items-center gap-2">
                        <ZoomIn className="h-4 w-4" />
                        Size
                      </Label>
                      <span className="text-sm text-muted-foreground">{imageScale}%</span>
                    </div>
                    <Slider
                      value={[imageScale]}
                      onValueChange={([value]) => setImageScale(value)}
                      min={50}
                      max={200}
                      step={5}
                      data-testid="slider-scale"
                    />
                  </div>
                  
                  <p className="text-xs text-muted-foreground">
                    Drag the image to reposition it within the print area
                  </p>
                  
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={resetTransform}
                    className="w-full"
                    data-testid="button-reset-transform"
                  >
                    Reset Position
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
