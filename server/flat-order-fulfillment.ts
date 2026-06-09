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
import { pool } from "./db";
import { storage } from "./storage";
import {
  bakeFlatPrintFile,
  persistBakedPrintFile,
  type FlatPlacement,
} from "./flat-print-file";
import { resolveFlatPrintFileDims, resolveFlatBakePlacementRect } from "./flat-calibration";
import { resolveVariantFromMap, type VariantMap } from "@shared/variantMapResolve";
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
};

export type ResolveResult =
  | { ok: true; design: ResolvedFlatDesign }
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
 * Resolve the design + Printify context for one order line. Returns:
 *   { ok:true }       — eligible flat/mesh on-the-fly line, ready to bake/submit
 *   { ok:false, skip:true }  — cleanly skip (mixed cart / normal product / AOP / no design)
 *   { ok:false, skip:false } — a hard error worth surfacing (e.g. missing creds)
 */
export async function resolveDesignForOrderLine(
  line: NormalizedOrderLine,
  shop: string,
): Promise<ResolveResult> {
  // 1) variant_id → published_products → designId (fallback to line properties)
  let designId: string | null = null;
  let resolvedShop = shop;
  if (line.variantId) {
    const pp = await findPublishedProductByVariant(shop, line.variantId);
    if (pp) {
      designId = pp.designId;
      resolvedShop = pp.shop || shop;
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

  // 3) productTypeId → product_types (must be an eligible flat/mesh on-the-fly product)
  const productType = await storage.getProductType(productTypeId);
  if (!productType) {
    return { ok: false, skip: true, reason: `product type ${productTypeId} not found` };
  }
  const tier = productType.onTheFlyTier;
  if (tier !== "flat" && tier !== "mesh") {
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

  const sizeId = String(line.properties["Size"] || job.size || "default");
  const colorId = String(line.properties["Color"] || job.frameColor || "default");

  return {
    ok: true,
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
  const lineItems: Array<{
    print_provider_id: number;
    blueprint_id: number;
    variant_id: number;
    quantity: number;
    external_id: string;
    print_areas: Record<string, PrintAreaImage[]>;
  }> = [];
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
    const design = resolved.design;
    const target = resolvePrintifyTarget(design.productType, design.sizeId, design.colorId);
    if (!target) {
      skippedReasons.push(`line ${line.lineId}: no Printify variant for ${design.sizeId}:${design.colorId}`);
      continue;
    }
    // All eligible lines for one order must share Printify credentials.
    printifyShopId = String(design.merchant.printifyShopId);
    printifyToken = String(design.merchant.printifyApiToken);
    firstDesignId = firstDesignId ?? design.designId;
    firstProductTypeId = firstProductTypeId ?? design.productType.id;
    resolvedShop = design.shop || resolvedShop;

    let built: { printAreas: Record<string, PrintAreaImage[]>; urls: Record<string, string> };
    try {
      built = await buildPrintAreasForDesign(design);
    } catch (e: any) {
      skippedReasons.push(`line ${line.lineId}: bake failed ${e?.message || e}`);
      continue;
    }
    Object.assign(allUrls, built.urls);
    lineItems.push({
      print_provider_id: target.providerId,
      blueprint_id: target.blueprintId,
      variant_id: target.printifyVariantId,
      quantity: line.quantity,
      external_id: `${shopifyOrderId || "test"}:${line.lineId || design.designId}`,
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
      "No saved design found for this product. Create a design on this product in the customizer first, then send a test order.",
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
