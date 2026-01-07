import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CreditCard, TrendingUp, Users } from "lucide-react";
import AdminLayout from "@/components/admin-layout";
import type { Merchant } from "@shared/schema";

interface CreditStats {
  totalCreditsIssued: number;
  totalCreditsUsed: number;
  activeCustomers: number;
}

export default function AdminCredits() {
  const { data: merchant } = useQuery<Merchant>({
    queryKey: ["/api/merchant"],
  });

  const { data: stats, isLoading } = useQuery<CreditStats>({
    queryKey: ["/api/admin/credit-stats"],
    queryFn: async () => {
      const response = await fetch("/api/admin/credit-stats", { credentials: "include" });
      if (!response.ok) {
        return { totalCreditsIssued: 0, totalCreditsUsed: 0, activeCustomers: 0 };
      }
      return response.json();
    },
  });

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-credits-title">Credits</h1>
          <p className="text-muted-foreground">Monitor credit usage across your store</p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Monthly Limit</CardTitle>
              <CreditCard className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-monthly-limit">
                {merchant?.generationsThisMonth || 0} / {merchant?.monthlyGenerationLimit || 100}
              </div>
              <p className="text-xs text-muted-foreground">
                Generations this billing period
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Subscription</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold capitalize" data-testid="text-subscription-tier">
                {merchant?.subscriptionTier || "Free"}
              </div>
              <p className="text-xs text-muted-foreground">
                Current plan
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Customers</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <div className="text-2xl font-bold" data-testid="text-active-customers">
                  {stats?.activeCustomers || 0}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Customers with credits
              </p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Usage Overview</CardTitle>
            <CardDescription>Credit allocation and consumption</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm">Total Credits Issued</span>
                {isLoading ? (
                  <Skeleton className="h-5 w-16" />
                ) : (
                  <span className="font-medium">{stats?.totalCreditsIssued || 0}</span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">Total Credits Used</span>
                {isLoading ? (
                  <Skeleton className="h-5 w-16" />
                ) : (
                  <span className="font-medium">{stats?.totalCreditsUsed || 0}</span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">Utilization Rate</span>
                {isLoading ? (
                  <Skeleton className="h-5 w-16" />
                ) : (
                  <span className="font-medium">
                    {stats?.totalCreditsIssued 
                      ? Math.round((stats.totalCreditsUsed / stats.totalCreditsIssued) * 100)
                      : 0}%
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
