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
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Globe, LayoutTemplate, Loader2, Plus, ExternalLink, Trash2,
  ToggleLeft, ToggleRight, AlertTriangle, Wand2, Save, ArrowUpRight, TrendingUp,
} from "lucide-react";
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
  productId: string;
  title: string;
  imageUrl: string | null;
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
  const [formVariantId, setFormVariantId] = useState("");
  const [handleTouched, setHandleTouched] = useState(false);

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
    mutationFn: async (body: { title: string; handle: string; baseVariantId: string }) => {
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
      const res = await apiRequest("DELETE", `/api/appai/customizer-pages/${id}`, undefined);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/appai/customizer-pages"] });
      setDeleteTarget(null);
      toast({ title: "Page deleted" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
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
    createMutation.mutate({ title: formTitle, handle: formHandle, baseVariantId: formVariantId });
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

  // All variants flat list for picker
  const allVariants: Array<{ variantId: string; label: string }> = (blanksData?.blanks ?? []).flatMap(
    (b) =>
      (b.variants ?? []).map((v) => ({
        variantId: v.id,
        label: `${b.title} — ${v.title} ($${v.price})`,
      }))
  );

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
                    <Label>Product &amp; Default Variant</Label>
                    {blanksLoading ? (
                      <Skeleton className="h-10 w-full mt-1" />
                    ) : (blanksData?.blanks ?? []).length === 0 ? (
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
                          {(blanksData?.blanks ?? []).map((blank) => (
                            <SelectGroup key={blank.productId}>
                              <SelectLabel>{blank.title}</SelectLabel>
                              {(blank.variants ?? []).map((v) => (
                                <SelectItem key={v.id} value={v.id}>
                                  {v.title} (${v.price})
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      All variants will be available to customers. This sets the default.
                    </p>
                  </div>
                  <Button
                    className="w-full"
                    onClick={handleSubmitCreate}
                    disabled={!formTitle.trim() || !formHandle.trim() || !formVariantId || createMutation.isPending}
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

            {/* ── SETUP GUIDE ── */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Setup Guide</CardTitle>
                <CardDescription>One-time configuration steps</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {[
                  {
                    n: 1,
                    title: "Enable the AppAI App Embed",
                    body: "Online Store → Themes → Customize → App Embeds → Enable AI Art Studio Embed. One-time step.",
                  },
                  {
                    n: 2,
                    title: "Create a customizer page above",
                    body: "Click Create Page, pick a title, URL handle, and which product variant customers will customize.",
                  },
                  {
                    n: 3,
                    title: "Visit the storefront page",
                    body: "The AppAI embed auto-mounts the customizer on /pages/your-handle.",
                  },
                ].map(({ n, title, body }) => (
                  <div key={n} className="flex items-start gap-3">
                    <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                      {n}
                    </span>
                    <div>
                      <p className="font-medium">{title}</p>
                      <p className="text-muted-foreground">{body}</p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

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
