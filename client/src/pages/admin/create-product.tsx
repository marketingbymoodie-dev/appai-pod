import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FlaskConical, Loader2, Package, Save } from "lucide-react";
import AdminLayout from "@/components/admin-layout";
import EmbedDesign, { type TesterDesignStatus } from "@/pages/embed-design";
import { dedupeProductTypesForPicker } from "@shared/productTypePicker";
import type { ProductType } from "@shared/schema";

interface DesignStudioIdentity {
  shop: string;
  customerId: string;
  savedCount: number;
  savedLimit: number;
  canSaveDesigns?: boolean;
}

/** How long the Send button will wait for an in-flight print-panel upload before ordering anyway. */
const PANEL_SAVE_WAIT_MS = 90_000;

export default function AdminCreateProduct() {
  const { toast } = useToast();
  const searchParams = new URLSearchParams(window.location.search);
  const initialProductTypeId = searchParams.get("productTypeId");

  const [selectedProductTypeId, setSelectedProductTypeId] = useState<number | null>(
    initialProductTypeId ? parseInt(initialProductTypeId) : null
  );

  // Live status of the design on screen, reported by the embedded customizer:
  // which generation job it is + whether its AOP print panels are still uploading.
  // Ref (not state) — updates arrive mid-edit and shouldn't rerender the page.
  const testerStatusRef = useRef<TesterDesignStatus>({ jobId: null, aopPanels: "none" });
  const saveDesignRef = useRef<(() => Promise<void>) | null>(null);
  const [testerHasDesign, setTesterHasDesign] = useState(false);
  const [testerPanelStatus, setTesterPanelStatus] = useState<TesterDesignStatus["aopPanels"]>("none");
  const handleTesterDesignStatus = useCallback((status: TesterDesignStatus) => {
    testerStatusRef.current = status;
    setTesterHasDesign(!!status.jobId);
    setTesterPanelStatus(status.aopPanels);
  }, []);

  const {
    data: productTypesRaw,
    isLoading: productTypesLoading,
    isError: productTypesError,
    error: productTypesErrorObj,
    refetch: refetchProductTypes,
  } = useQuery<ProductType[]>({
    queryKey: ["/api/admin/product-types"],
  });
  const productTypes = useMemo(
    () =>
      dedupeProductTypesForPicker(
        Array.isArray(productTypesRaw) ? productTypesRaw : [],
      ),
    [productTypesRaw],
  );

  const { data: studioIdentity } = useQuery<DesignStudioIdentity>({
    queryKey: ["/api/appai/design-studio/identity"],
  });
  const { data: planData } = useQuery<{
    planName: string | null;
    planStatus: string | null;
    isActive: boolean;
  }>({
    queryKey: ["/api/appai/plan"],
  });

  const canSaveDesigns =
    studioIdentity?.canSaveDesigns === true ||
    (!!planData?.isActive &&
      !!planData.planName &&
      ["starter", "dabbler", "pro", "pro_plus"].includes(planData.planName));

  // Send a DRAFT test order to Printify — targets the design currently on screen
  // (falls back to the latest saved design when nothing was generated this session).
  // Waits for an in-flight print-panel upload so the order matches what's on screen.
  // Never sent to production, never charges.
  const testOrderMutation = useMutation({
    mutationFn: async (id: number) => {
      const waitStart = Date.now();
      while (
        testerStatusRef.current.aopPanels === "saving" &&
        Date.now() - waitStart < PANEL_SAVE_WAIT_MS
      ) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (testerStatusRef.current.aopPanels === "saving") {
        throw new Error(
          "Design is still saving — wait a moment, then send the test order again.",
        );
      }
      // AOP panels and flat Apply both report aopPanels saved/error. Do not send
      // a test order until the on-screen design has been persisted.
      if (testerStatusRef.current.aopPanels === "error") {
        throw new Error(
          "Last design save failed — adjust placement once more, wait for Design saved, then try again.",
        );
      }
      if (testerStatusRef.current.aopPanels !== "saved") {
        throw new Error(
          "Apply your design first and wait for Design saved, then send the test order.",
        );
      }
      const jobId = testerStatusRef.current.jobId;
      const response = await apiRequest(
        "POST",
        `/api/admin/product-types/${id}/test-printify-order`,
        jobId ? { designId: jobId } : undefined,
      );
      return response.json();
    },
    onSuccess: (data) => {
      const url = data?.printifyOrderUrl as string | undefined;
      toast({
        title: "Draft test order created in Printify",
        description: data?.printifyOrderId
          ? `Order ${data.printifyOrderId} (DRAFT — not sent to production). Open it in Printify to verify the print file. Delete it there once you're done if automatic fulfillment is enabled on your Printify account.`
          : "Draft order created. Open Printify to verify the print file.",
        action: url ? (
          <a href={url} target="_blank" rel="noopener noreferrer" className="underline text-xs">
            Open
          </a>
        ) : undefined,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Test order failed", description: error.message, variant: "destructive" });
    },
  });

  const saveDesignMutation = useMutation({
    mutationFn: async () => {
      const waitStart = Date.now();
      while (
        testerStatusRef.current.aopPanels === "saving" &&
        Date.now() - waitStart < PANEL_SAVE_WAIT_MS
      ) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!saveDesignRef.current) {
        throw new Error("Customizer not ready — wait for it to load.");
      }
      await saveDesignRef.current();
    },
    onSuccess: () => {
      toast({
        title: "Design saved",
        description: "Saved to My Designs. You can list it as a product or reopen it from there.",
        action: (
          <a href="/my-designs" className="underline text-xs">
            Open My Designs
          </a>
        ),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/storefront/customizer/my-designs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/appai/design-studio/identity"] });
    },
    onError: (error: Error) => {
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-create-product-title">Art Generator Tester</h1>
            <p className="text-muted-foreground max-w-2xl">
              Test each Customizer page with an artwork generation
              {canSaveDesigns ? ", save designs to My Designs," : ""} then send a test order to Printify to check
              the output matches your mockup here. Important! Delete your test orders in your Printify admin
              immediately if you have automatic fulfilment already enabled there.
            </p>
          </div>
          {selectedProductTypeId && (
            <div className="flex flex-wrap items-center gap-2">
              {canSaveDesigns ? (
                <Button
                  variant="outline"
                  onClick={() => saveDesignMutation.mutate()}
                  disabled={!testerHasDesign || saveDesignMutation.isPending || testOrderMutation.isPending}
                  data-testid="button-save-design"
                >
                  {saveDesignMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  {saveDesignMutation.isPending ? "Saving…" : "Save to My Designs"}
                </Button>
              ) : null}
              {!canSaveDesigns && studioIdentity ? (
                <p className="text-xs text-muted-foreground w-full sm:w-auto">
                  Saving to My Designs requires{" "}
                  <a href="/admin/plan" className="underline">
                    Starter or above
                  </a>
                  .
                </p>
              ) : null}
              <Button
                onClick={() => testOrderMutation.mutate(selectedProductTypeId)}
                disabled={
                  testOrderMutation.isPending || testerPanelStatus === "saving"
                }
                data-testid="button-send-test-order"
              >
                {testOrderMutation.isPending || testerPanelStatus === "saving" ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <FlaskConical className="h-4 w-4 mr-2" />
                )}
                {testOrderMutation.isPending
                  ? "Sending Test Order…"
                  : testerPanelStatus === "saving"
                    ? "Design saving…"
                    : "Send a Test Order to Printify"}
              </Button>
              {testerPanelStatus === "saving" && (
                <p className="text-xs text-muted-foreground w-full" data-testid="text-design-saving">
                  Saving design for Printify…
                </p>
              )}
              {testerPanelStatus === "saved" && testerHasDesign && (
                <p className="text-xs text-muted-foreground w-full" data-testid="text-design-saved">
                  Design saved — ready for test order.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Product Type selector — the "tester" input that chooses which product's customizer to render */}
        <div className="max-w-md space-y-2">
          <Label>Product Type</Label>
          {productTypesLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : productTypesError ? (
            <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-sm text-destructive">
                Couldn’t load product types
                {productTypesErrorObj instanceof Error && productTypesErrorObj.message
                  ? `: ${productTypesErrorObj.message}`
                  : "."}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => refetchProductTypes()}
                data-testid="button-retry-product-types"
              >
                Retry
              </Button>
            </div>
          ) : productTypes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active product types found. Import or activate products under Products first.
            </p>
          ) : (
            <Select
              value={selectedProductTypeId != null ? String(selectedProductTypeId) : undefined}
              onValueChange={(v) => {
                // Switching products remounts the customizer — the previous design's
                // job id no longer describes what's on screen.
                testerStatusRef.current = { jobId: null, aopPanels: "none" };
                setTesterHasDesign(false);
                setSelectedProductTypeId(parseInt(v));
              }}
            >
              <SelectTrigger data-testid="select-product-type">
                <SelectValue placeholder="Select a product type" />
              </SelectTrigger>
              <SelectContent>
                {productTypes.map((pt) => (
                  <SelectItem key={pt.id} value={pt.id.toString()}>
                    {pt.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <p className="text-xs text-muted-foreground">
            This renders the exact same designer your customers use — it always stays in sync with the live customizer.
          </p>
        </div>

        {/* Live customizer — the IDENTICAL storefront design studio, rendered IN-PROCESS via the
            admin-tester runtime mode. In-process (not an iframe) so it isn't blocked by the app's
            frame-ancestors CSP and so it reuses the App Bridge session token for /api/generate. */}
        {selectedProductTypeId ? (
          <Card className="overflow-hidden">
            <CardContent className="p-0">
              <EmbedDesign
                key={selectedProductTypeId}
                embeddedContext={{
                  mode: "admin-tester",
                  productTypeId: selectedProductTypeId,
                  onTesterDesignStatus: handleTesterDesignStatus,
                  saveDesignRef,
                }}
              />
            </CardContent>
          </Card>
        ) : (
          <div className="aspect-[16/9] max-h-[480px] bg-muted rounded-lg flex items-center justify-center">
            <div className="text-center text-muted-foreground">
              <Package className="h-12 w-12 mx-auto mb-2" />
              <p className="text-sm">Select a product type to load its customizer</p>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
