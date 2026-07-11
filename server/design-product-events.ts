/**
 * Analytics events for permanent "design products" (My Designs → List as product).
 * Populated from:
 *   - the `orders/paid` webhook (sale events) — see server/routes.ts.
 *   - `carts/create` / `carts/update` webhooks (atc events) — see server/routes.ts.
 * Backs the My Orders stats dashboard (GET /api/appai/design-products/stats).
 *
 * NOTE: `orders/paid` is not yet subscribed in shopify.app.toml (pending Protected
 * Customer Data approval — see the comment there), so sale events won't populate in
 * production until that's approved. The wiring is in place so it activates automatically
 * once the topic is re-enabled.
 */
import { pool } from "./db";

/** Look up a permanent design product by its purchasable Shopify variant id (numeric, no gid prefix). */
export async function findDesignProductRowByVariant(
  shop: string,
  variantId: string,
): Promise<{ id: string } | null> {
  const numeric = variantId.replace("gid://shopify/ProductVariant/", "");
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM design_products WHERE shop = $1 AND variant_map::jsonb ? $2 LIMIT 1`,
    [shop, numeric],
  );
  return result.rows[0] ?? null;
}

/**
 * Record a sale event for one order line. Idempotent per (designProductId, orderId, lineId)
 * via a partial unique index — safe to call on webhook replay.
 */
export async function recordDesignProductSale(args: {
  designProductId: string;
  shopifyOrderId: string;
  lineId: string;
  quantity: number;
  amountCents: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO design_product_events (design_product_id, event_type, quantity, amount_cents, shopify_order_id, cart_token)
     VALUES ($1, 'sale', $2, $3, $4, $5)
     ON CONFLICT (design_product_id, shopify_order_id, cart_token) WHERE event_type = 'sale' DO NOTHING`,
    [args.designProductId, args.quantity, args.amountCents, args.shopifyOrderId, args.lineId],
  );
}

/**
 * Record an add-to-cart event, deduped by cart token (repeat carts/update webhooks for the
 * same cart + variant don't inflate the count).
 */
export async function recordDesignProductAtc(args: {
  designProductId: string;
  cartToken: string;
  quantity: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO design_product_events (design_product_id, event_type, quantity, cart_token)
     VALUES ($1, 'atc', $2, $3)
     ON CONFLICT (design_product_id, cart_token) WHERE event_type = 'atc' DO NOTHING`,
    [args.designProductId, args.quantity, args.cartToken],
  );
}

type NormalizedWebhookLine = { variantId: string | null; quantity: number; lineId: string; price?: string };

function extractLines(order: any): NormalizedWebhookLine[] {
  if (!Array.isArray(order?.line_items)) return [];
  return order.line_items.map((l: any) => ({
    variantId: l?.variant_id != null ? String(l.variant_id) : null,
    quantity: Number(l?.quantity ?? 1) || 1,
    lineId: String(l?.id ?? l?.line_item_id ?? `${l?.variant_id ?? "unknown"}`),
    price: l?.price != null ? String(l.price) : undefined,
  }));
}

/** Called from the orders/paid webhook handler — records a sale event per matching line. */
export async function recordDesignProductSalesForOrder(shop: string, order: any): Promise<void> {
  const orderId = String(order?.admin_graphql_api_id || order?.id || "");
  if (!orderId) return;
  const lines = extractLines(order);
  for (const line of lines) {
    if (!line.variantId) continue;
    try {
      const match = await findDesignProductRowByVariant(shop, line.variantId);
      if (!match) continue;
      const unitPriceCents = Math.round(parseFloat(line.price || "0") * 100) || 0;
      await recordDesignProductSale({
        designProductId: match.id,
        shopifyOrderId: orderId,
        lineId: line.lineId,
        quantity: line.quantity,
        amountCents: unitPriceCents * line.quantity,
      });
    } catch (e: any) {
      console.warn("[design-product-events] sale recording failed for line", line.lineId, e?.message ?? e);
    }
  }
}

/** Called from carts/create + carts/update webhooks — records an atc event per matching line. */
export async function recordDesignProductAtcForCart(shop: string, cart: any): Promise<void> {
  const cartToken = String(cart?.token || cart?.id || "");
  if (!cartToken) return;
  const lines = extractLines(cart);
  for (const line of lines) {
    if (!line.variantId) continue;
    try {
      const match = await findDesignProductRowByVariant(shop, line.variantId);
      if (!match) continue;
      // dedupe key is per (product, cart) — one atc credit per cart regardless of quantity edits
      await recordDesignProductAtc({
        designProductId: match.id,
        cartToken: `${cartToken}:${line.variantId}`,
        quantity: line.quantity,
      });
    } catch (e: any) {
      console.warn("[design-product-events] atc recording failed for cart", cartToken, e?.message ?? e);
    }
  }
}
