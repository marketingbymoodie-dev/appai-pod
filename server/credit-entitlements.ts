import { storage } from "./storage";
import { shopifyApiCall } from "./shopify";

function toShopifyCustomerGid(value: string): string {
  if (value.startsWith("gid://shopify/Customer/")) return value;
  return `gid://shopify/Customer/${value}`;
}

export async function syncCreditEntitlementMetafield(customerId: string): Promise<void> {
  const balance = await storage.ensureCustomerBalance(customerId);
  const aliases = await storage.getCustomerAliases(customerId);
  const shopifyAlias = aliases.find((alias) => alias.aliasType === "shopify" && alias.shop);

  if (!shopifyAlias?.shop) {
    console.log("[Credit Metafield] no Shopify alias; skipping", { customerId, entitlementCents: balance.discountEntitlementCents });
    return;
  }

  const installation = await storage.getShopifyInstallationByShop(shopifyAlias.shop);
  if (!installation?.accessToken) {
    console.warn("[Credit Metafield] missing installation/token", { customerId, shop: shopifyAlias.shop });
    return;
  }

  const mutation = `
    mutation AppAICreditEntitlementSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace value }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    metafields: [
      {
        ownerId: toShopifyCustomerGid(shopifyAlias.aliasValue),
        namespace: "$app:credits",
        key: "off_entitled_cents",
        type: "number_integer",
        value: String(balance.discountEntitlementCents),
      },
    ],
  };

  const result = await shopifyApiCall(shopifyAlias.shop, installation.accessToken, "graphql.json", {
    method: "POST",
    body: JSON.stringify({ query: mutation, variables }),
  });

  const errors = result.data?.data?.metafieldsSet?.userErrors || result.data?.errors;
  if (!result.ok || (Array.isArray(errors) && errors.length > 0)) {
    console.warn("[Credit Metafield] sync failed", { customerId, shop: shopifyAlias.shop, error: result.error, errors });
    return;
  }

  console.log("[Credit Metafield] synced", { customerId, shop: shopifyAlias.shop, entitlementCents: balance.discountEntitlementCents });
}
