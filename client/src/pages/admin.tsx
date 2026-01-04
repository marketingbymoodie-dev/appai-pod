import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link } from "wouter";
import { ArrowLeft, Settings, BarChart3, Save, CheckCircle, AlertCircle } from "lucide-react";
import type { Merchant } from "@shared/schema";

interface GenerationStats {
  total: number;
  successful: number;
  failed: number;
}

export default function AdminPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const [printifyToken, setPrintifyToken] = useState("");
  const [printifyShopId, setPrintifyShopId] = useState("");
  const [useBuiltIn, setUseBuiltIn] = useState(true);
  const [customToken, setCustomToken] = useState("");

  const { data: merchant, isLoading: merchantLoading } = useQuery<Merchant>({
    queryKey: ["/api/merchant"],
    enabled: isAuthenticated,
  });

  const { data: stats } = useQuery<GenerationStats>({
    queryKey: ["/api/admin/stats"],
    enabled: isAuthenticated && !!merchant,
  });

  const saveMutation = useMutation({
    mutationFn: async (data: Partial<Merchant>) => {
      const response = await apiRequest("PUT", "/api/merchant", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/merchant"] });
      toast({
        title: "Settings saved",
        description: "Your merchant settings have been updated.",
      });
    },
    onError: () => {
      toast({
        title: "Save failed",
        description: "Failed to save settings",
        variant: "destructive",
      });
    },
  });

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Skeleton className="h-32 w-32 rounded-full" />
      </div>
    );
  }

  if (!isAuthenticated) {
    window.location.href = "/api/login";
    return null;
  }

  const handleSave = () => {
    saveMutation.mutate({
      printifyApiToken: printifyToken || merchant?.printifyApiToken,
      printifyShopId: printifyShopId || merchant?.printifyShopId,
      useBuiltInNanoBanana: useBuiltIn,
      customNanoBananaToken: customToken || merchant?.customNanoBananaToken,
    });
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 bg-background z-50">
        <div className="container mx-auto px-4 py-3 flex items-center gap-4">
          <Link href="/">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <h1 className="text-lg font-semibold">Merchant Admin</h1>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <Tabs defaultValue="settings">
          <TabsList className="mb-6">
            <TabsTrigger value="settings" data-testid="tab-settings">
              <Settings className="h-4 w-4 mr-2" />
              Settings
            </TabsTrigger>
            <TabsTrigger value="stats" data-testid="tab-stats">
              <BarChart3 className="h-4 w-4 mr-2" />
              Statistics
            </TabsTrigger>
          </TabsList>

          <TabsContent value="settings">
            <div className="grid gap-6 max-w-2xl">
              <Card>
                <CardHeader>
                  <CardTitle>Printify Integration</CardTitle>
                  <CardDescription>
                    Connect your Printify account to enable print fulfillment
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="printify-token">API Token</Label>
                    <Input
                      id="printify-token"
                      type="password"
                      placeholder="Enter your Printify API token"
                      value={printifyToken}
                      onChange={(e) => setPrintifyToken(e.target.value)}
                      data-testid="input-printify-token"
                    />
                    <p className="text-xs text-muted-foreground">
                      Get your API token from Printify Settings &gt; API
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="printify-shop">Shop ID</Label>
                    <Input
                      id="printify-shop"
                      placeholder="Your Printify Shop ID"
                      value={printifyShopId}
                      onChange={(e) => setPrintifyShopId(e.target.value)}
                      data-testid="input-printify-shop"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    {merchant?.printifyApiToken ? (
                      <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                        <CheckCircle className="h-4 w-4" />
                        <span className="text-sm">Connected</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <AlertCircle className="h-4 w-4" />
                        <span className="text-sm">Not connected</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>AI Image Generation</CardTitle>
                  <CardDescription>
                    Configure how AI artwork is generated
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <Label>Use Built-in Nano Banana</Label>
                      <p className="text-xs text-muted-foreground">
                        Uses Replit credits for image generation
                      </p>
                    </div>
                    <Switch
                      checked={useBuiltIn}
                      onCheckedChange={setUseBuiltIn}
                      data-testid="switch-builtin"
                    />
                  </div>
                  
                  {!useBuiltIn && (
                    <div className="space-y-2">
                      <Label htmlFor="custom-token">Custom API Token</Label>
                      <Input
                        id="custom-token"
                        type="password"
                        placeholder="Enter your Nano Banana API token"
                        value={customToken}
                        onChange={(e) => setCustomToken(e.target.value)}
                        data-testid="input-custom-token"
                      />
                      <p className="text-xs text-muted-foreground">
                        Use your own API token for unlimited generations
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Subscription</CardTitle>
                  <CardDescription>
                    Your current plan and usage limits
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {merchantLoading ? (
                    <Skeleton className="h-20 w-full" />
                  ) : (
                    <div className="space-y-3">
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">Current Plan</span>
                        <span className="font-medium capitalize">{merchant?.subscriptionTier || "Free"}</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">Monthly Limit</span>
                        <span>{merchant?.monthlyGenerationLimit || 100} generations</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-muted-foreground">Used This Month</span>
                        <span>{merchant?.generationsThisMonth || 0} generations</span>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Button onClick={handleSave} disabled={saveMutation.isPending} data-testid="button-save">
                <Save className="h-4 w-4 mr-2" />
                {saveMutation.isPending ? "Saving..." : "Save Settings"}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="stats">
            <div className="grid gap-6 sm:grid-cols-3 max-w-3xl">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Total Generations</CardDescription>
                  <CardTitle className="text-3xl" data-testid="text-total-generations">
                    {stats?.total ?? 0}
                  </CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Successful</CardDescription>
                  <CardTitle className="text-3xl text-green-600 dark:text-green-400" data-testid="text-successful">
                    {stats?.successful ?? 0}
                  </CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Failed</CardDescription>
                  <CardTitle className="text-3xl text-destructive" data-testid="text-failed">
                    {stats?.failed ?? 0}
                  </CardTitle>
                </CardHeader>
              </Card>
            </div>

            <Card className="mt-6 max-w-3xl">
              <CardHeader>
                <CardTitle>Recent Activity</CardTitle>
                <CardDescription>
                  Generation activity over the past 30 days
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Detailed analytics coming soon. Track customer generations, popular styles, and conversion rates.
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
