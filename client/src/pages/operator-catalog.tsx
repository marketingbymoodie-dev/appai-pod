import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Redirect } from "wouter";
import AdminLayout from "@/components/admin-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Loader2 } from "lucide-react";
import PrintifyCatalogLink from "@/components/catalog/PrintifyCatalogLink";
import ShippingLocationBadges from "@/components/catalog/ShippingLocationBadges";
import {
  usePrintifyCatalogFilters,
  type PrintifyBlueprintListItem,
} from "@/hooks/usePrintifyCatalogFilters";
import {
  PLATFORM_CATALOG_CATEGORIES,
  platformCatalogCategoryLabel,
} from "@shared/platformCatalogCategories";
import { PRINTIFY_SHIPPING_REGIONS } from "@shared/printifyShippingRegions";

type CatalogTag = {
  printifyBlueprintId: number;
  label: string;
  brand: string | null;
  kind: "flat" | "aop" | "printify" | "blocked";
  status: "draft" | "published";
  category: string | null;
};

const KIND_LABELS: Record<CatalogTag["kind"], string> = {
  flat: "Flat",
  aop: "AOP",
  printify: "API",
  blocked: "Block",
};

function kindBadgeVariant(kind: CatalogTag["kind"]) {
  if (kind === "printify") return "default" as const;
  if (kind === "flat") return "secondary" as const;
  if (kind === "aop") return "outline" as const;
  return "destructive" as const;
}

