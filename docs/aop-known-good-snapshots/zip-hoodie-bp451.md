# Zip hoodie AOP (bp 451) — known-good snapshot

**Status: VERIFIED WORKING (2026-07-17, merchant sign-off).**  
Zip hoodie **Place on item** and **Pattern** mode both match in-app preview and Printify mockups. Use this doc to restore this exact behavior if a later change regresses zip-hoodie AOP.

## Pin commit (production)

| Field | Value |
|-------|--------|
| **Commit** | `aabd9b694205b471229ee434ce3118e037a2ca15` (`aabd9b6`) |
| **Branch** | `production` (Railway deploy target) |
| **Date** | 2026-07-17 |
| **Message** | Fix pattern tile scale regression and pullover pocket Printify panel. |

Merchant sign-off (2026-07-17): **Pattern mode** at 1.5" tile is perfect across front, back, hood, sleeves, and pockets (app + Printify).

### Place-on-item foundation (still required)

Place-on-item edge-to-edge export was signed off earlier at `5f792b6` and remains an invariant of this stack. Do not reintroduce UV sub-rect flat baking (see “Known broken intermediate” below).

### Stack this snapshot sits on

These commits are included on `production` at this pin and should stay together when reverting:

| Commit | Summary |
|--------|---------|
| `aabd9b6` | **This pin** — Pattern mode sign-off; pullover pocket export path |
| `41110cf` | Pattern tile density / pocket merge iteration |
| `5f792b6` | Place-on-item flat export via mesh warp on uniform flat grid |
| `8932244` | Pullover pocket render, uniform pattern tiles (place-on-item export later fixed) |

## What was verified working (zip hoodie bp 451)

