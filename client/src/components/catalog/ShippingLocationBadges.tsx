import { Globe, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatShippingBadgeLabel } from "@shared/printifyShippingRegions";
import type { BlueprintShippingMeta } from "@/hooks/usePrintifyCatalogFilters";

type Props = {
  meta?: BlueprintShippingMeta | null;
  compact?: boolean;
};

export default function ShippingLocationBadges({ meta, compact }: Props) {
  if (!meta) return null;

  const from = meta.shipsFrom.slice(0, compact ? 2 : 4);
  const to = meta.shipsTo.slice(0, compact ? 3 : 6);
  const toOverflow = meta.shipsTo.length - to.length;
  const limitedFulfillment =
    meta.shipsTo.length > 0 &&
    meta.shipsTo.length <= 3 &&
    !meta.shipsTo.some((c) => /global|worldwide|all/i.test(c));

  if (from.length === 0 && to.length === 0) return null;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-wrap items-center gap-1">
        {from.map((loc) => (
          <Tooltip key={`from-${loc}`}>
            <TooltipTrigger asChild>
              <Badge variant="secondary" className="gap-0.5 px-1.5 py-0 text-[10px] font-normal">
                <MapPin className="h-2.5 w-2.5" />
                {formatShippingBadgeLabel(loc)}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-xs">
              Print provider based in: {loc}
            </TooltipContent>
          </Tooltip>
        ))}
        {to.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="gap-0.5 px-1.5 py-0 text-[10px] font-normal">
                <Globe className="h-2.5 w-2.5" />
                {to.map(formatShippingBadgeLabel).join(", ")}
                {toOverflow > 0 ? ` +${toOverflow}` : ""}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-xs">
              Ships to: {meta.shipsTo.join(", ") || "See Printify for details"}
              {limitedFulfillment && (
                <span className="mt-1 block text-amber-600">
                  Limited fulfillment — check before selling globally.
                </span>
              )}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}
