/**
 * DEV-ONLY: Storefront Preview Launcher
 *
 * This page is only accessible in development (import.meta.env.DEV).
 * It lists all product types from the database and provides direct links
 * to the storefront designer so you can preview the customer-facing UI
 * without needing a live Shopify store session.
 *
 * Access at: /dev/storefront
 */

import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Palette, ShoppingBag } from "lucide-react";

const DEV_SHOP = "appai-2.myshopify.com";

interface ProductType {
  id: number;
  name: string;
  designerType?: string;
}

const designerTypeLabel: Record<string, string> = {
  "framed-print": "Framed Print",
  "pillow": "Pillow",
  "mug": "Mug / Tumbler",
  "apparel": "Apparel",
  "generic": "Generic",
};

const designerTypeColor: Record<string, string> = {
  "framed-print": "bg-blue-100 text-blue-800",
  "pillow": "bg-purple-100 text-purple-800",
  "mug": "bg-amber-100 text-amber-800",
  "apparel": "bg-green-100 text-green-800",
  "generic": "bg-gray-100 text-gray-800",
};

export default function DevStorefrontPreview() {
  // Only render in dev mode
  if (!import.meta.env.DEV) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Not available in production.</p>
      </div>
    );
  }

  const { data: productTypes, isLoading, error } = useQuery<ProductType[]>({
    queryKey: ["/api/dev/product-types"],
    queryFn: async () => {
      const res = await fetch("/api/dev/product-types");
      if (!res.ok) throw new Error("Failed to load product types");
      return res.json();
    },
  });

  const getDesignerUrl = (pt: ProductType) => {
    const params = new URLSearchParams({
      shop: DEV_SHOP,
      productTypeId: String(pt.id),
      storefront: "true",
    });
    return `/s/designer?${params.toString()}`;
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Dev banner */}
      <div className="bg-yellow-400 text-yellow-900 text-xs font-mono px-4 py-2 text-center font-semibold">
        DEV MODE — Storefront Preview Launcher — changes here are never pushed to production
      </div>

      <div className="container mx-auto px-4 py-10 max-w-3xl">
        <div className="flex items-center gap-3 mb-2">
          <ShoppingBag className="h-7 w-7 text-primary" />
          <h1 className="text-2xl font-bold">Customer Storefront Preview</h1>
        </div>
        <p className="text-muted-foreground mb-8">
          Click any product below to open the customer-facing designer exactly as your end users would see it.
          Using shop: <code className="bg-gray-100 px-1 rounded text-xs">{DEV_SHOP}</code>
        </p>

        {isLoading && (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
            Failed to load product types. Make sure the dev server is running.
          </div>
        )}

        {productTypes && (
          <div className="space-y-3">
            {productTypes.map((pt) => {
              const colorClass = designerTypeColor[pt.designerType ?? ""] ?? designerTypeColor["generic"];
              const label = designerTypeLabel[pt.designerType ?? ""] ?? pt.designerType ?? "Unknown";
              return (
                <a
                  key={pt.id}
                  href={getDesignerUrl(pt)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between bg-white border rounded-lg px-5 py-4 hover:shadow-md hover:border-primary transition-all group"
                >
                  <div className="flex items-center gap-3">
                    <Palette className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                    <div>
                      <div className="font-medium text-sm">{pt.name}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">ID: {pt.id}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${colorClass}`}>
                      {label}
                    </span>
                    <ExternalLink className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                  </div>
                </a>
              );
            })}
          </div>
        )}

        <div className="mt-10 border-t pt-6 text-xs text-muted-foreground space-y-1">
          <p>The designer opens in a new tab using the storefront API (same as the live store).</p>
          <p>AI image generation requires the shop to be verified — use the live store for full generation testing.</p>
          <p>All other UI elements (layout, mockups, selectors, styles) render fully from real database data.</p>
        </div>
      </div>
    </div>
  );
}
