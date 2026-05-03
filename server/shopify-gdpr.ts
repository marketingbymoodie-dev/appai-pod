import type { Express, Request, Response } from "express";
import crypto from "crypto";
import { pool } from "./db";

const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "";

type ShopifyGdprCustomer = {
  id?: number | string;
  email?: string;
  phone?: string;
};

type ShopifyGdprPayload = {
  shop_domain?: string;
  shop_id?: number | string;
  customer?: ShopifyGdprCustomer;
  orders_requested?: number[];
  data_request?: { id?: number | string };
};

function rawBodyForHmac(req: Request): Buffer {
  const rawBody = (req as any).rawBody;
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === "string") return Buffer.from(rawBody, "utf8");
  return Buffer.from(JSON.stringify(req.body ?? {}), "utf8");
}

function verifyShopifyWebhookHmac(req: Request): boolean {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const hmac = Array.isArray(hmacHeader) ? hmacHeader[0] : hmacHeader;
  if (!SHOPIFY_API_SECRET || !hmac) return false;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(rawBodyForHmac(req))
    .digest("base64");

  try {
    return (
      digest.length === hmac.length &&
      crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(hmac, "utf8"))
    );
  } catch {
    return false;
  }
}

function normalizeShopDomain(req: Request, payload: ShopifyGdprPayload): string {
  const headerShop = req.headers["x-shopify-shop-domain"];
  const shop = Array.isArray(headerShop) ? headerShop[0] : headerShop;
  return String(shop || payload.shop_domain || "").trim().toLowerCase();
}

function customerIdVariants(customer: ShopifyGdprCustomer | undefined): string[] {
  const raw = customer?.id;
  if (raw === undefined || raw === null || raw === "") return [];
  const numeric = String(raw).replace("gid://shopify/Customer/", "");
  return Array.from(new Set([numeric, `gid://shopify/Customer/${numeric}`]));
}

async function findInternalCustomerIds(shop: string, customer: ShopifyGdprCustomer | undefined): Promise<string[]> {
  const ids = customerIdVariants(customer);
  const email = customer?.email?.trim().toLowerCase();
  const values: string[] = [];
  values.push(...ids);
  if (email) values.push(email);
  if (values.length === 0) return [];

  const result = await pool.query<{ customer_id: string }>(
    `
      SELECT DISTINCT customer_id
      FROM customer_aliases
      WHERE
        (
          alias_type = 'shopify'
          AND alias_value = ANY($1::text[])
          AND (shop = $2 OR shop IS NULL)
        )
        OR (
          alias_type = 'otp_email'
          AND lower(alias_value) = $3
        )
    `,
    [values, shop, email ?? ""],
  );
  return result.rows.map((row) => row.customer_id);
}

