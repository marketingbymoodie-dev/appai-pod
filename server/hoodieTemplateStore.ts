/**
 * Customer-facing hoodie panel-mapping template loader.
 *
 * Reads published templates from Supabase (uploaded by
 * `scripts/publish-hoodie-template.ts`) and caches them in memory so a brief
 * Supabase pause on the free tier doesn't break the storefront placer for
 * cached customers.
 *
 * Templates published here are *sanitised* copies — admin-only refs
 * (`productionPanelSrc`, `referenceOverlay`) are stripped on publish so the
 * customer renderer never tries to fetch admin URLs.
 *
 * **Dev fallback:** when running locally without Supabase configured (or
 * before the admin has run the publish script), the loader looks for the
 * raw admin authoring file in `tmp/hoodie-templates/templates/<localName>.json`
 * and serves that instead. This makes the storefront placer Just Work for
 * any developer who has the admin tool loaded — no publish round-trip
 * required for iteration. Only active when `NODE_ENV !== "production"`.
 */
import fs from "node:fs";
import path from "node:path";
import {
  isValidPublicTemplateName,
  resolveAdminSlugCandidatesForPublicName,
} from "@shared/aopTemplateNaming";
import { normalizeHoodieTemplate } from "@shared/hoodieTemplate";
import {
  isSupabaseHoodieTemplatesConfigured,
  listHoodieTemplatesBucketFiles,
  publicHoodieTemplateUrl,
} from "./supabaseHoodieTemplates";

export type PublishedHoodieTemplate = {
  /** Server-side handle (e.g. `unisex-zip-hoodie-aop-L`) — never shown to customers. */
  name: string;
  /** Raw template JSON (sanitised for customer use). */
  template: any;
  /** Resolved public CDN URLs for the per-view base mockup PNGs. */
  mockups: { front?: string | null; back?: string | null };
  /** Timestamp the cache entry was populated (ms since epoch). */
  cachedAt: number;
};

/**
 * Published templates are loaded from Supabase by name. Any valid slug that
 * has been Saved + published is served — no per-product code allowlist.
 */
export function isPublicTemplateName(name: string): boolean {
  return isValidPublicTemplateName(name);
}

/** @deprecated use listPublishedTemplateNames() for an up-to-date Supabase list */
export function listPublicTemplateNames(): string[] {
  return [];
}

