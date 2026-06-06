import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Send, Package, AlertTriangle, Check, DollarSign, Info, ChevronRight, ChevronLeft } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import AdminLayout from "@/components/admin-layout";
import EmbedDesign from "@/pages/embed-design";
import type { ProductType } from "@shared/schema";

interface DesignerConfig {
  id: number;
  name: string;
  description: string | null;
  printifyBlueprintId: number | null;
  aspectRatio: string;
  printShape: string;
  printAreaWidth: number | null;
  printAreaHeight: number | null;
  bleedMarginPercent: number;
  designerType: string;
  sizeType: string;
  hasPrintifyMockups: boolean;
  baseMockupImages: { front?: string; lifestyle?: string };
  sizes: Array<{ id: string; name: string; width: number; height: number; aspectRatio?: string }>;
  frameColors: Array<{ id: string; name: string; hex: string }>;
  colorLabel?: string;
  canvasConfig: { maxDimension: number; width: number; height: number; safeZoneMargin: number };
  variantMap?: Record<string, { printifyVariantId: number; providerId: number }>;
  isAllOverPrint?: boolean;
  aopTemplateId?: string | null;
  placeholderPositions?: { position: string; width: number; height: number }[];
}

export default function AdminCreateProduct() {
  const { toast } = useToast();
  const searchParams = new URLSearchParams(window.location.search);
  const initialProductTypeId = searchParams.get("productTypeId");

  const [selectedProductTypeId, setSelectedProductTypeId] = useState<number | null>(
    initialProductTypeId ? parseInt(initialProductTypeId) : null
  );

  // ── Shopify publishing ("Send to Store") state ──
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [publishStep, setPublishStep] = useState<1 | 2>(1);
  const [shopDomain, setShopDomain] = useState("");
  const [isPublishing, setIsPublishing] = useState(false);
  const [selectedColorsForPublish, setSelectedColorsForPublish] = useState<Set<string>>(new Set());
  const [shopifyInstallations, setShopifyInstallations] = useState<Array<{ id: number; shopDomain: string; shopName: string }>>([]);
  const [installationsLoading, setInstallationsLoading] = useState(false);
  const [publishVariantPrices, setPublishVariantPrices] = useState<Record<string, string>>({});
  const [publishPriceErrors, setPublishPriceErrors] = useState<Record<string, string>>({});

  // Printify costs popup state (shared with pricing step)
  const [publishCostsOpen, setPublishCostsOpen] = useState(false);
  const [publishShippingTier, setPublishShippingTier] = useState("standard");
  const [publishShippingCountry, setPublishShippingCountry] = useState("US");

  // Markup percentage for recommended retail pricing (default 60%)
  const [markupPercent, setMarkupPercent] = useState(60);

  const { data: productTypes, isLoading: productTypesLoading } = useQuery<ProductType[]>({
    queryKey: ["/api/product-types"],
  });

  const { data: designerConfig } = useQuery<DesignerConfig>({
    queryKey: [`/api/product-types/${selectedProductTypeId}/designer`],
    enabled: !!selectedProductTypeId,
  });

  // Get the selected product type object for variant filtering
  const selectedProductType = productTypes?.find(pt => pt.id === selectedProductTypeId);

  // Filter sizes/colors based on saved variant selections for the testing generator
  const filteredSizes = useMemo(() => {
    if (!designerConfig?.sizes) return [];
    if (!selectedProductType) return designerConfig.sizes;

    const savedSizeIds: string[] = typeof selectedProductType.selectedSizeIds === 'string'
      ? JSON.parse(selectedProductType.selectedSizeIds || "[]")
      : selectedProductType.selectedSizeIds || [];

    if (savedSizeIds.length === 0) return designerConfig.sizes;

    const savedSizeSet = new Set(savedSizeIds);
    const filtered = designerConfig.sizes.filter(size => savedSizeSet.has(size.id));
    return filtered.length > 0 ? filtered : designerConfig.sizes;
  }, [designerConfig?.sizes, selectedProductType]);

  const filteredColors = useMemo(() => {
    if (!designerConfig?.frameColors) return [];
    if (!selectedProductType) return designerConfig.frameColors;

    const savedColorIds: string[] = typeof selectedProductType.selectedColorIds === 'string'
      ? JSON.parse(selectedProductType.selectedColorIds || "[]")
      : selectedProductType.selectedColorIds || [];

    if (savedColorIds.length === 0) return designerConfig.frameColors;

    const savedColorSet = new Set(savedColorIds);
    const filtered = designerConfig.frameColors.filter(color => savedColorSet.has(color.id));
    return filtered.length > 0 ? filtered : designerConfig.frameColors;
  }, [designerConfig?.frameColors, selectedProductType]);

  // Load saved variant count from product type
  const [savedVariantCount, setSavedVariantCount] = useState(0);

  // Fetch Shopify installations when dialog opens
  useEffect(() => {
    const fetchInstallations = async () => {
      setInstallationsLoading(true);
      try {
        const response = await fetch("/api/shopify/installations", { credentials: "include" });
        if (response.ok) {
          const data = await response.json();
          setShopifyInstallations(data.installations || []);
          if (data.installations && data.installations.length === 1) {
            const domain = data.installations[0].shopDomain || "";
            setShopDomain(domain.replace(".myshopify.com", ""));
          }
        }
      } catch (error) {
        console.error("Failed to fetch Shopify installations:", error);
      } finally {
        setInstallationsLoading(false);
      }
    };

    if (showPublishDialog) {
      fetchInstallations();
    }
  }, [showPublishDialog]);

  useEffect(() => {
    if (showPublishDialog && selectedProductType) {
      const savedSizeIds: string[] = typeof selectedProductType.selectedSizeIds === 'string'
        ? JSON.parse(selectedProductType.selectedSizeIds || "[]")
        : selectedProductType.selectedSizeIds || [];
      const savedColorIds: string[] = typeof selectedProductType.selectedColorIds === 'string'
        ? JSON.parse(selectedProductType.selectedColorIds || "[]")
        : selectedProductType.selectedColorIds || [];

      const totalSizes = designerConfig?.sizes?.length || 0;
      const totalColors = designerConfig?.frameColors?.length || 0;

      const sizeCount = savedSizeIds.length > 0 ? savedSizeIds.length : totalSizes;
      const colorCount = savedColorIds.length > 0 ? savedColorIds.length : (totalColors > 0 ? totalColors : 1);

      const count = sizeCount * colorCount;
      setSavedVariantCount(count);

      if (savedColorIds.length > 0) {
        setSelectedColorsForPublish(new Set(savedColorIds));
      } else if (totalColors > 0) {
        setSelectedColorsForPublish(new Set(designerConfig?.frameColors?.map(c => c.id) || []));
      }
    }
  }, [showPublishDialog, selectedProductType, designerConfig]);

  const SHOPIFY_VARIANT_LIMIT = 100;
  const variantCount = savedVariantCount;
  const isOverLimit = variantCount > SHOPIFY_VARIANT_LIMIT;

  // Build variant list for pricing step (sizeId:colorId -> label)
  const publishVariantList = useMemo(() => {
    if (!designerConfig) return [];
    const variants: Array<{ key: string; label: string }> = [];
    const sizes = filteredSizes;
    const colors = filteredColors;
    const vm = designerConfig.variantMap || {};
    if (colors.length > 0) {
      for (const size of sizes) {
        for (const color of colors) {
          const key = `${size.id}:${color.id}`;
          if (vm[key]) variants.push({ key, label: `${size.name} / ${color.name}` });
        }
      }
    } else {
      for (const size of sizes) {
        const key = `${size.id}:default`;
        if (vm[key]) variants.push({ key, label: size.name });
      }
    }
    return variants;
  }, [designerConfig, filteredSizes, filteredColors]);

  // Local Printify variant-ID → human label map (so shipping labels render before costs resolve)
  const localVariantLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    const vm = designerConfig?.variantMap || {};
    for (const [key, entry] of Object.entries(vm)) {
      const [sizeId, colorId] = key.split(":");
      const sizeName = filteredSizes.find(s => s.id === sizeId)?.name ?? sizeId;
      const colorName = filteredColors.find(c => c.id === colorId)?.name;
      const vid = String((entry as any).printifyVariantId);
      labels[vid] = colorName && colorId !== "default" ? `${sizeName} / ${colorName}` : sizeName;
    }
    return labels;
  }, [designerConfig, filteredSizes, filteredColors]);

  // Printify costs query for Generator Tester pricing step
  const { data: genCostsData, isLoading: genCostsLoading } = useQuery<{
    costs: Record<string, number>;
    shopifyVariantCosts: Record<string, number>;
    printifyVariantLabels: Record<string, string>;
    cached: boolean;
  }>({
    queryKey: ["/api/admin/printify/costs", selectedProductTypeId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/printify/costs/${selectedProductTypeId}`);
      return res.json();
    },
    enabled: (publishCostsOpen || publishStep === 2) && !!selectedProductTypeId && !!designerConfig?.printifyBlueprintId,
  });

  // Shared rounding helper: rounds a price up to the nearest .95 ending
  function roundUpTo95(price: number): number {
    const dollars = Math.floor(price);
    return price <= dollars + 0.95 ? dollars + 0.95 : dollars + 1.95;
  }

  // Recommended retail prices keyed by variant key (sizeId:colorId), computed from costs + markup
  const publishRecommendedPrices = useMemo(() => {
    if (!genCostsData?.costs || !designerConfig?.variantMap) return {} as Record<string, string>;
    const result: Record<string, string> = {};
    for (const v of publishVariantList) {
      const vm = designerConfig.variantMap[v.key];
      if (!vm?.printifyVariantId) continue;
      const costCents = genCostsData.costs[String(vm.printifyVariantId)];
      if (costCents == null) continue;
      const raw = (costCents / 100) * (1 + markupPercent / 100);
      result[v.key] = roundUpTo95(raw).toFixed(2);
    }
    return result;
  }, [genCostsData, designerConfig, publishVariantList, markupPercent]);

  const { data: genShippingData, isLoading: genShippingLoading } = useQuery<{
    version: string;
    tiers?: string[];
    shipping?: Record<string, Array<{
      variantId: number;
      country: string;
      firstItem: number;
      additionalItems: number;
      currency: string;
      handlingTime?: { from: number; to: number };
    }>>;
    countries?: string[];
  }>({
    queryKey: ["/api/admin/printify/shipping", designerConfig?.printifyBlueprintId, selectedProductType?.printifyProviderId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/printify/shipping/${designerConfig!.printifyBlueprintId}/${selectedProductType!.printifyProviderId}`);
      return res.json();
    },
    enabled: publishCostsOpen && !!designerConfig?.printifyBlueprintId && !!selectedProductType?.printifyProviderId,
  });

  // Advance from store selection to pricing step
  function advanceToPublishPricing() {
    if (!shopDomain.trim() || isOverLimit || variantCount === 0) return;
    const prefilled: Record<string, string> = {};
    for (const v of publishVariantList) {
      prefilled[v.key] = publishVariantPrices[v.key] ?? "";
    }
    setPublishVariantPrices(prefilled);
    setPublishPriceErrors({});
    setPublishStep(2);
  }

  // Validate prices before final submit
  function validatePublishPrices(): boolean {
    const errs: Record<string, string> = {};
    for (const v of publishVariantList) {
      const val = publishVariantPrices[v.key] ?? "";
      const num = parseFloat(val);
      if (!val.trim() || isNaN(num) || num <= 0) {
        errs[v.key] = "Required — enter a price greater than $0.00";
      }
    }
    if (Object.keys(errs).length > 0) {
      setPublishPriceErrors(errs);
      return false;
    }
    setPublishPriceErrors({});
    return true;
  }

  // Publish product to Shopify
  const handlePublishToShopify = async () => {
    if (!selectedProductTypeId || !shopDomain) {
      toast({
        title: "Missing information",
        description: "Please select a product type and enter your Shopify store domain",
        variant: "destructive",
      });
      return;
    }

    if (!validatePublishPrices()) return;

    let formattedDomain = shopDomain.trim().toLowerCase();
    if (!formattedDomain.endsWith(".myshopify.com")) {
      formattedDomain = `${formattedDomain}.myshopify.com`;
    }

    setIsPublishing(true);
    try {
      const response = await apiRequest("POST", "/api/shopify/products", {
        productTypeId: selectedProductTypeId,
        shopDomain: formattedDomain,
        selectedColorIds: designerConfig?.frameColors.length ? Array.from(selectedColorsForPublish) : undefined,
        variantPrices: publishVariantPrices,
      });

      await response.json();

      setShowPublishDialog(false);
      setPublishStep(1);
      toast({
        title: "Product sent to store!",
        description: "Your product is ready for your customizer page.",
      });
    } catch (error: any) {
      toast({
        title: "Failed to create product",
        description: error.message || "Please check your Shopify connection and try again",
        variant: "destructive",
      });
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-create-product-title">Art Generator Tester</h1>
            <p className="text-muted-foreground">Test the live customizer for a product type before sending it to your store</p>
          </div>
          {selectedProductTypeId && designerConfig && (
            <div className="flex items-center gap-2">
              <Button onClick={() => setShowPublishDialog(true)} data-testid="button-send-to-store">
                <Send className="h-4 w-4 mr-2" />
                Send to Store
              </Button>
            </div>
          )}
        </div>

        {/* Product Type selector — the "tester" input that chooses which product's customizer to render */}
        <div className="max-w-md space-y-2">
          <Label>Product Type</Label>
          {productTypesLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Select
              value={selectedProductTypeId?.toString() || ""}
              onValueChange={(v) => setSelectedProductTypeId(parseInt(v))}
            >
              <SelectTrigger data-testid="select-product-type">
                <SelectValue placeholder="Select a product type" />
              </SelectTrigger>
              <SelectContent>
                {productTypes?.map((pt) => (
                  <SelectItem key={pt.id} value={pt.id.toString()}>
                    {pt.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <p className="text-xs text-muted-foreground">
            This renders the exact same designer your customers use — it always stays in sync with the live customizer.
          </p>
        </div>

        {/* Live customizer — the IDENTICAL storefront design studio, rendered IN-PROCESS via the
            admin-tester runtime mode. In-process (not an iframe) so it isn't blocked by the app's
            frame-ancestors CSP and so it reuses the App Bridge session token for /api/generate. */}
        {selectedProductTypeId ? (
          <Card className="overflow-hidden">
            <CardContent className="p-0">
              <EmbedDesign
                key={selectedProductTypeId}
                embeddedContext={{ mode: "admin-tester", productTypeId: selectedProductTypeId }}
              />
            </CardContent>
          </Card>
        ) : (
          <div className="aspect-[16/9] max-h-[480px] bg-muted rounded-lg flex items-center justify-center">
            <div className="text-center text-muted-foreground">
              <Package className="h-12 w-12 mx-auto mb-2" />
              <p className="text-sm">Select a product type to load its customizer</p>
            </div>
          </div>
        )}
      </div>

      {/* Send to Store Dialog — Step 1: Store + Product info, Step 2: Pricing */}
      <Dialog open={showPublishDialog} onOpenChange={(open) => { setShowPublishDialog(open); if (!open) setPublishStep(1); }}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Send to Store{publishStep === 2 ? " — Set Pricing" : ""}</DialogTitle>
            <DialogDescription>
              {publishStep === 1
                ? "Select your store and review the product before setting prices."
                : "Set a retail price for each variant. You can view Printify costs for reference."}
            </DialogDescription>
          </DialogHeader>

          {/* ── Step 1: Store selection + product info ── */}
          {publishStep === 1 && (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="shop-domain">Store</Label>
                {installationsLoading ? (
                  <Skeleton className="h-10 w-full" />
                ) : shopifyInstallations.length > 1 ? (
                  <Select value={shopDomain} onValueChange={setShopDomain}>
                    <SelectTrigger data-testid="select-shop-domain">
                      <SelectValue placeholder="Select your store" />
                    </SelectTrigger>
                    <SelectContent>
                      {shopifyInstallations.map((inst) => {
                        const domainSlug = (inst.shopDomain || "").replace(".myshopify.com", "");
                        return (
                          <SelectItem key={inst.id} value={domainSlug}>
                            {inst.shopDomain || `${domainSlug}.myshopify.com`}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                ) : shopifyInstallations.length === 1 ? (
                  <div className="flex items-center gap-2 p-2 bg-muted rounded-md">
                    <Check className="h-4 w-4 text-green-600" />
                    <span className="text-sm font-medium">{shopifyInstallations[0].shopDomain}</span>
                  </div>
                ) : (
                  <div className="flex gap-2 items-center">
                    <Input id="shop-domain" placeholder="your-store" value={shopDomain} onChange={(e) => setShopDomain(e.target.value)} data-testid="input-shop-domain" />
                    <span className="text-sm text-muted-foreground whitespace-nowrap">.myshopify.com</span>
                  </div>
                )}
                {shopifyInstallations.length === 0 && !installationsLoading && (
                  <p className="text-xs text-muted-foreground">
                    No connected stores found. Enter your store name manually or{" "}
                    <a href="/shopify/install" className="underline text-primary">connect your Shopify store</a> first.
                  </p>
                )}
              </div>

              {designerConfig && (
                <div className="space-y-3">
                  <div className="bg-muted p-3 rounded-lg space-y-2">
                    <p className="text-sm font-medium">Product: {designerConfig.name}</p>
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">Variants</p>
                      <span className={`text-lg font-bold ${isOverLimit ? "text-red-600" : "text-green-600"}`}>{variantCount}</span>
                    </div>
                  </div>
                  {isOverLimit && (
                    <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-md">
                      <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
                      <div className="text-sm text-red-700 dark:text-red-300">
                        <p className="font-medium">Too many variants ({variantCount})</p>
                        <p className="text-xs mt-1">Shopify allows maximum {SHOPIFY_VARIANT_LIMIT} variants.</p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="text-sm text-muted-foreground space-y-1">
                <p>This will:</p>
                <ul className="list-disc list-inside space-y-1 text-xs">
                  <li>Create your product with all size and color variants</li>
                  <li>Include mockup images and the design studio widget</li>
                  <li>Set your retail prices on each variant</li>
                </ul>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setShowPublishDialog(false)}>Cancel</Button>
                <Button onClick={advanceToPublishPricing} disabled={!shopDomain.trim() || isOverLimit || variantCount === 0}>
                  Next: Set Pricing <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </DialogFooter>
            </div>
          )}

          {/* ── Step 2: Variant pricing ── */}
          {publishStep === 2 && (
            <div className="space-y-4 py-2">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Set a retail price for each variant.
                </p>
                {designerConfig?.printifyBlueprintId && (
                  <Button variant="outline" size="sm" className="flex-shrink-0 ml-2" onClick={() => { setPublishCostsOpen(true); setPublishShippingTier("standard"); setPublishShippingCountry("US"); }}>
                    <Info className="h-3.5 w-3.5 mr-1" /> Printify Costs
                  </Button>
                )}
              </div>

              {/* Markup % control + Apply All */}
              {designerConfig?.printifyBlueprintId && (
                <div className="flex items-center gap-2 p-3 rounded-md bg-muted/50 border">
                  <span className="text-sm text-muted-foreground whitespace-nowrap">Markup:</span>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min="1"
                      max="999"
                      step="1"
                      value={markupPercent}
                      onChange={(e) => setMarkupPercent(Math.max(1, parseInt(e.target.value) || 60))}
                      className="w-16 h-8 text-center text-sm"
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                  {genCostsLoading && <span className="text-xs text-muted-foreground ml-1">Loading costs…</span>}
                  {Object.keys(publishRecommendedPrices).length > 0 && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="ml-auto text-xs h-8"
                      onClick={() => {
                        const filled: Record<string, string> = { ...publishVariantPrices };
                        for (const [key, price] of Object.entries(publishRecommendedPrices)) {
                          filled[key] = price;
                        }
                        setPublishVariantPrices(filled);
                        setPublishPriceErrors({});
                      }}
                    >
                      Apply All Suggested
                    </Button>
                  )}
                </div>
              )}

              <div className="space-y-3 max-h-[40vh] overflow-y-auto pr-1">
                {publishVariantList.map((v) => (
                  <div key={v.key}>
                    <div className="flex items-center justify-between">
                      <Label className="flex items-center gap-1">
                        <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
                        {v.label}
                      </Label>
                      {publishRecommendedPrices[v.key] && (
                        <button
                          type="button"
                          className="text-xs text-primary hover:underline cursor-pointer"
                          onClick={() => {
                            setPublishVariantPrices((prev) => ({ ...prev, [v.key]: publishRecommendedPrices[v.key] }));
                            if (publishPriceErrors[v.key]) setPublishPriceErrors((prev) => { const n = { ...prev }; delete n[v.key]; return n; });
                          }}
                        >
                          Suggested: ${publishRecommendedPrices[v.key]}
                        </button>
                      )}
                    </div>
                    <div className="flex items-center mt-1">
                      <span className="text-sm text-muted-foreground border border-r-0 rounded-l-md px-3 py-2 bg-muted h-10 flex items-center">$</span>
                      <Input
                        type="number"
                        min="0.01"
                        step="0.01"
                        placeholder="0.00"
                        value={publishVariantPrices[v.key] ?? ""}
                        onChange={(e) => {
                          setPublishVariantPrices((prev) => ({ ...prev, [v.key]: e.target.value }));
                          if (publishPriceErrors[v.key]) setPublishPriceErrors((prev) => { const n = { ...prev }; delete n[v.key]; return n; });
                        }}
                        className={`rounded-l-none ${publishPriceErrors[v.key] ? "border-destructive focus-visible:ring-destructive" : ""}`}
                      />
                    </div>
                    {publishPriceErrors[v.key] && (
                      <p className="text-xs text-destructive mt-1">{publishPriceErrors[v.key]}</p>
                    )}
                  </div>
                ))}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPublishStep(1)}>
                  <ChevronLeft className="h-4 w-4 mr-1" /> Back
                </Button>
                <Button onClick={handlePublishToShopify} disabled={isPublishing}>
                  {isPublishing ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating...</>
                  ) : (
                    <><Send className="h-4 w-4 mr-2" /> Send to Store</>
                  )}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Printify Costs Dialog (Generator Tester) ── */}
      <Dialog open={publishCostsOpen} onOpenChange={setPublishCostsOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Printify Costs — {designerConfig?.name}</DialogTitle>
          </DialogHeader>
          <Tabs defaultValue="production" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="production">Production</TabsTrigger>
              <TabsTrigger value="shipping">Shipping</TabsTrigger>
            </TabsList>
            <TabsContent value="production" className="space-y-3 pt-2">
              {genCostsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" />
                  <span className="text-sm text-muted-foreground">Fetching production costs from Printify...</span>
                </div>
              ) : genCostsData?.costs ? (
                <>
                  <div className="rounded-md border text-sm">
                    <div className="grid grid-cols-3 gap-2 px-3 py-2 bg-muted font-medium">
                      <span>Variant</span>
                      <span className="text-right">Standard</span>
                      <span className="text-right text-emerald-600">Premium (est.)</span>
                    </div>
                    {publishVariantList.map((v) => {
                      const vm = designerConfig?.variantMap?.[v.key];
                      const costCents = vm?.printifyVariantId ? genCostsData.costs[String(vm.printifyVariantId)] : undefined;
                      return (
                        <div key={v.key} className="grid grid-cols-3 gap-2 px-3 py-2 border-t">
                          <span>{v.label}</span>
                          <span className="text-right font-mono">{costCents != null ? `$${(costCents / 100).toFixed(2)}` : "—"}</span>
                          <span className="text-right font-mono text-emerald-600">{costCents != null ? `$${(costCents * 0.8 / 100).toFixed(2)}` : "—"}</span>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">Premium estimates based on up to 20% Printify Premium discount. Shipping costs are separate.</p>
                  {genCostsData.cached && <p className="text-xs text-muted-foreground">Cached data. Refreshed every 24 hours.</p>}
                </>
              ) : (
                <p className="text-sm text-muted-foreground py-4 text-center">Production cost data is not available.</p>
              )}
            </TabsContent>
            <TabsContent value="shipping" className="space-y-3 pt-2">
              {genShippingLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" />
                  <span className="text-sm text-muted-foreground">Loading shipping rates...</span>
                </div>
              ) : genShippingData?.tiers && genShippingData.shipping ? (
                <>
                  <div className="flex gap-2 flex-wrap">
                    {genShippingData.tiers.map((tier) => (
                      <Button key={tier} variant={publishShippingTier === tier ? "default" : "outline"} size="sm" onClick={() => setPublishShippingTier(tier)} className="capitalize">{tier}</Button>
                    ))}
                  </div>
                  {genShippingData.countries && genShippingData.countries.length > 0 && (
                    <Select value={publishShippingCountry} onValueChange={setPublishShippingCountry}>
                      <SelectTrigger className="w-full"><SelectValue placeholder="Select country" /></SelectTrigger>
                      <SelectContent>
                        {genShippingData.countries.map((c) => (
                          <SelectItem key={c} value={c}>{c === "REST_OF_THE_WORLD" ? "Rest of the World" : c}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {(() => {
                    const tierEntries = (genShippingData.shipping[publishShippingTier] ?? []).filter((e) => e.country === publishShippingCountry);
                    if (tierEntries.length === 0) return <p className="text-sm text-muted-foreground text-center py-4">No shipping data for this tier/country.</p>;
                    const ht = tierEntries[0]?.handlingTime;
                    return (
                      <>
                        {ht && <p className="text-xs text-muted-foreground">Handling time: {ht.from}–{ht.to} business days</p>}
                        <div className="rounded-md border text-sm">
                          <div className="grid grid-cols-3 gap-2 px-3 py-2 bg-muted font-medium">
                            <span>Variant</span><span className="text-right">1st Item</span><span className="text-right">Additional</span>
                          </div>
                          {(() => {
                            const seen = new Set<string>();
                            return tierEntries.filter((entry) => {
                              const lbl = localVariantLabels[String(entry.variantId)] ?? genCostsData?.printifyVariantLabels?.[String(entry.variantId)] ?? `Variant ${entry.variantId}`;
                              const key = `${lbl}|${entry.firstItem}|${entry.additionalItems}`;
                              if (seen.has(key)) return false;
                              seen.add(key);
                              return true;
                            }).map((entry) => {
                              const label = localVariantLabels[String(entry.variantId)] ?? genCostsData?.printifyVariantLabels?.[String(entry.variantId)] ?? `Variant ${entry.variantId}`;
                              return (
                                <div key={entry.variantId} className="grid grid-cols-3 gap-2 px-3 py-2 border-t">
                                  <span className="truncate">{label}</span>
                                  <span className="text-right font-mono">${(entry.firstItem / 100).toFixed(2)}</span>
                                  <span className="text-right font-mono">${(entry.additionalItems / 100).toFixed(2)}</span>
                                </div>
                              );
                            });
                          })()}
                        </div>
                      </>
                    );
                  })()}
                </>
              ) : (
                <p className="text-sm text-muted-foreground py-4 text-center">Shipping data is not available.</p>
              )}
            </TabsContent>
          </Tabs>
          <p className="text-xs text-muted-foreground border-t pt-3">Set your retail price above production + shipping costs to ensure profitability.</p>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
