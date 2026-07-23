# Vertical Framed Poster (VFP) — known-good snapshot

**Status: VERIFIED WORKING (2026-07-23 re-lock; originally signed off 2026-07-21).**

Generator Tester / storefront VFP uses the flat placer (scale + fine position), local front mockups, on-demand **Lifestyle Shot** (Printify Context), orientation pills beside Art Style when the catalog mixes orientations, catalog gallery Views after generate, and bake that fills the print canvas (no letterbox). Use this doc if a later change regresses VFP.

## Pin commit (production)

| Field | Value |
|-------|--------|
| **Commit** | `23bfaab101f9fcfa3c2b02ca39e940c50f2a08ed` (`23bfaab`) |
| **Branch** | `production` (Railway deploy target) |
| **Date** | 2026-07-23 |
| **Message** | Warn tapestry users when art leaves raw weave uncovered. |

Prior VFP-only UX pin (still in stack): `22c2238` — orientation beside Art Style; Lifestyle under Placement ready; Context gallery nav.

### Stack this snapshot sits on

| Commit | Summary |
|--------|---------|
| `23bfaab` | **This pin** — shared flat-decor lock with HFP + tapestry |
| `d0d56c8` | Catalog Primary / View 2–4 stay reachable after generate |
| `a74f980` | Lifestyle/Context reachable after carousel wrap |
| `6cd5819` | Align HFP with VFP flat placer; first VFP snapshot |
| `22c2238` | Orientation row; Lifestyle under placer; Context dots |
| `c200437` | On-demand Lifestyle Shot (no auto Mockup Preview spam) |
| `79a3707` | Unify HFP/VFP onto flat placer; full-canvas bake |

## What was verified working

- **FlatProductPlacer** — Edit Placement / auto-open after generate; Artwork Scale (default ~110%); Fine Position; “Placement ready”
- **Local front mockup** — size + frame colour re-raster without Printify for the front view
- **Lifestyle Shot** — under Placement ready; shimmer when active; dims when placement dirty; Context on canvas + dots/arrows
- **Catalog gallery** — Primary / View 2… remain after generate (not only Artwork + Context)
- **Orientation** — Vertical / Square (etc.) beside Art Style when mixed sizes
- **Test order bake** — matches placer scale/size (full print canvas, no fat letterbox)
- **No art carryover** — switching products clears session art (HFP ↔ VFP)

## Critical implementation (do not break casually)

| Area | Path / invariant |
|------|------------------|
| Placer gate | `embed-design.tsx` `usesFlatOnTheFlyPreview` — framed/decor with calibration **always** placer (`productLooksLikeFramedDecor`) |
| Decor mode | `flatDecorMode` — Lifestyle + mat guides; edge-gap coverage warning |
| Bake rect | `server/flat-calibration.ts` `resolveFlatBakePlacementRect` — full `{0,0,printW,printH}` |
| Landscape dims | `resolveFlatPrintFileDims` + `sizeIdLooksLandscape` / blank dimension-swap |
| Lifestyle | `requestLifestyleShot` + `mergeContextOnly`; `FlatProductPlacer` `lifestyleAction` |
| Gallery nav | `postGenGalleryNav.ts` `isFlatPlacerGalleryReachable` — catalog + Context, skip Front rasters |

## Product row expectations

- `designerType`: `framed-print`
- `onTheFlyTier`: `flat`
- `flatCalibration` with `decorPerSize: true` and `size:color` blanks
- `hasPrintifyMockups`: true (Lifestyle Context on demand)

HFP is a **separate** product type (not VFP orientation pills). Same code path.

## Verification checklist

- [ ] Generate on VFP → placer opens with scale/nudge
- [ ] Placement ready → Lifestyle Shot shimmers; click → Context + dots
- [ ] Catalog Primary / View 2… visible after generate
- [ ] Nudge/scale → Lifestyle dims until ready again
- [ ] Size/colour change → front updates locally
- [ ] Test order matches scale + size/colour

## Revert

Prefer surgical revert of the commits above over resetting all of `production`. Shared gallery/Lifestyle code also affects HFP and tapestry — check those docs before a wide revert.

---

*Snapshot recorded: 2026-07-21; re-locked: 2026-07-23.*