/** List template basenames currently in Supabase `templates/` (published). */
export async function listPublishedTemplateNames(): Promise<string[]> {
  if (!isSupabaseHoodieTemplatesConfigured()) return [];
  const files = await listHoodieTemplatesBucketFiles("templates");
  return files
    .map((f) => f.name.replace(/\.json$/i, ""))
    .filter((name) => isValidPublicTemplateName(name))
    .sort();
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_GRACE_MS = 24 * 60 * 60 * 1000; // serve stale up to 24h if Supabase pauses
const NEGATIVE_TTL_MS = 30 * 1000; // remember 404s for 30s to avoid hot-looping

type CacheEntry = {
  ok: true;
  value: PublishedHoodieTemplate;
} | {
  ok: false;
  error: string;
  ts: number;
};

const cache = new Map<string, CacheEntry>();

async function fetchJson(url: string, signal?: AbortSignal): Promise<any> {
  const r = await fetch(url, { signal, cache: "no-store" });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}

/**
 * Map customer-facing template names back to the admin authoring file name on
 * disk (dev fallback). Legacy hoodies use explicit maps; new products try
 * underscore variants of the public kebab name.
 */
function resolveLocalAdminCandidates(publicName: string): string[] {
  return resolveAdminSlugCandidatesForPublicName(publicName);
}

/**
 * Mirror of the publish script's `sanitiseTemplateForPublish`. Strips
 * admin-only fields (`productionPanelSrc`, `referenceOverlay`) so the
 * customer renderer never sees URLs the storefront can't reach in production.
 */
function sanitiseAdminTemplate(t: any, publicName: string): any {
  const clone = JSON.parse(JSON.stringify(t));
  clone.name = publicName;
  if (clone.views && typeof clone.views === "object") {
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

/**
 * Dev fallback: read the admin's local authoring file and turn it into a
 * `PublishedHoodieTemplate` shape. Returns `null` if not in dev, no candidate
 * file exists, or the file is unreadable.
 */
function loadLocalAdminTemplate(publicName: string): PublishedHoodieTemplate | null {
  if (process.env.NODE_ENV === "production") return null;
  const baseDir = path.resolve(process.cwd(), "tmp", "hoodie-templates");
  const templatesDir = path.join(baseDir, "templates");
  const candidates = resolveLocalAdminCandidates(publicName);
  for (const localName of candidates) {
    const file = path.join(templatesDir, `${localName}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      const sanitised = sanitiseAdminTemplate(raw, publicName);
      const template = normalizeHoodieTemplate(sanitised);
      // Local admin saves already point mockup `src` at the dev endpoint
      // (`/api/dev/hoodie-mapper/mockups/...`) so we can pass them through
      // verbatim — they're served by the same dev process.
      return {
        name: publicName,
        template,
        mockups: {
          front: template?.views?.front?.mockup?.src ?? null,
          back: template?.views?.back?.mockup?.src ?? null,
        },
        cachedAt: Date.now(),
      };
    } catch (err: any) {
      console.warn(
        `[hoodieTemplateStore] Local admin template ${file} unreadable: ${err?.message || err}`,
      );
      return null;
    }
  }
  return null;
}

/**
 * Returns the published template by name. Throws if not in allowlist or
 * if both the cache and Supabase are unavailable.
 */
export async function getPublishedHoodieTemplate(
  name: string,
): Promise<PublishedHoodieTemplate> {
  if (!isValidPublicTemplateName(name)) {
    throw new Error(`Invalid template name "${name}"`);
  }

  const cached = cache.get(name);
  const now = Date.now();
  if (cached?.ok && now - cached.value.cachedAt < CACHE_TTL_MS) {
    return cached.value;
  }
  if (cached && !cached.ok && now - cached.ts < NEGATIVE_TTL_MS) {
    throw new Error(cached.error);
  }

  // Dev preference: when running locally, prefer the admin's authoring file
  // over Supabase. Lets the developer iterate on the template (in
  // `/admin/hoodie-template-mapper`) and see changes immediately on the
  // storefront placer without having to run the publish script. We
  // intentionally **don't cache** the result in dev so the very next page
  // refresh after Save reflects the new template — file I/O on a 80 KB JSON
  // is well below the request latency budget.
  if (process.env.NODE_ENV !== "production") {
    const local = loadLocalAdminTemplate(name);
    if (local) return local;
  }

  if (!isSupabaseHoodieTemplatesConfigured()) {
    if (cached?.ok && now - cached.value.cachedAt < STALE_GRACE_MS) {
      // Serve stale during outages.
      return cached.value;
    }
    const err = "Supabase storage not configured for hoodie templates";
    cache.set(name, { ok: false, error: err, ts: now });
    throw new Error(err);
  }

  const jsonUrl = publicHoodieTemplateUrl(`templates/${name}.json`);
  if (!jsonUrl) throw new Error("Could not resolve public template URL");

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let template: any;
    try {
      template = await fetchJson(jsonUrl, ctrl.signal);
    } finally {
      clearTimeout(timer);
    }

    const value: PublishedHoodieTemplate = {
      name,
      template: normalizeHoodieTemplate(template),
      mockups: {
        front: template?.views?.front?.mockup?.src ?? null,
        back: template?.views?.back?.mockup?.src ?? null,
      },
      cachedAt: now,
    };
    cache.set(name, { ok: true, value });
    return value;
  } catch (err: any) {
    // Fall back to stale cache during transient Supabase outages (free-tier pause etc).
    if (cached?.ok && now - cached.value.cachedAt < STALE_GRACE_MS) {
      console.warn(
        `[hoodieTemplateStore] Supabase fetch failed for ${name}, serving stale cache: ${err?.message}`,
      );
      return cached.value;
    }
    const msg = `Failed to load template "${name}": ${err?.message || err}`;
    cache.set(name, { ok: false, error: msg, ts: now });
    throw new Error(msg);
  }
}

/** Test/admin helper. Forgets one template (or all) so the next load re-fetches. */
export function invalidateHoodieTemplateCache(name?: string): void {
  if (name) cache.delete(name);
  else cache.clear();
}
