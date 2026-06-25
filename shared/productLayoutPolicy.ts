/**
 * Storefront mockup mode vs fulfillment layout — independently overridable.
 *
 * - storefrontMockupMode: what the customer sees in the editor (flat Printify mockups,
 *   on-the-fly flat placer, AOP pattern UI, etc.)
 * - fulfillmentLayout: how we build the print file for Printify orders
 */

import { TOTE_FOLDED_V1_TEMPLATE } from "./toteFoldedLayout";

export type StorefrontMockupMode = "auto" | "flat" | "aop" | "printify";
export type FulfillmentLayout = "auto" | "standard" | "flat" | "aop" | typeof TOTE_FOLDED_V1_TEMPLATE;

export const STOREFRONT_MOCKUP_MODE_LABELS: Record<StorefrontMockupMode, string> = {
  auto: "Auto (from AOP flag + catalog)",
  flat: "Flat lay (Printify front/back, same art)",
  aop: "AOP panel customizer",
  printify: "Printify mockups (legacy)",
};

export const FULFILLMENT_LAYOUT_LABELS: Record<FulfillmentLayout, string> = {
  auto: "Auto (from catalog / product name)",
  standard: "Standard (front/back placeholders)",
  flat: "Flat on-the-fly bake",
  aop: "AOP panel URLs",
  tote_folded_v1: "Folded tote (duplicate + 180° bottom panel)",
};

/** Printify blueprint: Adjustable Tote Bag (AOP). */
export const ADJUSTABLE_TOTE_BLUEPRINT_ID = 1300;

export type LayoutPolicySource = {
  isAllOverPrint?: boolean | null;
  storefrontMockupMode?: string | null;
  fulfillmentLayout?: string | null;
  printifyBlueprintId?: number | null;
  forceFlatHarvest?: boolean | null;
};

function normMode(raw: string | null | undefined): StorefrontMockupMode | null {
  if (!raw || raw === "auto") return null;
  if (raw === "flat" || raw === "aop" || raw === "printify") return raw;
  return null;
}

function normFulfillment(raw: string | null | undefined): FulfillmentLayout | null {
  if (!raw || raw === "auto") return null;
  if (
    raw === "standard" ||
    raw === "flat" ||
    raw === "aop" ||
    raw === TOTE_FOLDED_V1_TEMPLATE
  ) {
    return raw;
  }
  return null;
}

export function resolveStorefrontMockupMode(
  product: LayoutPolicySource,
  catalog?: LayoutPolicySource | null,
): StorefrontMockupMode {
  const explicit = normMode(product.storefrontMockupMode) ?? normMode(catalog?.storefrontMockupMode);
  if (explicit) return explicit;

  const fulfillment =
    resolveFulfillmentLayout(product, catalog);
  if (fulfillment === TOTE_FOLDED_V1_TEMPLATE) return "flat";

  if (product.isAllOverPrint || catalog?.isAllOverPrint) return "aop";
  return "printify";
}

export function resolveFulfillmentLayout(
  product: LayoutPolicySource,
  catalog?: LayoutPolicySource | null,
): FulfillmentLayout {
  const explicit =
    normFulfillment(product.fulfillmentLayout) ?? normFulfillment(catalog?.fulfillmentLayout);
  if (explicit) return explicit;

  const bp = product.printifyBlueprintId ?? catalog?.printifyBlueprintId;
  if (bp === ADJUSTABLE_TOTE_BLUEPRINT_ID) return TOTE_FOLDED_V1_TEMPLATE;

  if (product.isAllOverPrint || catalog?.isAllOverPrint) return "aop";
  return "standard";
}

/** PatternCustomizer / HoodieAopPlacer vs flat Printify mockups. */
export function usesAopStorefrontCustomizer(
  product: LayoutPolicySource,
  catalog?: LayoutPolicySource | null,
): boolean {
  const mode = resolveStorefrontMockupMode(product, catalog);
  if (mode === "aop") return true;
  if (mode === "flat" || mode === "printify") return false;
  return !!product.isAllOverPrint;
}

export function usesToteFoldedFulfillment(
  product: LayoutPolicySource,
  catalog?: LayoutPolicySource | null,
): boolean {
  return resolveFulfillmentLayout(product, catalog) === TOTE_FOLDED_V1_TEMPLATE;
}

/** Tote folded products always print both faces from one panel design. */
export function resolveToteFoldedDoubleSided(
  product: LayoutPolicySource,
  catalog?: LayoutPolicySource | null,
): boolean {
  if (usesToteFoldedFulfillment(product, catalog)) return true;
  return false;
}

export function shouldAllowFlatHarvest(args: {
  name: string;
  blueprintId: number;
  forceFlatHarvest?: boolean | null;
  isAllOverPrint?: boolean | null;
  fulfillmentLayout?: string | null;
}): boolean {
  if (args.forceFlatHarvest) return true;
  if (normFulfillment(args.fulfillmentLayout) === TOTE_FOLDED_V1_TEMPLATE) return true;
  if (args.blueprintId === ADJUSTABLE_TOTE_BLUEPRINT_ID) return true;
  if (!args.isAllOverPrint) return true;
  return false;
}

/** Skip curved/wrap probe rejection — operator tagged flat despite AOP name or tote_folded layout. */
export function shouldForceFlatTierDespiteProbe(source: LayoutPolicySource): boolean {
  if (source.forceFlatHarvest) return true;
  return usesToteFoldedFulfillment(source);
}

export function shouldBlockFlatCatalogTag(args: {
  name: string;
  blueprintId: number;
  forceFlatHarvest?: boolean | null;
}): boolean {
  if (args.forceFlatHarvest) return false;
  return /\(aop\)/i.test(args.name.trim());
}
