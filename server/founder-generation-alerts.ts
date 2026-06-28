/**
 * Founder-facing failure-rate monitoring (Resend email + audit log).
 * Separate from merchant-facing Shopify resource feedback.
 */
import { storage } from "./storage";
import type { MerchantGenerationHealth, ShopifyInstallation } from "@shared/schema";

const TAG = "[founder-generation-alerts]";
const COOLDOWN_MS = 6 * 60 * 60 * 1000;

function alertThresholds() {
  return {
    minAttempts: parseInt(process.env.FOUNDER_ALERT_MIN_ATTEMPTS || "20", 10),
    failureRate: parseFloat(process.env.FOUNDER_ALERT_FAILURE_RATE || "0.30"),
  };
}

async function sendFounderEmail(params: {
  shopDomain: string;
  failureRate: number;
  attempts: number;
  failures: number;
}): Promise<boolean> {
  const to = process.env.FOUNDER_ALERT_EMAIL?.trim();
  const resendKey = process.env.RESEND_API_KEY;
  if (!to || !resendKey) {
    console.warn(`${TAG} FOUNDER_ALERT_EMAIL or RESEND_API_KEY not set — skipping email`);
    return false;
  }

  const pct = Math.round(params.failureRate * 100);
  const body = [
    `High AI generation failure rate detected for ${params.shopDomain}.`,
    ``,
    `Rolling 1h window: ${params.failures} failures / ${params.attempts} attempts (${pct}%).`,
    ``,
    `Check the platform Generation Health dashboard in AppAI admin.`,
  ].join("\n");

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "AppAI Alerts <onboarding@resend.dev>",
        to: [to],
        subject: `[AppAI] High generation failure rate — ${params.shopDomain}`,
        text: body,
      }),
    });
    if (!resp.ok) {
      console.error(`${TAG} Resend error ${resp.status}:`, await resp.text());
      return false;
    }
    return true;
  } catch (err: any) {
    console.error(`${TAG} email send failed:`, err?.message ?? err);
    return false;
  }
}

/** Record outcome and maybe email the founder (rate-limited per shop). */
export async function recordGenerationOutcomeForFounder(
  installation: ShopifyInstallation | null | undefined,
  success: boolean,
): Promise<void> {
  if (!installation?.id || !installation.shopDomain) return;

  const health = await storage.recordGenerationHealthEvent(
    installation.id,
    installation.shopDomain,
    success,
  );

  if (success) return;

  await maybeSendFounderAlert(installation, health);
}

async function maybeSendFounderAlert(
  installation: ShopifyInstallation,
  health: MerchantGenerationHealth,
): Promise<void> {
  const { minAttempts, failureRate } = alertThresholds();
  const total = health.successCount + health.failureCount;
  if (total < minAttempts) return;

  const rate = health.failureCount / total;
  if (rate < failureRate) return;

  if (
    health.founderAlertSentAt &&
    Date.now() - health.founderAlertSentAt.getTime() < COOLDOWN_MS
  ) {
    return;
  }

  const emailSent = await sendFounderEmail({
    shopDomain: installation.shopDomain,
    failureRate: rate,
    attempts: total,
    failures: health.failureCount,
  });

  await storage.insertFounderAlert({
    installationId: installation.id,
    shopDomain: installation.shopDomain,
    alertType: "high_failure_rate",
    failureRate: rate,
    attempts: total,
    emailSent,
  });

  const { db } = await import("./db");
  const { merchantGenerationHealth } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  await db
    .update(merchantGenerationHealth)
    .set({ founderAlertSentAt: new Date() })
    .where(eq(merchantGenerationHealth.installationId, installation.id));
}
