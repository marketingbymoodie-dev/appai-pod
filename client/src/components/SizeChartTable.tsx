import { useEffect, useMemo, useState } from "react";
import type { NormalizedSizeChart } from "@/lib/printifySizeCharts";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type UnitMode = "imperial" | "metric";

type SizeChartTableProps = {
  chart: NormalizedSizeChart | null | undefined;
  className?: string;
  compact?: boolean;
};

function convertInchesToCm(value: string) {
  if (!value.trim()) return value;
  const num = Number(value);
  if (Number.isNaN(num)) return value;
  return (num * 2.54).toFixed(1);
}

function convertRowLabel(label: string) {
  return label.replace(/,\s*in\b/i, ", cm");
}

function labelUsesInches(label: string) {
  return /,\s*in\b/i.test(label);
}

function rowValuesAreNumeric(values: string[]) {
  return values.length > 0 && values.every((value) => {
    if (!value.trim()) return true;
    return !Number.isNaN(Number(value));
  });
}

export default function SizeChartTable({
  chart,
  className,
  compact = false,
}: SizeChartTableProps) {
  const hasImperialRows = useMemo(
    () => !!chart?.rows.some((row) => labelUsesInches(row.label)),
    [chart]
  );
  const [unitMode, setUnitMode] = useState<UnitMode>(
    hasImperialRows ? "imperial" : "metric"
  );

  useEffect(() => {
    setUnitMode(hasImperialRows ? "imperial" : "metric");
  }, [hasImperialRows, chart?.blueprintId]);

  if (!chart || chart.sizes.length === 0 || chart.rows.length === 0) {
    return (
      <div className={cn("rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground", className)}>
        Size chart unavailable
      </div>
    );
  }

  const displayRows = chart.rows.map((row) => {
    const shouldConvert = unitMode === "metric" && labelUsesInches(row.label) && rowValuesAreNumeric(row.values);
    return {
      label: shouldConvert ? convertRowLabel(row.label) : row.label,
      values: shouldConvert ? row.values.map(convertInchesToCm) : row.values,
    };
  });

  const subtitle = [chart.brand, chart.model].filter(Boolean).join(" ");
  const unitLabel = unitMode === "metric" ? "Metric (cm)" : chart.unit || "Imperial (in)";

  return (
    <section className={cn("rounded-lg border bg-background p-3 sm:p-4", className)}>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className={cn("font-semibold", compact ? "text-sm" : "text-base")}>
            Size Guide
          </h3>
          <p className="text-xs text-muted-foreground sm:text-sm">
            {subtitle || chart.title}
            {subtitle && chart.title ? ` · ${chart.title}` : ""}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{unitLabel}</p>
        </div>
        {hasImperialRows && (
          <div className="inline-flex w-full rounded-md border bg-muted p-1 sm:w-auto">
            <Button
              type="button"
              size="sm"
              variant={unitMode === "imperial" ? "default" : "ghost"}
              className="min-h-8 flex-1 px-3 text-xs sm:flex-none"
              onClick={() => setUnitMode("imperial")}
            >
              Imperial
            </Button>
            <Button
              type="button"
              size="sm"
              variant={unitMode === "metric" ? "default" : "ghost"}
              className="min-h-8 flex-1 px-3 text-xs sm:flex-none"
              onClick={() => setUnitMode("metric")}
            >
              Metric
            </Button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 min-w-28 bg-background px-3 py-2 text-xs">
                Size
              </TableHead>
              {chart.sizes.map((size) => (
                <TableHead key={size} className="whitespace-nowrap px-3 py-2 text-center text-xs">
                  {size}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {displayRows.map((row) => (
              <TableRow key={row.label}>
                <TableCell className="sticky left-0 z-10 min-w-28 bg-background px-3 py-2 text-xs font-medium">
                  {row.label}
                </TableCell>
                {chart.sizes.map((size, index) => (
                  <TableCell key={`${row.label}-${size}-${index}`} className="whitespace-nowrap px-3 py-2 text-center text-xs">
                    {row.values[index] || "-"}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
