import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, Loader2 } from "lucide-react";
import AdminLayout from "@/components/admin-layout";
import { Button } from "@/components/ui/button";
import EmbedDesign from "@/pages/embed-design";

interface DesignStudioIdentity {
  shop: string;
  customerId: string;
  savedCount: number;
  savedLimit: number;
}

/**
 * Merchant "My Designs" studio host. Renders the IDENTICAL storefront customizer
 * in-process (embeddedContext.mode = 'merchant-studio') so output and save behaviour
 * match real customers exactly — see the RuntimeMode doc in embed-design.tsx.
 */
export default function AdminDesignStudio() {
  const searchParams = new URLSearchParams(window.location.search);
  const productTypeId = searchParams.get("productTypeId") || "";

  const { data: identity, isLoading, error } = useQuery<DesignStudioIdentity>({
    queryKey: ["/api/appai/design-studio/identity"],
  });

  const embeddedContext = useMemo(() => {
    if (!identity?.shop || !productTypeId) return undefined;
    return {
      mode: "merchant-studio" as const,
      productTypeId,
      shop: identity.shop,
    };
  }, [identity?.shop, productTypeId]);

  return (
    <AdminLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Link href="/designs">
            <Button variant="ghost" size="icon" data-testid="button-back-to-designs">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-semibold">Design Studio</h1>
            {identity ? (
              <p className="text-xs text-muted-foreground">
                {identity.savedCount} / {identity.savedLimit} saved designs
              </p>
            ) : null}
          </div>
        </div>

        {!productTypeId ? (
          <p className="text-sm text-destructive">Missing product — open the studio from My Designs.</p>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-24 text-muted-foreground">
            <Loader2 className="h-5 w-5 mr-2 animate-spin" />
            Loading studio…
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">Failed to load your studio identity. Please refresh and try again.</p>
        ) : embeddedContext ? (
          <div className="rounded-lg border overflow-hidden bg-background">
            <EmbedDesign key={productTypeId} embeddedContext={embeddedContext} />
          </div>
        ) : null}
      </div>
    </AdminLayout>
  );
}
