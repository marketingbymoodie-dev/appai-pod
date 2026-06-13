import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Redirect } from "wouter";
import AdminLayout from "@/components/admin-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, Crosshair, Upload, RefreshCw } from "lucide-react";

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
  category: string;
  kind: "flat" | "aop";
  panelMappingTemplate?: string;
  publish: PublishState;
};

export default function PlatformCatalogPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

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

  const products = data?.products ?? [];

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

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading catalog…
          </div>
        ) : (
          <ul className="space-y-4">
            {products.map((p) => (
              <li key={p.blueprintId} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-medium">{p.label}</h2>
                      <Badge variant="outline">{p.category}</Badge>
                      <Badge variant="secondary">{p.kind === "aop" ? "AOP panel map" : "Flat / mesh"}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">Printify blueprint {p.blueprintId}</p>
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
      </div>
    </AdminLayout>
  );
}
