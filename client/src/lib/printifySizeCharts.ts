import { supabase } from "./supabaseClient";
import { API_BASE } from "./urlBase";

export type RawSizeChartRow = string[];

export type PrintifySizeChartRecord = {
  id: string;
  blueprint_id: number;
  blueprint_title: string;
  brand: string | null;
  model: string | null;
  source_url: string | null;
  unit: string | null;
  measurements: RawSizeChartRow[] | null;
  raw_html?: string | null;
  status: string | null;
  scraped_at: string | null;
};

export type NormalizedSizeChart = {
  blueprintId: number;
  title: string;
  brand?: string | null;
  model?: string | null;
  unit?: string | null;
  sourceUrl?: string | null;
  scrapedAt?: string | null;
  sizes: string[];
  rows: {
    label: string;
    values: string[];
  }[];
};

function normalizeRow(row: unknown): RawSizeChartRow | null {
  if (!Array.isArray(row)) return null;
  const values = row.map((value) => String(value ?? "").trim());
  return values.some(Boolean) ? values : null;
}

export function normalizeSizeChart(
  record: PrintifySizeChartRecord
): NormalizedSizeChart | null {
  const rows = record.measurements?.map(normalizeRow).filter(Boolean) as
    | RawSizeChartRow[]
    | undefined;

  if (!rows || rows.length < 2) return null;

  const [sizes, ...measurementRows] = rows;
  const normalizedRows = measurementRows
    .map((row) => ({
      label: row[0] || "Measurement",
      values: row.slice(1),
    }))
    .filter((row) => row.values.length > 0);

  if (sizes.length === 0 || normalizedRows.length === 0) return null;

  return {
    blueprintId: record.blueprint_id,
    title: record.blueprint_title || `Blueprint ${record.blueprint_id}`,
    brand: record.brand,
    model: record.model,
    unit: record.unit,
    sourceUrl: record.source_url,
    scrapedAt: record.scraped_at,
    sizes,
    rows: normalizedRows,
  };
}

export async function getSizeChartByBlueprintId(
  blueprintId: number
): Promise<NormalizedSizeChart | null> {
  if (!blueprintId || Number.isNaN(blueprintId)) return null;

  const apiChart = await getSizeChartByBlueprintIdFromApi(blueprintId);
  if (apiChart) return apiChart;

  if (!supabase) {
    return null;
  }

  const result = await Promise.race([
    supabase
      .from("printify_size_charts")
      .select("*")
      .eq("blueprint_id", blueprintId)
      .eq("status", "extracted")
      .maybeSingle(),
    new Promise<null>((resolve) => globalThis.setTimeout(() => resolve(null), 7000)),
  ]);

  if (!result) return null;

  const { data, error } = result;

  if (error) {
    console.error("Failed to load size chart", error);
    return null;
  }

  if (!data) {
    return null;
  }

  return normalizeSizeChart(data as PrintifySizeChartRecord);
}

async function getSizeChartByBlueprintIdFromApi(
  blueprintId: number
): Promise<NormalizedSizeChart | null> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 7000);

  try {
    const response = await fetch(
      `${API_BASE}/api/storefront/size-chart/${encodeURIComponent(String(blueprintId))}`,
      { headers: { Accept: "application/json" }, signal: controller.signal }
    );
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.chart ?? null;
  } catch (error) {
    console.warn("Failed to load size chart through API fallback", error);
    return null;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
