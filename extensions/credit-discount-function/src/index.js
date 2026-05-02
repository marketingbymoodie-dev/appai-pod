// Shopify Discount Function: apply the flat AppAI $1 entitlement stored on the
// Shopify customer metafield. The DB/webhooks remain source of truth; this
// function only reads the synced metafield at checkout.
export function run(input) {
  const metafield = input.cart.buyerIdentity?.customer?.metafield;
  const entitlementCents = Number.parseInt(metafield?.value || "0", 10);
  if (!Number.isFinite(entitlementCents) || entitlementCents <= 0) {
    return { operations: [] };
  }

  const subtotalCents = Math.round(Number.parseFloat(input.cart.cost.subtotalAmount.amount || "0") * 100);
  const discountCents = Math.min(100, entitlementCents, subtotalCents);
  if (discountCents <= 0) {
    return { operations: [] };
  }

  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [
            {
              message: "AppAI credit buyer - $1 off",
              targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
              value: {
                fixedAmount: {
                  amount: (discountCents / 100).toFixed(2),
                  appliesToEachItem: false,
                },
              },
            },
          ],
          selectionStrategy: "FIRST",
        },
      },
    ],
  };
}
