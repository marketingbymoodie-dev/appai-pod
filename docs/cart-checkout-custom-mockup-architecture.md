# Custom mockup in cart and checkout (shadow product / shadow SKU)

This document describes the **only reliable pattern this app uses** so a buyer sees a **per-design image** in the **cart and checkout** (not the generic base-product image), and how that relates to a possible **smaller “side” app** without the AI art studio.

It is the companion to the implementation in code; see also **`.cursor/rules/shadow-sku-custom-mockup.mdc`**.

---

## The core limitation (all Shopify plans)

**Checkout and cart line thumbnails** are driven by the **line item’s product variant** in almost all setups. **Line item properties** (e.g. a URL) do **not** replace Shopify’s built-in line image. That is why “just pass a custom image URL on the line” is not enough for the **default** thumbnail the customer sees, unless you add something else (see below).

**Shopify Plus** adds more checkout customization (e.g. UI extensions, some branding APIs). This project does **not** depend on Plus for the main trick: a **dedicated variant whose image is the mockup**.

---

## The approach used here: on-the-fly “shadow” product + variant

1. The merchant keeps a **real catalog product** (the “base” product) with normal variants (size, color, etc.).
2. When a buyer finishes a design, the app calls **`POST /api/storefront/resolve-design-variant`** (server: `server/routes.ts`) with at least: `shop` (must be `*.myshopify.com` after normalization), base **`variantId`**, stable **`designId`**, and HTTPS **`mockupUrl`**.
3. The backend uses the **Admin API** (OAuth `accessToken` for that shop) to:
   - Resolve the **canonical `productId`** from the base variant.
   - Create a **separate, hidden / unlisted Shopify product** (a “shadow” product) whose **image is the mockup**, and a **single purchasable variant** priced from the base variant, published to the **Online Store** sales channel.
   - Store the mapping (design → shadow `variantId`) so repeat visits can reuse the same row.
4. The **add-to-cart** path adds **the shadow variant’s id**, not the base catalog variant, so the **native** cart and checkout show the **shadow variant’s image** — i.e. the custom mockup.

**Why not “just unique product IDs in the admin”?**

- You cannot invent variant IDs. They are created by Shopify when a **product/variant** exists.
- Pre-creating an unlimited number of variants in the catalog **ahead of time** is not practical for one-off custom art. **Shadow products created at order time** scale for arbitrary designs.

**Combination with a generic base product**

- The **base** product/variant is still the “template” for price, options, and Printify/fulfillment configuration.
- The **shadow** product is a **presentation + purchasable handle** for that specific design; fulfillment logic should still read **design id, artwork URL, and/or base variant** from line properties or your database — not assume the shadow SKU is the long-term product identity in Printify.

---

## Line item properties: what we attach

- **`_mockup_url`** (underscore) — used internally; underscore-prefixed properties are **hidden** from the buyer in most themes and checkout.
- **Avoid** shipping **`mockup_url`** (no underscore) as a visible line property if you do not want URLs shown in cart/checkout.
- The **thumbnail** is still the **variant image** from the shadow product, not the property.

---

## Storefront wiring (do not break casually)

| Piece | Role |
|--------|------|
| `server/routes.ts` | `POST /api/storefront/resolve-design-variant`, `normalizeMyshopifyShopDomain`, `getAuthorizedInstallation`, `markShopTokenInvalid` on Admin API 401/403. |
| `server/shopify.ts` | OAuth `GET /shopify/callback` stores token; **`app/uninstall` webhook** must not clobber a **fresh** reinstall (stale-uninstall skip within ~90s of `installedAt`). |
| `extensions/theme-extension/.../ai-art-embed.liquid` | Calls `resolveDesignSku` / API with **normalized** shop; ATC uses returned shadow **variant_id**. |
| `extensions/theme-extension/assets/appai-cart-guard.js` | Injects **`_mockup_url`**; keeps buyer-visible `mockup_url` / `image` props out. |
| `client/src/pages/embed-design.tsx` | `resolveShopDomain`, add-to-cart payload, coordinates with theme. |
| `extensions/checkout-ui` (optional) | UI extension for extra mockup copy; **not required** if the shadow variant image is correct. Bundle lines may need `collectCartLineAttributes` for attributes on child line components. |

**Operational requirement:** the shop’s **installation** row must have a **valid Admin API token**. Reinstall or refresh OAuth if Admin API returns 401. **Shop domain** must match DB (`store.myshopify.com`).

---

## Mockup speed vs file size (Printify preview path)

- Mockups are built in **`server/printify-mockups.ts`** (and the `/api/mockup/generate` route): uploads to Printify, **temporary** Printify product, then mockup fetch. **Latency is dominated by** Printify and network **round-trips**, not a separate aggressive “mockup-only compression” step in this repo.
- AOP panels: non-PNG panels may be re-encoded to PNG; **PNG** panels are **not** re-encoded to avoid extra CPU (see comments in that file).
- **Pushing under ~10 seconds end-to-end** is an operations/tuning target: reduce **number of mockup views** returned, **parallelism** (already limited), and **source image** size/CPU on the client **only if** you still meet **print safe** minima for the blueprint (Printify documents minimum px per print area).
- **Important:** the **images Printify returns for mockups** are for **merchandising preview**. They are **not** automatically the same as the file you want for **final print** on a production order. **Confirm separately** (test orders) that your order → Printify (or OMS) pipeline sends the **high-resolution print file** (e.g. your stored `generatedImageUrl` / print-ready export), **not** a downscaled mockup or thumbnail.

---

## Lighter standalone app (no AI): what to reuse

A smaller app can **drop image generation** but **keep**:

1. **Shopify OAuth** + `accessToken` storage and **uninstall** handling.
2. **`resolve-design-variant`** (or a renamed equivalent) that creates the **shadow product** from a **supplied** HTTPS image URL (from your uploader, or from your own “generate mockup only” service).
3. **Theme + cart** integration: call resolve **before** `/cart/add.js` with the shadow **variant_id**; pass **`_mockup_url`** and design metadata as needed for fulfillment.
4. **Domain normalization** everywhere (`*.myshopify.com`).

You **still** need the **shadow product** (or an equivalent that creates a **real** variant with the right image) if you want **native** cart/checkout thumbnails the way this app does.

---

## Suggested manual regression checks (after risky changes)

1. `POST /api/storefront/resolve-design-variant` → **200**, `success: true`, new shadow `variantId` (or `reused: true` for same `designId`).
2. New ATC line: **line.variant_id** is the **shadow** variant, not the base.
3. Checkout: line image matches custom mockup; multiple lines with same base product keep **distinct** images.
4. **Saved designs** / storefront: `POST /api/storefront/customizer/my-designs` is **200** (not `Shop not authorized`).

---

*Last updated to match app behavior at time of writing; if behavior diverges, update this file and `.cursor/rules/shadow-sku-custom-mockup.mdc` together.*
