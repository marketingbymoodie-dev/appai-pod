# Flat decor known-good snapshots

Per-product **signed-off** pins for flat decor (VFP / HFP / Woven Wall Tapestry). Same idea as `docs/aop-known-good-snapshots/`: record the `production` commit where the product was verified so regressions have a revert target.

**Do not** treat these as “never change this code.” They are regression baselines.

## Index

| Product | Blueprint | Signed off | Pin commit | Doc |
|---------|-----------|------------|------------|-----|
| Vertical Framed Poster (VFP) | (framed-print) | 2026-07-23 (re-lock) | `23bfaab` | [vertical-framed-poster.md](./vertical-framed-poster.md) |
| Horizontal Framed Poster (HFP) | (framed-print) | 2026-07-23 | `23bfaab` | [horizontal-framed-poster.md](./horizontal-framed-poster.md) |
| Woven Wall Tapestry | 1649 | 2026-07-23 | `23bfaab` | [woven-wall-tapestry-bp1649.md](./woven-wall-tapestry-bp1649.md) |

All three share pin `23bfaab` on `production` after tapestry blend + gallery + coverage-warning lock-down. Prefer **surgical** reverts if only one product regresses.

## Related

- Flat placer / bake: `client/.../FlatProductPlacer/`, `server/flat-calibration.ts`
- Storefront embed: `client/src/pages/embed-design.tsx`
- Fabric blend: `shared/fabricWeave.ts`, `flatRender.ts` `DEFAULT_FABRIC_BLEND_CONFIG`
- AOP snapshots (orthogonal): `docs/aop-known-good-snapshots/`
