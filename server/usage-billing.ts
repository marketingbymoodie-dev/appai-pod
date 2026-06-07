/**
 * Shopify usage-charge billing for AI-generation overages.
 *
 * Background: a merchant on a paid plan gets a free monthly allotment of AI
 * generations plus a capped number of paid "overage" generations. The recurring
 * subscription price is billed by Shopify automatically. The *overage* units are
 * metered: each one that the merchant actually uses is billed as a Shopify
 * **usage charge** (`appUsageRecordCreate`) against the subscription's metered
 * (usage) pricing line, at $0.08 each up to the plan's capped amount.
 *
 * This module owns:
 *   - emitting a usage charge per overage generation (idempotent + resilient),
 *   - persisting every charge attempt in `merchant_usage_charges` for audit and
 *     retry, keyed uniquely per overage unit so we never double-bill,
 *   - retrying charges that failed (or were "skipped" because the subscription
 *     had no usage line yet — e.g. legacy subscribers who later re-subscribe),
 *   - extracting the usage line-item GID from an AppSubscription payload.
 *
 * Resilience contract: emitting a charge MUST NOT block or fail the generation
 * the merchant already passed quota checks for. Every Shopify/DB error here is
 * caught and logged; the generation proceeds regardless.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { merchantUsageCharges } from "@shared/schema";
import type { ShopifyInstallation } from "@shared/schema";

/** Shopify Admin API version used across the app (keep in sync with routes.ts). */
export const SHOPIFY_ADMIN_API_VERSION = "2025-10";

const TAG = "[usage-billing]";

/** Minimal installation shape the billing calls need. */
export type BillingInstallation = Pick<
  ShopifyInstallation,
  "id" | "shopDomain" | "accessToken" | "billingUsageLineItemId"
>;

type LineItemNode = {
  id?: string | null;
  plan?: { pricingDetails?: { __typename?: string | null } | null } | null;
};

/**
 * Find the metered (usage) pricing line's GID inside an AppSubscription payload.
 * Returns null when the subscription has no usage line (e.g. trial, or a legacy
 * subscription created before overage billing existed).
 */
export function extractUsageLineItemId(appSubscription: {
  lineItems?: LineItemNode[] | null;
} | null | undefined): string | null {
  const items = appSubscription?.lineItems;
  if (!Array.isArray(items)) return null;
  for (const li of items) {
    if (li?.plan?.pricingDetails?.__typename === "AppUsagePricingDetails" && li.id) {
      return li.id;
    }
  }
  return null;
}

