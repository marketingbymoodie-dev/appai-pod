# AppAI POD — Claude Code project guide

Shopify + Printify POD app: AI design studio embed, custom mockups, cart/checkout shadow SKUs, flat/mesh on-the-fly rendering.

## Stack

- **Client:** React + Vite (`client/`)
- **Server:** Express (`server/`), builds to `dist/index.cjs`
- **DB:** Drizzle + Postgres
- **Deploy:** Railway watches **`production`** branch (not `main` — `main` push may be branch-protected)
- **Shopify:** theme extension + checkout UI in `extensions/`

## Commands

```bash
npm run dev          # local server
npm run build        # must pass before deploy
npm run shopify:dev  # Shopify app dev
npm run shopify:deploy
```

## Git / deploy conventions

- Only commit when the user asks (or when explicitly shipping deploy-worthy work).
- **Production deploy:** merge to `production`, push → Railway auto-deploys. Sync `main` when possible.
- Do **not** force-push `main`/`master`.
- Never commit `.env` or secrets.

## Do not break (read before touching)

### Shadow SKU + custom checkout mockup

Per-design cart/checkout thumbnails use a **shadow Shopify variant**, not line-item properties alone.

Before changing ATC, variant resolution, theme embed, or cart guard:

1. Read `docs/cart-checkout-custom-mockup-architecture.md`
2. Preserve invariants:
   - Shop domain = `{handle}.myshopify.com` (not bare handle)
   - Valid OAuth token; Admin 401 → generic checkout image
   - Uninstall webhook must not race fresh OAuth (`server/shopify.ts`)

Touch with care: `server/routes.ts` (`resolve-design-variant`), `extensions/theme-extension/`, `client/src/pages/embed-design.tsx` (ATC), `extensions/checkout-ui/`.

### Railway deploy

After **deploy-worthy** fixes (not docs-only): `npm run build` → commit → merge `production` → push.

---

## Storefront embed (`embed-design.tsx` + theme extension)

### Hard refresh must land on the preview box

On Shopify customizer pages the iframe auto-resizes to full content height. Browsers often restore parent scroll near the **footer** after reload, so customers miss the product mockup.

**Invariant:** after config loads, scroll the **preview / image box** into view — not the page bottom. But **only when the preview is actually out of view** (see guard below).

| Layer | Behaviour |
|-------|-----------|
| **Iframe** (`embed-design.tsx`) | `history.scrollRestoration = 'manual'`; scroll iframe to top; `previewLandingRef` on `container-mockup` — scrolled via **own `document.scrollingElement` only, never `scrollIntoView`** (same-origin iframe means `scrollIntoView` also scrolls the parent storefront page); postMessage `ai-art-studio:scroll-to-preview` (retries at 0 / 400 / 1200 ms for resize settle). |
| **Theme** (`appai-art-embed.js` + `design-studio.js`) | Handle `ai-art-studio:scroll-to-preview`: **guard first** — if the embed root's `rect.top` is already in the top half of the viewport, do nothing. Otherwise `scrollIntoView` on embed root + set parent `scrollTop` so embed top is ~16px below viewport top. |

**Why the guard (2026-07, Ritual bug):** the message fires on every load, not just hard refresh. On a fresh navigation the preview is already near the top; scrolling then only trims top margin, and on themes whose header is **not sticky** (Ritual: static header inside the `.page-wrapper` scroller) it pushed the nav menu off-screen — merchants saw "the native menu is removed" on every customizer page open. The guard keeps the hard-refresh-from-footer rescue intact.

Do not remove this without re-testing (a) hard refresh on a long customizer page (mobile + desktop) and (b) fresh landing on Ritual — header/menu must stay visible.

### Catalog placeholder carousel (Primary / View 2 / View 3)

Before the customer generates artwork, `catalogPreviewImages` drives the blank mockup carousel.

- Build from merchant **`primary`** / **`gallery`** / **`custom`** only — not `baseMockupImages.available` (admin picker pool).
- **Dedupe by URL pathname** (ignore query strings) — do not show View 2 / View 3 when they are the same image as Primary.
- Hide carousel UI unless `catalogPreviewImages.length > 1` after dedupe.
- `ProductMockup` blank `<img>` uses `key={blankImageUrl}` so index changes always repaint.

