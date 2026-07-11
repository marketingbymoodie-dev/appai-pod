/**
 * Customizer Page Plan Limits
 *
 * Maps plan name → max customizer pages allowed.
 * The plan state lives on shopifyInstallations.planName / planStatus.
 */

export const PLAN_PAGE_LIMITS: Record<string, number> = {
  trial:    1,
  starter:  1,
  dabbler:  5,
  pro:      15,
  pro_plus: 30,
};

/**
 * Max ACTIVE permanent "design products" (merchant-published standalone product
 * listings from My Designs) allowed per plan. Trial gets none. Saved designs in
 * the library are capped separately at a flat 30 regardless of plan (see
 * MERCHANT_STUDIO_GALLERY_LIMIT in server/routes.ts) — this limit only governs
 * how many of those saved designs can be live Shopify products at once.
 */
export const PLAN_DESIGN_PRODUCT_LIMITS: Record<string, number> = {
  trial:    0,
  starter:  1,
  dabbler:  5,
  pro:      15,
  pro_plus: 30,
};

export function getDesignProductLimit(planName: string | null | undefined): number {
  if (!planName) return 0;
  return PLAN_DESIGN_PRODUCT_LIMITS[planName] ?? 0;
}

/**
 * Monthly free AI-generation allotment per plan.
 *
 * NOTE: These numbers currently drive the billing/pricing DISPLAY (plan picker
 * cards). Per-merchant monthly quota *enforcement* (counting generations,
 * blocking at the cap, charging overages) is NOT yet wired up — see
 * `merchants.monthlyGenerationLimit` / `generationsThisMonth` in the schema,
 * which still default to 100 and are not tied to these values. Wire these in
 * when implementing metered billing.
 *
 * The separate per-CUSTOMER 10-free-generation limit IS enforced today
 * (FREE_GENERATION_LIMIT in server/routes.ts + server/storage.ts).
 */
export const PLAN_GENERATION_QUOTAS: Record<string, number> = {
  trial:    20,
  starter:  250,
  dabbler:  600,
  pro:      1500,
  pro_plus: 3000,
};

/** Per-generation overage price in USD (applies once the monthly quota is exhausted). */
export const OVERAGE_PRICE_USD = 0.08;

