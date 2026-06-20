/**
 * DB-backed platform Printify catalog tags. Operators tag products without deploys.
 */
import { db } from "./db";
import { platformCatalogBlueprints, type PlatformCatalogBlueprint } from "@shared/schema";
import { eq, inArray, asc } from "drizzle-orm";
import { slimPhoneCaseBlueprintId } from "@shared/canonicalProducts";

export type PlatformCatalogKind = "flat" | "aop" | "printify" | "blocked";
export type PlatformCatalogStatus = "draft" | "published";

export type PlatformCatalogEntry = PlatformCatalogBlueprint;

const CACHE_TTL_MS = 15_000;
let cache: PlatformCatalogEntry[] | null = null;
let cacheAt = 0;

export function invalidatePlatformCatalogCache(): void {
  cache = null;
  cacheAt = 0;
}

async function refreshCache(): Promise<PlatformCatalogEntry[]> {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;
  cache = await db.select().from(platformCatalogBlueprints).orderBy(asc(platformCatalogBlueprints.label));
  cacheAt = now;
  return cache;
}

/** Idempotent seed for legacy hardcoded entries. */
export async function ensurePlatformCatalogSeed(): Promise<void> {
  const phoneId = slimPhoneCaseBlueprintId();
  const seeds: Array<{
    printifyBlueprintId: number;
    label: string;
    kind: PlatformCatalogKind;
    status: PlatformCatalogStatus;
    category: string;
    panelMappingTemplate?: string;
  }> = [
    {
      printifyBlueprintId: phoneId,
      label: "Slim Phone Cases",
      kind: "flat",
      status: "draft",
      category: "phone-cases",
    },
    {
      printifyBlueprintId: 451,
      label: "Unisex Zip Hoodie (AOP)",
      kind: "aop",
      status: "published",
      category: "apparel",
      panelMappingTemplate: "unisex-zip-hoodie-aop-L",
    },
  ];

  for (const s of seeds) {
    const existing = await db
      .select()
      .from(platformCatalogBlueprints)
      .where(eq(platformCatalogBlueprints.printifyBlueprintId, s.printifyBlueprintId))
      .limit(1);
    if (existing.length > 0) continue;
    await db.insert(platformCatalogBlueprints).values({
      printifyBlueprintId: s.printifyBlueprintId,
      label: s.label,
      kind: s.kind,
      status: s.status,
      category: s.category,
      panelMappingTemplate: s.panelMappingTemplate ?? null,
    });
  }
  invalidatePlatformCatalogCache();
}

export async function listPlatformCatalog(): Promise<PlatformCatalogEntry[]> {
  await ensurePlatformCatalogSeed();
  return refreshCache();
}

export async function getPlatformCatalogEntry(
  blueprintId: number,
): Promise<PlatformCatalogEntry | undefined> {
  await ensurePlatformCatalogSeed();
  const rows = await db
    .select()
    .from(platformCatalogBlueprints)
    .where(eq(platformCatalogBlueprints.printifyBlueprintId, blueprintId))
    .limit(1);
  return rows[0];
}

export async function listPlatformCatalogByKind(
  kinds: PlatformCatalogKind[],
): Promise<PlatformCatalogEntry[]> {
  const all = await listPlatformCatalog();
  return all.filter((e) => kinds.includes(e.kind as PlatformCatalogKind));
}

/** Merchants may import these blueprints from the filtered Printify picker. */
export async function listMerchantImportableCatalog(): Promise<PlatformCatalogEntry[]> {
  const all = await listPlatformCatalog();
  return all.filter((e) => {
    if (e.kind === "blocked") return false;
    if (e.kind === "printify") return e.status === "published";
    if (e.kind === "flat") return e.status === "published";
    if (e.kind === "aop") return e.status === "published" && !!e.panelMappingTemplate;
    return false;
  });
}

/** Operator may stage-import draft flat/aop reference products on their shop. */
export async function canOperatorImportEntry(
  entry: PlatformCatalogEntry | undefined,
): Promise<boolean> {
  if (!entry || entry.kind === "blocked") return false;
  return true;
}

export async function canMerchantImportEntry(
  entry: PlatformCatalogEntry | undefined,
): Promise<boolean> {
  if (!entry || entry.kind === "blocked") return false;
  if (entry.kind === "printify") return entry.status === "published";
  if (entry.kind === "flat") return entry.status === "published";
  if (entry.kind === "aop") return entry.status === "published" && !!entry.panelMappingTemplate;
  return false;
}

