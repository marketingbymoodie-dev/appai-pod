import { useState, useMemo, useEffect } from "react";
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
  CheckCircle2, ChevronRight, DollarSign, Info, RefreshCw, Truck, Factory,
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
  baseProductId: string | null;
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
  const [syncPricesTarget, setSyncPricesTarget] = useState<CustomizerPage | null>(null);
  const [syncPricesMap, setSyncPricesMap] = useState<Record<string, string>>({});
  const [syncPricesLoading, setSyncPricesLoading] = useState(false);

  // Hub URL (fallback for disabled pages)
  const [hubUrl, setHubUrl] = useState("");

  // Form state
  const [formTitle, setFormTitle] = useState("");
  const [formHandle, setFormHandle] = useState("");
  const [formProductId, setFormProductId] = useState("");
  const [handleTouched, setHandleTouched] = useState(false);
  const [titleTouched, setTitleTouched] = useState(false);

  // Wizard state
  const [formStep, setFormStep] = useState<1 | 2 | 3 | 4>(1);
  const [variantPrices, setVariantPrices] = useState<Record<string, string>>({});
  const [priceErrors, setPriceErrors] = useState<Record<string, string>>({});
  const [confirmedVariants, setConfirmedVariants] = useState<BlankVariant[]>([]);
  const [createdPageResult, setCreatedPageResult] = useState<any>(null);

  // Costs popup state
  const [costsOpen, setCostsOpen] = useState(false);
  const [costsActiveTab, setCostsActiveTab] = useState<"production" | "shipping">("production");
  const [costsShippingCountry, setCostsShippingCountry] = useState("US");
  const [costsShippingTier, setCostsShippingTier] = useState("standard");

  // Markup percentage for recommended retail pricing (default 60%)
  const [markupPercent, setMarkupPercent] = useState(60);

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
    enabled: createOpen || !!syncPricesTarget,
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

  async function handleSyncPrices() {
    if (!syncPricesTarget) return;
    const prices = Object.fromEntries(
      Object.entries(syncPricesMap).filter(([, v]) => v && parseFloat(v) > 0)
    );
    if (Object.keys(prices).length === 0) {
      toast({ title: "No prices entered", description: "Please enter at least one price.", variant: "destructive" });
      return;
    }
    setSyncPricesLoading(true);
    try {
      const res = await apiRequest("POST", `/api/appai/customizer-pages/${syncPricesTarget.id}/sync-prices`, { variantPrices: prices });
      const data = await res.json();
      if (data.success) {
        queryClient.invalidateQueries({ queryKey: ["/api/appai/customizer-pages"] });
        toast({ title: "Prices updated", description: `Updated ${data.successCount} of ${data.totalCount} variants on Shopify.` });
        setSyncPricesTarget(null);
        setSyncPricesMap({});
      } else {
        toast({ title: "Sync failed", description: data.error ?? "Unknown error", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Sync failed", description: err.message ?? "Unknown error", variant: "destructive" });
    } finally {
      setSyncPricesLoading(false);
    }
  }

  function resetForm() {
    setFormTitle("");
    setFormHandle("");
    setFormProductId("");
    setHandleTouched(false);
    setTitleTouched(false);
    setFormStep(1);
    setVariantPrices({});
    setPriceErrors({});
    setCreatedPageResult(null);
  }

  function handleTitleChange(val: string) {
    setTitleTouched(true);
    setFormTitle(val);
    if (!handleTouched) setFormHandle(slugify(val));
  }

  /** Simplify a Printify product name to a short page title.
   *  e.g. "Custom Spun Polyester Square Pillow" → "Square Pillow"
   *       "Premium Unisex Crewneck Sweatshirt" → "Crewneck Sweatshirt"
   */
  function simplifyProductName(name: string): string {
    const STRIP_WORDS = [
      "custom", "spun", "polyester", "premium", "unisex", "classic",
      "basic", "standard", "all-over", "all over", "print",
      "sublimation", "sublimated", "dye", "digital",
    ];
    let words = name.split(/\s+/);
    // Remove leading words that match the strip list
    while (words.length > 1 && STRIP_WORDS.includes(words[0].toLowerCase().replace(/[^a-z]/g, ""))) {
      words = words.slice(1);
    }
    return words.join(" ");
  }

  /** Derive variants for the currently-selected product (Step 2 pricing) */
  const selectedBlank = (blanksData?.blanks ?? []).find(
    (b) => (b.productId ? b.productId : `pt:${b.productTypeId}`) === formProductId
  );

  /**
   * Deduplicate variants by size — strip the color suffix (" / Color") from variant
   * titles and keep only the first variant per unique size name. This prevents phone
   * case products (e.g. "iPhone 12 Pro / Black", "iPhone 12 Pro / Clear") from
   * showing duplicate pricing rows for the same model.
   */
  const selectedVariants: BlankVariant[] = useMemo(() => {
    const raw = selectedBlank?.variants ?? [];
    const seen = new Set<string>();
    const deduped: BlankVariant[] = [];
    for (const v of raw) {
      // Strip color suffix: "iPhone 12 Pro / Black" → "iPhone 12 Pro"
      const sizeOnly = v.title.includes(" / ") ? v.title.split(" / ")[0].trim() : v.title;
      if (!seen.has(sizeOnly)) {
        seen.add(sizeOnly);
        deduped.push({ ...v, title: sizeOnly });
      }
    }
    return deduped;
  }, [selectedBlank?.variants]);

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
    enabled: (costsOpen || formStep === 2) && !!selectedBlank?.productTypeId && !!selectedBlank?.printifyBlueprintId,
  });

  // Mutation: clear all cached costs and refetch for current product
  const clearCostsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/printify/costs/clear-cache");
      if (!res.ok) throw new Error("Failed to clear costs cache");
      return res.json();
    },
    onSuccess: () => {
      // Invalidate the costs query so it re-fetches fresh data
      queryClient.invalidateQueries({ queryKey: ["/api/admin/printify/costs"] });
      toast({ title: "Costs refreshed", description: "Production costs cache cleared. Fetching fresh data…" });
    },
    onError: () => {
      toast({ title: "Refresh failed", description: "Could not clear costs cache. Please try again.", variant: "destructive" });
    },
  });

  // Shipping rates query
  const { data: shippingData, isLoading: shippingLoading } = useQuery<{
    shipping: Record<string, any[]>;
    tiers: string[];
    countries: string[];
  }>({
    queryKey: ["/api/admin/printify/shipping", selectedBlank?.printifyBlueprintId, selectedBlank?.printifyProviderId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/printify/shipping/${selectedBlank!.printifyBlueprintId}/${selectedBlank!.printifyProviderId}`);
      return res.json();
    },
    enabled: costsOpen && !!selectedBlank?.printifyBlueprintId && !!selectedBlank?.printifyProviderId,
  });

  // Helper to round up to .95
  function roundUpTo95(num: number): number {
    return Math.ceil(num) - 0.05;
  }

  // Recommended retail prices based on production costs + markup
  const recommendedPrices = useMemo(() => {
    if (!costsData?.costs || selectedVariants.length === 0) return {};
    const result: Record<string, string> = {};
    // Build a normalised-label → cost-in-cents lookup from Printify variant labels
    // e.g. { "14x14" → 850, "18x18" → 950, ... }
    const labelToCost: Record<string, number> = {};
    if (costsData.printifyVariantLabels && costsData.costs) {
      for (const [printifyVid, label] of Object.entries(costsData.printifyVariantLabels)) {
        const costCents = costsData.costs[printifyVid];
        if (costCents != null) {
          labelToCost[label.toLowerCase().trim()] = costCents;
        }
      }
    }
    for (const v of selectedVariants) {
      // 1) Direct Shopify variant ID bridge
      let costCents: number | undefined = costsData.shopifyVariantCosts?.[v.id];
      // 2) Direct Printify variant ID lookup (fallback)
      if (costCents == null) costCents = costsData.costs?.[v.id];
      // 3) Label-based fallback: match variant title against Printify variant labels
      if (costCents == null && v.title) {
        const normTitle = v.title.toLowerCase().trim();
        // Try exact match first
        costCents = labelToCost[normTitle];
        // Try partial match: check if any label is contained in the variant title or vice versa
        if (costCents == null) {
          for (const [label, cost] of Object.entries(labelToCost)) {
            if (normTitle.includes(label) || label.includes(normTitle)) {
              costCents = cost;
              break;
            }
          }
        }
      }
      if (costCents == null) continue;
      const raw = (costCents / 100) * (1 + markupPercent / 100);
      result[v.id] = roundUpTo95(raw).toFixed(2);
    }
    return result;
  }, [costsData, selectedVariants, markupPercent]);

  // Auto-apply recommended prices to empty price fields whenever costs load or markup changes
  useEffect(() => {
    if (formStep !== 2) return;
    if (Object.keys(recommendedPrices).length === 0) return;
    setVariantPrices((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [id, price] of Object.entries(recommendedPrices)) {
        // Only fill in if the field is currently empty or zero
        if (!next[id] || next[id] === "" || next[id] === "0" || next[id] === "0.00") {
          next[id] = price;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [recommendedPrices, formStep]);

  // Auto-populate page title from product name when product is selected (if title not manually edited)
  useEffect(() => {
    if (!selectedBlank) return;
    if (titleTouched) return; // user has manually typed a title — don't overwrite
    const simplified = simplifyProductName(selectedBlank.title);
    setFormTitle(simplified);
    if (!handleTouched) setFormHandle(slugify(simplified));
  }, [selectedBlank?.title, titleTouched]);

  /** When moving from Step 1 → Step 2, pre-fill prices from Shopify data */
  function advanceToStep2() {
    if (!formTitle.trim() || !formHandle.trim() || !formProductId) return;
    // If the product has no variants (e.g. not yet on Shopify), skip pricing step
    if (selectedVariants.length === 0) {
      setConfirmedVariants([]);
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
    setConfirmedVariants(selectedVariants);
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
  const atLimit = false; // We allow unlimited creation now, only restrict activation

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
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Page
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg flex flex-col" style={{maxHeight: 'min(90vh, 700px)'}}>
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
                    {/* Product first */}
                    <div>
                      <Label>Product</Label>
                      {blanksLoading ? (
                        <Skeleton className="h-10 w-full mt-1" />
                      ) : (blanksData?.blanks ?? []).length === 0 ? (
                        <p className="text-sm text-destructive mt-1">
                          No products found. Import products from Printify first.
                        </p>
                      ) : (
                        <Select value={formProductId} onValueChange={(val) => { setFormProductId(val); }}>
                          <SelectTrigger className="mt-1">
                            <SelectValue placeholder="Select a product…" />
                          </SelectTrigger>
                          <SelectContent>
                            {(blanksData?.blanks ?? []).map((blank) => {
                              const val = blank.productId ? blank.productId : `pt:${blank.productTypeId}`;
                              return (
                                <SelectItem key={val} value={val}>
                                  {blank.title}
                                  {blank.needsShopifySync ? " (new — will be sent to store)" : ""}
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                      )}
                      {selectedBlank?.needsShopifySync ? (
                        <p className="text-xs text-muted-foreground mt-1">
                          This product will be automatically created on your store when you finish setting up this page.
                        </p>
                      ) : null}
                    </div>

                    <div>
                      <Label htmlFor="title">Page Title</Label>
                      <Input
                        id="title"
                        placeholder="e.g. Custom Pillow"
                        value={formTitle}
                        onChange={(e) => handleTitleChange(e.target.value)}
                        className="mt-1"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        Auto-filled from product name — feel free to edit.
                      </p>
                    </div>

                    <div>
                      <Label htmlFor="handle">URL Handle</Label>
                      <div className="flex items-center mt-1">
                        <div className="bg-muted px-3 py-2 rounded-l-md border border-r-0 text-sm text-muted-foreground">
                          /pages/
                        </div>
                        <Input
                          id="handle"
                          placeholder="custom-pillow"
                          value={formHandle}
                          onChange={(e) => { setHandleTouched(true); setFormHandle(slugify(e.target.value)); }}
                          className="rounded-l-none"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        Storefront URL: /pages/{formHandle || "..."}
                      </p>
                    </div>

                    <Button
                      className="w-full mt-2"
                      disabled={!formTitle.trim() || !formHandle.trim() || !formProductId}
                      onClick={advanceToStep2}
                    >
                      Next: Set Pricing <ChevronRight className="h-4 w-4 ml-1" />
                    </Button>
                  </div>
                )}

                {/* ── STEP 2: Pricing ── */}
                {formStep === 2 && (
                  <div className="flex flex-col min-h-0 flex-1 pt-2">
                    {blanksLoading ? (
                      <div className="flex flex-col items-center justify-center py-12 gap-3">
                        <Loader2 className="h-8 w-8 animate-spin text-primary" />
                        <p className="text-sm text-muted-foreground">Loading variant prices…</p>
                      </div>
                    ) : (
                    <>
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-muted-foreground">Set a retail price for each variant.</p>
                      <Dialog open={costsOpen} onOpenChange={setCostsOpen}>
                        <DialogTrigger asChild>
                          <Button variant="outline" size="sm">
                            <Info className="h-4 w-4 mr-2" />
                            Printify Costs
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
                          <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                              <DollarSign className="h-5 w-5 text-emerald-600" />
                              Production & Shipping Costs
                            </DialogTitle>
                            <p className="text-sm text-muted-foreground">
                              Estimated costs for <strong>{selectedBlank?.title}</strong>.
                            </p>
                          </DialogHeader>

                          <Tabs value={costsActiveTab} onValueChange={(v: any) => setCostsActiveTab(v)} className="mt-2">
                            <TabsList className="grid w-full grid-cols-2">
                              <TabsTrigger value="production" className="flex items-center gap-1.5">
                                <Factory className="h-3.5 w-3.5 shrink-0" />
                                <span className={costsActiveTab === "production" ? "shimmer-text" : ""}>
                                  Production
                                </span>
                              </TabsTrigger>
                              <TabsTrigger value="shipping" className="flex items-center gap-1.5">
                                <Truck className="h-3.5 w-3.5 shrink-0" />
                                <span className={costsActiveTab === "shipping" ? "shimmer-text" : ""}>
                                  Shipping
                                </span>
                              </TabsTrigger>
                            </TabsList>

                            {/* Production tab */}
                            <TabsContent value="production" className="space-y-4 pt-2">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <Label htmlFor="markup" className="text-sm font-medium">Global Markup</Label>
                                  <div className="flex items-center gap-1">
                                    <Input
                                      id="markup"
                                      type="number"
                                      className="w-16 h-8"
                                      value={markupPercent}
                                      onChange={(e) => setMarkupPercent(Number(e.target.value))}
                                    />
                                    <span className="text-sm text-muted-foreground">%</span>
                                  </div>
                                </div>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => clearCostsMutation.mutate()}
                                  disabled={clearCostsMutation.isPending || costsLoading}
                                >
                                  <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${clearCostsMutation.isPending ? 'animate-spin' : ''}`} />
                                  Refresh Costs
                                </Button>
                              </div>

                              {costsLoading ? (
                                <div className="flex items-center justify-center py-8">
                                  <Loader2 className="h-5 w-5 animate-spin mr-2" />
                                  <span className="text-sm text-muted-foreground">Fetching Printify costs...</span>
                                </div>
                              ) : costsData?.costs || costsData?.shopifyVariantCosts ? (
                                <>
                                  <div className="rounded-md border text-sm">
                                    <div className="grid grid-cols-3 gap-2 px-3 py-2 bg-muted font-medium">
                                      <span>Variant</span>
                                      <span className="text-right">Standard Cost</span>
                                      <span className="text-right text-emerald-700">Premium Cost</span>
                                    </div>
                                    {selectedVariants.length > 0 ? selectedVariants.map((v) => {
                                      // Try Shopify variant ID first, then fall back to label-based matching
                                      // (label matching handles cases where shopifyVariantCosts is not populated)
                                      let costCents: number | undefined = costsData.shopifyVariantCosts?.[v.id] ?? costsData.costs?.[v.id];
                                      if (costCents == null && costsData.printifyVariantLabels) {
                                        const matchingPrintifyId = Object.entries(costsData.printifyVariantLabels)
                                          .find(([, label]) => label === v.title)?.[0];
                                        if (matchingPrintifyId) costCents = costsData.costs?.[matchingPrintifyId];
                                        // Partial match fallback
                                        if (costCents == null && v.title) {
                                          const normTitle = v.title.toLowerCase().trim();
                                          for (const [pid, label] of Object.entries(costsData.printifyVariantLabels)) {
                                            const normLabel = label.toLowerCase().trim();
                                            if (normTitle.includes(normLabel) || normLabel.includes(normTitle)) {
                                              costCents = costsData.costs?.[pid];
                                              if (costCents != null) break;
                                            }
                                          }
                                        }
                                      }
                                      return (
                                        <div key={v.id} className="grid grid-cols-3 gap-2 px-3 py-2 border-t">
                                          <span className="truncate">{v.title}</span>
                                          <span className="text-right font-mono">
                                            {costCents != null ? `$${(costCents / 100).toFixed(2)}` : "—"}
                                          </span>
                                          <span className="text-right font-mono text-emerald-600">
                                            {costCents != null ? `$${(costCents * 0.8 / 100).toFixed(2)}` : "—"}
                                          </span>
                                        </div>
                                      );
                                    }) : Object.entries(costsData.costs).map(([vid, costCents]) => (
                                      <div key={vid} className="grid grid-cols-3 gap-2 px-3 py-2 border-t">
                                        <span className="text-muted-foreground">Variant {vid}</span>
                                        <span className="text-right font-mono">${(Number(costCents) / 100).toFixed(2)}</span>
                                        <span className="text-right font-mono text-emerald-600">${(Number(costCents) * 0.8 / 100).toFixed(2)}</span>
                                      </div>
                                    ))}
                                  </div>
                                  <p className="text-xs text-muted-foreground">Premium estimates based on up to 20% Printify Premium discount. Shipping costs are separate.</p>
                                  {costsData.cached && (
                                    <p className="text-xs text-muted-foreground">Cached data. Use the Refresh button above to fetch the latest costs.</p>
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
                                  <div className="flex gap-2 flex-wrap items-center">
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
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => clearCostsMutation.mutate()}
                                      disabled={clearCostsMutation.isPending || costsLoading}
                                      className="ml-auto shrink-0"
                                    >
                                      <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${clearCostsMutation.isPending ? 'animate-spin' : ''}`} />
                                      Refresh Pricing
                                    </Button>
                                  </div>
                                  {shippingData.countries && shippingData.countries.length > 0 && (
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm font-medium whitespace-nowrap">Country</span>
                                      <Select value={costsShippingCountry} onValueChange={setCostsShippingCountry}>
                                        <SelectTrigger className="flex-1">
                                          <SelectValue placeholder="Select country" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {(() => {
                                            const sorted = [...shippingData.countries].sort((a, b) => {
                                              if (a === "US") return -1;
                                              if (b === "US") return 1;
                                              if (a === "REST_OF_THE_WORLD") return -1;
                                              if (b === "REST_OF_THE_WORLD") return 1;
                                              return a.localeCompare(b);
                                            });
                                            return sorted.map((c) => (
                                              <SelectItem key={c} value={c}>
                                                {c === "REST_OF_THE_WORLD" ? "Rest of the World" : c}
                                              </SelectItem>
                                            ));
                                          })()}
                                        </SelectContent>
                                      </Select>
                                    </div>
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
                                          {(() => {
                                            const seen = new Set<string>();
                                            return tierEntries.filter((entry) => {
                                              const label = selectedBlank?.printifyVariantLabels?.[String(entry.variantId)]
                                                ?? costsData?.printifyVariantLabels?.[String(entry.variantId)]
                                                ?? `Variant ${entry.variantId}`;
                                              const key = `${label}|${entry.firstItem}|${entry.additionalItems}`;
                                              if (seen.has(key)) return false;
                                              seen.add(key);
                                              return true;
                                            }).map((entry) => {
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
                                            });
                                          })()}
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
                    </div>

                    <div className="flex items-center gap-4 p-3 bg-muted/50 rounded-lg border">
                      <div className="flex-1">
                        <Label htmlFor="markup-main" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Markup</Label>
                        <div className="flex items-center gap-2 mt-1">
                          <Input
                            id="markup-main"
                            type="number"
                            className="w-20"
                            value={markupPercent}
                            onChange={(e) => setMarkupPercent(Number(e.target.value))}
                          />
                          <span className="text-sm font-medium">%</span>
                        </div>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-10"
                        onClick={() => {
                          const next: Record<string, string> = {};
                          for (const [id, price] of Object.entries(recommendedPrices)) {
                            next[id] = price;
                          }
                          setVariantPrices(next);
                        }}
                      >
                        Apply All Suggested
                      </Button>
                    </div>

                    <div className="space-y-3 overflow-y-auto pr-1 flex-1 min-h-0" style={{maxHeight: '240px'}}>
                      <p className="text-xs font-semibold shimmer-text">
                        Shipping rates vary by destination and are automatically calculated by Shopify once the customer enters their delivery address at checkout — no action needed. To offer free shipping, open <span className="text-primary font-medium">Printify Costs → Shipping</span> to find the rate for your target market and add it to the RRP below.
                      </p>
                      {selectedVariants.map((v) => (
                        <div key={v.id} className="space-y-1.5">
                          <div className="flex justify-between items-end">
                            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{v.title}</Label>
                            {costsLoading ? (
                              <div className="flex items-center gap-1">
                                <Loader2 className="h-2.5 w-2.5 animate-spin text-muted-foreground" />
                                <span className="text-[10px] text-muted-foreground italic">Calculating...</span>
                              </div>
                            ) : recommendedPrices[v.id] ? (
                              <span className="text-[10px] text-muted-foreground">Suggested: ${recommendedPrices[v.id]}</span>
                            ) : null}
                          </div>
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                            <Input
                              className={`pl-7 ${priceErrors[v.id] ? "border-destructive" : ""}`}
                              placeholder="0.00"
                              value={variantPrices[v.id] ?? ""}
                              onChange={(e) => setVariantPrices({ ...variantPrices, [v.id]: e.target.value })}
                            />
                          </div>
                          {priceErrors[v.id] && (
                            <p className="text-[10px] text-destructive font-medium">{priceErrors[v.id]}</p>
                          )}
                        </div>
                      ))}
                    </div>

                    <div className="flex gap-2 pt-2 shrink-0">
                      <Button variant="outline" className="flex-1" onClick={() => setFormStep(1)}>
                        Back
                      </Button>
                      <Button className="flex-1" onClick={advanceToStep3}>
                        Review & Create <ChevronRight className="h-4 w-4 ml-1" />
                      </Button>
                    </div>
                    </>
                    )}
                  </div>
                )}

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
                      {selectedVariants.length > 0 ? (
                        <div className="border-t pt-2 mt-1 space-y-1">
                          <span className="text-muted-foreground text-xs uppercase tracking-wide">Variant prices</span>
                          <div className={selectedVariants.length > 6 ? "max-h-[160px] overflow-y-auto pr-1 space-y-1" : "space-y-1"}>
                            {selectedVariants.map((v) => (
                              <div key={v.id} className="flex justify-between">
                                <span>{v.title}</span>
                                <span className="font-medium">${parseFloat(variantPrices[v.id] ?? "0").toFixed(2)}</span>
                              </div>
                            ))}
                          </div>
                          {selectedVariants.length > 6 && (
                            <p className="text-[10px] text-muted-foreground pt-1">{selectedVariants.length} variants total — scroll to view all</p>
                          )}
                        </div>
                      ) : (
                        <div className="border-t pt-2 mt-1">
                          <p className="text-xs text-muted-foreground">Pricing will be set automatically based on your product configuration.</p>
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      This will create the customizer page on your Online Store.
                    </p>
                    <div className="flex gap-2">
                      <Button variant="outline" className="flex-1" onClick={() => setFormStep(selectedVariants.length === 0 ? 1 : 2)} disabled={createMutation.isPending}>
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
                {formStep === 4 && createdPageResult && (
                  <div className="space-y-6 py-4 text-center">
                    <div className="flex flex-col items-center space-y-2">
                      <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                        <CheckCircle2 className="h-6 w-6 text-primary" />
                      </div>
                      <h3 className="text-lg font-semibold">Customizer Page Created!</h3>
                      <p className="text-sm text-muted-foreground">
                        Your page is now live on your storefront.
                      </p>
                    </div>

                    <div className="bg-muted/50 rounded-lg p-4 space-y-3 text-left">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">Storefront URL</span>
                        <a
                          href={`https://${shopDomain}/pages/${createdPageResult.page.handle}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary flex items-center hover:underline"
                        >
                          View Page <ExternalLink className="h-3 w-3 ml-1" />
                        </a>
                      </div>
                      <div className="p-2 bg-background rounded border font-mono text-xs break-all">
                        https://{shopDomain}/pages/{createdPageResult.page.handle}
                      </div>
                      {createdPageResult.navWarning ? (
                        <div className="flex items-start gap-2 pt-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          <div className="space-y-1">
                            {createdPageResult.navWarning.includes("Navigation scope missing") ? (
                              <>
                                <span className="font-semibold">App needs to be reinstalled to manage navigation.</span>
                                <span className="block">The app is missing the <code>read_online_store_navigation</code> permission. Click below to reinstall — it only takes a moment.</span>
                                <button
                                  className="mt-1 underline font-semibold text-amber-800"
                                  onClick={() => window.open(`/shopify/reinstall?shop=${shopDomain}`, "_top")}
                                >
                                  Reinstall App →
                                </button>
                              </>
                            ) : (
                              <span>Navigation menu could not be updated automatically. Please add the page link manually in your Shopify admin under <strong>Online Store → Navigation</strong>.</span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 pt-1 text-xs text-green-700">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>Added to your store navigation menu automatically.</span>
                        </div>
                      )}
                    </div>

                    <Button className="w-full" onClick={() => { setCreateOpen(false); resetForm(); }}>
                      Done
                    </Button>
                  </div>
                )}
              </DialogContent>
            </Dialog>
          )}
        </div>

        {/* Reauth Banner */}
        {reauthData && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-yellow-800">Shopify connection needs to be refreshed</h3>
              <p className="text-sm text-yellow-700 mt-1">
                Your app's Shopify access token has expired or been revoked. Click below to reconnect
                your store — this only takes a moment.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3 border-yellow-300 text-yellow-800 hover:bg-yellow-100"
                onClick={() => window.open(reauthData.reinstallUrl, "_top")}
              >
                Reconnect Shopify
              </Button>
            </div>
          </div>
        )}

        {/* Main Content */}
        {pagesLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <>
            {/* ── UPGRADE PROMPT (if over limit) ── */}
            {overLimit && (
              <Card className="border-amber-200 bg-amber-50">
                <CardContent className="pt-6">
                  <div className="flex items-start gap-4">
                    <div className="h-10 w-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                      <TrendingUp className="h-5 w-5 text-amber-600" />
                    </div>
                    <div className="flex-1">
                      <h3 className="text-base font-semibold text-amber-900">Unlock more customizer pages</h3>
                      <p className="text-sm text-amber-800 mt-1">
                        You've reached the limit of <strong>{limit} active pages</strong> on your current plan.
                        Upgrade to activate more pages and grow your custom product catalog.
                      </p>
                      <Button
                        size="sm"
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
                {count >= limit && limit > 0 && (
                  <p className="text-xs text-amber-600 mt-2 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Active page limit reached ({limit}). Deactivate a page or upgrade to activate more.
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
                  <Button onClick={() => setCreateOpen(true)}>
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
                            title="Sync prices to Shopify"
                            onClick={() => {
                              setSyncPricesTarget(page);
                              setSyncPricesMap({});
                            }}
                          >
                            <DollarSign className="h-4 w-4" />
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

      {/* Sync Prices dialog */}
      <Dialog open={!!syncPricesTarget} onOpenChange={(v) => { if (!v) { setSyncPricesTarget(null); setSyncPricesMap({}); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5" />
              Sync Prices — {syncPricesTarget?.title}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <p className="text-sm text-muted-foreground">
              Enter the retail price for each variant. These will be pushed directly to Shopify.
            </p>
            {syncPricesTarget && (() => {
              if (blanksLoading) {
                return <Skeleton className="h-24 w-full" />;
              }
              // Find the blank for this page's product
              const blank = (blanksData?.blanks ?? []).find(
                (b) => b.productId === syncPricesTarget.baseProductId
              );
              const variants = blank?.variants ?? [];
              if (variants.length === 0) {
                return (
                  <p className="text-sm text-amber-600">
                    No variant data available. Make sure the product is imported.
                  </p>
                );
              }
              return (
                <div className="space-y-2">
                  {variants.map((v) => (
                    <div key={v.id} className="flex items-center gap-3">
                      <span className="text-sm flex-1 min-w-0 truncate">{v.title}</span>
                      <div className="relative w-28 shrink-0">
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                        <Input
                          className="pl-6 text-sm"
                          placeholder="0.00"
                          value={syncPricesMap[v.id] ?? ""}
                          onChange={(e) => setSyncPricesMap({ ...syncPricesMap, [v.id]: e.target.value })}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
            <div className="flex gap-2 pt-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => { setSyncPricesTarget(null); setSyncPricesMap({}); }}
                disabled={syncPricesLoading}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                onClick={handleSyncPrices}
                disabled={syncPricesLoading}
              >
                {syncPricesLoading ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Syncing…</>
                ) : (
                  <><RefreshCw className="h-4 w-4 mr-2" /> Sync Prices</>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