/** Max extra (overage) generations allowed per calendar month, per paid plan. */
export const PLAN_OVERAGE_CAPS: Record<string, number> = {
  starter:  200,
  dabbler:  300,
  pro:      500,
  pro_plus: 1000,
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

/**
 * Maximum monthly overage cost (USD) a plan can incur = overage cap × per-unit
 * price. This is the `cappedAmount` Shopify requires on a usage-pricing line:
 * Shopify will reject usage records once the merchant's accrued usage for the
 * billing period reaches this amount, which lines up with our own hard cap
 * (overageCap units × OVERAGE_PRICE_USD). Returns 0 for plans without overage.
 *
 *   Starter : 200 × $0.08 = $16.00
 *   Dabbler : 300 × $0.08 = $24.00
 *   Pro     : 500 × $0.08 = $40.00
 *   Pro Plus: 1000 × $0.08 = $80.00
 */
export function getPlanOverageCappedAmountUsd(planName: string | null | undefined): number {
  if (!planName) return 0;
  const cap = PLAN_OVERAGE_CAPS[planName] ?? 0;
  // Round to cents to avoid float drift (e.g. 16.000000000000004).
  return Math.round(cap * OVERAGE_PRICE_USD * 100) / 100;
}

/** Human-readable terms shown on the metered (usage) pricing line at approval. */
export const OVERAGE_USAGE_TERMS = `$${OVERAGE_PRICE_USD.toFixed(2)} USD per additional AI generation beyond your monthly included allotment (pay-as-you-go; requires in-app opt-in; not a prepaid pack)`;

export function getPageLimit(planName: string | null | undefined): number {
  if (!planName) return 0;
  return PLAN_PAGE_LIMITS[planName] ?? 0;
}

/**
 * Derive the effective plan status for an installation.
 * Returns a normalized object the UI and server can act on.
 *
 * If OWNER_SHOP_DOMAIN env var is set and shopDomain matches, unconditionally
 * returns Pro Plus active — bypasses all billing/DB state for the developer's store.
 */
export function getEffectivePlan(
  installation: {
    planName?: string | null;
    planStatus?: string | null;
    trialStartedAt?: Date | null;
    billingCurrentPeriodEnd?: Date | null;
  },
  shopDomain?: string
): {
  planName: string | null;
  planStatus: string | null;
  isActive: boolean;
  requiresPlan: boolean;
  pageLimit: number;
  displayName: string;
} {
  // Owner bypass: env-var-configured shop always gets Pro Plus without payment
  const ownerShop = process.env.OWNER_SHOP_DOMAIN?.toLowerCase().trim();
  if (ownerShop && shopDomain && shopDomain.toLowerCase().replace(/^https?:\/\//, "") === ownerShop) {
    return {
      planName: "pro_plus",
      planStatus: "active",
      isActive: true,
      requiresPlan: false,
      pageLimit: PLAN_PAGE_LIMITS["pro_plus"],
      displayName: "Pro Plus (Owner)",
    };
  }

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
 * Resolve the monthly generation quota config for an effective plan.
 *
 * Returns the free allotment, overage cap, overage price, and the counter
 * "bucket key" that the per-merchant monthly counters belong to:
 *   - Paid+active plans bucket per calendar month → key "YYYY-MM" (UTC),
 *     resets automatically when the month changes.
 *   - Trial / no-plan / inactive bucket cumulatively → key "trial" (the 20
 *     free generations are a lifetime total, NOT monthly, and never reset).
 *
 * `now` is injectable for testing.
 */
export interface GenerationQuotaConfig {
  /** The plan the quota is derived from (may differ from raw planName when inactive → trial fallback). */
  effectivePlan: string;
  /** Free generations included in the bucket. */
  freeQuota: number;
  /** Max extra (overage) generations beyond the free allotment in the bucket. */
  overageCap: number;
  /** Hard cap for the bucket = freeQuota + overageCap. */
  hardCap: number;
  /** Per-overage-generation price in USD (0 for plans with no overage). */
  overagePriceUsd: number;
  /** Counter bucket key the monthly counters belong to. */
  bucketKey: string;
  /** Whether the bucket resets per calendar month (paid) or is cumulative (trial). */
  monthly: boolean;
}

/** UTC calendar-month key, e.g. "2026-06". */
export function generationMonthKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Derive the generation quota config from a plan name + active flag.
 *
 * A merchant on an active PAID plan gets that plan's monthly quota + overage.
 * Anyone else (trial, no plan, expired, cancelled) falls back to the trial
 * allotment: 20 free generations total, no overage, upgrade-to-Starter to continue.
 */
export function resolveGenerationQuota(
  planName: string | null | undefined,
  isActive: boolean,
  now: Date = new Date()
): GenerationQuotaConfig {
  const isPaidActive =
    isActive && !!planName && (PAID_PLANS as readonly string[]).includes(planName);

  if (isPaidActive) {
    const freeQuota = PLAN_GENERATION_QUOTAS[planName!] ?? 0;
    const overageCap = PLAN_OVERAGE_CAPS[planName!] ?? 0;
    return {
      effectivePlan: planName!,
      freeQuota,
      overageCap,
      hardCap: freeQuota + overageCap,
      overagePriceUsd: overageCap > 0 ? OVERAGE_PRICE_USD : 0,
      bucketKey: generationMonthKey(now),
      monthly: true,
    };
  }

  // Trial / no plan / inactive → cumulative 20 free, no overage.
  const freeQuota = PLAN_GENERATION_QUOTAS["trial"] ?? 20;
  return {
    effectivePlan: "trial",
    freeQuota,
    overageCap: 0,
    hardCap: freeQuota,
    overagePriceUsd: 0,
    bucketKey: "trial",
    monthly: false,
  };
}

/**
 * Pure decision for consuming one generation against a bucket's quota.
 *
 * Single source of truth for the cap/overage math, shared by the storage-layer
 * atomic consume and unit tests.
 *
 * @param currentUsed total generations already used in the bucket (free + overage)
 * @param freeQuota   free allotment for the bucket
 * @param overageCap  extra allowed beyond the free allotment
 */
export function computeGenerationConsume(
  currentUsed: number,
  freeQuota: number,
  overageCap: number
): { allowed: boolean; isOverage: boolean; hardCap: number } {
  const hardCap = freeQuota + overageCap;
  const allowed = currentUsed < hardCap;
  // The unit being consumed is overage when the free allotment is already spent.
  const isOverage = allowed && currentUsed >= freeQuota;
  return { allowed, isOverage, hardCap };
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

/** Check whether a shop can activate another permanent design product. */
export function canActivateDesignProduct(
  planName: string | null | undefined,
  currentActiveCount: number
): { allowed: boolean; limit: number; currentCount: number } {
  const limit = getDesignProductLimit(planName);
  return { allowed: currentActiveCount < limit, limit, currentCount: currentActiveCount };
}
