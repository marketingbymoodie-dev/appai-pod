# Men's Bomber Jacket AOP (bp 433) — known-good snapshot

**Status: VERIFIED WORKING — Place on item only (2026-07-19, merchant sign-off).**  
Men's Bomber Jacket **Place on item** matches in-app preview and Printify mockups (continuous `front` export, front/back/sleeve preview knobs locked). **Pattern mode is not signed off yet** — do not treat this pin as a Pattern baseline.

## Pin commit (production)

| Field | Value |
|-------|--------|
| **Commit** | `becee3a4a6c1ce36c9f16b45bfb8a85f7ba0fa2f` (`becee3a`) |
| **Branch** | `production` (Railway deploy target) |
| **Date** | 2026-07-19 |
| **Message** | Bomber sleeve preview scale -10% (1.945 → 1.7505). |

Merchant sign-off (2026-07-19):

- **Place on item** — front/back/sleeves size and placement good enough to lock; Mirror + sleeve click-to-switch UX; app preview aligned with Printify after iterative trim.
- **Pattern mode** — **not verified** (testing next).

### Stack this snapshot sits on

These commits are on `production` at this pin and should stay together when reverting Place-on-item:

| Commit | Summary |
|--------|---------|
| `becee3a` | **This pin** — sleeve preview scale `1.7505` (−10%) |
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
- **Pattern mode** — **not part of this sign-off.**
- **In-app preview ↔ Printify** — after hard refresh + re-apply (“Design saved”).

Product: Printify blueprint **433** (`BOMBER_JACKET_BLUEPRINT_ID`). Catalog placeholders are a single **`front`** (+ `back` + sleeves) — **not** zip `front_left` / `front_right`.

## Critical implementation (do not break casually)

### Continuous Printify `front`

**Files:** `client/.../aopPreview.ts` — `bakeBomberFrontPrintPanel`, `finalizeBomberPrintPanelsForPrintify`

**Invariant:** Export one full-width `front` panel from front-body placement. Do **not** upload zip-style `front_left` / `front_right` halves (stretches art, bare shoulders, low DPI).

### Place-on-item preview knobs (preview only unless noted)

**File:** `shared/hoodieTemplate.ts` — applied in `applyBomberFrontBodyPlacement` / `applyFrontBodyPreviewPlacementScale` / `applyBomberSleevePreviewPlacementScale` in `aopPreview.ts`.

| Constant | Value | Role |
|----------|-------|------|
| `BOMBER_FRONT_BODY_ASPECT_X_SCALE` | `1` | Preview + print (keep 1 — wrong X stretch was bad) |
| `BOMBER_FRONT_BODY_PLACEMENT_SCALE` | `1.42` | Preview + print front coverage |
| `BOMBER_FRONT_BODY_OFFSET_Y_FRAC` | `-0.18` | Preview + print (up toward collar) |
| `BOMBER_FRONT_BODY_PREVIEW_PLACEMENT_SCALE` | `1.07` | Preview-only +7% |
| `BOMBER_FRONT_BODY_PREVIEW_OFFSET_Y_FRAC` | `0.045` | Preview-only ~1" lower |
| `BOMBER_FRONT_BODY_PREVIEW_HEIGHT_SCALE` | `0.95` | Preview-only height −5% |
| `BOMBER_BACK_PREVIEW_PLACEMENT_SCALE` | `1.144` | Preview-only back |
| `BOMBER_SLEEVES_PREVIEW_PLACEMENT_SCALE` | `1.7505` | Preview-only sleeves |

**Invariant:** Preview-only scales must not be applied to print export rects (except the shared front-body placement constants above).

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
| Blueprint + preview constants | `shared/hoodieTemplate.ts` |
| Placer Mirror / parts / click nav | `client/src/components/designer/HoodieAopPlacer/index.tsx` |
| Placeholder dims into placer | `client/src/pages/embed-design.tsx` |

## Revert to this snapshot

**Option A — whole tree (last resort):** only if this pin is still the global best for all signed-off products.

**Option B — revert commits:** reverse from HEAD down through the bomber Place-on-item stack above until behavior returns (prefer surgical).

**Option C — restore files:** restore listed paths from `becee3a` for bomber-only regressions without touching zip/pullover/sweatshirt pins.

## Verification checklist (Place on item)

- [ ] Front — continuous art across zipper; shoulders covered; no L/R stretch
- [ ] Back — size/placement matches Printify after hard refresh + re-apply
- [ ] Sleeves — Front scale/nudge WYSIWYG; Back bridge matches Front scale; Printify sleeve panels fill
- [ ] Mirror on/off — flip + toward-chest nudges; button only on Sleeves part
- [ ] View Front/Back engages body parts; click sleeve ↔ body works
- [ ] Pattern mode — **out of scope for this pin**

---

*Snapshot recorded: 2026-07-19. Pattern mode TBD.*
