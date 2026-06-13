import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

export type PrintifyBlueprintListItem = {
  id: number;
  title: string;
  brand: string;
  description?: string;
  images?: string[];
};

type ProviderRow = {
  location?: { country?: string };
  fulfillment_countries?: string[];
};

type UsePrintifyCatalogFiltersOptions = {
  enabled?: boolean;
  /** When true, returns [] until the user types a search query. */
  requireSearch?: boolean;
  maxResults?: number;
  extraFilter?: (bp: PrintifyBlueprintListItem) => boolean;
};

export function usePrintifyCatalogFilters(options: UsePrintifyCatalogFiltersOptions = {}) {
  const {
    enabled = true,
    requireSearch = false,
    maxResults = 100,
    extraFilter,
  } = options;

  const [search, setSearch] = useState("");
  const [locationFilter, setLocationFilter] = useState("all");

  const { data: allProviders } = useQuery<ProviderRow[]>({
    queryKey: ["/api/admin/printify/providers"],
    queryFn: async () => {
      const res = await fetch("/api/admin/printify/providers", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch providers");
      return res.json();
    },
    enabled,
    staleTime: 5 * 60 * 1000,
  });

  const availableLocations = useMemo(() => {
    if (!allProviders) return [];
    const countries = new Set<string>();
    for (const p of allProviders) {
      if (p.location?.country) countries.add(p.location.country);
      p.fulfillment_countries?.forEach((c) => countries.add(c));
    }
    return Array.from(countries).sort((a, b) => a.localeCompare(b));
  }, [allProviders]);

  const {
    data: blueprints,
    isLoading,
    isFetching,
    refetch,
    error,
  } = useQuery<PrintifyBlueprintListItem[]>({
    queryKey: ["/api/admin/printify/blueprints", locationFilter],
    queryFn: async () => {
      const params =
        locationFilter && locationFilter !== "all"
          ? `?location=${encodeURIComponent(locationFilter)}`
          : "";
      const res = await fetch(`/api/admin/printify/blueprints${params}`, {
        credentials: "include",
      });
      if (res.status === 202) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body.message || "Provider location cache is still loading — try again in a moment.",
        );
      }
      if (!res.ok) throw new Error("Failed to fetch Printify catalog");
      return res.json();
    },
    enabled,
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

  const filtered = useMemo(() => {
    let list = searchFiltered;
    if (extraFilter) list = list.filter(extraFilter);
    return list;
  }, [searchFiltered, extraFilter]);

  const visible = useMemo(() => filtered.slice(0, maxResults), [filtered, maxResults]);

  return {
    search,
    setSearch,
    locationFilter,
    setLocationFilter,
    availableLocations,
    blueprints,
    filtered,
    visible,
    totalMatching: filtered.length,
    isLoading,
    isFetching,
    refetch,
    error,
  };
}
