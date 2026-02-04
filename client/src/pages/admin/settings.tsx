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

  const handleUninstallInstructions = (shopDomain: string) => {
    // Open Shopify admin apps page where they can uninstall
    window.open(`https://${shopDomain}/admin/settings/apps`, '_blank');
  };

  useEffect(() => {
    if (merchant) {
      setPrintifyToken(merchant.printifyApiToken || "");
      setPrintifyShopId(merchant.printifyShopId || "");
      setUseBuiltIn(merchant.useBuiltInNanoBanana);
      setCustomToken(merchant.customNanoBananaToken || "");
    }
  }, [merchant]);

  const updateMerchantMutation = useMutation({
    mutationFn: async (data: Partial<Merchant>) => {
      const response = await apiRequest("PUT", "/api/merchant", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/merchant"] });
      toast({ title: "Settings saved", description: "Your settings have been updated." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save settings", description: error.message, variant: "destructive" });
    },
  });

  const registerScriptMutation = useMutation({
    mutationFn: async (shopDomain: string) => {
      const response = await apiRequest("POST", "/api/shopify/register-script", { shopDomain });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Cart script registered", description: "The cart image replacement script has been registered with Shopify." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to register script", description: error.message, variant: "destructive" });
    },
  });

  const syncMetafieldsMutation = useMutation({
    mutationFn: async (shopDomain: string) => {
      const response = await apiRequest("POST", "/api/shopify/sync-metafields", { shopDomain });
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "App URLs synced",
        description: `Updated ${data.updated} products to use the current app URL.${data.failed > 0 ? ` ${data.failed} failed.` : ''}`
      });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to sync app URLs", description: error.message, variant: "destructive" });
    },
  });

  const handleDetectShop = async () => {
    if (!printifyToken) {
      setShopDetectResult({ message: "Please enter a Printify API token first", error: true });
      return;
    }
    
    setDetectShopLoading(true);
    setShopDetectResult(null);
    
    try {
      const response = await fetch("/api/admin/printify/detect-shop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: printifyToken }),
        credentials: "include",
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        setShopDetectResult({ message: data.error || "Failed to detect shop", error: true, instructions: data.instructions });
      } else if (data.shops && data.shops.length > 0) {
        if (data.shops.length === 1) {
          setPrintifyShopId(data.shops[0].id);
          setShopDetectResult({ message: `Found shop: ${data.shops[0].title}`, shops: data.shops });
        } else {
          setShopDetectResult({ message: `Found ${data.shops.length} shops. Select one:`, shops: data.shops });
        }
      } else {
        setShopDetectResult({ message: "No shops found for this token", error: true, instructions: data.instructions });
      }
    } catch (error) {
      setShopDetectResult({ message: "Failed to detect shop", error: true });
    } finally {
      setDetectShopLoading(false);
    }
  };

  const handleSaveSettings = () => {
    updateMerchantMutation.mutate({
      printifyApiToken: printifyToken,
      printifyShopId: printifyShopId,
      useBuiltInNanoBanana: useBuiltIn,
      customNanoBananaToken: customToken,
    });
  };

  if (merchantLoading) {
    return (
      <AdminLayout>
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-2xl">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-settings-title">Settings</h1>
          <p className="text-muted-foreground">Configure your AI Art Studio integrations</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Printify Integration</CardTitle>
            <CardDescription>Connect to Printify for print-on-demand fulfillment</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="printify-token">Printify API Token</Label>
              <Input
                id="printify-token"
                type="password"
                value={printifyToken}
                onChange={(e) => setPrintifyToken(e.target.value)}
                placeholder="Enter your Printify API token"
                data-testid="input-printify-token"
              />
              <p className="text-xs text-muted-foreground">
                Get your API token from Printify Dashboard &gt; Settings &gt; API
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="printify-shop">Shop ID</Label>
              <div className="flex gap-2">
                <Input
                  id="printify-shop"
                  value={printifyShopId}
                  onChange={(e) => setPrintifyShopId(e.target.value)}
                  placeholder="Shop ID (auto-detected)"
                  data-testid="input-printify-shop"
                />
                <Button 
                  variant="outline" 
                  onClick={handleDetectShop}
                  disabled={detectShopLoading || !printifyToken}
                  data-testid="button-detect-shop"
                >
                  {detectShopLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Detect"}
                </Button>
              </div>
              {shopDetectResult && (
                <div className={`text-sm flex items-start gap-2 ${shopDetectResult.error ? 'text-red-600' : 'text-green-600'}`}>
                  {shopDetectResult.error ? <AlertCircle className="h-4 w-4 mt-0.5" /> : <CheckCircle className="h-4 w-4 mt-0.5" />}
                  <div>
                    <span>{shopDetectResult.message}</span>
                    {shopDetectResult.shops && shopDetectResult.shops.length > 1 && (
                      <div className="mt-2 space-y-1">
                        {shopDetectResult.shops.map((shop) => (
                          <Button
                            key={shop.id}
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setPrintifyShopId(shop.id);
                              setShopDetectResult({ message: `Selected: ${shop.title}` });
                            }}
                          >
                            {shop.title} ({shop.id})
                          </Button>
                        ))}
                      </div>
                    )}
                    {shopDetectResult.instructions && (
                      <ul className="mt-2 list-disc list-inside text-xs text-muted-foreground">
                        {shopDetectResult.instructions.map((instruction, i) => (
                          <li key={i}>{instruction}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>AI Integration</CardTitle>
            <CardDescription>Configure AI image generation settings</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="use-builtin">Use Built-in AI</Label>
                <p className="text-xs text-muted-foreground">Use the default AI provider (recommended)</p>
              </div>
              <Switch
                id="use-builtin"
                checked={useBuiltIn}
                onCheckedChange={setUseBuiltIn}
                data-testid="switch-use-builtin"
              />
            </div>

            {!useBuiltIn && (
              <div className="space-y-2">
                <Label htmlFor="custom-token">Custom API Token</Label>
                <Input
                  id="custom-token"
                  type="password"
                  value={customToken}
                  onChange={(e) => setCustomToken(e.target.value)}
                  placeholder="Enter your custom API token"
                  data-testid="input-custom-token"
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
            <CardDescription>Manage your connected Shopify stores</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {installationsLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : shopifyInstallations && shopifyInstallations.length > 0 ? (
              <div className="space-y-3">
                {shopifyInstallations.map((installation) => {
                  const hasWriteProducts = installation.scope?.includes('write_products');
                  const needsPermissionFix = !hasWriteProducts && installation.status === 'active';
                  return (
                    <div 
                      key={installation.id}
                      className="space-y-2"
                    >
                      <div className="flex items-center justify-between p-3 border rounded-md">
                        <div className="flex items-center gap-3">
                          <Store className="h-5 w-5 text-muted-foreground" />
                          <div>
                            <p className="font-medium">{installation.shopDomain}</p>
                            <div className="flex items-center gap-2 text-xs">
                              {installation.status === 'active' ? (
                                <span className="text-green-600 flex items-center gap-1">
                                  <CheckCircle className="h-3 w-3" /> Active
                                </span>
                              ) : (
                                <span className="text-yellow-600 flex items-center gap-1">
                                  <AlertCircle className="h-3 w-3" /> {installation.status}
                                </span>
                              )}
                              {needsPermissionFix && (
                                <span className="text-orange-600 flex items-center gap-1">
                                  <AlertCircle className="h-3 w-3" /> Missing product permissions
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => syncMetafieldsMutation.mutate(installation.shopDomain)}
                            disabled={syncMetafieldsMutation.isPending}
                            title="Update all AI Art Studio products to use the current app URL"
                            data-testid={`button-sync-urls-${installation.shopDomain}`}
                          >
                            {syncMetafieldsMutation.isPending ? (
                              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            ) : (
                              <Link2 className="h-4 w-4 mr-1" />
                            )}
                            Sync URLs
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => registerScriptMutation.mutate(installation.shopDomain)}
                            disabled={registerScriptMutation.isPending}
                            data-testid={`button-register-script-${installation.shopDomain}`}
                          >
                            {registerScriptMutation.isPending ? (
                              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            ) : (
                              <FileCode className="h-4 w-4 mr-1" />
                            )}
                            Register Script
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleReconnectStore(installation.shopDomain)}
                            data-testid={`button-reconnect-${installation.shopDomain}`}
                          >
                            <RefreshCw className="h-4 w-4 mr-1" />
                            Reconnect
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => window.open(`https://${installation.shopDomain}/admin`, '_blank')}
                            data-testid={`button-open-store-${installation.shopDomain}`}
                          >
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      {needsPermissionFix && (
                        <div className="bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-900 rounded-md p-3 text-sm">
                          <p className="font-medium text-orange-800 dark:text-orange-200 mb-2">
                            To enable "Send to Store", you need to grant product permissions:
                          </p>
                          <ol className="list-decimal list-inside space-y-1 text-orange-700 dark:text-orange-300 text-xs">
                            <li>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-auto p-0 text-xs text-orange-700 dark:text-orange-300 underline"
                                onClick={() => handleUninstallInstructions(installation.shopDomain)}
                              >
                                Open your Shopify Apps settings
                              </Button>
                              {" "}and uninstall this app
                            </li>
                            <li>Click "Reconnect" above to reinstall with the correct permissions</li>
                            <li>Approve all requested permissions when prompted</li>
                          </ol>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-6 text-muted-foreground">
                <Store className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No Shopify stores connected yet</p>
                <p className="text-xs mt-1">Install the app on your Shopify store to get started</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Button 
          onClick={handleSaveSettings}
          disabled={updateMerchantMutation.isPending}
          data-testid="button-save-settings"
        >
          {updateMerchantMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Save className="h-4 w-4 mr-2" />
          )}
          Save Settings
        </Button>
      </div>
    </AdminLayout>
  );
}
