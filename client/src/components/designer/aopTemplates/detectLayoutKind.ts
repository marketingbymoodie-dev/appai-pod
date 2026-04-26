/** Inferred AOP layout family from Printify placeholder position names. */
export type AopLayoutKind = "hoodie" | "leggings" | "generic";

/**
 * Infer hoodie vs leggings vs generic from panel `position` strings.
 * Used when `aopTemplateId` is unset (backward compatible).
 */
export function detectProductKind(panels: Array<{ position: string }>): AopLayoutKind {
  // Normalize: Printify / APIs sometimes use spaces, hyphens, or mixed case.
  const p = panels.map((x) => x.position.toLowerCase().replace(/[\s-]+/g, "_"));
  if (p.some((x) => x.includes("hood") || /^front_(left|right)/.test(x) || /^back_(left|right)/.test(x))) {
    return "hoodie";
  }
  if (p.some((x) => x.includes("_leg") || x.includes("_side") || x.includes("waistband"))) {
    return "leggings";
  }
  return "generic";
}
