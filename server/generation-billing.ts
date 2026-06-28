/**
 * Apply merchant/customer billing after a successful generation.
 */
import { storage } from "./storage";
import {
  consumeMerchantGenerationQuota,
  peekMerchantGenerationQuota,
  type MerchantQuotaDecision,
} from "./generation-quota";
import { syncMerchantQuotaAlerts } from "./merchant-quota-alerts";
import { logMerchantGeneration, type MerchantGenerationLogInput } from "./merchant-generation-log";
import type { ShopifyInstallation } from "@shared/schema";

export type GenerationBillingMode = "merchant" | "customer_paid" | "customer_free" | "session";

export function resolveStorefrontBillingMode(params: {
  usedCustomerPaidCredit: boolean;
  hasLoggedInCustomer: boolean;
  hasSessionOnly: boolean;
}): GenerationBillingMode {
  if (params.usedCustomerPaidCredit) return "customer_paid";
  if (params.hasLoggedInCustomer) return "customer_free";
  if (params.hasSessionOnly) return "session";
  return "merchant";
}

export async function applyCustomerBillingOnSuccess(params: {
  customerId: string;
  mode: "customer_paid" | "customer_free";
  idempotencyKey: string;
  externalRef: string;
}): Promise<boolean> {
  const { customerId, mode, idempotencyKey, externalRef } = params;
  if (mode === "customer_paid") {
    const r = await storage.consumePaidCredit(customerId, idempotencyKey, externalRef);
    return r.consumed;
  }
  const r = await storage.consumeFreeGeneration(customerId, idempotencyKey, externalRef);
  return r.consumed;
}

export async function applyMerchantBillingOnSuccess(
  installation: ShopifyInstallation,
): Promise<MerchantQuotaDecision> {
  const decision = await consumeMerchantGenerationQuota(installation);
  void syncMerchantQuotaAlerts(installation, decision).catch((err) => {
    console.warn("[generation-billing] quota alert sync failed:", err?.message ?? err);
  });
  return decision;
}

/** Peek merchant quota and fire alert side-effects (POST generate paths). */
export async function peekMerchantQuotaWithAlerts(
  installation: ShopifyInstallation,
): Promise<MerchantQuotaDecision> {
  const decision = await peekMerchantGenerationQuota(installation);
  void syncMerchantQuotaAlerts(installation, decision).catch(() => {});
  return decision;
}

export async function finalizeGenerationBilling(params: {
  installation: ShopifyInstallation;
  billingMode: GenerationBillingMode;
  customerId?: string | null;
  idempotencyKey: string;
}): Promise<MerchantQuotaDecision | null> {
  const { installation, billingMode, customerId, idempotencyKey } = params;

  if (billingMode === "merchant") {
    return applyMerchantBillingOnSuccess(installation);
  }

  if (billingMode === "customer_paid" && customerId) {
    await applyCustomerBillingOnSuccess({
      customerId,
      mode: "customer_paid",
      idempotencyKey,
      externalRef: idempotencyKey,
    });
    return null;
  }

  if (billingMode === "customer_free" && customerId) {
    await applyCustomerBillingOnSuccess({
      customerId,
      mode: "customer_free",
      idempotencyKey: `storefront-free-generation:${idempotencyKey}`,
      externalRef: idempotencyKey,
    });
    return null;
  }

  // session + anonymous: job completion is the meter (countSessionGenerations)
  return null;
}

export async function recordSuccessfulGeneration(
  log: MerchantGenerationLogInput,
): Promise<void> {
  await logMerchantGeneration({ ...log, success: true });
}

export async function recordFailedGeneration(
  log: MerchantGenerationLogInput,
): Promise<void> {
  await logMerchantGeneration({ ...log, success: false });
}
