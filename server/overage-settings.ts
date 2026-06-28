/**
 * Merchant overage opt-in settings — effective caps and bucket rollover.
 */
import {
  OVERAGE_PRICE_USD,
  PLAN_OVERAGE_CAPS,
  type GenerationQuotaConfig,
} from "./customizer-plans";
import type { ShopifyInstallation } from "@shared/schema";

export const OVERAGE_PRICE_CENTS = Math.round(OVERAGE_PRICE_USD * 100);

export type OverageInstallation = Pick<
  ShopifyInstallation,
  | "overageOptInEnabled"
  | "overageBudgetCents"
  | "overageRecurring"
  | "overageOptInBucketKey"
  | "overageOptInAt"
>;

/** Plan max overage spend in USD cents (e.g. Starter 200 × $0.08 = 1600). */
export function planMaxOverageBudgetCents(planName: string | null | undefined): number {
  if (!planName) return 0;
  const cap = PLAN_OVERAGE_CAPS[planName] ?? 0;
  return cap * OVERAGE_PRICE_CENTS;
}

/** Overage generation units from a USD-cent budget. */
export function budgetCentsToOverageUnits(budgetCents: number): number {
  if (budgetCents <= 0) return 0;
  return Math.floor(budgetCents / OVERAGE_PRICE_CENTS);
}

/**
 * Effective overage unit cap for this bucket (0 when not opted in).
 * Capped by plan max and merchant budget.
 */
export function resolveEffectiveOverageCap(
  installation: OverageInstallation,
  quota: GenerationQuotaConfig,
): number {
  if (quota.overageCap <= 0) return 0;
  if (!installation.overageOptInEnabled) return 0;
  if (installation.overageOptInBucketKey !== quota.bucketKey) return 0;

  const budgetCents = installation.overageBudgetCents ?? 0;
  const merchantUnits = budgetCentsToOverageUnits(budgetCents);
  if (merchantUnits <= 0) return 0;

  return Math.min(merchantUnits, quota.overageCap);
}

export function isOverageOptInActive(
  installation: OverageInstallation,
  bucketKey: string,
): boolean {
  return (
    !!installation.overageOptInEnabled &&
    installation.overageOptInBucketKey === bucketKey &&
    (installation.overageBudgetCents ?? 0) >= OVERAGE_PRICE_CENTS
  );
}

export function includedUsedFromCounters(used: number, overageUsed: number): number {
  return Math.max(0, used - overageUsed);
}

export function extraSpentCents(overageUsed: number): number {
  return overageUsed * OVERAGE_PRICE_CENTS;
}
