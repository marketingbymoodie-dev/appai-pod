/**
 * Production-safe startup migration fallback.
 *
 * drizzle-kit push is the primary migration mechanism (runs during build).
 * This file is a safety net that ensures critical columns exist even if
 * drizzle-kit push was skipped or partially failed during deploy.
 *
 * Every statement uses ADD COLUMN IF NOT EXISTS, so it is fully idempotent.
 */
import { pool } from "../db";

const MIGRATIONS: { table: string; column: string; type: string }[] = [
  // shopify_installations — customizer + billing columns
  { table: "shopify_installations", column: "customizer_hub_url", type: "TEXT" },
  { table: "shopify_installations", column: "plan_name", type: "TEXT" },
  { table: "shopify_installations", column: "plan_status", type: "TEXT" },
  { table: "shopify_installations", column: "trial_started_at", type: "TIMESTAMP" },
  { table: "shopify_installations", column: "billing_subscription_id", type: "TEXT" },
  { table: "shopify_installations", column: "billing_current_period_end", type: "TIMESTAMP" },
];

export async function runStartupMigrations(): Promise<void> {
  const tag = "[startup-migration]";
  console.log(`${tag} Running idempotent column checks (${MIGRATIONS.length} statements)…`);

  let applied = 0;
  let errors = 0;

  for (const m of MIGRATIONS) {
    try {
      await pool.query(
        `ALTER TABLE "${m.table}" ADD COLUMN IF NOT EXISTS "${m.column}" ${m.type}`
      );
      applied++;
    } catch (err: any) {
      errors++;
      console.error(`${tag} FAILED: ${m.table}.${m.column} — ${err.message ?? err}`);
    }
  }

  console.log(`${tag} Done. applied=${applied} errors=${errors}`);

  if (errors > 0) {
    console.error(`${tag} WARNING: ${errors} migration(s) failed — some routes may not work correctly.`);
  }
}
