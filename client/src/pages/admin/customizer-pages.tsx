import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
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
  ToggleLeft, ToggleRight, AlertTriangle, Wand2,
} from "lucide-react";
import AdminLayout from "@/components/admin-layout";
import type { Merchant } from "@shared/schema";

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
}

interface BlankVariant {
  id: string;
  title: string;
  price: string;
  sku?: string;
}

interface Blank {
  productTypeId: number;
  productId: string;
  title: string;
  imageUrl: string | null;
  variants: BlankVariant[];
}

function slugify(str: string): string {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export default function AdminCustomizerPages() {
  const { toast } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CustomizerPage | null>(null);

  // Form state
  const [formTitle, setFormTitle] = useState("");
  const [formHandle, setFormHandle] = useState("");
  const [formVariantId, setFormVariantId] = useState("");
  const [handleTouched, setHandleTouched] = useState(false);

  const { data: merchant } = useQuery<Merchant>({ queryKey: ["/api/merchant"] });

  const { data: pagesData, isLoading: pagesLoading } = useQuery<PagesResponse>({
    queryKey: ["/api/appai/customizer-pages"],
    enabled: !!merchant,
  });

  const { data: blanksData, isLoading: blanksLoading } = useQuery<{ blanks: Blank[] }>({
    queryKey: ["/api/appai/blanks"],
    enabled: createOpen,
  });

  // Derive shop domain from existing installation data in pages response
  const shopDomain = pagesData?.pages?.[0]?.shop ?? "";

  const createMutation = useMutation({
    mutationFn: async (body: {
      title: string; handle: string; baseVariantId: string; shopDomain?: string;
    }) => {
      const res = await apiRequest("POST", "/api/appai/customizer-pages", body);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/appai/customizer-pages"] });
      setCreateOpen(false);
      resetForm();
      toast({
        title: "Customizer page created",
        description: `Visit /pages/${data.page?.handle} on your storefront to test it.`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string; shopDomain?: string }) => {
      const res = await apiRequest("PATCH", `/api/appai/customizer-pages/${id}`, {
        status,
        shopDomain,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/appai/customizer-pages"] });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/appai/customizer-pages/${id}?shopDomain=${encodeURIComponent(shopDomain)}`, undefined);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/appai/customizer-pages"] });
      setDeleteTarget(null);
      toast({ title: "Page deleted" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function resetForm() {
    setFormTitle("");
    setFormHandle("");
    setFormVariantId("");
    setHandleTouched(false);
  }

  function handleTitleChange(val: string) {
    setFormTitle(val);
    if (!handleTouched) setFormHandle(slugify(val));
  }

  function handleSubmitCreate() {
    if (!formTitle.trim() || !formHandle.trim() || !formVariantId) return;
    createMutation.mutate({
      title: formTitle,
      handle: formHandle,
      baseVariantId: formVariantId,
      shopDomain,
    });
  }

  const pages = pagesData?.pages ?? [];
  const limit = pagesData?.limit ?? 0;
  const count = pagesData?.count ?? 0;
  const planTier = pagesData?.planTier ?? "free";
  const atLimit = count >= limit;

  // All variants flat list for picker
  const allVariants: Array<{ variantId: string; label: string; blank: Blank }> = (
    blanksData?.blanks ?? []
  ).flatMap((b) =>
    (b.variants ?? []).map((v) => ({
      variantId: v.id,
      label: `${b.title} — ${v.title} ($${v.price})`,
      blank: b,
    }))
  );

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
              The AppAI embed mounts the customizer automatically — no theme blocks needed.
            </p>
          </div>

          <Dialog
            open={createOpen}
            onOpenChange={(v) => {
              setCreateOpen(v);
              if (!v) resetForm();
            }}
          >
            <DialogTrigger asChild>
              <Button disabled={atLimit && planTier !== "studio"}>
                <Plus className="h-4 w-4 mr-2" />
                Create Page
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Create Customizer Page</DialogTitle>
              </DialogHeader>

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
                  <Label>Base Product / Variant</Label>
                  {blanksLoading ? (
                    <Skeleton className="h-10 w-full mt-1" />
                  ) : allVariants.length === 0 ? (
                    <p className="text-sm text-destructive mt-1">
                      No blank products found. Add products tagged{" "}
                      <code className="bg-muted px-1 rounded">appai-blank</code> in Shopify.
                    </p>
                  ) : (
                    <Select value={formVariantId} onValueChange={setFormVariantId}>
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select a product variant…" />
                      </SelectTrigger>
                      <SelectContent>
                        {allVariants.map((v) => (
                          <SelectItem key={v.variantId} value={v.variantId}>
                            {v.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                <Button
                  className="w-full"
                  onClick={handleSubmitCreate}
                  disabled={
                    !formTitle.trim() ||
                    !formHandle.trim() ||
                    !formVariantId ||
                    createMutation.isPending
                  }
                >
                  {createMutation.isPending ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating…</>
                  ) : (
                    <><Wand2 className="h-4 w-4 mr-2" /> Create Page</>
                  )}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Plan usage bar */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">
                Plan: <Badge variant="secondary" className="ml-1 capitalize">{planTier}</Badge>
              </span>
              <span className="text-sm text-muted-foreground">
                {count} / {limit} page{limit !== 1 ? "s" : ""} used
              </span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all"
                style={{ width: limit > 0 ? `${Math.min((count / limit) * 100, 100)}%` : "0%" }}
              />
            </div>
            {atLimit && limit > 0 && (
              <p className="text-xs text-amber-600 mt-2 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                Plan limit reached. Upgrade to create more pages.
              </p>
            )}
            {limit === 0 && (
              <p className="text-xs text-muted-foreground mt-2">
                Your free plan does not include customizer pages. Upgrade to get started.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Pages list */}
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
              {limit > 0 ? (
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create first page
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">Upgrade your plan to unlock customizer pages.</p>
              )}
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
                          Product: {page.baseProductTitle}
                          {page.baseVariantTitle && ` — ${page.baseVariantTitle}`}
                          {page.baseProductPrice && ` · $${parseFloat(page.baseProductPrice).toFixed(2)}`}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      {/* Storefront link */}
                      <Button variant="ghost" size="icon" asChild title="Open storefront page">
                        <a
                          href={`https://${page.shop}/pages/${page.handle}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </Button>

                      {/* Toggle status */}
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={toggleMutation.isPending}
                        title={page.status === "active" ? "Disable page" : "Enable page"}
                        onClick={() =>
                          toggleMutation.mutate({
                            id: page.id,
                            status: page.status === "active" ? "disabled" : "active",
                            shopDomain,
                          })
                        }
                      >
                        {page.status === "active" ? (
                          <ToggleRight className="h-4 w-4 text-primary" />
                        ) : (
                          <ToggleLeft className="h-4 w-4 text-muted-foreground" />
                        )}
                      </Button>

                      {/* Delete */}
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

        {/* Setup guide */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Setup Guide</CardTitle>
            <CardDescription>One-time configuration steps</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">1</span>
              <div>
                <p className="font-medium">Enable the AppAI App Embed</p>
                <p className="text-muted-foreground">Online Store → Themes → Customize → App Embeds → Enable <em>AI Art Studio Embed</em>. This is a one-time step.</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">2</span>
              <div>
                <p className="font-medium">Create a customizer page above</p>
                <p className="text-muted-foreground">Click <em>Create Page</em>, pick a title, URL handle, and which product variant customers will customize.</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">3</span>
              <div>
                <p className="font-medium">Visit the storefront page</p>
                <p className="text-muted-foreground">The AppAI embed auto-mounts the customizer on <code className="bg-muted px-1 rounded">/pages/your-handle</code> — no theme block or App URL setting needed.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Confirm delete dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete customizer page?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete <strong>{deleteTarget?.title}</strong> (/pages/{deleteTarget?.handle})
              from both AppAI and your Shopify store. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
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
