/**
 * Apparel chroma-key style prompt fragments.
 * DB `style_presets.prompt_prefix` / `prompt_prefix_dark` are the live source
 * of truth after deploy; these are fallbacks for empty or legacy rows.
 */

export const NO_HOT_PINK_IN_DESIGN =
  "DO NOT use solid hot pink (#FF00FF) or magenta anywhere in the main design — #FF00FF is reserved exclusively for the background mat";

export const NO_HOT_PINK_IN_DESIGN_SHORT =
  "DO NOT use solid hot pink (#FF00FF) or magenta in the design";

/** Light-garment canonical prefixes keyed by lowercased style name. */
export const APPAREL_CHROMA_STYLE_BY_NAME: Record<string, string> = {
  "free 4 all": "",
  "pattern maker":
    `Seamless repeating pattern design, tileable motif, clean vector shapes, flat colors (avoid white, light colors; ${NO_HOT_PINK_IN_DESIGN_SHORT}), high contrast, isolated on a solid hot pink (#FF00FF) background, no white mat, no rectangular frame. Create a repeating pattern of`,
  opinionated:
    `T-shirt graphic, bold stacked text typography, strong opinion statement, up to 6 words maximum, flat vibrant colors (avoid white, light colors; ${NO_HOT_PINK_IN_DESIGN_SHORT}), high contrast, centered, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, no white mat, clean typographic layout. Create a bold text stack design of`,
  quotes:
    `T-shirt graphic, stylish quote typography, expressive lettering, flat vibrant colors (avoid white, light colors; ${NO_HOT_PINK_IN_DESIGN_SHORT}), high contrast, centered, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, no white mat, creative typographic layout. Create a quote design of`,
  "pet portraits":
    `T-shirt graphic, illustrated pet portrait, detailed character illustration, flat vibrant colors, white may be used inside the subject (teeth, eyes, highlights) but not as a background mat (${NO_HOT_PINK_IN_DESIGN}), high contrast, centered, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, no white mat, clean illustrated style. Create a pet portrait of`,
  "centered graphic":
    `T-shirt graphic, centered flat vector illustration, bold clean shapes, flat vibrant colors, white may be used inside the subject (teeth, eyes, highlights) but not as a background mat (${NO_HOT_PINK_IN_DESIGN}), high contrast, centered composition, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, no white mat, no rectangular frame. Create a centered graphic of`,
  "illustrated motif":
    `T-shirt graphic, illustrated character motif, detailed illustration, flat vibrant colors, white may be used inside the subject (teeth, eyes, highlights) but not as a background mat (${NO_HOT_PINK_IN_DESIGN}), high contrast, centered, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, no white mat, no rectangular frame, clean illustrated style. Create an illustrated motif of`,
};

/** Dark-garment variants keyed by style preset id (e.g. illustrated-motif). */
export const APPAREL_DARK_TIER_PROMPTS: Record<string, string> = {
  "free-4-all": "",
  "pattern-maker": `Seamless repeating pattern design, tileable motif, clean vector shapes, bright vibrant colors including white and light tones (avoid dark, black; ${NO_HOT_PINK_IN_DESIGN_SHORT}), high contrast, isolated on a solid hot pink (#FF00FF) background. Create a repeating pattern of`,
  opinionated: `T-shirt graphic, bold stacked text typography, strong opinion statement, up to 6 words maximum, bright vibrant colors including white and light tones (avoid dark, black; ${NO_HOT_PINK_IN_DESIGN_SHORT}), high contrast, centered, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, clean typographic layout. Create a bold text stack design of`,
  quotes: `T-shirt graphic, stylish quote typography, expressive lettering, bright vibrant colors including white and light tones (avoid dark, black; ${NO_HOT_PINK_IN_DESIGN_SHORT}), high contrast, centered, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, creative typographic layout. Create a quote design of`,
  "pet-portraits": `T-shirt graphic, illustrated pet portrait, detailed character illustration, bright vibrant colors including white and light tones (avoid dark, black; ${NO_HOT_PINK_IN_DESIGN}), high contrast, centered, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, clean illustrated style. Create a pet portrait of`,
  "centered-graphic": `T-shirt graphic, centered flat vector illustration, bold clean shapes, bright vibrant colors including white and light tones (avoid dark, black; ${NO_HOT_PINK_IN_DESIGN}), high contrast, centered composition, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, no white mat, no rectangular frame. Create a centered graphic of`,
  "illustrated-motif": `T-shirt graphic, illustrated character motif, detailed illustration, bright vibrant colors including white and light tones (avoid dark, black; ${NO_HOT_PINK_IN_DESIGN}), high contrast, centered, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, no white mat, no rectangular frame, clean illustrated style. Create an illustrated motif of`,
  none: "",
};

export function isChromaSafeApparelPrefix(prefix: string): boolean {
  const lower = prefix.trim().toLowerCase();
  return lower.includes("#ff00ff") || lower.includes("hot pink");
}
