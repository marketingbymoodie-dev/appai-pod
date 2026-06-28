/**
 * Per-merchant monthly generation quota enforcement.
 */
import { storage } from "./storage";
import {
  getEffectivePlan,
  resolveGenerationQuota,
  PLAN_DISPLAY_NAMES,
  type GenerationQuotaConfig,
} from "./customizer-plans";
import { emitOverageUsageCharge } from "./usage-billing";
import {
  includedUsedFromCounters,
  extraSpentCents,
  isOverageOptInActive,
  resolveEffectiveOverageCap,
} from "./overage-settings";
import { maybeApplyPendingPlan } from "./plan-transition-apply";
import type { ShopifyInstallation } from "@shared/schema";

export type QuotaBlockCode =
  | "TRIAL_LIMIT_REACHED"
  | "MONTHLY_LIMIT_REACHED"
  | "OVERAGE_OPT_IN_REQUIRED"
  | "OVERAGE_BUDGET_EXHAUSTED";

export interface MerchantQuotaDecision {
  allowed: boolean;
  unlimited: boolean;
  code?: QuotaBlockCode;
  message?: string;
  status?: number;
  planName: string | null;
  freeQuota: number;
  /** Plan-level max overage units (before merchant opt-in). */
  planOverageCap: number;
  /** Effective overage cap after merchant opt-in budget. */
  overageCap: number;
  hardCap: number;
  used: number;
  overageUsed: number;
  remaining: number;
  isOverage: boolean;
  overagePriceUsd: number;
  /** Included (plan allowance) usage — excludes extra pay-as-you-go. */
  includedUsed: number;
  includedLimit: number;
  includedRemaining: number;
  extraUsed: number;
  extraLimit: number;
  extraBudgetCents: number | null;
  extraSpentCents: number;
  extraRemainingCents: number | null;
  overageOptInEnabled: boolean;
  overageRecurring: boolean;
  /** True when included usage >= 90% and not opted in. */
  showOptInForm: boolean;
  /** True when included quota exhausted and not opted in. */
  includedExhausted: boolean;
  currency: "USD";
}