export default function OperatorCatalogPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [tagCategory, setTagCategory] = useState<string>("other");
  const [tagStatusFilter, setTagStatusFilter] = useState<"all" | "tagged" | "untagged" | "blocked">("all");
  const [categoryFilter, setCategoryFilter] = useState("all");

  const { data: platformStatus, isLoading: platformLoading } = useQuery<{ isPlatformAdmin: boolean }>({
    queryKey: ["/api/platform/admin/status"],
  });

  const { data: tagsData } = useQuery<{ tags: CatalogTag[] }>({
    queryKey: ["/api/platform/operator-catalog/tags"],
    enabled: !!platformStatus?.isPlatformAdmin,
  });

  const tagById = useMemo(() => {
    const m = new Map<number, CatalogTag>();
    for (const t of tagsData?.tags ?? []) m.set(t.printifyBlueprintId, t);
    return m;
  }, [tagsData?.tags]);

  const extraFilter = useMemo(() => {
    return (bp: PrintifyBlueprintListItem) => {
      const tag = tagById.get(bp.id);
      if (tagStatusFilter === "tagged" && !tag) return false;
      if (tagStatusFilter === "untagged" && tag) return false;
      if (tagStatusFilter === "blocked" && tag?.kind !== "blocked") return false;
      if (categoryFilter !== "all" && tag?.category !== categoryFilter) return false;
      return true;
    };
  }, [tagById, tagStatusFilter, categoryFilter]);

  const {
    search,
    setSearch,
    locationFilter,
    setLocationFilter,
    shippingMetaLoading,
    getShippingMeta,
    visible,
    totalMatching,
    isLoading: blueprintsLoading,
    isFetching,
    refetch,
    error: blueprintsError,
  } = usePrintifyCatalogFilters({
    enabled: !!platformStatus?.isPlatformAdmin,
    requireSearch: false,
    maxResults: 150,
    extraFilter,
  });

  const tagMutation = useMutation({
    mutationFn: async (args: { blueprintId: number; kind: CatalogTag["kind"]; bp: PrintifyBlueprintListItem }) => {
      const res = await apiRequest("PUT", `/api/platform/operator-catalog/${args.blueprintId}/tag`, {
        kind: args.kind,
        label: args.bp.title,
        brand: args.bp.brand,
        category: tagCategory,
      });
      return res.json();
    },
    onSuccess: (_data, vars) => {
      const catLabel = platformCatalogCategoryLabel(tagCategory);
      toast({
        title: `Tagged: ${KIND_LABELS[vars.kind]} · ${catLabel}`,
        description:
          vars.kind === "printify"
            ? "Published for merchant import (Printify mockups)."
            : vars.kind === "flat" || vars.kind === "aop"
              ? "Added to Platform Catalog — harvest/map, then Publish."
              : "Blocked from merchant import.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/platform/operator-catalog/tags"] });
      queryClient.invalidateQueries({ queryKey: ["/api/platform/canonical/products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/catalog/allowed-blueprints"] });
    },
    onError: (e: Error) => toast({ title: "Tag failed", description: e.message, variant: "destructive" }),
  });

  const clearMutation = useMutation({
    mutationFn: async (blueprintId: number) => {
      const res = await apiRequest("DELETE", `/api/platform/operator-catalog/${blueprintId}/tag`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/platform/operator-catalog/tags"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/catalog/allowed-blueprints"] });
    },
  });

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

  const regionLabel =
    PRINTIFY_SHIPPING_REGIONS.find((r) => r.id === locationFilter)?.label ?? locationFilter;

  return (
    <AdminLayout>
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <div>
          <h1 className="text-2xl font-semibold">Operator Printify Catalog</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Browse and tag products for your merchants. Set a <strong>category</strong>, then click{" "}
            <strong>API</strong> / <strong>Flat</strong> / <strong>AOP</strong> / <strong>Block</strong> on
            each row. Open Printify for full supplier specs.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Search title, brand, or blueprint id…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-w-[200px] flex-1 max-w-md"
          />
          <Select
            value={locationFilter}
            onValueChange={(v) => setLocationFilter(v as typeof locationFilter)}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Ships from" />
            </SelectTrigger>
            <SelectContent>
              {PRINTIFY_SHIPPING_REGIONS.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={tagStatusFilter} onValueChange={(v) => setTagStatusFilter(v as typeof tagStatusFilter)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Tag status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All products</SelectItem>
              <SelectItem value="tagged">Tagged only</SelectItem>
              <SelectItem value="untagged">Untagged only</SelectItem>
              <SelectItem value="blocked">Blocked only</SelectItem>
            </SelectContent>
          </Select>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Tagged category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tagged categories</SelectItem>
              {PLATFORM_CATALOG_CATEGORIES.map((cat) => (
                <SelectItem key={cat.value} value={cat.value}>
                  {cat.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={tagCategory} onValueChange={setTagCategory}>
            <SelectTrigger className="w-[200px]" title="Saved when you click API / Flat / AOP / Block">
              <SelectValue placeholder="Category when tagging" />
            </SelectTrigger>
            <SelectContent>
              {PLATFORM_CATALOG_CATEGORIES.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reload"}
          </Button>
        </div>

        {blueprintsError && (
          <p className="text-sm text-destructive">{(blueprintsError as Error).message}</p>
        )}

        {shippingMetaLoading && locationFilter !== "all" && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading shipping regions for filter…
          </p>
        )}

        {blueprintsLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading Printify blueprints…
          </div>
        ) : (
          <>
            {totalMatching > 0 && (
              <p className="text-xs text-muted-foreground">
                Showing {visible.length} of {totalMatching} matching
                {locationFilter !== "all" ? ` (ships from ${regionLabel})` : ""}
              </p>
            )}
            <ul className="divide-y rounded-lg border">
              {visible.map((bp) => {
                const tag = tagById.get(bp.id);
                const shipping = getShippingMeta(bp.id);
                return (
                  <li key={bp.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      {bp.images?.[0] ? (
                        <img
                          src={bp.images[0]}
                          alt=""
                          className="h-12 w-12 shrink-0 rounded object-contain"
                        />
                      ) : (
                        <div className="h-12 w-12 shrink-0 rounded bg-muted" />
                      )}
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium truncate">{bp.title}</span>
                          <span className="text-xs text-muted-foreground">{bp.brand}</span>
                          <span className="text-xs text-muted-foreground">#{bp.id}</span>
                          <PrintifyCatalogLink
                            blueprintId={bp.id}
                            title={bp.title}
                            providerTitle={shipping?.primaryProviderTitle}
                          />
                          {tag && (
                            <>
                              <Badge variant={kindBadgeVariant(tag.kind)}>{KIND_LABELS[tag.kind]}</Badge>
                              {tag.category && (
                                <Badge variant="outline">{platformCatalogCategoryLabel(tag.category)}</Badge>
                              )}
                              {tag.kind !== "printify" && tag.kind !== "blocked" && (
                                <Badge variant={tag.status === "published" ? "default" : "destructive"}>
                                  {tag.status === "published" ? "Live" : "Draft"}
                                </Badge>
                              )}
                            </>
                          )}
                        </div>
                        <ShippingLocationBadges meta={shipping} />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {(["printify", "flat", "aop", "blocked"] as const).map((kind) => (
                        <Button
                          key={kind}
                          size="sm"
                          variant={tag?.kind === kind ? "default" : "outline"}
                          disabled={tagMutation.isPending}
                          onClick={() => tagMutation.mutate({ blueprintId: bp.id, kind, bp })}
                          title={
                            kind === "printify"
                              ? "Instant merchant import (Printify mockups)"
                              : kind === "flat"
                                ? "Platform flat calibrator queue"
                                : kind === "aop"
                                  ? "AOP panel map queue"
                                  : "Block merchant import"
                          }
                        >
                          {KIND_LABELS[kind]}
                        </Button>
                      ))}
                      {tag && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={clearMutation.isPending}
                          onClick={() => clearMutation.mutate(bp.id)}
                        >
                          Clear
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {!blueprintsLoading && visible.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {locationFilter !== "all" && shippingMetaLoading
              ? "Loading shipping data…"
              : "No blueprints match your filters."}
          </p>
        )}
      </div>
    </AdminLayout>
  );
}
