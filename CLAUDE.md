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

**Sticky-header watchdog (`appaiInstallStickyHeaderWatchdog` in `appai-art-embed.js`):** Ritual/Horizon-family `<header-component sticky="scroll-up">` has a theme bug — quick wheel direction changes ending back at the very top can strand it at `data-sticky-state="idle"` + `opacity:0` (invisible menu at scroll 0, reproduced with all app scripts blocked). The watchdog resets it to `"inactive"` when the header sits at its natural top position but stays hidden for ~0.8s. It must never fire mid-page (`rect.top > -4` check) or the theme's hide-on-scroll-down/reveal-on-scroll-up breaks.

Do not remove this without re-testing (a) hard refresh on a long customizer page (mobile + desktop) and (b) fresh landing on Ritual — header/menu must stay visible.

### Catalog placeholder carousel (Primary / View 2 / View 3)

Before the customer generates artwork, `catalogPreviewImages` drives the blank mockup carousel.

- Build from merchant **`primary`** / **`gallery`** / **`custom`** only — not `baseMockupImages.available` (admin picker pool).
- **Dedupe by URL pathname** (ignore query strings) — do not show View 2 / View 3 when they are the same image as Primary.
- Hide carousel UI unless `catalogPreviewImages.length > 1` after dedupe.
- `ProductMockup` blank `<img>` uses `key={blankImageUrl}` so index changes always repaint.

---

## SVG vectorization drops internal colors/sections — fixed 2026-07

**Status: root-cause fixed. Re-verify with real Recraft/Neplex output before fully trusting on a wide multi-color launch batch (unit-tested with synthetic rasters only — see below).**

Root cause: `sanitizeVectorSvg`'s plate-stripping used a blind hue-range match (`isChromaPlateRgb`: high red + high blue + low green) to decide which traced SVG fill/stroke colors were the `#FF00FF` chroma plate. That range is deliberately wide (to survive tracer color quantization drift, e.g. Neplex rounds 255→252), but it's *indistinguishable* from legitimate hot-pink/magenta/fuchsia **design** colors (common in floral designs, exactly what triggered the user report) — both satisfy the same RGB bounds, so any enclosed design shape in that hue got nulled out (`fill="none"`) right alongside the actual background plate.

Fix (`server/replicate-vectorizer.ts`):
- `classifyPlateColorsByConnectivity()` — rasterizes the **raw, unsanitized** trace, flood-fills only pixels within a **tight** Manhattan distance to pure `#FF00FF` (`isPlateFloodPixelRgb`, tolerance 60) starting from the canvas border, then classifies each candidate plate-range SVG color by whether its pixels are majority border-connected (→ strip) or majority enclosed (→ keep). Mirrors the connectivity philosophy `removeChromaKeyBackground` already uses for raster matting (tight flood ≠ wide hue-range candidate net).
- `sanitizeVectorSvgConnected()` — orchestrates: collect wide-range candidate colors from the raw SVG text → rasterize → classify → sanitize using only the classified-as-plate set. Used by both `vectorizeWithRecraft` and `vectorizeWithNeplex` (`server/apparel-matting.ts`) instead of the old blind `sanitizeVectorSvg(svg)` call.
- `apparel-matting.ts`'s `acceptVectorizedOrFallback` also gained a general opaque-coverage-regression QA check (source vs. traced opaque pixel count, <88% retained → fall back to the pre-vectorize PNG) as defense-in-depth for any remaining edge case.
- Unit tests (`server/replicate-vectorizer.test.ts`) cover the exact bug shape: an enclosed hot-pink square inside a `#FF00FF` background must survive; the background must still be stripped.
- Known residual risk: colors *very close* to pure `#FF00FF` itself (inside the tight flood tolerance) still can't be told apart from plate if enclosed — same accepted tradeoff raster matting already makes (see `removeChromaKeyBackground`'s Pass A comment). Only near-exact-key colors, not the broader pink/magenta family.

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
- **Pullover hoodie kangaroo pocket artwork (2026-07):** toggling "Pockets" on in the customer placer never showed artwork for pullover hoodies (worked fine for zip hoodies). Root cause: `front_pocket` lived in the `trim` design group (`shared/hoodieTemplate.ts`), which `HoodieAopPlacer`'s `buildEffectiveRenderConfig` **always** force-disables (`trim: false`, waistband/cuffs must stay solid) — so the pocket panel inherited a disabled group no matter the toggle state. Zip hoodie's `pocket_left`/`pocket_right` were already in the enabled `front-body` group, which is why it worked there. Fix: moved `front_pocket` into `front-body` in `defaultPulloverDesignGroups()`, plus a `normalizeHoodieTemplate()` migration so already-persisted Supabase templates self-heal on load (no backfill script needed — same pattern as the existing legacy-sleeve-group migration in that function).

---

## Code style

- Minimal scope; match surrounding patterns.
- No drive-by refactors.
- Comments only for non-obvious business logic.
- Run `npm run build` after substantive changes.

## Secrets

- **Never read, commit, or log `.env`.** It is gitignored and listed in `.claudeignore`.
- Supabase, Printify, Shopify tokens live in env only.
