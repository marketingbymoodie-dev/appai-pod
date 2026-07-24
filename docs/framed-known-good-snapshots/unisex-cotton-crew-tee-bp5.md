# Unisex Cotton Crew Tee (bp 5) — known-good snapshot

**Status: VERIFIED WORKING (2026-07-24, merchant sign-off).**

Standard DTG crew tee on **FlatProductPlacer** (flat on-the-fly, not AOP mesh). Generation uses the dashed-guide aspect ratio; chroma motifs trim to opaque bounds (wide subjects look landscape in the art box — expected). Default artwork scale is **85%**; Print Side stays synced with PRINT ON BACK; Printify print output matches placement even when soft motif edges sit near/over the dashed guide visually.

## Pin commit (production)

| Field | Value |
|-------|--------|
| **Commit** | `eafd244` |
| **Branch** | `production` (Railway deploy target) |
| **Date** | 2026-07-24 |
| **Message** | Default flat apparel scale to 85%; center gallery dots; add preview zoom. |

### Stack this snapshot sits on

| Commit | Summary |
|--------|---------|
| `eafd244` | **This pin** — 85% default apparel scale; gallery dots under canvas; preview Zoom slider |
| `8d237c6` | Honor Print Side when seeding flat placer (Both → PRINT ON BACK stays on) |
| `c39f765` | Generate flat-calibrated tee art from dashed-guide aspect ratio |

Shoulder Tote remains pinned at `c09b062` — see [shoulder-tote-bp836.md](./shoulder-tote-bp836.md). Prefer **surgical** reverts if only the tee regresses.

## What was verified working

- **FlatProductPlacer** — Front/Back, artwork scale, fine position, Placement ready
- **Default scale** — new generate/upload seeds at **~85%** (not 135%); slider max remains 100% for apparel
- **Print Side** — “Print on Both Sides” turns **PRINT ON BACK** on after generate
- **Aspect / art box** — Replicate generates portrait (e.g. 4:5 from 3:4 guide); after chroma + `trimTransparentBounds`, wide motifs become landscape PNGs and the solid art box matches — dashed print guide stays portrait
- **Dashed-guide overlap** — soft motif edges that appear to kiss/overhang the dashed box in the editor did **not** get trimmed on the Printify output (verified)
- **Preview Zoom** — view-only Zoom slider inside the editor canvas (does not change print scale)
- **Catalog gallery** — Artwork / Primary / View 2 after generate

## Critical implementation (do not break casually)

| Area | Path / invariant |
|------|------------------|
| Blueprint | Printify **5** (Unisex Cotton Crew Tee), `onTheFlyTier: flat` + `flatCalibration` |
| Gen AR | `aspectRatioFromFlatCalibration` / `resolveGenerationAspectRatio` — dashed guide / print bounds, not sleeve slots |
| Apparel seed scale | `FLAT_APPAREL_DEFAULT_SCALE = 0.85` via `flatDefaultPlacementScale` (not Printify mockup 135%) |
| Print Side sync | Generate/upload seed `enabled` from `printPlacement`; mockup bake prefers dropdown over stale `enabled.back: false` |
| Chroma trim | `trimTransparentBounds` in `server/apparel-matting.ts` — opaque crop after matting (landscape box for wide motifs is expected) |
| Placement bake | Flat placer Apply → Printify positions use placement + mask; visual soft overhang ≠ hard trim |
| Preview Zoom | `FlatProductPlacer` local `previewZoom` CSS scale — UI only |

## Product row expectations

- Printify blueprint **5**
- `designerType`: `apparel`, `isAllOverPrint`: false
- `onTheFlyTier`: `flat` + `flatCalibration` (front/back views)
- `aspectRatio` / size ARs: portrait (e.g. `3:4`)
- `hasPrintifyMockups`: true; `doubleSidedPrint` enables Print Side dropdown

## Verification checklist

- [ ] Generate Illustrated Motif → flat placer; art starts ~**85%**
- [ ] Print Side = Both → **PRINT ON BACK** on after generate
- [ ] Wide motif → landscape solid art box inside portrait dashed guide (OK)
- [ ] Placement ready → test order / Printify mockup — no unexpected edge trim vs editor
- [ ] Preview Zoom changes view only; Artwork Scale still drives print size
- [ ] Artwork / Primary / View 2 dots under the preview canvas

## Revert

- **Scale / zoom / dots:** `eafd244` (`flatDefaultPlacementScale`, placer Zoom, `lg:pr-80` dots)
- **Print Side seed:** `8d237c6`
- **Gen AR from flat calibration:** `c39f765`
- Prefer surgical over resetting `production` to this pin if that would drop later unrelated work

---

*Snapshot recorded: 2026-07-24.*
