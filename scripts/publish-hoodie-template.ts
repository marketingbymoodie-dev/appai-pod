/**
 * Publish a saved hoodie panel-mapping template (and its base mockup PNGs)
 * from the local admin tool's working directory (`tmp/hoodie-templates/`)
 * up to Supabase storage so the production storefront placer can fetch it.
 *
 * USAGE
 *   npx tsx scripts/publish-hoodie-template.ts \
 *     --source zip-hoodie-aop-L \
 *     --target unisex-zip-hoodie-aop-L
 *
 *   # or short form when source==target:
 *   npx tsx scripts/publish-hoodie-template.ts --name unisex-zip-hoodie-aop-L
 *
 * What it does:
 *   1. Loads `tmp/hoodie-templates/templates/<source>.json`.
 *   2. Strips admin-only fields (productionPanelSrc, referenceOverlay) so the
 *      customer-facing copy never points at /api/dev/* URLs that 404 in prod.
 *   3. Uploads the two view-level mockup PNGs (front.png, back.png) to the
 *      `hoodie-templates` bucket under `mockups/<target>-{front,back}.png`.
 *   4. Rewrites the template's `views.{front,back}.mockup.src` to the new
 *      Supabase public URLs.
 *   5. Renames the template (`name`) to <target> and uploads the rewritten
 *      JSON to `templates/<target>.json` in the same bucket.
 *
 * Idempotent — every upload is upsert. Safe to re-run after iterating in the
 * admin tool. Run from your local machine where `tmp/hoodie-templates/` lives.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ensureHoodieTemplatesBucket,
  uploadToHoodieTemplatesBucket,
  publicHoodieTemplateUrl,
} from "../server/supabaseHoodieTemplates";

type Args = { source: string; target: string };

function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === "--source" || k === "--target" || k === "--name") {
      args[k.slice(2)] = argv[++i] ?? "";
    }
  }
  if (args.name && !args.source) args.source = args.name;
  if (args.name && !args.target) args.target = args.name;
  if (!args.source || !args.target) {
    throw new Error("Usage: --source <name> --target <name>  (or --name <name> for both)");
  }
  return { source: args.source, target: args.target };
}

const ROOT = process.cwd();
const TEMPLATES_DIR = path.resolve(ROOT, "tmp", "hoodie-templates", "templates");
const MOCKUPS_DIR = path.resolve(ROOT, "tmp", "hoodie-templates", "mockups");

function readJsonFile(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function sanitiseTemplateForPublish(t: any, target: string): any {
  // Deep clone so we don't mutate the on-disk admin copy.
  const clone = JSON.parse(JSON.stringify(t));
  clone.name = target;
  if (clone.views) {
    for (const view of Object.values<any>(clone.views)) {
      // Strip admin reference overlay (admin-only crossfade aid).
      if ("referenceOverlay" in view) delete view.referenceOverlay;
      if (Array.isArray(view.layers)) {
        for (const layer of view.layers) {
          // Customer placer never reads productionPanelSrc — that's the
          // calibration triangulated PNG used during admin mesh editing.
          if ("productionPanelSrc" in layer) delete layer.productionPanelSrc;
        }
      }
    }
  }
  return clone;
}

async function main() {
  const { source, target } = parseArgs(process.argv);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (load from .env).",
    );
  }

  const templatePath = path.join(TEMPLATES_DIR, `${source}.json`);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found: ${templatePath}`);
  }
  const tpl = readJsonFile(templatePath);

  await ensureHoodieTemplatesBucket();
  console.log(`[publish] bucket ready`);

  // Upload mockup PNGs (front + back)
  const newMockupUrls: Record<string, string> = {};
  for (const view of ["front", "back"] as const) {
    const candidates = [
      path.join(MOCKUPS_DIR, `${source}-${view}.png`),
      path.join(MOCKUPS_DIR, `${target}-${view}.png`),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) {
      console.warn(`[publish] missing mockup for ${view}: tried ${candidates.join(", ")}`);
      continue;
    }
    const buf = fs.readFileSync(found);
    const filename = `mockups/${target}-${view}.png`;
    const url = await uploadToHoodieTemplatesBucket(filename, buf, "image/png");
    newMockupUrls[view] = url;
    console.log(`[publish] uploaded ${view} mockup → ${url}`);
  }

  // Sanitise + rewrite mockup URLs
  const sanitised = sanitiseTemplateForPublish(tpl, target);
  for (const view of ["front", "back"] as const) {
    const url = newMockupUrls[view];
    if (!url) continue;
    if (!sanitised.views?.[view]) continue;
    if (sanitised.views[view].mockup && typeof sanitised.views[view].mockup === "object") {
      sanitised.views[view].mockup.src = url;
    } else {
      sanitised.views[view].mockup = { src: url };
    }
  }

  // Upload template JSON
  const jsonBuf = Buffer.from(JSON.stringify(sanitised, null, 2), "utf-8");
  const jsonFilename = `templates/${target}.json`;
  const jsonUrl = await uploadToHoodieTemplatesBucket(
    jsonFilename,
    jsonBuf,
    "application/json",
  );
  console.log(`[publish] uploaded template JSON → ${jsonUrl}`);

  console.log(`\n[publish] DONE`);
  console.log(`  Template: ${publicHoodieTemplateUrl(jsonFilename)}`);
  console.log(`  Frontend will load via: GET /api/storefront/hoodie-template/${target}`);
}

main().catch((err) => {
  console.error("[publish] FAILED:", err?.message || err);
  process.exit(1);
});
