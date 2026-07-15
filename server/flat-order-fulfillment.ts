/**
 * Order-time Printify print-file submission for "on-the-fly" flat / mesh products.
 *
 * WHY THIS EXISTS
 * ---------------
 * Checkout sells SHADOW Shopify products (created via Admin API with
 * `fulfillment_service:'manual'`), NOT Printify products. Printify never sees
 * these orders, so our app must PUSH the order to Printify via the API once a
 * Shopify order is paid. This module owns the resolution + bake + submit
 * pipeline. It is invoked from:
 *   - the admin "send test order" endpoint (draft, sendToProduction:false), and
 *   - the disabled-by-default `orders/paid` webhook (live, gated behind
 *     FLAT_ORDER_FULFILLMENT_ENABLED).
 *
 * DATA RESOLUTION PATH (verified against the codebase):
 *   line.variant_id
 *     → published_products.shopifyVariantId  → designId, baseVariantId, shop
 *       (fallback: line.properties `_appai_job_id` / `_design_id`)
 *   designId (== generation_jobs.id)
 *     → generation_jobs: designState.flatPlacerState (normalized placement),
 *       designImageUrl (print-ready artwork), productTypeId
 *   productTypeId
 *     → product_types: flatCalibration (per-view printFileDims +
 *       visibleRectNormalized + tier), onTheFlyTier, variantMap
 *       ({sizeId}:{colorId} → {printifyVariantId}), printifyBlueprintId/ProviderId,
 *       merchantId
 *   merchantId
 *     → merchants: printifyApiToken, printifyShopId
 *
 * PRINTIFY ORDER SHAPE (official docs — order submission with on-the-fly product
 * creation, advanced image positioning):
 *   POST /v1/shops/{printifyShopId}/orders.json
 *   {
 *     external_id, label,
 *     line_items: [{
 *       print_provider_id, blueprint_id, variant_id, quantity, external_id,
 *       print_areas: { front: [{ src: <url>, scale: 1, x: 0.5, y: 0.5, angle: 0 }], ... }
 *     }],
 *     shipping_method: 1, send_shipping_notification: false, address_to: {...}
 *   }
 * Orders are created as DRAFTS; production is a separate, explicit call:
 *   POST /v1/shops/{printifyShopId}/orders/{order_id}/send_to_production.json
 * The baked print file is full-bleed at `printFileDims` and submitted at
 * {x:0.5,y:0.5,scale:1,angle:0} (see server/flat-print-file.ts for the bake math).
 * `src` is a public URL, so we persist each baked PNG to the Supabase
 * flat-calibration bucket (already required for flat/mesh products) and use that
 * URL — no Printify image-id round trip is needed.
 */
import { getBlueprintVariantPlaceholders } from "./printify-mockups";
import { pool } from "./db";
import { storage } from "./storage";
import {
  bakeFlatPrintFile,
  persistBakedPrintFile,
  type FlatPlacement,
} from "./flat-print-file";
import { resolveFlatPrintFileDims, resolveFlatBakePlacementRect } from "./flat-calibration";
import { resolveVariantFromMap, type VariantMap } from "@shared/variantMapResolve";
import { usesToteFoldedFulfillment } from "@shared/productLayoutPolicy";
import { buildToteFoldedPrintPngFromUrl } from "./toteFoldedPrintFile";
import { uploadToFlatCalibrationBucket } from "./supabaseFlatCalibration";
import type { ToteFoldedPlacement } from "@shared/toteFoldedLayout";
import type { ProductType, Merchant, GenerationJob } from "@shared/schema";

const PRINTIFY_API_BASE = "https://api.printify.com/v1";

type ViewName = "front" | "back";
const VIEWS: ViewName[] = ["front", "back"];

export type PrintifyAddress = {
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  country: string; // ISO-2
  region?: string;
  address1: string;
  address2?: string;
  city: string;
  zip: string;
  company?: string;
};

/** A safe default test ship-to address (override via FLAT_TEST_SHIP_TO_JSON). */
export const DEFAULT_TEST_ADDRESS: PrintifyAddress = {
  first_name: "AppAI",
  last_name: "Test",
  email: "test@appai.example",
  phone: "5555555555",
  country: "US",
  region: "CA",
  address1: "123 Test Street",
  address2: "",
  city: "Los Angeles",
  zip: "90001",
};

export function resolveTestShipToAddress(): PrintifyAddress {
  const raw = process.env.FLAT_TEST_SHIP_TO_JSON;
  if (!raw) return DEFAULT_TEST_ADDRESS;
  try {
    return { ...DEFAULT_TEST_ADDRESS, ...JSON.parse(raw) } as PrintifyAddress;
  } catch {
    return DEFAULT_TEST_ADDRESS;
  }
}

// ── Normalized order line ──────────────────────────────────────────────────────
export type NormalizedOrderLine = {
  lineId: string;
  variantId: string | null;
  quantity: number;
  properties: Record<string, string>;
};

