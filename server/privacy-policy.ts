export const privacyPolicyHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI Art Studio Privacy Policy</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 860px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #111827; }
    h1, h2 { line-height: 1.25; }
    h1 { margin-bottom: 0.25rem; }
    .muted { color: #6b7280; }
    ul { padding-left: 1.4rem; }
  </style>
</head>
<body>
  <h1>AI Art Studio Privacy Policy</h1>
  <p class="muted">Last updated: May 3, 2026</p>

  <p>
    AI Art Studio ("AppAI", "we", "us") provides AI artwork generation,
    product customization, cart/checkout image support, and customer credit
    purchase features for Shopify merchants.
  </p>

  <h2>Personal Data We Process</h2>
  <p>We process the minimum customer personal data needed to provide the app:</p>
  <ul>
    <li>Shopify shop domain and app installation details.</li>
    <li>Shopify customer ID and, where provided by the customer, email address.</li>
    <li>Customer artwork prompts, generated design metadata, and design status.</li>
    <li>Credit balances, credit ledger entries, Stripe Checkout session references, and discount entitlement amounts.</li>
    <li>Shopify order ID and discount application metadata when a credit discount is redeemed.</li>
  </ul>
  <p>
    We do not sell customer personal data and we do not use it for unrelated
    advertising or profiling.
  </p>

  <h2>Why We Process Personal Data</h2>
  <p>We use this data only to:</p>
  <ul>
    <li>Generate and display customer-created artwork.</li>
    <li>Maintain accurate paid credit and free generation balances.</li>
    <li>Apply and consume one-time checkout credit discounts.</li>
    <li>Create product/mockup records needed for cart and checkout display.</li>
    <li>Support merchant troubleshooting, fraud prevention, and legal compliance.</li>
  </ul>

  <h2>Sharing</h2>
  <p>
    We share data only with service providers required to operate the app,
    including Shopify, Railway-hosted infrastructure, Stripe for payment
    processing, Supabase or object storage providers for generated assets, and
    email delivery providers for verification messages. These providers process
    data on our behalf.
  </p>

  <h2>Security and Retention</h2>
  <p>
    Data is transmitted over HTTPS and stored in managed infrastructure with
    encryption at rest. Production access is limited to authorized operators.
    We retain personal data only while needed to provide the app, support
    merchants, comply with legal obligations, or resolve disputes.
  </p>

  <h2>Deletion and Access Requests</h2>
  <p>
    We support Shopify's required privacy webhooks for customer data requests,
    customer redaction, and shop redaction. When a customer or merchant requests
    deletion through Shopify, we delete or anonymize the matching app records
    within Shopify's required timelines.
  </p>

  <h2>Contact</h2>
  <p>
    Merchants can contact us about privacy or data protection requests through
    the support contact listed on the AI Art Studio Shopify app listing.
  </p>
</body>
</html>`;
