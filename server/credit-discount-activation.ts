// Per-shop activation of the "AppAI Credit Buyer Discount" automatic app discount
// that is backed by extensions/credit-discount-function.
//
// Called best-effort from the OAuth callback. We:
//  1. Look up the deployed Shopify Function by API type + title.
//  2. Check if an automatic discount already references that function id.
//  3. If not, create one via discountAutomaticAppCreate.
//
// Errors are logged and swallowed — install must succeed even if activation
// fails (typically because `shopify app deploy` has not yet published the
// function for this app).

import { shopifyApiCall } from "./shopify";

const FUNCTION_TITLE = "AppAI Credit Buyer Discount";
const DISCOUNT_TITLE = "AppAI Credit Buyer Discount";

interface ShopifyFunctionNode {
  id: string;
  title: string;
  apiType: string;
  app?: { title?: string };
}

interface AutomaticDiscountNode {
  id: string;
  automaticDiscount?: {
    title?: string;
    appDiscountType?: { functionId?: string };
  };
}

async function findCreditFunctionId(shop: string, accessToken: string): Promise<string | null> {
  const query = `
    query AppaiFindCreditFunction {
      shopifyFunctions(first: 50) {
        nodes {
          id
          title
          apiType
          app { title }
        }
      }
    }
  `;
  const result = await shopifyApiCall(shop, accessToken, "graphql.json", {
    method: "POST",
    body: JSON.stringify({ query }),
  });
  if (!result.ok) {
    console.warn("[Credit Discount Activation] shopifyFunctions query failed", { shop, error: result.error });
    return null;
  }
  const nodes: ShopifyFunctionNode[] = result.data?.data?.shopifyFunctions?.nodes ?? [];
  // Prefer exact title + discounts apiType. Fall back to any discounts function
  // owned by this app if the title was renamed at deploy time.
  const exact = nodes.find(
    (n) => n.apiType === "discounts" && n.title === FUNCTION_TITLE,
  );
  if (exact) return exact.id;
  const fuzzy = nodes.find((n) => n.apiType === "discounts" && n.title?.toLowerCase().includes("appai"));
  return fuzzy?.id ?? null;
}

async function findExistingAutomaticDiscountId(
  shop: string,
  accessToken: string,
  functionId: string,
): Promise<string | null> {
  const query = `
    query AppaiFindAutomaticDiscount {
      automaticDiscountNodes(first: 50, query: "type:automatic_app") {
        nodes {
          id
          automaticDiscount {
            ... on DiscountAutomaticApp {
              title
              appDiscountType { functionId }
            }
          }
        }
      }
    }
  `;
  const result = await shopifyApiCall(shop, accessToken, "graphql.json", {
    method: "POST",
    body: JSON.stringify({ query }),
  });
  if (!result.ok) {
    console.warn("[Credit Discount Activation] automaticDiscountNodes query failed", { shop, error: result.error });
    return null;
  }
  const nodes: AutomaticDiscountNode[] = result.data?.data?.automaticDiscountNodes?.nodes ?? [];
  const match = nodes.find((n) => n.automaticDiscount?.appDiscountType?.functionId === functionId);
  return match?.id ?? null;
}

async function createAutomaticAppDiscount(
  shop: string,
  accessToken: string,
  functionId: string,
): Promise<string | null> {
  const mutation = `
    mutation AppaiCreateAutomaticDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
        automaticAppDiscount { discountId title }
        userErrors { field message }
      }
    }
  `;
  const variables = {
    automaticAppDiscount: {
      title: DISCOUNT_TITLE,
      functionId,
      startsAt: new Date().toISOString(),
      combinesWith: {
        orderDiscounts: false,
        productDiscounts: true,
        shippingDiscounts: true,
      },
    },
  };
  const result = await shopifyApiCall(shop, accessToken, "graphql.json", {
    method: "POST",
    body: JSON.stringify({ query: mutation, variables }),
  });
  if (!result.ok) {
    console.warn("[Credit Discount Activation] discountAutomaticAppCreate failed", { shop, error: result.error });
    return null;
  }
  const userErrors = result.data?.data?.discountAutomaticAppCreate?.userErrors ?? [];
  if (Array.isArray(userErrors) && userErrors.length > 0) {
    console.warn("[Credit Discount Activation] userErrors", { shop, userErrors });
    return null;
  }
  const id = result.data?.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId ?? null;
  return id;
}

export async function ensureCreditDiscountActivated(shop: string, accessToken: string): Promise<void> {
  try {
    const functionId = await findCreditFunctionId(shop, accessToken);
    if (!functionId) {
      console.log("[Credit Discount Activation] function not deployed for shop yet — skipping", { shop });
      return;
    }

    const existingId = await findExistingAutomaticDiscountId(shop, accessToken, functionId);
    if (existingId) {
      console.log("[Credit Discount Activation] already active", { shop, existingId, functionId });
      return;
    }

    const newId = await createAutomaticAppDiscount(shop, accessToken, functionId);
    if (newId) {
      console.log("[Credit Discount Activation] created", { shop, newId, functionId });
    }
  } catch (err: any) {
    console.warn("[Credit Discount Activation] unexpected error", { shop, error: err?.message });
  }
}
