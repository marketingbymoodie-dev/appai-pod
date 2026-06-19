import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Redirect } from "wouter";
import AdminLayout from "@/components/admin-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, Crosshair, Upload, RefreshCw, Trash2, Check } from "lucide-react";
import PrintifyCatalogLink from "@/components/catalog/PrintifyCatalogLink";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type PublishState = {
  published: boolean;
  version?: number;
  tier?: string;
  publishedAt?: string;
  panelMappingTemplate?: string;
};

type CatalogProduct = {
  blueprintId: number;
  label: string;
  brand?: string | null;
  category: string;
  kind: "flat" | "aop";
  panelMappingTemplate?: string;
  harvestComplete?: boolean;
  harvestOutcome?: "none" | "ready" | "unsupported" | "failed";
  harvestError?: string;
  publish: PublishState;
};

type HarvestPhase = "idle" | "running" | "complete" | "failed";

export default function PlatformCatalogPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState<"all" | "flat" | "aop">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "live" | "draft">("all");
  const [removeTarget, setRemoveTarget] = useState<CatalogProduct | null>(null);
  const [harvestPhaseById, setHarvestPhaseById] = useState<Record<number, HarvestPhase>>({});
  const prevHarvestPhaseRef = useRef<Record<number, HarvestPhase>>({});

  const { data: platformStatus, isLoading: platformLoading } = useQuery<{ isPlatformAdmin: boolean }>({
    queryKey: ["/api/platform/admin/status"],
  });

  const anyHarvesting = useMemo(
    () => Object.values(harvestPhaseById).some((phase) => phase === "running"),
    [harvestPhaseById],
  );

  const { data, isLoading, refetch } = useQuery<{ products: CatalogProduct[] }>({
    queryKey: ["/api/platform/canonical/products"],
    enabled: !!platformStatus?.isPlatformAdmin,
    refetchInterval: anyHarvesting ? 15_000 : false,
  });

  useEffect(() => {
    if (!data?.products) return;
    setHarvestPhaseById((prev) => {
      const next = { ...prev };
      for (const p of data.products) {
        if (p.kind !== "flat") continue;
        if (p.harvestComplete) {
          next[p.blueprintId] = "complete";
        } else if (p.harvestOutcome === "failed" || p.harvestOutcome === "unsupported") {
          next[p.blueprintId] = "failed";
        } else if (prev[p.blueprintId] !== "running") {
          next[p.blueprintId] = "idle";
        }
      }
      return next;
    });
  }, [data?.products]);

  useEffect(() => {
    for (const p of data?.products ?? []) {
      if (p.kind !== "flat") continue;
      const phase = harvestPhaseById[p.blueprintId] ?? "idle";
      const prev = prevHarvestPhaseRef.current[p.blueprintId] ?? "idle";
      if (prev === "running" && phase === "complete" && p.harvestComplete) {
        toast({
          title: "Harvest complete",
          description: `${p.label} is ready — open Flat calibrator, then Publish.`,
        });
      } else if (
        prev === "running" &&
        phase === "failed" &&
        (p.harvestOutcome === "failed" || p.harvestOutcome === "unsupported")
      ) {
        toast({
          title: p.harvestOutcome === "unsupported" ? "Not a flat product" : "Harvest failed",
          description: p.harvestError || `${p.label} could not be harvested for flat mockups.`,
          variant: "destructive",
        });
      }
      prevHarvestPhaseRef.current[p.blueprintId] = phase;
    }
  }, [data?.products, harvestPhaseById, toast]);

  const publishMutation = useMutation({
    mutationFn: async (blueprintId: number) => {
      const res = await apiRequest("POST", `/api/platform/canonical/${blueprintId}/publish`, { version: 1 });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Published", description: "Merchants can now import this product instantly." });
      queryClient.invalidateQueries({ queryKey: ["/api/platform/canonical/products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/catalog/allowed-blueprints"] });
    },
    onError: (e: Error) => toast({ title: "Publish failed", description: e.message, variant: "destructive" }),
  });

  const harvestMutation = useMutation({
    mutationFn: async (blueprintId: number) => {
      const res = await apiRequest("POST", `/api/platform/canonical/${blueprintId}/harvest`, { version: 1 });
      return res.json();
    },
    onSuccess: (_body, blueprintId) => {
      setHarvestPhaseById((prev) => ({ ...prev, [blueprintId]: "running" }));
      toast({
        title: "Harvest started",
        description: "Running in background — this page updates every 15s until assets are ready.",
      });
      void refetch();
    },
    onError: (e: Error) => toast({ title: "Harvest failed", description: e.message, variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: async (blueprintId: number) => {
      const res = await apiRequest("DELETE", `/api/platform/canonical/${blueprintId}`);
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Removed from platform catalog",
        description: "Merchants can no longer import this product. Harvested Supabase files are kept.",
      });
      setRemoveTarget(null);
      queryClient.invalidateQueries({ queryKey: ["/api/platform/canonical/products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/platform/operator-catalog/tags"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/catalog/allowed-blueprints"] });
    },
    onError: (e: Error) => toast({ title: "Remove failed", description: e.message, variant: "destructive" }),
  });

  const products = data?.products ?? [];

  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const p of products) {
      if (p.category) cats.add(p.category);
    }
    return Array.from(cats).sort();
  }, [products]);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (kindFilter !== "all" && p.kind !== kindFilter) return false;
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false;
      if (statusFilter === "live" && !p.publish.published) return false;
      if (statusFilter === "draft" && p.publish.published) return false;
      if (!q) return true;
      return (
        p.label.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        String(p.blueprintId).includes(q)
      );
    });
  }, [products, search, categoryFilter, kindFilter, statusFilter]);

  if (platformLoading) {
    return (
      <AdminLayout>
        <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking access…
        </div>
      </AdminLayout>
    );
  }

  if (!platformStatus?.isPlatformAdmin) {
    return <Redirect to="/admin" />;
  }

  return (
    <AdminLayout>
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-semibold">Platform Product Catalog</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Curated Printify products with shared calibration assets. Merchants only see allowlisted
            blueprints at import. Harvest once here, publish, then every merchant gets instant setup.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Search name or blueprint id…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
          />
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {cat}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as typeof kindFilter)}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Kind" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All kinds</SelectItem>
              <SelectItem value="flat">Flat</SelectItem>
              <SelectItem value="aop">AOP</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All status</SelectItem>
              <SelectItem value="live">Live</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading catalog…
          </div>
        ) : (
          <ul className="space-y-4">
            {filteredProducts.map((p) => {
              const harvestPhase =
                harvestPhaseById[p.blueprintId] ??
                (p.harvestComplete
                  ? "complete"
                  : p.harvestOutcome === "failed" || p.harvestOutcome === "unsupported"
                    ? "failed"
                    : "idle");
              const isHarvesting = harvestPhase === "running";
              const isHarvested = harvestPhase === "complete" || !!p.harvestComplete;
              const harvestFailed = harvestPhase === "failed";

              return (
              <li key={p.blueprintId} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-medium">{p.label}</h2>
                      <Badge variant="outline">{p.category}</Badge>
                      <Badge variant="secondary">{p.kind === "aop" ? "AOP panel map" : "Flat / mesh"}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Printify blueprint {p.blueprintId}
                      {p.brand ? ` · ${p.brand}` : ""}
                      {" · "}
                      <PrintifyCatalogLink
                        blueprintId={p.blueprintId}
                        title={p.label}
                        providerTitle={p.brand}
                      />
                    </p>
                    {p.kind === "aop" && p.panelMappingTemplate && (
                      <p className="mt-1 text-xs">Template: {p.panelMappingTemplate}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {p.publish.published ? (
                      <Badge className="self-center">Live for merchants</Badge>
                    ) : (
                      <Badge variant="destructive" className="self-center">Not published</Badge>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {p.kind === "flat" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className={isHarvested && !isHarvesting ? "border-green-600 text-green-700" : undefined}
                        disabled={isHarvesting}
                        onClick={() => harvestMutation.mutate(p.blueprintId)}
                      >
                        {isHarvesting ? (
                          <>
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            Harvesting…
                          </>
                        ) : isHarvested ? (
                          <>
                            <Check className="mr-1 h-3 w-3" />
                            Harvested
                          </>
                        ) : harvestFailed ? (
                          <>
                            <RefreshCw className="mr-1 h-3 w-3" />
                            Retry harvest
                          </>
                        ) : (
                          <>
                            <RefreshCw className="mr-1 h-3 w-3" />
                            Harvest to library
                          </>
                        )}
                      </Button>
                      <Link href={`/admin/platform/flat-calibrator/${p.blueprintId}`}>
                        <Button size="sm" variant="outline">
                          <Crosshair className="mr-1 h-3 w-3" />
                          Flat calibrator
                        </Button>
                      </Link>
                      {p.harvestComplete && (
                        <Button
                          size="sm"
                          disabled={publishMutation.isPending}
                          onClick={() => publishMutation.mutate(p.blueprintId)}
                        >
                          <Upload className="mr-1 h-3 w-3" />
                          Publish for merchants
                        </Button>
                      )}
                      {harvestFailed && p.harvestError && (
                        <p className="w-full text-xs text-destructive">{p.harvestError}</p>
                      )}
                    </>
                  )}
                  {p.kind === "aop" && (
                    <p className="text-xs text-muted-foreground self-center">
                      AOP uses Hoodie Template Mapper + publish script. Already live when template is on Supabase.
                    </p>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={removeMutation.isPending}
                    onClick={() => setRemoveTarget(p)}
                  >
                    <Trash2 className="mr-1 h-3 w-3" />
                    Remove from catalog
                  </Button>
                </div>
              </li>
              );
            })}
          </ul>
        )}

        {!isLoading && filteredProducts.length === 0 && (
          <p className="text-sm text-muted-foreground">No products match your filters.</p>
        )}

        <AlertDialog open={!!removeTarget} onOpenChange={(open) => !open && setRemoveTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove from platform catalog?</AlertDialogTitle>
              <AlertDialogDescription>
                <strong>{removeTarget?.label}</strong> (blueprint {removeTarget?.blueprintId}) will be removed from
                the platform catalog and merchant import allowlist. Merchants who already imported it keep their
                product; harvested calibration files on Supabase are not deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={removeMutation.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={removeMutation.isPending}
                onClick={(e) => {
                  e.preventDefault();
                  if (removeTarget) removeMutation.mutate(removeTarget.blueprintId);
                }}
              >
                {removeMutation.isPending ? "Removing…" : "Remove"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </AdminLayout>
  );
}
