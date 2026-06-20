/**
 * Auto-publish a hoodie panel-mapping template from the admin authoring tool
 * up to Supabase storage in the same action as the admin's "Save" click —
 * eliminating the manual `npx tsx scripts/publish-hoodie-template.ts` step.
 *
 * Mirrors what the publish script does:
 *   1. Read `tmp/hoodie-templates/templates/<adminName>.json`.
 *   2. Resolve the public-facing name (e.g. zip-hoodie-aop-L → unisex-zip-hoodie-aop-L).
 *   3. For each view (front/back), if a local mockup PNG exists AND its mtime
 *      is newer than what we last uploaded, re-upload it. Otherwise skip
 *      (avoids burning a few MB of bandwidth on every Save when only the
 *      mesh / polygon JSON has changed).
 *   4. Sanitise the JSON (strip admin-only fields), rewrite mockup URLs to
 *      the Supabase public URLs, rename to the public name, upload it.
 *   5. Invalidate the in-memory hoodieTemplateStore cache for this template
 *      so the next storefront request gets the fresh JSON.
 *
 * Best-effort: if Supabase isn't configured (dev without env vars) or the
 * admin name doesn't map to a public name, returns `{ ok: false, skipped: true }`
 * without throwing. The caller treats that as "nothing to do" and the user's
 * local Save still succeeds.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ensureHoodieTemplatesBucket,
  uploadToHoodieTemplatesBucket,
  publicHoodieTemplateUrl,
  isSupabaseHoodieTemplatesConfigured,
} from "./supabaseHoodieTemplates";
import { invalidateHoodieTemplateCache } from "./hoodieTemplateStore";

/**
 * Inverse of `DEV_LOCAL_NAME` in `hoodieTemplateStore.ts`. Maps the admin
 * authoring file name (e.g. `zip-hoodie-aop-L`) to its public published name
 * (e.g. `unisex-zip-hoodie-aop-L`). Templates not listed here are not
 * auto-published.
 */
const ADMIN_TO_PUBLIC_NAME: Record<string, string> = {
  "zip-hoodie-aop-L": "unisex-zip-hoodie-aop-L",
  "pullover-hoodie-aop-L": "unisex-pullover-hoodie-aop-L",
};

const ROOT = process.cwd();
const TEMPLATES_DIR = path.resolve(ROOT, "tmp", "hoodie-templates", "templates");
const MOCKUPS_DIR = path.resolve(ROOT, "tmp", "hoodie-templates", "mockups");
/**
 * Tracks when each mockup PNG was last uploaded. Compared against on-disk
 * mtime to skip redundant re-uploads. Lives next to the templates directory.
 *
 *   {
 *     "unisex-zip-hoodie-aop-L": { "front": 1717220000000, "back": 1717220001000 }
 *   }
 */
const PUBLISHED_STATE_FILE = path.resolve(
  ROOT,
  "tmp",
  "hoodie-templates",
  ".published.json",
);

type PublishedState = Record<string, { front?: number; back?: number }>;

