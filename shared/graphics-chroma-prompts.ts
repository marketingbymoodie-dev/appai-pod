/**
 * Graphics (isolated motif) style prompt fragments for large items, patterns, blankets.
 * Same hot-pink chroma-key + matting/SVG pipeline as apparel — without garment language.
 */

import { NO_HOT_PINK_IN_DESIGN, NO_HOT_PINK_IN_DESIGN_SHORT } from "./apparel-chroma-prompts";

/** Canonical prefixes keyed by graphics style preset id. */
export const GRAPHICS_CHROMA_STYLE_BY_ID: Record<string, string> = {
  "graphics-centered-graphic": `Centered flat vector illustration for large-format print, bold clean shapes, flat vibrant colors, white may be used inside the subject (teeth, eyes, highlights) but not as a background mat (${NO_HOT_PINK_IN_DESIGN}), high contrast, centered composition, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, no white mat, no rectangular frame. Create a centered graphic of`,
  "graphics-illustrated-motif": `Illustrated character motif for large-format print and patterns, detailed illustration, flat vibrant colors, white may be used inside the subject (teeth, eyes, highlights) but not as a background mat (${NO_HOT_PINK_IN_DESIGN}), high contrast, centered, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, no white mat, no rectangular frame, clean illustrated style. Create an illustrated motif of`,
  "graphics-pattern-maker": `Seamless repeating pattern design for large-format products, tileable motif, clean vector shapes, flat colors (avoid white, light colors; ${NO_HOT_PINK_IN_DESIGN_SHORT}), high contrast, isolated on a solid hot pink (#FF00FF) background, no white mat, no rectangular frame. Create a repeating pattern of`,
};

/** Fallback by lowercased style display name. */
export const GRAPHICS_CHROMA_STYLE_BY_NAME: Record<string, string> = {
  "centered graphic (graphics)": GRAPHICS_CHROMA_STYLE_BY_ID["graphics-centered-graphic"],
  "illustrated motif (graphics)": GRAPHICS_CHROMA_STYLE_BY_ID["graphics-illustrated-motif"],
  "pattern maker (graphics)": GRAPHICS_CHROMA_STYLE_BY_ID["graphics-pattern-maker"],
};
