# Vertical Framed Poster (VFP) — known-good snapshot

**Status: VERIFIED WORKING (2026-07-21, merchant sign-off).**

Generator Tester / storefront VFP uses the flat placer (scale + fine position), local front mockups, on-demand **Lifestyle Shot** (Printify Context), orientation pills beside Art Style when the catalog mixes orientations, and bake that fills the print canvas (no letterbox). Use this doc if a later change regresses VFP.

## Pin commit (production)

| Field | Value |
|-------|--------|
| **Commit** | `22c223856f7d103e5ad7d3dee0c4a729d9029d08` (`22c2238`) |
| **Branch** | `production` (Railway deploy target) |
| **Date** | 2026-07-21 |
| **Message** | Improve framed customizer UX: orientation row, Lifestyle under placer, Context gallery nav. |

### Stack this snapshot sits on

| Commit | Summary |
|--------|---------|
| `22c2238` | **This pin** — orientation beside Art Style; Lifestyle under Placement ready + shimmer; Context dots/arrows |
| `c200437` | On-demand Lifestyle Shot (stop auto Mockup Preview spam) |
| `79a3707` | Unify HFP/VFP onto flat placer; full-canvas bake; landscape print dims |
| `069d0c9` | Tester save loop, zoom refresh gate, mockup top clipping |

## What was verified working

- **FlatProductPlacer** — Edit Placement / auto-open after generate; Artwork Scale (default ~110%); Fine Position; “Placement ready”
- **Local front mockup** — size + frame colour re-raster without Printify for the front view
- **Lifestyle Shot** — under Placement ready; shimmer when active; dims when placement dirty; one Printify temp product only on click; gallery shows **Context** with dots/arrows
- **Orientation** — Vertical / Square (etc.) beside Art Style; Size beside Color
- **Test order bake** — matches placer scale/size (full print canvas, no fat white/black letterbox)
- **No art carryover** — switching products clears session art (HFP ↔ VFP)

## Critical implementation (do not break casually)

| Area | Path / invariant |
|------|------------------|
| Placer gate | `embed-design.tsx` `usesFlatOnTheFlyPreview` — framed/decor with calibration **always** placer, even if `storefrontMockupMode === "printify"` (`productLooksLikeFramedDecor`) |
| Decor mode | `flatDecorMode` — same framed gate; Lifestyle + mat guides |
| Bake rect | `server/flat-calibration.ts` `resolveFlatBakePlacementRect` — full `{0,0,printW,printH}` |
| Landscape dims | `resolveFlatPrintFileDims` + `sizeIdLooksLandscape` / blank dimension-swap (`swapDecorSizeDimensionId`) |
| Lifestyle | `requestLifestyleShot` + `FlatProductPlacer` `lifestyleAction`; no auto `mergeContextOnly` |
| Tester save | Memoized `embeddedContext` in `create-product.tsx`; Apply mutex / dirty gate |

## Product row expectations

- `designerType`: `framed-print` (auto-healed from “Framed/Poster” names if `generic`)
- `onTheFlyTier`: `flat`
- `flatCalibration` with `decorPerSize: true` and `size:color` blanks
- `hasPrintifyMockups`: true (for Lifestyle Context only)

HFP is a **separate** product type (not VFP orientation pills). Same code path once HFP has calibration; landscape sizes may reuse swapped portrait blank keys until HFP is re-harvested.

## Verification checklist

- [ ] Generate on VFP → placer opens with scale/nudge
- [ ] Placement ready → Lifestyle Shot shimmers; click → Context on canvas + dots
- [ ] Nudge/scale → Lifestyle dims until ready again
- [ ] Size/colour change → front updates locally; Lifestyle cleared until re-request
- [ ] Test order matches scale + size/colour
- [ ] No flood of unpublished “Mockup Preview” products on every nudge

## Revert

Prefer surgical revert of the commits above over resetting all of `production`. Lifestyle + placer UX live mainly in `embed-design.tsx` and `FlatProductPlacer/index.tsx`; bake in `server/flat-calibration.ts`.

---

*Snapshot recorded: 2026-07-21.*
