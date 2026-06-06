/**
 * Production-safe startup migration fallback.
 *
 * drizzle-kit push is the primary migration mechanism (runs during build).
 * This file is a safety net that ensures:
 *   1. All required columns exist on existing tables (ADD COLUMN IF NOT EXISTS)
 *   2. All required tables exist (CREATE TABLE IF NOT EXISTS)
 *
 * Every statement is fully idempotent and safe to run on every boot.
 */
import { pool } from "../db";

// ── Column additions ──────────────────────────────────────────────────────────

const COLUMN_MIGRATIONS: { table: string; column: string; type: string }[] = [
  { table: "shopify_installations", column: "customizer_hub_url",          type: "TEXT" },
  { table: "shopify_installations", column: "plan_name",                   type: "TEXT" },
  { table: "shopify_installations", column: "plan_status",                 type: "TEXT" },
  { table: "shopify_installations", column: "trial_started_at",            type: "TIMESTAMP" },
  { table: "shopify_installations", column: "billing_subscription_id",     type: "TEXT" },
  { table: "shopify_installations", column: "billing_current_period_end",  type: "TIMESTAMP" },
  { table: "shopify_installations", column: "generation_month",            type: "TEXT" },
  { table: "shopify_installations", column: "monthly_generations_used",    type: "INTEGER NOT NULL DEFAULT 0" },
  { table: "shopify_installations", column: "monthly_overage_used",        type: "INTEGER NOT NULL DEFAULT 0" },
  { table: "customizer_pages",      column: "base_product_handle",         type: "TEXT" },
  { table: "generation_jobs",       column: "session_id",                  type: "TEXT" },
  { table: "generation_jobs",       column: "customer_id",                 type: "TEXT" },
  { table: "product_types",         column: "printify_costs",              type: "TEXT DEFAULT '{}'" },
  { table: "product_types",         column: "is_all_over_print",           type: "BOOLEAN NOT NULL DEFAULT FALSE" },
  { table: "product_types",         column: "placeholder_positions",       type: "TEXT DEFAULT '[]'" },
  { table: "style_presets",         column: "base_image_url",              type: "TEXT" },
  { table: "merchants",             column: "branding_settings",           type: "JSONB" },
  { table: "customers",              column: "email",                       type: "TEXT" },
  { table: "customers",              column: "otp_code",                    type: "TEXT" },
  { table: "customers",              column: "otp_expires_at",              type: "TIMESTAMP" },
  { table: "generation_jobs",       column: "mockup_urls",                 type: "JSON" },
  { table: "generation_jobs",       column: "design_state",                type: "JSON" },
  { table: 'generation_jobs',       column: 'user_prompt',                 type: 'TEXT' },
  { table: 'style_presets',         column: 'prompt_placeholder',          type: 'TEXT' },
  { table: 'style_presets',         column: 'options',                     type: 'JSONB' },
  { table: 'style_presets',         column: 'description_optional',        type: 'BOOLEAN NOT NULL DEFAULT FALSE' },
  { table: 'published_products',    column: 'expires_at',                  type: 'TIMESTAMP' },
  { table: 'published_products',    column: 'cart_added_at',               type: 'TIMESTAMP' },
  { table: 'generation_jobs',       column: 'shadow_product_id',           type: 'TEXT' },
  { table: 'generation_jobs',       column: 'shadow_variant_id',           type: 'TEXT' },
  { table: 'generation_jobs',       column: 'shadow_expires_at',           type: 'TIMESTAMP' },
  { table: 'product_types',         column: 'panel_flat_lay_images',       type: "TEXT DEFAULT '{}'" },
  { table: "product_types",         column: "aop_template_id",             type: "TEXT" },
  { table: "product_types",         column: "panel_mapping_template",      type: "TEXT" },
  { table: "aop_calibration_runs",  column: "export_url",                  type: "TEXT" },
];

