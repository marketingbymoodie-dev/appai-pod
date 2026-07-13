/**
 * One-shot migration: upload local `tmp/hoodie-templates/` authoring files
 * into Supabase `drafts/*` so they appear in the in-app AOP Panel Mapper
 * (`/admin/hoodie-template-mapper`), then re-publish storefront templates.
 *
 * USAGE
 *   npx tsx scripts/import-hoodie-drafts-to-supabase.ts
 *   npx tsx scripts/import-hoodie-drafts-to-supabase.ts --source zip-hoodie-aop-L
 *   npm run import:hoodie-drafts
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env`.
 */
import fs from "node:fs";
import path from "node:path";
import "../server/load-env";
import {
  LOCAL_MOCKUPS_DIR,
  LOCAL_REFERENCE_OVERLAYS_DIR,
  LOCAL_SOURCE_PANELS_DIR,
  LOCAL_TEMPLATES_DIR,
} from "../server/aopMapperStorage";
import { autoPublishHoodieTemplate } from "../server/hoodieTemplateAutoPublish";
import {
  ensureHoodieTemplatesBucket,
  isSupabaseHoodieTemplatesConfigured,
  uploadToHoodieTemplatesBucket,
} from "../server/supabaseHoodieTemplates";

const DEV_MAPPER_PREFIX = "/api/dev/hoodie-mapper/";
const PLATFORM_MAPPER_PREFIX = "/api/platform/aop-mapper/";

type AssetKind = "mockups" | "source-panels" | "reference-overlays";

function parseArgs(argv: string[]): { sources: string[]; skipPublish: boolean } {
  const sources: string[] = [];
  let skipPublish = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source" || arg === "--name") {
      const v = argv[++i];
      if (v) sources.push(v.replace(/\.json$/i, ""));
    } else if (arg === "--skip-publish") {
      skipPublish = true;
    }
  }
  return { sources, skipPublish };
}

function contentTypeForFile(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".json") return "application/json";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function rewriteMapperUrls(text: string): string {
  return text.split(DEV_MAPPER_PREFIX).join(PLATFORM_MAPPER_PREFIX);
}

async function uploadDirFiles(
  kind: AssetKind,
  dir: string,
  label: string,
): Promise<number> {
  if (!fs.existsSync(dir)) {
    console.log(`[import] skip ${label} — directory missing: ${dir}`);
    return 0;
  }
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith("."));
  let count = 0;
  for (const filename of files) {
    const full = path.join(dir, filename);
    if (!fs.statSync(full).isFile()) continue;
    const buf = fs.readFileSync(full);
    const remote = `drafts/${kind}/${filename}`;
    await uploadToHoodieTemplatesBucket(remote, buf, contentTypeForFile(filename));
    count += 1;
    console.log(`[import]   ${remote} (${(buf.length / 1024).toFixed(0)} KB)`);
  }
  return count;
}

async function uploadTemplates(sources: string[]): Promise<string[]> {
  if (!fs.existsSync(LOCAL_TEMPLATES_DIR)) {
    throw new Error(`Templates directory not found: ${LOCAL_TEMPLATES_DIR}`);
  }
  const allJson = fs
    .readdirSync(LOCAL_TEMPLATES_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."));
  const names = sources.length > 0
    ? sources
    : allJson.map((f) => f.replace(/\.json$/i, ""));

  const uploaded: string[] = [];
  for (const name of names) {
    const file = path.join(LOCAL_TEMPLATES_DIR, `${name}.json`);
    if (!fs.existsSync(file)) {
      console.warn(`[import] skip template "${name}" — file not found`);
      continue;
    }
    const raw = fs.readFileSync(file, "utf-8");
    const rewritten = rewriteMapperUrls(raw);
    // Validate JSON
    JSON.parse(rewritten);
    const remote = `drafts/templates/${name}.json`;
    await uploadToHoodieTemplatesBucket(
      remote,
      Buffer.from(rewritten, "utf-8"),
      "application/json",
    );
    uploaded.push(name);
    console.log(`[import]   ${remote} (URLs → platform mapper)`);
  }
  return uploaded;
}

async function main() {
  const { sources, skipPublish } = parseArgs(process.argv);

  if (!isSupabaseHoodieTemplatesConfigured()) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env (copy from Railway → Variables).",
    );
  }

  console.log("[import] Ensuring hoodie-templates bucket…");
  await ensureHoodieTemplatesBucket();

  console.log("[import] Uploading mockups → drafts/mockups/ …");
  const mockupCount = await uploadDirFiles("mockups", LOCAL_MOCKUPS_DIR, "mockups");

  console.log("[import] Uploading source panels → drafts/source-panels/ …");
  const panelCount = await uploadDirFiles(
    "source-panels",
    LOCAL_SOURCE_PANELS_DIR,
    "source-panels",
  );

  console.log("[import] Uploading reference overlays → drafts/reference-overlays/ …");
  const overlayCount = await uploadDirFiles(
    "reference-overlays",
    LOCAL_REFERENCE_OVERLAYS_DIR,
    "reference-overlays",
  );

  console.log("[import] Uploading templates → drafts/templates/ …");
  const templateNames = await uploadTemplates(sources);

  console.log(
    `[import] Uploaded ${templateNames.length} template(s), ${mockupCount} mockup(s), ${panelCount} source panel(s), ${overlayCount} overlay(s).`,
  );

  if (skipPublish) {
    console.log("[import] --skip-publish set; drafts only. Open /admin/hoodie-template-mapper to verify.");
    return;
  }

  console.log("[import] Re-publishing storefront templates …");
  for (const name of templateNames) {
    const result = await autoPublishHoodieTemplate(name);
    if (result.ok) {
      console.log(
        `[import]   publish OK ${name} → ${result.publicName} (mockups: ${result.uploadedMockups.join(", ") || "unchanged"})`,
      );
    } else if ("skipped" in result && result.skipped) {
      console.warn(`[import]   publish skipped ${name}: ${result.reason}`);
    } else {
      console.error(`[import]   publish FAILED ${name}: ${("error" in result && result.error) || "unknown"}`);
    }
  }

  console.log("[import] DONE — open AOP Panel Mapper in Shopify admin; templates should appear in the left sidebar.");
}

main().catch((err) => {
  console.error("[import] FAILED:", err?.message || err);
  process.exit(1);
});
