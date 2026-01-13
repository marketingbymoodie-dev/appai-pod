import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Package, Plus, Trash2, Edit2, Download, Search, Loader2, ExternalLink, RefreshCw, Settings, Info, Palette, Upload } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import AdminLayout from "@/components/admin-layout";
import type { ProductType, Merchant } from "@shared/schema";

interface VariantOption {
  id: string;
  name: string;
  hex?: string;
  width?: number;
  height?: number;
}

interface PrintifyBlueprint {
  id: number;
  title: string;
  description: string;
  brand: string;
  model: string;
  images: string[];
}

interface PrintifyProvider {
  id: number;
  title: string;
  location?: {
    address1?: string;
    address2?: string;
    city?: string;
    country?: string;
    region?: string;
    zip?: string;
  };
  fulfillment_countries?: string[];
}

export default function AdminProducts() {
  const { toast } = useToast();
  
  const [printifyImportOpen, setPrintifyImportOpen] = useState(false);
  const [blueprintSearch, setBlueprintSearch] = useState("");
  const [selectedBlueprint, setSelectedBlueprint] = useState<PrintifyBlueprint | null>(null);
  const [providerSelectionOpen, setProviderSelectionOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<PrintifyProvider | null>(null);
  const [providerLocationFilter, setProviderLocationFilter] = useState("");
  
  // Variant selection step
  const [variantSelectionOpen, setVariantSelectionOpen] = useState(false);
  const [availableSizes, setAvailableSizes] = useState<VariantOption[]>([]);
  const [availableColors, setAvailableColors] = useState<VariantOption[]>([]);
  const [selectedSizeIds, setSelectedSizeIds] = useState<Set<string>>(new Set());
  const [selectedColorIds, setSelectedColorIds] = useState<Set<string>>(new Set());
  const [variantDataLoading, setVariantDataLoading] = useState(false);
  
  // Edit variants for existing product
  const [editVariantsOpen, setEditVariantsOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<ProductType | null>(null);

  const { data: merchant } = useQuery<Merchant>({
    queryKey: ["/api/merchant"],
  });

  const { data: productTypes, isLoading: productTypesLoading } = useQuery<ProductType[]>({
    queryKey: ["/api/product-types"],
  });

  const { data: printifyBlueprints, isLoading: blueprintsLoading, refetch: refetchBlueprints, isFetching: blueprintsFetching } = useQuery<PrintifyBlueprint[]>({
    queryKey: ["/api/admin/printify/blueprints"],
    queryFn: async () => {
      const response = await fetch("/api/admin/printify/blueprints", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch blueprints");
      return response.json();
    },
    enabled: false,
  });

  const { data: printifyProviders, isLoading: providersLoading } = useQuery<PrintifyProvider[]>({
    queryKey: ["/api/admin/printify/blueprints", selectedBlueprint?.id, "providers"],
    queryFn: async () => {
      if (!selectedBlueprint) return [];
      const response = await fetch(`/api/admin/printify/blueprints/${selectedBlueprint.id}/providers`, {
        credentials: "include"
      });
      if (!response.ok) throw new Error("Failed to fetch providers");
      return response.json();
    },
    enabled: !!selectedBlueprint && providerSelectionOpen,
  });

  const { data: allProviders } = useQuery<PrintifyProvider[]>({
    queryKey: ["/api/admin/printify/providers"],
    queryFn: async () => {
      const response = await fetch("/api/admin/printify/providers", {
        credentials: "include"
      });
      if (!response.ok) throw new Error("Failed to fetch providers");
      return response.json();
    },
    enabled: printifyImportOpen && !!merchant?.printifyApiToken,
    staleTime: 5 * 60 * 1000,
  });

  const availableLocations = useMemo(() => {
    if (!allProviders) return [];
    const countries = new Set<string>();
    allProviders.forEach(p => {
      if (p.location?.country) countries.add(p.location.country);
      p.fulfillment_countries?.forEach(c => countries.add(c));
    });
    return Array.from(countries).sort();
  }, [allProviders]);

  // Calculate variant count based on selections
  const variantCount = useMemo(() => {
    const sizeCount = selectedSizeIds.size || 1;
    const colorCount = selectedColorIds.size || (availableColors.length === 0 ? 1 : 0);
    return sizeCount * (colorCount || 1);
  }, [selectedSizeIds.size, selectedColorIds.size, availableColors.length]);
  
  const isVariantCountValid = variantCount <= 100 && variantCount > 0;

  const importPrintifyMutation = useMutation({
    mutationFn: async (data: { 
      blueprintId: number; 
      name: string; 
      description?: string; 
      providerId?: number;
      selectedSizeIds?: string[];
      selectedColorIds?: string[];
    }) => {
      const response = await apiRequest("POST", "/api/admin/printify/import", data);
      return response.json();
    },
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
      setPrintifyImportOpen(false);
      setProviderSelectionOpen(false);
      setVariantSelectionOpen(false);
      setSelectedBlueprint(null);
      setSelectedProvider(null);
      setSelectedSizeIds(new Set());
      setSelectedColorIds(new Set());
      setAvailableSizes([]);
      setAvailableColors([]);
      setBlueprintSearch("");
      toast({ title: "Blueprint imported", description: "Product type created from Printify catalog." });
      
      // Auto-refresh images for the newly imported product
      if (data?.id) {
        try {
          await apiRequest("POST", `/api/admin/product-types/${data.id}/refresh-images`);
          queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
        } catch (e) {
          // Silent fail for image refresh - product was still imported successfully
          console.log("Auto-image refresh skipped:", e);
        }
      }
    },
    onError: (error: Error) => {
      toast({ title: "Failed to import blueprint", description: error.message, variant: "destructive" });
    },
  });
  
  const updateVariantsMutation = useMutation({
    mutationFn: async (data: { productTypeId: number; selectedSizeIds: string[]; selectedColorIds: string[] }) => {
      const response = await apiRequest("PATCH", `/api/admin/product-types/${data.productTypeId}/variants`, {
        selectedSizeIds: data.selectedSizeIds,
        selectedColorIds: data.selectedColorIds,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
      setEditVariantsOpen(false);
      setEditingProduct(null);
      setSelectedSizeIds(new Set());
      setSelectedColorIds(new Set());
      toast({ title: "Variants updated", description: "Selected variants have been saved." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update variants", description: error.message, variant: "destructive" });
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

  const refreshImagesMutation = useMutation({
    mutationFn: async (id: number) => {
      const response = await apiRequest("POST", `/api/admin/product-types/${id}/refresh-images`);
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
      const hasImages = data.baseMockupImages?.front || data.baseMockupImages?.lifestyle;
      toast({ 
        title: hasImages ? "Images refreshed" : "No images available",
        description: hasImages ? "Product placeholder images updated from Printify." : "This product type has no placeholder images in Printify."
      });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to refresh images", description: error.message, variant: "destructive" });
    },
  });

  const refreshColorsMutation = useMutation({
    mutationFn: async (id: number) => {
      const response = await apiRequest("POST", `/api/admin/product-types/${id}/refresh-colors`);
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
      toast({ 
        title: "Colors refreshed",
        description: data.updatedCount > 0 
          ? `Updated ${data.updatedCount} color${data.updatedCount !== 1 ? 's' : ''} with new hex values.`
          : "All colors already have the latest hex values."
      });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to refresh colors", description: error.message, variant: "destructive" });
    },
  });

  // Fetch connected Shopify shops
  const { data: shopifyShops } = useQuery<{ shops: Array<{ id: number; shopDomain: string }> }>({
    queryKey: ["/api/shopify/shops"],
  });

  // Update Shopify product mutation
  const updateShopifyProductMutation = useMutation({
    mutationFn: async (data: { productTypeId: number; shopDomain: string }) => {
      const response = await apiRequest("PUT", `/api/shopify/products/${data.productTypeId}`, {
        shopDomain: data.shopDomain,
      });
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
      toast({ 
        title: "Shopify product updated",
        description: "The product description has been refreshed with the latest design studio embed."
      });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update Shopify product", description: error.message, variant: "destructive" });
    },
  });

  const handleUpdateShopifyProduct = (productType: ProductType) => {
    if (!productType.shopifyProductId) {
      toast({ title: "Not published", description: "This product hasn't been sent to Shopify yet.", variant: "destructive" });
      return;
    }
    
    // Extract shop domain from the stored shopifyProductUrl (e.g., https://shop.myshopify.com/admin/products/123)
    let shopDomain = "";
    if (productType.shopifyProductUrl) {
      try {
        const url = new URL(productType.shopifyProductUrl);
        shopDomain = url.hostname;
      } catch (e) {
        console.error("Failed to parse shopifyProductUrl:", e);
      }
    }
    
    // Fallback to first connected shop if URL parsing fails
    if (!shopDomain || !shopDomain.includes(".myshopify.com")) {
      const shop = shopifyShops?.shops?.[0];
      if (!shop) {
        toast({ title: "No Shopify store", description: "Please connect a Shopify store first.", variant: "destructive" });
        return;
      }
      shopDomain = shop.shopDomain;
    }
    
    updateShopifyProductMutation.mutate({ 
      productTypeId: productType.id, 
      shopDomain: shopDomain 
    });
  };

  const handleOpenPrintifyImport = async () => {
    setPrintifyImportOpen(true);
    if (!printifyBlueprints) {
      refetchBlueprints();
    }
  };


  const filteredBlueprints = useMemo(() => {
    if (!printifyBlueprints) return [];
    return printifyBlueprints.filter(bp => {
      const matchesSearch = !blueprintSearch || 
        bp.title.toLowerCase().includes(blueprintSearch.toLowerCase()) ||
        bp.brand.toLowerCase().includes(blueprintSearch.toLowerCase());
      
      return matchesSearch;
    });
  }, [printifyBlueprints, blueprintSearch]);

  const filteredProviders = useMemo(() => {
    if (!printifyProviders) return [];
    if (!providerLocationFilter || providerLocationFilter === "all") return printifyProviders;
    
    return printifyProviders.filter(p => 
      p.location?.country === providerLocationFilter ||
      p.fulfillment_countries?.includes(providerLocationFilter)
    );
  }, [printifyProviders, providerLocationFilter]);

  // Load variant data for the selected blueprint/provider
  const loadVariantData = async () => {
    if (!selectedBlueprint) return;
    
    setVariantDataLoading(true);
    try {
      const url = selectedProvider 
        ? `/api/admin/printify/blueprints/${selectedBlueprint.id}/variants?providerId=${selectedProvider.id}`
        : `/api/admin/printify/blueprints/${selectedBlueprint.id}/variants`;
      
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch variants");
      
      const data = await response.json();
      setAvailableSizes(data.sizes || []);
      setAvailableColors(data.colors || []);
      
      // Select all by default
      setSelectedSizeIds(new Set(data.sizes?.map((s: VariantOption) => s.id) || []));
      setSelectedColorIds(new Set(data.colors?.map((c: VariantOption) => c.id) || []));
    } catch (e) {
      console.error("Failed to load variant data:", e);
      toast({ title: "Failed to load variants", variant: "destructive" });
    } finally {
      setVariantDataLoading(false);
    }
  };
  
  const handleProceedToVariants = async () => {
    setProviderSelectionOpen(false);
    setVariantSelectionOpen(true);
    await loadVariantData();
  };

  const handleImportBlueprint = async () => {
    if (!selectedBlueprint) return;
    if (!isVariantCountValid) return;
    
    importPrintifyMutation.mutate({
      blueprintId: selectedBlueprint.id,
      name: selectedBlueprint.title,
      description: selectedBlueprint.description,
      providerId: selectedProvider?.id,
      selectedSizeIds: Array.from(selectedSizeIds),
      selectedColorIds: Array.from(selectedColorIds),
    });
  };
  
  const toggleSize = (sizeId: string) => {
    setSelectedSizeIds(prev => {
      const next = new Set(prev);
      if (next.has(sizeId)) {
        next.delete(sizeId);
      } else {
        next.add(sizeId);
      }
      return next;
    });
  };
  
  const toggleColor = (colorId: string) => {
    setSelectedColorIds(prev => {
      const next = new Set(prev);
      if (next.has(colorId)) {
        next.delete(colorId);
      } else {
        next.add(colorId);
      }
      return next;
    });
  };
  
  const handleEditVariants = (product: ProductType) => {
    setEditingProduct(product);
    
    // Parse existing selections
    const sizes = typeof product.sizes === 'string' ? JSON.parse(product.sizes || "[]") : product.sizes || [];
    const colors = typeof product.frameColors === 'string' ? JSON.parse(product.frameColors || "[]") : product.frameColors || [];
    const savedSizeIds = typeof product.selectedSizeIds === 'string' ? JSON.parse(product.selectedSizeIds || "[]") : product.selectedSizeIds || [];
    const savedColorIds = typeof product.selectedColorIds === 'string' ? JSON.parse(product.selectedColorIds || "[]") : product.selectedColorIds || [];
    
    setAvailableSizes(sizes);
    setAvailableColors(colors);
    
    // If no saved selection, select all
    setSelectedSizeIds(new Set(savedSizeIds.length > 0 ? savedSizeIds : sizes.map((s: VariantOption) => s.id)));
    setSelectedColorIds(new Set(savedColorIds.length > 0 ? savedColorIds : colors.map((c: VariantOption) => c.id)));
    
    setEditVariantsOpen(true);
  };
  
  const handleSaveVariants = () => {
    if (!editingProduct) return;
    updateVariantsMutation.mutate({
      productTypeId: editingProduct.id,
      selectedSizeIds: Array.from(selectedSizeIds),
      selectedColorIds: Array.from(selectedColorIds),
    });
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-products-title">Products</h1>
            <p className="text-muted-foreground">Manage your product types for the AI design studio</p>
          </div>
          <Button onClick={handleOpenPrintifyImport} disabled={!merchant?.printifyApiToken} data-testid="button-import-printify">
            <Download className="h-4 w-4 mr-2" />
            Import from Printify
          </Button>
        </div>

        {!merchant?.printifyApiToken && (
          <Card className="border-yellow-200 bg-yellow-50 dark:bg-yellow-900/20 dark:border-yellow-800">
            <CardContent className="pt-6">
              <p className="text-sm">
                Connect your Printify account in{" "}
                <a href="/admin/settings" className="text-primary underline">Settings</a>
                {" "}to import products from the Printify catalog.
              </p>
            </CardContent>
          </Card>
        )}

        {productTypesLoading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-48" />
            ))}
          </div>
        ) : productTypes && productTypes.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {productTypes.map((pt) => {
              const mockupImages = typeof pt.baseMockupImages === 'string' 
                ? JSON.parse(pt.baseMockupImages || "{}") 
                : pt.baseMockupImages || {};
              const productImage = mockupImages.front || mockupImages.lifestyle;
              
              return (
                <Card key={pt.id} data-testid={`card-product-${pt.id}`}>
                  {productImage && (
                    <div className="w-full h-40 overflow-hidden rounded-t-lg bg-muted">
                      <img 
                        src={productImage} 
                        alt={pt.name} 
                        className="w-full h-full object-contain"
                        data-testid={`img-product-${pt.id}`}
                      />
                    </div>
                  )}
                  {!productImage && (
                    <div className="w-full h-40 flex flex-col items-center justify-center bg-muted rounded-t-lg gap-2">
                      <Package className="h-10 w-10 text-muted-foreground" />
                      {pt.printifyBlueprintId && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => refreshImagesMutation.mutate(pt.id)}
                          disabled={refreshImagesMutation.isPending}
                          data-testid={`button-refresh-images-${pt.id}`}
                        >
                          <RefreshCw className={`h-3 w-3 mr-1 ${refreshImagesMutation.isPending ? 'animate-spin' : ''}`} />
                          Load Image
                        </Button>
                      )}
                    </div>
                  )}
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <CardTitle className="text-base">{pt.name}</CardTitle>
                        <CardDescription className="text-xs mt-1">
                          Blueprint: {pt.printifyBlueprintId || "Custom"}
                        </CardDescription>
                      </div>
                      <Badge variant="outline" className="text-xs">
                        {pt.designerType}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="text-sm text-muted-foreground space-y-1">
                      <div>Aspect Ratio: {pt.aspectRatio}</div>
                      <div>Sizes: {JSON.parse(pt.sizes || "[]").length}</div>
                      <div>Colors: {JSON.parse(pt.frameColors || "[]").length}</div>
                    </div>
                    <div className="flex gap-2 mt-4 flex-wrap">
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => window.location.href = `/admin/create-product?productTypeId=${pt.id}`}
                        data-testid={`button-test-${pt.id}`}
                      >
                        Test Generator
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => handleEditVariants(pt)}
                        data-testid={`button-edit-variants-${pt.id}`}
                      >
                        <Settings className="h-3 w-3 mr-1" />
                        Variants
                      </Button>
                      {pt.printifyBlueprintId && JSON.parse(pt.frameColors || "[]").length > 0 && (
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={() => refreshColorsMutation.mutate(pt.id)}
                          disabled={refreshColorsMutation.isPending}
                          data-testid={`button-refresh-colors-${pt.id}`}
                        >
                          <Palette className={`h-3 w-3 mr-1 ${refreshColorsMutation.isPending ? 'animate-pulse' : ''}`} />
                          Refresh Colors
                        </Button>
                      )}
                      {pt.shopifyProductId && (
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={() => handleUpdateShopifyProduct(pt)}
                          disabled={updateShopifyProductMutation.isPending}
                          data-testid={`button-update-shopify-${pt.id}`}
                        >
                          <Upload className={`h-3 w-3 mr-1 ${updateShopifyProductMutation.isPending ? 'animate-spin' : ''}`} />
                          Update Shopify
                        </Button>
                      )}
                      <Button 
                        variant="ghost" 
                        size="icon"
                        onClick={() => deleteProductTypeMutation.mutate(pt.id)}
                        data-testid={`button-delete-${pt.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="font-medium mb-2">No products yet</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Import products from Printify to get started
              </p>
              <Button onClick={handleOpenPrintifyImport} disabled={!merchant?.printifyApiToken}>
                <Download className="h-4 w-4 mr-2" />
                Import from Printify
              </Button>
            </CardContent>
          </Card>
        )}

        <Dialog open={printifyImportOpen} onOpenChange={setPrintifyImportOpen}>
          <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Import from Printify Catalog</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex gap-2 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <Input
                    placeholder="Search blueprints..."
                    value={blueprintSearch}
                    onChange={(e) => setBlueprintSearch(e.target.value)}
                    data-testid="input-blueprint-search"
                  />
                </div>
              </div>

              {blueprintsFetching ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              ) : (
                <div className="grid gap-3 max-h-[400px] overflow-y-auto">
                  {filteredBlueprints.slice(0, 50).map((bp) => (
                    <Card 
                      key={bp.id} 
                      className={`cursor-pointer hover-elevate ${selectedBlueprint?.id === bp.id ? 'ring-2 ring-primary' : ''}`}
                      onClick={() => {
                        setSelectedBlueprint(bp);
                        setProviderSelectionOpen(true);
                      }}
                    >
                      <CardContent className="p-4 flex items-center gap-4">
                        {bp.images[0] && (
                          <img src={bp.images[0]} alt={bp.title} className="w-16 h-16 object-cover rounded" />
                        )}
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium truncate">{bp.title}</h4>
                          <p className="text-sm text-muted-foreground">{bp.brand}</p>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={providerSelectionOpen} onOpenChange={setProviderSelectionOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Select Print Provider</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {selectedBlueprint && (
                <div className="p-3 bg-muted rounded-lg">
                  <p className="font-medium">{selectedBlueprint.title}</p>
                  <p className="text-sm text-muted-foreground">{selectedBlueprint.brand}</p>
                </div>
              )}

              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <Label className="text-sm font-medium">Filter by location</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-6 w-6" data-testid="button-provider-location-info">
                        <Info className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-72 text-sm">
                      <p><strong>Location</strong> refers to the production facility.</p>
                      <p className="mt-2 text-muted-foreground">Suppliers may still ship internationally. Check the Printify listing for detailed shipping info.</p>
                    </PopoverContent>
                  </Popover>
                </div>
                <Select value={providerLocationFilter || undefined} onValueChange={(val) => setProviderLocationFilter(val === "all" ? "" : val)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Filter by location" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All locations</SelectItem>
                    {availableLocations.map(loc => (
                      <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {providersLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              ) : filteredProviders.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <p className="text-sm">No print providers available for this product.</p>
                  <p className="text-xs mt-1">Try selecting a different product or adjusting the location filter.</p>
                </div>
              ) : (
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {filteredProviders.map((provider) => (
                    <Card
                      key={provider.id}
                      className={`cursor-pointer hover-elevate ${selectedProvider?.id === provider.id ? 'ring-2 ring-primary' : ''}`}
                      onClick={() => setSelectedProvider(provider)}
                    >
                      <CardContent className="p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <p className="font-medium">{provider.title}</p>
                            {(provider.location?.city || provider.location?.country) && (
                              <p className="text-sm text-muted-foreground">
                                {[provider.location?.city, provider.location?.country].filter(Boolean).join(', ')}
                              </p>
                            )}
                          </div>
                          {provider.fulfillment_countries && provider.fulfillment_countries.length > 0 && (
                            <Badge variant="secondary" className="text-xs">
                              Ships to {provider.fulfillment_countries.length} {provider.fulfillment_countries.length === 1 ? 'country' : 'countries'}
                            </Badge>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setProviderSelectionOpen(false)}>
                  Cancel
                </Button>
                <Button 
                  onClick={handleProceedToVariants}
                  disabled={!selectedBlueprint}
                >
                  Select Variants
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
        
        {/* Variant Selection Dialog */}
        <Dialog open={variantSelectionOpen} onOpenChange={setVariantSelectionOpen}>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Select Variants</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {selectedBlueprint && (
                <div className="p-3 bg-muted rounded-lg">
                  <p className="font-medium">{selectedBlueprint.title}</p>
                  {selectedProvider && (
                    <p className="text-sm text-muted-foreground">{selectedProvider.title}</p>
                  )}
                </div>
              )}
              
              {/* Variant Count Display */}
              <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                <span className="text-sm font-medium">Total Variants:</span>
                <span className={`text-lg font-bold ${isVariantCountValid ? 'text-green-600' : 'text-red-600'}`}>
                  {variantCount}
                </span>
              </div>
              
              {!isVariantCountValid && (
                <p className="text-sm text-red-600">
                  Shopify allows maximum 100 variants. Deselect some options to continue.
                </p>
              )}
              
              {variantDataLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Sizes Section */}
                  {availableSizes.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm font-medium">Sizes ({selectedSizeIds.size}/{availableSizes.length})</Label>
                        <div className="flex gap-2">
                          <Button 
                            variant="ghost" 
                            size="sm"
                            onClick={() => setSelectedSizeIds(new Set(availableSizes.map(s => s.id)))}
                          >
                            Select all
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="sm"
                            onClick={() => setSelectedSizeIds(new Set())}
                          >
                            Clear all
                          </Button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-40 overflow-y-auto border rounded-md p-2">
                        {availableSizes.map((size) => (
                          <label 
                            key={size.id}
                            htmlFor={`size-${size.id}`}
                            className="flex items-center gap-2 p-1.5 hover:bg-muted rounded cursor-pointer"
                          >
                            <Checkbox 
                              id={`size-${size.id}`}
                              checked={selectedSizeIds.has(size.id)}
                              onCheckedChange={() => toggleSize(size.id)}
                            />
                            <span className="text-sm">{size.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {/* Colors Section */}
                  {availableColors.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm font-medium">Colors ({selectedColorIds.size}/{availableColors.length})</Label>
                        <div className="flex gap-2">
                          <Button 
                            variant="ghost" 
                            size="sm"
                            onClick={() => setSelectedColorIds(new Set(availableColors.map(c => c.id)))}
                          >
                            Select all
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="sm"
                            onClick={() => setSelectedColorIds(new Set())}
                          >
                            Clear all
                          </Button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-40 overflow-y-auto border rounded-md p-2">
                        {availableColors.map((color) => (
                          <label 
                            key={color.id}
                            htmlFor={`color-${color.id}`}
                            className="flex items-center gap-2 p-1.5 hover:bg-muted rounded cursor-pointer"
                          >
                            <Checkbox 
                              id={`color-${color.id}`}
                              checked={selectedColorIds.has(color.id)}
                              onCheckedChange={() => toggleColor(color.id)}
                            />
                            <div 
                              className="w-4 h-4 rounded-full border border-border flex-shrink-0 flex items-center justify-center text-[8px] text-muted-foreground"
                              style={color.hex ? { backgroundColor: color.hex } : { backgroundColor: 'var(--muted)' }}
                            >
                              {!color.hex && color.name?.charAt(0).toUpperCase()}
                            </div>
                            <span className="text-sm truncate">{color.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setVariantSelectionOpen(false)}>
                  Cancel
                </Button>
                <Button 
                  onClick={handleImportBlueprint}
                  disabled={!isVariantCountValid || importPrintifyMutation.isPending}
                >
                  {importPrintifyMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : null}
                  Import Product
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
        
        {/* Edit Variants Dialog */}
        <Dialog open={editVariantsOpen} onOpenChange={setEditVariantsOpen}>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Variants</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {editingProduct && (
                <div className="p-3 bg-muted rounded-lg">
                  <p className="font-medium">{editingProduct.name}</p>
                </div>
              )}
              
              {/* Variant Count Display */}
              <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                <span className="text-sm font-medium">Total Variants:</span>
                <span className={`text-lg font-bold ${isVariantCountValid ? 'text-green-600' : 'text-red-600'}`}>
                  {variantCount}
                </span>
              </div>
              
              {!isVariantCountValid && (
                <p className="text-sm text-red-600">
                  Shopify allows maximum 100 variants. Deselect some options to continue.
                </p>
              )}
              
              <div className="space-y-6">
                {/* Sizes Section */}
                {availableSizes.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Sizes ({selectedSizeIds.size}/{availableSizes.length})</Label>
                      <div className="flex gap-2">
                        <Button 
                          variant="ghost" 
                          size="sm"
                          onClick={() => setSelectedSizeIds(new Set(availableSizes.map(s => s.id)))}
                        >
                          Select all
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="sm"
                          onClick={() => setSelectedSizeIds(new Set())}
                        >
                          Clear all
                        </Button>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-40 overflow-y-auto border rounded-md p-2">
                      {availableSizes.map((size) => (
                        <label 
                          key={size.id}
                          htmlFor={`edit-size-${size.id}`}
                          className="flex items-center gap-2 p-1.5 hover:bg-muted rounded cursor-pointer"
                        >
                          <Checkbox 
                            id={`edit-size-${size.id}`}
                            checked={selectedSizeIds.has(size.id)}
                            onCheckedChange={() => toggleSize(size.id)}
                          />
                          <span className="text-sm">{size.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Colors Section */}
                {availableColors.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Colors ({selectedColorIds.size}/{availableColors.length})</Label>
                      <div className="flex gap-2">
                        <Button 
                          variant="ghost" 
                          size="sm"
                          onClick={() => setSelectedColorIds(new Set(availableColors.map(c => c.id)))}
                        >
                          Select all
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="sm"
                          onClick={() => setSelectedColorIds(new Set())}
                        >
                          Clear all
                        </Button>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-40 overflow-y-auto border rounded-md p-2">
                      {availableColors.map((color) => (
                        <label 
                          key={color.id}
                          htmlFor={`edit-color-${color.id}`}
                          className="flex items-center gap-2 p-1.5 hover:bg-muted rounded cursor-pointer"
                        >
                          <Checkbox 
                            id={`edit-color-${color.id}`}
                            checked={selectedColorIds.has(color.id)}
                            onCheckedChange={() => toggleColor(color.id)}
                          />
                          <div 
                            className="w-4 h-4 rounded-full border border-border flex-shrink-0 flex items-center justify-center text-[8px] text-muted-foreground"
                            style={color.hex ? { backgroundColor: color.hex } : { backgroundColor: 'var(--muted)' }}
                          >
                            {!color.hex && color.name?.charAt(0).toUpperCase()}
                          </div>
                          <span className="text-sm truncate">{color.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEditVariantsOpen(false)}>
                  Cancel
                </Button>
                <Button 
                  onClick={handleSaveVariants}
                  disabled={!isVariantCountValid || updateVariantsMutation.isPending}
                >
                  {updateVariantsMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : null}
                  Save Variants
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