/** One-time data fixes (idempotent WHERE clauses). */
const DATA_MIGRATIONS: string[] = [
  // Pin reference leggings blueprints to the locked template when still unset.
  `UPDATE product_types SET aop_template_id = 'leggings_v1'
   WHERE is_all_over_print = true
     AND printify_blueprint_id IN (256, 1050)
     AND (aop_template_id IS NULL OR aop_template_id = '')`,
  // Pin product 20 (unisex zip hoodie) to the new mesh-warp panel-mapping
  // template. When this is set, embed-design.tsx renders the new
  // HoodieAopPlacer instead of the legacy PatternCustomizer for this product.
  `UPDATE product_types SET panel_mapping_template = 'unisex-zip-hoodie-aop-L'
   WHERE id = 20
     AND (panel_mapping_template IS NULL OR panel_mapping_template = '')`,
  // Backfill materialized balances from the legacy customer columns.
  `INSERT INTO credit_balances (
      customer_id,
      credits,
      free_generations_used,
      discount_entitlement_cents,
      version,
      updated_at
    )
    SELECT
      id,
      COALESCE(credits, 0),
      COALESCE(free_generations_used, 0),
      0,
      0,
      NOW()
    FROM customers
    ON CONFLICT (customer_id) DO NOTHING`,
  // Backfill identity aliases from legacy user_id values.
  `INSERT INTO customer_aliases (customer_id, alias_type, alias_value, shop)
    SELECT
      id,
      'shopify',
      split_part(user_id, ':', 4),
      split_part(user_id, ':', 2) || ':' || split_part(user_id, ':', 3)
    FROM customers
    WHERE user_id LIKE 'shopify:%:%'
    ON CONFLICT DO NOTHING`,
  `INSERT INTO customer_aliases (customer_id, alias_type, alias_value, shop)
    SELECT
      id,
      'otp_email',
      split_part(user_id, ':', 4),
      split_part(user_id, ':', 2) || ':' || split_part(user_id, ':', 3)
    FROM customers
    WHERE user_id LIKE 'email:%:%'
    ON CONFLICT DO NOTHING`,
  // Replay legacy credit transactions into the append-only ledger with stable
  // synthetic idempotency keys. This is only for audit/history; balances are
  // backfilled from customers above to preserve the currently visible state.
  `INSERT INTO credit_ledger (
      customer_id,
      delta_credits,
      delta_entitlement_cents,
      reason,
      idempotency_key,
      external_ref,
      metadata,
      created_at
    )
    SELECT
      customer_id,
      amount,
      CASE WHEN type = 'purchase' AND amount > 0 THEN LEAST(100, COALESCE(price_in_cents, 0)) ELSE 0 END,
      type,
      'legacy:credit_transaction:' || id,
      CASE WHEN order_id IS NULL THEN NULL ELSE 'legacy_order:' || order_id END,
      jsonb_build_object('description', description, 'priceInCents', price_in_cents),
      created_at
    FROM credit_transactions
    ON CONFLICT (idempotency_key) DO NOTHING`,
  // Repair balances affected by legacy decrement-only paths that lowered
  // customers.credits without lowering credit_balances.credits. Purchases and
  // coupon grants dual-write both columns, so the legacy column being lower is
  // a strong signal that credits were already consumed.
  `UPDATE credit_balances cb
    SET credits = c.credits,
        updated_at = NOW(),
        version = cb.version + 1
    FROM customers c
    WHERE cb.customer_id = c.id
      AND c.credits < cb.credits`,
];

// ── Table creation ─────────────────────────────────────────────────────────────
// SQL matches shared/schema.ts exactly.

