import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, Link } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import AdminLayout from "@/components/admin-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Image, Loader2, Trash2, Wand2, Pencil, Sparkles, LayoutTemplate, Tag,
  ExternalLink, Camera, Power, PowerOff, X,
} from "lucide-react";

interface CustomizerPageSummary {
  id: string;
  title: string;
  status: "active" | "disabled";
  productTypeId: number | null;
  baseProductTitle: string | null;
}

interface DesignStudioIdentity {
  shop: string;
  customerId: string;
  savedCount: number;
  savedLimit: number;
  canSaveDesigns?: boolean;
}

interface SavedMerchantDesign {
  id: string;
  artworkUrl: string | null;
  mockupUrls: string[];
  prompt: string | null;
  size: string | null;
  frameColor: string | null;
  productTypeId: string | null;
  baseTitle: string | null;
  pageHandle: string | null;
  createdAt: string;
}

interface DesignProduct {
  id: string;
  jobId: string;
  shopifyProductId: string | null;
  handle: string | null;
  title: string;
  status: "active" | "inactive";
  mockupUrls: string[] | null;
}

export default function DesignsPage() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busyProductId, setBusyProductId] = useState<string | null>(null);

  const { data: pagesData, isLoading: pagesLoading } = useQuery<{ pages: CustomizerPageSummary[] }>({
    queryKey: ["/api/appai/customizer-pages"],
  });
  const activePages = (pagesData?.pages ?? []).filter((p) => p.status === "active" && p.productTypeId != null);

  const { data: identity, isLoading: identityLoading } = useQuery<DesignStudioIdentity>({
    queryKey: ["/api/appai/design-studio/identity"],
  });

  const { data: designsData, isLoading: designsLoading } = useQuery<{ designs: SavedMerchantDesign[] }>({
    queryKey: ["/api/storefront/customizer/my-designs", identity?.shop, identity?.customerId],
    queryFn: async () => {
      const res = await fetch(`/api/storefront/customizer/my-designs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ shop: identity!.shop, customerId: identity!.customerId }),
      });
      if (!res.ok) throw new Error("Failed to load saved designs");
      return res.json();
    },
    enabled: !!identity?.shop && !!identity?.customerId,
  });
  const designs = designsData?.designs ?? [];

  const { data: productsData, isLoading: productsLoading } = useQuery<{
    designProducts: DesignProduct[];
    activeCount: number;
    limit: number;
  }>({
    queryKey: ["/api/appai/design-products"],
  });
  const productByJobId = new Map((productsData?.designProducts ?? []).map((dp) => [dp.jobId, dp]));

  const deleteMutation = useMutation({
    mutationFn: async (jobId: string) => {
      if (!identity?.shop) throw new Error("Missing shop");
      setDeletingId(jobId);
      const params = new URLSearchParams({ shop: identity.shop, customerId: identity.customerId });
      const res = await fetch(`/api/storefront/customizer/my-designs/${jobId}?${params.toString()}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete design");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/storefront/customizer/my-designs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/appai/design-studio/identity"] });
      toast({ title: "Design deleted" });
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
    onSettled: () => setDeletingId(null),
  });

  const publishMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const res = await fetch(`/api/appai/design-products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ jobId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to list design as a product");
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: "Created as a draft — review it in Shopify",
        description: [
          data?.printifyWarning ? `Printify: ${data.printifyWarning}` : null,
          "Check the title, description, and images, then activate it here when you're ready to sell it.",
        ].filter(Boolean).join(" "),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/appai/design-products"] });
    },
    onError: (err: any) => toast({ title: "Couldn't list design", description: err.message, variant: "destructive" }),
  });

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: "active" | "inactive" }) => {
      setBusyProductId(id);
      const res = await fetch(`/api/appai/design-products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to update product");
      return data;
    },
    onSuccess: (_data, vars) => {
      toast({ title: vars.status === "active" ? "Product activated" : "Product deactivated" });
      queryClient.invalidateQueries({ queryKey: ["/api/appai/design-products"] });
    },
    onError: (err: any) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
    onSettled: () => setBusyProductId(null),
  });

  const unpublishMutation = useMutation({
    mutationFn: async (id: string) => {
      setBusyProductId(id);
      const res = await fetch(`/api/appai/design-products/${id}`, { method: "DELETE", credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to unpublish product");
      return data;
    },
    onSuccess: () => {
      toast({ title: "Product unpublished" });
      queryClient.invalidateQueries({ queryKey: ["/api/appai/design-products"] });
    },
    onError: (err: any) => toast({ title: "Unpublish failed", description: err.message, variant: "destructive" }),
    onSettled: () => setBusyProductId(null),
  });

  const printifyMockupsMutation = useMutation({
    mutationFn: async (id: string) => {
      setBusyProductId(id);
      const res = await fetch(`/api/appai/design-products/${id}/printify-mockups`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to add Printify mockups");
      return data;
    },
    onSuccess: (data) => {
      toast({ title: `Added ${data?.addedCount ?? 0} Printify mockup image(s)` });
      queryClient.invalidateQueries({ queryKey: ["/api/appai/design-products"] });
    },
    onError: (err: any) => toast({ title: "Couldn't add Printify mockups", description: err.message, variant: "destructive" }),
    onSettled: () => setBusyProductId(null),
  });

  const openStudio = (productTypeId: number) => {
    navigate(`/admin/design-studio?productTypeId=${productTypeId}`);
  };

  return (
    <AdminLayout>
      <div className="space-y-10">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold">My Designs</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Create designs with your live customizer pages, then list your favorites as standalone products on your store.
            </p>
          </div>
          {productsData && (
            <Badge variant="outline" className="text-xs" data-testid="text-active-product-count">
              {productsData.activeCount} / {productsData.limit} active product design{productsData.limit === 1 ? "" : "s"}
            </Badge>
          )}
        </div>

        <section className="space-y-3">
          <h2 className="text-lg font-medium flex items-center gap-2">
            <Wand2 className="h-4 w-4" /> Start a new design
          </h2>
          {pagesLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
            </div>
          ) : activePages.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-center">
                <LayoutTemplate className="h-10 w-10 mx-auto text-muted-foreground opacity-50 mb-3" />
                <p className="text-sm text-muted-foreground mb-4">
                  You need an active customizer page before you can design here. Create one from Products Import.
                </p>
                <Link href="/admin/customizer-pages">
                  <Button variant="outline" size="sm">Go to Customizer Pages</Button>
                </Link>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {activePages.map((page) => (
                <Card key={page.id} data-testid={`card-studio-launcher-${page.id}`}>
                  <CardContent className="p-4 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{page.title}</p>
                      {page.baseProductTitle && (
                        <p className="text-xs text-muted-foreground truncate">{page.baseProductTitle}</p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      onClick={() => openStudio(page.productTypeId!)}
                      data-testid={`button-open-studio-${page.id}`}
                    >
                      <Sparkles className="h-4 w-4 mr-1" />
                      Open studio
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium flex items-center gap-2">
              <Image className="h-4 w-4" /> Saved designs
            </h2>
            {identity && (
              <span className="text-xs text-muted-foreground" data-testid="text-saved-count">
                {identity.savedCount} / {identity.savedLimit} saved
              </span>
            )}
          </div>

          {identityLoading || designsLoading || productsLoading ? (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="aspect-[3/4] rounded-lg" />)}
            </div>
          ) : designs.length === 0 ? (
            <Card>
              <CardContent className="p-10 text-center">
                <Image className="h-12 w-12 mx-auto text-muted-foreground opacity-50 mb-3" />
                <p className="text-sm text-muted-foreground">
                  No saved designs yet. Open a studio above and generate your first artwork.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {designs.map((design) => {
                const product = productByJobId.get(design.id);
                const isBusy = busyProductId === product?.id;
                return (
                  <Card key={design.id} className="overflow-hidden" data-testid={`card-saved-design-${design.id}`}>
                    <div className="aspect-[3/4] bg-muted relative overflow-hidden">
                      {design.mockupUrls?.[0] || design.artworkUrl ? (
                        <img
                          src={design.mockupUrls?.[0] || design.artworkUrl || ""}
                          alt={design.prompt || "Saved design"}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Image className="h-10 w-10 text-muted-foreground opacity-50" />
                        </div>
                      )}
                      {product && (
                        <Badge
                          className="absolute top-2 right-2 capitalize"
                          variant={product.status === "active" ? "default" : "secondary"}
                          data-testid={`badge-product-status-${design.id}`}
                        >
                          {product.status === "active" ? "Live product" : "Draft product"}
                        </Badge>
                      )}
                    </div>
                    <CardContent className="p-3 space-y-2">
                      <p className="text-sm font-medium line-clamp-1">
                        {design.baseTitle || "Custom design"}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {design.size && <Badge variant="secondary">{design.size}</Badge>}
                        {design.frameColor && <Badge variant="outline" className="capitalize">{design.frameColor}</Badge>}
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          disabled={!design.productTypeId}
                          onClick={() => navigate(`/admin/design-studio?productTypeId=${design.productTypeId}&loadDesignId=${design.id}`)}
                          data-testid={`button-continue-editing-${design.id}`}
                        >
                          <Pencil className="h-3.5 w-3.5 mr-1" />
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => deleteMutation.mutate(design.id)}
                          disabled={deletingId === design.id}
                          data-testid={`button-delete-design-${design.id}`}
                        >
                          {deletingId === design.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4 text-destructive" />
                          )}
                        </Button>
                      </div>

                      {!product ? (
                        <Button
                          size="sm"
                          className="w-full"
                          onClick={() => publishMutation.mutate(design.id)}
                          disabled={publishMutation.isPending}
                          data-testid={`button-list-as-product-${design.id}`}
                        >
                          {publishMutation.isPending ? (
                            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                          ) : (
                            <Tag className="h-3.5 w-3.5 mr-1" />
                          )}
                          List as product
                        </Button>
                      ) : (
                        <div className="space-y-1.5 pt-1 border-t">
                          <div className="flex gap-2">
                            {product.shopifyProductId && (
                              <a
                                href={`https://${identity?.shop}/admin/products/${product.shopifyProductId}`}
                                target="_blank"
                                rel="noreferrer"
                                className="flex-1"
                              >
                                <Button variant="outline" size="sm" className="w-full" data-testid={`button-view-shopify-${design.id}`}>
                                  <ExternalLink className="h-3.5 w-3.5 mr-1" />
                                  View
                                </Button>
                              </a>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              className="flex-1"
                              disabled={isBusy}
                              onClick={() => statusMutation.mutate({ id: product.id, status: product.status === "active" ? "inactive" : "active" })}
                              data-testid={`button-toggle-status-${design.id}`}
                            >
                              {isBusy && statusMutation.isPending ? (
                                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                              ) : product.status === "active" ? (
                                <PowerOff className="h-3.5 w-3.5 mr-1" />
                              ) : (
                                <Power className="h-3.5 w-3.5 mr-1" />
                              )}
                              {product.status === "active" ? "Deactivate" : "Activate"}
                            </Button>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="flex-1"
                              disabled={isBusy}
                              onClick={() => printifyMockupsMutation.mutate(product.id)}
                              data-testid={`button-add-printify-mockups-${design.id}`}
                            >
                              {isBusy && printifyMockupsMutation.isPending ? (
                                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                              ) : (
                                <Camera className="h-3.5 w-3.5 mr-1" />
                              )}
                              Add Printify mockups
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={isBusy}
                              onClick={() => unpublishMutation.mutate(product.id)}
                              title="Unpublish"
                              data-testid={`button-unpublish-${design.id}`}
                            >
                              {isBusy && unpublishMutation.isPending ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <X className="h-4 w-4 text-destructive" />
                              )}
                            </Button>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </AdminLayout>
  );
}