function readPublishedState(): PublishedState {
  try {
    if (!fs.existsSync(PUBLISHED_STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(PUBLISHED_STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writePublishedState(state: PublishedState): void {
  try {
    fs.mkdirSync(path.dirname(PUBLISHED_STATE_FILE), { recursive: true });
    fs.writeFileSync(PUBLISHED_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    // Non-fatal: just means we'll re-upload mockups on the next save.
    // eslint-disable-next-line no-console
    console.warn(
      `[hoodieTemplateAutoPublish] Failed to write ${PUBLISHED_STATE_FILE}: ${
        (err as any)?.message || err
      }`,
    );
  }
}

/**
 * Resolve a mockup PNG on disk for publish. Prefers `{admin|public}-{view}.png`,
 * then falls back to whatever file the template JSON references (e.g. reusing
 * `zip-hoodie-aop-L-back.png` for a pullover fork).
 */
export function resolveLocalMockupPathForPublish(
  adminName: string,
  publicName: string,
  view: "front" | "back",
  template: { views?: Record<string, { mockup?: { src?: string | null } | null }> },
): string | null {
  const candidates = [
    path.join(MOCKUPS_DIR, `${adminName}-${view}.png`),
    path.join(MOCKUPS_DIR, `${publicName}-${view}.png`),
  ];
  const named = candidates.find((p) => fs.existsSync(p));
  if (named) return named;

  const src = template.views?.[view]?.mockup?.src;
  if (!src || typeof src !== "string") return null;

  // Dev mapper URL: /api/dev/hoodie-mapper/mockups/zip-hoodie-aop-L-back.png
  const devMatch = src.match(/\/mockups\/([^?#]+)/);
  if (devMatch?.[1]) {
    const fromDev = path.join(MOCKUPS_DIR, decodeURIComponent(devMatch[1]));
    if (fs.existsSync(fromDev)) return fromDev;
  }

  // Absolute or relative filesystem path (rare).
  if (src.startsWith("/") || /^[A-Za-z]:[\\/]/.test(src)) {
    if (fs.existsSync(src)) return src;
  }

  return null;
}

export function sanitiseTemplateForPublish(t: any, publicName: string): any {
  const clone = JSON.parse(JSON.stringify(t));
  clone.name = publicName;
  if (clone.views) {
    for (const view of Object.values<any>(clone.views)) {
      if (!view || typeof view !== "object") continue;
      if ("referenceOverlay" in view) delete view.referenceOverlay;
      if (Array.isArray(view.layers)) {
        for (const layer of view.layers) {
          if (layer && typeof layer === "object" && "productionPanelSrc" in layer) {
            delete layer.productionPanelSrc;
          }
        }
      }
    }
  }
  return clone;
}

export type AutoPublishResult =
  | {
      ok: true;
      publicName: string;
      jsonUrl: string;
      mockups: { front?: string; back?: string };
      uploadedMockups: string[];
      elapsedMs: number;
    }
  | {
      ok: false;
      skipped: true;
      reason: string;
    }
  | {
      ok: false;
      skipped: false;
      error: string;
      elapsedMs: number;
    };

/**
 * Sanitise + upload one template (and its mockups, if changed) to Supabase.
 *
 * @param adminName  The admin authoring name (the basename used by Save in the
 *                   mapper UI). Must be present in `ADMIN_TO_PUBLIC_NAME`.
 */
export async function autoPublishHoodieTemplate(
  adminName: string,
): Promise<AutoPublishResult> {
  const t0 = Date.now();
  const publicName = ADMIN_TO_PUBLIC_NAME[adminName];
  if (!publicName) {
    return {
      ok: false,
      skipped: true,
      reason: `Admin template "${adminName}" has no public mapping; not auto-published.`,
    };
  }
  if (!isSupabaseHoodieTemplatesConfigured()) {
    return {
      ok: false,
      skipped: true,
      reason:
        "Supabase is not configured (missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY). Local save succeeded; skipping publish.",
    };
  }

  const templatePath = path.join(TEMPLATES_DIR, `${adminName}.json`);
  if (!fs.existsSync(templatePath)) {
    return {
      ok: false,
      skipped: true,
      reason: `Local template not found: ${templatePath}`,
    };
  }

  try {
    await ensureHoodieTemplatesBucket();

    const tpl = JSON.parse(fs.readFileSync(templatePath, "utf-8"));

    const publishedState = readPublishedState();
    const recorded = publishedState[publicName] ?? {};
    const uploadedMockups: string[] = [];
    const newMockupUrls: { front?: string; back?: string } = {};

    for (const view of ["front", "back"] as const) {
      const found = resolveLocalMockupPathForPublish(adminName, publicName, view, tpl);
      if (!found) continue;

      const stat = fs.statSync(found);
      const mtime = stat.mtimeMs;
      const filename = `mockups/${publicName}-${view}.png`;

      if ((recorded[view] ?? 0) >= mtime) {
        // Already uploaded a copy at this mtime or newer — re-use the URL.
        const existing = publicHoodieTemplateUrl(filename);
        if (existing) newMockupUrls[view] = existing;
        continue;
      }

      const buf = fs.readFileSync(found);
      const url = await uploadToHoodieTemplatesBucket(filename, buf, "image/png");
      newMockupUrls[view] = url;
      uploadedMockups.push(`${view} (${(buf.length / 1024).toFixed(0)} KB)`);
      recorded[view] = mtime;
    }

    const sanitised = sanitiseTemplateForPublish(tpl, publicName);
    for (const view of ["front", "back"] as const) {
      const url = newMockupUrls[view];
      if (!url || !sanitised.views?.[view]) continue;
      if (
        sanitised.views[view].mockup &&
        typeof sanitised.views[view].mockup === "object"
      ) {
        sanitised.views[view].mockup.src = url;
      } else {
        sanitised.views[view].mockup = { src: url };
      }
    }

    const jsonBuf = Buffer.from(JSON.stringify(sanitised, null, 2), "utf-8");
    const jsonFilename = `templates/${publicName}.json`;
    const jsonUrl = await uploadToHoodieTemplatesBucket(
      jsonFilename,
      jsonBuf,
      "application/json",
    );

    publishedState[publicName] = recorded;
    writePublishedState(publishedState);

    invalidateHoodieTemplateCache(publicName);

    return {
      ok: true,
      publicName,
      jsonUrl,
      mockups: newMockupUrls,
      uploadedMockups,
      elapsedMs: Date.now() - t0,
    };
  } catch (err: any) {
    return {
      ok: false,
      skipped: false,
      error: err?.message || String(err),
      elapsedMs: Date.now() - t0,
    };
  }
}
