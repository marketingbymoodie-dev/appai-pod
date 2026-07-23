# Woven Wall Tapestry (bp 1649) — known-good snapshot

**Status: VERIFIED WORKING (2026-07-23, merchant sign-off).**

Woven Wall Tapestry uses the flat placer with **fabric blank multiply** (baked blend defaults), on-demand **Printers Mockup** (Printify product photo, not Lifestyle Context), catalog gallery Views after generate, and a **coverage warning** when art leaves raw weave uncovered. Use this doc if a later change regresses tapestry preview or Printers Mockup.

## Pin commit (production)

| Field | Value |
|-------|--------|
| **Commit** | `23bfaab101f9fcfa3c2b02ca39e940c50f2a08ed` (`23bfaab`) |
| **Branch** | `production` (Railway deploy target) |
| **Date** | 2026-07-23 |
| **Message** | Warn tapestry users when art leaves raw weave uncovered. |

### Stack this snapshot sits on

| Commit | Summary |
|--------|---------|
| `23bfaab` | **This pin** — raw-weave coverage warning; scale past 100% to refill |
| `d0d56c8` | Catalog Primary / View 2–4 stay after generate |
| `f032fef` | Remove TEMP blend sliders; rename **Printers Mockup**; blank-key gallery fix |
| `4eedacf` | Bake merchant fabric-blend defaults (Printify-matched) |
| `52cb1fa` | Simple blank multiply + on-demand Printify product merge |
| `abc36d2` | Decor text gate (no invented text except Vintage Poster / user ask) — orthogonal but on same branch tip |

## What was verified working

- **FlatProductPlacer** — scale (up to 200%), fine position, Placement ready
- **Blank multiply blend** — art × coloured blank + grain/speckle/lineal/cream/darkening defaults (no procedural fake weave grid)
- **Printers Mockup** — button under Placement ready; fetches Printify woven photo; merges onto local fronts; **Artwork / Printers Mockup** dots; persists across re-raster (stable blank identity, not refresh nonce)
- **Catalog gallery** — Primary / View 2 / View 3 / View 4 after generate
- **Coverage warning** — when art does **not** fully cover print area: raw weave will show; scale up / reposition (opposite of apparel “trim” warning)
- **Orientation / size** — Horizontal / Vertical drives size + blank when mixed

## Baked fabric blend defaults

`DEFAULT_FABRIC_BLEND_CONFIG` in `client/.../FlatProductPlacer/lib/flatRender.ts` (storage key `appai:fabricBlendConfig:v2`):

| Knob | Value |
|------|-------|
| transparency | 0.17 |
| cream | 0.41 |
| darkening | 0.07 |
| vibrance | 0.2 |
| grain | 0.9 |
| speckle | 0.91 |
| linealX | 7 |
| linealY | 5 |
| linealAlpha | 0.2 |

## Critical implementation (do not break casually)

| Area | Path / invariant |
|------|------------------|
| Blueprint | `shared/fabricWeave.ts` — `WOVEN_WALL_TAPESTRY_BLUEPRINT_ID = 1649`; `resolveFabricWeaveTexture` |
| Shading | `flatRender.ts` `applySimpleBlankMultiply` via `getFabricBlendConfig()` — **no** procedural weave in preview path |
| Printers Mockup | `embed-design.tsx` — `mergeProductMockups: true` (label `printers`); **not** `mergeContextOnly` / Lifestyle |
| Blank identity | `flatMockupBlankIdentity` (color+size+weave) — must not include refresh nonce or Apply vs raster wipe Printers slides |
| Gallery | `isFlatPlacerGalleryReachable` — artwork + catalog + printers/context; skip Front rasters |
| Coverage | `fabricWeave` → `edge-gap` when `!flatCovers`; message about raw weave; `FLAT_SCALE_MAX_FABRIC = 2.0` |

## Product row expectations

- Printify blueprint **1649**
- `fabricWeaveTexture`: true (or null → blueprint default)
- `onTheFlyTier`: `flat` + `flatCalibration`
- `hasPrintifyMockups`: true (Printers Mockup on demand)
- Mixed orientation sizes OK (Horizontal / Vertical pills)

## Verification checklist

- [ ] Generate → placer; blank multiply looks closer to Printify than a light grid
- [ ] Placement ready → **Printers Mockup** → woven photo on canvas + dots
- [ ] Nudge/scale → Printers slide still in gallery (re-request if art changed)
- [ ] Catalog View 2–4 visible after generate
- [ ] Scale down / leave gap → raw-weave coverage warning
- [ ] Scale up to fill → warning clears

## Revert

- **Blend-only:** revert `4eedacf` / adjust `DEFAULT_FABRIC_BLEND_CONFIG`
- **Printers Mockup path:** `52cb1fa` + `f032fef` (blank-key fix)
- Prefer surgical over resetting `production` to a pin that drops VFP/HFP lifestyle work

---

*Snapshot recorded: 2026-07-23.*
