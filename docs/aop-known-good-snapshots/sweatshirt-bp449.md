# Unisex Sweatshirt AOP (bp 449) — known-good snapshot

**Status: VERIFIED WORKING (2026-07-18, merchant sign-off).**  
Unisex Sweatshirt **Place on item** and **Pattern** mode match in-app preview and Printify mockups (collar filled with garment bg; front/back Pattern density matched; place-on-item preview scale locked). Use this doc to restore this behavior if a later change regresses sweatshirt AOP.

## Pin commit (production)

| Field | Value |
|-------|--------|
| **Commit** | `0c010e55c446c5d9e0642e512c7425a96122adb7` (`0c010e5`) |
| **Branch** | `production` (Railway deploy target) |
| **Date** | 2026-07-18 |
| **Message** | Match sweatshirt Pattern back tile scale to front. |

Merchant sign-off (2026-07-18):

- **Place on item** — front/back/sleeves look correct; collar takes garment background colour on Printify; app preview scale matched to Printify after iterative trim.
- **Pattern mode** — front ↔ back tile density matched in app and on Printify (back was printing a little small before the front-matched body scale).

### Stack this snapshot sits on

These commits are on `production` at this pin and should stay together when reverting:

| Commit | Summary |
|--------|---------|
| `0c010e5` | **This pin** — Pattern front/back body tile scale locked to front |
| `8ee27b4` | Clip enlarged artwork bbox so nudge controls stay clickable |
| `5ae621e` | Place-on-item front/back preview scale `0.9765` (−7% after prior +5%) |
| `d31f6f7` | Printify placeholder is title-case **`Collar`** (not `collar`) |
| `5552857` | Upsize solid trim panels; prefer server bgColor solid for collar |
| `a630166` | Force solid collar export; first preview scale bump |

Zip hoodie remains pinned at `aabd9b6` — see [zip-hoodie-bp451.md](./zip-hoodie-bp451.md).  
Pullover hoodie remains pinned at `e636838` — see [pullover-hoodie-bp450.md](./pullover-hoodie-bp450.md).  
Do **not** reset `production` to an older product pin if that would drop this sweatshirt stack.

## What was verified working (unisex sweatshirt bp 449)

- **Place on item** — front/back/sleeves; garment bg on collar, cuffs, waistband; preview size aligned with Printify after hard refresh + re-apply.
- **Pattern mode** — front ↔ back body tile density match; sleeves + trim solid garment colour.
- **In-app preview ↔ Printify** — after hard refresh + re-apply (“Design saved”).

Product: Printify blueprint **449** (`SWEATSHIRT_BLUEPRINT_ID`), provider **10** (MWW On Demand). Live placeholders include `front`, `back`, `left_sleeve`, `right_sleeve`, `left_cuff_panel`, `right_cuff_panel`, **`Collar`** (title-case), `waistband`.

Template: `unisex-sweatshirt-aop-L` (`panel_mapping_template` on product type id 31). Garment layout: `jumper-no-hood` (no hood / pockets UI).

## Critical implementation (do not break casually)

### Printify position names

| App panel key | Printify `position` |
|---------------|---------------------|
| `collar_front` / `collar_back` | **`Collar`** (title-case) via `hoodiePanelKeyToPrintifyPosition()` |
| cuffs | `left_cuff_panel` / `right_cuff_panel` |
| body / sleeves | identity (`front`, `back`, `left_sleeve`, `right_sleeve`) |

**Files:** `shared/hoodieTemplate.ts`, `shared/pulloverPocketPrintMerge.ts` (`expandPanelImageIdsWithCollarAliases`, case-insensitive `resolvePrintifyPanelImageId`), `server/printify-mockups.ts`, `server/flat-order-fulfillment.ts` (case-insensitive allowed-position match)

**Invariants:**

- Always export/upload collar as Printify **`Collar`**. Lowercase `collar` is skipped by the live catalog and leaves `images: []` (white neck rib).
- Customer placer never prints artwork on trim — collar / cuffs / waistband are solid garment `backgroundColor` (`TRIM_PANEL_KEYS` + `finalizeSweatshirtPrintPanelsForPrintify`).
- Solid trim canvases must keep a usable short edge (wide collar strip ≈ 3769×338); sub-~64px heights are ignored by Printify.
- Mockup path: prefer server 1024² `bgColor` solid for `/collar/i` placeholders when available; always merge uploaded panel keys into `aopPositions`.
- Order path: map saved panel positions onto canonical Printify spelling (e.g. `collar` → `Collar`).

### Pattern mode tile scale

**Files:** `shared/aopTileScale.ts` (`patternModeFrontBodyTileScale`, `usesFrontMatchedBodyPatternTileScale`), `client/.../aopPreview.ts` (`collectPatternTileScaleSamples`, preview + `renderFlatPrintPanels`)

**Invariant (sweatshirt only):** Lock **`front` + `back`** body Pattern density to the **front** body’s flat/mesh ratio for both preview and print. Native per-panel scale left the back a little small vs front.

