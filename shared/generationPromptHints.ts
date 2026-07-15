/** True when the customer typed a concrete subject (not style-only generation). */
export function hasUserArtworkDescription(userDesc: string | null | undefined): boolean {
  return !!(userDesc && userDesc.trim().length >= 3);
}

/** Style preset reference URLs — skip when the user typed their own subject. */
export function filterStyleReferenceUrls(
  styleBaseUrls: string[],
  userDesc: string | null | undefined,
  hasCustomerReferenceImage: boolean,
): string[] {
  if (!shouldUseStyleReferenceImage(userDesc, hasCustomerReferenceImage)) return [];
  return styleBaseUrls;
}

/** Detect monochrome / B&W requests so we don't force "vibrant bold" color rules. */
export function userPromptRequestsMonochrome(userDesc: string | null | undefined): boolean {
  if (!userDesc) return false;
  const t = userDesc.toLowerCase();
  return (
    /\bblack\s+and\s+white\b/.test(t) ||
    /\bb\s*&\s*w\b/.test(t) ||
    /\bmonochrome\b/.test(t) ||
    /\bgrayscale\b/.test(t) ||
    /\bgreyscale\b/.test(t) ||
    /\bblack\s*&\s*white\b/.test(t) ||
    (/\bonly\b/.test(t) && /\b(black|white|grey|gray)\b/.test(t))
  );
}

/** AOP sizing block line 3 — respect user palette when they asked for B&W. */
export function aopDesignColorRequirement(userDesc: string | null | undefined): string {
  if (userPromptRequestsMonochrome(userDesc)) {
    return "DESIGN COLORS: Use ONLY black, white, and grey tones exactly as the user described. Do NOT add green or other colors unless the user explicitly requested them. The design MUST NOT contain any hot pink/magenta pixels — #FF00FF is reserved exclusively for the background.";
  }
  return "DESIGN COLORS: Use VIBRANT, BOLD colors. The design MUST NOT contain any hot pink/magenta pixels in the main subject — #FF00FF is reserved exclusively for the background.";
}

/**
 * Style preset reference images steer the model toward the sample artwork (e.g. a
 * skull icon). Skip them when the user typed their own subject.
 */
export function shouldUseStyleReferenceImage(
  userDesc: string | null | undefined,
  hasCustomerReferenceImage: boolean,
): boolean {
  if (hasCustomerReferenceImage) return true;
  return !hasUserArtworkDescription(userDesc);
}

/** Full AOP sizing block injected by route handlers (line 3 respects B&W requests). */
export function buildAopSizingRequirements(userDesc: string | null | undefined): string {
  return `
MANDATORY IMAGE REQUIREMENTS FOR ALL-OVER PRINT (AOP) - FOLLOW EXACTLY:
1. ISOLATED MOTIF: Create a SINGLE, centered graphic design that is ISOLATED from any background scenery. This motif will be tiled into a repeating pattern.
2. SOLID HOT PINK CHROMA KEY BACKGROUND: The ENTIRE background MUST be a flat, solid, uniform hot pink (#FF00FF) color. Every pixel that is not part of the design must be exactly #FF00FF. DO NOT create scenic backgrounds, gradients, or detailed environments.
3. ${aopDesignColorRequirement(userDesc)}
4. CENTERED COMPOSITION: The main design subject should be centered and take up approximately 60-70% of the canvas, leaving clean hot pink space around it.
5. CLEAN EDGES: The design must have crisp, hard vector-like edges against the hot pink background. No fuzzy, gradient, or semi-transparent edges.
6. NO RECTANGULAR FRAMES: Do NOT put the design inside a rectangular box, border, or frame. The design should stand alone on the solid hot pink background.
6b. NO WHITE OR GREY PLATE: Do NOT render the subject on a white or grey mat — the ONLY background color is #FF00FF edge-to-edge.
7. PRINT-READY: This is for all-over print fabric — create an isolated motif graphic.
8. COMPOSITION FORMAT: Fill the canvas matching the requested aspect ratio with the design centered.
9. STRICT PROMPT ADHERENCE: ONLY depict exactly what the user described. Do NOT add text, slogans, words, brand names, themed scenarios, or additional story elements unless the user explicitly asked for them.
`;
}

/** Non-AOP apparel chroma-key sizing — color line respects B&W requests. */
export function apparelMotifDesignColors(
  userDesc: string | null | undefined,
  isDarkTier: boolean,
): string {
  if (userPromptRequestsMonochrome(userDesc)) {
    return "Use ONLY black, white, and grey tones exactly as the user described. Do NOT add green or other colors unless the user explicitly requested them. AVOID hot pink/magenta in the design.";
  }
  if (isDarkTier) {
    return "BRIGHT, VIBRANT colors including white and light tones. AVOID dark, black, and hot pink/magenta colors in the design.";
  }
  return "VIBRANT colors. White may be used inside the subject (teeth, eyes, highlights) but NOT as a background mat. AVOID hot pink/magenta in the design.";
}

/** Pattern Maker / tileable-repeat styles (not single-icon AOP). */
export function styleIsPatternMaker(
  styleName: string | null | undefined,
  stylePrefix: string | null | undefined,
): boolean {
  const combined = `${styleName || ""} ${stylePrefix || ""}`.toLowerCase();
  return (
    /\bpattern maker\b/.test(combined) ||
    (/\brepeating pattern\b/.test(combined) && /\btileable\b/.test(combined))
  );
}

/** AOP sizing for Pattern Maker — tileable repeat unit, not a single centered icon. */
export function buildAopPatternSizingRequirements(userDesc: string | null | undefined): string {
  return `
MANDATORY IMAGE REQUIREMENTS FOR ALL-OVER PRINT (AOP) PATTERN - FOLLOW EXACTLY:
1. TILEABLE REPEATING UNIT: Create a seamless, tileable repeating pattern unit. The design must repeat seamlessly when tiled horizontally and vertically. Do NOT output a single isolated icon floating in empty space.
2. SOLID HOT PINK CHROMA KEY BACKGROUND: The ENTIRE background MUST be a flat, solid, uniform hot pink (#FF00FF) color. Every pixel that is not part of the pattern must be exactly #FF00FF.
3. ${aopDesignColorRequirement(userDesc)}
4. FILL THE TILE: Pattern elements should fill the tile unit edge-to-edge with no large empty pink gaps — this unit will be repeated across the garment.
5. CLEAN EDGES: Crisp vector-like edges between pattern elements and the hot pink background. No fuzzy gradients into the background.
6. NO RECTANGULAR FRAMES: Do NOT put the pattern inside a box, border, or card — the tile should extend to all four edges.
7. PRINT-READY: This is for all-over print fabric — create a seamless repeat tile.
8. STRICT PROMPT ADHERENCE: ONLY depict exactly what the user described. Do NOT add text, slogans, or extra subjects unless the user explicitly asked for them.
`;
}