const TABLE_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "design_sku_mappings",
    sql: `
      CREATE TABLE IF NOT EXISTS "design_sku_mappings" (
        "id"                         SERIAL PRIMARY KEY,
        "shop_domain"                TEXT NOT NULL,
        "source_variant_id"          TEXT NOT NULL,
        "design_id"                  TEXT NOT NULL,
        "mockup_url"                 TEXT NOT NULL,
        "shadow_shopify_product_id"  TEXT NOT NULL,
        "shadow_shopify_variant_id"  TEXT NOT NULL,
        "created_at"                 TIMESTAMP DEFAULT NOW() NOT NULL,
        "expires_at"                 TIMESTAMP NOT NULL
      )
    `,
  },
  {
    name: "customizer_pages",
    sql: `
      CREATE TABLE IF NOT EXISTS "customizer_pages" (
        "id"                    VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        "shop"                  TEXT NOT NULL,
        "shopify_page_id"       TEXT,
        "handle"                TEXT NOT NULL,
        "title"                 TEXT NOT NULL,
        "base_product_id"       TEXT,
        "base_variant_id"       TEXT NOT NULL,
        "base_product_title"    TEXT,
        "base_variant_title"    TEXT,
        "base_product_price"    TEXT,
        "base_product_handle"   TEXT,
        "product_type_id"       INTEGER,
        "status"                TEXT NOT NULL DEFAULT 'active',
        "created_at"            TIMESTAMP DEFAULT NOW() NOT NULL,
        "updated_at"            TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `,
  },
  {
    name: "customizer_designs",
    sql: `
      CREATE TABLE IF NOT EXISTS "customizer_designs" (
        "id"                   VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        "shop"                 TEXT NOT NULL,
        "shopify_customer_id"  TEXT,
        "customer_key"         TEXT,
        "base_product_id"      TEXT,
        "base_variant_id"      TEXT NOT NULL,
        "base_title"           TEXT,
        "prompt"               TEXT NOT NULL,
        "options"              JSON,
        "artwork_url"          TEXT,
        "mockup_url"           TEXT,
        "mockup_urls"          JSON,
        "status"               TEXT NOT NULL DEFAULT 'GENERATING',
        "error_message"        TEXT,
        "created_at"           TIMESTAMP DEFAULT NOW() NOT NULL,
        "updated_at"           TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `,
  },
  {
    name: "generation_jobs",
    sql: `
      CREATE TABLE IF NOT EXISTS "generation_jobs" (
        "id"                  VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        "shop"                TEXT NOT NULL,
        "session_id"          TEXT,
        "customer_id"         TEXT,
        "status"              TEXT NOT NULL DEFAULT 'pending',
        "prompt"              TEXT NOT NULL,
        "style_preset"        TEXT,
        "size"                TEXT,
        "frame_color"         TEXT,
        "product_type_id"     TEXT,
        "reference_image_url" TEXT,
        "design_image_url"    TEXT,
        "thumbnail_url"       TEXT,
        "design_id"           TEXT,
        "error_message"       TEXT,
        "expires_at"          TIMESTAMP NOT NULL,
        "created_at"          TIMESTAMP DEFAULT NOW() NOT NULL,
        "updated_at"          TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `,
  },
  {
    name: "published_products",
    sql: `
      CREATE TABLE IF NOT EXISTS "published_products" (
        "id"                       VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        "shop"                     TEXT NOT NULL,
        "design_id"                TEXT NOT NULL,
        "customer_key"             TEXT,
        "shopify_product_id"       TEXT NOT NULL,
        "shopify_variant_id"       TEXT NOT NULL,
        "shopify_product_handle"   TEXT,
        "base_variant_id"          TEXT NOT NULL,
        "status"                   TEXT NOT NULL DEFAULT 'active',
        "created_at"               TIMESTAMP DEFAULT NOW() NOT NULL,
        "updated_at"               TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `,
  },
  {
    name: "customer_aliases",
    sql: `
      CREATE TABLE IF NOT EXISTS "customer_aliases" (
        "id"          SERIAL PRIMARY KEY,
        "customer_id" VARCHAR NOT NULL,
        "alias_type"  TEXT NOT NULL,
        "alias_value" TEXT NOT NULL,
        "shop"        TEXT,
        "created_at"  TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `,
  },
  {
    name: "credit_balances",
    sql: `
      CREATE TABLE IF NOT EXISTS "credit_balances" (
        "customer_id"                 VARCHAR PRIMARY KEY,
        "credits"                     INTEGER NOT NULL DEFAULT 0 CHECK ("credits" >= 0),
        "free_generations_used"       INTEGER NOT NULL DEFAULT 0 CHECK ("free_generations_used" >= 0),
        "discount_entitlement_cents"  INTEGER NOT NULL DEFAULT 0 CHECK ("discount_entitlement_cents" >= 0),
        "version"                     INTEGER NOT NULL DEFAULT 0,
        "updated_at"                  TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `,
  },
  {
    name: "credit_ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS "credit_ledger" (
        "id"                       SERIAL PRIMARY KEY,
        "customer_id"              VARCHAR NOT NULL,
        "delta_credits"            INTEGER NOT NULL,
        "delta_entitlement_cents"  INTEGER NOT NULL DEFAULT 0,
        "reason"                   TEXT NOT NULL,
        "idempotency_key"          TEXT NOT NULL UNIQUE,
        "external_ref"             TEXT,
        "metadata"                 JSONB,
        "created_at"               TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `,
  },
  {
    name: "stripe_events",
    sql: `
      CREATE TABLE IF NOT EXISTS "stripe_events" (
        "stripe_event_id" TEXT PRIMARY KEY,
        "type"            TEXT NOT NULL,
        "outcome"         TEXT,
        "received_at"     TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `,
  },
  {
    name: "order_discount_claims",
    sql: `
      CREATE TABLE IF NOT EXISTS "order_discount_claims" (
        "id"                  VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        "customer_id"         VARCHAR NOT NULL,
        "shopify_order_id"    TEXT UNIQUE,
        "shop"                TEXT NOT NULL,
        "entitlement_cents"   INTEGER NOT NULL,
        "status"              TEXT NOT NULL DEFAULT 'pending',
        "created_at"          TIMESTAMP DEFAULT NOW() NOT NULL,
        "updated_at"          TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `,
  },
  {
    name: "aop_calibration_runs",
    sql: `
      CREATE TABLE IF NOT EXISTS "aop_calibration_runs" (
        "id"                   VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        "product_type_id"      INTEGER,
        "blueprint_id"         INTEGER NOT NULL,
        "provider_id"          INTEGER NOT NULL,
        "variant_id"           INTEGER,
        "size"                 TEXT,
        "status"               TEXT NOT NULL DEFAULT 'pending',
        "printify_product_id"  TEXT,
        "printify_mockup_urls" JSONB,
        "print_areas_payload"  JSONB,
        "export_url"           TEXT,
        "error"                TEXT,
        "created_at"           TIMESTAMP DEFAULT NOW() NOT NULL,
        "updated_at"           TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `,
  },
  {
    name: "aop_calibration_panels",
    sql: `
      CREATE TABLE IF NOT EXISTS "aop_calibration_panels" (
        "id"                    VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        "run_id"                VARCHAR NOT NULL REFERENCES "aop_calibration_runs"("id") ON DELETE CASCADE,
        "panel_key"             TEXT NOT NULL,
        "width"                 INTEGER NOT NULL,
        "height"                INTEGER NOT NULL,
        "calibration_image_url" TEXT NOT NULL,
        "placement"             JSONB,
        "created_at"            TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `,
  },
  {
    name: "aop_projection_maps",
    sql: `
      CREATE TABLE IF NOT EXISTS "aop_projection_maps" (
        "id"              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        "product_type_id" INTEGER,
        "blueprint_id"    INTEGER NOT NULL,
        "provider_id"     INTEGER NOT NULL,
        "size"            TEXT,
        "map_json"        JSONB NOT NULL,
        "created_at"      TIMESTAMP DEFAULT NOW() NOT NULL,
        "updated_at"      TIMESTAMP DEFAULT NOW() NOT NULL
      )
    `,
  },
];

const INDEX_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "customer_aliases_alias_unique",
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS "customer_aliases_alias_unique"
      ON "customer_aliases" ("alias_type", "alias_value", COALESCE("shop", ''))`,
  },
  {
    name: "customer_aliases_customer_idx",
    sql: `CREATE INDEX IF NOT EXISTS "customer_aliases_customer_idx"
      ON "customer_aliases" ("customer_id")`,
  },
  {
    name: "credit_ledger_customer_created_idx",
    sql: `CREATE INDEX IF NOT EXISTS "credit_ledger_customer_created_idx"
      ON "credit_ledger" ("customer_id", "created_at")`,
  },
  {
    name: "order_discount_claims_customer_idx",
    sql: `CREATE INDEX IF NOT EXISTS "order_discount_claims_customer_idx"
      ON "order_discount_claims" ("customer_id")`,
  },
  {
    name: "aop_calibration_runs_product_type_idx",
    sql: `CREATE INDEX IF NOT EXISTS "aop_calibration_runs_product_type_idx"
      ON "aop_calibration_runs" ("product_type_id")`,
  },
  {
    name: "aop_calibration_runs_created_idx",
    sql: `CREATE INDEX IF NOT EXISTS "aop_calibration_runs_created_idx"
      ON "aop_calibration_runs" ("created_at")`,
  },
  {
    name: "aop_calibration_panels_run_idx",
    sql: `CREATE INDEX IF NOT EXISTS "aop_calibration_panels_run_idx"
      ON "aop_calibration_panels" ("run_id")`,
  },
  {
    name: "aop_calibration_panels_panel_key_idx",
    sql: `CREATE INDEX IF NOT EXISTS "aop_calibration_panels_panel_key_idx"
      ON "aop_calibration_panels" ("panel_key")`,
  },
  {
    name: "aop_projection_maps_product_type_idx",
    sql: `CREATE INDEX IF NOT EXISTS "aop_projection_maps_product_type_idx"
      ON "aop_projection_maps" ("product_type_id")`,
  },
  {
    name: "aop_projection_maps_blueprint_provider_idx",
    sql: `CREATE INDEX IF NOT EXISTS "aop_projection_maps_blueprint_provider_idx"
      ON "aop_projection_maps" ("blueprint_id", "provider_id")`,
  },
  {
    name: "aop_projection_maps_created_idx",
    sql: `CREATE INDEX IF NOT EXISTS "aop_projection_maps_created_idx"
      ON "aop_projection_maps" ("created_at")`,
  },
];

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runStartupMigrations(): Promise<void> {
  const tag = "[startup-migration]";
  console.log(`${tag} Running idempotent schema checks…`);

  let applied = 0;
  let errors  = 0;

  // 1) Create tables
  for (const m of TABLE_MIGRATIONS) {
    try {
      await pool.query(m.sql);
      applied++;
    } catch (err: any) {
      errors++;
      console.error(`${tag} FAILED creating table ${m.name}: ${err.message ?? err}`);
    }
  }

  // 2) Add indexes
  for (const m of INDEX_MIGRATIONS) {
    try {
      await pool.query(m.sql);
      applied++;
    } catch (err: any) {
      errors++;
      console.error(`${tag} FAILED creating index ${m.name}: ${err.message ?? err}`);
    }
  }

  // 3) Add columns
  for (const m of COLUMN_MIGRATIONS) {
    try {
      await pool.query(
        `ALTER TABLE "${m.table}" ADD COLUMN IF NOT EXISTS "${m.column}" ${m.type}`
      );
      applied++;
    } catch (err: any) {
      errors++;
      console.error(`${tag} FAILED adding column ${m.table}.${m.column}: ${err.message ?? err}`);
    }
  }

  // 4) Data migrations (safe re-runs)
  for (const sql of DATA_MIGRATIONS) {
    try {
      const r = await pool.query(sql);
      applied++;
      const n = (r as { rowCount?: number }).rowCount;
      if (n && n > 0) {
        console.log(`${tag} Data migration updated ${n} row(s)`);
      }
    } catch (err: any) {
      errors++;
      console.error(`${tag} FAILED data migration: ${err.message ?? err}`);
    }
  }

  const total = TABLE_MIGRATIONS.length + INDEX_MIGRATIONS.length + COLUMN_MIGRATIONS.length + DATA_MIGRATIONS.length;
  console.log(`${tag} Done. total=${total} applied=${applied} errors=${errors}`);
  if (errors > 0) {
    console.error(`${tag} WARNING: ${errors} statement(s) failed — some routes may be degraded.`);
  }
}
