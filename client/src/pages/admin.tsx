import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link } from "wouter";
import { ArrowLeft, Settings, BarChart3, Save, CheckCircle, AlertCircle, Ticket, Palette, Plus, Trash2, Edit2, Package, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { Merchant, Coupon, StylePresetDB, ProductType } from "@shared/schema";

interface GenerationStats {
  total: number;
  successful: number;
  failed: number;
}

export default function AdminPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const [printifyToken, setPrintifyToken] = useState("");
  const [printifyShopId, setPrintifyShopId] = useState("");
  const [useBuiltIn, setUseBuiltIn] = useState(true);
  const [customToken, setCustomToken] = useState("");

  const [couponDialogOpen, setCouponDialogOpen] = useState(false);
  const [newCouponCode, setNewCouponCode] = useState("");
  const [newCouponCredits, setNewCouponCredits] = useState("5");
  const [newCouponMaxUses, setNewCouponMaxUses] = useState("");

  const [styleDialogOpen, setStyleDialogOpen] = useState(false);
  const [editingStyle, setEditingStyle] = useState<StylePresetDB | null>(null);
  const [styleName, setStyleName] = useState("");
  const [stylePrompt, setStylePrompt] = useState("");

  const [productTypeDialogOpen, setProductTypeDialogOpen] = useState(false);
  const [editingProductType, setEditingProductType] = useState<ProductType | null>(null);
  const [productTypeName, setProductTypeName] = useState("");
  const [productTypeDescription, setProductTypeDescription] = useState("");
  const [productTypeBlueprintId, setProductTypeBlueprintId] = useState("");
  const [productTypeAspectRatio, setProductTypeAspectRatio] = useState("3:4");
  const [productTypeSizes, setProductTypeSizes] = useState("");
  const [productTypeFrameColors, setProductTypeFrameColors] = useState("");

  const { data: merchant, isLoading: merchantLoading } = useQuery<Merchant>({
    queryKey: ["/api/merchant"],
    enabled: isAuthenticated,
  });

  const { data: stats } = useQuery<GenerationStats>({
    queryKey: ["/api/admin/stats"],
    enabled: isAuthenticated && !!merchant,
  });

  const { data: coupons, isLoading: couponsLoading } = useQuery<Coupon[]>({
    queryKey: ["/api/admin/coupons"],
    enabled: isAuthenticated,
  });

  const { data: styles, isLoading: stylesLoading } = useQuery<StylePresetDB[]>({
    queryKey: ["/api/admin/styles"],
    enabled: isAuthenticated,
  });

  const { data: productTypes, isLoading: productTypesLoading } = useQuery<ProductType[]>({
    queryKey: ["/api/product-types"],
    enabled: isAuthenticated,
  });

  const createProductTypeMutation = useMutation({
    mutationFn: async (data: { name: string; description: string; printifyBlueprintId?: number; aspectRatio: string; sizes: any[]; frameColors: any[] }) => {
      const response = await apiRequest("POST", "/api/admin/product-types", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
      setProductTypeDialogOpen(false);
      resetProductTypeForm();
      toast({ title: "Product type created", description: "Your product type is ready to use." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create product type", description: error.message, variant: "destructive" });
    },
  });

  const updateProductTypeMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: number; name: string; description: string; printifyBlueprintId?: number; aspectRatio: string; sizes: any[]; frameColors: any[] }) => {
      const response = await apiRequest("PATCH", `/api/admin/product-types/${id}`, data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
      setProductTypeDialogOpen(false);
      resetProductTypeForm();
      toast({ title: "Product type updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update product type", description: error.message, variant: "destructive" });
    },
  });

  const deleteProductTypeMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/admin/product-types/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
      toast({ title: "Product type deleted" });
    },
  });

  const resetProductTypeForm = () => {
    setEditingProductType(null);
    setProductTypeName("");
    setProductTypeDescription("");
    setProductTypeBlueprintId("");
    setProductTypeAspectRatio("3:4");
    setProductTypeSizes("");
    setProductTypeFrameColors("");
  };

  const openEditProductType = (pt: ProductType) => {
    setEditingProductType(pt);
    setProductTypeName(pt.name);
    setProductTypeDescription(pt.description || "");
    setProductTypeBlueprintId(pt.printifyBlueprintId?.toString() || "");
    setProductTypeAspectRatio(pt.aspectRatio);
    try {
      const sizes = JSON.parse(pt.sizes);
      setProductTypeSizes(sizes.map((s: any) => `${s.id}:${s.name}:${s.width}x${s.height}`).join("\n"));
    } catch { setProductTypeSizes(""); }
    try {
      const colors = JSON.parse(pt.frameColors);
      setProductTypeFrameColors(colors.map((c: any) => `${c.id}:${c.name}:${c.hex}`).join("\n"));
    } catch { setProductTypeFrameColors(""); }
    setProductTypeDialogOpen(true);
  };

  const handleProductTypeSubmit = () => {
    const sizes = productTypeSizes.split("\n").filter(Boolean).map(line => {
      const [id, name, dims] = line.split(":");
      const [width, height] = (dims || "").split("x").map(Number);
      return { id: id?.trim(), name: name?.trim(), width: width || 0, height: height || 0 };
    });
    const frameColors = productTypeFrameColors.split("\n").filter(Boolean).map(line => {
      const [id, name, hex] = line.split(":");
      return { id: id?.trim(), name: name?.trim(), hex: hex?.trim() || "#000000" };
    });

    const data = {
      name: productTypeName,
      description: productTypeDescription,
      printifyBlueprintId: productTypeBlueprintId ? parseInt(productTypeBlueprintId) : undefined,
      aspectRatio: productTypeAspectRatio,
      sizes,
      frameColors,
    };

    if (editingProductType) {
      updateProductTypeMutation.mutate({ id: editingProductType.id, ...data });
    } else {
      createProductTypeMutation.mutate(data);
    }
  };

  const seedProductTypesMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/product-types/seed");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
      toast({ title: "Product types seeded", description: "Default product types have been created." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to seed product types", description: error.message, variant: "destructive" });
    },
  });

  const seedStylesMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/styles/seed");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/styles"] });
    },
  });

  useEffect(() => {
    if (isAuthenticated && styles && styles.length === 0) {
      seedStylesMutation.mutate();
    }
  }, [isAuthenticated, styles]);

  const createCouponMutation = useMutation({
    mutationFn: async (data: { code: string; creditAmount: number; maxUses?: number }) => {
      const response = await apiRequest("POST", "/api/admin/coupons", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/coupons"] });
      setCouponDialogOpen(false);
      setNewCouponCode("");
      setNewCouponCredits("5");
      setNewCouponMaxUses("");
      toast({ title: "Coupon created", description: "Your coupon code is ready to use." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create coupon", description: error.message, variant: "destructive" });
    },
  });

  const toggleCouponMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: number; isActive: boolean }) => {
      const response = await apiRequest("PATCH", `/api/admin/coupons/${id}`, { isActive });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/coupons"] });
    },
  });

  const deleteCouponMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/admin/coupons/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/coupons"] });
      toast({ title: "Coupon deleted" });
    },
  });

  const createStyleMutation = useMutation({
    mutationFn: async (data: { name: string; promptPrefix: string }) => {
      const response = await apiRequest("POST", "/api/admin/styles", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/styles"] });
      setStyleDialogOpen(false);
      setStyleName("");
      setStylePrompt("");
      toast({ title: "Style created" });
    },
    onError: () => {
      toast({ title: "Failed to create style", variant: "destructive" });
    },
  });

  const updateStyleMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: number; name?: string; promptPrefix?: string; isActive?: boolean }) => {
      const response = await apiRequest("PATCH", `/api/admin/styles/${id}`, data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/styles"] });
      setEditingStyle(null);
      setStyleDialogOpen(false);
      setStyleName("");
      setStylePrompt("");
      toast({ title: "Style updated" });
    },
  });

  const deleteStyleMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/admin/styles/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/styles"] });
      toast({ title: "Style deleted" });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (data: Partial<Merchant>) => {
      const response = await apiRequest("PUT", "/api/merchant", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/merchant"] });
      toast({
        title: "Settings saved",
        description: "Your merchant settings have been updated.",
      });
    },
    onError: () => {
      toast({
        title: "Save failed",
        description: "Failed to save settings",
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

  const handleSave = () => {
    saveMutation.mutate({
      printifyApiToken: printifyToken || merchant?.printifyApiToken,
      printifyShopId: printifyShopId || merchant?.printifyShopId,
      useBuiltInNanoBanana: useBuiltIn,
      customNanoBananaToken: customToken || merchant?.customNanoBananaToken,
    });
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 bg-background z-50">
        <div className="container mx-auto px-4 py-3 flex items-center gap-4">
          <Link href="/">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <h1 className="text-lg font-semibold">Merchant Admin</h1>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <Tabs defaultValue="settings">
          <TabsList className="mb-6 flex-wrap gap-1">
            <TabsTrigger value="settings" data-testid="tab-settings">
              <Settings className="h-4 w-4 mr-2" />
              Settings
            </TabsTrigger>
            <TabsTrigger value="coupons" data-testid="tab-coupons">
              <Ticket className="h-4 w-4 mr-2" />
              Coupons
            </TabsTrigger>
            <TabsTrigger value="styles" data-testid="tab-styles">
              <Palette className="h-4 w-4 mr-2" />
              Styles
            </TabsTrigger>
            <TabsTrigger value="stats" data-testid="tab-stats">
              <BarChart3 className="h-4 w-4 mr-2" />
              Statistics
            </TabsTrigger>
            <TabsTrigger value="products" data-testid="tab-products">
              <Package className="h-4 w-4 mr-2" />
              Product Types
            </TabsTrigger>
          </TabsList>

          <TabsContent value="settings">
            <div className="grid gap-6 max-w-2xl">
              <Card>
                <CardHeader>
                  <CardTitle>Printify Integration</CardTitle>
                  <CardDescription>
                    Connect your Printify account to enable print fulfillment
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="printify-token">API Token</Label>
                    <Input
                      id="printify-token"
                      type="password"
                      placeholder="Enter your Printify API token"
                      value={printifyToken}
                      onChange={(e) => setPrintifyToken(e.target.value)}
                      data-testid="input-printify-token"
                    />
                    <p className="text-xs text-muted-foreground">
                      Get your API token from Printify Settings &gt; API
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="printify-shop">Shop ID</Label>
                    <Input
                      id="printify-shop"
                      placeholder="Your Printify Shop ID"
                      value={printifyShopId}
                      onChange={(e) => setPrintifyShopId(e.target.value)}
                      data-testid="input-printify-shop"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    {merchant?.printifyApiToken ? (
                      <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                        <CheckCircle className="h-4 w-4" />
                        <span className="text-sm">Connected</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <AlertCircle className="h-4 w-4" />
                        <span className="text-sm">Not connected</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>AI Image Generation</CardTitle>
                  <CardDescription>
                    Configure how AI artwork is generated
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <Label>Use Built-in Nano Banana</Label>
                      <p className="text-xs text-muted-foreground">
                        Uses Replit credits for image generation
                      </p>
                    </div>
                    <Switch
                      checked={useBuiltIn}
                      onCheckedChange={setUseBuiltIn}
                      data-testid="switch-builtin"
                    />
                  </div>
                  
                  {!useBuiltIn && (
                    <div className="space-y-2">
                      <Label htmlFor="custom-token">Custom API Token</Label>
                      <Input
                        id="custom-token"
                        type="password"
                        placeholder="Enter your Nano Banana API token"
                        value={customToken}
                        onChange={(e) => setCustomToken(e.target.value)}
                        data-testid="input-custom-token"
                      />
                      <p className="text-xs text-muted-foreground">
                        Use your own API token for unlimited generations
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Subscription</CardTitle>
                  <CardDescription>
                    Your current plan and usage limits
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {merchantLoading ? (
                    <Skeleton className="h-20 w-full" />
                  ) : (
                    <div className="space-y-3">
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">Current Plan</span>
                        <span className="font-medium capitalize">{merchant?.subscriptionTier || "Free"}</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">Monthly Limit</span>
                        <span>{merchant?.monthlyGenerationLimit || 100} generations</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">Used This Month</span>
                        <span>{merchant?.generationsThisMonth || 0} generations</span>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Button onClick={handleSave} disabled={saveMutation.isPending} data-testid="button-save">
                <Save className="h-4 w-4 mr-2" />
                {saveMutation.isPending ? "Saving..." : "Save Settings"}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="coupons">
            <div className="max-w-3xl">
              <div className="flex items-center justify-between gap-4 mb-6">
                <div>
                  <h2 className="text-lg font-semibold">Coupon Codes</h2>
                  <p className="text-sm text-muted-foreground">Create codes to give customers free credits</p>
                </div>
                <Dialog open={couponDialogOpen} onOpenChange={setCouponDialogOpen}>
                  <DialogTrigger asChild>
                    <Button data-testid="button-create-coupon">
                      <Plus className="h-4 w-4 mr-2" />
                      Create Coupon
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Create Coupon Code</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 mt-4">
                      <div className="space-y-2">
                        <Label htmlFor="coupon-code">Code</Label>
                        <Input
                          id="coupon-code"
                          placeholder="e.g., WELCOME10"
                          value={newCouponCode}
                          onChange={(e) => setNewCouponCode(e.target.value.toUpperCase())}
                          data-testid="input-coupon-code"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="coupon-credits">Credits to Give</Label>
                        <Input
                          id="coupon-credits"
                          type="number"
                          min="1"
                          value={newCouponCredits}
                          onChange={(e) => setNewCouponCredits(e.target.value)}
                          data-testid="input-coupon-credits"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="coupon-max-uses">Max Uses (optional)</Label>
                        <Input
                          id="coupon-max-uses"
                          type="number"
                          min="1"
                          placeholder="Unlimited"
                          value={newCouponMaxUses}
                          onChange={(e) => setNewCouponMaxUses(e.target.value)}
                          data-testid="input-coupon-max-uses"
                        />
                      </div>
                      <Button
                        className="w-full"
                        onClick={() => createCouponMutation.mutate({
                          code: newCouponCode,
                          creditAmount: parseInt(newCouponCredits),
                          maxUses: newCouponMaxUses ? parseInt(newCouponMaxUses) : undefined,
                        })}
                        disabled={!newCouponCode || !newCouponCredits || createCouponMutation.isPending}
                        data-testid="button-submit-coupon"
                      >
                        {createCouponMutation.isPending ? "Creating..." : "Create Coupon"}
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>

              {couponsLoading ? (
                <Skeleton className="h-48 w-full" />
              ) : coupons && coupons.length > 0 ? (
                <div className="space-y-3">
                  {coupons.map((coupon) => (
                    <Card key={coupon.id} data-testid={`card-coupon-${coupon.id}`}>
                      <CardContent className="flex items-center justify-between gap-4 py-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-3 flex-wrap">
                            <code className="font-mono font-bold text-lg" data-testid={`text-coupon-code-${coupon.id}`}>{coupon.code}</code>
                            {!coupon.isActive && (
                              <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">Disabled</span>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground mt-1">
                            {coupon.creditAmount} credits | Used: {coupon.usedCount}{coupon.maxUses ? ` / ${coupon.maxUses}` : ""}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={coupon.isActive}
                            onCheckedChange={(checked) => toggleCouponMutation.mutate({ id: coupon.id, isActive: checked })}
                            data-testid={`switch-coupon-${coupon.id}`}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => deleteCouponMutation.mutate(coupon.id)}
                            data-testid={`button-delete-coupon-${coupon.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <Card>
                  <CardContent className="py-8 text-center">
                    <Ticket className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground">No coupons yet. Create your first coupon code above.</p>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="styles">
            <div className="max-w-3xl">
              <div className="flex items-center justify-between gap-4 mb-6">
                <div>
                  <h2 className="text-lg font-semibold">Style Presets</h2>
                  <p className="text-sm text-muted-foreground">Customize art styles available to customers</p>
                </div>
                <Dialog open={styleDialogOpen} onOpenChange={(open) => {
                  setStyleDialogOpen(open);
                  if (!open) {
                    setEditingStyle(null);
                    setStyleName("");
                    setStylePrompt("");
                  }
                }}>
                  <DialogTrigger asChild>
                    <Button data-testid="button-create-style">
                      <Plus className="h-4 w-4 mr-2" />
                      New Style
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>{editingStyle ? "Edit Style" : "Create Style"}</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 mt-4">
                      <div className="space-y-2">
                        <Label htmlFor="style-name">Style Name</Label>
                        <Input
                          id="style-name"
                          placeholder="e.g., Watercolor Dreams"
                          value={styleName}
                          onChange={(e) => setStyleName(e.target.value)}
                          data-testid="input-style-name"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="style-prompt">Prompt Prefix</Label>
                        <Textarea
                          id="style-prompt"
                          placeholder="e.g., A beautiful watercolor painting of..."
                          value={stylePrompt}
                          onChange={(e) => setStylePrompt(e.target.value)}
                          rows={3}
                          data-testid="input-style-prompt"
                        />
                        <p className="text-xs text-muted-foreground">This text is prepended to customer prompts</p>
                      </div>
                      <Button
                        className="w-full"
                        onClick={() => {
                          if (editingStyle) {
                            updateStyleMutation.mutate({
                              id: editingStyle.id,
                              name: styleName,
                              promptPrefix: stylePrompt,
                            });
                          } else {
                            createStyleMutation.mutate({
                              name: styleName,
                              promptPrefix: stylePrompt,
                            });
                          }
                        }}
                        disabled={!styleName || (editingStyle ? updateStyleMutation.isPending : createStyleMutation.isPending)}
                        data-testid="button-submit-style"
                      >
                        {editingStyle
                          ? (updateStyleMutation.isPending ? "Saving..." : "Save Changes")
                          : (createStyleMutation.isPending ? "Creating..." : "Create Style")}
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>

              {stylesLoading ? (
                <Skeleton className="h-48 w-full" />
              ) : styles && styles.length > 0 ? (
                <div className="space-y-3">
                  {styles.map((style) => (
                    <Card key={style.id} data-testid={`card-style-${style.id}`}>
                      <CardContent className="flex items-center justify-between gap-4 py-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-3 flex-wrap">
                            <span className="font-medium" data-testid={`text-style-name-${style.id}`}>{style.name}</span>
                            {!style.isActive && (
                              <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">Hidden</span>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground mt-1 truncate">
                            {style.promptPrefix || "(No prompt prefix)"}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={style.isActive}
                            onCheckedChange={(checked) => updateStyleMutation.mutate({ id: style.id, isActive: checked })}
                            data-testid={`switch-style-${style.id}`}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setEditingStyle(style);
                              setStyleName(style.name);
                              setStylePrompt(style.promptPrefix);
                              setStyleDialogOpen(true);
                            }}
                            data-testid={`button-edit-style-${style.id}`}
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => deleteStyleMutation.mutate(style.id)}
                            data-testid={`button-delete-style-${style.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <Card>
                  <CardContent className="py-8 text-center">
                    <Palette className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground">Loading default styles...</p>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="stats">
            <div className="grid gap-6 sm:grid-cols-3 max-w-3xl">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Total Generations</CardDescription>
                  <CardTitle className="text-3xl" data-testid="text-total-generations">
                    {stats?.total ?? 0}
                  </CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Successful</CardDescription>
                  <CardTitle className="text-3xl text-green-600 dark:text-green-400" data-testid="text-successful">
                    {stats?.successful ?? 0}
                  </CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Failed</CardDescription>
                  <CardTitle className="text-3xl text-destructive" data-testid="text-failed">
                    {stats?.failed ?? 0}
                  </CardTitle>
                </CardHeader>
              </Card>
            </div>

            <Card className="mt-6 max-w-3xl">
              <CardHeader>
                <CardTitle>Recent Activity</CardTitle>
                <CardDescription>
                  Generation activity over the past 30 days
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Detailed analytics coming soon. Track customer generations, popular styles, and conversion rates.
                </p>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="products">
            <div className="max-w-3xl">
              <div className="flex items-center justify-between gap-4 mb-6">
                <div>
                  <h2 className="text-lg font-semibold">Product Types</h2>
                  <p className="text-sm text-muted-foreground">Configure different products for the design studio (Framed Prints, Pillows, Mugs, etc.)</p>
                </div>
                <Dialog open={productTypeDialogOpen} onOpenChange={(open) => { if (!open) resetProductTypeForm(); setProductTypeDialogOpen(open); }}>
                  <DialogTrigger asChild>
                    <Button data-testid="button-create-product-type">
                      <Plus className="h-4 w-4 mr-2" />
                      Add Product Type
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-lg">
                    <DialogHeader>
                      <DialogTitle>{editingProductType ? "Edit Product Type" : "Create Product Type"}</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 mt-4 max-h-[60vh] overflow-y-auto pr-2">
                      <div className="space-y-2">
                        <Label htmlFor="pt-name">Name</Label>
                        <Input
                          id="pt-name"
                          placeholder="e.g., Framed Prints"
                          value={productTypeName}
                          onChange={(e) => setProductTypeName(e.target.value)}
                          data-testid="input-product-type-name"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="pt-description">Description</Label>
                        <Textarea
                          id="pt-description"
                          placeholder="High-quality framed artwork prints..."
                          value={productTypeDescription}
                          onChange={(e) => setProductTypeDescription(e.target.value)}
                          data-testid="input-product-type-description"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="pt-blueprint">Printify Blueprint ID</Label>
                        <Input
                          id="pt-blueprint"
                          type="number"
                          placeholder="e.g., 540"
                          value={productTypeBlueprintId}
                          onChange={(e) => setProductTypeBlueprintId(e.target.value)}
                          data-testid="input-product-type-blueprint"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="pt-aspect">Aspect Ratio</Label>
                        <Input
                          id="pt-aspect"
                          placeholder="e.g., 3:4"
                          value={productTypeAspectRatio}
                          onChange={(e) => setProductTypeAspectRatio(e.target.value)}
                          data-testid="input-product-type-aspect"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="pt-sizes">Sizes (one per line: id:name:widthxheight)</Label>
                        <Textarea
                          id="pt-sizes"
                          placeholder={"11x14:11\" x 14\":11x14\n12x16:12\" x 16\":12x16"}
                          value={productTypeSizes}
                          onChange={(e) => setProductTypeSizes(e.target.value)}
                          className="min-h-[100px] font-mono text-sm"
                          data-testid="input-product-type-sizes"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="pt-colors">Frame Colors (one per line: id:name:hex)</Label>
                        <Textarea
                          id="pt-colors"
                          placeholder={"black:Black:#1a1a1a\nwhite:White:#f5f5f5"}
                          value={productTypeFrameColors}
                          onChange={(e) => setProductTypeFrameColors(e.target.value)}
                          className="min-h-[80px] font-mono text-sm"
                          data-testid="input-product-type-colors"
                        />
                      </div>
                      <Button
                        className="w-full"
                        onClick={handleProductTypeSubmit}
                        disabled={!productTypeName || createProductTypeMutation.isPending || updateProductTypeMutation.isPending}
                        data-testid="button-submit-product-type"
                      >
                        {editingProductType ? "Update Product Type" : "Create Product Type"}
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>

              {productTypesLoading ? (
                <div className="space-y-4">
                  <Skeleton className="h-32 w-full" />
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : productTypes && productTypes.length > 0 ? (
                <div className="space-y-4">
                  {productTypes.map((pt) => {
                    let sizes: any[] = [];
                    let frameColors: any[] = [];
                    try { sizes = JSON.parse(pt.sizes); } catch {}
                    try { frameColors = JSON.parse(pt.frameColors); } catch {}
                    
                    return (
                      <Card key={pt.id} data-testid={`card-product-type-${pt.id}`}>
                        <CardHeader className="flex flex-row items-start justify-between gap-4 pb-2">
                          <div>
                            <CardTitle className="text-base">{pt.name}</CardTitle>
                            <CardDescription>{pt.description || "No description"}</CardDescription>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => openEditProductType(pt)}
                              data-testid={`button-edit-product-type-${pt.id}`}
                            >
                              <Edit2 className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => deleteProductTypeMutation.mutate(pt.id)}
                              disabled={deleteProductTypeMutation.isPending}
                              data-testid={`button-delete-product-type-${pt.id}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                              <span className="text-muted-foreground">Blueprint ID:</span>{" "}
                              <span className="font-medium">{pt.printifyBlueprintId || "Not set"}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Aspect Ratio:</span>{" "}
                              <span className="font-medium">{pt.aspectRatio}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Sizes:</span>{" "}
                              <span className="font-medium">{sizes.length} options</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Frame Colors:</span>{" "}
                              <span className="font-medium">{frameColors.length} options</span>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              ) : (
                <Card>
                  <CardContent className="py-8 text-center">
                    <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground mb-4">No product types configured yet.</p>
                    <div className="flex flex-wrap items-center justify-center gap-3">
                      <Button 
                        onClick={() => seedProductTypesMutation.mutate()} 
                        disabled={seedProductTypesMutation.isPending}
                        data-testid="button-seed-product-types"
                      >
                        {seedProductTypesMutation.isPending ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Plus className="h-4 w-4 mr-2" />
                        )}
                        Load Default Product Types
                      </Button>
                      <Button variant="outline" onClick={() => setProductTypeDialogOpen(true)} data-testid="button-add-first-product-type">
                        <Plus className="h-4 w-4 mr-2" />
                        Create Custom
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