/** Convert a raw Shopify webhook line_item into a normalized line. */
export function normalizeShopifyOrderLine(raw: any): NormalizedOrderLine {
  const properties: Record<string, string> = {};
  if (Array.isArray(raw?.properties)) {
    for (const p of raw.properties) {
      if (p && typeof p.name === "string") properties[p.name] = String(p.value ?? "");
    }
  } else if (raw?.properties && typeof raw.properties === "object") {
    for (const [k, v] of Object.entries(raw.properties)) properties[k] = String(v ?? "");
  }
  return {
    lineId: String(raw?.id ?? raw?.line_item_id ?? ""),
    variantId: raw?.variant_id != null ? String(raw.variant_id) : null,
    quantity: Number(raw?.quantity ?? 1) || 1,
    properties,
  };
}

// ── Design / target resolution ──────────────────────────────────────────────────
export type ResolvedFlatDesign = {
  designId: string;
  shop: string;
  job: GenerationJob;
  productType: ProductType;
  merchant: Merchant;
  flatCalibration: any;
  tier: "flat" | "mesh";
  /** Per-view placement from the customer's flatPlacerState. */
  placements: Partial<Record<ViewName, FlatPlacement>>;
  /** Per-view enabled flags (front defaults on, back defaults off). */
  enabled: Record<ViewName, boolean>;
  artworkUrl: string;
  sizeId: string;
  colorId: string;
  /** Design product's persistent Printify product (if any) — bake-failure fallback (Phase 3). */
  printifyProductId?: string | null;
};

export type ResolvedToteFoldedDesign = {
  designId: string;
  shop: string;
  job: GenerationJob;
  productType: ProductType;
  merchant: Merchant;
  artworkUrl: string;
  sizeId: string;
  colorId: string;
  /** Design product's persistent Printify product (if any) — bake-failure fallback (Phase 3). */
  printifyProductId?: string | null;
  placement: ToteFoldedPlacement;
};

/**
 * A design product whose artwork already lives on a persistent Printify product
 * (server/design-product-publish.ts). No bake needed — the order line references
 * that product + variant directly. This is the ONLY fulfillment path for design
 * products outside the flat/mesh/tote_folded tiers (e.g. AOP, static/single-image).
 */
export type ResolvedProductReferenceDesign = {
  designId: string;
  shop: string;
  job: GenerationJob;
  productType: ProductType;
  merchant: Merchant;
  printifyProductId: string;
  sizeId: string;
  colorId: string;
};

/**
 * An AOP design whose per-panel print files were captured on the job's
 * designState (`aopPrintPanelUrls`, written by the studio's apply step). The
 * order line submits those panels directly as on-the-fly `print_areas`
 * ({ position: [{ src, scale:1, x:0.5, y:0.5 }] }) — exactly what Printify
 * bakes for the mockups the merchant saw in-app. Used by the admin test-order
 * flow and as the fallback for AOP orders with no persistent Printify product.
 */
export type ResolvedAopDesign = {
  designId: string;
  shop: string;
  job: GenerationJob;
  productType: ProductType;
  merchant: Merchant;
  /** position → hosted print-panel URL */
  panels: Array<{ position: string; url: string }>;
  sizeId: string;
  colorId: string;
};

export type ResolveResult =
  | { ok: true; kind: "flat"; design: ResolvedFlatDesign }
  | { ok: true; kind: "tote_folded"; design: ResolvedToteFoldedDesign }
  | { ok: true; kind: "product_reference"; design: ResolvedProductReferenceDesign }
  | { ok: true; kind: "aop"; design: ResolvedAopDesign }
  | { ok: false; skip: true; reason: string }
  | { ok: false; skip: false; reason: string };

function parseJson<T = any>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "object") return value as T;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

