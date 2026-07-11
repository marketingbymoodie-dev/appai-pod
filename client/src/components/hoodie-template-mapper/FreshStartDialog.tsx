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
  defaultPlacerEditorForBlueprint,
  defaultPrintFileLayoutForBlueprint,
  isValidAopTemplateSlug,
  normalizeAopTemplateSlugInput,
  PULOVER_HOODIE_BLUEPRINT_ID,
  PILLOW_WRAP_BLUEPRINT_ID,
  FAUX_SUEDE_PILLOW_WRAP_BLUEPRINT_ID,
  BODY_PILLOW_WRAP_BLUEPRINT_ID,
  ZIP_HOODIE_BLUEPRINT_ID,
  type PlacerEditor,
  type PrintFileLayout,
  type GarmentLayout,
} from "@shared/hoodieTemplate";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
  const [placerEditor, setPlacerEditor] = useState<PlacerEditor>("hoodie");
  const [garmentLayout, setGarmentLayout] = useState<GarmentLayout>("hoodie");
  const [printFileLayout, setPrintFileLayout] = useState<PrintFileLayout>("split-front-back");
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

  useEffect(() => {
    if (bpInvalid) return;
    const nextPlacer = defaultPlacerEditorForBlueprint(bpNum);
    setPlacerEditor(nextPlacer);
    setPrintFileLayout(defaultPrintFileLayoutForBlueprint(bpNum));
    if (nextPlacer === "front-back-face") {
      setGarmentLayout("hoodie");
    }
  }, [bpNum, bpInvalid]);

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
        placerEditor,
        printFileLayout,
        garmentLayout: placerEditor === "front-back-face" ? undefined : garmentLayout,
      }),
    );
    onOpenChange(false);
    setSlug("");
    setLabel("");
    setBlueprintId(String(PULOVER_HOODIE_BLUEPRINT_ID));
    setPlacerEditor("hoodie");
    setGarmentLayout("hoodie");
    setPrintFileLayout("split-front-back");
    setProductTypeId("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90dvh,calc(100vh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="shrink-0 space-y-1.5 px-6 pt-6">
          <DialogTitle>Fresh start — new AOP template</DialogTitle>
          <DialogDescription>
            Creates a blank in-memory template with a <strong>new slug</strong>. Nothing is written to disk until
            you Save. Slugs that already exist on the server are blocked so you cannot accidentally overwrite them.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-2">
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

          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Storefront editor</Label>
              <ToggleGroup
                type="single"
                value={placerEditor}
                onValueChange={(v) => {
                  if (v === "hoodie" || v === "front-back-face") {
                    setPlacerEditor(v);
                    if (v === "front-back-face") setGarmentLayout("hoodie");
                  }
                }}
                className="grid w-full grid-cols-2 gap-1"
              >
                <ToggleGroupItem value="hoodie" className="h-8 text-xs">
                  Hoodie
                </ToggleGroupItem>
                <ToggleGroupItem value="front-back-face" className="h-8 text-xs">
                  Front / Back
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
            {placerEditor === "hoodie" && (
              <div className="space-y-2">
                <Label>Garment preset</Label>
                <ToggleGroup
                  type="single"
                  value={garmentLayout}
                  onValueChange={(v) => {
                    if (v === "hoodie" || v === "jumper-no-hood") setGarmentLayout(v);
                  }}
                  className="grid w-full grid-cols-2 gap-1"
                >
                  <ToggleGroupItem value="hoodie" className="h-8 text-xs">
                    Hoodie
                  </ToggleGroupItem>
                  <ToggleGroupItem value="jumper-no-hood" className="h-8 text-xs">
                    Jumper (no hood)
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            )}
            <div className="space-y-2">
              <Label>Print file layout</Label>
              <ToggleGroup
                type="single"
                value={printFileLayout}
                onValueChange={(v) => {
                  if (v === "wrap-single" || v === "split-front-back") setPrintFileLayout(v);
                }}
                className="grid w-full grid-cols-2 gap-1"
              >
                <ToggleGroupItem value="wrap-single" className="h-8 text-xs">
                  Wrap
                </ToggleGroupItem>
                <ToggleGroupItem value="split-front-back" className="h-8 text-xs">
                  Split
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
            <p className="text-xs text-muted-foreground">
              Auto-suggested from blueprint id — adjust before mapping if Printify uses a different layout.
            </p>
          </div>
        </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
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
