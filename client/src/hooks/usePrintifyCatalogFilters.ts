import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  anyLocationMatchesRegion,
  type PrintifyShippingRegionId,
  PRINTIFY_SHIPPING_REGIONS,
} from "@shared/printifyShippingRegions";

export type PrintifyBlueprintListItem = {
  id: number;
  title: string;
  brand: string;
  description?: string;
  images?: string[];
};

export type BlueprintShippingMeta = {
  providerIds: number[];
  locations: string[];
  shipsFrom: string[];
  shipsTo: string[];
  primaryProviderTitle: string | null;
};

type BatchProvidersResponse = Record<string, BlueprintShippingMeta>;

type UsePrintifyCatalogFiltersOptions = {
  enabled?: boolean;
  requireSearch?: boolean;
  maxResults?: number;
  extraFilter?: (bp: PrintifyBlueprintListItem) => boolean;
  /** Max blueprints to load shipping meta for (batch-providers). */
  shippingMetaLimit?: number;
};

async function fetchBatchShippingMeta(blueprintIds: number[]): Promise<Record<number, BlueprintShippingMeta>> {
  if (blueprintIds.length === 0) return {};
  const res = await fetch("/api/admin/printify/blueprints/batch-providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ blueprintIds }),
  });
  if (!res.ok) throw new Error("Failed to load shipping data");
  const data = (await res.json()) as BatchProvidersResponse;
  const out: Record<number, BlueprintShippingMeta> = {};
  for (const [id, meta] of Object.entries(data)) {
    out[Number(id)] = meta;
  }
  return out;
}

export function usePrintifyCatalogFilters(options: UsePrintifyCatalogFiltersOptions = {}) {
  const {
    enabled = true,
    requireSearch = false,
    maxResults = 100,
    extraFilter,
    shippingMetaLimit = 200,
  } = options;

  const [search, setSearch] = useState("");
  const [locationFilter, setLocationFilter] = useState<PrintifyShippingRegionId>("all");
  const [shippingMeta, setShippingMeta] = useState<Record<number, BlueprintShippingMeta>>({});
  const [shippingMetaLoading, setShippingMetaLoading] = useState(false);

  const {
    data: blueprints,
    isLoading,
    isFetching,
    refetch,
    error,
  } = useQuery<PrintifyBlueprintListItem[]>({
    queryKey: ["/api/admin/printify/blueprints", "all"],
    queryFn: async () => {
      const res = await fetch("/api/admin/printify/blueprints", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch Printify catalog");
      return res.json();
    },
    enabled,
    staleTime: 10 * 60 * 1000,
  });

  const searchFiltered = useMemo(() => {
    if (!blueprints) return [];
    const q = search.trim().toLowerCase();
    if (requireSearch && !q) return [];

    const idMatch = q.match(/^(?:id\s*:\s*)?(\d+)$/i);
    if (idMatch) {
      return blueprints.filter((bp) => bp.id.toString() === idMatch[1]);
    }

    if (!q) return blueprints;

    return blueprints.filter(
      (bp) =>
        bp.title.toLowerCase().includes(q) ||
        bp.brand.toLowerCase().includes(q) ||
        String(bp.id).includes(q) ||
        (bp.description?.toLowerCase().includes(q) ?? false),
    );
  }, [blueprints, search, requireSearch]);

  const preLocationFiltered = useMemo(() => {
    if (!extraFilter) return searchFiltered;
    return searchFiltered.filter(extraFilter);
  }, [searchFiltered, extraFilter]);

  const idsNeedingMeta = useMemo(() => {
    return preLocationFiltered
      .slice(0, shippingMetaLimit)
      .filter((bp) => !shippingMeta[bp.id])
      .map((bp) => bp.id);
  }, [preLocationFiltered, shippingMeta, shippingMetaLimit]);

  const loadShippingMeta = useCallback(async (ids: number[]) => {
    if (ids.length === 0) return;
    setShippingMetaLoading(true);
    try {
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const batch = await fetchBatchShippingMeta(chunk);
        setShippingMeta((prev) => ({ ...prev, ...batch }));
      }
    } catch (e) {
      console.error("[catalog] shipping meta fetch failed:", e);
    } finally {
      setShippingMetaLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || idsNeedingMeta.length === 0) return;
    loadShippingMeta(idsNeedingMeta);
  }, [enabled, idsNeedingMeta, loadShippingMeta]);

  const locationFiltered = useMemo(() => {
    if (locationFilter === "all") return preLocationFiltered;
    return preLocationFiltered.filter((bp) => {
      const meta = shippingMeta[bp.id];
      if (!meta) return false;
      const check = [...meta.shipsFrom, ...meta.locations];
      return anyLocationMatchesRegion(check, locationFilter);
    });
  }, [preLocationFiltered, locationFilter, shippingMeta]);

  const visible = useMemo(
    () => locationFiltered.slice(0, maxResults),
    [locationFiltered, maxResults],
  );

  const getShippingMeta = useCallback(
    (blueprintId: number) => shippingMeta[blueprintId] ?? null,
    [shippingMeta],
  );

  return {
    search,
    setSearch,
    locationFilter,
    setLocationFilter,
    shippingRegions: PRINTIFY_SHIPPING_REGIONS,
    shippingMeta,
    shippingMetaLoading,
    getShippingMeta,
    loadShippingMeta,
    blueprints,
    filtered: locationFiltered,
    visible,
    totalMatching: locationFiltered.length,
    isLoading,
    isFetching,
    refetch,
    error,
  };
}
