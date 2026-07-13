/**
 * Persistent Printify products for permanent "design products" (My Designs studio
 * listings). Unlike the ephemeral mockup-preview product (`printify-mockups.ts`,
 * created and immediately deleted), this product is kept forever in the merchant's
 * own Printify account: it is the artwork-storage + order-fulfillment target for the
 * Shopify draft listing created by `POST /api/appai/design-products`.
 *
 * Because the merchant's Printify shop here is NOT connected to Shopify via Printify's
 * own app (confirmed 2026-07), Printify never learns about the Shopify listing on its
 * own — our app owns both sides: this module creates the Printify product (artwork +
 * print areas + variants), and the Shopify draft references it. At order time (Phase 3)
 * we submit a `{product_id, variant_id, quantity}` reference order — no print_areas
 * need to be re-sent because they already live on this persistent product.
 *
 * Print-area construction mirrors the temp mockup-preview product
 * (`printify-mockups.ts` `createTemporaryProduct`, ~410-575) but declares ALL of the
 * design's selected size (and, if applicable, color) variants instead of one, and is
 * never deleted.
 */
import { uploadImageToPrintify } from "./printify-mockups";
import { bakeFlatPrintFile, uploadPrintFileToPrintify, type FlatPlacement } from "./flat-print-file";
import { resolveFlatPrintFileDims, resolveFlatBakePlacementRect } from "./flat-calibration";
import { buildToteFoldedPrintPngFromUrl } from "./toteFoldedPrintFile";
import { usesToteFoldedFulfillment } from "@shared/productLayoutPolicy";
import { resolveVariantFromMap, type VariantMap } from "@shared/variantMapResolve";
import type { ProductType, Merchant, GenerationJob } from "@shared/schema";

const PRINTIFY_API_BASE = "https://api.printify.com/v1";

type ViewName = "front" | "back";
const VIEWS: ViewName[] = ["front", "back"];

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw !== "string") return raw as T;
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function toAbsoluteUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) return url;
  const base = (process.env.PUBLIC_APP_URL || process.env.APP_URL || "").replace(/\/$/, "");
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

type ResolvedVariant = { sizeId: string; colorId: string; printifyVariantId: number; providerId: number };

function resolveDesignProductVariants(
  variantMap: VariantMap,
  variantMeta: Array<{ sizeId: string; colorId: string }>,
  defaultProviderId: number,
): ResolvedVariant[] {
  const out: ResolvedVariant[] = [];
  const seen = new Set<number>();
  for (const meta of variantMeta) {
    const resolved = resolveVariantFromMap(variantMap, meta.sizeId, meta.colorId);
    const printifyVariantId = resolved?.entry?.printifyVariantId;
    if (printifyVariantId == null || printifyVariantId === "") continue;
    const idNum = Number(printifyVariantId);
    if (!Number.isFinite(idNum) || seen.has(idNum)) continue;
    seen.add(idNum);
    out.push({
      sizeId: meta.sizeId,
      colorId: meta.colorId,
      printifyVariantId: idNum,
      providerId: Number(resolved?.entry?.providerId ?? defaultProviderId),
    });
  }
  return out;
}

type PrintifyPlaceholderImage = { id: string; x: number; y: number; scale: number; angle: number };
type PrintifyPlaceholder = { position: string; images: PrintifyPlaceholderImage[] };

export type CreatePersistentPrintifyProductArgs = {
  job: GenerationJob;
  productType: ProductType;
  merchant: Merchant;
  /** {sizeId, colorId} pairs for every Shopify variant the design product will offer. */
  variantMeta: Array<{ sizeId: string; colorId: string }>;
  title: string;
  description?: string;
  tags?: string[];
};

export type CreatePersistentPrintifyProductResult =
  | { ok: true; printifyProductId: string }
  | { ok: false; error: string };

/**
 * Build print_areas placeholders for an AOP (all-over-print) design from the
 * per-panel URLs saved on the job's designState (`aopPrintPanelUrls`, set by the
 * merchant/customer studio's apply step — mockup-resolution today, print-res once
 * Phase 2 lands). Skips positions with no captured panel.
 */
async function buildAopPlaceholders(
  job: GenerationJob,
  apiToken: string,
): Promise<{ placeholders: PrintifyPlaceholder[]; error?: string }> {
  const designState = parseJson<Record<string, any>>(job.designState, {});
  const panels = Array.isArray(designState.aopPrintPanelUrls) ? designState.aopPrintPanelUrls : [];
  const usablePanels = panels.filter((p: any) => p && typeof p.position === "string" && typeof p.url === "string" && p.url);
  if (usablePanels.length === 0) {
    return {
      placeholders: [],
      error: "This design has no saved AOP print panels. Re-open it in the studio, adjust the artwork once, and try publishing again.",
    };
  }

  const placeholders: PrintifyPlaceholder[] = [];
  for (const panel of usablePanels) {
    try {
      const uploaded = await uploadImageToPrintify(toAbsoluteUrl(panel.url), apiToken);
      if (!uploaded) continue;
      placeholders.push({
        position: panel.position,
        images: [{ id: uploaded.id, x: 0.5, y: 0.5, scale: 1, angle: 0 }],
      });
    } catch (e: any) {
      console.warn(`[design-product-publish] AOP panel upload failed for "${panel.position}":`, e?.message ?? e);
    }
  }
  if (placeholders.length === 0) {
    return { placeholders: [], error: "Failed to upload any AOP print panels to Printify." };
  }
  return { placeholders };
}

