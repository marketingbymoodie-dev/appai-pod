import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createFreshAopTemplate,
  isValidAopTemplateSlug,
  normalizeAopTemplateSlugInput,
  PULOVER_HOODIE_BLUEPRINT_ID,
  PILLOW_WRAP_BLUEPRINT_ID,
  FAUX_SUEDE_PILLOW_WRAP_BLUEPRINT_ID,
  BODY_PILLOW_WRAP_BLUEPRINT_ID,
  ZIP_HOODIE_BLUEPRINT_ID,
} from "@shared/hoodieTemplate";
import { resolvePublicTemplateName } from "@shared/aopTemplateNaming";
import { listTemplates } from "./api";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (template: ReturnType<typeof createFreshAopTemplate>) => void;
  onLoadExisting?: (slug: string) => void;
};

export default function FreshStartDialog({ open, onOpenChange, onConfirm, onLoadExisting }: Props) {
  const [slug, setSlug] = useState("");
  const [label, setLabel] = useState("");
  const [blueprintId, setBlueprintId] = useState(String(PULOVER_HOODIE_BLUEPRINT_ID));
  const [productTypeId, setProductTypeId] = useState("");
  const [existingSlugs, setExistingSlugs] = useState<Set<string>>(new Set());
  const [loadingSlugs, setLoadingSlugs] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoadingSlugs(true);
    listTemplates()
      .then((rows) => setExistingSlugs(new Set(rows.map((r) => r.name))))
      .catch(() => setExistingSlugs(new Set()))
      .finally(() => setLoadingSlugs(false));
  }, [open]);

  const normalizedSlug = slug.trim();
  const bpNum = Number(blueprintId);
  const slugTaken = normalizedSlug.length > 0 && existingSlugs.has(normalizedSlug);
  const slugInvalid = normalizedSlug.length > 0 && !isValidAopTemplateSlug(normalizedSlug);
  const bpInvalid = !Number.isFinite(bpNum) || bpNum <= 0;

  const canConfirm = useMemo(() => {
    if (!normalizedSlug || slugTaken || slugInvalid || bpInvalid || loadingSlugs) return false;
    return true;
  }, [normalizedSlug, slugTaken, slugInvalid, bpInvalid, loadingSlugs]);

  function handleConfirm() {
    if (!canConfirm) return;
    const ptIdRaw = productTypeId.trim();
    onConfirm(
      createFreshAopTemplate({
        name: normalizedSlug,
        label: label.trim() || normalizedSlug,
        blueprintId: bpNum,
        productTypeId: ptIdRaw === "" ? null : Number(ptIdRaw) || null,
      }),
    );
    onOpenChange(false);
    setSlug("");
    setLabel("");
    setBlueprintId(String(PULOVER_HOODIE_BLUEPRINT_ID));
    setProductTypeId("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Fresh start — new AOP template</DialogTitle>
          <DialogDescription>
            Creates a blank in-memory template with a <strong>new slug</strong>. Nothing is written to disk until
            you Save. Slugs that already exist on the server are blocked so you cannot accidentally overwrite them.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="fresh-slug">Slug (admin file name)</Label>
            <Input
              id="fresh-slug"
              value={slug}
              placeholder="e.g. sweatshirt-aop-L"
              onChange={(e) => setSlug(normalizeAopTemplateSlugInput(e.target.value))}
              data-testid="fresh-start-slug"
            />
            {slugTaken && (
              <div className="space-y-2">
                <p className="text-xs text-destructive">
                  Slug <span className="font-mono">{normalizedSlug}</span> is already saved — load it to edit, or
                  pick a different name.
                </p>
                {onLoadExisting && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-7 text-xs"
                    onClick={() => {
                      onLoadExisting(normalizedSlug);
                      onOpenChange(false);
                    }}
                    data-testid="fresh-start-load-existing"
                  >
                    Load {normalizedSlug}
                  </Button>
                )}
              </div>
            )}
            {slugInvalid && !slugTaken && (
              <p className="text-xs text-destructive">Use letters, numbers, dashes, underscores (max 64 chars).</p>
            )}
            {!slugTaken && normalizedSlug && (
              <>
                <p className="text-xs text-muted-foreground">
                  Mockup uploads will save as {normalizedSlug}-front.png and {normalizedSlug}-back.png
                </p>
                <p className="text-xs text-emerald-700 dark:text-emerald-400">
                  Storefront / catalog name after Save:{" "}
                  <span className="font-mono">{resolvePublicTemplateName(normalizedSlug)}</span>
                </p>
              </>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="fresh-label">Label (optional)</Label>
            <Input
              id="fresh-label"
              value={label}
              placeholder="Human-readable title"
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="fresh-blueprint">Printify blueprintId</Label>
              <Input
                id="fresh-blueprint"
                type="number"
                value={blueprintId}
                onChange={(e) => setBlueprintId(e.target.value)}
                data-testid="fresh-start-blueprint"
              />
              {bpInvalid && <p className="text-xs text-destructive">Required positive number.</p>}
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => setBlueprintId(String(PULOVER_HOODIE_BLUEPRINT_ID))}
                >
                  Pullover 450
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => setBlueprintId(String(ZIP_HOODIE_BLUEPRINT_ID))}
                >
                  Zip 451
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => setBlueprintId(String(PILLOW_WRAP_BLUEPRINT_ID))}
                >
                  Sq pillow 220
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => setBlueprintId(String(FAUX_SUEDE_PILLOW_WRAP_BLUEPRINT_ID))}
                >
                  Faux suede 223
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => setBlueprintId(String(BODY_PILLOW_WRAP_BLUEPRINT_ID))}
                >
                  Body 2758
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="fresh-pt-id">Product ID (optional)</Label>
              <Input
                id="fresh-pt-id"
                type="number"
                value={productTypeId}
                placeholder="After import"
                onChange={(e) => setProductTypeId(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm} data-testid="fresh-start-confirm">
            Start blank template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