async function exportCustomerData(shop: string, customer: ShopifyGdprCustomer | undefined) {
  const customerIds = await findInternalCustomerIds(shop, customer);
  if (customerIds.length === 0) {
    return { shop, shopifyCustomer: customer ?? null, matchedCustomerIds: [], records: {} };
  }

  const client = await pool.connect();
  try {
    const params = [customerIds];
    const [
      customers,
      aliases,
      balances,
      ledger,
      transactions,
      designs,
      orders,
      generationLogs,
      jobs,
      customizerDesignRows,
      publishedProductRows,
      discountClaims,
    ] = await Promise.all([
      client.query("SELECT id, user_id, credits, free_generations_used, total_generations, total_spent, created_at, updated_at FROM customers WHERE id = ANY($1::text[])", params),
      client.query("SELECT customer_id, alias_type, alias_value, shop, created_at FROM customer_aliases WHERE customer_id = ANY($1::text[])", params),
      client.query("SELECT * FROM credit_balances WHERE customer_id = ANY($1::text[])", params),
      client.query("SELECT customer_id, delta_credits, delta_entitlement_cents, reason, external_ref, metadata, created_at FROM credit_ledger WHERE customer_id = ANY($1::text[]) ORDER BY created_at DESC LIMIT 500", params),
      client.query("SELECT customer_id, type, amount, price_in_cents, order_id, description, created_at FROM credit_transactions WHERE customer_id = ANY($1::text[])", params),
      client.query("SELECT id, customer_id, merchant_id, product_type_id, prompt, style_preset, size, frame_color, status, created_at, updated_at FROM designs WHERE customer_id = ANY($1::text[])", params),
      client.query("SELECT id, customer_id, merchant_id, status, size, frame_color, quantity, price_in_cents, shipping_in_cents, credit_refund_in_cents, created_at, updated_at FROM orders WHERE customer_id = ANY($1::text[])", params),
      client.query("SELECT customer_id, merchant_id, design_id, prompt_length, had_reference_image, style_preset, size, success, error_message, created_at FROM generation_logs WHERE customer_id = ANY($1::text[])", params),
      client.query("SELECT id, shop, session_id, customer_id, status, design_id, created_at, updated_at FROM generation_jobs WHERE customer_id = ANY($1::text[])", params),
      client.query("SELECT id, shop, shopify_customer_id, customer_key, base_variant_id, status, created_at, updated_at FROM customizer_designs WHERE shop = $2 AND (shopify_customer_id = ANY($3::text[]) OR customer_key = ANY($4::text[]))", [customerIds, shop, customerIdVariants(customer), customerIds]),
      client.query("SELECT id, shop, design_id, customer_key, shopify_product_id, shopify_variant_id, status, created_at, updated_at FROM published_products WHERE shop = $2 AND customer_key = ANY($1::text[])", [customerIds, shop]),
      client.query("SELECT customer_id, shopify_order_id, shop, entitlement_cents, status, created_at, updated_at FROM order_discount_claims WHERE customer_id = ANY($1::text[])", params),
    ]);

    return {
      shop,
      shopifyCustomer: customer ?? null,
      matchedCustomerIds: customerIds,
      records: {
        customers: customers.rows,
        customerAliases: aliases.rows,
        creditBalances: balances.rows,
        creditLedger: ledger.rows,
        creditTransactions: transactions.rows,
        designs: designs.rows,
        orders: orders.rows,
        generationLogs: generationLogs.rows,
        generationJobs: jobs.rows,
        customizerDesigns: customizerDesignRows.rows,
        publishedProducts: publishedProductRows.rows,
        orderDiscountClaims: discountClaims.rows,
      },
    };
  } finally {
    client.release();
  }
}

