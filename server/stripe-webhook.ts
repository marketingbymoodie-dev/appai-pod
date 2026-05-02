import express, { type Express, type Request, type Response } from "express";
import Stripe from "stripe";
import { storage } from "./storage";

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

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      console.log("[Stripe Webhook] session metadata", session.metadata);
      const customerId = session.metadata?.customerId;
      const credits = session.metadata?.credits || session.metadata?.creditsToAdd;

      if (customerId && credits) {
        const customer = await storage.getCustomer(customerId);
        if (customer) {
          const amount = parseInt(credits, 10);
          const priceInCents = session.amount_total || 0;
          const newCredits = customer.credits + amount;
          const newTotalSpent = parseFloat(customer.totalSpent) + priceInCents / 100;

          await storage.updateCustomer(customer.id, {
            credits: newCredits,
            totalSpent: newTotalSpent.toFixed(2),
          });

          await storage.createCreditTransaction({
            customerId: customer.id,
            type: "purchase",
            amount,
            priceInCents,
            description: `Purchased ${amount} credits via Stripe`,
          });

          console.log(`[Stripe Webhook] Credited ${amount} to customer ${customerId}`);
        }
      }
    }

    res.status(200).send("ok");
  });
}
