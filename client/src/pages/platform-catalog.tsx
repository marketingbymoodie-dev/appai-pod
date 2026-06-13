import { useMemo, useState } from "react";
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
import { Loader2, Crosshair, Upload, RefreshCw } from "lucide-react";
import PrintifyCatalogLink from "@/components/catalog/PrintifyCatalogLink";

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
  publish: PublishState;
};

export default function PlatformCatalogPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState<"all" | "flat" | "aop">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "live" | "draft">("all");

  const { data: platformStatus, isLoading: platformLoading } = useQuery<{ isPlatformAdmin: boolean }>({
    queryKey: ["/api/platform/admin/status"],
  });

  const { data, isLoading } = useQuery<{ products: CatalogProduct[] }>({
    queryKey: ["/api/platform/canonical/products"],
    enabled: !!platformStatus?.isPlatformAdmin,
  });

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
    onSuccess: () => {
      toast({
        title: "Harvest started",
        description: "Runs in background. Open calibrator after ~15–30 min to review, then Publish.",
      });
    },
    onError: (e: Error) => toast({ title: "Harvest failed", description: e.message, variant: "destructive" }),
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
            {filteredProducts.map((p) => (
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
                        disabled={harvestMutation.isPending}
                        onClick={() => harvestMutation.mutate(p.blueprintId)}
                      >
                        <RefreshCw className="mr-1 h-3 w-3" />
                        Harvest to library
                      </Button>
                      <Link href={`/admin/platform/flat-calibrator/${p.blueprintId}`}>
                        <Button size="sm" variant="outline">
                          <Crosshair className="mr-1 h-3 w-3" />
                          Flat calibrator
                        </Button>
                      </Link>
                      <Button
                        size="sm"
                        disabled={publishMutation.isPending}
                        onClick={() => publishMutation.mutate(p.blueprintId)}
                      >
                        <Upload className="mr-1 h-3 w-3" />
                        Publish for merchants
                      </Button>
                    </>
                  )}
                  {p.kind === "aop" && (
                    <p className="text-xs text-muted-foreground self-center">
                      AOP uses Hoodie Template Mapper + publish script. Already live when template is on Supabase.
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {!isLoading && filteredProducts.length === 0 && (
          <p className="text-sm text-muted-foreground">No products match your filters.</p>
        )}
      </div>
    </AdminLayout>
  );
}