- **Place on item** — front (`front_left` / `front_right`), back, sleeves, hood: artwork fills each Printify placeholder edge-to-edge (no white “postage stamp” patches, no 2× zoom vs preview).
- **Pattern mode** — uniform tile scale across L/R front halves, hood halves, sleeves, back, and pockets (no panel-to-panel tile size mismatch at 1.5").
- **In-app preview ↔ Printify** — mockups align after hard refresh + re-apply (“Design saved”).

Product: Printify blueprint **451** (`ZIP_HOODIE_BLUEPRINT_ID`), split front placeholders (`front_left`, `front_right`), separate `pocket_left` / `pocket_right`.

## Critical implementation (do not break casually)

### Place-on-item print export

**File:** `client/src/components/hoodie-template-mapper/lib/aopPreview.ts`

1. **`renderHoodFlatPanel()`** — builds each flat Printify panel from the customer artwork.
2. **`synthesiseSeamAwareSourceRect()`** — same seam-aware slice the live preview uses for split fronts.
3. **`buildFlatMeshTargetPoints()`** — uniform `(cols × rows)` grid over the full flat canvas (`0…flatW`, `0…flatH`).
4. **`drawMeshWarp(..., { sourceRect: slice, targetPoints: flatGrid })`** — bakes the slice through the **same mesh topology** as the in-app preview, but onto a flat grid so the **entire** Printify placeholder is filled.

**Invariant:** UV `0…1` on the flat grid maps across the full `slice` (synthSrc). Do **not** map the slice into a fractional dest rect on the flat canvas (e.g. `destX = (slice.x/aw)*flatW`) — that was shipped briefly in `8932244` and caused large white gaps on Printify.

### Pattern mode

**Files:**

- `shared/aopTileScale.ts` — `patternModeUniformTileScale()` — median mockup→flat ratio of chest/back/sleeve panels
- `client/src/components/hoodie-template-mapper/lib/aopPreview.ts` — `patternTileScaleOverrideForLayer()` / `renderTiledFlatPanel()`

**Invariant:** Body/sleeve median is applied as `mockupToFlatScaleOverride` on **chest/back/sleeves only**. Hood and pocket panels use **per-panel** flat/mesh scale (`usesPerPanelPatternTileScale`). Pullover front meshes often lack `sourceRect` — export borrows the matching back-view `sourceRect` (or Printify pocket placeholder dims) so density matches zip. Do not force the body median onto hood/pocket.

### Preview vs export paths

| Layer | Place-on-item behavior |
|-------|------------------------|
| **In-app preview** | `drawMeshWarp` on mockup with `sourceRect: synthSrc` (direct mesh path) |
| **Printify export** | `renderHoodFlatPanel` → mesh warp on flat grid (must match preview scale/coverage) |
| **Back hood/sleeve bridge** | `renderHoodFlatPanel` from front layer, then `drawMeshWarp` on back mesh with `sourceRect: {0,0,W,H}` |

## Related files (touch with care)

| Area | Path |
|------|------|
| Flat panel export | `client/src/components/hoodie-template-mapper/lib/aopPreview.ts` |
| Mesh warp | `client/src/components/hoodie-template-mapper/lib/meshWarp.ts` |
| Tile scale math | `shared/aopTileScale.ts` |
| Panel keys / zip defaults | `shared/hoodieTemplate.ts` |
| Storefront apply + mockups | `client/src/pages/embed-design.tsx` |
| Unit test (flat grid) | `client/src/components/hoodie-template-mapper/lib/aopPreviewFlatPanel.test.ts` |

## Revert to this snapshot

### Option A — reset `production` to this commit (full rollback)

Use only if later production commits broke zip hoodie and you want the exact known-good tree.

```bash
git fetch origin
git checkout production
git reset --hard aabd9b6
git push --force-with-lease origin production
```

Railway redeploys on push. **Warning:** this drops any commits on `production` after `aabd9b6`.

### Option B — revert specific bad commits (surgical)

If only one later commit regressed zip hoodie:

```bash
git checkout production
git revert <bad-commit-sha>
git push origin production
```

Prefer this when other fixes on `production` after `aabd9b6` must be kept.

### Option C — restore pattern / place-on-item files from the pin

```bash
git checkout aabd9b6 -- client/src/components/hoodie-template-mapper/lib/aopPreview.ts
git checkout aabd9b6 -- shared/aopTileScale.ts
npm run build
# commit + merge to production as usual
```

For place-on-item-only regressions, also consider restoring flat-panel helpers from `5f792b6` if needed.

### After any revert

1. `npm run build` must pass.
2. Hard refresh embed; re-apply zip hoodie design.
3. Re-check **Place on item** and **Pattern** on Printify mockups (front L/R, back, sleeves, hood, pockets).

## Known broken intermediate (do not re-ship)

**Commit `8932244` place-on-item export only** (fixed by `5f792b6`):

- `renderHoodFlatPanel` drew each artwork slice into a **UV sub-rect** of the flat canvas (`destX/destW` from artwork fractions).
- **Symptom:** Printify showed pattern in small blocks with large white areas; in-app preview looked fine.
- **Fix:** mesh flat bake filling full placeholder (`5f792b6`).

**Pattern mode:** Do not force the body/sleeve median onto hood/pocket when their `sourceRect` is missing or much larger than the mesh (pullover front hoods) — that enlarges hood tiles on Printify. Keep per-panel scale for hood/pocket; borrow sibling-view `sourceRect` when needed.

## Verification checklist (zip hoodie 451)

- [ ] Place on item — front view, artwork scale nudged (e.g. 150–250%), L/R panels continuous at zipper
- [ ] Place on item — back + sleeves + hood scale consistent with preview
- [ ] Pattern mode @ 1.5" — tile density matches across front L/R, hood, sleeves, back, pockets
- [ ] Printify mockup gallery — no white gaps on any panel; pockets show art when Pockets ON
- [ ] Re-apply after hard refresh — “Design saved”, mockups refresh

---

*Snapshot recorded: 2026-07-17. Owner sign-off: zip hoodie Pattern mode perfect at production `aabd9b6` (place-on-item foundation `5f792b6`).*
