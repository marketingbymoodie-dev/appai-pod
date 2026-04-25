import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import SizeChartTable from "@/components/SizeChartTable";
import { getSizeChartByBlueprintId } from "@/lib/printifySizeCharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const TEST_BLUEPRINTS = [
  { id: 12, label: "Bella+Canvas 3001" },
  { id: 6, label: "Gildan 5000" },
  { id: 706, label: "Comfort Colors 1717" },
  { id: 145, label: "Gildan 64000" },
  { id: 49, label: "Gildan 18000" },
];

export default function TestSizeChart() {
  const [blueprintId, setBlueprintId] = useState(12);
  const { data: chart, isLoading, error } = useQuery({
    queryKey: ["printify-size-chart", blueprintId],
    queryFn: () => getSizeChartByBlueprintId(blueprintId),
  });

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Printify Size Chart Test</CardTitle>
          <CardDescription>
            Loads size charts from Supabase table <code>printify_size_charts</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {TEST_BLUEPRINTS.map((blueprint) => (
              <Button
                key={blueprint.id}
                type="button"
                size="sm"
                variant={blueprintId === blueprint.id ? "default" : "outline"}
                onClick={() => setBlueprintId(blueprint.id)}
              >
                {blueprint.id} {blueprint.label}
              </Button>
            ))}
          </div>

          <div className="rounded-md bg-muted/50 p-3 text-sm">
            <div>Current blueprint ID: {blueprintId}</div>
            <div>Chart loaded: {chart ? "yes" : "no"}</div>
            <div>Row count: {chart?.rows.length ?? 0}</div>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              Failed to load size chart: {error instanceof Error ? error.message : "Unknown error"}
            </div>
          )}

          {isLoading ? (
            <div className="rounded-md border p-4 text-sm text-muted-foreground">Loading size chart...</div>
          ) : (
            <SizeChartTable chart={chart} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}
