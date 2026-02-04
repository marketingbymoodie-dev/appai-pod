import { Switch, Route } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ShopifyProvider } from "./lib/shopify";

import Home from "@/pages/home";
import DesignPage from "@/pages/design";
import DesignsPage from "@/pages/designs";
import OrdersPage from "@/pages/orders";
import EmbedDesign from "@/pages/embed-design";
import NotFound from "@/pages/not-found";

import AdminDashboard from "@/pages/admin/dashboard";
import AdminSettings from "@/pages/admin/settings";
import AdminProducts from "@/pages/admin/products";
import AdminStyles from "@/pages/admin/styles";
import AdminCoupons from "@/pages/admin/coupons";
import AdminCredits from "@/pages/admin/credits";
import AdminCreateProduct from "@/pages/admin/create-product";

function Router() {
  return (
    <Switch>
      {/* Home */}
      <Route path="/" component={Home} />

      {/* Main app */}
      <Route path="/design" component={DesignPage} />
      <Route path="/designs" component={DesignsPage} />
      <Route path="/my-designs" component={DesignsPage} />
      <Route path="/orders" component={OrdersPage} />
      <Route path="/embed/design" component={EmbedDesign} />

      {/* Admin */}
      <Route path="/admin/settings" component={AdminSettings} />
      <Route path="/admin/products" component={AdminProducts} />
      <Route path="/admin/styles" component={AdminStyles} />
      <Route path="/admin/coupons" component={AdminCoupons} />
      <Route path="/admin/credits" component={AdminCredits} />
      <Route path="/admin/create-product" component={AdminCreateProduct} />
      <Route path="/admin" component={AdminDashboard} />

      {/* Fallback */}
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return (
    <ShopifyProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Router />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ShopifyProvider>
  );
}
