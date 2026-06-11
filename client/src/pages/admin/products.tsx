import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
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
import { Switch } from "@/components/ui/switch";
import { Package, Plus, Trash2, Edit2, Download, Search, Loader2, ExternalLink, RefreshCw, Settings, Info, Palette, Upload, FlaskConical, DollarSign } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import AdminLayout from "@/components/admin-layout";
import ResyncPricesDialog from "@/components/admin/ResyncPricesDialog";
import SizeChartTable from "@/components/SizeChartTable";
import { getSizeChartByBlueprintId } from "@/lib/printifySizeCharts";
import type { ProductType, Merchant } from "@shared/schema";
import { AOP_TEMPLATE_ADMIN_OPTIONS, AOP_TEMPLATE_SELECT_AUTO } from "@/components/designer/aopTemplates/registry";

interface VariantOption {
  id: string;
  name: string;
  hex?: string;
  width?: number;
  height?: number;
}

/** Returns "Models" for phone case products, "Colors" otherwise. */
function getColorOptionLabel(colors: VariantOption[]): string {
  if (!colors || colors.length === 0) return "Colors";
  const phoneModelPatterns = [
    /^iphone\s+(\d|x|xs|xr|se|pro|plus|max)/i,
    /^samsung\s+(galaxy|note)/i,
    /^galaxy\s+/i,
    /^pixel\s+\d/i,
    /^for\s+(iphone|galaxy|pixel|samsung)/i,
    /^(iphone|samsung|galaxy|pixel|oneplus|motorola|lg|htc)\b/i,
  ];
  const isPhoneModel = colors.some((c) =>
    phoneModelPatterns.some((p) => p.test((c.name || "").trim()))
  );
  return isPhoneModel ? "Models" : "Colors";
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

interface PlaceholderImageOption {
  url: string;
  label: string;
  position?: string;
  source?: string;
}

export default function AdminProducts() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  
  const [printifyImportOpen, setPrintifyImportOpen] = useState(false);
  const [blueprintSearch, setBlueprintSearch] = useState("");
  const [selectedBlueprint, setSelectedBlueprint] = useState<PrintifyBlueprint | null>(null);
  const [providerSelectionOpen, setProviderSelectionOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<PrintifyProvider | null>(null);
  const [providerLocationFilter, setProviderLocationFilter] = useState("");
  const [placeholderPrimaryUrl, setPlaceholderPrimaryUrl] = useState("");
  const [placeholderGalleryUrls, setPlaceholderGalleryUrls] = useState<Set<string>>(new Set());
  
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
  // Track which specific product is currently being refreshed/sent to Shopify
  const [shopifyMutatingProductId, setShopifyMutatingProductId] = useState<number | null>(null);
  const [refreshVariantsMutatingId, setRefreshVariantsMutatingId] = useState<number | null>(null);
  const [refreshColorsMutatingId, setRefreshColorsMutatingId] = useState<number | null>(null);
  const [aopTemplateMutatingId, setAopTemplateMutatingId] = useState<number | null>(null);
  const [testOrderMutatingId, setTestOrderMutatingId] = useState<number | null>(null);
  const [calibrateMutatingId, setCalibrateMutatingId] = useState<number | null>(null);
  const [resyncPricesTarget, setResyncPricesTarget] = useState<ProductType | null>(null);

  const { data: merchant } = useQuery<Merchant>({
    queryKey: ["/api/merchant"],
  });

  const { data: productTypes, isLoading: productTypesLoading } = useQuery<ProductType[]>({
    queryKey: ["/api/product-types"],
    // Calibration runs server-side for several minutes; poll while any product
    // is pending/running so the button doesn't stay on "Recalibrating…" until
    // a manual refresh.
    refetchInterval: (query) => {
      const pts = query.state.data as ProductType[] | undefined;
      const calibrating = pts?.some(
        (pt) => pt.flatCalibrationStatus === "pending" || pt.flatCalibrationStatus === "running",
      );
      return calibrating ? 15_000 : false;
    },
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

  const { data: placeholderOptionsData, isLoading: placeholderOptionsLoading } = useQuery<{ images: PlaceholderImageOption[] }>({
    queryKey: ["/api/admin/printify/placeholders", selectedBlueprint?.id, selectedProvider?.id],
    queryFn: async () => {
      if (!selectedBlueprint || !selectedProvider) return { images: [] };
      const response = await fetch(`/api/admin/printify/blueprints/${selectedBlueprint.id}/providers/${selectedProvider.id}/placeholders`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch placeholder images");
      return response.json();
    },
    enabled: !!selectedBlueprint && !!selectedProvider && variantSelectionOpen,
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

  const { data: selectedBlueprintSizeChart, isLoading: selectedBlueprintSizeChartLoading } = useQuery({
    queryKey: ["printify-size-chart", selectedBlueprint?.id],
    queryFn: () => getSizeChartByBlueprintId(selectedBlueprint!.id),
    enabled: !!selectedBlueprint,
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
      placeholderPrimaryUrl?: string;
      placeholderGalleryUrls?: string[];
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
      setPlaceholderPrimaryUrl("");
      setPlaceholderGalleryUrls(new Set());
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
      setRefreshColorsMutatingId(id);
      const response = await apiRequest("POST", `/api/admin/product-types/${id}/refresh-colors`);
      return response.json();
    },
    onSuccess: (data) => {
      setRefreshColorsMutatingId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
      toast({
        title: "Colors refreshed",
        description: data.updatedCount > 0
          ? `Updated ${data.updatedCount} color${data.updatedCount !== 1 ? 's' : ''} with new hex values.`
          : "All colors already have the latest hex values."
      });
    },
    onError: (error: Error) => {
      setRefreshColorsMutatingId(null);
      toast({ title: "Failed to refresh colors", description: error.message, variant: "destructive" });
    },
  });

  const refreshVariantsMutation = useMutation({
    mutationFn: async (id: number) => {
      setRefreshVariantsMutatingId(id);
      const response = await apiRequest("POST", `/api/admin/product-types/${id}/refresh-variants`);
      return response.json();
    },
    onSuccess: (data) => {
      setRefreshVariantsMutatingId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
      toast({
        title: "Variants refreshed",
        description: data.message || `Found ${data.sizes?.length || 0} sizes and ${data.frameColors?.length || 0} colors.`
      });
    },
    onError: (error: Error) => {
      setRefreshVariantsMutatingId(null);
      toast({ title: "Failed to refresh variants", description: error.message, variant: "destructive" });
    },
  });

  // Toggle isAllOverPrint flag
  const toggleAopMutation = useMutation({
    mutationFn: async (data: { id: number; isAllOverPrint: boolean }) => {
      const response = await apiRequest("PATCH", `/api/admin/product-types/${data.id}`, {
        isAllOverPrint: data.isAllOverPrint,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update AOP flag", description: error.message, variant: "destructive" });
    },
  });

  const updateAopTemplateMutation = useMutation({
    mutationFn: async (data: { id: number; aopTemplateId: string | null }) => {
      setAopTemplateMutatingId(data.id);
      const response = await apiRequest("PATCH", `/api/admin/product-types/${data.id}`, {
        aopTemplateId: data.aopTemplateId,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
      toast({ title: "AOP template updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update AOP template", description: error.message, variant: "destructive" });
    },
    onSettled: () => setAopTemplateMutatingId(null),
  });

  // Send a DRAFT test order to Printify so the merchant can verify the baked
  // print file matches the on-screen design before going live. Never produces
  // or charges — it creates a draft Printify order only.
  const testPrintifyOrderMutation = useMutation({
    mutationFn: async (id: number) => {
      setTestOrderMutatingId(id);
      const response = await apiRequest("POST", `/api/admin/product-types/${id}/test-printify-order`);
      return response.json();
    },
    onSuccess: (data) => {
      const url = data?.printifyOrderUrl as string | undefined;
      toast({
        title: "Draft test order created in Printify",
        description: data?.printifyOrderId
          ? `Order ${data.printifyOrderId} (DRAFT — not sent to production). Open it in Printify to verify the print file.`
          : "Draft order created. Open Printify to verify the print file.",
        action: url ? (
          <a href={url} target="_blank" rel="noopener noreferrer" className="underline text-xs">
            Open
          </a>
        ) : undefined,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Test order failed", description: error.message, variant: "destructive" });
    },
    onSettled: () => setTestOrderMutatingId(null),
  });

  // (Re)run on-the-fly flat/mesh calibration for an existing product. Only
  // surfaced for products that have never been calibrated (legacy imports) or
  // whose last run failed — new imports auto-calibrate, so this never lingers.
  const calibrateFlatMutation = useMutation({
    mutationFn: async (id: number) => {
      setCalibrateMutatingId(id);
      const response = await apiRequest("POST", `/api/admin/product-types/${id}/calibrate-flat`);
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Calibration started",
        description:
          "Harvesting masks and blank photos via Printify (up to 8 colours, not all variants). " +
          "Apparel with front + back usually takes 3–8 min. This page auto-refreshes status.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
    },
    onError: (error: Error) => {
      toast({ title: "Couldn't start calibration", description: error.message, variant: "destructive" });
    },
    onSettled: () => setCalibrateMutatingId(null),
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
      setShopifyMutatingProductId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
      toast({
        title: "Shopify product refreshed",
        description: "Product description and metafields updated. The correct design studio will now load."
      });
    },
    onError: (error: Error) => {
      setShopifyMutatingProductId(null);
      toast({ title: "Failed to update Shopify product", description: error.message, variant: "destructive" });
    },
  });

  const handleUpdateShopifyProduct = (productType: ProductType) => {
    // If not published, we'll send it to Shopify for the first time
    const isNew = !productType.shopifyProductId;
    
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
    
    setShopifyMutatingProductId(productType.id);
    updateShopifyProductMutation.mutate({ 
      productTypeId: productType.id, 
      shopDomain: shopDomain 
    }, {
      onSuccess: () => {
        toast({
          title: isNew ? "Product sent to Shopify" : "Shopify product refreshed",
          description: isNew 
            ? "The product has been created on your Shopify store."
            : "Product description and metafields updated."
        });
      }
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
    setPlaceholderPrimaryUrl("");
    setPlaceholderGalleryUrls(new Set());
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
      placeholderPrimaryUrl: placeholderPrimaryUrl || undefined,
      placeholderGalleryUrls: Array.from(placeholderGalleryUrls),
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

  const togglePlaceholderGalleryUrl = (url: string) => {
    setPlaceholderGalleryUrls(prev => {
      const next = new Set(prev);
      if (next.has(url)) {
        next.delete(url);
      } else if (next.size < 3) {
        next.add(url);
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
    
    // Use the saved selection as-is. An empty array means the merchant has explicitly
    // cleared all options (e.g. removed the stray '12 Pro' color from phone cases).
    // We only fall back to "select all" when the product has never been saved at all
    // (i.e. the product was imported before the variant-selection feature existed and
    // the DB still holds the schema default of '[]' for both fields AND the product
    // has never been explicitly saved via this modal).
    // Since the import flow always writes explicit IDs, an empty array here reliably
    // means "intentionally cleared" — so we respect it and show nothing checked.
    setSelectedSizeIds(new Set(savedSizeIds));
    setSelectedColorIds(new Set(savedColorIds));
    
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
              const productImage = mockupImages.primary || mockupImages.front || mockupImages.gallery?.[0] || mockupImages.lifestyle;
              
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
                    <div className="flex items-center gap-2 mt-3">
                      <Switch
                        id={`aop-toggle-${pt.id}`}
                        checked={!!pt.isAllOverPrint}
                        onCheckedChange={(checked) =>
                          toggleAopMutation.mutate({ id: pt.id, isAllOverPrint: checked })
                        }
                        data-testid={`switch-aop-${pt.id}`}
                      />
                      <Label htmlFor={`aop-toggle-${pt.id}`} className="text-sm cursor-pointer">
                        All-Over Print (AOP)
                      </Label>
                    </div>
                    {pt.isAllOverPrint && (
                      <div className="mt-3 space-y-1">
                        <Label className="text-xs text-muted-foreground">AOP layout template</Label>
                        <Select
                          value={pt.aopTemplateId || AOP_TEMPLATE_SELECT_AUTO}
                          onValueChange={(v) =>
                            updateAopTemplateMutation.mutate({
                              id: pt.id,
                              aopTemplateId: v === AOP_TEMPLATE_SELECT_AUTO ? null : v,
                            })
                          }
                          disabled={aopTemplateMutatingId === pt.id}
                        >
                          <SelectTrigger className="h-8 text-xs" data-testid={`select-aop-template-${pt.id}`}>
                            <SelectValue placeholder="Template" />
                          </SelectTrigger>
                          <SelectContent>
                            {AOP_TEMPLATE_ADMIN_OPTIONS.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>
                                {opt.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="flex gap-2 mt-4 flex-wrap">
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => navigate(`/admin/create-product?productTypeId=${pt.id}`)}
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
                      {pt.printifyBlueprintId && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => refreshVariantsMutation.mutate(pt.id)}
                          disabled={refreshVariantsMutatingId === pt.id}
                          data-testid={`button-refresh-variants-${pt.id}`}
                        >
                          <RefreshCw className={`h-3 w-3 mr-1 ${refreshVariantsMutatingId === pt.id ? 'animate-spin' : ''}`} />
                          Refresh Variants
                        </Button>
                      )}
                      {pt.printifyBlueprintId && JSON.parse(pt.frameColors || "[]").length > 0 && (
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={() => refreshColorsMutation.mutate(pt.id)}
                          disabled={refreshColorsMutatingId === pt.id}
                          data-testid={`button-refresh-colors-${pt.id}`}
                        >
                          <Palette className={`h-3 w-3 mr-1 ${refreshColorsMutatingId === pt.id ? 'animate-pulse' : ''}`} />
                          Refresh Colors
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleUpdateShopifyProduct(pt)}
                        disabled={shopifyMutatingProductId === pt.id}
                        data-testid={`button-refresh-shopify-${pt.id}`}
                      >
                        {pt.shopifyProductId ? (
                          <>
                            <RefreshCw className={`h-3 w-3 mr-1 ${shopifyMutatingProductId === pt.id ? 'animate-spin' : ''}`} />
                            Refresh Shopify
                          </>
                        ) : (
                          <>
                            <Upload className={`h-3 w-3 mr-1 ${shopifyMutatingProductId === pt.id ? 'animate-spin' : ''}`} />
                            Send to Shopify
                          </>
                        )}
                      </Button>
                      {pt.shopifyProductId && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setResyncPricesTarget(pt)}
                          data-testid={`button-resync-prices-${pt.id}`}
                        >
                          <DollarSign className="h-3 w-3 mr-1" />
                          Resync Prices
                        </Button>
                      )}
                      {/* On-the-fly calibration: shown for non-AOP products that
                          don't yet have a final tier and weren't ruled out
                          (unsupported). New imports auto-calibrate to a tier, so
                          this self-removes for healthy products. It stays
                          clickable even while "running" so an interrupted run
                          (e.g. a server restart) can be restarted — it never
                          gets permanently stuck on "Calibrating…". */}
                      {!pt.isAllOverPrint && !pt.onTheFlyTier && pt.flatCalibrationStatus !== "unsupported" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => calibrateFlatMutation.mutate(pt.id)}
                          disabled={calibrateMutatingId === pt.id}
                          title="Probe this product's print area and harvest masks/blanks so it can use on-the-fly mockups (flat/mesh) instead of Printify. Runs in the background (~1–2 min). Click again to restart if it stalls."
                          data-testid={`button-calibrate-flat-${pt.id}`}
                        >
                          {(calibrateMutatingId === pt.id || pt.flatCalibrationStatus === "pending" || pt.flatCalibrationStatus === "running") ? (
                            <>
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                              Calibrating… (click to restart)
                            </>
                          ) : pt.flatCalibrationStatus === "failed" ? (
                            <>
                              <FlaskConical className="h-3 w-3 mr-1" />
                              Retry calibration
                            </>
                          ) : (
                            <>
                              <FlaskConical className="h-3 w-3 mr-1" />
                              Calibrate for on-the-fly
                            </>
                          )}
                        </Button>
                      )}
                      {pt.onTheFlyTier && (
                        <Badge
                          variant={pt.onTheFlyTier === "reject" ? "secondary" : "default"}
                          className="self-center"
                          title={
                            pt.onTheFlyTier === "reject"
                              ? "Curved/3D surface — stays on Printify mockups."
                              : "Eligible for on-the-fly local mockups."
                          }
                        >
                          {pt.onTheFlyTier === "flat" ? "On-the-fly: flat" : pt.onTheFlyTier === "mesh" ? "On-the-fly: mesh" : "On-the-fly: n/a"}
                        </Badge>
                      )}
                      {/* Re-run calibration for products that already have a tier
                          (e.g. after a code fix, or when a prior run left masks
                          but missing blank photos). */}
                      {!pt.isAllOverPrint &&
                        (pt.onTheFlyTier === "flat" || pt.onTheFlyTier === "mesh") &&
                        pt.flatCalibrationStatus !== "unsupported" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => calibrateFlatMutation.mutate(pt.id)}
                          disabled={calibrateMutatingId === pt.id}
                          title="Re-harvest masks, shading, and up to 8 blank garment photos (not one per variant). Apparel front+back: typically 3–8 min."
                          data-testid={`button-recalibrate-flat-${pt.id}`}
                        >
                          {(calibrateMutatingId === pt.id || pt.flatCalibrationStatus === "pending" || pt.flatCalibrationStatus === "running") ? (
                            <>
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                              Recalibrating…
                            </>
                          ) : (
                            <>
                              <FlaskConical className="h-3 w-3 mr-1" />
                              Recalibrate
                            </>
                          )}
                        </Button>
                      )}
                      {(pt.onTheFlyTier === "flat" || pt.onTheFlyTier === "mesh") && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => testPrintifyOrderMutation.mutate(pt.id)}
                          disabled={testOrderMutatingId === pt.id}
                          title="Bakes the print file for the latest design and creates a DRAFT Printify order (not sent to production) so you can verify the print file matches the design."
                          data-testid={`button-test-printify-order-${pt.id}`}
                        >
                          <FlaskConical className={`h-3 w-3 mr-1 ${testOrderMutatingId === pt.id ? 'animate-pulse' : ''}`} />
                          Send test order to Printify (draft)
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
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
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

              {selectedBlueprint && (
                <details className="group rounded-md border bg-background">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium">
                    <span>Size chart preview</span>
                    <span className="text-xs text-muted-foreground">
                      {selectedBlueprintSizeChartLoading
                        ? "Loading..."
                        : selectedBlueprintSizeChart
                          ? "Available"
                          : "Unavailable"}
                    </span>
                  </summary>
                  <div className="border-t p-3">
                    {selectedBlueprintSizeChartLoading ? (
                      <div className="rounded-md border p-3 text-sm text-muted-foreground">Loading size chart...</div>
                    ) : (
                      <SizeChartTable chart={selectedBlueprintSizeChart} compact />
                    )}
                  </div>
                </details>
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
                  
                  {/* Colors/Models Section */}
                  {availableColors.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm font-medium">{getColorOptionLabel(availableColors)} ({selectedColorIds.size}/{availableColors.length})</Label>
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

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Placeholder Images</Label>
                      <span className="text-xs text-muted-foreground">
                        Choose 1 primary and up to 3 gallery images
                      </span>
                    </div>
                    {placeholderOptionsLoading ? (
                      <div className="flex items-center gap-2 rounded-md border p-3 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading available placeholders...
                      </div>
                    ) : (placeholderOptionsData?.images?.length ?? 0) > 0 ? (
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-64 overflow-y-auto border rounded-md p-2">
                        {placeholderOptionsData!.images.map((img, index) => {
                          const isPrimary = (placeholderPrimaryUrl || placeholderOptionsData!.images[0]?.url) === img.url;
                          const isGallery = placeholderGalleryUrls.has(img.url);
                          return (
                            <div key={`${img.url}-${index}`} className={`rounded-md border p-2 space-y-2 ${isPrimary ? "ring-2 ring-primary" : ""}`}>
                              <button
                                type="button"
                                className="block w-full overflow-hidden rounded bg-muted"
                                onClick={() => setPlaceholderPrimaryUrl(img.url)}
                                title="Use as primary placeholder"
                              >
                                <img src={img.url} alt={img.label} className="h-24 w-full object-cover" />
                              </button>
                              <div className="space-y-1">
                                <p className="truncate text-xs font-medium">{img.label}</p>
                                <div className="flex items-center justify-between gap-2">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant={isPrimary ? "default" : "outline"}
                                    className="h-7 px-2 text-xs"
                                    onClick={() => setPlaceholderPrimaryUrl(img.url)}
                                  >
                                    Primary
                                  </Button>
                                  <label className="flex items-center gap-1 text-xs">
                                    <Checkbox
                                      checked={isGallery}
                                      disabled={!isGallery && placeholderGalleryUrls.size >= 3}
                                      onCheckedChange={() => togglePlaceholderGalleryUrl(img.url)}
                                    />
                                    Gallery
                                  </label>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="rounded-md border p-3 text-sm text-muted-foreground">
                        No placeholder images were returned by Printify. The product can still be imported.
                      </p>
                    )}
                  </div>
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
                
                {/* Colors/Models Section */}
                {availableColors.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">{getColorOptionLabel(availableColors)} ({selectedColorIds.size}/{availableColors.length})</Label>
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

        <ResyncPricesDialog
          open={!!resyncPricesTarget}
          onOpenChange={(v) => { if (!v) setResyncPricesTarget(null); }}
          title={resyncPricesTarget?.name ?? ""}
          productTypeId={resyncPricesTarget?.id ?? 0}
        />
      </div>
    </AdminLayout>
  );
}