/** Build print_areas placeholders for an on-the-fly flat/mesh calibrated product. */
async function buildFlatPlaceholders(
  job: GenerationJob,
  productType: ProductType,
  apiToken: string,
): Promise<{ placeholders: PrintifyPlaceholder[]; error?: string }> {
  const flatCalibration = parseJson<any>(productType.flatCalibration, null);
  if (!flatCalibration?.views || Object.keys(flatCalibration.views).length === 0) {
    return { placeholders: [], error: "This product has no flat calibration manifest." };
  }
  const designState = parseJson<Record<string, any>>(job.designState, {});
  const flatPlacerState = designState?.flatPlacerState as
    | { placements?: Partial<Record<ViewName, FlatPlacement>>; enabled?: Partial<Record<ViewName, boolean>>; artworkUrl?: string }
    | undefined;
  const artworkUrl = (job.designImageUrl as string | null) || flatPlacerState?.artworkUrl || "";
  if (!artworkUrl) {
    return { placeholders: [], error: "This design has no print-ready artwork." };
  }

  const sizeId = String(job.size || "default");
  const colorId = String(job.frameColor || "default");
  const enabled: Record<ViewName, boolean> = { front: true, back: false };
  const placements: Partial<Record<ViewName, FlatPlacement>> = {};
  for (const v of VIEWS) {
    const p = flatPlacerState?.placements?.[v];
    placements[v] = p && typeof p === "object"
      ? { scale: Number(p.scale ?? 1), offsetX: Number(p.offsetX ?? 0), offsetY: Number(p.offsetY ?? 0) }
      : { scale: 1, offsetX: 0, offsetY: 0 };
    if (flatPlacerState?.enabled && typeof flatPlacerState.enabled[v] === "boolean") {
      enabled[v] = flatPlacerState.enabled[v]!;
    }
  }

  const placeholders: PrintifyPlaceholder[] = [];
  for (const view of VIEWS) {
    if (!enabled[view]) continue;
    const dims = resolveFlatPrintFileDims(flatCalibration, view, { sizeId, frameColorId: colorId });
    if (!dims?.width || !dims.height) continue;
    const placement = placements[view] ?? { scale: 1, offsetX: 0, offsetY: 0 };
    const placementRect = resolveFlatBakePlacementRect(flatCalibration, view, { sizeId, frameColorId: colorId });
    try {
      const baked = await bakeFlatPrintFile({
        artworkUrl,
        placement,
        printFileDims: { width: dims.width, height: dims.height },
        placementRect: placementRect ?? undefined,
      });
      const imageId = await uploadPrintFileToPrintify(apiToken, `design-${job.id}-${view}.png`, baked.buffer);
      placeholders.push({ position: view, images: [{ id: imageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] });
    } catch (e: any) {
      console.warn(`[design-product-publish] Flat bake failed for view "${view}":`, e?.message ?? e);
    }
  }
  if (placeholders.length === 0) {
    return { placeholders: [], error: "Could not bake a print file for this design's size." };
  }
  return { placeholders };
}

/** Build print_areas placeholders for a tote_folded_v1 fulfillment product (single folded canvas). */
async function buildToteFoldedPlaceholders(
  job: GenerationJob,
  apiToken: string,
): Promise<{ placeholders: PrintifyPlaceholder[]; error?: string }> {
  const designState = parseJson<Record<string, any>>(job.designState, {});
  const artworkUrl = (job.designImageUrl as string | null) || "";
  if (!artworkUrl) return { placeholders: [], error: "This design has no print-ready artwork." };
  const dsScale = Number(designState?.scale ?? 100);
  const dsX = Number(designState?.x ?? 50);
  const dsY = Number(designState?.y ?? 50);
  try {
    const buffer = await buildToteFoldedPrintPngFromUrl(toAbsoluteUrl(artworkUrl), {
      scale: Math.max(0.05, Math.min(4, dsScale / 100)),
      offsetX: (dsX - 50) / 50,
      offsetY: (dsY - 50) / 50,
    });
    const imageId = await uploadPrintFileToPrintify(apiToken, `design-${job.id}-folded.png`, buffer);
    return { placeholders: [{ position: "front", images: [{ id: imageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] }] };
  } catch (e: any) {
    return { placeholders: [], error: `Could not build the folded print file: ${e?.message ?? e}` };
  }
}

/**
 * Build print_areas placeholders for a static/single-image product (mugs, posters,
 * canvases, pillows, phone cases outside the flat calibration tier, etc.) — the same
 * single-image + scale/x/y placement the storefront's live Printify mockup preview
 * already uses (`generatePrintifyMockup`'s non-AOP path), minus wrap-around folding.
 */
async function buildDefaultPlaceholders(
  job: GenerationJob,
  productType: ProductType,
  apiToken: string,
): Promise<{ placeholders: PrintifyPlaceholder[]; error?: string }> {
  const artworkUrl =
    (job.designImageUrl as string | null) ||
    (Array.isArray(job.mockupUrls) && (job.mockupUrls as string[])[0]) ||
    "";
  if (!artworkUrl) return { placeholders: [], error: "This design has no artwork." };

  const designState = parseJson<Record<string, any>>(job.designState, {});
  const scale = typeof designState.scale === "number" ? designState.scale / 100 : 1;
  const x = typeof designState.x === "number" ? (designState.x - 50) / 100 : 0;
  const y = typeof designState.y === "number" ? (designState.y - 50) / 100 : 0;

  let uploaded;
  try {
    uploaded = await uploadImageToPrintify(toAbsoluteUrl(artworkUrl), apiToken);
  } catch (e: any) {
    return { placeholders: [], error: `Image upload to Printify failed: ${e?.message ?? e}` };
  }
  if (!uploaded) return { placeholders: [], error: "Image upload to Printify failed." };

  const imageEntry: PrintifyPlaceholderImage = {
    id: uploaded.id,
    x: 0.5 + x * 0.5,
    y: 0.5 + y * 0.5,
    scale,
    angle: 0,
  };
  const placeholders: PrintifyPlaceholder[] = [{ position: "front", images: [imageEntry] }];
  if (productType.doubleSidedPrint) {
    placeholders.push({ position: "back", images: [imageEntry] });
  }
  return { placeholders };
}

/**
 * Create (or return an error explaining why we couldn't create) a persistent
 * Printify product holding this design's artwork + all selected size/color
 * variants. Never deletes the product — it is the permanent fulfillment target.
 */
export async function createPersistentPrintifyProduct(
  args: CreatePersistentPrintifyProductArgs,
): Promise<CreatePersistentPrintifyProductResult> {
  const { job, productType, merchant, variantMeta, title, description, tags } = args;
  const apiToken = merchant.printifyApiToken;
  const printifyShopId = merchant.printifyShopId;
  if (!apiToken || !printifyShopId) {
    return { ok: false, error: "Connect your Printify account before publishing this design as a product." };
  }

  const blueprintId = Number(productType.printifyBlueprintId);
  if (!Number.isFinite(blueprintId)) {
    return { ok: false, error: "This product has no Printify blueprint configured." };
  }

  const variantMap = parseJson<VariantMap>(productType.variantMap, {});
  const defaultProviderId = Number(productType.printifyProviderId ?? 1);
  const resolvedVariants = resolveDesignProductVariants(variantMap, variantMeta, defaultProviderId);
  if (resolvedVariants.length === 0) {
    return { ok: false, error: "Couldn't resolve any Printify variants for this design's sizes." };
  }
  const providerId = resolvedVariants[0].providerId || defaultProviderId;

  const toteFolded = usesToteFoldedFulfillment({
    isAllOverPrint: productType.isAllOverPrint,
    storefrontMockupMode: (productType as any).storefrontMockupMode,
    fulfillmentLayout: (productType as any).fulfillmentLayout,
    printifyBlueprintId: productType.printifyBlueprintId,
  });
  const isAop = !!productType.isAllOverPrint && !toteFolded;
  const isFlatTier = !toteFolded && !isAop && (productType.onTheFlyTier === "flat" || productType.onTheFlyTier === "mesh");

  let built: { placeholders: PrintifyPlaceholder[]; error?: string };
  if (toteFolded) {
    built = await buildToteFoldedPlaceholders(job, apiToken);
  } else if (isAop) {
    built = await buildAopPlaceholders(job, apiToken);
  } else if (isFlatTier) {
    built = await buildFlatPlaceholders(job, productType, apiToken);
  } else {
    built = await buildDefaultPlaceholders(job, productType, apiToken);
  }
  if (built.error || built.placeholders.length === 0) {
    return { ok: false, error: built.error || "Could not build a print file for this design." };
  }

  const variantIds = resolvedVariants.map((v) => v.printifyVariantId);
  const requestBody = {
    title: title.slice(0, 250),
    description: description || "AppAI Studio design product — artwork stored for automatic order fulfillment. Do not edit print areas manually.",
    blueprint_id: blueprintId,
    print_provider_id: providerId,
    variants: variantIds.map((id) => ({ id, price: 100, is_enabled: true })),
    print_areas: [{ variant_ids: variantIds, placeholders: built.placeholders }],
    ...(tags?.length ? { tags } : {}),
  };

  try {
    const res = await fetch(`${PRINTIFY_API_BASE}/shops/${printifyShopId}/products.json`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error("[design-product-publish] Printify product create failed:", res.status, text.slice(0, 500));
      return { ok: false, error: `Printify rejected the product (${res.status}): ${text.slice(0, 200)}` };
    }
    const created = text ? JSON.parse(text) : {};
    if (!created?.id) return { ok: false, error: "Printify did not return a product id." };
    return { ok: true, printifyProductId: String(created.id) };
  } catch (e: any) {
    return { ok: false, error: `Printify request failed: ${e?.message ?? e}` };
  }
}
