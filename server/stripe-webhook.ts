import express, { type Express, type Request, type Response } from "express";
import Stripe from "stripe";
import { storage } from "./storage";
import { syncCreditEntitlementMetafield } from "./credit-entitlements";

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" }) : null;

export function registerStripeWebhook(app: Express) {
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req: Request, res: Response) => {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!stripe || !sig || !webhookSecret) {
      console.error("[Stripe Webhook] Error: Missing configuration", { hasStripe: !!stripe, hasSig: !!sig, hasSecret: !!webhookSecret });
      return res.status(400).send("Webhook Error: Missing configuration");
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err: any) {
      console.error(`[Stripe Webhook] Error: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const firstDelivery = await storage.recordStripeEvent(event.id, event.type);
    if (!firstDelivery) {
      console.log("[Stripe Webhook] duplicate event ignored", event.id, event.type);
      return res.status(200).send("ok");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      console.log("[Stripe Webhook] metadata", session.metadata);
      const customerId = session.metadata?.internal_customer_id || session.metadata?.customerId;
      const credits = session.metadata?.credits;
      const entitlementCents = session.metadata?.entitlement_cents || "100";
      const idempotencyKey = session.metadata?.idempotency_key || `stripe:session:${session.id}`;
      console.log("[Stripe Webhook] Crediting customerId", customerId);

      if (customerId && credits) {
        const customer = await storage.getCustomer(customerId);
        if (customer) {
          const amount = parseInt(credits, 10);
          const priceInCents = session.amount_total || 0;
          const result = await storage.applyCreditLedgerEntry({
            customerId: customer.id,
            deltaCredits: amount,
            deltaEntitlementCents: Math.min(100, Math.max(0, parseInt(entitlementCents, 10) || 0)),
            reason: "purchase",
            idempotencyKey,
            externalRef: session.id,
            metadata: {
              stripeEventId: event.id,
              paymentIntent: typeof session.payment_intent === "string" ? session.payment_intent : null,
              priceInCents,
            },
          });

          if (result.inserted) {
            await storage.createCreditTransaction({
              customerId: customer.id,
              type: "purchase",
              amount,
              priceInCents,
              description: `Purchased ${amount} credits via Stripe`,
            });
          }

          await storage.markStripeEventOutcome(event.id, result.inserted ? "processed" : "duplicate-ledger");
          if (result.inserted) {
            await syncCreditEntitlementMetafield(customer.id).catch((err) =>
              console.warn("[Stripe Webhook] entitlement metafield sync failed", err),
            );
          }
          console.log(`[Stripe Webhook] Credited ${result.inserted ? amount : 0} to customer ${customerId}`);
        } else {
          await storage.markStripeEventOutcome(event.id, "customer-not-found");
        }
      } else {
        await storage.markStripeEventOutcome(event.id, "missing-metadata");
      }
    } else {
      await storage.markStripeEventOutcome(event.id, "ignored");
    }

    res.status(200).send("ok");
  });
}
