# AOP known-good snapshots

Per-product **signed-off** pins on `production`. Each entry records the commit (and stack) where that product’s AOP pipeline was verified — in-app preview, Printify mockups, and print export — so you can revert or cherry-pick if a later change regresses one product without guessing.

**Do not** treat these as “never change this code.” They are **revert targets** and **regression baselines**, not permanent lockdowns (see `docs/iframe-scroll-architecture.md` for that pattern).

## Index

| Product | Blueprint | Signed off | Pin commit | Doc |
|---------|-----------|------------|------------|-----|
| Zip hoodie | 451 | 2026-07-17 | `aabd9b6` | [zip-hoodie-bp451.md](./zip-hoodie-bp451.md) |
| Pullover hoodie | 450 | 2026-07-17 | `e636838` | [pullover-hoodie-bp450.md](./pullover-hoodie-bp450.md) |
| Unisex sweatshirt | 449 | 2026-07-18 | `0c010e5` | [sweatshirt-bp449.md](./sweatshirt-bp449.md) |
| Men's bomber jacket | 433 | 2026-07-20 (Place on item + Pattern) | `088fd23` | [bomber-jacket-bp433.md](./bomber-jacket-bp433.md) |

*Add a row when a product gets merchant sign-off.*

## When to add a snapshot

1. Merchant (or you) confirms the product is **perfect** on live/dev after deploy — Place on item, Pattern mode (if applicable), Printify parity.
2. Note the **`production` commit SHA** at sign-off (not “latest main”).
3. Add `docs/aop-known-good-snapshots/<product-slug>.md` using the template below.
4. Update this index table.
5. Commit docs to `production` (no Railway redeploy required for docs-only, but keeps the pin in git history next to code).

## When to use a snapshot

- A shared AOP change broke **one** product → Option B/C in the product doc (revert commit or restore listed files).
- Multiple products broken and you need the last known-good **whole tree** → Option A (reset `production` to that product’s pin only if that pin is still the global best; otherwise pick the newest pin that still passes all signed-off products).

If two products pin different commits, prefer **surgical** reverts (Option B/C) over resetting `production` to an older global pin.

## New snapshot template

Copy to `docs/aop-known-good-snapshots/<slug>.md`:

```markdown
# <Product name> AOP (bp XXX) — known-good snapshot

**Status: VERIFIED WORKING (YYYY-MM-DD, merchant sign-off).**

## Pin commit (production)

| Field | Value |
|-------|--------|
| **Commit** | `<full-sha>` (`<short>`) |
| **Branch** | `production` |
| **Date** | YYYY-MM-DD |
| **Message** | `<subject line>` |

## What was verified working

- Place on item — …
- Pattern mode — …
- In-app preview ↔ Printify — …

## Critical implementation

(Files, functions, invariants — only what differs or must not regress for this product.)

## Revert to this snapshot

(Option A / B / C — same pattern as zip-hoodie doc.)

## Verification checklist

- [ ] …

---

*Snapshot recorded: YYYY-MM-DD.*
```

## Related docs

- `docs/aop-calibration-storage.md` — template / mesh persistence
- `docs/cart-checkout-custom-mockup-architecture.md` — shadow SKU (orthogonal to AOP print)
