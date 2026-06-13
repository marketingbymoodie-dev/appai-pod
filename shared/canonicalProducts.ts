/**
 * Canonical flat-calibration Supabase path helpers + default blueprint ids.
 * Product allowlist lives in Postgres (`platform_catalog_blueprints`) — see
 * `server/platformCatalogStore.ts`.
 */

export type CanonicalProductKind = "flat" | "aop" | "printify" | "blocked";

/** Slim phone cases Printify blueprint (override via CANONICAL_SLIM_PHONE_BLUEPRINT_ID). */
export function slimPhoneCaseBlueprintId(): number {
  const fromEnv = process.env.CANONICAL_SLIM_PHONE_BLUEPRINT_ID;
  if (fromEnv && /^\d+$/.test(fromEnv.trim())) return parseInt(fromEnv.trim(), 10);
  return 421;
}

export function canonicalStorageKey(blueprintId: number, version: number): string {
  return `canonical/${blueprintId}/v${version}`;
}

export function canonicalPublishedMetaPath(blueprintId: number): string {
  return `canonical/${blueprintId}/published.json`;
}

export function canonicalManifestPath(blueprintId: number, version: number): string {
  return `${canonicalStorageKey(blueprintId, version)}/manifest.json`;
}

export type CanonicalPublishedMeta = {
  blueprintId: number;
  version: number;
  kind: CanonicalProductKind;
  label: string;
  tier?: "flat" | "mesh";
  publishedAt: string;
  panelMappingTemplate?: string;
};
