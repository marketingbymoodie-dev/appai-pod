/**
 * Admin mapper slug ↔ storefront / catalog template name.
 *
 * New products: admin slug is auto-derived to a lowercase kebab public name
 * on Save (e.g. Faux_Suede_Square_Pillow → faux-suede-square-pillow).
 * Legacy hoodie entries keep explicit overrides so existing catalog rows
 * don't break.
 */
import { AOP_TEMPLATE_SLUG_RE, isValidAopTemplateSlug } from "./hoodieTemplate";

/** @deprecated prefer LEGACY_ADMIN_TO_PUBLIC_NAME — kept for scripts/docs. */
export const ADMIN_TO_PUBLIC_NAME: Record<string, string> = {
  "zip-hoodie-aop-L": "unisex-zip-hoodie-aop-L",
  "pullover-hoodie-aop-L": "unisex-pullover-hoodie-aop-L",
  "sweatshirt-aop-L": "unisex-sweatshirt-aop-L",
  Spun_Polyester: "spun-polyester-pillow-wrap-L",
};

export const LEGACY_ADMIN_TO_PUBLIC_NAME: Record<string, string> = ADMIN_TO_PUBLIC_NAME;

/** Storefront + Operator Catalog `panelMappingTemplate` must match this pattern. */
export function isValidPublicTemplateName(name: string): boolean {
  return isValidAopTemplateSlug(name);
}

/**
 * Derive the published storefront name from an admin authoring slug.
 * Underscores → dashes, lowercased, collapsed; legacy hoodies keep explicit maps.
 */
export function slugifyAdminToPublicName(adminName: string): string {
  const raw = adminName.trim();
  if (!raw) return "";
  const slug = raw
    .replace(/_/g, "-")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return slug;
}

/** Resolve admin Save slug → Supabase / storefront template name. */
export function resolvePublicTemplateName(adminName: string): string {
  const trimmed = adminName.trim();
  const legacy = LEGACY_ADMIN_TO_PUBLIC_NAME[trimmed];
  if (legacy) return legacy;
  const derived = slugifyAdminToPublicName(trimmed);
  if (derived && isValidPublicTemplateName(derived)) return derived;
  return trimmed.replace(/_/g, "-").slice(0, 64);
}

/** Inverse lookup for dev local-file fallback. */
export function resolveAdminSlugCandidatesForPublicName(publicName: string): string[] {
  const candidates = new Set<string>();
  candidates.add(publicName);
  for (const [admin, pub] of Object.entries(LEGACY_ADMIN_TO_PUBLIC_NAME)) {
    if (pub === publicName) candidates.add(admin);
  }
  if (publicName.startsWith("unisex-")) {
    candidates.add(publicName.slice("unisex-".length));
  }
  candidates.add(publicName.replace(/-/g, "_"));
  const titleUnderscore = publicName
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
    .join("_");
  if (titleUnderscore) candidates.add(titleUnderscore);
  return Array.from(candidates);
}
