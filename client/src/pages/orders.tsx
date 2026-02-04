import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, Package, ShoppingCart } from "lucide-react";
import { CreditDisplay } from "@/components/credit-display";
import type { Order, Customer } from "@shared/schema";

export default function OrdersPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  const { data: orders, isLoading: ordersLoading } = useQuery<Order[]>({
    queryKey: ["/api/orders"],
    enabled: isAuthenticated,
  });

  const { data: customer, isLoading: customerLoading } = useQuery<Customer>({
    queryKey: ["/api/customer"],
    enabled: isAuthenticated,
  });

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Skeleton className="h-32 w-32 rounded-full" />
      </div>
    );
  }

  if (!isAuthenticated) {
    window.location.href = "/";
    return null;
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge variant="secondary">Pending</Badge>;
      case "processing":
        return <Badge variant="outline">Processing</Badge>;
      case "shipped":
        return <Badge>Shipped</Badge>;
      case "delivered":
        return <Badge variant="default">Delivered</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const formatPrice = (cents: number) => {
    return `$${(cents / 100).toFixed(2)}`;
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 bg-background z-50">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link href="/">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <h1 className="text-lg font-semibold">My Orders</h1>
          </div>
          <CreditDisplay customer={customer} isLoading={customerLoading} />
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        {ordersLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-32 rounded-lg" />
            ))}
          </div>
        ) : orders && orders.length > 0 ? (
          <div className="space-y-4">
            {orders.map((order) => (
              <Card key={order.id} data-testid={`card-order-${order.id}`}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <CardTitle className="text-base">
                      Order #{order.id}
                    </CardTitle>
                    {getStatusBadge(order.status)}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-2 text-sm">
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Size</span>
                      <span>{order.size}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Frame</span>
                      <span className="capitalize">{order.frameColor}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Quantity</span>
                      <span>{order.quantity}</span>
                    </div>
                    <div className="border-t pt-2 mt-2">
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">Product</span>
                        <span>{formatPrice(order.priceInCents)}</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">Shipping</span>
                        <span>{formatPrice(order.shippingInCents)}</span>
                      </div>
                      {order.creditRefundInCents > 0 && (
                        <div className="flex justify-between gap-4 text-green-600 dark:text-green-400">
                          <span>Credit Refund</span>
                          <span>-{formatPrice(order.creditRefundInCents)}</span>
                        </div>
                      )}
                      <div className="flex justify-between gap-4 font-medium mt-1">
                        <span>Total</span>
                        <span>
                          {formatPrice(order.priceInCents + order.shippingInCents - order.creditRefundInCents)}
                        </span>
                      </div>
                    </div>
                  </div>
                  {order.printifyOrderId && (
                    <p className="text-xs text-muted-foreground mt-3">
                      Printify Order: {order.printifyOrderId}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="text-center py-16">
            <Package className="h-16 w-16 mx-auto text-muted-foreground opacity-50 mb-4" />
            <h2 className="text-xl font-semibold mb-2">No orders yet</h2>
            <p className="text-muted-foreground mb-6">
              Create a design and order your first print
            </p>
            <Link href="/design">
              <Button data-testid="button-create-design">
                <ShoppingCart className="h-4 w-4 mr-2" />
                Start Creating
              </Button>
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