async function redactCustomerData(shop: string, customer: ShopifyGdprCustomer | undefined): Promise<{ customerIds: string[]; deletedRows: Record<string, number> }> {
  const customerIds = await findInternalCustomerIds(shop, customer);
  const deletedRows: Record<string, number> = {};
  if (customerIds.length === 0) return { customerIds, deletedRows };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const shopifyIds = customerIdVariants(customer);
    const customerKeys = [...customerIds, ...shopifyIds.map((id) => `shopify:${shop}:${id}`)];

    const deletions: Array<[string, string, any[]]> = [
      ["order_discount_claims", "DELETE FROM order_discount_claims WHERE customer_id = ANY($1::text[])", [customerIds]],
      ["credit_ledger", "DELETE FROM credit_ledger WHERE customer_id = ANY($1::text[])", [customerIds]],
      ["credit_transactions", "DELETE FROM credit_transactions WHERE customer_id = ANY($1::text[])", [customerIds]],
      ["credit_balances", "DELETE FROM credit_balances WHERE customer_id = ANY($1::text[])", [customerIds]],
      ["coupon_redemptions", "DELETE FROM coupon_redemptions WHERE customer_id = ANY($1::text[])", [customerIds]],
      ["generation_logs", "DELETE FROM generation_logs WHERE customer_id = ANY($1::text[])", [customerIds]],
      ["orders", "DELETE FROM orders WHERE customer_id = ANY($1::text[])", [customerIds]],
      ["designs", "DELETE FROM designs WHERE customer_id = ANY($1::text[])", [customerIds]],
      ["generation_jobs", "DELETE FROM generation_jobs WHERE customer_id = ANY($1::text[])", [customerIds]],
      ["published_products", "DELETE FROM published_products WHERE shop = $2 AND customer_key = ANY($1::text[])", [customerKeys, shop]],
      ["customizer_designs", "DELETE FROM customizer_designs WHERE shop = $2 AND (shopify_customer_id = ANY($3::text[]) OR customer_key = ANY($1::text[]))", [customerKeys, shop, shopifyIds]],
      ["customer_aliases", "DELETE FROM customer_aliases WHERE customer_id = ANY($1::text[])", [customerIds]],
      ["customers", "DELETE FROM customers WHERE id = ANY($1::text[])", [customerIds]],
    ];

    for (const [name, sql, params] of deletions) {
      const result = await client.query(sql, params);
      deletedRows[name] = result.rowCount ?? 0;
    }

    await client.query("COMMIT");
    return { customerIds, deletedRows };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function redactShopData(shop: string): Promise<Record<string, number>> {
  const deletedRows: Record<string, number> = {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deletions: Array<[string, string, any[]]> = [
      ["order_discount_claims", "DELETE FROM order_discount_claims WHERE shop = $1", [shop]],
      ["customer_aliases", "DELETE FROM customer_aliases WHERE shop = $1", [shop]],
      ["generation_jobs", "DELETE FROM generation_jobs WHERE shop = $1", [shop]],
      ["published_products", "DELETE FROM published_products WHERE shop = $1", [shop]],
      ["customizer_designs", "DELETE FROM customizer_designs WHERE shop = $1", [shop]],
      ["customizer_pages", "DELETE FROM customizer_pages WHERE shop = $1", [shop]],
      ["design_sku_mappings", "DELETE FROM design_sku_mappings WHERE shop_domain = $1", [shop]],
      ["shared_designs", "DELETE FROM shared_designs WHERE shop_domain = $1", [shop]],
      ["product_types", "UPDATE product_types SET shopify_product_id = NULL, shopify_product_handle = NULL, shopify_product_url = NULL, shopify_shop_domain = NULL, shopify_variant_ids = NULL, last_pushed_to_shopify = NULL WHERE shopify_shop_domain = $1", [shop]],
      ["shopify_installations", "DELETE FROM shopify_installations WHERE shop_domain = $1", [shop]],
    ];

    for (const [name, sql, params] of deletions) {
      const result = await client.query(sql, params);
      deletedRows[name] = result.rowCount ?? 0;
    }

    await client.query("COMMIT");
    return deletedRows;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function requireVerifiedWebhook(req: Request, res: Response): boolean {
  if (verifyShopifyWebhookHmac(req)) return true;
  console.warn("[Shopify GDPR] invalid webhook HMAC", {
    topic: req.headers["x-shopify-topic"],
    shop: req.headers["x-shopify-shop-domain"],
  });
  res.status(401).send("HMAC verification failed");
  return false;
}

export function registerShopifyGdprRoutes(app: Express): void {
  app.post("/shopify/webhooks/customers-data-request", async (req: Request, res: Response) => {
    if (!requireVerifiedWebhook(req, res)) return;
    const payload = req.body as ShopifyGdprPayload;
    const shop = normalizeShopDomain(req, payload);

    try {
      const exportPayload = await exportCustomerData(shop, payload.customer);
      console.log("[Shopify GDPR] customer data request prepared", {
        shop,
        requestId: payload.data_request?.id,
        matchedCustomerIds: exportPayload.matchedCustomerIds.length,
        recordGroups: Object.keys(exportPayload.records ?? {}),
      });
      // Shopify requires a 200 acknowledgement. The export is intentionally
      // logged as metadata only; support can generate the full export by replaying
      // this helper if the merchant asks for the file.
      res.status(200).send("OK");
    } catch (err: any) {
      console.error("[Shopify GDPR] customers/data_request failed", { shop, error: err?.message });
      res.status(500).send("Failed to process data request");
    }
  });

  app.post("/shopify/webhooks/customers-redact", async (req: Request, res: Response) => {
    if (!requireVerifiedWebhook(req, res)) return;
    const payload = req.body as ShopifyGdprPayload;
    const shop = normalizeShopDomain(req, payload);

    try {
      const result = await redactCustomerData(shop, payload.customer);
      console.log("[Shopify GDPR] customer redacted", {
        shop,
        shopifyCustomerId: payload.customer?.id,
        matchedCustomerIds: result.customerIds.length,
        deletedRows: result.deletedRows,
      });
      res.status(200).send("OK");
    } catch (err: any) {
      console.error("[Shopify GDPR] customers/redact failed", { shop, error: err?.message });
      res.status(500).send("Failed to redact customer");
    }
  });

  app.post("/shopify/webhooks/shop-redact", async (req: Request, res: Response) => {
    if (!requireVerifiedWebhook(req, res)) return;
    const payload = req.body as ShopifyGdprPayload;
    const shop = normalizeShopDomain(req, payload);

    try {
      const deletedRows = await redactShopData(shop);
      console.log("[Shopify GDPR] shop redacted", { shop, deletedRows });
      res.status(200).send("OK");
    } catch (err: any) {
      console.error("[Shopify GDPR] shop/redact failed", { shop, error: err?.message });
      res.status(500).send("Failed to redact shop");
    }
  });
}
