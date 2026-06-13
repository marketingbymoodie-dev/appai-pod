/** Printify-style “Ships from” regions for catalog filtering. */
export type PrintifyShippingRegionId =
  | "all"
  | "usa"
  | "canada"
  | "uk"
  | "europe"
  | "australia-nz"
  | "china";

export type PrintifyShippingRegion = {
  id: PrintifyShippingRegionId;
  label: string;
};

export const PRINTIFY_SHIPPING_REGIONS: PrintifyShippingRegion[] = [
  { id: "all", label: "All locations" },
  { id: "usa", label: "USA" },
  { id: "canada", label: "Canada" },
  { id: "uk", label: "United Kingdom" },
  { id: "europe", label: "Europe" },
  { id: "australia-nz", label: "Australia/NZ" },
  { id: "china", label: "China" },
];

const EU_MARKERS = [
  "europe",
  "eu",
  "de",
  "germany",
  "fr",
  "france",
  "es",
  "spain",
  "it",
  "italy",
  "nl",
  "netherlands",
  "pl",
  "poland",
  "lv",
  "latvia",
  "lt",
  "lithuania",
  "ee",
  "estonia",
  "cz",
  "czech",
  "pt",
  "portugal",
  "be",
  "belgium",
  "at",
  "austria",
  "se",
  "sweden",
  "dk",
  "denmark",
  "fi",
  "finland",
  "ie",
  "ireland",
];

function norm(loc: string): string {
  return loc.trim().toLowerCase();
}

/** Whether a Printify location/country string matches a ships-from region. */
export function locationMatchesShippingRegion(
  location: string,
  regionId: PrintifyShippingRegionId,
): boolean {
  if (regionId === "all") return true;
  const l = norm(location);
  if (!l) return false;

  switch (regionId) {
    case "usa":
      return l === "us" || l === "usa" || l.includes("united states") || l.includes("u.s.");
    case "canada":
      return l === "ca" || l === "can" || l.includes("canada");
    case "uk":
      return l === "uk" || l === "gb" || l.includes("united kingdom") || l.includes("great britain");
    case "europe":
      return EU_MARKERS.some((m) => l === m || l.includes(m));
    case "australia-nz":
      return (
        l === "au" ||
        l === "nz" ||
        l.includes("australia") ||
        l.includes("new zealand")
      );
    case "china":
      return l === "cn" || l.includes("china");
    default:
      return false;
  }
}

export function anyLocationMatchesRegion(
  locations: string[],
  regionId: PrintifyShippingRegionId,
): boolean {
  if (regionId === "all") return true;
  return locations.some((loc) => locationMatchesShippingRegion(loc, regionId));
}

/** Short badge label for a country/region string. */
export function formatShippingBadgeLabel(location: string): string {
  const l = norm(location);
  if (l === "us" || l === "usa" || l.includes("united states")) return "US";
  if (l === "ca" || l.includes("canada")) return "CA";
  if (l === "uk" || l === "gb" || l.includes("united kingdom")) return "UK";
  if (l === "au" || l.includes("australia")) return "AU";
  if (l === "nz" || l.includes("new zealand")) return "NZ";
  if (l === "cn" || l.includes("china")) return "CN";
  if (l.length <= 4) return location.toUpperCase();
  return location.length > 12 ? `${location.slice(0, 10)}…` : location;
}
