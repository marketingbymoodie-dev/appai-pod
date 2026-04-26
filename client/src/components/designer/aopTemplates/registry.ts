import type { AopLayoutKind } from "./detectLayoutKind";

/**
 * Template ids only select **which layout rules** apply in `PatternCustomizer` (paired with DB config).
 * Improving leggings behavior = change `PatternCustomizer` (and related helpers); products already set to
 * `leggings_v1` pick up those code changes automatically — no second “template version” column required
 * unless you intentionally fork (e.g. `leggings_v2`).
 */

/** Known AOP template ids (DB `aop_template_id` / API `aopTemplateId`). */
export const AOP_TEMPLATE_IDS = ["leggings_v1", "hoodie_v1", "generic_aop_v1"] as const;
export type AopTemplateId = (typeof AOP_TEMPLATE_IDS)[number];

const TEMPLATE_TO_LAYOUT: Record<AopTemplateId, AopLayoutKind> = {
  leggings_v1: "leggings",
  hoodie_v1: "hoodie",
  generic_aop_v1: "generic",
};

/** Admin / docs: human labels for template select. */
export const AOP_TEMPLATE_ADMIN_OPTIONS: { value: string; label: string }[] = [
  { value: "__auto__", label: "Auto (infer from panel names)" },
  { value: "leggings_v1", label: "Leggings v1 (reference template)" },
  { value: "hoodie_v1", label: "Panel / zip hoodie v1" },
  { value: "generic_aop_v1", label: "Generic AOP (linear panels)" },
];

export const AOP_TEMPLATE_SELECT_AUTO = "__auto__";

/**
 * When set, forces layout behavior for PatternCustomizer regardless of placeholder name quirks
 * (e.g. another supplier’s blueprint with non-standard keys).
 *
 * `generic_aop_v1` does **not** override inference: the product is still a DB “generic AOP” row,
 * but `detectProductKind` (from Printify `position` strings) must choose hoodie vs leggings vs linear.
 * Previously mapping it to "generic" forced a 40px linear gap and ignored zip-hoodie layout fixes.
 */
export function resolveAopLayoutKind(
  templateId: string | null | undefined,
  inferred: AopLayoutKind,
): AopLayoutKind {
  if (!templateId) return inferred;
  if (templateId === "generic_aop_v1") return inferred;
  const mapped = TEMPLATE_TO_LAYOUT[templateId as AopTemplateId];
  return mapped ?? inferred;
}
