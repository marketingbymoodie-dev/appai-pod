/**
 * Per–customizer-page art style selection.
 * Merchants attach explicit presets or allow all styles in a category.
 */

export type CustomizerPageStyleCategory = "decor" | "apparel" | "all";

export type CustomizerPageStyleConfig =
  | { mode: "category"; category: CustomizerPageStyleCategory }
  | { mode: "selected"; presetIds: string[] };

export function parseCustomizerPageStyleConfig(
  raw: unknown,
): CustomizerPageStyleConfig | null {
  if (!raw) return null;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.mode === "category" && typeof o.category === "string") {
    if (o.category === "decor" || o.category === "apparel" || o.category === "all") {
      return { mode: "category", category: o.category };
    }
  }
  if (o.mode === "selected" && Array.isArray(o.presetIds)) {
    const ids = o.presetIds.map(String).filter(Boolean);
    if (ids.length > 0) return { mode: "selected", presetIds: [...new Set(ids)] };
  }
  return null;
}

export function validateCustomizerPageStyleConfig(
  config: CustomizerPageStyleConfig | null | undefined,
): string | null {
  if (!config) {
    return "Choose one or more art styles, or select all styles in a category (Decor, Apparel, or All).";
  }
  if (config.mode === "selected" && config.presetIds.length === 0) {
    return "Select at least one art style.";
  }
  return null;
}

export function defaultStyleConfigForDesignerType(
  designerType?: string | null,
): CustomizerPageStyleConfig {
  const dt = (designerType || "").toLowerCase();
  if (dt === "apparel" || dt === "all-over-print") {
    return { mode: "category", category: "apparel" };
  }
  if (dt === "pillow" || dt === "framed-print" || dt === "mug") {
    return { mode: "category", category: "decor" };
  }
  return { mode: "category", category: "all" };
}

export function suggestedStyleCategoryForDesignerType(
  designerType?: string | null,
): CustomizerPageStyleCategory {
  const def = defaultStyleConfigForDesignerType(designerType);
  return def.mode === "category" ? def.category : "all";
}

export function dedupeStylePresets<T extends { id: string; name?: string }>(
  presets: T[],
): T[] {
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  return presets.filter((p) => {
    const idKey = String(p.id);
    const nameKey = (p.name || idKey).trim().toLowerCase();
    if (seenIds.has(idKey) || seenNames.has(nameKey)) return false;
    seenIds.add(idKey);
    seenNames.add(nameKey);
    return true;
  });
}

export function filterStylePresetsForPage<T extends { id: string; category?: string | null }>(
  presets: T[],
  config: CustomizerPageStyleConfig | null | undefined,
  designerType?: string | null,
): T[] {
  const deduped = dedupeStylePresets(presets);
  const cfg = config ?? defaultStyleConfigForDesignerType(designerType);
  if (cfg.mode === "selected") {
    const idSet = new Set(cfg.presetIds.map(String));
    return deduped.filter((p) => idSet.has(String(p.id)));
  }
  if (cfg.category === "all") return deduped;
  return deduped.filter(
    (p) => p.category === cfg.category || p.category === "all" || !p.category,
  );
}

/** Strip decor full-bleed language when generating isolated AOP motifs. */
export function sanitizeStylePrefixForAop(prefix: string): string {
  let cleaned = prefix.trim();
  cleaned = cleaned.replace(/\bfull-bleed\b/gi, "centered");
  cleaned = cleaned.replace(/\bfills?\s+the\s+entire\s+canvas\b/gi, "centers the subject on");
  cleaned = cleaned.replace(/\b(reaching|extending)\s+to\s+all\s+edges\b/gi, "with clear space around the subject");
  cleaned = cleaned.replace(/\bedge-to-edge\b/gi, "centered");
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  if (cleaned && !/isolated|centered|motif/i.test(cleaned)) {
    cleaned = `${cleaned}, isolated centered motif`;
  }
  return cleaned;
}
