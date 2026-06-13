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
import {
  PLATFORM_CATALOG_CATEGORIES,
} from "@shared/platformCatalogCategories";
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
  onConfirm,
  isPending,
}: Props) {
  if (!kind) return null;

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
              <p className="text-xs text-muted-foreground">
                Used to group this product in merchant import filters.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isPending}>
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
