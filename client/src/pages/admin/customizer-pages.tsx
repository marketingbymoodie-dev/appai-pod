import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Globe, LayoutTemplate, Loader2, Plus, ExternalLink, Trash2,
  ToggleLeft, ToggleRight, AlertTriangle, Wand2, Save, ArrowUpRight, TrendingUp,
  CheckCircle2, ChevronRight, DollarSign, Info,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import AdminLayout from "@/components/admin-layout";
import PlanPicker from "./plan-picker";

interface CustomizerPage {
  id: string;
  shop: string;
  handle: string;
  title: string;
  baseVariantId: string;
  baseProductTitle: string | null;
  baseVariantTitle: string | null;
  baseProductPrice: string | null;
  status: "active" | "disabled";
  createdAt: string;
}

interface PagesResponse {
  pages: CustomizerPage[];
  limit: number;
  count: number;
  planTier: string;
  planName: string | null;
  planStatus: string | null;
  requiresPlan: boolean;
  overLimit: boolean;
}

interface BlankVariant {
  id: string;
  title: string;
  price: string;
  sku?: string;
}

interface Blank {
  productTypeId: number;
  productId: string | null;
  title: string;
  imageUrl: string | null;
  needsShopifySync?: boolean;
  printifyBlueprintId?: number | null;
  printifyProviderId?: number | null;
  printifyVariantLabels?: Record<string, string>;
  variants: BlankVariant[];
}

