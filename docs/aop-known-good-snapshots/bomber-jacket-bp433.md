# Men's Bomber Jacket AOP (bp 433) — known-good snapshot

**Status: VERIFIED WORKING — Place on item + Pattern mode (2026-07-20, merchant sign-off).**  
Men's Bomber Jacket **Place on item** and **Pattern mode** match in-app preview and Printify mockups (continuous `front` export, place knobs + Pattern print tile scales locked).

## Pin commit (production)

| Field | Value |
|-------|--------|
| **Commit** | `088fd2391e874df97967e467e9f881be1b1c6c3e` (`088fd23`) |
| **Branch** | `production` (Railway deploy target) |
| **Date** | 2026-07-20 |
| **Message** | Bomber Pattern print: front and back +5%. |

Merchant sign-off:

- **Place on item** (2026-07-19) — front/back/sleeves size and placement locked at `becee3a`; Mirror + sleeve click-to-switch UX; app preview aligned with Printify.
- **Pattern mode** (2026-07-20) — app preview uniform; Printify front/back/sleeve density tuned via print-only tile scales at this pin.

### Stack this snapshot sits on

These commits are on `production` at this pin and should stay together when reverting bomber AOP:

| Commit | Summary |
|--------|---------|
| `088fd23` | **This pin** — Pattern print front/back +5% (`5.25` / `0.947625`); sleeves `0.64` |
| `1b9cc31` | Pattern print: back another −5%, sleeves another −20% |
| `0aa8935` | Pattern print scales: front ×5, back −5%, sleeves −20% + front bake harden |
| `0257a80` | Pattern: uniform tile scale, continuous tiled front, collar Y nudge |
| `ec781d2` | Docs: lock Place-on-item known-good (pre-Pattern) |
| `becee3a` | Place-on-item sleeve preview scale `1.7505` (−10%) |
| `93be669` | Sleeve back bridge like hood (full flat + preview scale) |
| `1eacd6f` | Front sleeves direct mesh warp (half-bake reverted) |
| `c80b58c` | Mirror-mode sleeve nudges move in unison |
| `332fc93` | Mirror only on Sleeves; click Front/Back/Sleeves parts |
| `6eadfdf` / `bb65b85` | Mirror toggle wired to live preview + print |
| `d2a92dc` / `be11006` | Front height −5%, back +4%, front +7% / ~1" lower |
| `611075f` / `2127df1` | Bake continuous Printify `front` (not zip L/R halves) |
| `20826cd` | Foundation: bomber place-on-item stretch / preview scales |

Zip / pullover / sweatshirt remain pinned separately — see index.  
Do **not** reset `production` to an older product pin if that would drop this bomber stack.

## What was verified working (bomber bp 433)

- **Place on item** — continuous `front` + `back` + sleeves; preview knobs so app matches Printify; Mirror (right sleeve flip + toward-chest nudges); Part click navigation.
- **Pattern mode** — uniform app preview; continuous tiled Printify `front`; print-only front/back/sleeve tile scales so Printify density matches app.
- **In-app preview ↔ Printify** — after hard refresh + re-apply (“Design saved”).

Product: Printify blueprint **433** (`BOMBER_JACKET_BLUEPRINT_ID`). Catalog placeholders are a single **`front`** (+ `back` + sleeves) — **not** zip `front_left` / `front_right`.

## Critical implementation (do not break casually)

### Continuous Printify `front`

**Files:** `client/.../aopPreview.ts` — `bakeBomberFrontPrintPanel` (Place on item), `bakeBomberFrontTiledPrintPanel` (Pattern), `finalizeBomberPrintPanelsForPrintify`

**Invariant:** Export one full-width `front` panel. Do **not** upload zip-style `front_left` / `front_right` halves (stretches art, bare shoulders, low DPI). Pattern front bake must use shared uniform mockup→flat scale (never placeholder `W/W = 1` — that made motifs microscopic).

### Place-on-item preview knobs (preview only unless noted)

**File:** `shared/hoodieTemplate.ts` — applied in `applyBomberFrontBodyPlacement` / `applyFrontBodyPreviewPlacementScale` / `applyBomberSleevePreviewPlacementScale` in `aopPreview.ts`.

| Constant | Value | Role |
|----------|-------|------|
| `BOMBER_FRONT_BODY_ASPECT_X_SCALE` | `1` | Preview + print (keep 1 — wrong X stretch was bad) |
| `BOMBER_FRONT_BODY_PLACEMENT_SCALE` | `1.42` | Preview + print front coverage |
| `BOMBER_FRONT_BODY_OFFSET_Y_FRAC` | `-0.18` | Preview + print (up toward collar); also Pattern front tile Y nudge |
| `BOMBER_FRONT_BODY_PREVIEW_PLACEMENT_SCALE` | `1.07` | Preview-only +7% |
| `BOMBER_FRONT_BODY_PREVIEW_OFFSET_Y_FRAC` | `0.045` | Preview-only ~1" lower |
| `BOMBER_FRONT_BODY_PREVIEW_HEIGHT_SCALE` | `0.95` | Preview-only height −5% |
| `BOMBER_BACK_PREVIEW_PLACEMENT_SCALE` | `1.144` | Preview-only back |
| `BOMBER_SLEEVES_PREVIEW_PLACEMENT_SCALE` | `1.7505` | Preview-only sleeves |

