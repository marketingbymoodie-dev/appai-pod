import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DollarSign, Loader2, RefreshCw } from "lucide-react";

type BlankVariant = { id: string; title: string; price?: string };

type Blank = {
  productTypeId: number;
  productId: string | null;
  title: string;
  printifyBlueprintId?: number | null;
  variants: BlankVariant[];
};

export type ResyncPricesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  productTypeId: number;
  /** When set, POST to customizer-pages sync endpoint */
  customizerPageId?: string;
  onSuccess?: () => void;
};

export default function ResyncPricesDialog({
  open,
  onOpenChange,
  title,
  productTypeId,
  customizerPageId,
  onSuccess,
}: ResyncPricesDialogProps) {
  const { toast } = useToast();
  const [pricesMap, setPricesMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [markupPercent, setMarkupPercent] = useState(60);

  const { data: blanksData, isLoading: blanksLoading } = useQuery<{ blanks: Blank[] }>({
    queryKey: ["/api/appai/blanks"],
    enabled: open,
  });

  const blank = useMemo(() => {
    if (!open || !blanksData?.blanks) return null;
    return blanksData.blanks.find((b) => b.productTypeId === productTypeId) ?? null;
  }, [open, blanksData, productTypeId]);

  const variants: BlankVariant[] = useMemo(() => {
    const raw = blank?.variants ?? [];
    const seen = new Set<string>();
    const deduped: BlankVariant[] = [];
    for (const v of raw) {
      if (!seen.has(v.title)) {
        seen.add(v.title);
        deduped.push(v);
      }
    }
    return deduped;
  }, [blank?.variants]);

  const { data: costsData, isLoading: costsLoading } = useQuery<{
    costs: Record<string, number>;
    shopifyVariantCosts: Record<string, number>;
    printifyVariantLabels: Record<string, string>;
    cached: boolean;
  }>({
    queryKey: ["/api/admin/printify/costs", productTypeId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/printify/costs/${productTypeId}`);
      return res.json();
    },
    enabled: open && !!blank?.printifyBlueprintId,
  });

  const recommendedPrices = useMemo(() => {
    if (!costsData?.costs || variants.length === 0) return {};
    const result: Record<string, string> = {};
    const labelToCost: Record<string, number> = {};
    if (costsData.printifyVariantLabels && costsData.costs) {
      for (const [printifyVid, label] of Object.entries(costsData.printifyVariantLabels)) {
        const costCents = costsData.costs[printifyVid];
        if (costCents != null) labelToCost[label.toLowerCase().trim()] = costCents;
      }
    }
    for (const v of variants) {
      let costCents: number | undefined = costsData.shopifyVariantCosts?.[v.id];
      if (costCents == null) costCents = costsData.costs?.[v.id];
      if (costCents == null && v.title) {
        const normTitle = v.title.toLowerCase().trim();
        costCents = labelToCost[normTitle];
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
      result[v.id] = (Math.ceil(raw) - 0.05).toFixed(2);
    }
    return result;
  }, [costsData, variants, markupPercent]);

  useEffect(() => {
    if (!open) {
      setPricesMap({});
      setMarkupPercent(60);
      return;
    }
    const prefilled: Record<string, string> = {};
    for (const v of variants) {
      prefilled[v.id] = v.price && v.price !== "0.00" ? v.price : "";
    }
    setPricesMap(prefilled);
  }, [open, productTypeId, variants]);

  useEffect(() => {
    if (!open || Object.keys(recommendedPrices).length === 0) return;
    setPricesMap((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [id, price] of Object.entries(recommendedPrices)) {
        if (!next[id] || next[id] === "" || next[id] === "0" || next[id] === "0.00") {
          next[id] = price;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [recommendedPrices, open]);

  async function handleSubmit() {
    const prices = Object.fromEntries(
      Object.entries(pricesMap).filter(([, v]) => v && parseFloat(v) > 0),
    );
    if (Object.keys(prices).length === 0) {
      toast({
        title: "No prices entered",
        description: "Please enter at least one price.",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    try {
      const endpoint = customizerPageId
        ? `/api/appai/customizer-pages/${customizerPageId}/sync-prices`
        : `/api/admin/product-types/${productTypeId}/sync-prices`;
      const res = await apiRequest("POST", endpoint, { variantPrices: prices });
      const data = await res.json();
      if (data.success) {
        queryClient.invalidateQueries({ queryKey: ["/api/appai/customizer-pages"] });
        queryClient.invalidateQueries({ queryKey: ["/api/product-types"] });
        queryClient.invalidateQueries({ queryKey: ["/api/appai/blanks"] });
        toast({
          title: "Prices updated",
          description: `Updated ${data.successCount} of ${data.totalCount} variants on Shopify.`,
        });
        onOpenChange(false);
        onSuccess?.();
      } else {
        toast({ title: "Resync failed", description: data.error ?? "Unknown error", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Resync failed", description: err.message ?? "Unknown error", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  const needsShopify = blank?.productId == null && !customizerPageId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Resync Prices — {title}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <p className="text-sm text-muted-foreground">
            Prices are calculated from Printify production costs. Adjust markup and apply suggested prices, or edit individually.
          </p>

          {needsShopify ? (
            <p className="text-sm text-amber-600">
              This product is not on Shopify yet. Send to store first, then resync prices.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-4 p-3 bg-muted/50 rounded-lg border">
                <div className="flex-1">
                  <Label htmlFor="resync-markup" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Markup
                  </Label>
                  <div className="flex items-center gap-2 mt-1">
                    <Input
                      id="resync-markup"
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
                  disabled={Object.keys(recommendedPrices).length === 0}
                  onClick={() => {
                    const next: Record<string, string> = {};
                    for (const [id, price] of Object.entries(recommendedPrices)) {
                      next[id] = price;
                    }
                    setPricesMap(next);
                  }}
                >
                  Apply All Suggested
                </Button>
              </div>

              {blanksLoading || costsLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : variants.length === 0 ? (
                <p className="text-sm text-amber-600">
                  No variant data available. Refresh variants on the product first.
                </p>
              ) : (
                <div className="space-y-2 overflow-y-auto pr-1" style={{ maxHeight: "240px" }}>
                  {variants.map((v) => (
                    <div key={v.id} className="space-y-1">
                      <div className="flex justify-between items-end">
                        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          {v.title}
                        </Label>
                        {recommendedPrices[v.id] ? (
                          <span className="text-[10px] text-muted-foreground">
                            Suggested: ${recommendedPrices[v.id]}
                          </span>
                        ) : null}
                      </div>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                        <Input
                          className="pl-7 text-sm"
                          placeholder="0.00"
                          value={pricesMap[v.id] ?? ""}
                          onChange={(e) => setPricesMap({ ...pricesMap, [v.id]: e.target.value })}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          <div className="flex gap-2 pt-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              className="flex-1"
              onClick={() => void handleSubmit()}
              disabled={loading || needsShopify || variants.length === 0}
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Syncing…
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" /> Resync Prices
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
