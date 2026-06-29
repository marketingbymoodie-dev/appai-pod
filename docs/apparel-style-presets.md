# Apparel style presets — chroma key requirements

Apparel artwork uses **hot pink chroma key** (`#FF00FF`) for background removal. The server strips the pink (and white/grey mats) after generation and saves a **transparent PNG**. Merchants see the garment color through transparent pixels in the AOP placer and mockups.

## Required language in every apparel `promptPrefix`

Every apparel style must include:

1. **`#FF00FF` / hot pink** — the only background color edge-to-edge.
2. **No white mat** — no white plate, card, rectangle, frame, or `#FFFFFF` background.
3. **Design color guard** — light tier: avoid white/light/pink in the subject. Dark tier: allow white/light in subject, still avoid pink in subject.
4. **Hard edges** — no drop shadow, outer glow, or gradient halos into the background.

### Copy-paste template (light garment / default tier)

```
T-shirt graphic, [STYLE DESCRIPTION], flat vibrant colors (avoid white, light colors, and hot pink/magenta in the design), high contrast, centered, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, no white mat, no rectangular frame. Create a [style noun] of
```

### Copy-paste template (dark garment tier)

Same as above but replace the color line with:

```
bright vibrant colors including white and light tones (avoid dark, black, and hot pink/magenta colors in the design)
```

Append the user’s subject after the trailing `of` (e.g. `scary grizzly bear standing up`).

## Canonical repo-defined styles

These names are **enforced server-side** via `resolveApparelStylePrefix()` — Admin edits to `promptPrefix` for these names are replaced with the repo canonical copy on every generate request.

| Style name | Repo id | Category |
|------------|---------|----------|
| Free 4 All | `free-4-all` | apparel |
| Pattern Maker | `pattern-maker` | apparel |
| Opinionated | `opinionated` | apparel |
| Quotes | `quotes` | apparel |
| Pet Portraits | `pet-portraits` | apparel |
| Centered Graphic | `centered-graphic` | apparel |
| Illustrated Motif | `illustrated-motif` | apparel |

Source of truth: [`shared/schema.ts`](../shared/schema.ts) (`STYLE_PRESETS`, `APPAREL_DARK_TIER_PROMPTS`) and [`server/apparel-matting.ts`](../server/apparel-matting.ts) (`APPAREL_CHROMA_STYLE_BY_NAME`).

## What merchants can customize

- Style **display name** (except matching canonical names above — those are locked for prefix purposes).
- **Placeholder** text (`promptPlaceholder`).
- **Base reference images** (`baseImageUrl` / `baseImageUrls`).
- **Sort order**, active/inactive, sub-options (where applicable).

## What merchants cannot override (canonical names)

For styles whose name matches a canonical entry (case-insensitive), the server **replaces** `promptPrefix` with the repo version before generation. This prevents regressions like “white background” or “on a card” language that break matting.

Custom apparel styles (new names not in the table) still use the merchant prefix, but `sanitizeApparelStylePrefix()` strips conflicting background phrases and appends chroma suffix if missing.

## Adding a new apparel style

1. Add an entry to `STYLE_PRESETS` in `shared/schema.ts` with `category: "apparel"` and a full chroma-safe `promptPrefix`.
2. Add a dark-tier variant to `APPAREL_DARK_TIER_PROMPTS` if the style should allow light colors on dark garments.
3. Add the same prefix to `APPAREL_CHROMA_STYLE_BY_NAME` in `server/apparel-matting.ts` keyed by **lowercased style name**.
4. Optionally add a one-time `DATA_MIGRATIONS` row in `server/migrations/startup.ts` if merchants already have a style with that name in the DB.
5. Run Admin → Styles → **Reseed** (or wait for startup migration on deploy).

## Verification checklist

After changing styles or matting code:

1. Generate with **Illustrated Motif** or **Centered Graphic** on zip hoodie AOP.
2. Confirm the stored artwork URL is `.png` (not `.jpg`).
3. Open the PNG — areas outside the subject should be transparent, not white.
4. AOP preview on a dark garment color should show fabric through transparent regions (no white rectangle).
5. Railway logs should show `[Chroma Key]` passes; white-canvas images should log `skipping ML fallback`, not Replicate fallback.

## Related env flags

| Variable | Default | Effect |
|----------|---------|--------|
| `APPAREL_ML_BG_FALLBACK` | `true` | Replicate saliency fallback when pink chroma clearly failed (not on white canvas) |
| `APPAREL_VECTORIZE` | off | Post-matting Recraft/neplex trace; when on, **stores SVG** (no raster round-trip) |
| `APPAREL_VECTORIZE_PROVIDER` | `recraft` | `recraft` (Replicate recraft-ai/recraft-vectorize, neplex fallback) or `neplex` only |
| `REPLICATE_RECRAFT_VECTORIZE_VERSION` | pinned hash | Override Recraft model version on Replicate |
| `REPLICATE_VECTORIZE_POLL_TIMEOUT_MS` | `120000` | Max wait for Recraft vectorize prediction |