export async function upsertPlatformCatalogTag(args: {
  printifyBlueprintId: number;
  label: string;
  brand?: string | null;
  kind: PlatformCatalogKind;
  category?: string | null;
  panelMappingTemplate?: string | null;
  storefrontMockupMode?: string | null;
  fulfillmentLayout?: string | null;
  forceFlatHarvest?: boolean | null;
  notes?: string | null;
}): Promise<PlatformCatalogEntry> {
  const status: PlatformCatalogStatus = args.kind === "printify" ? "published" : "draft";
  const existing = await getPlatformCatalogEntry(args.printifyBlueprintId);
  const panelTemplate =
    args.kind === "aop"
      ? args.panelMappingTemplate?.trim()
        ? args.panelMappingTemplate.trim()
        : existing?.panelMappingTemplate ?? null
      : null;
  if (existing) {
    const [row] = await db
      .update(platformCatalogBlueprints)
      .set({
        label: args.label,
        brand: args.brand ?? null,
        kind: args.kind,
        category: args.category ?? null,
        status: args.kind === "printify" ? "published" : existing.status === "published" && args.kind === existing.kind ? "published" : status,
        panelMappingTemplate: panelTemplate,
        storefrontMockupMode: args.storefrontMockupMode ?? existing.storefrontMockupMode ?? null,
        fulfillmentLayout: args.fulfillmentLayout ?? existing.fulfillmentLayout ?? null,
        forceFlatHarvest:
          args.forceFlatHarvest != null ? args.forceFlatHarvest : existing.forceFlatHarvest ?? false,
        notes: args.notes ?? existing.notes,
        updatedAt: new Date(),
      })
      .where(eq(platformCatalogBlueprints.printifyBlueprintId, args.printifyBlueprintId))
      .returning();
    invalidatePlatformCatalogCache();
    return row;
  }

  const [row] = await db
    .insert(platformCatalogBlueprints)
    .values({
      printifyBlueprintId: args.printifyBlueprintId,
      label: args.label,
      brand: args.brand ?? null,
      kind: args.kind,
      category: args.category ?? null,
      status,
      panelMappingTemplate: panelTemplate,
      storefrontMockupMode: args.storefrontMockupMode ?? null,
      fulfillmentLayout: args.fulfillmentLayout ?? null,
      forceFlatHarvest: args.forceFlatHarvest ?? false,
      notes: args.notes ?? null,
    })
    .returning();
  invalidatePlatformCatalogCache();
  return row;
}

export async function markPlatformCatalogPublished(
  blueprintId: number,
): Promise<PlatformCatalogEntry | undefined> {
  const [row] = await db
    .update(platformCatalogBlueprints)
    .set({ status: "published", updatedAt: new Date() })
    .where(eq(platformCatalogBlueprints.printifyBlueprintId, blueprintId))
    .returning();
  invalidatePlatformCatalogCache();
  return row;
}

/** Link a published Supabase panel template and mark an AOP catalog row live for merchants. */
export async function publishPlatformAopCatalogEntry(
  blueprintId: number,
  panelMappingTemplate: string,
): Promise<PlatformCatalogEntry> {
  const normalized = panelMappingTemplate.trim();
  if (!/^[a-zA-Z0-9_\-]{1,64}$/.test(normalized)) {
    throw new Error("panelMappingTemplate must be 1–64 alphanumeric characters, dashes, or underscores");
  }

  const existing = await getPlatformCatalogEntry(blueprintId);
  if (!existing || existing.kind !== "aop") {
    throw new Error(`Blueprint ${blueprintId} is not an AOP platform catalog entry`);
  }

  const [row] = await db
    .update(platformCatalogBlueprints)
    .set({
      panelMappingTemplate: normalized,
      status: "published",
      updatedAt: new Date(),
    })
    .where(eq(platformCatalogBlueprints.printifyBlueprintId, blueprintId))
    .returning();
  invalidatePlatformCatalogCache();
  return row;
}

export async function clearPlatformCatalogTag(blueprintId: number): Promise<void> {
  await db
    .delete(platformCatalogBlueprints)
    .where(eq(platformCatalogBlueprints.printifyBlueprintId, blueprintId));
  invalidatePlatformCatalogCache();
}

export async function getPlatformCatalogTagsForBlueprints(
  blueprintIds: number[],
): Promise<Map<number, PlatformCatalogEntry>> {
  if (blueprintIds.length === 0) return new Map();
  await ensurePlatformCatalogSeed();
  const rows = await db
    .select()
    .from(platformCatalogBlueprints)
    .where(inArray(platformCatalogBlueprints.printifyBlueprintId, blueprintIds));
  return new Map(rows.map((r) => [r.printifyBlueprintId, r]));
}