/** Low-level: create one Shopify usage record. Never throws. */
async function createUsageRecord(params: {
  shopDomain: string;
  accessToken: string;
  subscriptionLineItemId: string;
  priceUsd: number;
  description: string;
}): Promise<{ ok: boolean; usageRecordId?: string; error?: string }> {
  const { shopDomain, accessToken, subscriptionLineItemId, priceUsd, description } = params;
  try {
    const resp = await fetch(
      `https://${shopDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `
            mutation appUsageRecordCreate($subscriptionLineItemId: ID!, $price: MoneyInput!, $description: String!) {
              appUsageRecordCreate(subscriptionLineItemId: $subscriptionLineItemId, price: $price, description: $description) {
                userErrors { field message }
                appUsageRecord { id }
              }
            }
          `,
          variables: {
            subscriptionLineItemId,
            price: { amount: priceUsd.toFixed(2), currencyCode: "USD" },
            description,
          },
        }),
      }
    );

    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    const data = (await resp.json()) as any;
    const result = data?.data?.appUsageRecordCreate;
    const userErrors = result?.userErrors;
    if (userErrors?.length) {
      return { ok: false, error: userErrors.map((e: any) => e.message).join("; ") };
    }
    const id = result?.appUsageRecord?.id;
    if (!id) {
      // GraphQL transport errors (e.g. throttling) land here.
      const gqlErrors = data?.errors;
      return {
        ok: false,
        error: gqlErrors?.length ? gqlErrors.map((e: any) => e.message).join("; ") : "No usage record id returned",
      };
    }
    return { ok: true, usageRecordId: id };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

function describeCharge(shopDomain: string, bucketKey: string, overageSeq: number): string {
  return `AI generation overage #${overageSeq} (${bucketKey}) for ${shopDomain}`;
}

/**
 * Emit a usage charge for a single overage generation.
 *
 * Idempotent per (installation, bucketKey, overageSeq): a UNIQUE index means a
 * retry or concurrent call for the same overage unit inserts nothing and bills
 * nothing twice. Resilient: never throws — logs and returns a status instead.
 *
 * When the subscription has no usage line (legacy subscriber), the charge row is
 * persisted as "skipped" so it can be retried after the merchant re-subscribes.
 */
export async function emitOverageUsageCharge(params: {
  installation: BillingInstallation;
  bucketKey: string;
  /** Running overage count within the bucket (1-based; the unit just consumed). */
  overageSeq: number;
  priceUsd: number;
}): Promise<{ status: "charged" | "failed" | "skipped" | "duplicate"; error?: string }> {
  const { installation, bucketKey, overageSeq, priceUsd } = params;
  const lineItemId = installation.billingUsageLineItemId ?? null;

  try {
    // Reserve the overage unit. ON CONFLICT DO NOTHING makes this the idempotency
    // gate: if the row already exists we must not bill again.
    const inserted = await db
      .insert(merchantUsageCharges)
      .values({
        installationId: installation.id,
        shopDomain: installation.shopDomain,
        bucketKey,
        overageSeq,
        subscriptionLineItemId: lineItemId,
        priceUsd: priceUsd.toFixed(4),
        status: lineItemId ? "pending" : "skipped",
        attempts: 0,
        error: lineItemId ? null : "Subscription has no usage line (merchant must re-subscribe)",
      })
      .onConflictDoNothing({
        target: [
          merchantUsageCharges.installationId,
          merchantUsageCharges.bucketKey,
          merchantUsageCharges.overageSeq,
        ],
      })
      .returning({ id: merchantUsageCharges.id });

    const row = inserted[0];
    if (!row) {
      // Already recorded for this overage unit — do not double-bill.
      return { status: "duplicate" };
    }

    if (!lineItemId) {
      console.warn(
        `${TAG} No usage line for ${installation.shopDomain} — overage #${overageSeq} recorded as SKIPPED (unbilled). Merchant must re-subscribe to enable overage billing.`
      );
      return { status: "skipped", error: "no usage line" };
    }

    const res = await createUsageRecord({
      shopDomain: installation.shopDomain,
      accessToken: installation.accessToken,
      subscriptionLineItemId: lineItemId,
      priceUsd,
      description: describeCharge(installation.shopDomain, bucketKey, overageSeq),
    });

    if (res.ok) {
      await db
        .update(merchantUsageCharges)
        .set({
          status: "charged",
          shopifyUsageRecordId: res.usageRecordId,
          attempts: sql`${merchantUsageCharges.attempts} + 1`,
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(merchantUsageCharges.id, row.id));
      console.log(
        `${TAG} Charged $${priceUsd.toFixed(2)} overage #${overageSeq} for ${installation.shopDomain} (${res.usageRecordId})`
      );
      return { status: "charged" };
    }

    await db
      .update(merchantUsageCharges)
      .set({
        status: "failed",
        attempts: sql`${merchantUsageCharges.attempts} + 1`,
        error: res.error?.slice(0, 1000) ?? "unknown error",
        updatedAt: new Date(),
      })
      .where(eq(merchantUsageCharges.id, row.id));
    console.error(
      `${TAG} FAILED to charge overage #${overageSeq} for ${installation.shopDomain}: ${res.error}. Generation still allowed; will retry later.`
    );
    return { status: "failed", error: res.error };
  } catch (err: any) {
    // DB errors etc. — log and swallow; the generation already passed quota.
    console.error(`${TAG} Unexpected error emitting overage charge for ${installation.shopDomain}: ${err?.message ?? err}`);
    return { status: "failed", error: err?.message ?? String(err) };
  }
}

/**
 * Best-effort retry of unbilled overage charges for one installation.
 *
 * Re-attempts rows that are pending/failed (transient errors) or skipped
 * (subscription had no usage line at the time — now retried against the
 * installation's current usage line, e.g. after a re-subscribe). Safe to call
 * opportunistically (e.g. when the merchant opens the billing page). Never throws.
 */
export async function retryPendingOverageCharges(
  installation: BillingInstallation,
  limit = 25
): Promise<{ attempted: number; charged: number; failed: number; skipped: number }> {
  const summary = { attempted: 0, charged: 0, failed: 0, skipped: 0 };
  const lineItemId = installation.billingUsageLineItemId ?? null;
  try {
    const rows = await db
      .select()
      .from(merchantUsageCharges)
      .where(
        and(
          eq(merchantUsageCharges.installationId, installation.id),
          inArray(merchantUsageCharges.status, ["pending", "failed", "skipped"]),
        )
      )
      .orderBy(merchantUsageCharges.id)
      .limit(limit);

    if (!rows.length) return summary;

    if (!lineItemId) {
      // Can't bill anything without a usage line; leave rows as-is for later.
      summary.skipped = rows.length;
      return summary;
    }

    for (const row of rows) {
      summary.attempted++;
      const priceUsd = Number(row.priceUsd);
      const res = await createUsageRecord({
        shopDomain: installation.shopDomain,
        accessToken: installation.accessToken,
        subscriptionLineItemId: lineItemId,
        priceUsd,
        description: describeCharge(installation.shopDomain, row.bucketKey, row.overageSeq),
      });
      if (res.ok) {
        summary.charged++;
        await db
          .update(merchantUsageCharges)
          .set({
            status: "charged",
            subscriptionLineItemId: lineItemId,
            shopifyUsageRecordId: res.usageRecordId,
            attempts: sql`${merchantUsageCharges.attempts} + 1`,
            error: null,
            updatedAt: new Date(),
          })
          .where(eq(merchantUsageCharges.id, row.id));
      } else {
        summary.failed++;
        await db
          .update(merchantUsageCharges)
          .set({
            status: "failed",
            subscriptionLineItemId: lineItemId,
            attempts: sql`${merchantUsageCharges.attempts} + 1`,
            error: res.error?.slice(0, 1000) ?? "unknown error",
            updatedAt: new Date(),
          })
          .where(eq(merchantUsageCharges.id, row.id));
      }
    }
    if (summary.charged || summary.failed) {
      console.log(
        `${TAG} Retry for ${installation.shopDomain}: attempted=${summary.attempted} charged=${summary.charged} failed=${summary.failed}`
      );
    }
    return summary;
  } catch (err: any) {
    console.error(`${TAG} retryPendingOverageCharges error for ${installation.shopDomain}: ${err?.message ?? err}`);
    return summary;
  }
}