/** Look up a published (shadow) product by its purchasable Shopify variant id. */
async function findPublishedProductByVariant(
  shop: string,
  variantId: string,
): Promise<{ designId: string; shop: string; baseVariantId: string } | null> {
  const numeric = variantId.replace("gid://shopify/ProductVariant/", "");
  const gid = `gid://shopify/ProductVariant/${numeric}`;
  const result = await pool.query<{ design_id: string; shop: string; base_variant_id: string }>(
    `SELECT design_id, shop, base_variant_id
       FROM published_products
      WHERE shopify_variant_id = ANY($1::text[])
      ORDER BY created_at DESC
      LIMIT 1`,
    [[numeric, gid]],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { designId: row.design_id, shop: row.shop, baseVariantId: row.base_variant_id };
}

/**
 * Look up a permanent "design product" (My Designs → List as product) by its purchasable
 * Shopify variant id. Unlike published_products (ephemeral shadow SKUs, one variant per
 * design), a design product has a real size/color variant set mapped in `variant_map`
 * ({ [shopifyVariantId]: { sizeId, colorId } }) — the resolved sizeId/colorId here MUST
 * override job.size/job.frameColor (the size the artwork was originally generated at),
 * since the customer may buy a different size/color variant of the same listing.
 */
async function findDesignProductByVariant(
  shop: string,
  variantId: string,
): Promise<{ jobId: string; sizeId: string | null; colorId: string | null; printifyProductId: string | null } | null> {
  const numeric = variantId.replace("gid://shopify/ProductVariant/", "");
  const result = await pool.query<{ job_id: string; variant_map: any; printify_product_id: string | null }>(
    `SELECT job_id, variant_map, printify_product_id
       FROM design_products
      WHERE shop = $1 AND variant_map::jsonb ? $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [shop, numeric],
  );
  const row = result.rows[0];
  if (!row) return null;
  const map = parseJson<Record<string, { sizeId?: string; colorId?: string }>>(row.variant_map, {});
  const entry = map[numeric];
  return {
    jobId: row.job_id,
    sizeId: entry?.sizeId ?? null,
    colorId: entry?.colorId ?? null,
    printifyProductId: row.printify_product_id ?? null,
  };
}

/**
 * Resolve the design + Printify context for one order line. Returns:
 *   { ok:true }       — eligible flat/mesh on-the-fly line, ready to bake/submit
 *   { ok:false, skip:true }  — cleanly skip (mixed cart / normal product / AOP / no design)
 *   { ok:false, skip:false } — a hard error worth surfacing (e.g. missing creds)
 */
export async function resolveDesignForOrderLine(
  line: NormalizedOrderLine,
  shop: string,
): Promise<ResolveResult> {
  // 1) variant_id → published_products (shadow SKU) OR design_products (permanent listing)
  //    → designId (fallback to line properties for older/legacy carts)
  let designId: string | null = null;
  let resolvedShop = shop;
  let designProductOverride: { sizeId: string | null; colorId: string | null; printifyProductId: string | null } | null = null;
  if (line.variantId) {
    const pp = await findPublishedProductByVariant(shop, line.variantId);
    if (pp) {
      designId = pp.designId;
      resolvedShop = pp.shop || shop;
    } else {
      const dp = await findDesignProductByVariant(shop, line.variantId);
      if (dp) {
        designId = dp.jobId;
        designProductOverride = { sizeId: dp.sizeId, colorId: dp.colorId, printifyProductId: dp.printifyProductId };
      }
    }
  }
  if (!designId) {
    designId = line.properties["_appai_job_id"] || line.properties["_design_id"] || null;
  }
  if (!designId) {
    return { ok: false, skip: true, reason: "no design id on line (normal product / mixed cart)" };
  }

  // 2) designId → generation_jobs
  const job = await storage.getGenerationJob(designId);
  if (!job) {
    return { ok: false, skip: true, reason: `no generation job for design ${designId}` };
  }

  const designState = parseJson<Record<string, any>>(job.designState, {});
  const flatPlacerState = designState?.flatPlacerState as
    | { placements?: Partial<Record<ViewName, FlatPlacement>>; enabled?: Partial<Record<ViewName, boolean>>; artworkUrl?: string }
    | undefined;

  const artworkUrl =
    (job.designImageUrl as string | null) ||
    line.properties["_artwork_url"] ||
    flatPlacerState?.artworkUrl ||
    "";
  if (!artworkUrl) {
    return { ok: false, skip: true, reason: `no artwork url for design ${designId}` };
  }

  const productTypeId = Number(job.productTypeId);
  if (!Number.isFinite(productTypeId)) {
    return { ok: false, skip: true, reason: `design ${designId} has no productTypeId` };
  }

  // 3) productTypeId → product_types (flat/mesh on-the-fly or tote_folded_v1)
  const productType = await storage.getProductType(productTypeId);
  if (!productType) {
    return { ok: false, skip: true, reason: `product type ${productTypeId} not found` };
  }

  const toteFolded = usesToteFoldedFulfillment({
    isAllOverPrint: productType.isAllOverPrint,
    storefrontMockupMode: (productType as any).storefrontMockupMode,
    fulfillmentLayout: (productType as any).fulfillmentLayout,
    printifyBlueprintId: productType.printifyBlueprintId,
  });

  if (toteFolded) {
    if (!productType.merchantId) {
      return { ok: false, skip: false, reason: `product type ${productTypeId} has no merchant` };
    }
    const merchant = await storage.getMerchant(productType.merchantId);
    if (!merchant || !merchant.printifyApiToken || !merchant.printifyShopId) {
      return { ok: false, skip: false, reason: `merchant for product type ${productTypeId} missing Printify credentials` };
    }

    const dsScale = Number(designState?.scale ?? 100);
    const dsX = Number(designState?.x ?? 50);
    const dsY = Number(designState?.y ?? 50);
    const placement: ToteFoldedPlacement = {
      scale: Math.max(0.05, Math.min(4, dsScale / 100)),
      offsetX: (dsX - 50) / 50,
      offsetY: (dsY - 50) / 50,
    };
    const sizeId = String(designProductOverride?.sizeId || line.properties["Size"] || job.size || "default");
    const colorId = String(designProductOverride?.colorId || line.properties["Color"] || job.frameColor || "default");

    return {
      ok: true,
      kind: "tote_folded",
      design: {
        designId,
        shop: resolvedShop,
        job,
        productType,
        merchant,
        artworkUrl,
        sizeId,
        colorId,
        placement,
        printifyProductId: designProductOverride?.printifyProductId ?? null,
      },
    };
  }

  const tier = productType.onTheFlyTier;
  if (tier !== "flat" && tier !== "mesh") {
    // Design products (My Designs → List as product) outside the flat/mesh/tote_folded
    // tiers (e.g. AOP, static/single-image products) have no on-the-fly bake path at
    // all — their artwork was already baked into a persistent Printify product at
    // publish time (server/design-product-publish.ts). Submit a product-reference
    // order line: no print_areas needed, Printify already has them.
    if (designProductOverride?.printifyProductId) {
      if (!productType.merchantId) {
        return { ok: false, skip: false, reason: `product type ${productTypeId} has no merchant` };
      }
      const merchant = await storage.getMerchant(productType.merchantId);
      if (!merchant || !merchant.printifyApiToken || !merchant.printifyShopId) {
        return { ok: false, skip: false, reason: `merchant for product type ${productTypeId} missing Printify credentials` };
      }
      const sizeId = String(designProductOverride.sizeId || line.properties["Size"] || job.size || "default");
      const colorId = String(designProductOverride.colorId || line.properties["Color"] || job.frameColor || "default");
      return {
        ok: true,
        kind: "product_reference",
        design: {
          designId,
          shop: resolvedShop,
          job,
          productType,
          merchant,
          printifyProductId: designProductOverride.printifyProductId,
          sizeId,
          colorId,
        },
      };
    }

    // AOP with captured print panels: submit the panels directly as on-the-fly
    // print_areas — same files that produced the in-app Printify mockups. This is
    // what the admin AOP test-order uses (and any AOP order without a persistent
    // Printify product).
    if (productType.isAllOverPrint) {
      const rawPanels = Array.isArray(designState?.aopPrintPanelUrls) ? designState.aopPrintPanelUrls : [];
      // Printify's order `src` must be a fetchable URL — hosted http(s) or app-relative
      // paths only (data: URLs from unpersisted local state can't be used).
      const panels = rawPanels
        .map((p: any) => ({ position: String(p?.position || ""), url: String(p?.url || "") }))
        .filter((p: { position: string; url: string }) =>
          p.position && p.url && (p.url.startsWith("http") || p.url.startsWith("/")));
      if (panels.length === 0) {
        return {
          ok: false,
          skip: true,
          reason: `AOP design ${designId} has no saved print panels yet — they upload in the background a few seconds after each change. Wait a moment and try again (or re-apply the design once).`,
        };
      }
      if (!productType.merchantId) {
        return { ok: false, skip: false, reason: `product type ${productTypeId} has no merchant` };
      }
      const merchant = await storage.getMerchant(productType.merchantId);
      if (!merchant || !merchant.printifyApiToken || !merchant.printifyShopId) {
        return { ok: false, skip: false, reason: `merchant for product type ${productTypeId} missing Printify credentials` };
      }
      const sizeId = String(designProductOverride?.sizeId || line.properties["Size"] || job.size || "default");
      const colorId = String(designProductOverride?.colorId || line.properties["Color"] || job.frameColor || "default");
      return {
        ok: true,
        kind: "aop",
        design: { designId, shop: resolvedShop, job, productType, merchant, panels, sizeId, colorId },
      };
    }

    return { ok: false, skip: true, reason: `product type ${productTypeId} tier=${tier ?? "none"} not flat/mesh` };
  }
  const flatCalibration = parseJson<any>(productType.flatCalibration, null);
  if (!flatCalibration || !flatCalibration.views || Object.keys(flatCalibration.views).length === 0) {
    return { ok: false, skip: true, reason: `product type ${productTypeId} has no flat calibration manifest` };
  }

  // 4) merchant → printify creds
  if (!productType.merchantId) {
    return { ok: false, skip: false, reason: `product type ${productTypeId} has no merchant` };
  }
  const merchant = await storage.getMerchant(productType.merchantId);
  if (!merchant || !merchant.printifyApiToken || !merchant.printifyShopId) {
    return { ok: false, skip: false, reason: `merchant for product type ${productTypeId} missing Printify credentials` };
  }

  // Placement + enabled flags (front defaults on, back defaults off — mirrors the placer).
  const placements: Partial<Record<ViewName, FlatPlacement>> = {};
  const enabled: Record<ViewName, boolean> = { front: true, back: false };
  for (const v of VIEWS) {
    const p = flatPlacerState?.placements?.[v];
    placements[v] = p && typeof p === "object"
      ? { scale: Number(p.scale ?? 1), offsetX: Number(p.offsetX ?? 0), offsetY: Number(p.offsetY ?? 0) }
      : { scale: 1, offsetX: 0, offsetY: 0 };
    if (flatPlacerState?.enabled && typeof flatPlacerState.enabled[v] === "boolean") {
      enabled[v] = flatPlacerState.enabled[v]!;
    }
  }

  const sizeId = String(designProductOverride?.sizeId || line.properties["Size"] || job.size || "default");
  const colorId = String(designProductOverride?.colorId || line.properties["Color"] || job.frameColor || "default");

  return {
    ok: true,
    kind: "flat",
    design: {
      designId,
      shop: resolvedShop,
      job,
      productType,
      merchant,
      flatCalibration,
      tier,
      placements,
      enabled,
      artworkUrl,
      sizeId,
      colorId,
      printifyProductId: designProductOverride?.printifyProductId ?? null,
    },
  };
}

export type PrintifyTarget = {
  blueprintId: number;
  providerId: number;
  printifyVariantId: number;
};

/**
 * Resolve the Printify blueprint / provider / variant for a product type +
 * selected size/color, mirroring the storefront mockup variant resolution
 * (server/routes.ts ~7676): exact `{size}:{color}` key, then documented fallbacks.
 */
export function resolvePrintifyTarget(
  productType: ProductType,
  sizeId: string,
  colorId: string,
): PrintifyTarget | null {
  const variantMap = parseJson<VariantMap>(productType.variantMap, {});
  const resolved = resolveVariantFromMap(variantMap, sizeId, colorId);
  const variantData = resolved?.entry;
  if (!variantData || variantData.printifyVariantId == null) return null;
  const blueprintId = Number(productType.printifyBlueprintId);
  const providerId = Number(variantData.providerId ?? productType.printifyProviderId ?? 1);
  const printifyVariantId = Number(variantData.printifyVariantId);
  if (!Number.isFinite(blueprintId) || !Number.isFinite(printifyVariantId)) return null;
  return { blueprintId, providerId, printifyVariantId };
}

// ── Printify REST helpers ────────────────────────────────────────────────────────
async function pf<T = any>(pathname: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${PRINTIFY_API_BASE}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Printify ${res.status} on ${pathname}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

type PrintAreaImage = { src: string; scale: number; x: number; y: number; angle: number };

/** Printify must be able to fetch `src` — expand app-relative paths (/objects/…) to the public app URL. */
function toAbsolutePrintUrl(url: string): string {
  if (!url || url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = (process.env.PUBLIC_APP_URL || process.env.APP_URL || "").replace(/\/$/, "");
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

/**
 * Bake + persist the enabled views' print files for one resolved design and
 * return the Printify order `print_areas` object plus the persisted URLs.
 * Skips views that aren't enabled or lack `printFileDims`. Throws if no enabled
 * view could be produced.
 */
async function buildPrintAreasForDesign(
  design: ResolvedFlatDesign,
): Promise<{ printAreas: Record<string, PrintAreaImage[]>; urls: Record<string, string> }> {
  const printAreas: Record<string, PrintAreaImage[]> = {};
  const urls: Record<string, string> = {};
  for (const view of VIEWS) {
    if (!design.enabled[view]) continue;
    const dims = resolveFlatPrintFileDims(design.flatCalibration, view, {
      sizeId: design.sizeId,
      frameColorId: design.colorId,
    });
    if (!dims?.width || !dims.height) continue;
    const placement = design.placements[view] ?? { scale: 1, offsetX: 0, offsetY: 0 };
    const placementRect = resolveFlatBakePlacementRect(design.flatCalibration, view, {
      sizeId: design.sizeId,
      frameColorId: design.colorId,
    });
    const baked = await bakeFlatPrintFile({
      artworkUrl: design.artworkUrl,
      placement,
      printFileDims: { width: dims.width, height: dims.height },
      placementRect: placementRect ?? undefined,
    });
    const url = await persistBakedPrintFile(design.productType.id, design.designId, view, baked.buffer);
    if (!url) {
      throw new Error(
        "Supabase flat-calibration bucket not configured — cannot host the baked print file for Printify",
      );
    }
    urls[view] = url;
    printAreas[view] = [{ src: url, scale: 1, x: 0.5, y: 0.5, angle: 0 }];
  }
  if (Object.keys(printAreas).length === 0) {
    throw new Error("no enabled views with print dimensions to bake");
  }
  return { printAreas, urls };
}

async function buildToteFoldedPrintAreasForDesign(
  design: ResolvedToteFoldedDesign,
): Promise<{ printAreas: Record<string, PrintAreaImage[]>; urls: Record<string, string> }> {
  let artworkUrl = design.artworkUrl;
  if (artworkUrl.startsWith("/")) {
    const base = process.env.PUBLIC_APP_URL || process.env.APP_URL || "";
    artworkUrl = `${base.replace(/\/$/, "")}${artworkUrl}`;
  }
  const foldedPng = await buildToteFoldedPrintPngFromUrl(artworkUrl, design.placement);
  const path = `tote-folded-orders/${design.productType.id}/${design.designId}-${Date.now()}.png`;
  const url = await uploadToFlatCalibrationBucket(path, foldedPng, "image/png");
  if (!url) {
    throw new Error(
      "Supabase flat-calibration bucket not configured — cannot host the folded tote print file for Printify",
    );
  }
  return {
    printAreas: { front: [{ src: url, scale: 1, x: 0.5, y: 0.5, angle: 0 }] },
    urls: { front: url },
  };
}

// ── Idempotency ──────────────────────────────────────────────────────────────────
async function findExistingSubmission(idempotencyKey: string): Promise<{ printifyOrderId: string | null; status: string } | null> {
  const result = await pool.query<{ printify_order_id: string | null; status: string }>(
    `SELECT printify_order_id, status FROM flat_order_submissions WHERE idempotency_key = $1 LIMIT 1`,
    [idempotencyKey],
  );
  const row = result.rows[0];
  return row ? { printifyOrderId: row.printify_order_id, status: row.status } : null;
}

async function recordSubmission(row: {
  idempotencyKey: string;
  shop?: string | null;
  shopifyOrderId?: string | null;
  shopifyLineId?: string | null;
  designId?: string | null;
  productTypeId?: number | null;
  printifyShopId?: string | null;
  printifyOrderId?: string | null;
  status: string;
  sentToProduction: boolean;
  isTest: boolean;
  printFileUrls?: Record<string, string> | null;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO flat_order_submissions
       (idempotency_key, shop, shopify_order_id, shopify_line_id, design_id, product_type_id,
        printify_shop_id, printify_order_id, status, sent_to_production, is_test, print_file_urls, error, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (idempotency_key) DO UPDATE SET
        printify_order_id = EXCLUDED.printify_order_id,
        status = EXCLUDED.status,
        sent_to_production = EXCLUDED.sent_to_production,
        print_file_urls = EXCLUDED.print_file_urls,
        error = EXCLUDED.error,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()`,
    [
      row.idempotencyKey,
      row.shop ?? null,
      row.shopifyOrderId ?? null,
      row.shopifyLineId ?? null,
      row.designId ?? null,
      row.productTypeId ?? null,
      row.printifyShopId ?? null,
      row.printifyOrderId ?? null,
      row.status,
      row.sentToProduction,
      row.isTest,
      row.printFileUrls ? JSON.stringify(row.printFileUrls) : null,
      row.error ?? null,
      row.metadata ? JSON.stringify(row.metadata) : null,
    ],
  );
}

// ── Submit ────────────────────────────────────────────────────────────────────────
export type SubmitFlatOrderArgs = {
  /** Raw Shopify order object (webhook payload) or a synthetic test order. */
  shopifyOrder: any;
  /** Already-normalized order lines (use `normalizeShopifyOrderLine`). */
  lines: NormalizedOrderLine[];
  /** Default FALSE — create the Printify order as a draft (no production/charge). */
  sendToProduction?: boolean;
  /** Ship-to address. Required by Printify. For test orders use `resolveTestShipToAddress()`. */
  addressTo: PrintifyAddress;
  /** Stable idempotency key (e.g. `shopify-order-fulfill:{orderId}`). */
  idempotencyKey: string;
  /** Marks the submission row as a test (admin draft). */
  isTest?: boolean;
  shippingMethod?: number;
};

export type SubmitFlatOrderResult = {
  status: "submitted" | "skipped" | "duplicate" | "failed";
  printifyOrderId?: string | null;
  eligibleLines: number;
  skippedReasons: string[];
  printFileUrls?: Record<string, string>;
  error?: string;
  sentToProduction: boolean;
};

/**
 * Resolve → bake → submit a Shopify order's eligible flat/mesh lines to Printify
 * as a single Printify order. Idempotent on `idempotencyKey`. Creates a DRAFT by
 * default (`sendToProduction:false`); only routes to production when explicitly true.
 */
export async function submitFlatOrderToPrintify(
  args: SubmitFlatOrderArgs,
): Promise<SubmitFlatOrderResult> {
  const sendToProduction = args.sendToProduction === true;
  const shopifyOrderId = String(args.shopifyOrder?.id ?? args.shopifyOrder?.admin_graphql_api_id ?? "");
  const shopHeader = String(
    args.shopifyOrder?.shop_domain || args.shopifyOrder?.__shop || "",
  );

  // Idempotency: never re-submit the same key.
  const existing = await findExistingSubmission(args.idempotencyKey);
  if (existing && existing.status === "submitted") {
    return {
      status: "duplicate",
      printifyOrderId: existing.printifyOrderId,
      eligibleLines: 0,
      skippedReasons: [],
      sentToProduction: sendToProduction,
    };
  }

  const skippedReasons: string[] = [];
  type BakedLineItem = {
    print_provider_id: number;
    blueprint_id: number;
    variant_id: number;
    quantity: number;
    external_id: string;
    print_areas: Record<string, PrintAreaImage[]>;
  };
  /** Product-reference order line — no print_areas, artwork already lives on the persistent Printify product. */
  type ProductRefLineItem = {
    product_id: string;
    variant_id: number;
    quantity: number;
    external_id: string;
  };
  const lineItems: Array<BakedLineItem | ProductRefLineItem> = [];
  const allUrls: Record<string, string> = {};
  let printifyShopId: string | null = null;
  let printifyToken: string | null = null;
  let firstDesignId: string | null = null;
  let firstProductTypeId: number | null = null;
  let resolvedShop = shopHeader;

  for (const line of args.lines) {
    let resolved: ResolveResult;
    try {
      resolved = await resolveDesignForOrderLine(line, shopHeader);
    } catch (e: any) {
      skippedReasons.push(`line ${line.lineId}: resolve error ${e?.message || e}`);
      continue;
    }
    if (!resolved.ok) {
      skippedReasons.push(`line ${line.lineId}: ${resolved.reason}`);
      continue;
    }

    const productType = resolved.design.productType;
    const designId = resolved.design.designId;
    const merchant = resolved.design.merchant;
    const target = resolvePrintifyTarget(productType, resolved.design.sizeId, resolved.design.colorId);
    if (!target) {
      skippedReasons.push(`line ${line.lineId}: no Printify variant for ${resolved.design.sizeId}:${resolved.design.colorId}`);
      continue;
    }
    printifyShopId = String(merchant.printifyShopId);
    printifyToken = String(merchant.printifyApiToken);
    firstDesignId = firstDesignId ?? designId;
    firstProductTypeId = firstProductTypeId ?? productType.id;
    resolvedShop = resolved.design.shop || resolvedShop;

    // Design product whose artwork already lives on a persistent Printify product
    // (AOP / static products with no on-the-fly bake path) — reference it directly.
    if (resolved.kind === "product_reference") {
      lineItems.push({
        product_id: resolved.design.printifyProductId,
        variant_id: target.printifyVariantId,
        quantity: line.quantity,
        external_id: `${shopifyOrderId || "test"}:${line.lineId || designId}`,
      });
      continue;
    }

    // AOP: submit the captured per-panel print files directly as print_areas —
    // no bake step, these are the exact files the in-app Printify mockups used.
    if (resolved.kind === "aop") {
      const validPlaceholderPositions = await getBlueprintVariantPlaceholders(
        target.blueprintId,
        target.providerId,
        target.printifyVariantId,
        printifyToken!,
      );
      const allowedPositions = validPlaceholderPositions
        ? new Set(validPlaceholderPositions.map((p) => p.position))
        : null;

      const printAreas: Record<string, PrintAreaImage[]> = {};
      for (const panel of resolved.design.panels) {
        if (allowedPositions && !allowedPositions.has(panel.position)) {
          console.warn(
            `[flat-order-fulfillment] Skipping AOP panel "${panel.position}" — not a Printify placeholder for variant ${target.printifyVariantId} (allowed: ${[...allowedPositions].join(", ")})`,
          );
          continue;
        }
        const src = toAbsolutePrintUrl(panel.url);
        printAreas[panel.position] = [{ src, scale: 1, x: 0.5, y: 0.5, angle: 0 }];
        allUrls[`${designId}:${panel.position}`] = src;
      }
      if (Object.keys(printAreas).length === 0) {
        skippedReasons.push(
          `line ${line.lineId}: no AOP print panels match Printify placeholders for variant ${target.printifyVariantId}`,
        );
        continue;
      }
      lineItems.push({
        print_provider_id: target.providerId,
        blueprint_id: target.blueprintId,
        variant_id: target.printifyVariantId,
        quantity: line.quantity,
        external_id: `${shopifyOrderId || "test"}:${line.lineId || designId}`,
        print_areas: printAreas,
      });
      continue;
    }

    let built: { printAreas: Record<string, PrintAreaImage[]>; urls: Record<string, string> } | null = null;
    try {
      built =
        resolved.kind === "tote_folded"
          ? await buildToteFoldedPrintAreasForDesign(resolved.design)
          : await buildPrintAreasForDesign(resolved.design);
    } catch (e: any) {
      // Flat/mesh/tote_folded design products fall back to their persistent Printify
      // product (if publish created one) rather than dropping the line entirely.
      if (resolved.design.printifyProductId) {
        console.warn(
          `[flat-order-fulfillment] line ${line.lineId}: bake failed (${e?.message || e}) — falling back to product-reference order`,
        );
        lineItems.push({
          product_id: resolved.design.printifyProductId,
          variant_id: target.printifyVariantId,
          quantity: line.quantity,
          external_id: `${shopifyOrderId || "test"}:${line.lineId || designId}`,
        });
        continue;
      }
      skippedReasons.push(`line ${line.lineId}: bake failed ${e?.message || e}`);
      continue;
    }
    Object.assign(allUrls, built.urls);
    lineItems.push({
      print_provider_id: target.providerId,
      blueprint_id: target.blueprintId,
      variant_id: target.printifyVariantId,
      quantity: line.quantity,
      external_id: `${shopifyOrderId || "test"}:${line.lineId || designId}`,
      print_areas: built.printAreas,
    });
  }

  if (lineItems.length === 0 || !printifyToken || !printifyShopId) {
    await recordSubmission({
      idempotencyKey: args.idempotencyKey,
      shop: resolvedShop,
      shopifyOrderId,
      designId: firstDesignId,
      productTypeId: firstProductTypeId,
      printifyShopId,
      status: "skipped",
      sentToProduction: false,
      isTest: args.isTest === true,
      metadata: { skippedReasons },
    });
    return {
      status: "skipped",
      eligibleLines: 0,
      skippedReasons,
      sentToProduction: false,
    };
  }

  const orderBody = {
    external_id: args.idempotencyKey,
    label: shopifyOrderId ? `Shopify ${shopifyOrderId}` : `AppAI test ${Date.now()}`,
    line_items: lineItems,
    shipping_method: args.shippingMethod ?? 1,
    send_shipping_notification: false,
    address_to: args.addressTo,
  };

  try {
    const created = await pf<{ id: string }>(`/shops/${printifyShopId}/orders.json`, printifyToken, {
      method: "POST",
      body: JSON.stringify(orderBody),
    });
    const printifyOrderId = String(created.id);

    if (sendToProduction) {
      await pf(`/shops/${printifyShopId}/orders/${printifyOrderId}/send_to_production.json`, printifyToken, {
        method: "POST",
        body: JSON.stringify({}),
      });
    }

    await recordSubmission({
      idempotencyKey: args.idempotencyKey,
      shop: resolvedShop,
      shopifyOrderId,
      designId: firstDesignId,
      productTypeId: firstProductTypeId,
      printifyShopId,
      printifyOrderId,
      status: "submitted",
      sentToProduction: sendToProduction,
      isTest: args.isTest === true,
      printFileUrls: allUrls,
      metadata: { skippedReasons, lineCount: lineItems.length },
    });

    return {
      status: "submitted",
      printifyOrderId,
      eligibleLines: lineItems.length,
      skippedReasons,
      printFileUrls: allUrls,
      sentToProduction: sendToProduction,
    };
  } catch (e: any) {
    const error = e?.message || String(e);
    await recordSubmission({
      idempotencyKey: args.idempotencyKey,
      shop: resolvedShop,
      shopifyOrderId,
      designId: firstDesignId,
      productTypeId: firstProductTypeId,
      printifyShopId,
      status: "failed",
      sentToProduction: false,
      isTest: args.isTest === true,
      printFileUrls: allUrls,
      error,
      metadata: { skippedReasons },
    });
    return {
      status: "failed",
      eligibleLines: lineItems.length,
      skippedReasons,
      error,
      sentToProduction: false,
    };
  }
}

/**
 * Find the most-recent generation job for a product type that carries a
 * `flatPlacerState` (i.e. a real on-the-fly flat/mesh design). Used by the admin
 * test-order endpoint when no explicit designId is supplied.
 */
export async function findLatestFlatDesignJobId(productTypeId: number): Promise<string | null> {
  const product = await storage.getProductType(productTypeId);
  const toteFolded =
    product &&
    usesToteFoldedFulfillment({
      isAllOverPrint: product.isAllOverPrint,
      storefrontMockupMode: (product as any).storefrontMockupMode,
      fulfillmentLayout: (product as any).fulfillmentLayout,
      printifyBlueprintId: product.printifyBlueprintId,
    });

  if (toteFolded) {
    const jobs = await storage.getGenerationJobsByProductType(productTypeId);
    const job = jobs.find((j) => j.status === "complete" && j.designImageUrl) ?? jobs[0];
    return job?.id ?? null;
  }

  // AOP: the usable design is the one whose apply step captured per-panel print
  // files (aopPrintPanelUrls) — those become the order's print_areas directly.
  if (product?.isAllOverPrint) {
    const result = await pool.query<{ id: string }>(
      `SELECT id
         FROM generation_jobs
        WHERE product_type_id = $1
          AND design_state::text LIKE '%aopPrintPanelUrls%'
        ORDER BY created_at DESC
        LIMIT 1`,
      [String(productTypeId)],
    );
    return result.rows[0]?.id ?? null;
  }

  const result = await pool.query<{ id: string }>(
    `SELECT id
       FROM generation_jobs
      WHERE product_type_id = $1
        AND design_image_url IS NOT NULL
        AND design_state::text LIKE '%flatPlacerState%'
      ORDER BY created_at DESC
      LIMIT 1`,
    [String(productTypeId)],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Admin "send test order" helper: resolve a design (explicit or latest) for a
 * product type and submit a DRAFT Printify order using a test ship-to address.
 * Never sends to production. Throws with a clear, merchant-facing message when
 * no usable design exists.
 */
export async function submitFlatTestOrder(args: {
  productType: ProductType;
  designId?: string | null;
  addressTo?: PrintifyAddress;
}): Promise<SubmitFlatOrderResult & { designId: string }> {
  let designId = args.designId?.trim() || null;
  if (!designId) {
    designId = await findLatestFlatDesignJobId(args.productType.id);
  }
  if (!designId) {
    throw new Error(
      args.productType.isAllOverPrint
        ? "No saved AOP design with captured print panels found for this product. Create a design in the customizer and apply the pattern once, then send a test order."
        : "No saved design found for this product. Create a design on this product in the customizer first, then send a test order.",
    );
  }

  const idempotencyKey = `flat-test-order:${args.productType.id}:${designId}:${Date.now()}`;
  // Build a synthetic single-line order keyed by the design id so the standard
  // resolution path (line.properties._appai_job_id → generation_jobs) is used.
  const syntheticOrder = {
    id: idempotencyKey,
    shop_domain: args.productType.shopifyShopDomain || "",
  };
  const line: NormalizedOrderLine = {
    lineId: "test-1",
    variantId: null,
    quantity: 1,
    properties: { _appai_job_id: designId },
  };

  const result = await submitFlatOrderToPrintify({
    shopifyOrder: syntheticOrder,
    lines: [line],
    sendToProduction: false,
    addressTo: args.addressTo ?? resolveTestShipToAddress(),
    idempotencyKey,
    isTest: true,
  });

  return { ...result, designId };
}