function isOwnerShop(shopDomain: string | null | undefined): boolean {
  const ownerShop = process.env.OWNER_SHOP_DOMAIN?.toLowerCase().trim();
  if (!ownerShop || !shopDomain) return false;
  return shopDomain.toLowerCase().replace(/^https?:\/\//, "") === ownerShop;
}

function enrichDecision(
  base: Omit<
    MerchantQuotaDecision,
    | "includedUsed"
    | "includedLimit"
    | "includedRemaining"
    | "extraUsed"
    | "extraLimit"
    | "extraBudgetCents"
    | "extraSpentCents"
    | "extraRemainingCents"
    | "overageOptInEnabled"
    | "overageRecurring"
    | "showOptInForm"
    | "includedExhausted"
    | "currency"
    | "planOverageCap"
  > & { planOverageCap?: number },
  installation: ShopifyInstallation,
  quota: GenerationQuotaConfig,
): MerchantQuotaDecision {
  const includedUsed = includedUsedFromCounters(base.used, base.overageUsed);
  const includedLimit = base.freeQuota;
  const includedRemaining = Math.max(0, includedLimit - includedUsed);
  const extraUsed = base.overageUsed;
  const extraLimit = base.overageCap;
  const budgetCents = installation.overageBudgetCents ?? null;
  const spentCents = extraSpentCents(extraUsed);
  const extraRemainingCents =
    budgetCents != null ? Math.max(0, budgetCents - spentCents) : null;
  const optedIn = isOverageOptInActive(installation, quota.bucketKey);
  const includedExhausted = !base.unlimited && includedUsed >= includedLimit && includedLimit > 0;
  const showOptInForm =
    !base.unlimited &&
    quota.monthly &&
    !optedIn &&
    includedLimit > 0 &&
    includedUsed >= Math.ceil(includedLimit * 0.9);

  return {
    ...base,
    planOverageCap: base.planOverageCap ?? quota.overageCap,
    includedUsed,
    includedLimit,
    includedRemaining,
    extraUsed,
    extraLimit,
    extraBudgetCents: budgetCents,
    extraSpentCents: spentCents,
    extraRemainingCents,
    overageOptInEnabled: optedIn,
    overageRecurring: !!installation.overageRecurring,
    showOptInForm,
    includedExhausted,
    currency: "USD",
  };
}

function unlimitedDecision(planName: string | null): MerchantQuotaDecision {
  return {
    allowed: true,
    unlimited: true,
    planName,
    freeQuota: Infinity,
    planOverageCap: 0,
    overageCap: 0,
    hardCap: Infinity,
    used: 0,
    overageUsed: 0,
    remaining: Infinity,
    isOverage: false,
    overagePriceUsd: 0,
    includedUsed: 0,
    includedLimit: Infinity,
    includedRemaining: Infinity,
    extraUsed: 0,
    extraLimit: 0,
    extraBudgetCents: null,
    extraSpentCents: 0,
    extraRemainingCents: null,
    overageOptInEnabled: false,
    overageRecurring: false,
    showOptInForm: false,
    includedExhausted: false,
    currency: "USD",
  };
}

function blockedDecision(
  quota: GenerationQuotaConfig,
  used: number,
  overageUsed: number,
  installation: ShopifyInstallation,
  code: QuotaBlockCode,
): MerchantQuotaDecision {
  const effectiveOverageCap = resolveEffectiveOverageCap(installation, quota);
  const hardCap = quota.freeQuota + effectiveOverageCap;
  const includedUsed = includedUsedFromCounters(used, overageUsed);

  let message: string;
  switch (code) {
    case "TRIAL_LIMIT_REACHED":
      message = `You've used all ${quota.freeQuota} free trial generations. Upgrade to Starter to keep generating.`;
      break;
    case "OVERAGE_OPT_IN_REQUIRED":
      message =
        "Included AI generations for this billing period are used up. Enable pay-as-you-go extra usage (USD), upgrade your plan, or wait until your next billing period.";
      break;
    case "OVERAGE_BUDGET_EXHAUSTED":
      message =
        "Your pay-as-you-go extra generation budget for this period is exhausted. Increase your budget, upgrade your plan, or wait until next month.";
      break;
    default:
      message = `Monthly generation limit reached for your ${PLAN_DISPLAY_NAMES[quota.effectivePlan] ?? quota.effectivePlan} plan.`;
  }

  return enrichDecision(
    {
      allowed: false,
      unlimited: false,
      code,
      message,
      status: 402,
      planName: quota.effectivePlan,
      freeQuota: quota.freeQuota,
      planOverageCap: quota.overageCap,
      overageCap: effectiveOverageCap,
      hardCap,
      used,
      overageUsed,
      remaining: 0,
      isOverage: false,
      overagePriceUsd: quota.overagePriceUsd,
    },
    installation,
    quota,
  );
}

async function resolveQuotaContext(installation: ShopifyInstallation): Promise<{
  quota: GenerationQuotaConfig;
  effectiveOverageCap: number;
  hardCap: number;
}> {
  await storage.syncOverageOptInForBucket(installation.id, installation);
  let refreshed = (await storage.getShopifyInstallation(installation.id)) ?? installation;
  refreshed = await maybeApplyPendingPlan(refreshed);

  const eff = getEffectivePlan(refreshed as any, refreshed.shopDomain);
  const quota = resolveGenerationQuota(eff.planName, eff.isActive);
  const effectiveOverageCap = resolveEffectiveOverageCap(refreshed, quota);
  const hardCap = quota.freeQuota + effectiveOverageCap;
  return { quota, effectiveOverageCap, hardCap };
}

function classifyBlock(
  quota: GenerationQuotaConfig,
  used: number,
  overageUsed: number,
  installation: ShopifyInstallation,
  effectiveOverageCap: number,
): QuotaBlockCode | null {
  if (!quota.monthly) {
    if (used >= quota.freeQuota) return "TRIAL_LIMIT_REACHED";
    return null;
  }

  const includedUsed = includedUsedFromCounters(used, overageUsed);
  if (includedUsed < quota.freeQuota) return null;

  if (effectiveOverageCap <= 0) return "OVERAGE_OPT_IN_REQUIRED";

  const hardCap = quota.freeQuota + effectiveOverageCap;
  if (used >= hardCap) return "OVERAGE_BUDGET_EXHAUSTED";

  return null;
}

export async function peekMerchantGenerationQuota(
  installation: ShopifyInstallation,
): Promise<MerchantQuotaDecision> {
  if (isOwnerShop(installation.shopDomain)) return unlimitedDecision(null);

  const { quota, effectiveOverageCap, hardCap } = await resolveQuotaContext(installation);
  const refreshed = (await storage.getShopifyInstallation(installation.id)) ?? installation;
  const usage = await storage.getMerchantGenerationUsage(refreshed.id, quota.bucketKey);

  const blockCode = classifyBlock(
    quota,
    usage.used,
    usage.overageUsed,
    refreshed,
    effectiveOverageCap,
  );
  if (blockCode) {
    return blockedDecision(quota, usage.used, usage.overageUsed, refreshed, blockCode);
  }

  return enrichDecision(
    {
      allowed: true,
      unlimited: false,
      planName: quota.effectivePlan,
      freeQuota: quota.freeQuota,
      planOverageCap: quota.overageCap,
      overageCap: effectiveOverageCap,
      hardCap,
      used: usage.used,
      overageUsed: usage.overageUsed,
      remaining: Math.max(0, hardCap - usage.used),
      isOverage: usage.used >= quota.freeQuota,
      overagePriceUsd: quota.overagePriceUsd,
    },
    refreshed,
    quota,
  );
}

export async function consumeMerchantGenerationQuota(
  installation: ShopifyInstallation,
): Promise<MerchantQuotaDecision> {
  if (isOwnerShop(installation.shopDomain)) return unlimitedDecision(null);

  const { quota, effectiveOverageCap } = await resolveQuotaContext(installation);
  const refreshed = (await storage.getShopifyInstallation(installation.id)) ?? installation;

  const r = await storage.consumeMerchantGeneration({
    installationId: refreshed.id,
    bucketKey: quota.bucketKey,
    freeQuota: quota.freeQuota,
    overageCap: effectiveOverageCap,
  });

  if (!r.allowed) {
    const blockCode =
      classifyBlock(quota, r.used, r.overageUsed, refreshed, effectiveOverageCap) ??
      (!quota.monthly ? "TRIAL_LIMIT_REACHED" : "OVERAGE_BUDGET_EXHAUSTED");
    return blockedDecision(quota, r.used, r.overageUsed, refreshed, blockCode);
  }

  if (r.isOverage && quota.overagePriceUsd > 0) {
    void emitOverageUsageCharge({
      installation: refreshed,
      bucketKey: quota.bucketKey,
      overageSeq: r.overageUsed,
      priceUsd: quota.overagePriceUsd,
    }).catch((err) => {
      console.error(
        `[generation-quota] overage charge emit failed for ${refreshed.shopDomain}:`,
        err?.message ?? err,
      );
    });
  }

  const hardCap = quota.freeQuota + effectiveOverageCap;
  return enrichDecision(
    {
      allowed: true,
      unlimited: false,
      planName: quota.effectivePlan,
      freeQuota: quota.freeQuota,
      planOverageCap: quota.overageCap,
      overageCap: effectiveOverageCap,
      hardCap,
      used: r.used,
      overageUsed: r.overageUsed,
      remaining: Math.max(0, hardCap - r.used),
      isOverage: r.isOverage,
      overagePriceUsd: quota.overagePriceUsd,
    },
    refreshed,
    quota,
  );
}

/** Build the JSON body for a blocked-quota API response. */
export function quotaBlockBody(decision: MerchantQuotaDecision) {
  return {
    error: decision.code,
    code: decision.code,
    message: decision.message,
    upgrade:
      decision.code === "TRIAL_LIMIT_REACHED" || decision.code === "OVERAGE_OPT_IN_REQUIRED",
    optIn: decision.code === "OVERAGE_OPT_IN_REQUIRED",
    plan: decision.planName,
    used: decision.used,
    limit: decision.hardCap,
    remaining: 0,
    includedUsed: decision.includedUsed,
    includedLimit: decision.includedLimit,
    currency: "USD",
  };
}