---

## Phone cases (flat calibration) — active problem area

### What Printify expects

- **Print canvas = grey box** = `printFileDims` per model (from Printify placeholders), often tall/narrow (e.g. 1311×2220).
- **Phone back mask** sits **centered** inside that canvas; bleed fills the grey area.
- **Blue guide** = full print canvas; **amber guide** = safe visible back face (inset).
- Art placement is normalized to the **print canvas**; order bake uses full `printFileDims` rect.
- **Side-profile mockups** (iPhone 14/15+ style): Printify mockup PNG includes back + side strip. Must **crop to back face only** before mask/blank/shading setup — not runtime letterboxing on the raw mockup bbox.

### What went wrong (multiple failed iterations)

1. Guides used **mockup pixel bbox** or **back-width ÷ full-mask-width** instead of print-canvas space.
2. Layout fit the **entire PNG rectangle** instead of the **mask alpha silhouette** → phone off-center, art looked zoomed, dashed lines meaningless.
3. Side strip included in bbox → wrong aspect, side profile visible in editor, amber box shifted.
4. Stale `backFaceCropNormalized` vs live mask fighting each other.
5. Mockup API fell back to **wrong color variant** when `variantMap` missing an entry (fixed separately in `shared/variantMapResolve.ts`).

### Current approach (as of 2026-06, commit `7332521` on production)

**Print-canvas-centric layout** in `client/src/components/designer/FlatProductPlacer/lib/flatRender.ts`:

- `flatPrintCanvasLayout()` — centers **mask alpha bounds** in `printFileDims` aspect; computes `phoneBack`, `imageDraw`, `safeZone`, optional `sourceCrop`.
- `renderFlatView()` — grey fill for print canvas, draws blank/mask into `imageDraw`, art on full print canvas, clip to mask.
- Harvest in `server/flat-calibration.ts` — `computePrintCanvasGeometry`, side-profile crop of mask/blank/shading, per-model `geometryByBlank`, `phoneBackNormalized` / `safeZoneNormalized`.

**Mockup cache key** in `embed-design.tsx`: `::pc3` (bump when preview assets must regenerate).

### Key files

| Area | Path |
|------|------|
| Client layout/render | `client/.../FlatProductPlacer/lib/flatRender.ts` |
| Placer UI | `client/.../FlatProductPlacer/index.tsx`, `FlatDesignRectOverlay.tsx` |
| Storefront embed | `client/src/pages/embed-design.tsx` |
| Harvest / manifest | `server/flat-calibration.ts` |
| Order bake | `server/flat-order-fulfillment.ts`, `server/flat-print-file.ts` |
| Per-blank geometry merge | `client/.../FlatProductPlacer/lib/flatAssets.ts` |

### Likely still open after latest deploy

- **Re-calibration** may be needed so blanks/masks are pre-cropped (`sideProfileCropped`) with correct per-model `printFileDims` in `geometryByBlank`.
- Some models may still show side profile if harvested blank was not cropped and runtime `sourceCrop` detection misses the strip.
- Verify iPhone 13 (back-only), 14/15 Pro (side strip removed), 16/17 after hard refresh — guides should align: grey fill = blue box, phone centered, amber inset on back.

### What not to redo

- Letterboxing print aspect on back-face viewport crop (`flatEdgeWrapViewportLayout` approach) — rejected.
- Using full mockup mask bbox as placement rect without side-strip exclusion.
- Falling back to first `variantMap` entry when color doesn't match.

---

## Other recent fixes (context)

- **Garment color dropdown:** Radix scroll buttons blocked lower options; colors without `variantMap` entries now marked unavailable (`FrameColorSelector`, `shared/variantMapResolve.ts`).
- **Framed posters:** blank key resolution order (`size:color` before `white`) — do not regress.

---

## Code style

- Minimal scope; match surrounding patterns.
- No drive-by refactors.
- Comments only for non-obvious business logic.
- Run `npm run build` after substantive changes.

## Secrets

- **Never read, commit, or log `.env`.** It is gitignored and listed in `.claudeignore`.
- Supabase, Printify, Shopify tokens live in env only.
