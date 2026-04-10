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

  // 2) Add columns
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

  const total = TABLE_MIGRATIONS.length + COLUMN_MIGRATIONS.length;
  console.log(`${tag} Done. total=${total} applied=${applied} errors=${errors}`);
  if (errors > 0) {
    console.error(`${tag} WARNING: ${errors} statement(s) failed — some routes may be degraded.`);
  }
}
