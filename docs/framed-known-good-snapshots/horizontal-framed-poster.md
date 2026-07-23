# Horizontal Framed Poster (HFP) — known-good snapshot

**Status: VERIFIED WORKING (2026-07-23, merchant sign-off).**

HFP is a **separate** product type from VFP (not “VFP flipped to landscape”). It shares the same flat placer + Lifestyle + bake path as VFP after `6cd5819` / `79a3707`. Use this doc if a later change regresses HFP specifically (landscape sizes, blank keys, wrap prompts).

## Pin commit (production)

| Field | Value |
|-------|--------|
| **Commit** | `23bfaab101f9fcfa3c2b02ca39e940c50f2a08ed` (`23bfaab`) |
| **Branch** | `production` (Railway deploy target) |
| **Date** | 2026-07-23 |
| **Message** | Warn tapestry users when art leaves raw weave uncovered. |

HFP↔VFP placer unify foundation: `79a3707` / `6cd5819`.

### Stack this snapshot sits on

| Commit | Summary |
|--------|---------|
| `23bfaab` | **This pin** — shared flat-decor lock with VFP + tapestry |
| `d0d56c8` | Catalog Views stay after generate |
| `a74f980` | Lifestyle reachable after carousel wrap |
| `6cd5819` | Align HFP with VFP flat placer path |
| `79a3707` | Unify HFP/VFP onto flat placer; full-canvas bake; landscape print dims |
| `22c2238` | Lifestyle under placer; Context gallery |

## What was verified working

- **FlatProductPlacer** — same UX as VFP (scale, fine position, Placement ready)
- **Landscape sizes** — print dims + blank resolution (dimension-swap when needed); no tumbler-style wrap letterboxing on generate
- **Local front mockup** — size + frame colour re-raster
- **Lifestyle Shot** — on-demand Context; gallery dots/arrows
- **Catalog gallery** — Primary / View 2… after generate
- **Test order bake** — full print canvas, matches placer
- **Product switch** — no art carryover HFP ↔ VFP

## Critical implementation (do not break casually)

| Area | Path / invariant |
|------|------------------|
| Placer gate | Same as VFP — `usesFlatOnTheFlyPreview` / `productLooksLikeFramedDecor` |
| Wrap prompts | `generationPromptHints` / image client — framed products must **not** get cylindrical wrap / empty-margin rules from wide AR |
| Landscape bake | `resolveFlatPrintFileDims`, `sizeIdLooksLandscape`, `swapDecorSizeDimensionId` |
| Lifestyle | `mergeContextOnly` (not tapestry `mergeProductMockups`) |
| Gallery | `isFlatPlacerGalleryReachable` includes catalog |

## Product row expectations

- Separate product type from VFP (name typically “Horizontal Framed Poster”)
- `designerType`: `framed-print`
- `onTheFlyTier`: `flat`
- `flatCalibration` with `decorPerSize: true`
- Landscape-dominant sizes; may reuse swapped portrait blank keys until re-harvested
- `hasPrintifyMockups`: true

## Verification checklist

- [ ] Generate on HFP landscape size → art fills frame (no side letterbox)
- [ ] Placer opens; scale/nudge; Placement ready → Lifestyle → Context
- [ ] Catalog Views persist after generate
- [ ] Test order matches scale + landscape size
- [ ] Switch to VFP clears prior art

## Revert

Surgical first. Do not reset `production` to a pre-`79a3707` pin without checking VFP + tapestry.

---

*Snapshot recorded: 2026-07-23.*
