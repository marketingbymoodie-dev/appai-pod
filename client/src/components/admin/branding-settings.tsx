import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import type { Merchant } from "@shared/schema";

interface BrandingSettings {
  primaryColor?: string;
  secondaryColor?: string;
  textColor?: string;
  borderColor?: string;
  backgroundColor?: string;
  fontFamily?: string;
  syncedAt?: string;
}

export default function BrandingSettingsComponent() {
  const { toast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncResult, setSyncResult] = useState<{ success: boolean; message: string } | null>(null);

  const [branding, setBranding] = useState<BrandingSettings>({
    primaryColor: "#000000",
    secondaryColor: "#f5f5f5",
    textColor: "#000000",
    borderColor: "#000000",
    backgroundColor: "#ffffff",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  });

  const { data: merchant, isLoading: merchantLoading } = useQuery<Merchant>({
    queryKey: ["/api/merchant"],
    onSuccess: (data) => {
      if (data.brandingSettings) {
        setBranding(data.brandingSettings as BrandingSettings);
      }
    },
  });

  const updateBrandingMutation = useMutation({
    mutationFn: async (data: BrandingSettings) => {
      const response = await apiRequest("PUT", "/api/merchant", { brandingSettings: data });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/merchant"] });
      toast({ title: "Branding saved", description: "Your branding settings have been updated." });
      setIsEditing(false);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save branding", description: error.message, variant: "destructive" });
    },
  });

  const syncThemeMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/branding/sync-theme", {});
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/merchant"] });
      setSyncResult({ success: true, message: data.message || "Theme synced successfully" });
      toast({ title: "Theme synced", description: "Your branding has been updated from your Shopify theme." });
      setTimeout(() => setSyncResult(null), 3000);
    },
    onError: (error: Error) => {
      setSyncResult({ success: false, message: error.message });
      toast({ title: "Failed to sync theme", description: error.message, variant: "destructive" });
      setTimeout(() => setSyncResult(null), 3000);
    },
  });

  const handleSave = () => {
    updateBrandingMutation.mutate(branding);
  };

  const handleSync = () => {
    setSyncLoading(true);
    syncThemeMutation.mutate();
    setSyncLoading(false);
  };

  if (merchantLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-96 mt-2" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Branding & Styling</CardTitle>
        <CardDescription>Customize the colors and fonts for your customizer pages to match your store</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Sync Theme Button */}
        <div className="flex items-center justify-between p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <div>
            <p className="font-medium text-sm">Auto-Sync with Theme</p>
            <p className="text-xs text-muted-foreground">Automatically detect colors and fonts from your Shopify theme</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={syncLoading || syncThemeMutation.isPending}
          >
            {syncLoading || syncThemeMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            <span className="ml-2">Sync</span>
          </Button>
        </div>

        {/* Sync Result */}
        {syncResult && (
          <div className={`flex items-start gap-2 p-3 rounded-lg ${syncResult.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
            {syncResult.success ? (
              <CheckCircle className="h-4 w-4 text-green-600 mt-0.5" />
            ) : (
              <AlertCircle className="h-4 w-4 text-red-600 mt-0.5" />
            )}
            <p className={`text-sm ${syncResult.success ? 'text-green-800' : 'text-red-800'}`}>{syncResult.message}</p>
          </div>
        )}

        {/* Last Synced */}
        {branding.syncedAt && (
          <p className="text-xs text-muted-foreground">
            Last synced: {new Date(branding.syncedAt).toLocaleString()}
          </p>
        )}

        {/* Color Settings */}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="primary-color">Primary Color (Buttons)</Label>
              <div className="flex gap-2">
                <Input
                  id="primary-color"
                  type="color"
                  value={branding.primaryColor || "#000000"}
                  onChange={(e) => setBranding({ ...branding, primaryColor: e.target.value })}
                  className="h-10 w-16 cursor-pointer"
                  disabled={!isEditing}
                />
                <Input
                  type="text"
                  value={branding.primaryColor || "#000000"}
                  onChange={(e) => setBranding({ ...branding, primaryColor: e.target.value })}
                  placeholder="#000000"
                  disabled={!isEditing}
                  className="flex-1"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="text-color">Text Color</Label>
              <div className="flex gap-2">
                <Input
                  id="text-color"
                  type="color"
                  value={branding.textColor || "#000000"}
                  onChange={(e) => setBranding({ ...branding, textColor: e.target.value })}
                  className="h-10 w-16 cursor-pointer"
                  disabled={!isEditing}
                />
                <Input
                  type="text"
                  value={branding.textColor || "#000000"}
                  onChange={(e) => setBranding({ ...branding, textColor: e.target.value })}
                  placeholder="#000000"
                  disabled={!isEditing}
                  className="flex-1"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="border-color">Border Color</Label>
              <div className="flex gap-2">
                <Input
                  id="border-color"
                  type="color"
                  value={branding.borderColor || "#000000"}
                  onChange={(e) => setBranding({ ...branding, borderColor: e.target.value })}
                  className="h-10 w-16 cursor-pointer"
                  disabled={!isEditing}
                />
                <Input
                  type="text"
                  value={branding.borderColor || "#000000"}
                  onChange={(e) => setBranding({ ...branding, borderColor: e.target.value })}
                  placeholder="#000000"
                  disabled={!isEditing}
                  className="flex-1"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="bg-color">Background Color</Label>
              <div className="flex gap-2">
                <Input
                  id="bg-color"
                  type="color"
                  value={branding.backgroundColor || "#ffffff"}
                  onChange={(e) => setBranding({ ...branding, backgroundColor: e.target.value })}
                  className="h-10 w-16 cursor-pointer"
                  disabled={!isEditing}
                />
                <Input
                  type="text"
                  value={branding.backgroundColor || "#ffffff"}
                  onChange={(e) => setBranding({ ...branding, backgroundColor: e.target.value })}
                  placeholder="#ffffff"
                  disabled={!isEditing}
                  className="flex-1"
                />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="font-family">Font Family</Label>
            <Input
              id="font-family"
              type="text"
              value={branding.fontFamily || ""}
              onChange={(e) => setBranding({ ...branding, fontFamily: e.target.value })}
              placeholder="e.g., -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
              disabled={!isEditing}
            />
          </div>
        </div>

        {/* Preview */}
        <div className="p-4 border rounded-lg space-y-3">
          <p className="text-xs font-semibold text-muted-foreground">PREVIEW</p>
          <div
            style={{
              backgroundColor: branding.backgroundColor,
              color: branding.textColor,
              fontFamily: branding.fontFamily,
              padding: "1rem",
              borderRadius: "0.5rem",
              border: `2px solid ${branding.borderColor}`,
            }}
          >
            <p className="text-sm mb-3">This is how your customizer will look</p>
            <button
              style={{
                backgroundColor: branding.primaryColor,
                color: "#ffffff",
                padding: "0.5rem 1rem",
                borderRadius: "0.375rem",
                border: "none",
                cursor: "pointer",
                fontFamily: branding.fontFamily,
                fontWeight: "500",
              }}
            >
              Generate Design
            </button>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2 justify-end">
          {isEditing ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setIsEditing(false);
                  // Reset to current merchant branding
                  if (merchant?.brandingSettings) {
                    setBranding(merchant.brandingSettings as BrandingSettings);
                  }
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={updateBrandingMutation.isPending}
              >
                {updateBrandingMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : null}
                Save Changes
              </Button>
            </>
          ) : (
            <Button onClick={() => setIsEditing(true)}>
              Edit Colors
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
