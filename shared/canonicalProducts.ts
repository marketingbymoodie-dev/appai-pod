/**
 * Platform-curated Printify catalog — merchants may only import blueprints listed
 * here with a published calibration (flat/mesh manifest or AOP panel template).
 *
 * Asset paths: Supabase `flat-calibration` bucket under
 *   canonical/{blueprintId}/v{version}/…
 * Hoodie AOP templates: Supabase `hoodie-templates` bucket (separate).
 */

export type CanonicalProductKind = "flat" | "aop";

export type CanonicalBlueprintEntry = {
  blueprintId: number;
  label: string;
  category: "phone-cases" | "apparel" | "home" | "stationery" | "other";
  kind: CanonicalProductKind;
  /** AOP only — published hoodie panel-mapping template name. */
  panelMappingTemplate?: string;
  /** Optional default Printify provider when harvesting canonical assets. */
  defaultProviderId?: number;
};

/** Slim phone cases Printify blueprint (override via CANONICAL_SLIM_PHONE_BLUEPRINT_ID). */
export function slimPhoneCaseBlueprintId(): number {
  const fromEnv = process.env.CANONICAL_SLIM_PHONE_BLUEPRINT_ID;
  if (fromEnv && /^\d+$/.test(fromEnv.trim())) return parseInt(fromEnv.trim(), 10);
  return 421;
}

export function getCanonicalRegistry(): CanonicalBlueprintEntry[] {
  return [
    {
      blueprintId: slimPhoneCaseBlueprintId(),
      label: "Slim Phone Cases",
      category: "phone-cases",
      kind: "flat",
    },
    {
      blueprintId: 451,
      label: "Unisex Zip Hoodie (AOP)",
      category: "apparel",
      kind: "aop",
      panelMappingTemplate: "unisex-zip-hoodie-aop-L",
    },
  ];
}

export function getCanonicalEntry(blueprintId: number): CanonicalBlueprintEntry | undefined {
  return getCanonicalRegistry().find((e) => e.blueprintId === blueprintId);
}

export function isBlueprintImportAllowed(blueprintId: number): boolean {
  return getCanonicalEntry(blueprintId) != null;
}

export function getAllowedBlueprintIds(): number[] {
  return getCanonicalRegistry().map((e) => e.blueprintId);
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
