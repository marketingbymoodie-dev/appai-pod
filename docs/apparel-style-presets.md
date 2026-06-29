# Apparel style presets & chroma prompts

Apparel generation uses a **hot pink (#FF00FF) chroma key** background. The server strips that color after generation. Any pink/magenta **inside the design** is also removed — so prompts must forbid it in the artwork.

## Where prompts live (editable without deploy)

| Field | Admin UI | Used when |
|-------|----------|-----------|
| **Prompt Prefix** | Admin → Styles → edit style | Light garments + default |
| **Dark garment prompt prefix** | Same dialog (apparel styles) | Dark garment colors (olive, black, navy, …) |

Both fields are stored in Postgres (`style_presets.prompt_prefix`, `style_presets.prompt_prefix_dark`). Changes take effect on the **next generation** after save — no Railway redeploy.

The server still runs `sanitizeApparelStylePrefix()` on every request (fixes “white background” wording, ensures `#FF00FF` chroma suffix).

Repo fallbacks in [`shared/apparel-chroma-prompts.ts`](../shared/apparel-chroma-prompts.ts) apply only when the DB field is empty or missing chroma-key language.

## Canonical style names

These names match seeded presets; DB copy is preferred when chroma-safe:

| Style name | Preset id |
|------------|-----------|
| Free 4 All | `free-4-all` |
| Pattern Maker | `pattern-maker` |
| Opinionated | `opinionated` |
| Quotes | `quotes` |
| Pet Portraits | `pet-portraits` |
| Centered Graphic | `centered-graphic` |
| Illustrated Motif | `illustrated-motif` |

## Pink-in-design rule (prompt language)

All apparel prefixes should include strong wording like:

> DO NOT use solid hot pink (#FF00FF) or magenta anywhere in the main design — #FF00FF is reserved exclusively for the background mat

White inside the subject (teeth, eyes) is OK; hot pink is not.

## What merchants can customize

- **Prompt Prefix** and **Dark garment prompt prefix** (apparel)
- Style display name (except locked canonical names for prefix resolution by name)
- Placeholder text, base reference images, sort order, sub-options

## Adding a new apparel style

1. Create in Admin → Styles with `category: apparel` and full chroma-safe prefixes (light + dark).
2. Optionally add fallbacks to `shared/apparel-chroma-prompts.ts` for new installs / reseed.

## Verification

1. Edit **Illustrated Motif** prompt in Admin; generate — prompt in logs should match your edit.
2. Generate on **dark** hoodie color — should use dark prefix field.
3. Artwork must not contain #FF00FF in the subject (tongue, gums, accents).
4. Stored apparel art with `APPAREL_VECTORIZE=true` should be `.svg`.

## Related env flags

| Variable | Default | Effect |
|----------|---------|--------|
| `APPAREL_ML_BG_FALLBACK` | `true` | Replicate saliency fallback when pink chroma clearly failed |
| `APPAREL_VECTORIZE` | off | Post-matting Recraft trace; stores SVG when on |
| `APPAREL_VECTORIZE_PROVIDER` | `recraft` | `recraft` or `neplex` |
