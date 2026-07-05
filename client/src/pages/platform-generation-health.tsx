import AdminLayout from "@/components/admin-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface HealthRow {
  shopDomain: string;
  installationId: number;
  successCount: number;
  failureCount: number;
  failureRate: number;
  lastFailureAt: string | null;
}

export default function PlatformGenerationHealthPage() {
  const { data, isLoading, error } = useQuery<{ shops: HealthRow[] }>({
    queryKey: ["/api/platform/generation-health"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/platform/generation-health");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to load generation health");
      }
      return res.json();
    },
  });

  return (
    <AdminLayout>
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Generation health</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Rolling 1-hour failure rates per shop (founder monitoring). Sorted by failure rate.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Shops</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && <Skeleton className="h-48 w-full" />}
            {error && (
              <p className="text-sm text-destructive">{(error as Error).message}</p>
            )}
            {!isLoading && !error && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-2 pr-4">Shop</th>
                      <th className="py-2 pr-4">Success</th>
                      <th className="py-2 pr-4">Failures</th>
                      <th className="py-2 pr-4">Rate</th>
                      <th className="py-2">Last failure</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.shops ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-4 text-muted-foreground">
                          No health data yet.
                        </td>
                      </tr>
                    ) : (
                      data?.shops.map((row) => (
                        <tr key={row.installationId} className="border-b last:border-0">
                          <td className="py-2 pr-4 font-mono text-xs">{row.shopDomain}</td>
                          <td className="py-2 pr-4">{row.successCount}</td>
                          <td className="py-2 pr-4">{row.failureCount}</td>
                          <td className="py-2 pr-4">
                            {(row.failureRate * 100).toFixed(1)}%
                          </td>
                          <td className="py-2 text-muted-foreground text-xs">
                            {row.lastFailureAt
                              ? new Date(row.lastFailureAt).toLocaleString()
                              : "—"}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