**Do not** reintroduce a garment-wide body/sleeve median override for pullover/zip — that regresses those products (see pullover pin `707e6d5`). Hood/pocket panels stay on native per-panel scale everywhere.

### Place-on-item preview scale (preview only)

**File:** `shared/hoodieTemplate.ts` — `SWEATSHIRT_BODY_PREVIEW_PLACEMENT_SCALE = 0.9765`  
**Applied in:** `applyFrontBodyPreviewPlacementScale()` for `front-body` **and** `back-body` when `isSweatshirtBlueprint`.

| Constant | Value | Role |
|----------|-------|------|
| `SWEATSHIRT_BODY_PREVIEW_PLACEMENT_SCALE` | `0.9765` | Preview-only (1.05 × 0.93) so app matches Printify |
| Print export scale | `1.0` | Unchanged — do not shrink/grow sweatshirt print files for place-on-item |

**Invariant:** Preview scale is independent of print export. Do not apply pullover’s `PULOVER_FRONT_BODY_PRINT_ARTWORK_SCALE` to sweatshirt.

### Design groups / trim

`defaultSweatshirtDesignGroups()` / `migrateSweatshirtDesignGroups()` — collar lives in **`trim`** with cuffs + waistband (always force-disabled for artwork in the customer placer). No separate `collar` group on bp 449.

### Placer UX

Enlarged artwork bounding boxes must not cover nudge controls (`overflow-hidden` on design-rect overlay + canvas wrapper; nudge `z-10`) — `8ee27b4`.

## Related files (touch with care)

| Area | Path |
|------|------|
| Flat panel export / tile / collar finalize | `client/src/components/hoodie-template-mapper/lib/aopPreview.ts` |
| Blueprint constants + Collar mapping + preview scale | `shared/hoodieTemplate.ts` |
| Tile scale math (front-matched body) | `shared/aopTileScale.ts` |
| Collar aliases / case-insensitive resolve | `shared/pulloverPocketPrintMerge.ts` |
| Mockup create / solid-fill / Collar prefer | `server/printify-mockups.ts` |
| Order print_areas position canonicalization | `server/flat-order-fulfillment.ts` |
| Customer placer trim mute + nudge | `client/src/components/designer/HoodieAopPlacer/index.tsx` |
| Storefront apply + mockups | `client/src/pages/embed-design.tsx` |

## Revert to this snapshot

### Option A — reset `production` to this commit (full rollback)

```bash
git fetch origin
git checkout production
git reset --hard 0c010e5
git push --force-with-lease origin production
```

**Warning:** drops any commits on `production` after `0c010e5`. Prefer Option B/C if other products gained fixes after this pin.

### Option B — revert specific bad commits (surgical)

```bash
git checkout production
git revert <bad-commit-sha>
git push origin production
```

### Option C — restore sweatshirt-critical files from the pin

```bash
git checkout 0c010e5 -- \
  client/src/components/hoodie-template-mapper/lib/aopPreview.ts \
  shared/hoodieTemplate.ts \
  shared/aopTileScale.ts \
  shared/pulloverPocketPrintMerge.ts \
  server/printify-mockups.ts \
  server/flat-order-fulfillment.ts \
  client/src/components/designer/HoodieAopPlacer/index.tsx \
  client/src/components/hoodie-template-mapper/DesignRectHandlesOverlay.tsx
npm run build
# commit + merge to production as usual
```

### After any revert

1. `npm run build` must pass.
2. Hard refresh embed; re-apply sweatshirt design.
3. Re-check Place on item (collar colour + front/back size) and Pattern front ↔ back density on Printify.

## Known broken intermediates (do not re-ship)

| Failure | Cause | Fix pin |
|---------|--------|---------|
| White collar on Printify (mockup + orders) | Client sent lowercase `collar`; live placeholder is **`Collar`** → empty `images` | `d31f6f7` |
| Collar solid ignored / still white | ~160×14 solid strip too thin for Printify | `5552857` |
| Missing collar panel entirely | No forced solid export when template lacks collar mesh | `a630166` + finalize |
| Pattern back denser/smaller than front | Native per-panel flat/mesh ratios diverge on bp 449 | `0c010e5` |
| Place-on-item app vs Printify size mismatch | Preview-only body scale needs product-specific trim | `5ae621e` (`0.9765`) |
| Nudge arrows unclickable | Enlarged design-rect hit area covered controls | `8ee27b4` |

## Verification checklist (unisex sweatshirt 449)

- [ ] Place on item — front/back preview size matches Printify (not oversized/undersized)
- [ ] Place on item — Printify **Collar** tab shows solid garment bg (not empty / white zigzag)
- [ ] Place on item — cuffs + waistband solid garment colour
- [ ] Pattern @ chosen tile size — front ↔ back body density match in app and Printify
- [ ] Pattern — sleeves OK; trim solid garment colour
- [ ] Enlarged artwork — nudge arrows still clickable
- [ ] Re-apply after hard refresh — “Design saved”, mockups refresh

---

*Snapshot recorded: 2026-07-18. Owner sign-off: sweatshirt Place on item + Pattern good at production `0c010e5`.*
