import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart3, CheckCircle, AlertCircle, TrendingUp } from "lucide-react";
import AdminLayout from "@/components/admin-layout";
import GenerationQuotaUsage from "@/components/admin/GenerationQuotaUsage";
import { BookOpen } from "lucide-react";

interface GenerationStats {
  total: number;
  successful: number;
  failed: number;
}

export default function AdminDashboard() {
  const { data: stats, isLoading } = useQuery<GenerationStats>({
    queryKey: ["/api/admin/stats"],
  });

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-dashboard-title">Dashboard</h1>
          <p className="text-muted-foreground">Overview of your AI Art Studio performance</p>
        </div>

        <GenerationQuotaUsage />

        <p className="text-xs text-muted-foreground -mt-2">
          Plan quota is your shop&apos;s AI generation allowance. Analytics below count logged generations from the last 30 days.
        </p>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Generations</CardTitle>
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <div className="text-2xl font-bold" data-testid="text-total-generations">
                  {stats?.total || 0}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Successful</CardTitle>
              <CheckCircle className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <div className="text-2xl font-bold text-green-600" data-testid="text-successful-generations">
                  {stats?.successful || 0}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Failed</CardTitle>
              <AlertCircle className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <div className="text-2xl font-bold text-red-600" data-testid="text-failed-generations">
                  {stats?.failed || 0}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <div className="text-2xl font-bold" data-testid="text-success-rate">
                  {stats?.total ? Math.round((stats.successful / stats.total) * 100) : 0}%
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-muted-foreground" />
              <CardTitle>Setup Guide</CardTitle>
            </div>
            <CardDescription>One-time configuration steps</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {[
              {
                n: 1,
                title: "Enable the AppAI App Embed",
                body: "Online Store → Themes → Customize → App Embeds → Enable AI Art Studio Embed. One-time step.",
              },
              {
                n: 2,
                title: "Import your products from Printify",
                body: "Go to Products Import and import from Printify.",
              },
              {
                n: 3,
                title: "Test your Art Generator",
                body: "Test your art generator for your chosen product before creating a Customiser Page for it.",
              },
              {
                n: 4,
                title: "Create a customizer page for your new generator",
                body: "Click Create Page, pick a title, URL handle, and which product customers will customize. Customizer page allowance depends on your plan.",
              },
              {
                n: 5,
                title: "Check your store menu",
                body: "Check your store menu has added the newly created Customiser page and test it on your live store to make sure it's working as expected. Refresh your web page if it hasn't shown up immediately.",
              },
            ].map(({ n, title, body }) => (
              <div key={n} className="flex items-start gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                  {n}
                </span>
                <div>
                  <p className="font-medium">{title}</p>
                  <p className="text-muted-foreground">{body}</p>
                </div>
              </div>
            ))}
            <p className="text-muted-foreground pt-1">
              Visit the storefront page to ensure it's loading correctly. Repeat steps 3–5 for every product you want to have a generator page for.
            </p>
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
