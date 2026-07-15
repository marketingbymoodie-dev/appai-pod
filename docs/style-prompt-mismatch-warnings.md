# Style / prompt mismatch warnings

When a customer (or merchant in **Art Generator Tester**) clicks **Generate Artwork**, the embed may show a dialog if their **typed description** clearly conflicts with the **selected style’s prompt prefix**.

Example: *“rainbow pattern”* + **Minimalist Icon** → warns that the style is for a single icon, not a repeating pattern, and offers **Pattern Maker** if that style is available on the page.

## Where it runs

| Layer | File |
|-------|------|
| Detection rules | [`shared/stylePromptCompatibility.ts`](../shared/stylePromptCompatibility.ts) |
| Unit tests | [`shared/stylePromptCompatibility.test.ts`](../shared/stylePromptCompatibility.test.ts) |
| Dialog UI | [`client/src/pages/embed-design.tsx`](../client/src/pages/embed-design.tsx) (`handleGenerate`) |

Requires **styles visible on the page** (`showPresets !== false`) and a non-empty customer prompt.

---

## Merchant scoping (important)

**Alternatives are never suggested unless the merchant already exposes that style on the current page/product.**

Flow:

1. `detectStylePromptMismatch()` returns **canonical suggestion names** (e.g. `"Pattern Maker"`, `"Free 4 All"`).
2. `resolveSuggestedStylePresets()` maps those names to presets in **`filteredStylePresets`** only.
3. `filteredStylePresets` is built from:
   - the merchant’s **active** styles in Postgres, then
   - **Customizer page style config** (`styleConfig.mode: "selected"` + `presetIds`), and/or
   - product **designer type** category filter (decor / apparel / graphics).

So if a merchant does not use **Pattern Maker** on that customizer page (or deactivated it), the dialog still explains the conflict but **only shows “Generate anyway”** — no “Use Pattern Maker” button.

This is intentional: we must not advertise styles the store doesn’t offer on that surface.

### Making a style suggestable for a merchant

1. **Admin → Styles** — style exists and is **active**.
2. **Customizer page** (or Generator Tester product context) — include that style in the page’s style list:
   - **All styles in category**, or
   - **Selected styles** with the preset checked.
