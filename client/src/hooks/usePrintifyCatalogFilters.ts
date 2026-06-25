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
  /** Max blueprints to load shipping meta for when no shipping filter is active (badges only). */
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

function blueprintMatchesShippingFilters(
  meta: BlueprintShippingMeta | undefined,
  shipsFromFilter: PrintifyShippingRegionId,
  shipsToFilter: PrintifyShippingRegionId,
  requireMeta: boolean,
): boolean {
  if (shipsFromFilter === "all" && shipsToFilter === "all") return true;
  if (!meta) return !requireMeta;
  if (shipsFromFilter !== "all" && !anyLocationMatchesRegion(meta.shipsFrom, shipsFromFilter)) {
    return false;
  }
  if (shipsToFilter !== "all" && !anyLocationMatchesRegion(meta.shipsTo, shipsToFilter)) {
    return false;
  }
  return true;
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
  const [shipsFromFilter, setShipsFromFilter] = useState<PrintifyShippingRegionId>("all");
  const [shipsToFilter, setShipsToFilter] = useState<PrintifyShippingRegionId>("all");
  const [shippingMeta, setShippingMeta] = useState<Record<number, BlueprintShippingMeta>>({});
  const [shippingMetaLoading, setShippingMetaLoading] = useState(false);

  const shippingFilterActive = shipsFromFilter !== "all" || shipsToFilter !== "all";

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

  const preShippingFiltered = useMemo(() => {
    if (!extraFilter) return searchFiltered;
    return searchFiltered.filter(extraFilter);
  }, [searchFiltered, extraFilter]);

  const idsNeedingMeta = useMemo(() => {
    const pool = shippingFilterActive
      ? preShippingFiltered
      : preShippingFiltered.slice(0, shippingMetaLimit);
    return pool.filter((bp) => !shippingMeta[bp.id]).map((bp) => bp.id);
  }, [preShippingFiltered, shippingMeta, shippingMetaLimit, shippingFilterActive]);

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

  const shippingFiltered = useMemo(() => {
    if (!shippingFilterActive) return preShippingFiltered;
    return preShippingFiltered.filter((bp) =>
      blueprintMatchesShippingFilters(
        shippingMeta[bp.id],
        shipsFromFilter,
        shipsToFilter,
        true,
      ),
    );
  }, [preShippingFiltered, shippingFilterActive, shippingMeta, shipsFromFilter, shipsToFilter]);

  const visible = useMemo(
    () => shippingFiltered.slice(0, maxResults),
    [shippingFiltered, maxResults],
  );

  const getShippingMeta = useCallback(
    (blueprintId: number) => shippingMeta[blueprintId] ?? null,
    [shippingMeta],
  );

  return {
    search,
    setSearch,
    shipsFromFilter,
    setShipsFromFilter,
    shipsToFilter,
    setShipsToFilter,
    /** @deprecated use shipsFromFilter */
    locationFilter: shipsFromFilter,
    /** @deprecated use setShipsFromFilter */
    setLocationFilter: setShipsFromFilter,
    shippingRegions: PRINTIFY_SHIPPING_REGIONS,
    shippingFilterActive,
    shippingMeta,
    shippingMetaLoading,
    getShippingMeta,
    loadShippingMeta,
    blueprints,
    filtered: shippingFiltered,
    visible,
    totalMatching: shippingFiltered.length,
    isLoading,
    isFetching,
    refetch,
    error,
  };
}
