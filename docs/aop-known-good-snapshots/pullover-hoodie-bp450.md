# Pullover hoodie AOP (bp 450) — known-good snapshot

**Status: VERIFIED WORKING (2026-07-17, merchant sign-off).**  
Pullover hoodie **Pattern** mode and **Place on item** match in-app preview and Printify mockups (front pocket art present; hood halves filled; front chest print scale cleared for neck seam). Use this doc to restore this behavior if a later change regresses pullover AOP.

## Pin commit (production)

| Field | Value |
|-------|--------|
| **Commit** | `e6368383e4a7d81511c3a1277350564e295e6652` (`e636838`) |
| **Branch** | `production` (Railway deploy target) |
| **Date** | 2026-07-17 |
| **Message** | Shrink pullover front place-on-item print another 5%. |

Merchant sign-off (2026-07-17):

- **Pattern mode** @ 1.5" — correct all over in app; Printify shows pattern on body, sleeves, both hood halves, and kangaroo pocket (Pockets ON).
- **Place on item** — front/back/sleeves look good; main `front` print export scale locked after iterative trim so the top of the chest graphic is not lost at the neck/hood seam.

### Stack this snapshot sits on

These commits are on `production` at this pin and should stay together when reverting:

| Commit | Summary |
|--------|---------|
| `e636838` | **This pin** — front place-on-item print scale `0.8835` (second trim) |
| `ec3da7f` | Prefer calibrated back hoods for export; sibling hood fallback; first front print trim `0.93` |
| `707e6d5` | Native per-panel tile scale (fix front↔back density mismatch) |
| `5ab2cf7` | Map `front_pocket` → Printify `pocket`; pocket aliases + front fallback |
| `b8c563b` | Pocket alias expansion / early uniform-scale attempt (superseded for scale by `707e6d5`) |

Zip hoodie remains pinned separately at `aabd9b6` — see [zip-hoodie-bp451.md](./zip-hoodie-bp451.md). Do not reset `production` to the zip pin if that would drop this pullover stack.

## What was verified working (pullover hoodie bp 450)

- **Pattern mode** — uniform tile density front ↔ back @ 1.5"; hood, sleeves, body, and kangaroo pocket show art on Printify when Pockets ON.
- **Place on item** — continuous front body + pocket; sleeves; back; hood; print files fill Printify placeholders without blank true-left hood.
- **In-app preview ↔ Printify** — after hard refresh + re-apply (“Design saved”).

Product: Printify blueprint **450** (`PULOVER_HOODIE_BLUEPRINT_ID`), provider **10** (MWW On Demand). Live placeholders include `front`, `back`, `left_sleeve`, `right_sleeve`, **`pocket`** (not `front_pocket`), `left_hood`, `right_hood`, `waistband`, `left_cuff_panel`, `right_cuff_panel`.

Template: `unisex-pullover-hoodie-aop-L` (front meshes often lack `sourceRect`; back hoods/body have calibrated `sourceRect`).

## Critical implementation (do not break casually)

### Printify position names

| App panel key | Printify `position` |
|---------------|---------------------|
| `front_pocket` | **`pocket`** via `hoodiePanelKeyToPrintifyPosition()` |
| `left_hood` / `right_hood` | identity (`left_hood` = wearer’s true left — verified by color probe) |
| cuffs | `left_cuff_panel` / `right_cuff_panel` |

**Files:** `shared/hoodieTemplate.ts`, `shared/pulloverPocketPrintMerge.ts`, `server/printify-mockups.ts`

**Invariants:**

- Always upload/export kangaroo as Printify **`pocket`** (aliases still expand `front_pocket` ↔ `pocket`).
- Unmatched pocket → reuse **front** panel image, not solid white `bgColor`.
- Unmatched hood half → reuse **sibling** hood image, not solid white.
- `expandPanelImageIdsWithPocketAliases` + `expandHoodPanelImageIdsWithSiblingFallback` after panel upload.

### Pattern mode tile scale

**Files:** `shared/aopTileScale.ts`, `client/.../aopPreview.ts` (`renderTiledFlatPanel`, `collectPrintExportLayers`)

**Invariant:** Use each panel’s **native** flat/mesh tile scale (no garment-wide body median override). A shared override mixed front (no `sourceRect`, ratio ~1) with back (calibrated ~2) and made the back ~2× denser than the front at the same tile inches.

**Export layer pick:** `collectPrintExportLayers()` — prefer **back** hood layers when they have `sourceRect` (pullover front hoods are coarse / uncalibrated).

