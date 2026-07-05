/**
 * Publish a saved hoodie panel-mapping template (and its base mockup PNGs)
 * from `tmp/hoodie-templates/` up to Supabase storage.
 *
 * USAGE
 *   npx tsx scripts/publish-hoodie-template.ts --source pullover-hoodie-aop-L
 *   npm run publish:hoodie -- --source pullover-hoodie-aop-L
 *
 * Loads `.env` from the project root automatically (same as `npm run dev`).
 * Public name is derived automatically from the admin slug — see
 * `resolvePublicTemplateName()` in `@shared/aopTemplateNaming`.
 *
 * Easier alternative: open Hoodie Template Mapper and click **Publish** (or
 * **Save**, which auto-publishes when Supabase env vars are loaded).
 */
import "../server/load-env";
import { autoPublishHoodieTemplate } from "../server/hoodieTemplateAutoPublish";
import { publicHoodieTemplateUrl } from "../server/supabaseHoodieTemplates";

function parseAdminName(argv: string[]): string {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === "--source" || k === "--name" || k === "--target") {
      args[k.slice(2)] = argv[++i] ?? "";
    }
  }
  const name = args.source || args.name;
  if (!name) {
    throw new Error(
      "Usage: --source <admin-slug>  (e.g. pullover-hoodie-aop-L)\n" +
        "Legacy --target is ignored — public name is resolved server-side.",
    );
  }
  if (args.target && args.target !== name) {
    // eslint-disable-next-line no-console
    console.warn(
      `[publish] --target ${args.target} is ignored; public name is resolved from admin slug.`,
    );
  }
  return name;
}

async function main() {
  const adminName = parseAdminName(process.argv);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the project .env file " +
        "(copy from Railway → Variables). Restart is not required for this script once .env exists.\n" +
        "Or use Hoodie Template Mapper → Publish while `npm run dev` is running.",
    );
  }

  const result = await autoPublishHoodieTemplate(adminName);
  if (result.ok) {
    console.log(`[publish] DONE → ${result.publicName} (${result.elapsedMs}ms)`);
    console.log(`  JSON: ${result.jsonUrl}`);
    if (result.uploadedMockups.length > 0) {
      console.log(`  Mockups uploaded: ${result.uploadedMockups.join(", ")}`);
    } else {
      console.log("  Mockups unchanged (skipped re-upload — JSON still refreshed)");
    }
    console.log(`  Storefront: GET /api/storefront/hoodie-template/${result.publicName}`);
    console.log(`  Public URL: ${publicHoodieTemplateUrl(`templates/${result.publicName}.json`)}`);
    return;
  }
  if ("skipped" in result && result.skipped) {
    throw new Error(result.reason);
  }
  throw new Error(("error" in result && result.error) || "Publish failed");
}

main().catch((err) => {
  console.error("[publish] FAILED:", err?.message || err);
  process.exit(1);
});
