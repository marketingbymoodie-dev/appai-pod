import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { PLATFORM_CATALOG_CATEGORIES } from "@shared/platformCatalogCategories";
import {
  FULFILLMENT_LAYOUT_LABELS,
  STOREFRONT_MOCKUP_MODE_LABELS,
  type FulfillmentLayout,
  type StorefrontMockupMode,
} from "@shared/productLayoutPolicy";
import { Loader2 } from "lucide-react";

type CatalogKind = "flat" | "aop" | "printify" | "blocked";

const KIND_LABELS: Record<CatalogKind, string> = {
  printify: "API (instant merchant import)",
  flat: "Flat (calibrator queue)",
  aop: "AOP (panel map queue)",
  blocked: "Block (deny import)",
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productTitle: string;
  kind: CatalogKind | null;
  category: string;
  onCategoryChange: (value: string) => void;
  storefrontMockupMode: StorefrontMockupMode;
  onStorefrontMockupModeChange: (value: StorefrontMockupMode) => void;
  fulfillmentLayout: FulfillmentLayout;
  onFulfillmentLayoutChange: (value: FulfillmentLayout) => void;
  forceFlatHarvest: boolean;
  onForceFlatHarvestChange: (value: boolean) => void;
  onConfirm: () => void;
  isPending?: boolean;
};

export default function TagProductDialog({
  open,
  onOpenChange,
  productTitle,
  kind,
  category,
  onCategoryChange,
  storefrontMockupMode,
  onStorefrontMockupModeChange,
  fulfillmentLayout,
  onFulfillmentLayoutChange,
  forceFlatHarvest,
  onForceFlatHarvestChange,
  onConfirm,
  isPending,
}: Props) {
  if (!kind) return null;

  const aopName = /\(aop\)/i.test(productTitle);
  const blockFlatWithoutOverride =
    kind === "flat" &&
    aopName &&
    !forceFlatHarvest &&
    fulfillmentLayout !== "tote_folded_v1";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tag product</DialogTitle>
          <DialogDescription className="line-clamp-2">{productTitle}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label className="text-xs text-muted-foreground">Tag type</Label>
            <p className="mt-1 text-sm font-medium">{KIND_LABELS[kind]}</p>
          </div>

          {kind !== "blocked" && (
            <div className="space-y-2">
              <Label htmlFor="tag-category">Merchant catalog category</Label>
              <Select value={category} onValueChange={onCategoryChange}>
                <SelectTrigger id="tag-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORM_CATALOG_CATEGORIES.map((cat) => (
                    <SelectItem key={cat.value} value={cat.value}>
                      {cat.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {(kind === "flat" || kind === "aop") && (
            <>
              <div className="space-y-2">
                <Label>Storefront mockups</Label>
                <Select
                  value={storefrontMockupMode}
                  onValueChange={(v) => onStorefrontMockupModeChange(v as StorefrontMockupMode)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(STOREFRONT_MOCKUP_MODE_LABELS) as StorefrontMockupMode[]).map((k) => (
                      <SelectItem key={k} value={k}>
                        {STOREFRONT_MOCKUP_MODE_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Fulfillment print file</Label>
                <Select
                  value={fulfillmentLayout}
                  onValueChange={(v) => onFulfillmentLayoutChange(v as FulfillmentLayout)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(FULFILLMENT_LAYOUT_LABELS) as FulfillmentLayout[]).map((k) => (
                      <SelectItem key={k} value={k}>
                        {FULFILLMENT_LAYOUT_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {kind === "flat" && aopName && (
            <div className="flex items-start gap-2 rounded-md border p-3">
              <Checkbox
                id="force-flat-harvest"
                checked={forceFlatHarvest}
                onCheckedChange={(v) => onForceFlatHarvestChange(!!v)}
              />
              <div className="space-y-1">
                <Label htmlFor="force-flat-harvest" className="cursor-pointer text-sm font-medium">
                  Force flat despite (AOP) name
                </Label>
                <p className="text-xs text-muted-foreground">
                  Adjustable tote pattern: flat front/back mockups in the editor, folded print file at
                  order time.
                </p>
              </div>
            </div>
          )}

          {blockFlatWithoutOverride && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              Enable “Force flat despite (AOP) name”, or set fulfillment to tote_folded_v1.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isPending || blockFlatWithoutOverride}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              `Confirm tag`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
