/**
 * Customizer Page Plan Limits
 *
 * Maps plan name → max customizer pages allowed.
 * The plan state lives on shopifyInstallations.planName / planStatus.
 *
 * Future: add per-plan generation quota limits here as well.
 */

export const PLAN_PAGE_LIMITS: Record<string, number> = {
  trial:    1,
  starter:  1,
  dabbler:  5,
  pro:      15,
  pro_plus: 30,
};

/** Monthly price in USD (shown in plan picker UI). */
export const PLAN_PRICES_USD: Record<string, number> = {
  starter:  29,
  dabbler:  49,
  pro:      99,
  pro_plus: 199,
};

export const PLAN_DISPLAY_NAMES: Record<string, string> = {
  trial:    "Trial",
  starter:  "Starter",
  dabbler:  "Dabbler",
  pro:      "Pro",
  pro_plus: "Pro Plus",
};

export const PAID_PLANS = ["starter", "dabbler", "pro", "pro_plus"] as const;
export type PaidPlan = typeof PAID_PLANS[number];

export function getPageLimit(planName: string | null | undefined): number {
  if (!planName) return 0;
  return PLAN_PAGE_LIMITS[planName] ?? 0;
}

/**
 * Derive the effective plan status for an installation.
 * Returns a normalized object the UI and server can act on.
 */
export function getEffectivePlan(installation: {
  planName?: string | null;
  planStatus?: string | null;
  trialStartedAt?: Date | null;
  billingCurrentPeriodEnd?: Date | null;
}): {
  planName: string | null;
  planStatus: string | null;
  isActive: boolean;
  requiresPlan: boolean;
  pageLimit: number;
  displayName: string;
} {
  const planName = installation.planName ?? null;
  const planStatus = installation.planStatus ?? null;

  // Active if trialing or paid + active
  const isActive = planStatus === "trialing" || planStatus === "active";

  return {
    planName,
    planStatus,
    isActive,
    requiresPlan: !isActive,
    pageLimit: isActive ? getPageLimit(planName) : 0,
    displayName: planName ? (PLAN_DISPLAY_NAMES[planName] ?? planName) : "No plan",
  };
}

/**
 * Check whether a shop can create another customizer page.
 */
export function canCreatePage(
  planName: string | null | undefined,
  currentCount: number
): { allowed: boolean; limit: number; currentCount: number } {
  const limit = getPageLimit(planName);
  return { allowed: currentCount < limit, limit, currentCount };
}
