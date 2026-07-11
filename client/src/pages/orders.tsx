import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import AdminLayout from "@/components/admin-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarChart3, Image, ShoppingCart, TrendingUp, ExternalLink } from "lucide-react";

interface StatsBucket {
  unitsSold: number;
  revenueCents: number;
  atc: number;
  conversion: number | null;
}

interface DesignProductStats {
  id: string;
  title: string;
  status: "active" | "inactive";
  shopifyProductId: string | null;
  handle: string | null;
  mockupUrl: string | null;
  allTime: StatsBucket;
  last30d: StatsBucket;
}

interface StatsResponse {
  products: DesignProductStats[];
  totals: { allTime: StatsBucket; last30d: StatsBucket };
}

interface DesignStudioIdentity {
  shop: string;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatConversion(rate: number | null): string {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(0)}%`;
}

export default function OrdersPage() {
  const [range, setRange] = useState<"30d" | "all">("30d");

  const { data, isLoading } = useQuery<StatsResponse>({
    queryKey: ["/api/appai/design-products/stats"],
  });

  const { data: identity } = useQuery<DesignStudioIdentity>({
    queryKey: ["/api/appai/design-studio/identity"],
  });

  const products = data?.products ?? [];
  const totals = range === "30d" ? data?.totals.last30d : data?.totals.allTime;

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold">My Orders</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Sales performance for your permanent product designs.
            </p>
          </div>
          <Tabs value={range} onValueChange={(v) => setRange(v as "30d" | "all")}>
            <TabsList>
              <TabsTrigger value="30d" data-testid="tab-range-30d">Last 30 days</TabsTrigger>
              <TabsTrigger value="all" data-testid="tab-range-all">All time</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="p-2 rounded-md bg-primary/10">
                  <ShoppingCart className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-semibold" data-testid="text-total-units">{totals?.unitsSold ?? 0}</p>
                  <p className="text-xs text-muted-foreground">Units sold</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="p-2 rounded-md bg-primary/10">
                  <TrendingUp className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-semibold" data-testid="text-total-revenue">{formatCents(totals?.revenueCents ?? 0)}</p>
                  <p className="text-xs text-muted-foreground">Revenue</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="p-2 rounded-md bg-primary/10">
                  <BarChart3 className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-semibold" data-testid="text-total-atc">{totals?.atc ?? 0}</p>
                  <p className="text-xs text-muted-foreground">Add to carts</p>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
          </div>
        ) : products.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center">
              <Image className="h-12 w-12 mx-auto text-muted-foreground opacity-50 mb-3" />
              <h2 className="text-lg font-medium mb-1">No product designs yet</h2>
              <p className="text-sm text-muted-foreground mb-4">
                List a saved design as a permanent product from My Designs to start tracking sales here.
              </p>
              <Link href="/designs">
                <Button size="sm">Go to My Designs</Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Per-product performance</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {products.map((p) => {
                  const bucket = range === "30d" ? p.last30d : p.allTime;
                  return (
                    <div
                      key={p.id}
                      className="flex items-center gap-4 p-4 flex-wrap"
                      data-testid={`row-design-product-${p.id}`}
                    >
                      <div className="h-12 w-12 rounded-md bg-muted overflow-hidden flex-shrink-0">
                        {p.mockupUrl ? (
                          <img src={p.mockupUrl} alt={p.title} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Image className="h-5 w-5 text-muted-foreground opacity-50" />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium truncate">{p.title}</p>
                          <Badge variant={p.status === "active" ? "default" : "secondary"} className="text-[10px]">
                            {p.status === "active" ? "Live" : "Draft"}
                          </Badge>
                        </div>
                        {p.shopifyProductId && identity?.shop && (
                          <a
                            href={`https://${identity.shop}/admin/products/${p.shopifyProductId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground"
                          >
                            <ExternalLink className="h-3 w-3" /> View in Shopify admin
                          </a>
                        )}
                      </div>
                      <div className="grid grid-cols-4 gap-6 text-sm text-right">
                        <div>
                          <p className="font-medium">{bucket.unitsSold}</p>
                          <p className="text-[11px] text-muted-foreground">Sold</p>
                        </div>
                        <div>
                          <p className="font-medium">{formatCents(bucket.revenueCents)}</p>
                          <p className="text-[11px] text-muted-foreground">Revenue</p>
                        </div>
                        <div>
                          <p className="font-medium">{bucket.atc}</p>
                          <p className="text-[11px] text-muted-foreground">ATC</p>
                        </div>
                        <div>
                          <p className="font-medium">{formatConversion(bucket.conversion)}</p>
                          <p className="text-[11px] text-muted-foreground">Conv.</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