3. Suggestion **display name** should match a [canonical name or alias](#canonical-suggestion-names) below (exact or close).

---

## Current conflict rules

Rules are evaluated against the customer’s raw prompt plus the style’s **prompt prefix** (`promptSuffix` in the client API — same text as Admin → Styles → **Prompt Prefix**) and **style name**.

| Customer prompt signal | Style signal | User-facing reason | Suggested styles (canonical) |
|------------------------|--------------|--------------------|------------------------------|
| Pattern / repeating / seamless / tile / all-over | Single-motif style (minimal icon, centered graphic, illustrated motif) | Asks for a **repeating pattern**; style is for **one centered icon/motif** | **Pattern Maker** |
| Black & white / monochrome / grayscale | Prefix requires **vibrant** colors or **avoid white** | B&W request vs vibrant-only style | **Free 4 All**, **Pattern Maker** |
| 4+ words, not a pattern request | **Minimalist Icon** prefix/name | Detailed subject may become a **generic icon** | **Illustrated Motif**, **Centered Graphic**, **Free 4 All** |

**Short prompts:** pattern and B&W conflicts fire on any substantive prompt (≥ 3 characters). The “generic minimalist icon” warning only fires on **4+ words**.

### Style prefix / name signals (detection helpers)

| Helper | Matches |
|--------|---------|
| `stylePrefixIsMinimalIcon` | Name or prefix contains `minimalist icon`, or prefix ends with `Create a minimal icon of` |
| `stylePrefixIsSingleMotif` | Minimal icon, **or** centered graphic / illustrated motif language |
| `stylePrefixRequiresVibrantColor` | `vibrant`, `avoid white`, `flat solid vibrant`, etc. |

Customer-side helpers live in [`shared/generationPromptHints.ts`](../shared/generationPromptHints.ts) (e.g. `userPromptRequestsMonochrome`).

---

## Canonical suggestion names

Suggestions use **logical names**, not database IDs. Resolution uses [`CANONICAL_STYLE_ALIASES`](../shared/stylePromptCompatibility.ts) plus exact name match (case-insensitive).

| Canonical key | Aliases matched against merchant preset **name** |
|---------------|--------------------------------------------------|
| `Free 4 All` | free 4 all, free for all, custom prompt, no style |
| `Pattern Maker` | pattern maker, pattern |
| `Illustrated Motif` | illustrated motif, illustrated |
| `Centered Graphic` | centered graphic, centered |
| `Opinionated` | opinionated, text stack, typography |
| `Quotes` | quotes, quote |
| `Pet Portraits` | pet portraits, pet portrait, pet |

If a merchant renames **Pattern Maker** to something unrelated (e.g. “Seamless Tiles”), add an alias or use a name that still matches `pattern` / `pattern maker`.

---

## Adding detection for a new style

When you introduce a merchant-facing style whose **prompt prefix** imposes fixed rules (color, composition, subject type), decide:

1. **What customer phrases conflict?** (new regex / helper in `stylePromptCompatibility.ts`)
2. **What prefix/name text identifies this style?** (new `stylePrefixIs…()` helper)
3. **Which existing styles are better alternatives?** (canonical names merchants are likely to have enabled)

### Checklist

1. Add or extend a **style signal** function (prefix + name).
2. Add or extend a **prompt signal** function if needed.
3. In `detectStylePromptMismatch()`, append a `reasons` line and `suggestedStyleNames`.
4. Add **aliases** in `CANONICAL_STYLE_ALIASES` if the canonical preset name differs from DB display names.
5. Add tests in `stylePromptCompatibility.test.ts` using a realistic prefix string (see **Minimalist Icon** example in tests).
6. Deploy (client bundle change).

### Example: registering a new “Typography Stack” style as single-purpose

If the style prefix always forces stacked text and the customer asks for a **photographic scene**:

```typescript
// 1. Prompt signal
export function userPromptRequestsPhotographicScene(userDesc: string): boolean {
  return /\b(photo|photograph|realistic|landscape|scene)\b/i.test(userDesc || "");
}

// 2. Style signal
export function stylePrefixIsTypographyOnly(prefix: string, name: string): boolean {
  return /\btypography\b/i.test(`${name} ${prefix}`);
}

// 3. Inside detectStylePromptMismatch()
if (userPromptRequestsPhotographicScene(user) && stylePrefixIsTypographyOnly(prefix, name)) {
  reasons.push("This style only supports typographic layouts, not photographic scenes.");
  suggestedStyleNames.push("Free 4 All", "Centered Graphic");
}
```

### Example: new alternative style merchants can enable

If you add **Seamless Floral** as a merchant preset and want it suggested for pattern conflicts:

1. Add to aliases: `"seamless floral": ["seamless floral", "floral pattern"]`
2. Push `"Seamless Floral"` into `suggestedStyleNames` alongside `"Pattern Maker"` where appropriate.

Only merchants who **activated** the preset and **included it on the customizer page** will see the button.

---

## Styles that trigger warnings (merchant-created)

Merchants can create custom styles (e.g. **Minimalist Icon**) without a repo deploy. Warnings apply based on **prefix/name text**, not preset ID:

- Prefix contains **`Create a minimal icon of`** → treated as minimalist icon / single motif.
- Prefix contains **`flat solid vibrant colors`** + **`avoid white`** → vibrant-only; conflicts with B&W prompts.

Merchants do **not** configure mismatch rules in Admin. They configure:

- **Prompt Prefix** (steers AI — and drives detection)
- Which styles appear on each **Customizer page**

See also [Apparel style presets](./apparel-style-presets.md) for chroma-key prefix requirements.

---

## Dialog behavior

| Case | UI |
|------|-----|
| Conflict + ≥ 1 resolved alternative on page | “Use {Style}” buttons + “Generate anyway with {current}” |
| Conflict + no alternatives on page | Warning text only + “Generate anyway” |
| Customer chooses **Use {Style}** | Switches preset and generates (skips re-check) |
| Customer chooses **Generate anyway** | Keeps current style and generates |

---

## Testing

```bash
npx vitest run shared/stylePromptCompatibility.test.ts
```

Include cases for:

- Short prompts (`rainbow pattern`)
- Long prompts (`black and white jungle patterns`)
- Prefix-only detection when name matches (empty prefix but style name **Minimalist Icon**)
- `resolveSuggestedStylePresets()` with a subset of merchant presets (simulates page filter)

---

## Related generation behavior

Mismatch warnings are **client-side only** (pre-flight). Server generation also:

- Skips style **reference images** when the user typed a subject ([`generationPromptHints.ts`](../shared/generationPromptHints.ts))
- Adjusts AOP color rules for B&W prompts

Those server rules reduce bad output if the user clicks **Generate anyway**; the dialog reduces surprise before spending a credit.
