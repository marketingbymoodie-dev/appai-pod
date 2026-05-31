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
 */
import {
  isSupabaseHoodieTemplatesConfigured,
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
 * Allowlist of template names the storefront endpoint will serve. Anything
 * not listed here returns 404 — prevents enumeration of internal admin
 * templates that may exist on the bucket but aren't customer-ready.
 */
const PUBLIC_TEMPLATE_NAMES = new Set<string>([
  "unisex-zip-hoodie-aop-L",
]);

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

export function isPublicTemplateName(name: string): boolean {
  return PUBLIC_TEMPLATE_NAMES.has(name);
}

export function listPublicTemplateNames(): string[] {
  return Array.from(PUBLIC_TEMPLATE_NAMES);
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<any> {
  const r = await fetch(url, { signal, cache: "no-store" });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}

/**
 * Returns the published template by name. Throws if not in allowlist or
 * if both the cache and Supabase are unavailable.
 */
export async function getPublishedHoodieTemplate(
  name: string,
): Promise<PublishedHoodieTemplate> {
  if (!isPublicTemplateName(name)) {
    throw new Error(`Template "${name}" is not in the public allowlist`);
  }

  const cached = cache.get(name);
  const now = Date.now();
  if (cached?.ok && now - cached.value.cachedAt < CACHE_TTL_MS) {
    return cached.value;
  }
  if (cached && !cached.ok && now - cached.ts < NEGATIVE_TTL_MS) {
    throw new Error(cached.error);
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
      template,
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
