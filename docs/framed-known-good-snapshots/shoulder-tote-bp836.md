# Shoulder Tote Bag (AOP) (bp 836) — known-good snapshot

**Status: VERIFIED WORKING (2026-07-24, merchant sign-off).**

Shoulder Tote is **flat on-the-fly** (AOP title, FlatProductPlacer — not HoodieAopPlacer). Lifestyle Shot must return Printify **On Person** (not Context 1 flatlay), Print Side stays synced with PRINT ON BACK, and text generation keeps a **~15% top/bottom** safe band so landscape art cover-cropped onto the near-square bag does not clip words.

## Pin commit (production)

| Field | Value |
|-------|--------|
| **Commit** | `c09b062` |
| **Branch** | `production` (Railway deploy target) |
| **Date** | 2026-07-24 |
| **Message** | Sync Print on Both with BACK toggle; 15% top/bottom text safe zone. |

### Stack this snapshot sits on

| Commit | Summary |
|--------|---------|
| `c09b062` | **This pin** — Print Side ↔ PRINT ON BACK sync; 15% top/bottom text safe margins |
| `5e6cd55` | Lifestyle prefers **On Person**; Front/Back returns to live editor blank |
| `8046d07` | Do not AOP-trim Lifestyle to front/back only (keep on-person / context cameras) |
| `371a912` | Accept Printify `on-person` / Context 2 labels as lifestyle |
| `ef3fd82` | Prefer real lifestyle cameras; tote Lifestyle scale damp (`FLAT_LIFESTYLE_PRINTIFY_SCALE_FACTOR`) |

VFP / HFP / tapestry remain pinned at `23bfaab` — see sibling docs. Prefer **surgical** reverts if only the tote regresses.

## What was verified working

- **FlatProductPlacer** — Front/Back, scale, fine position, Placement ready
- **Lifestyle Shot** — opens **On Person** (bag on shoulder); Context 1 table flatlay is not the primary slide when On Person exists; optional Context 2 as secondary
- **Front / Back toggles** — leave Lifestyle/catalog override and show the live editor blank (Artwork)
- **Print Side** — “Print on Both Sides” turns **PRINT ON BACK** on (and toggles stay aligned with the dropdown)
- **Catalog gallery** — Artwork / Primary / View 2–4 after generate
- **Text composition** — new generates keep words ~15% inset from top/bottom (regenerate to pick up; old art unchanged)
- **Printify parity** — create-product returns `front`, `back`, `on-person`, `context-1`, `context-2` (probe confirmed)

## Critical implementation (do not break casually)

| Area | Path / invariant |
|------|------------------|
| Blueprint | Printify **836**, provider typically **72**, One size / White |
| Layout policy | `usesAopStorefrontCustomizer` → **false** when `onTheFlyTier: flat` (even if `isAllOverPrint`) |
| Lifestyle wait | `preferContextViews` must wait for context-like cameras even if AOP-flagged |
| Lifestyle select | `selectPreferredViews(..., preferContextViews)` — **not** `frontBackOnly`; rank On Person first; drop Context 1 when On Person exists |
| Labels | `shared/printifyMockupLabels.ts` — `isOnPersonMockupLabel`, `isContext1MockupLabel`, `lifestyleMockupPreferenceRank` |
| Client merge | `embed-design.tsx` — strict context filter; preserve `on-person` label (do not force-rename to `"context"`) |
| Editor return | `FlatProductPlacer` `onViewChange` → `setSelectedMockupIndex(0)` clears canvas override |
| Print Side sync | `initialState.enabled` derived from `printPlacement`; placer syncs parent `enabled`; toggle updates `printPlacement` |
| Text safe | `FLAT_PANEL_VERTICAL_TEXT_SAFE_PERCENT = 15` in `shared/generationPromptHints.ts`; AOP text line when user asked for words |
| Lifestyle scale | `FLAT_LIFESTYLE_PRINTIFY_SCALE_FACTOR = 0.9` so Context/On Person art size matches Artwork slide |

## Product row expectations

- Printify blueprint **836**
- `isAllOverPrint`: may be true (title) — still flat placer when calibrated
- `onTheFlyTier`: `flat` + `flatCalibration`
- `hasPrintifyMockups`: true (Lifestyle Shot on demand)
- Print placement selection enabled (front / back / both)

## Verification checklist

- [ ] Generate → flat placer; Artwork + catalog dots
- [ ] Print Side = Both → **PRINT ON BACK** is on
- [ ] Placement ready → **Lifestyle Shot** → **On Person** badge / slide (not Context 1 fabric/table close-up)
- [ ] Front or Back → preview returns to live editor blank
- [ ] Prompt with words → regenerate → text clear of top/bottom ~15% band on bag
- [ ] Optional: arrow to Context 2 hanging mockup if returned as second slide

## Revert

- **Lifestyle cameras only:** surgical revert `8046d07` / `5e6cd55` / label helpers in `printifyMockupLabels.ts` + `printify-mockups.ts`
- **Print Side sync:** `c09b062` placer/embed enabled sync
- **Text margins:** `generationPromptHints.ts` (`FLAT_PANEL_VERTICAL_TEXT_SAFE_PERCENT`)
- Prefer surgical over resetting `production` to this pin if that would drop later unrelated work

---

*Snapshot recorded: 2026-07-24.*
