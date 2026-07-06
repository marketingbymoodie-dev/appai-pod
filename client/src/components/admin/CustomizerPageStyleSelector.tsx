import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  type CustomizerPageStyleConfig,
  type CustomizerPageStyleCategory,
  suggestedStyleCategoryForDesignerType,
} from "@shared/customizerPageStyles";

export type AdminStyleOption = {
  id: string | number;
  name: string;
  category?: string | null;
};

type Props = {
  designerType?: string | null;
  availableStyles: AdminStyleOption[];
  value: CustomizerPageStyleConfig | null;
  onChange: (value: CustomizerPageStyleConfig) => void;
  disabled?: boolean;
};

const CATEGORY_LABELS: Record<CustomizerPageStyleCategory, string> = {
  decor: "All Decor styles",
  apparel: "All Apparel styles",
  all: "All styles",
};

export default function CustomizerPageStyleSelector({
  designerType,
  availableStyles,
  value,
  onChange,
  disabled,
}: Props) {
  const suggested = suggestedStyleCategoryForDesignerType(designerType);
  const mode = value?.mode ?? "category";
  const category =
    value?.mode === "category" ? value.category : suggested;
  const selectedIds =
    value?.mode === "selected" ? new Set(value.presetIds.map(String)) : new Set<string>();

  const stylesForProduct = availableStyles.filter((s) => {
    if (suggested === "all") return true;
    return s.category === suggested || s.category === "all" || !s.category;
  });

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
      <div>
        <Label className="text-sm font-semibold">Art styles on this page</Label>
        <p className="mt-1 text-xs text-muted-foreground">
          Customers only see the styles you allow here. A page cannot go live without at least one style or a category bundle.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ mode: "category", category: suggested })}
          className={`rounded-md border px-3 py-2 text-left text-sm transition ${
            mode === "category" && category === suggested
              ? "border-primary bg-primary/10 font-semibold"
              : "border-border hover:bg-muted/50"
          }`}
        >
          {CATEGORY_LABELS[suggested]}
          <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
            Recommended for this product type
          </span>
        </button>
        {(["decor", "apparel", "all"] as const)
          .filter((c) => c !== suggested)
          .map((c) => (
            <button
              key={c}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ mode: "category", category: c })}
              className={`rounded-md border px-3 py-2 text-left text-sm transition ${
                mode === "category" && category === c
                  ? "border-primary bg-primary/10 font-semibold"
                  : "border-border hover:bg-muted/50"
              }`}
            >
              {CATEGORY_LABELS[c]}
            </button>
          ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            onChange({
              mode: "selected",
              presetIds: selectedIds.size > 0 ? [...selectedIds] : [],
            })
          }
          className={`rounded-md border px-3 py-2 text-left text-sm transition sm:col-span-2 ${
            mode === "selected"
              ? "border-primary bg-primary/10 font-semibold"
              : "border-border hover:bg-muted/50"
          }`}
        >
          Choose specific styles
        </button>
      </div>

      {mode === "selected" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Select one or more styles ({selectedIds.size} selected)
          </p>
          <div className="max-h-44 overflow-y-auto rounded border bg-background p-2 space-y-1">
            {stylesForProduct.length === 0 ? (
              <p className="text-xs text-muted-foreground p-2">
                No styles found — seed art styles in Settings first.
              </p>
            ) : (
              stylesForProduct.map((s) => {
                const id = String(s.id);
                const checked = selectedIds.has(id);
                return (
                  <label
                    key={id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/60"
                  >
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={checked}
                      onChange={() => {
                        const next = new Set(selectedIds);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        onChange({ mode: "selected", presetIds: [...next] });
                      }}
                    />
                    <span className="text-sm flex-1">{s.name}</span>
                    {s.category ? (
                      <Badge variant="outline" className="text-[10px] capitalize">
                        {s.category}
                      </Badge>
                    ) : null}
                  </label>
                );
              })
            )}
          </div>
          {selectedIds.size === 0 && (
            <p className="text-xs text-destructive">Pick at least one style to publish this page.</p>
          )}
        </div>
      )}
    </div>
  );
}