**Invariant:** Preview-only scales must not be applied to print export rects (except the shared front-body placement constants above).

### Pattern mode

**Files:** `shared/aopTileScale.ts` (`patternModeUniformTileScale`, `usesBomberUniformPatternTileScale`), `shared/hoodieTemplate.ts` (print tile scales), `client/.../aopPreview.ts` (preview + `renderFlatPrintPanels` + `bakeBomberFrontTiledPrintPanel`)

**Invariant (bomber only):** Pattern preview uses garment-wide **uniform** mockup→flat scale on chest/back/sleeves (median of body samples). Zip/pullover stay native per-panel; sweatshirt stays front-matched body-only — do not reintroduce those overrides onto bomber incorrectly, or bomber’s uniform override onto zip/pullover.

**Print-only tile motif scales** (preview stays on shared uniform; multiply print tile px):

| Constant | Value | Role |
|----------|-------|------|
| `BOMBER_PATTERN_FRONT_PRINT_TILE_SCALE` | `5.25` | Print front motifs vs uniform |
| `BOMBER_PATTERN_BACK_PRINT_TILE_SCALE` | `0.947625` | Print back (−5% × −5% × +5% from early tune) |
| `BOMBER_PATTERN_SLEEVES_PRINT_TILE_SCALE` | `0.64` | Print sleeves (−20% × −20%) |

Applied via `bomberPatternPrintTileScaleForPanel()` on back/sleeves in `renderTiledFlatPanel`, and on continuous front in `bakeBomberFrontTiledPrintPanel`.

### Sleeve front/back bridge (display)

**Like hood:** bake full flat via `renderHoodFlatPanel` from front layer + front placement, warp through back mesh with `sourceRect = full panel`. Mesh UVs select back-of-arm. Do **not** half-crop `sourceRect` for sleeves (that broke region + scale).

Front sleeves in the placer use **direct mesh warp** (not flat+half bake) so Scale/nudge stays WYSIWYG for print.

### Mirror + placer UX

**File:** `client/.../HoodieAopPlacer/index.tsx`

- `sleevesMirrored` (default on): XOR `sourceFlipX` on `right_sleeve` in preview + print; Mirror ON → same L/R offsets (toward chest); Mirror OFF → negated `offsetX`.
- Mirror button only when **Sleeves** part is active.
- Front/Back view buttons select Front body / Back body; canvas click switches Sleeves ↔ body.

## Related files (touch with care)

| Area | Path |
|------|------|
| Flat export / preview / bomber front bake | `client/src/components/hoodie-template-mapper/lib/aopPreview.ts` |
| Blueprint + place/Pattern constants | `shared/hoodieTemplate.ts` |
| Pattern tile scale math | `shared/aopTileScale.ts` |
| Placer Mirror / parts / click nav | `client/src/components/designer/HoodieAopPlacer/index.tsx` |
| Placeholder dims into placer | `client/src/pages/embed-design.tsx` |

## Revert to this snapshot

**Option A — whole tree (last resort):** only if this pin is still the global best for all signed-off products.

**Option B — revert commits:** reverse from HEAD down through the bomber Place-on-item + Pattern stack above until behavior returns (prefer surgical).

**Option C — restore files:** restore listed paths from `088fd23` for bomber-only regressions without touching zip/pullover/sweatshirt pins. For Place-on-item-only regressions that predate Pattern, `becee3a` remains a useful partial restore for place knobs — do not drop Pattern bake/scale files if Pattern must stay green.

## Verification checklist

### Place on item

- [ ] Front — continuous art across zipper; shoulders covered; no L/R stretch
- [ ] Back — size/placement matches Printify after hard refresh + re-apply
- [ ] Sleeves — Front scale/nudge WYSIWYG; Back bridge matches Front scale; Printify sleeve panels fill
- [ ] Mirror on/off — flip + toward-chest nudges; button only on Sleeves part
- [ ] View Front/Back engages body parts; click sleeve ↔ body works

### Pattern mode

- [ ] App preview — front/back/sleeve motif size uniform (e.g. 1.5″ Grid/Brick)
- [ ] Printify Front — density matches app (not microscopic); continuous `front` panel
- [ ] Printify Back — density matches app (print scale `0.947625`)
- [ ] Printify Sleeves — density matches app (print scale `0.64`)
- [ ] Hard refresh + re-apply after deploy before judging Printify thumbs

---

*Snapshot recorded: 2026-07-20. Place on item + Pattern mode signed off.*
