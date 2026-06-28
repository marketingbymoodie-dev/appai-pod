/**
 * Apply deferred plan changes and enforce page limits after downgrades.
 */
import { storage } from "./storage";
import { getPageLimit } from "./customizer-plans";
import { downgradeMeteringReset, isPaidPlan } from "./plan-transitions";
import type { ShopifyInstallation } from "@shared/schema";

export async function applyPendingPlanIfDue(
  installation: ShopifyInstallation,
): Promise<{ applied: boolean; deactivatedPageIds: string[]; newPlanName?: string }> {
  const pending = installation.pendingPlanName;
  const effectiveAt = installation.pendingPlanEffectiveAt;
  if (!pending || !effectiveAt) {
    return { applied: false, deactivatedPageIds: [] };
  }
  if (Date.now() < effectiveAt.getTime()) {
    return { applied: false, deactivatedPageIds: [] };
  }

  const pageLimit = getPageLimit(pending);
  const baseUpdates: Partial<ShopifyInstallation> = {
    planName: pending,
    pendingPlanName: null,
    pendingPlanEffectiveAt: null,
  };

  if (pending === "trial") {
    baseUpdates.planStatus = "trialing";
  } else if (isPaidPlan(pending)) {
    baseUpdates.planStatus = "active";
    Object.assign(baseUpdates, downgradeMeteringReset());
  }

  await storage.updateShopifyInstallation(installation.id, baseUpdates);

  const { deactivatedIds, keptActiveCount } = await storage.enforceCustomizerPageLimit(
    installation.shopDomain,
    pageLimit,
  );

  console.log(
    `[plan-transitions] Applied pending plan ${pending} for ${installation.shopDomain}; ` +
      `pages kept active=${keptActiveCount}, deactivated=${deactivatedIds.length}`,
  );

  return { applied: true, deactivatedPageIds: deactivatedIds, newPlanName: pending };
}

/** Opportunistically apply pending plan; returns refreshed installation if applied. */
export async function maybeApplyPendingPlan(
  installation: ShopifyInstallation,
): Promise<ShopifyInstallation> {
  const result = await applyPendingPlanIfDue(installation);
  if (!result.applied) return installation;
  return (await storage.getShopifyInstallation(installation.id)) ?? installation;
}
