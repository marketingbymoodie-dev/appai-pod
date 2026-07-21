# Framed poster known-good snapshots

Per-product **signed-off** pins for flat framed decor (VFP / HFP). Same idea as `docs/aop-known-good-snapshots/`: record the `production` commit where the product was verified so regressions have a revert target.

**Do not** treat these as “never change this code.” They are regression baselines.

## Index

| Product | Signed off | Pin commit | Doc |
|---------|------------|------------|-----|
| Vertical Framed Poster (VFP) | 2026-07-21 | `22c2238` | [vertical-framed-poster.md](./vertical-framed-poster.md) |

*Add HFP after merchant sign-off on the same placer + Lifestyle path.*

## Related

- Flat placer / bake: `client/.../FlatProductPlacer/`, `server/flat-calibration.ts`
- Storefront embed: `client/src/pages/embed-design.tsx`
- AOP snapshots (orthogonal): `docs/aop-known-good-snapshots/`