### Place-on-item front chest scale (print only)

**File:** `shared/hoodieTemplate.ts` — `PULOVER_FRONT_BODY_PRINT_ARTWORK_SCALE = 0.8835`  
**Applied in:** `renderFlatPrintPanels()` for `panelKey === "front"` only (not pocket, not preview).

| Constant | Value | Role |
|----------|-------|------|
| `PULOVER_FRONT_BODY_PREVIEW_PLACEMENT_SCALE` | `1.05` | Preview-only chest bump |
| `PULOVER_FRONT_BODY_PRINT_ARTWORK_SCALE` | `0.8835` | Print export shrink so hat clears neck/hood seam |

**Invariant:** Do not apply the print shrink to `front_pocket` or to zip hoodie panels. Preview scale stays independent so merchants can nudge in the UI without fighting a double shrink.

### Place-on-item flat bake (shared with zip)

Same as zip: `renderHoodFlatPanel` + `buildFlatMeshTargetPoints` — full-placeholder mesh bake. Do **not** reintroduce UV sub-rect flat baking (`8932244` failure mode).

### Design groups

`front_pocket` must live in **`front-body`**, not the always-disabled `trim` group (`migrateFrontPocketOutOfTrimGroup` / `normalizeHoodieTemplate`).

## Related files (touch with care)

| Area | Path |
|------|------|
| Flat panel export / tile / layer pick | `client/src/components/hoodie-template-mapper/lib/aopPreview.ts` |
| Print scales + panel→Printify names | `shared/hoodieTemplate.ts` |
| Tile scale math | `shared/aopTileScale.ts` |
| Pocket/hood Printify matching | `shared/pulloverPocketPrintMerge.ts` |
| Mockup create / solid-fill fallbacks | `server/printify-mockups.ts` |
| Customer placer toggles | `client/src/components/designer/HoodieAopPlacer/index.tsx` |
| Storefront apply + mockups | `client/src/pages/embed-design.tsx` |

## Revert to this snapshot

### Option A — reset `production` to this commit (full rollback)

```bash
git fetch origin
git checkout production
git reset --hard e636838
git push --force-with-lease origin production
```

**Warning:** drops any commits on `production` after `e636838`. Prefer Option B/C if zip or other products gained fixes after this pin.

### Option B — revert specific bad commits (surgical)

```bash
git checkout production
git revert <bad-commit-sha>
git push origin production
```

### Option C — restore pullover-critical files from the pin

```bash
git checkout e636838 -- \
  client/src/components/hoodie-template-mapper/lib/aopPreview.ts \
  shared/hoodieTemplate.ts \
  shared/aopTileScale.ts \
  shared/pulloverPocketPrintMerge.ts \
  server/printify-mockups.ts
npm run build
# commit + merge to production as usual
```

### After any revert

1. `npm run build` must pass.
2. Hard refresh embed; re-apply pullover design.
3. Re-check Pattern @ 1.5" and Place on item on Printify (front + pocket, both hood halves, back, sleeves).

## Known broken intermediates (do not re-ship)

| Failure | Cause | Fix pin |
|---------|--------|---------|
| Blank white kangaroo on Printify | Unmatched `pocket` filled with solid `bgColor`; client sent `front_pocket` | `5ab2cf7` + aliases/fallback |
| Front pattern denser/coarser than back | Garment-wide `mockupToFlatScaleOverride` from mixed front/back samples | `707e6d5` |
| Blank true-left hood on Printify | Weak/missing `left_hood` upload; front hood meshes preferred | `ec3da7f` |
| Chest graphic clipped at neck seam | Front place-on-item print too large vs pocket / seam | `e636838` (`0.8835`) |
| Place-on-item white postage stamps | UV sub-rect flat bake | Never re-ship; use `5f792b6` mesh flat bake |

## Verification checklist (pullover hoodie 450)

- [ ] Pattern @ 1.5" — front/back tile density match; sleeves + both hood halves show art
- [ ] Pattern + Pockets ON — Printify kangaroo shows pattern (not white overlay)
- [ ] Place on item — front graphic clears neck/hood seam (hat/feather not clipped)
- [ ] Place on item — pocket aligns with front body; sleeves + back OK
- [ ] Printify gallery — no blank true-left hood; trim (cuffs/waistband) solid garment colour
- [ ] Re-apply after hard refresh — “Design saved”, mockups refresh

---

*Snapshot recorded: 2026-07-17. Owner sign-off: pullover Pattern + Place on item good at production `e636838`.*
