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
import { Package, Plus, Trash2, Edit2, Download, Search, Loader2, ExternalLink } from "lucide-react";
import AdminLayout from "@/components/admin-layout";
import type { ProductType, Merchant } from "@shared/schema";

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
  const [catalogLocationFilter, setCatalogLocationFilter] = useState("");
  const [blueprintLocationData, setBlueprintLocationData] = useState<Record<number, string[]>>({});
  const [locationDataLoading, setLocationDataLoading] = useState(false);

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

  const importPrintifyMutation = useMutation({
    mutationFn: async (data: { blueprintId: number; name: string; description?: string; providerId?: number }) => {
      const response = await apiRequest("POST", "/api/admin/printify/import", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
      setPrintifyImportOpen(false);
      setProviderSelectionOpen(false);
      setSelectedBlueprint(null);
      setSelectedProvider(null);
      setBlueprintSearch("");
      toast({ title: "Blueprint imported", description: "Product type created from Printify catalog." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to import blueprint", description: error.message, variant: "destructive" });
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

  const handleOpenPrintifyImport = async () => {
    setPrintifyImportOpen(true);
    setBlueprintLocationData({});
    setCatalogLocationFilter("");
    if (!printifyBlueprints) {
      refetchBlueprints();
    }
  };

  useEffect(() => {
    const loadLocationData = async () => {
      if (!printifyBlueprints || printifyBlueprints.length === 0) return;
      if (Object.keys(blueprintLocationData).length > 0) return;
      
      setLocationDataLoading(true);
      const locationMap: Record<number, string[]> = {};
      
      const batchSize = 10;
      for (let i = 0; i < printifyBlueprints.length; i += batchSize) {
        const batch = printifyBlueprints.slice(i, i + batchSize);
        await Promise.all(batch.map(async (bp) => {
          try {
            const response = await fetch(`/api/admin/printify/blueprints/${bp.id}/providers`, {
              credentials: "include"
            });
            if (response.ok) {
              const providers: PrintifyProvider[] = await response.json();
              const countries = new Set<string>();
              providers.forEach(p => {
                if (p.location?.country) countries.add(p.location.country);
                p.fulfillment_countries?.forEach(c => countries.add(c));
              });
              locationMap[bp.id] = Array.from(countries);
            }
          } catch (e) {
            locationMap[bp.id] = [];
          }
        }));
      }
      
      setBlueprintLocationData(locationMap);
      setLocationDataLoading(false);
    };
    
    if (printifyImportOpen && printifyBlueprints) {
      loadLocationData();
    }
  }, [printifyBlueprints, printifyImportOpen, blueprintLocationData]);

  const filteredBlueprints = useMemo(() => {
    if (!printifyBlueprints) return [];
    return printifyBlueprints.filter(bp => {
      const matchesSearch = !blueprintSearch || 
        bp.title.toLowerCase().includes(blueprintSearch.toLowerCase()) ||
        bp.brand.toLowerCase().includes(blueprintSearch.toLowerCase());
      
      const matchesLocation = !catalogLocationFilter || 
        blueprintLocationData[bp.id]?.includes(catalogLocationFilter);
      
      return matchesSearch && matchesLocation;
    });
  }, [printifyBlueprints, blueprintSearch, catalogLocationFilter, blueprintLocationData]);

  const filteredProviders = useMemo(() => {
    if (!printifyProviders) return [];
    if (!providerLocationFilter) return printifyProviders;
    
    return printifyProviders.filter(p => 
      p.location?.country === providerLocationFilter ||
      p.fulfillment_countries?.includes(providerLocationFilter)
    );
  }, [printifyProviders, providerLocationFilter]);

  const handleImportBlueprint = async () => {
    if (!selectedBlueprint) return;
    importPrintifyMutation.mutate({
      blueprintId: selectedBlueprint.id,
      name: selectedBlueprint.title,
      description: selectedBlueprint.description,
      providerId: selectedProvider?.id,
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
                    <div className="w-full h-40 flex items-center justify-center bg-muted rounded-t-lg">
                      <Package className="h-12 w-12 text-muted-foreground" />
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
                    <div className="flex gap-2 mt-4">
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => window.location.href = `/admin/create-product?productTypeId=${pt.id}`}
                        data-testid={`button-test-${pt.id}`}
                      >
                        Test Generator
                      </Button>
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
                <Select value={catalogLocationFilter} onValueChange={setCatalogLocationFilter}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Filter by location" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">All locations</SelectItem>
                    {availableLocations.map(loc => (
                      <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                          {blueprintLocationData[bp.id] && (
                            <div className="flex gap-1 flex-wrap mt-1">
                              {blueprintLocationData[bp.id].slice(0, 3).map(loc => (
                                <Badge key={loc} variant="secondary" className="text-xs">{loc}</Badge>
                              ))}
                              {blueprintLocationData[bp.id].length > 3 && (
                                <Badge variant="secondary" className="text-xs">+{blueprintLocationData[bp.id].length - 3}</Badge>
                              )}
                            </div>
                          )}
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

              <Select value={providerLocationFilter} onValueChange={setProviderLocationFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Filter by location" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All locations</SelectItem>
                  {availableLocations.map(loc => (
                    <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {providersLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin" />
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
                            <p className="text-sm text-muted-foreground">
                              {provider.location?.city}, {provider.location?.country}
                            </p>
                          </div>
                          {provider.fulfillment_countries && (
                            <Badge variant="secondary" className="text-xs">
                              Ships to {provider.fulfillment_countries.length} countries
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
                  onClick={handleImportBlueprint}
                  disabled={!selectedBlueprint || importPrintifyMutation.isPending}
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
      </div>
    </AdminLayout>
  );
}
