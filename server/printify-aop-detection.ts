interface DetectPrintifyAopParams {
  name?: string | null;
  description?: string | null;
  blueprintId?: number | null;
}

// Known blueprints that are AOP even when title text is inconsistent.
const KNOWN_AOP_BLUEPRINT_IDS = new Set<number>([
  256,  // Women's Cut & Sew Casual Leggings
  1050, // Women's Capri Leggings
]);

const AOP_NAME_MARKER_REGEX = /\(aop\)/i;
const AOP_PHRASE_REGEX = /\b(all[\s-]?over print|cut[\s-]?&?[\s-]?sew|sublimation)\b/i;
const AOP_CATEGORY_REGEX =
  /\b(leggings|rash guard|sports bra|swim trunks?|bikini|pencil skirt|basketball shorts?|camp shirt)\b/i;

/**
 * Determine if an imported Printify product should use AOP flows.
 * Multi-panel positions alone are intentionally ignored to avoid false positives
 * for non-AOP products that expose sleeve/neck-label placeholders.
 */
export function detectPrintifyAllOverPrint({
  name,
  description,
  blueprintId,
}: DetectPrintifyAopParams): boolean {
  const safeName = (name || "").trim();
  const combined = `${safeName} ${description || ""}`.toLowerCase();

  if (AOP_NAME_MARKER_REGEX.test(safeName)) {
    return true;
  }

  if (Number.isFinite(blueprintId) && KNOWN_AOP_BLUEPRINT_IDS.has(Number(blueprintId))) {
    return true;
  }

  if (AOP_PHRASE_REGEX.test(combined)) {
    return true;
  }

  if (AOP_CATEGORY_REGEX.test(combined) && /cut[\s-]?&?[\s-]?sew/i.test(combined)) {
    return true;
  }

  return false;
}

