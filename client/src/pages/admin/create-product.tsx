import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FlaskConical, Package } from "lucide-react";
import AdminLayout from "@/components/admin-layout";
import EmbedDesign from "@/pages/embed-design";
import type { ProductType } from "@shared/schema";

export default function AdminCreateProduct() {
  const { toast } = useToast();
  const searchParams = new URLSearchParams(window.location.search);
  const initialProductTypeId = searchParams.get("productTypeId");

  const [selectedProductTypeId, setSelectedProductTypeId] = useState<number | null>(
    initialProductTypeId ? parseInt(initialProductTypeId) : null
  );

  const { data: productTypes, isLoading: productTypesLoading } = useQuery<ProductType[]>({
    queryKey: ["/api/product-types"],
  });

  // Send a DRAFT test order to Printify — bakes/collects the print file for the
  // latest design on this product type so you can verify, in Printify, that it
  // matches the mockup shown here. Never sent to production, never charges.
  const testOrderMutation = useMutation({
    mutationFn: async (id: number) => {
      const response = await apiRequest("POST", `/api/admin/product-types/${id}/test-printify-order`);
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

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-create-product-title">Art Generator Tester</h1>
            <p className="text-muted-foreground max-w-2xl">
              Test each Customizer page with an artwork generation and then send a test order to Printify to check
              the output matches your mockup here. Important! Delete your test orders in your Printify admin
              immediately if you have automatic fulfilment already enabled there.
            </p>
          </div>
          {selectedProductTypeId && (
            <div className="flex items-center gap-2">
              <Button
                onClick={() => testOrderMutation.mutate(selectedProductTypeId)}
                disabled={testOrderMutation.isPending}
                data-testid="button-send-test-order"
              >
                <FlaskConical className={`h-4 w-4 mr-2 ${testOrderMutation.isPending ? "animate-pulse" : ""}`} />
                Send a Test Order to Printify
              </Button>
            </div>
          )}
        </div>

        {/* Product Type selector — the "tester" input that chooses which product's customizer to render */}
        <div className="max-w-md space-y-2">
          <Label>Product Type</Label>
          {productTypesLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Select
              value={selectedProductTypeId?.toString() || ""}
              onValueChange={(v) => setSelectedProductTypeId(parseInt(v))}
            >
              <SelectTrigger data-testid="select-product-type">
                <SelectValue placeholder="Select a product type" />
              </SelectTrigger>
              <SelectContent>
                {productTypes?.map((pt) => (
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
                embeddedContext={{ mode: "admin-tester", productTypeId: selectedProductTypeId }}
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
