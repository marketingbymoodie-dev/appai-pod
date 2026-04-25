import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ShopifyProvider } from "./lib/shopify";
import { ROUTER_BASE } from "./lib/urlBase";

import Home from "@/pages/home";
import DesignPage from "@/pages/design";
import DesignsPage from "@/pages/designs";
import OrdersPage from "@/pages/orders";
import EmbedDesign from "@/pages/embed-design";
import TestSizeChart from "@/pages/test-size-chart";
import NotFound from "@/pages/not-found";

import AdminDashboard from "@/pages/admin/dashboard";
import AdminSettings from "@/pages/admin/settings";
import AdminProducts from "@/pages/admin/products";
import AdminStyles from "@/pages/admin/styles";
import AdminCoupons from "@/pages/admin/coupons";
import AdminCredits from "@/pages/admin/credits";
import AdminCreateProduct from "@/pages/admin/create-product";
import AdminCustomizerPages from "@/pages/admin/customizer-pages";
import AdminPlanPicker from "@/pages/admin/plan-picker-page";

// DEV-ONLY: Storefront preview launcher — tree-shaken out of production builds
import DevStorefrontPreview from "@/pages/dev-storefront-preview";

function AppRouter() {
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
      <Route path="/test-size-chart" component={TestSizeChart} />

      {/* Storefront designer — dedicated path, never initializes App Bridge */}
      <Route path="/s/designer" component={EmbedDesign} />

      {/* Admin */}
      <Route path="/admin/settings" component={AdminSettings} />
      <Route path="/admin/products" component={AdminProducts} />
      <Route path="/admin/styles" component={AdminStyles} />
      <Route path="/admin/coupons" component={AdminCoupons} />
      <Route path="/admin/credits" component={AdminCredits} />
      <Route path="/admin/create-product" component={AdminCreateProduct} />
      <Route path="/admin/customizer-pages" component={AdminCustomizerPages} />
      <Route path="/admin/plan" component={AdminPlanPicker} />
      <Route path="/admin" component={AdminDashboard} />

      {/* DEV-ONLY: Storefront preview launcher */}
      {import.meta.env.DEV && (
        <Route path="/dev/storefront" component={DevStorefrontPreview} />
      )}

      {/* Fallback */}
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return (
    <WouterRouter base={ROUTER_BASE}>
      <ShopifyProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AppRouter />
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      </ShopifyProvider>
    </WouterRouter>
  );
}
// trigger build Wed Mar 25 03:23:03 EDT 2026
// rebuild 1774423579
