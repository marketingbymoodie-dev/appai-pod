/**
 * Upload size-keyed comforter / wall-decal blanks to Supabase and apply them
 * to every product_types row for those Printify blueprints.
 *
 *   npx tsx scripts/seed-catalog-size-blanks.ts
 *
 * Requires DATABASE_URL + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Load .env before any module that snapshots process.env at import time.
import "../server/load-env";
import pg from "pg";
import {
  applyCatalogSizeBlanks,
  CATALOG_SIZE_BLANK_BLUEPRINTS,
  CATALOG_SIZE_BLANK_STORAGE_PATHS,
  type CatalogSizeBlankBlueprintId,
} from "../shared/catalogSizeBlanks";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "scripts", "assets", "catalog-blanks");

const LOCAL_DIRS: Record<CatalogSizeBlankBlueprintId, string> = {
  [CATALOG_SIZE_BLANK_BLUEPRINTS.cottonComforter]: path.join(ASSETS, "comforter"),
  [CATALOG_SIZE_BLANK_BLUEPRINTS.wallDecals]: path.join(ASSETS, "wall-decals"),
};

async function main() {
  // Dynamic import so supabaseDesigns reads env after load-env completes.
  const {
    isSupabaseDesignsConfigured,
    uploadDesignFileToSupabase,
    getSupabaseDesignPublicUrl,
  } = await import("../server/supabaseDesigns");

  if (!isSupabaseDesignsConfigured()) {
    console.error("Supabase designs bucket not configured");
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL missing");
    process.exit(1);
  }

  async function uploadBlueprintBlanks(
    blueprintId: CatalogSizeBlankBlueprintId,
  ): Promise<Record<string, string>> {
    const paths = CATALOG_SIZE_BLANK_STORAGE_PATHS[blueprintId];
    const localDir = LOCAL_DIRS[blueprintId];
    const out: Record<string, string> = {};

    for (const [sizeKey, storagePath] of Object.entries(paths)) {
      const localFile = path.join(localDir, `${sizeKey}.png`);
      if (!fs.existsSync(localFile)) {
        throw new Error(`Missing local blank: ${localFile}`);
      }
      const buf = fs.readFileSync(localFile);
      const url = await uploadDesignFileToSupabase({
        buffer: buf,
        filename: storagePath,
        contentType: "image/png",
      });
      if (!url) {
        const fallback = getSupabaseDesignPublicUrl(storagePath);
        if (!fallback) throw new Error("Supabase designs upload failed");
        out[sizeKey] = fallback;
      } else {
        out[sizeKey] = url;
      }
      console.log(`[seed] uploaded ${storagePath} → ${out[sizeKey]}`);
    }
    return out;
  }

  const byBlueprint: Record<number, Record<string, string>> = {};
  for (const bp of Object.values(CATALOG_SIZE_BLANK_BLUEPRINTS)) {
    byBlueprint[bp] = await uploadBlueprintBlanks(bp);
  }
  const pool = new pg.Pool({
    connectionString: dbUrl,
    ssl: dbUrl.includes("rlwy.net") ? { rejectUnauthorized: false } : false,
  });

  const r = await pool.query(
    `SELECT id, name, printify_blueprint_id, base_mockup_images
     FROM product_types
     WHERE printify_blueprint_id = ANY($1::int[])`,
    [Object.values(CATALOG_SIZE_BLANK_BLUEPRINTS)],
  );

  let updated = 0;
  for (const row of r.rows) {
    const bp = Number(row.printify_blueprint_id);
    const blanks = byBlueprint[bp];
    if (!blanks) continue;
    const current =
      typeof row.base_mockup_images === "string"
        ? JSON.parse(row.base_mockup_images || "{}")
        : row.base_mockup_images || {};
    const next = applyCatalogSizeBlanks(current, blanks);
    await pool.query(
      `UPDATE product_types SET base_mockup_images = $1 WHERE id = $2`,
      [JSON.stringify(next), row.id],
    );
    updated += 1;
    console.log(
      `[seed] updated product_types id=${row.id} "${row.name}" bp=${bp} sizes=${Object.keys(blanks).join(",")}`,
    );
  }

  console.log(`[seed] done. rows=${r.rows.length} updated=${updated}`);
  console.log("[seed] blanksBySize URLs (for import defaults):");
  console.log(JSON.stringify(byBlueprint, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
