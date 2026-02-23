/**
 * Customizer Page Plan Limits
 *
 * Maps subscription tier → max customizer pages allowed.
 * Align tier names with merchants.subscriptionTier values.
 *
 * Future: replace constants with DB-driven plan config.
 */

export const PLAN_PAGE_LIMITS: Record<string, number> = {
  free: 0,
  starter: 1,
  pro: 5,
  studio: 20,
};

export function getPageLimit(planTier: string): number {
  return PLAN_PAGE_LIMITS[planTier] ?? 0;
}

/**
 * Check whether a shop can create another customizer page.
 * Returns { allowed, limit, currentCount } for client display.
 */
export async function canCreatePage(
  planTier: string,
  currentCount: number
): Promise<{ allowed: boolean; limit: number; currentCount: number }> {
  const limit = getPageLimit(planTier);
  return { allowed: currentCount < limit, limit, currentCount };
}
