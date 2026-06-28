/**
 * Plan change classification and upgrade/downgrade preview copy.
 */
import {
  PAID_PLANS,
  PLAN_DISPLAY_NAMES,
  PLAN_GENERATION_QUOTAS,
  PLAN_PAGE_LIMITS,
  PLAN_PRICES_USD,
  generationMonthKey,
} from "./customizer-plans";
import { planMaxOverageBudgetCents, OVERAGE_PRICE_CENTS } from "./overage-settings";

export type PlanChangeKind =
  | "trial_to_paid"
  | "paid_upgrade"
  | "paid_downgrade"
  | "same_tier"
  | "to_trial"
  | "unknown";

/** Trial = 0; paid plans ordered by PAID_PLANS index + 1. */
export function planTierRank(planName: string | null | undefined): number {
  if (!planName || planName === "trial") return 0;
  const idx = (PAID_PLANS as readonly string[]).indexOf(planName);
  return idx >= 0 ? idx + 1 : 0;
}

export function comparePlanTier(
  from: string | null | undefined,
  to: string | null | undefined,
): number {
  return planTierRank(to) - planTierRank(from);
}

export function classifyPlanChange(
  fromPlan: string | null | undefined,
  toPlan: string | null | undefined,
): PlanChangeKind {
  const from = fromPlan ?? "trial";
  const to = toPlan ?? "trial";

  if (to === "trial") return from === "trial" ? "same_tier" : "to_trial";

  const fromIsPaid = (PAID_PLANS as readonly string[]).includes(from);
  const toIsPaid = (PAID_PLANS as readonly string[]).includes(to);
  if (!toIsPaid) return "unknown";

  if (!fromIsPaid && from === "trial") return "trial_to_paid";
  if (!fromIsPaid) return "trial_to_paid";

  const cmp = comparePlanTier(from, to);
  if (cmp > 0) return "paid_upgrade";
  if (cmp < 0) return "paid_downgrade";
  return "same_tier";
}

export function isPaidPlan(planName: string | null | undefined): boolean {
  return !!planName && (PAID_PLANS as readonly string[]).includes(planName);
}

/**
 * Included usage that carries into a new paid plan this billing period.
 * Trial usage never carries over.
 */
export function resolveCarryoverIncludedUsed(params: {
  fromPlan: string | null | undefined;
  toPlan: string | null | undefined;
  includedUsed: number;
}): number {
  const kind = classifyPlanChange(params.fromPlan, params.toPlan);
  if (kind === "trial_to_paid") return 0;
  if (kind === "paid_upgrade") return Math.max(0, params.includedUsed);
  return 0;
}

export function buildUpgradePreview(params: {
  currentPlan: string;
  newPlan: string;
  carryoverIncludedUsed: number;
  newFreeQuota: number;
  newPriceUsd: number;
}) {
  const { currentPlan, newPlan, carryoverIncludedUsed, newFreeQuota, newPriceUsd } = params;
  const kind = classifyPlanChange(currentPlan, newPlan);
  const newIncludedRemaining = Math.max(0, newFreeQuota - carryoverIncludedUsed);
  const newPageLimit = PLAN_PAGE_LIMITS[newPlan] ?? 0;

  let confirmationMessage: string;
  if (kind === "trial_to_paid") {
    confirmationMessage =
      `You will be charged $${newPriceUsd.toFixed(2)} USD/month for the ${PLAN_DISPLAY_NAMES[newPlan] ?? newPlan} plan on your next Shopify app bill. ` +
      `Your included allowance becomes ${newFreeQuota} generations per month (${newIncludedRemaining} available this period). ` +
      `Trial generations do not count toward your paid plan allowance. All amounts in USD.`;
  } else {
    confirmationMessage =
      `You will be charged $${newPriceUsd.toFixed(2)} USD/month for the ${PLAN_DISPLAY_NAMES[newPlan] ?? newPlan} plan on your next Shopify app bill. ` +
      `Your included allowance becomes ${newFreeQuota} generations per month with ${newIncludedRemaining} remaining this period` +
      (carryoverIncludedUsed > 0
        ? ` (${carryoverIncludedUsed} already used from your previous plan's included quota this period).`
        : ".") +
      ` All amounts in USD.`;
  }

  return {
    changeKind: kind,
    isDowngrade: false,
    currentPlan,
    newPlan,
    newPriceUsd,
    currency: "USD" as const,
    includedConsumed: carryoverIncludedUsed,
    newIncludedAllowance: newFreeQuota,
    newIncludedRemaining,
    newPageLimit,
    confirmationMessage,
    planMaxOverageBudgetCents: planMaxOverageBudgetCents(newPlan),
    overagePriceCents: OVERAGE_PRICE_CENTS,
  };
}

export function buildDowngradePreview(params: {
  currentPlan: string;
  newPlan: string;
  effectiveAt: Date | null;
  currentPeriodEnd: Date | null;
}) {
  const { currentPlan, newPlan, effectiveAt, currentPeriodEnd } = params;
  const effective = effectiveAt ?? currentPeriodEnd;
  const effectiveLabel = effective
    ? effective.toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" })
    : "the start of your next billing period";

  const currentQuota = PLAN_GENERATION_QUOTAS[currentPlan] ?? 0;
  const newQuota = PLAN_GENERATION_QUOTAS[newPlan] ?? 0;
  const currentPages = PLAN_PAGE_LIMITS[currentPlan] ?? 0;
  const newPages = PLAN_PAGE_LIMITS[newPlan] ?? 0;
  const newPriceUsd = PLAN_PRICES_USD[newPlan] ?? 0;

  const confirmationMessage =
    `Your plan will change to ${PLAN_DISPLAY_NAMES[newPlan] ?? newPlan} ($${newPriceUsd.toFixed(2)} USD/month) on ${effectiveLabel}. ` +
    `Until then you keep your current ${PLAN_DISPLAY_NAMES[currentPlan] ?? currentPlan} benefits: ` +
    `${currentQuota} included generations per month and up to ${currentPages} active customizer page${currentPages === 1 ? "" : "s"}. ` +
    `After the change: ${newQuota} generations per month (no rollover from this period) and up to ${newPages} active page${newPages === 1 ? "" : "s"}. ` +
    `Oldest pages stay active if you exceed the new limit; you can swap which pages are live within your allowance. All amounts in USD.`;

  return {
    changeKind: "paid_downgrade" as const,
    isDowngrade: true,
    currentPlan,
    newPlan,
    newPriceUsd,
    currency: "USD" as const,
    effectiveAt: effective?.toISOString() ?? null,
    newIncludedAllowance: newQuota,
    newPageLimit: newPages,
    currentPageLimit: currentPages,
    confirmationMessage,
  };
}

/** Reset fields when trial → paid (fresh monthly bucket). */
export function trialToPaidMeteringReset(now: Date = new Date()) {
  return {
    generationMonth: generationMonthKey(now),
    monthlyGenerationsUsed: 0,
    monthlyOverageUsed: 0,
  };
}

/** Reset metering when a deferred downgrade takes effect (no gen rollover). */
export function downgradeMeteringReset(now: Date = new Date()) {
  return {
    generationMonth: generationMonthKey(now),
    monthlyGenerationsUsed: 0,
    monthlyOverageUsed: 0,
    overageOptInEnabled: false,
    overageBudgetCents: null,
    overageOptInAt: null,
    overageOptInBucketKey: null,
    quotaAlert90BucketKey: null,
    quotaAlert100BucketKey: null,
  };
}
