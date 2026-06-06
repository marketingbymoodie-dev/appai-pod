/**
 * Per-merchant monthly generation quota enforcement.
 *
 * The Plan & Billing page advertises monthly generation allotments + overage
 * pricing per plan (see server/customizer-plans.ts). This module wires that up:
 * it reads the merchant's effective plan from the Shopify installation, meters
 * generations against the plan's free allotment + overage cap, and blocks once
 * the hard cap is reached.
 *
 * Two counter buckets exist (see resolveGenerationQuota):
 *   - Paid+active plans: monthly bucket "YYYY-MM" (resets each calendar month).
 *   - Trial / no-plan:   cumulative bucket "trial" (20 free total, never resets).
 *
 * The separate per-CUSTOMER 10-free-generation limit (FREE_GENERATION_LIMIT in
 * routes.ts/storage.ts) is unrelated and remains enforced independently.
 */
import { storage } from "./storage";
import {
  getEffectivePlan,
  resolveGenerationQuota,
  PLAN_DISPLAY_NAMES,
} from "./customizer-plans";
import { emitOverageUsageCharge } from "./usage-billing";
import type { ShopifyInstallation } from "@shared/schema";

export interface MerchantQuotaDecision {
  /** Whether the generation is permitted. */
  allowed: boolean;
  /** Owner-shop bypass — unlimited, no metering. */
  unlimited: boolean;
  /** Machine-readable block reason (only when !allowed). */
  code?: "TRIAL_LIMIT_REACHED" | "MONTHLY_LIMIT_REACHED";
  /** Human-readable message the UI can surface. */
  message?: string;
  /** Suggested HTTP status when blocked. */
  status?: number;
  /** Effective plan the quota was derived from (e.g. "trial", "starter"). */
  planName: string | null;
  /** Free generations included in the bucket. */
  freeQuota: number;
  /** Overage cap (extra generations beyond free) in the bucket. */
  overageCap: number;
  /** Hard cap = freeQuota + overageCap. */
  hardCap: number;
  /** Generations used in the current bucket (after consumption when consumed). */
  used: number;
  /** Overage units used in the current bucket (for billing tally). */
  overageUsed: number;
  /** Generations remaining before the hard block. */
  remaining: number;
  /** True when the metered generation fell into the overage band. */
  isOverage: boolean;
  /** Per-overage-generation price in USD (0 when plan has no overage). */
  overagePriceUsd: number;
}

function isOwnerShop(shopDomain: string | null | undefined): boolean {
  const ownerShop = process.env.OWNER_SHOP_DOMAIN?.toLowerCase().trim();
  if (!ownerShop || !shopDomain) return false;
  return shopDomain.toLowerCase().replace(/^https?:\/\//, "") === ownerShop;
}

function unlimitedDecision(planName: string | null): MerchantQuotaDecision {
  return {
    allowed: true,
    unlimited: true,
    planName,
    freeQuota: Infinity,
    overageCap: 0,
    hardCap: Infinity,
    used: 0,
    overageUsed: 0,
    remaining: Infinity,
    isOverage: false,
    overagePriceUsd: 0,
  };
}

function blockedDecision(
  quota: ReturnType<typeof resolveGenerationQuota>,
  used: number,
  overageUsed: number
): MerchantQuotaDecision {
  const isTrial = !quota.monthly;
  const code = isTrial ? "TRIAL_LIMIT_REACHED" : "MONTHLY_LIMIT_REACHED";
  const message = isTrial
    ? `You've used all ${quota.freeQuota} free trial generations. Upgrade to Starter to keep generating.`
    : `Monthly generation limit reached for your ${PLAN_DISPLAY_NAMES[quota.effectivePlan] ?? quota.effectivePlan} plan. Your quota resets at the start of next month.`;
  return {
    allowed: false,
    unlimited: false,
    code,
    message,
    status: 402,
    planName: quota.effectivePlan,
    freeQuota: quota.freeQuota,
    overageCap: quota.overageCap,
    hardCap: quota.hardCap,
    used,
    overageUsed,
    remaining: 0,
    isOverage: false,
    overagePriceUsd: quota.overagePriceUsd,
  };
}

/**
 * Read-only check of whether the merchant has generation quota remaining.
 * Does NOT consume. Use to fail fast before doing per-customer work.
 */
export async function peekMerchantGenerationQuota(
  installation: ShopifyInstallation
): Promise<MerchantQuotaDecision> {
  if (isOwnerShop(installation.shopDomain)) return unlimitedDecision(null);

  const eff = getEffectivePlan(installation as any, installation.shopDomain);
  const quota = resolveGenerationQuota(eff.planName, eff.isActive);
  const usage = await storage.getMerchantGenerationUsage(installation.id, quota.bucketKey);
  const remaining = Math.max(0, quota.hardCap - usage.used);

  if (usage.used >= quota.hardCap) {
    return blockedDecision(quota, usage.used, usage.overageUsed);
  }

  return {
    allowed: true,
    unlimited: false,
    planName: quota.effectivePlan,
    freeQuota: quota.freeQuota,
    overageCap: quota.overageCap,
    hardCap: quota.hardCap,
    used: usage.used,
    overageUsed: usage.overageUsed,
    remaining,
    isOverage: usage.used >= quota.freeQuota,
    overagePriceUsd: quota.overagePriceUsd,
  };
}

/**
 * Atomically consume one generation against the merchant's plan quota.
 * Returns allowed=false (no mutation) when the hard cap is reached.
 */
export async function consumeMerchantGenerationQuota(
  installation: ShopifyInstallation
): Promise<MerchantQuotaDecision> {
  if (isOwnerShop(installation.shopDomain)) return unlimitedDecision(null);

  const eff = getEffectivePlan(installation as any, installation.shopDomain);
  const quota = resolveGenerationQuota(eff.planName, eff.isActive);
  const r = await storage.consumeMerchantGeneration({
    installationId: installation.id,
    bucketKey: quota.bucketKey,
    freeQuota: quota.freeQuota,
    overageCap: quota.overageCap,
  });

  if (!r.allowed) {
    return blockedDecision(quota, r.used, r.overageUsed);
  }

  // The consumed unit fell into the paid overage band → bill it as a Shopify
  // usage charge. Fire-and-forget + fully self-contained error handling so a
  // billing hiccup never blocks the generation the merchant already passed
  // quota checks for. Idempotent per (installation, bucket, overage count).
  if (r.isOverage && quota.overagePriceUsd > 0) {
    void emitOverageUsageCharge({
      installation,
      bucketKey: quota.bucketKey,
      overageSeq: r.overageUsed,
      priceUsd: quota.overagePriceUsd,
    }).catch((err) => {
      console.error(
        `[generation-quota] overage charge emit failed for ${installation.shopDomain}:`,
        err?.message ?? err
      );
    });
  }

  return {
    allowed: true,
    unlimited: false,
    planName: quota.effectivePlan,
    freeQuota: quota.freeQuota,
    overageCap: quota.overageCap,
    hardCap: quota.hardCap,
    used: r.used,
    overageUsed: r.overageUsed,
    remaining: Math.max(0, quota.hardCap - r.used),
    isOverage: r.isOverage,
    overagePriceUsd: quota.overagePriceUsd,
  };
}

/** Build the JSON body for a blocked-quota API response. */
export function quotaBlockBody(decision: MerchantQuotaDecision) {
  return {
    error: decision.code,
    code: decision.code,
    message: decision.message,
    upgrade: decision.code === "TRIAL_LIMIT_REACHED",
    plan: decision.planName,
    used: decision.used,
    limit: decision.hardCap,
    remaining: 0,
  };
}