function slugify(str: string): string {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const PLAN_DISPLAY: Record<string, string> = {
  trial: "Trial",
  starter: "Starter",
  dabbler: "Dabbler",
  pro: "Pro",
  pro_plus: "Pro Plus",
};

export default function AdminCustomizerPages() {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CustomizerPage | null>(null);

  // Hub URL (fallback for disabled pages)
  const [hubUrl, setHubUrl] = useState("");

  // Form state
  const [formTitle, setFormTitle] = useState("");
  const [formHandle, setFormHandle] = useState("");
  const [formProductId, setFormProductId] = useState("");
  const [handleTouched, setHandleTouched] = useState(false);

  // Wizard state
  const [formStep, setFormStep] = useState<1 | 2 | 3 | 4>(1);
  const [variantPrices, setVariantPrices] = useState<Record<string, string>>({});
  const [priceErrors, setPriceErrors] = useState<Record<string, string>>({});
  const [createdPageResult, setCreatedPageResult] = useState<any>(null);

  // Costs popup state
  const [costsOpen, setCostsOpen] = useState(false);
  const [costsShippingCountry, setCostsShippingCountry] = useState("US");
  const [costsShippingTier, setCostsShippingTier] = useState("standard");

  const { data: pagesData, isLoading: pagesLoading, error: pagesError } = useQuery<PagesResponse>({
    queryKey: ["/api/appai/customizer-pages"],
  });

  // Parse REAUTH_REQUIRED from query errors so we can show a reconnect banner
  const reauthData = (() => {
    if (!pagesError) return null;
    try {
      // throwIfResNotOk formats the error as: "401: <json body>"
      const raw = (pagesError as Error).message ?? "";
      const jsonStart = raw.indexOf("{");
      if (jsonStart === -1) return null;
      const parsed = JSON.parse(raw.slice(jsonStart));
      if (parsed?.error === "REAUTH_REQUIRED") return parsed as { error: string; reinstallUrl: string };
    } catch {
      // not a parseable JSON error — ignore
    }
    return null;
  })();

  // Initialise hub URL from server response
  const hubUrlFromServer = (pagesData as any)?.hubUrl;
  if (!hubUrl && hubUrlFromServer) setHubUrl(hubUrlFromServer);

  const hubUrlMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest("PATCH", "/api/appai/shop-settings", {
        customizerHubUrl: url,
      });
      return res.json();
    },
    onSuccess: () => toast({ title: "Saved", description: "Fallback URL updated." }),
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const { data: blanksData, isLoading: blanksLoading } = useQuery<{ blanks: Blank[] }>({
    queryKey: ["/api/appai/blanks"],
    enabled: createOpen,
  });

  const shopDomain = pagesData?.pages?.[0]?.shop ?? "";

  const createMutation = useMutation({
    mutationFn: async (body: {
      title: string;
      handle: string;
      baseProductId?: string;
      productTypeId?: number;
      variantPrices: Record<string, string>;
    }) => {
      const res = await apiRequest("POST", "/api/appai/customizer-pages", body);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/appai/customizer-pages"] });
      setCreatedPageResult(data);
      setFormStep(4);
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const res = await apiRequest("PATCH", `/api/appai/customizer-pages/${id}`, { status });
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/appai/customizer-pages"] }),
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!id) throw new Error("Missing page ID");
      const res = await apiRequest("DELETE", `/api/appai/customizer-pages/${id}`, undefined);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/appai/customizer-pages"] });
      setDeleteTarget(null);
      toast({ title: "Page deleted", description: "The customizer page has been removed." });
    },
    onError: (err: any) => {
      const msg = err?.message ?? "Unknown error";
      console.error("[delete customizer-page]", msg);
      toast({ title: "Delete failed", description: msg, variant: "destructive" });
    },
  });

  function resetForm() {
    setFormTitle("");
    setFormHandle("");
    setFormProductId("");
    setHandleTouched(false);
    setFormStep(1);
    setVariantPrices({});
    setPriceErrors({});
    setCreatedPageResult(null);
  }

  function handleTitleChange(val: string) {
    setFormTitle(val);
    if (!handleTouched) setFormHandle(slugify(val));
  }

  /** Derive variants for the currently-selected product (Step 2 pricing) */
  const selectedBlank = (blanksData?.blanks ?? []).find(
    (b) => (b.productId ? b.productId : `pt:${b.productTypeId}`) === formProductId
  );
  const selectedVariants: BlankVariant[] = selectedBlank?.variants ?? [];

  // Printify costs query -- fetches production costs via temporary product probe
  const { data: costsData, isLoading: costsLoading } = useQuery<{
    costs: Record<string, number>;
    shopifyVariantCosts: Record<string, number>;
    printifyVariantLabels: Record<string, string>;
    cached: boolean;
  }>({
    queryKey: ["/api/admin/printify/costs", selectedBlank?.productTypeId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/printify/costs/${selectedBlank!.productTypeId}`);
      return res.json();
    },
    enabled: costsOpen && !!selectedBlank?.productTypeId && !!selectedBlank?.printifyBlueprintId,
  });

  // Printify shipping query -- fetches per-tier, per-country shipping costs
  const { data: shippingData, isLoading: shippingLoading } = useQuery<{
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
    queryKey: ["/api/admin/printify/shipping", selectedBlank?.printifyBlueprintId, selectedBlank?.printifyProviderId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/printify/shipping/${selectedBlank!.printifyBlueprintId}/${selectedBlank!.printifyProviderId}`);
      return res.json();
    },
    enabled: costsOpen && !!selectedBlank?.printifyBlueprintId && !!selectedBlank?.printifyProviderId,
  });

  /** When moving from Step 1 → Step 2, pre-fill prices from Shopify data */
  function advanceToStep2() {
    if (!formTitle.trim() || !formHandle.trim() || !formProductId) return;
    // If the product isn't on Shopify yet, skip pricing step (no Shopify variants to price yet)
    if (selectedBlank?.needsShopifySync) {
      setFormStep(3);
      return;
    }
    const prefilled: Record<string, string> = {};
    for (const v of selectedVariants) {
      prefilled[v.id] = variantPrices[v.id] ?? (v.price && v.price !== "0.00" ? v.price : "");
    }
    setVariantPrices(prefilled);
    setPriceErrors({});
    setFormStep(2);
  }

  /** Validate prices in Step 2; advance to Step 3 (confirm) */
  function advanceToStep3() {
    const errs: Record<string, string> = {};
    for (const v of selectedVariants) {
      const val = variantPrices[v.id] ?? "";
      const num = parseFloat(val);
      if (!val.trim() || isNaN(num) || num <= 0) {
        errs[v.id] = "Required — enter a price greater than $0.00";
      }
    }
    if (Object.keys(errs).length > 0) {
      setPriceErrors(errs);
      return;
    }
    setPriceErrors({});
    setFormStep(3);
  }

  function handleSubmitCreate() {
    // For products on Shopify: pass their shopify productId.
    // For products not yet on Shopify: pass the productTypeId so the backend can auto-send.
    const isSync = selectedBlank?.needsShopifySync;
    createMutation.mutate({
      title: formTitle,
      handle: formHandle,
      baseProductId: isSync ? undefined : formProductId,
      productTypeId: isSync ? selectedBlank?.productTypeId : undefined,
      variantPrices,
    });
  }

  const pages = pagesData?.pages ?? [];
  const limit = pagesData?.limit ?? 0;
  const count = pagesData?.count ?? 0;
  const planName = pagesData?.planName ?? null;
  const planStatus = pagesData?.planStatus ?? null;
  const requiresPlan = pagesData?.requiresPlan ?? false;
  const overLimit = pagesData?.overLimit ?? false;
  const atLimit = count >= limit && limit > 0;

  const activePagesCount = pages.filter((p) => p.status === "active").length;
  const overLimitActiveCount = Math.max(0, activePagesCount - limit);

  if (reauthData) {
    return (
      <AdminLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4 text-center px-4">
          <AlertTriangle className="h-12 w-12 text-yellow-500" />
          <h2 className="text-xl font-semibold">Shopify connection needs to be refreshed</h2>
          <p className="text-muted-foreground max-w-sm">
            Your app's Shopify access token has expired or been revoked. Click below to reconnect
            your store — this only takes a moment.
          </p>
          <Button
            size="lg"
            onClick={() => window.open(reauthData.reinstallUrl, "_top")}
          >
            Reconnect Shopify
          </Button>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <LayoutTemplate className="h-6 w-6 text-primary" />
              Customizer Pages
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Create storefront pages where customers can generate custom designs.
            </p>
          </div>

          {/* Only show Create button if plan is active */}
          {!requiresPlan && (
            <Dialog open={createOpen} onOpenChange={(v) => { setCreateOpen(v); if (!v) resetForm(); }}>
              <DialogTrigger asChild>
                <Button disabled={atLimit}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Page
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>
                    {formStep === 4 ? "Page Created!" : "Create Customizer Page"}
                  </DialogTitle>
                  {formStep < 4 && (
                    <div className="flex items-center gap-1.5 pt-1">
                      {([1, 2, 3] as const).map((s) => (
                        <div key={s} className="flex items-center gap-1.5">
                          <div className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center ${
                            formStep === s
                              ? "bg-primary text-primary-foreground"
                              : formStep > s
                              ? "bg-primary/20 text-primary"
                              : "bg-muted text-muted-foreground"
                          }`}>{s}</div>
                          <span className={`text-xs ${formStep === s ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                            {s === 1 ? "Page info" : s === 2 ? "Pricing" : "Confirm"}
                          </span>
                          {s < 3 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                        </div>
                      ))}
                    </div>
                  )}
                </DialogHeader>

                {/* ── STEP 1: Page info ── */}
                {formStep === 1 && (
                  <div className="space-y-4 pt-2">
                    <div>
                      <Label>Page Title</Label>
                      <Input
                        placeholder="Customize Your Tumbler"
                        value={formTitle}
                        onChange={(e) => handleTitleChange(e.target.value)}
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <Label>URL Handle</Label>
                      <div className="flex items-center mt-1">
                        <span className="text-sm text-muted-foreground border border-r-0 rounded-l-md px-3 py-2 bg-muted h-10 flex items-center">
                          /pages/
                        </span>
                        <Input
                          placeholder="customize-tumbler"
                          value={formHandle}
                          onChange={(e) => {
                            setHandleTouched(true);
                            setFormHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                          }}
                          className="rounded-l-none"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        Storefront URL: /pages/{formHandle || "…"}
                      </p>
                    </div>
                    <div>
                      <Label>Product</Label>
                      {blanksLoading ? (
                        <Skeleton className="h-10 w-full mt-1" />
                      ) : (blanksData?.blanks ?? []).length === 0 ? (
                        <p className="text-sm text-destructive mt-1">
                          No products found. Import products from Printify first.
                        </p>
                      ) : (
                        <Select value={formProductId} onValueChange={setFormProductId}>
                          <SelectTrigger className="mt-1">
                            <SelectValue placeholder="Select a product…" />
                          </SelectTrigger>
                          <SelectContent>
                            {(blanksData?.blanks ?? []).map((blank) => {
                              const val = blank.productId ? blank.productId : `pt:${blank.productTypeId}`;
                              return (
                                <SelectItem key={val} value={val}>
                                  {blank.title}
                                  {blank.needsShopifySync ? " (not yet sent to store)" : ""}
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                      )}
                      {selectedBlank?.needsShopifySync ? (
                        <p className="text-xs text-amber-600 mt-1">
                          This product hasn't been sent to your store yet. It will be automatically sent as a draft when you create this page. You'll need to set pricing in Shopify Admin before publishing it live.
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground mt-1">
                          All variants will be available to customers on the storefront.
                        </p>
                      )}
                    </div>
                    <Button
                      className="w-full"
                      onClick={advanceToStep2}
                      disabled={!formTitle.trim() || !formHandle.trim() || !formProductId}
                    >
                      Next: Set Pricing
                      <ChevronRight className="h-4 w-4 ml-2" />
                    </Button>
                  </div>
                )}

                {/* ── STEP 2: Pricing ── */}
                {formStep === 2 && (
                  <div className="space-y-4 pt-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-muted-foreground">
                        Set a price for each variant. These are written directly to your Shopify product.
                      </p>
                      {selectedBlank?.printifyBlueprintId && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-shrink-0 ml-2"
                          onClick={() => { setCostsOpen(true); setCostsShippingTier("standard"); setCostsShippingCountry("US"); }}
                        >
                          <Info className="h-3.5 w-3.5 mr-1" />
                          Printify Costs
                        </Button>
                      )}
                    </div>
                    <div className="space-y-3">
                      {selectedVariants.map((v) => (
                        <div key={v.id}>
                          <Label className="flex items-center gap-1">
                            <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
                            {v.title}
                          </Label>
                          <div className="flex items-center mt-1">
                            <span className="text-sm text-muted-foreground border border-r-0 rounded-l-md px-3 py-2 bg-muted h-10 flex items-center">
                              $
                            </span>
                            <Input
                              type="number"
                              min="0.01"
                              step="0.01"
                              placeholder="0.00"
                              value={variantPrices[v.id] ?? ""}
                              onChange={(e) => {
                                setVariantPrices((prev) => ({ ...prev, [v.id]: e.target.value }));
                                if (priceErrors[v.id]) setPriceErrors((prev) => { const n = { ...prev }; delete n[v.id]; return n; });
                              }}
                              className={`rounded-l-none ${priceErrors[v.id] ? "border-destructive focus-visible:ring-destructive" : ""}`}
                            />
                          </div>
                          {priceErrors[v.id] && (
                            <p className="text-xs text-destructive mt-1">{priceErrors[v.id]}</p>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" className="flex-1" onClick={() => setFormStep(1)}>
                        Back
                      </Button>
                      <Button className="flex-1" onClick={advanceToStep3}>
                        Review & Create
                        <ChevronRight className="h-4 w-4 ml-2" />
                      </Button>
                    </div>
                  </div>
                )}

                {/* ── Printify Costs Dialog ── */}
                <Dialog open={costsOpen} onOpenChange={setCostsOpen}>
                  <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
                    <DialogHeader>
                      <DialogTitle>Printify Costs — {selectedBlank?.title}</DialogTitle>
                    </DialogHeader>
                    <Tabs defaultValue="production" className="w-full">
                      <TabsList className="grid w-full grid-cols-2">
                        <TabsTrigger value="production">Production</TabsTrigger>
                        <TabsTrigger value="shipping">Shipping</TabsTrigger>
                      </TabsList>

                      {/* Production tab */}
                      <TabsContent value="production" className="space-y-3 pt-2">
                        {costsLoading ? (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-5 w-5 animate-spin mr-2" />
                            <span className="text-sm text-muted-foreground">Fetching production costs from Printify...</span>
                          </div>
                        ) : costsData?.costs ? (
                          <>
                            <div className="rounded-md border text-sm">
                              <div className="grid grid-cols-2 gap-2 px-3 py-2 bg-muted font-medium">
                                <span>Variant</span>
                                <span className="text-right">Production Cost</span>
                              </div>
                              {selectedVariants.length > 0 ? selectedVariants.map((v) => {
                                const costCents = costsData.shopifyVariantCosts?.[v.id] ?? costsData.costs?.[v.id];
                                return (
                                  <div key={v.id} className="grid grid-cols-2 gap-2 px-3 py-2 border-t">
                                    <span>{v.title}</span>
                                    <span className="text-right font-mono">
                                      {costCents != null ? `$${(costCents / 100).toFixed(2)}` : "—"}
                                    </span>
                                  </div>
                                );
                              }) : Object.entries(costsData.costs).map(([vid, costCents]) => (
                                <div key={vid} className="grid grid-cols-2 gap-2 px-3 py-2 border-t">
                                  <span className="text-muted-foreground">Variant {vid}</span>
                                  <span className="text-right font-mono">${(Number(costCents) / 100).toFixed(2)}</span>
                                </div>
                              ))}
                            </div>
                            {costsData.cached && (
                              <p className="text-xs text-muted-foreground">Cached data. Production costs are refreshed every 24 hours.</p>
                            )}
                          </>
                        ) : (
                          <p className="text-sm text-muted-foreground py-4 text-center">
                            Production cost data is not available for this product. Ensure your Printify API token and Shop ID are configured in Settings.
                          </p>
                        )}
                      </TabsContent>

                      {/* Shipping tab */}
                      <TabsContent value="shipping" className="space-y-3 pt-2">
                        {shippingLoading ? (
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-5 w-5 animate-spin mr-2" />
                            <span className="text-sm text-muted-foreground">Loading shipping rates...</span>
                          </div>
                        ) : shippingData?.tiers && shippingData.shipping ? (
                          <>
                            <div className="flex gap-2 flex-wrap">
                              {shippingData.tiers.map((tier) => (
                                <Button
                                  key={tier}
                                  variant={costsShippingTier === tier ? "default" : "outline"}
                                  size="sm"
                                  onClick={() => setCostsShippingTier(tier)}
                                  className="capitalize"
                                >
                                  {tier}
                                </Button>
                              ))}
                            </div>
                            {shippingData.countries && shippingData.countries.length > 0 && (
                              <Select value={costsShippingCountry} onValueChange={setCostsShippingCountry}>
                                <SelectTrigger className="w-full">
                                  <SelectValue placeholder="Select country" />
                                </SelectTrigger>
                                <SelectContent>
                                  {shippingData.countries.map((c) => (
                                    <SelectItem key={c} value={c}>
                                      {c === "REST_OF_THE_WORLD" ? "Rest of the World" : c}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                            {(() => {
                              const tierEntries = (shippingData.shipping[costsShippingTier] ?? [])
                                .filter((e) => e.country === costsShippingCountry);
                              if (tierEntries.length === 0) {
                                return <p className="text-sm text-muted-foreground text-center py-4">No shipping data for this tier/country combination.</p>;
                              }
                              const handlingTime = tierEntries[0]?.handlingTime;
                              return (
                                <>
                                  {handlingTime && (
                                    <p className="text-xs text-muted-foreground">
                                      Handling time: {handlingTime.from}–{handlingTime.to} business days
                                    </p>
                                  )}
                                  <div className="rounded-md border text-sm">
                                    <div className="grid grid-cols-3 gap-2 px-3 py-2 bg-muted font-medium">
                                      <span>Variant</span>
                                      <span className="text-right">1st Item</span>
                                      <span className="text-right">Additional</span>
                                    </div>
                                    {tierEntries.map((entry) => {
                                      const variantTitle = selectedBlank?.printifyVariantLabels?.[String(entry.variantId)]
                                        ?? costsData?.printifyVariantLabels?.[String(entry.variantId)]
                                        ?? `Variant ${entry.variantId}`;
                                      return (
                                        <div key={entry.variantId} className="grid grid-cols-3 gap-2 px-3 py-2 border-t">
                                          <span className="truncate">{variantTitle}</span>
                                          <span className="text-right font-mono">${(entry.firstItem / 100).toFixed(2)}</span>
                                          <span className="text-right font-mono">${(entry.additionalItems / 100).toFixed(2)}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </>
                              );
                            })()}
                          </>
                        ) : (
                          <p className="text-sm text-muted-foreground py-4 text-center">
                            Shipping data is not available for this product.
                          </p>
                        )}
                      </TabsContent>
                    </Tabs>
                    <p className="text-xs text-muted-foreground border-t pt-3">
                      Set your retail price above production + shipping costs to ensure profitability.
                    </p>
                  </DialogContent>
                </Dialog>

                {/* ── STEP 3: Confirm ── */}
                {formStep === 3 && (
                  <div className="space-y-4 pt-2">
                    <div className="rounded-lg border bg-muted/30 p-4 space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Page title</span>
                        <span className="font-medium">{formTitle}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">URL</span>
                        <span className="font-mono">/pages/{formHandle}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Product</span>
                        <span className="font-medium">{selectedBlank?.title ?? formProductId}</span>
                      </div>
                      {selectedBlank?.needsShopifySync ? (
                        <div className="border-t pt-2 mt-1">
                          <p className="text-xs text-amber-600">This product will be automatically sent to your store as a draft. Set pricing in Shopify Admin → Products before publishing it live.</p>
                        </div>
                      ) : (
                        <div className="border-t pt-2 mt-1 space-y-1">
                          <span className="text-muted-foreground text-xs uppercase tracking-wide">Variant prices</span>
                          {selectedVariants.map((v) => (
                            <div key={v.id} className="flex justify-between">
                              <span>{v.title}</span>
                              <span className="font-medium">${parseFloat(variantPrices[v.id] ?? "0").toFixed(2)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      This will create the customizer page on your Online Store.
                    </p>
                    <div className="flex gap-2">
                      <Button variant="outline" className="flex-1" onClick={() => setFormStep(selectedBlank?.needsShopifySync ? 1 : 2)} disabled={createMutation.isPending}>
                        Back
                      </Button>
                      <Button className="flex-1" onClick={handleSubmitCreate} disabled={createMutation.isPending}>
                        {createMutation.isPending ? (
                          <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating…</>
                        ) : (
                          <><Wand2 className="h-4 w-4 mr-2" /> Create Page</>
                        )}
                      </Button>
                    </div>
                  </div>
                )}

                {/* ── STEP 4: Success ── */}
                {formStep === 4 && (
                  <div className="space-y-5 pt-2">
                    <div className="flex flex-col items-center text-center gap-3 py-4">
                      <CheckCircle2 className="h-14 w-14 text-green-500" />
                      <div>
                        <p className="text-lg font-semibold">Your customizer page is live!</p>
                        <p className="text-sm text-muted-foreground mt-1">
                          Pricing has been saved to Shopify. The product is now published on your Online Store.
                        </p>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Button
                        className="w-full"
                        variant="outline"
                        asChild
                      >
                        <a
                          href={`https://${createdPageResult?.page?.shop ?? shopDomain}/pages/${createdPageResult?.page?.handle ?? formHandle}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="h-4 w-4 mr-2" />
                          Open customizer page
                        </a>
                      </Button>
                      {createdPageResult?.page?.baseProductId && (
                        <Button className="w-full" variant="outline" asChild>
                          <a
                            href={`https://${createdPageResult?.page?.shop ?? shopDomain}/admin/products/${createdPageResult.page.baseProductId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="h-4 w-4 mr-2" />
                            Open product in Shopify
                          </a>
                        </Button>
                      )}
                      <Button className="w-full" variant="outline" asChild>
                        <a
                          href={`https://${createdPageResult?.page?.shop ?? shopDomain}/admin/menus`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="h-4 w-4 mr-2" />
                          Edit menu link
                        </a>
                      </Button>
                    </div>
                    <p className="text-xs text-center text-muted-foreground">
                      To update pricing in the future, edit the product directly in Shopify Products.
                    </p>
                    {createdPageResult?.navWarning && (
                      <p className="text-xs text-amber-600 text-center">
                        Note: Could not auto-add nav link — please add it manually in Shopify Navigation.
                      </p>
                    )}
                    <Button className="w-full" onClick={() => { setCreateOpen(false); resetForm(); }}>
                      Done
                    </Button>
                  </div>
                )}
              </DialogContent>
            </Dialog>
          )}
        </div>

        {/* ── PLAN GATE: show PlanPicker inline when no active plan ── */}
        {pagesLoading ? (
          <Skeleton className="h-48 w-full rounded-lg" />
        ) : requiresPlan ? (
          <Card className="border-dashed">
            <CardContent className="p-0">
              <PlanPicker
                inline
                onActivated={() => {
                  queryClient.invalidateQueries({ queryKey: ["/api/appai/customizer-pages"] });
                }}
              />
            </CardContent>
          </Card>
        ) : (
          <>
            {/* ── OVER-LIMIT BANNER (downgrade scenario) ── */}
            {overLimit && (
              <Card className="border-amber-400 bg-amber-50 dark:bg-amber-950/20">
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-semibold text-amber-800 dark:text-amber-300">
                        Over plan limit
                      </p>
                      <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
                        Your <strong>{PLAN_DISPLAY[planName ?? ""] ?? planName}</strong> plan
                        allows {limit} active page{limit !== 1 ? "s" : ""}. You have{" "}
                        {activePagesCount} active. Disable {overLimitActiveCount} page
                        {overLimitActiveCount !== 1 ? "s" : ""} to comply with your plan,
                        or upgrade to unlock more.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-3 border-amber-600 text-amber-700"
                        onClick={() => navigate("/admin/plan")}
                      >
                        <TrendingUp className="h-3 w-3 mr-1.5" />
                        Upgrade Plan
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ── PLAN USAGE BAR ── */}
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium flex items-center gap-2">
                    Plan:
                    <Badge variant="secondary" className="capitalize">
                      {planName ? (PLAN_DISPLAY[planName] ?? planName) : "—"}
                    </Badge>
                    {planStatus === "trialing" && (
                      <Badge variant="outline" className="text-yellow-600 border-yellow-400">Trial</Badge>
                    )}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">
                      {count} / {limit} page{limit !== 1 ? "s" : ""}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => navigate("/admin/plan")}
                    >
                      <ArrowUpRight className="h-3 w-3 mr-1" />
                      {planStatus === "trialing" ? "Upgrade" : "Manage Plan"}
                    </Button>
                  </div>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${overLimit ? "bg-amber-500" : "bg-primary"}`}
                    style={{ width: limit > 0 ? `${Math.min((count / limit) * 100, 100)}%` : "0%" }}
                  />
                </div>
                {atLimit && !overLimit && (
                  <p className="text-xs text-amber-600 mt-2 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Plan limit reached. Upgrade to create more pages.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* ── PAGES LIST ── */}
            {pagesLoading ? (
              <div className="space-y-3">
                {[1, 2].map((i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}
              </div>
            ) : pages.length === 0 ? (
              <Card>
                <CardContent className="py-16 text-center">
                  <Globe className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
                  <p className="font-medium text-lg">No customizer pages yet</p>
                  <p className="text-sm text-muted-foreground mt-1 mb-6">
                    Create your first page to let customers design custom products on your storefront.
                  </p>
                  <Button onClick={() => setCreateOpen(true)} disabled={atLimit}>
                    <Plus className="h-4 w-4 mr-2" />
                    Create first page
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {pages.map((page) => (
                  <Card key={page.id}>
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold">{page.title}</span>
                            <Badge variant={page.status === "active" ? "default" : "secondary"}>
                              {page.status}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground mt-0.5 font-mono">
                            /pages/{page.handle}
                          </p>
                          {page.baseProductTitle && (
                            <p className="text-sm text-muted-foreground mt-1">
                              {page.baseProductTitle}
                              {page.baseVariantTitle && ` — ${page.baseVariantTitle}`}
                              {page.baseProductPrice && ` · $${parseFloat(page.baseProductPrice).toFixed(2)}`}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center gap-2 flex-shrink-0">
                          <Button variant="ghost" size="icon" asChild title="Open storefront page">
                            <a
                              href={`https://${page.shop}/pages/${page.handle}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={toggleMutation.isPending}
                            title={page.status === "active" ? "Disable page" : "Enable page"}
                            onClick={() =>
                              toggleMutation.mutate({
                                id: page.id,
                                status: page.status === "active" ? "disabled" : "active",
                              })
                            }
                          >
                            {page.status === "active" ? (
                              <ToggleRight className="h-4 w-4 text-primary" />
                            ) : (
                              <ToggleLeft className="h-4 w-4 text-muted-foreground" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Delete page"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setDeleteTarget(page)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {/* ── FALLBACK URL ── */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Disabled Page Fallback</CardTitle>
                <CardDescription>Where to redirect visitors if a customizer page is disabled.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2">
                  <Input
                    placeholder="/collections/custom-products"
                    value={hubUrl}
                    onChange={(e) => setHubUrl(e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    variant="outline"
                    onClick={() => hubUrlMutation.mutate(hubUrl)}
                    disabled={hubUrlMutation.isPending}
                  >
                    {hubUrlMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Use a relative path (e.g. <code className="bg-muted px-1 rounded">/collections/all</code>) or full URL.
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Confirm delete dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete customizer page?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete <strong>{deleteTarget?.title}</strong> (/pages/{deleteTarget?.handle}) from
              both AppAI and your Shopify store. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget?.id && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Deleting…</>
              ) : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}
