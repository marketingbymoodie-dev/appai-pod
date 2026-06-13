import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Redirect } from "wouter";
import AdminLayout from "@/components/admin-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Loader2 } from "lucide-react";

type PrintifyBlueprint = {
  id: number;
  title: string;
  brand: string;
  model?: string;
};

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
  const [search, setSearch] = useState("");

  const { data: platformStatus, isLoading: platformLoading } = useQuery<{ isPlatformAdmin: boolean }>({
    queryKey: ["/api/platform/admin/status"],
  });

  const { data: tagsData } = useQuery<{ tags: CatalogTag[] }>({
    queryKey: ["/api/platform/operator-catalog/tags"],
    enabled: !!platformStatus?.isPlatformAdmin,
  });

  const { data: blueprints, isLoading: blueprintsLoading, refetch } = useQuery<PrintifyBlueprint[]>({
    queryKey: ["/api/admin/printify/blueprints"],
    queryFn: async () => {
      const res = await fetch("/api/admin/printify/blueprints", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load Printify catalog");
      return res.json();
    },
    enabled: !!platformStatus?.isPlatformAdmin,
  });

  const tagById = useMemo(() => {
    const m = new Map<number, CatalogTag>();
    for (const t of tagsData?.tags ?? []) m.set(t.printifyBlueprintId, t);
    return m;
  }, [tagsData?.tags]);

  const filtered = useMemo(() => {
    if (!blueprints) return [];
    const q = search.trim().toLowerCase();
    if (!q) return blueprints.slice(0, 200);
    return blueprints
      .filter(
        (bp) =>
          bp.title.toLowerCase().includes(q) ||
          bp.brand.toLowerCase().includes(q) ||
          String(bp.id).includes(q),
      )
      .slice(0, 200);
  }, [blueprints, search]);

  const tagMutation = useMutation({
    mutationFn: async (args: { blueprintId: number; kind: CatalogTag["kind"]; bp: PrintifyBlueprint }) => {
      const res = await apiRequest("PUT", `/api/platform/operator-catalog/${args.blueprintId}/tag`, {
        kind: args.kind,
        label: args.bp.title,
        brand: args.bp.brand,
      });
      return res.json();
    },
    onSuccess: (_data, vars) => {
      toast({
        title: `Tagged as ${KIND_LABELS[vars.kind]}`,
        description:
          vars.kind === "printify"
            ? "Merchants can import this product immediately."
            : vars.kind === "flat" || vars.kind === "aop"
              ? "Added to Platform Catalog queue — harvest or map, then publish."
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

  return (
    <AdminLayout>
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <div>
          <h1 className="text-2xl font-semibold">Operator Printify Catalog</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Tag products as you review the Printify catalog. <strong>API</strong> = instant merchant
            import (Printify mockups). <strong>Flat</strong> / <strong>AOP</strong> = your Platform
            Catalog queue. No deploy needed when tagging.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Search title, brand, or blueprint id…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-md"
          />
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={blueprintsLoading}>
            {blueprintsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reload catalog"}
          </Button>
        </div>

        {blueprintsLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading Printify blueprints…
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {filtered.map((bp) => {
              const tag = tagById.get(bp.id);
              return (
                <li key={bp.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium truncate">{bp.title}</span>
                      <span className="text-xs text-muted-foreground">{bp.brand}</span>
                      <span className="text-xs text-muted-foreground">#{bp.id}</span>
                      {tag && (
                        <>
                          <Badge variant={kindBadgeVariant(tag.kind)}>{KIND_LABELS[tag.kind]}</Badge>
                          {tag.kind !== "printify" && tag.kind !== "blocked" && (
                            <Badge variant={tag.status === "published" ? "default" : "destructive"}>
                              {tag.status === "published" ? "Live" : "Draft"}
                            </Badge>
                          )}
                        </>
                      )}
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
        )}

        {!blueprintsLoading && filtered.length === 0 && (
          <p className="text-sm text-muted-foreground">No blueprints match your search.</p>
        )}
      </div>
    </AdminLayout>
  );
}
