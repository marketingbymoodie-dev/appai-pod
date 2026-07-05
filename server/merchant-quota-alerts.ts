/**
 * Shopify Admin resource feedback for merchant included-quota warnings (90% / 100%).
 * Requires write_resource_feedbacks scope (merchants must re-OAuth after scope add).
 */
import { storage } from "./storage";
import { shopifyApiCall } from "./shopify";
import { resolveGenerationQuota, getEffectivePlan } from "./customizer-plans";
import type { MerchantQuotaDecision } from "./generation-quota";
import type { ShopifyInstallation } from "@shared/schema";

const TAG = "[merchant-quota-alerts]";

async function shopResourceFeedback(
  installation: ShopifyInstallation,
  state: "REQUIRES_ACTION" | "ACCEPTED",
  messages: string[],
): Promise<void> {
  if (!installation.accessToken) return;

  const mutation = `mutation ShopResourceFeedbackCreate($input: ShopResourceFeedbackCreateInput!) {
    shopResourceFeedbackCreate(input: $input) {
      feedback { state messages }
      userErrors { field message }
    }
  }`;

  const result = await shopifyApiCall(
    installation.shopDomain,
    installation.accessToken,
    "graphql.json",
    {
      method: "POST",
      body: JSON.stringify({
        query: mutation,
        variables: { input: { state, messages } },
      }),
    },
  );

  if (!result.ok) {
    console.warn(`${TAG} feedback API failed for ${installation.shopDomain}:`, result.error);
    return;
  }

  const errors = result.data?.data?.shopResourceFeedbackCreate?.userErrors;
  if (Array.isArray(errors) && errors.length > 0) {
    console.warn(`${TAG} feedback userErrors for ${installation.shopDomain}:`, errors);
  }
}

/** Sync Shopify Admin feedback after a quota peek/consume. Best-effort, non-blocking. */
export async function syncMerchantQuotaAlerts(
  installation: ShopifyInstallation,
  decision: MerchantQuotaDecision,
): Promise<void> {
  if (decision.unlimited || !decision.planName || decision.planName === "trial") return;

  const eff = getEffectivePlan(installation as any, installation.shopDomain);
  const quota = resolveGenerationQuota(eff.planName, eff.isActive);
  const bucketKey = quota.bucketKey;

  const refreshed =
    (await storage.getShopifyInstallation(installation.id)) ?? installation;

  if (decision.includedExhausted && !decision.overageOptInEnabled) {
    if (refreshed.quotaAlert100BucketKey === bucketKey) return;
    await shopResourceFeedback(refreshed, "REQUIRES_ACTION", [
      "Included AI generations for this billing period are used up (USD plan allowance). " +
        "Enable pay-as-you-go extra usage in AppAI Plan & Billing, upgrade your plan, or wait until next month. " +
        "Customer-purchased credit packs still work.",
    ]);
    await storage.updateShopifyInstallation(refreshed.id, {
      quotaAlert100BucketKey: bucketKey,
    } as any);
    return;
  }

  if (decision.showOptInForm) {
    if (refreshed.quotaAlert90BucketKey === bucketKey) return;
    const pct = Math.round((decision.includedUsed / decision.includedLimit) * 100);
    await shopResourceFeedback(refreshed, "REQUIRES_ACTION", [
      `You've used ${pct}% of your included AI generations this billing period (USD plan allowance). ` +
        "Open AppAI Plan & Billing to enable pay-as-you-go extra usage before you hit the limit.",
    ]);
    await storage.updateShopifyInstallation(refreshed.id, {
      quotaAlert90BucketKey: bucketKey,
    } as any);
    return;
  }

  if (
    decision.overageOptInEnabled ||
    (decision.includedLimit > 0 && decision.includedUsed < Math.ceil(decision.includedLimit * 0.9))
  ) {
    if (!refreshed.quotaAlert90BucketKey && !refreshed.quotaAlert100BucketKey) return;
    await shopResourceFeedback(refreshed, "ACCEPTED", []);
    await storage.updateShopifyInstallation(refreshed.id, {
      quotaAlert90BucketKey: null,
      quotaAlert100BucketKey: null,
    } as any);
  }
}
