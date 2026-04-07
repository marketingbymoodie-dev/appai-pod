import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Save, CheckCircle, AlertCircle, Loader2, Store, RefreshCw, ExternalLink, FileCode, Link2 } from "lucide-react";
import AdminLayout from "@/components/admin-layout";
import BrandingSettingsComponent from "@/components/admin/branding-settings";
import AiModelSelector from "@/components/admin/ai-model-selector";
import type { Merchant } from "@shared/schema";

interface ShopifyInstallation {
  id: number;
  shopDomain: string;
  status: string;
  scope: string | null;
}

export default function AdminSettings() {
  const { toast } = useToast();
  
  const [printifyToken, setPrintifyToken] = useState("");
  const [printifyShopId, setPrintifyShopId] = useState("");
  const [detectShopLoading, setDetectShopLoading] = useState(false);
  const [shopDetectResult, setShopDetectResult] = useState<{ message: string; error?: boolean; shops?: { id: string; title: string }[]; instructions?: string[] } | null>(null);
  const [useBuiltIn, setUseBuiltIn] = useState(true);
  const [customToken, setCustomToken] = useState("");

  const { data: merchant, isLoading: merchantLoading } = useQuery<Merchant>({
    queryKey: ["/api/merchant"],
  });

  const { data: shopifyInstallations, isLoading: installationsLoading } = useQuery<
    { installations: ShopifyInstallation[] },
    Error,
    ShopifyInstallation[]
  >({
    queryKey: ["/api/shopify/installations"],
    select: (data) => data.installations,
  });

  const handleReconnectStore = (shopDomain: string) => {
    // Open Shopify reinstall in a new tab (attempts to revoke and reinstall)
    const reinstallUrl = `${window.location.origin}/shopify/reinstall?shop=${encodeURIComponent(shopDomain)}`;
    window.open(reinstallUrl, '_blank');
  };

  const handleSyncUrls = async () => {
    try {
      const res = await apiRequest("POST", "/api/shopify/sync-urls");
      const data = await res.json();
      toast({
        title: "Success",
        description: data.message || "App URLs synced with Shopify successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to sync app URLs with Shopify",
        variant: "destructive",
      });
    }
  };

  const handleRegisterScript = async () => {
    try {
      const res = await apiRequest("POST", "/api/shopify/register-script");
      const data = await res.json();
      toast({
        title: "Success",
        description: data.message || "Script tag registered successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to register script tag",
        variant: "destructive",
      });
    }
  };

  const updateMerchantMutation = useMutation({
    mutationFn: async (updates: Partial<Merchant>) => {
      const res = await apiRequest("PUT", "/api/merchant", updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/merchant"] });
      toast({
        title: "Settings saved",
        description: "Your integration settings have been updated.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    if (merchant) {
      setPrintifyToken(merchant.printifyApiToken || "");
      setPrintifyShopId(merchant.printifyShopId || "");
      setUseBuiltIn(merchant.useBuiltInNanoBanana ?? true);
      setCustomToken(merchant.customNanoBananaToken || "");
    }
  }, [merchant]);

  const handleSave = () => {
    updateMerchantMutation.mutate({
      printifyApiToken: printifyToken,
      printifyShopId: printifyShopId,
      useBuiltInNanoBanana: useBuiltIn,
      customNanoBananaToken: customToken,
    });
  };

  const handleDetectShop = async () => {
    if (!printifyToken) {
      toast({
        title: "Token required",
        description: "Please enter your Printify API token first.",
        variant: "destructive",
      });
      return;
    }

    setDetectShopLoading(true);
    setShopDetectResult(null);
    try {
      const res = await fetch("/api/printify/detect-shop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: printifyToken }),
      });
      const data = await res.json();
      setShopDetectResult(data);
      
      if (data.shopId) {
        setPrintifyShopId(data.shopId);
        toast({
          title: "Shop detected",
          description: `Found shop: ${data.shopName || data.shopId}`,
        });
      }
    } catch (error) {
      toast({
        title: "Detection failed",
        description: "Could not connect to Printify API.",
        variant: "destructive",
      });
    } finally {
      setDetectShopLoading(false);
    }
  };

  if (merchantLoading) {
    return (
      <AdminLayout title="Settings">
        <div className="space-y-6">
          <Skeleton className="h-[200px] w-full" />
          <Skeleton className="h-[200px] w-full" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title="Settings">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Store className="h-5 w-5" />
              Printify Integration
            </CardTitle>
            <CardDescription>
              Connect to Printify for print-on-demand fulfillment
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="printify-token">PRINTIFY API TOKEN</Label>
              <Input
                id="printify-token"
                type="password"
                placeholder="Enter your Printify API token"
                value={printifyToken}
                onChange={(e) => setPrintifyToken(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Get your API token from Printify Dashboard &gt; Settings &gt; API
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="printify-shop">SHOP ID</Label>
              <div className="flex gap-2">
                <Input
                  id="printify-shop"
                  placeholder="Shop ID (auto-detected)"
                  value={printifyShopId}
                  onChange={(e) => setPrintifyShopId(e.target.value)}
                />
                <Button 
                  variant="outline" 
                  onClick={handleDetectShop}
                  disabled={detectShopLoading}
                >
                  {detectShopLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Detect"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileCode className="h-5 w-5" />
              AI Integration
            </CardTitle>
            <CardDescription>
              Configure AI image generation settings
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="use-builtin">USE BUILT-IN AI</Label>
                <p className="text-xs text-muted-foreground">
                  Use the default AI provider (recommended)
                </p>
              </div>
              <Switch
                id="use-builtin"
                checked={useBuiltIn}
                onCheckedChange={setUseBuiltIn}
              />
            </div>

            {!useBuiltIn && (
              <div className="space-y-2 pt-2">
                <Label htmlFor="custom-token">CUSTOM API TOKEN</Label>
                <Input
                  id="custom-token"
                  type="password"
                  placeholder="Enter your custom API token"
                  value={customToken}
                  onChange={(e) => setCustomToken(e.target.value)}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Store className="h-5 w-5" />
              Shopify Integration
            </CardTitle>
            <CardDescription>
              Manage your connected Shopify stores
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {installationsLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : shopifyInstallations && shopifyInstallations.length > 0 ? (
              <div className="space-y-4">
                {shopifyInstallations.map((inst) => (
                  <div key={inst.id} className="flex items-center justify-between p-3 border rounded-lg">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-primary/10 rounded-full">
                        <Store className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium">{inst.shopDomain}</p>
                        <p className="text-xs text-muted-foreground capitalize">{inst.status}</p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button 
                        size="sm" 
                        variant="outline" 
                        className="gap-2"
                        onClick={handleSyncUrls}
                        title="Update all AI Art Studio products to use the current app URL"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Sync URLs
                      </Button>
                      <Button 
                        size="sm" 
                        variant="outline" 
                        className="gap-2"
                        onClick={handleRegisterScript}
                      >
                        <FileCode className="h-3.5 w-3.5" />
                        Register Script
                      </Button>
                      <Button 
                        size="sm" 
                        variant="outline" 
                        className="gap-2"
                        onClick={() => handleReconnectStore(inst.shopDomain)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Reconnect
                      </Button>
                      <Button size="sm" variant="ghost" asChild>
                        <a href={`https://${inst.shopDomain}/admin/apps/ai-art-studio`} target="_blank" rel="noreferrer">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-6 border-2 border-dashed rounded-lg">
                <Link2 className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">No Shopify stores connected yet.</p>
              </div>
            )}
          </CardContent>
        </Card>

        <AiModelSelector />
        <BrandingSettingsComponent />

        <div className="flex justify-end pt-4">
          <Button 
            size="lg" 
            className="gap-2" 
            onClick={handleSave}
            disabled={updateMerchantMutation.isPending}
          >
            {updateMerchantMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save Settings
          </Button>
        </div>
      </div>
    </AdminLayout>
  );
}
