import { useCallback } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@tanstack/react-query";
import { isShopifyEmbedded } from "@/lib/shopify";
import { getShopifyParams } from "@/lib/shopify-bridge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { 
  Settings, 
  Package, 
  Ticket, 
  Palette, 
  BarChart3, 
  CreditCard, 
  Plus, 
  LogOut,
  Store,
  Image,
  ShoppingCart,
  LayoutTemplate,
  TrendingUp,
} from "lucide-react";
import type { Merchant } from "@shared/schema";

interface AdminLayoutProps {
  children: React.ReactNode;
}

const menuItems = [
  { title: "Dashboard", url: "/admin", icon: BarChart3 },
  { title: "Customizer Pages", url: "/admin/customizer-pages", icon: LayoutTemplate },
  { title: "Plan & Billing", url: "/admin/plan", icon: TrendingUp },
  { title: "Products", url: "/admin/products", icon: Package },
  { title: "Create Product", url: "/admin/create-product", icon: Plus },
  { title: "Styles", url: "/admin/styles", icon: Palette },
  { title: "Coupons", url: "/admin/coupons", icon: Ticket },
  { title: "Credits", url: "/admin/credits", icon: CreditCard },
  { title: "Settings", url: "/admin/settings", icon: Settings },
];

const customerLinks = [
  { title: "My Designs", url: "/designs", icon: Image },
  { title: "My Orders", url: "/orders", icon: ShoppingCart },
];

export default function AdminLayout({ children }: AdminLayoutProps) {
  const { isAuthenticated, isLoading: authLoading, user, logout } = useAuth();
  const [location] = useLocation();
  const embedded = isShopifyEmbedded();

  // In embedded Shopify Admin the Shopify JWT is the auth — enable regardless of app-level auth
  const { data: merchant, isLoading: merchantLoading } = useQuery<Merchant>({
    queryKey: ["/api/merchant"],
    enabled: isAuthenticated || embedded,
  });

  // Show skeleton while auth or (in embedded mode) merchant data is loading
  if (authLoading || (embedded && merchantLoading)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Skeleton className="h-32 w-32 rounded-full" />
      </div>
    );
  }

  // Non-embedded: redirect to landing if not logged in via app auth
  if (!isAuthenticated && !embedded) {
    window.location.href = "/";
    return null;
  }

  // Call App Bridge navigate to keep the Shopify Admin URL bar in sync with wouter
  const handleNavClick = (path: string) => {
    const shopify = (window as any).shopify;
    if (shopify?.navigate) shopify.navigate(path);
  };

  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <Sidebar>
          <SidebarHeader className="border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Store className="h-5 w-5 text-primary" />
              <span className="font-semibold text-sm">AI Art Studio</span>
            </div>
            <span className="text-xs text-muted-foreground mt-1">
              Merchant Portal
            </span>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Menu</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {menuItems.map((item) => {
                    const isActive = location === item.url || 
                      (item.url !== "/admin" && location.startsWith(item.url));
                    return (
                      <SidebarMenuItem key={item.title}>
                        <SidebarMenuButton asChild data-active={isActive}>
                          <Link href={item.url} onClick={() => handleNavClick(item.url)}>
                            <item.icon className="h-4 w-4" />
                            <span>{item.title}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>Customer Pages</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {customerLinks.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton asChild>
                        <Link href={item.url}>
                          <item.icon className="h-4 w-4" />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter className="border-t p-4">
            <div className="flex flex-col gap-2">
              <div className="text-sm text-muted-foreground">
                {user?.firstName || user?.email}
              </div>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => logout()}
                className="justify-start"
                data-testid="button-logout"
              >
                <LogOut className="h-4 w-4 mr-2" />
                Logout
              </Button>
            </div>
          </SidebarFooter>
        </Sidebar>
        <div className="flex flex-col flex-1 overflow-hidden">
          <header className="flex items-center gap-4 border-b px-4 py-3 bg-background">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
            <div className="flex-1" />
            {merchant?.storeName && (
              <span className="text-sm text-muted-foreground">
                {merchant.storeName}
              </span>
            )}
          </header>
          <main className="flex-1 overflow-auto p-6">
            {children}
          </main>
        </div>
      </div>

      {/* Dev-only debug banner — remove or disable in production */}
      {import.meta.env.DEV && (
        <div
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            background: "#fef08a",
            color: "#713f12",
            fontSize: "11px",
            padding: "3px 8px",
            fontFamily: "monospace",
            zIndex: 9999,
            borderTop: "1px solid #ca8a04",
          }}
        >
          {(() => { const p = getShopifyParams(); return `[AppAI Debug] embedded=${String(embedded)} | shop=${p.shop ?? "—"} | host=${p.host ? "present" : "—"} | path=${location}`; })()}
        </div>
      )}
    </SidebarProvider>
  );
}
