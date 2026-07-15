import { hasUserArtworkDescription, userPromptRequestsMonochrome } from "./generationPromptHints";

export type StylePromptMismatch = {
  reasons: string[];
  /** Canonical style names — resolved against merchant presets in the UI */
  suggestedStyleNames: string[];
};

export type StylePresetLike = {
  id: string;
  name: string;
};

const CANONICAL_STYLE_ALIASES: Record<string, string[]> = {
  "free 4 all": ["free 4 all", "free for all", "custom prompt", "no style"],
  "pattern maker": ["pattern maker", "pattern"],
  "illustrated motif": ["illustrated motif", "illustrated"],
  "centered graphic": ["centered graphic", "centered"],
  "opinionated": ["opinionated", "text stack", "typography"],
  quotes: ["quotes", "quote"],
  "pet portraits": ["pet portraits", "pet portrait", "pet"],
};

/** User asked for a repeating / tileable pattern (not a single icon). */
export function userPromptRequestsPattern(userDesc: string | null | undefined): boolean {
  if (!userDesc) return false;
  const t = userDesc.toLowerCase();
  return (
    /\bpatterns?\b/.test(t) ||
    /\brepeating\b/.test(t) ||
    /\brepeat(?:ing|able)?\b/.test(t) ||
    /\bseamless\b/.test(t) ||
    /\btile(?:able|d)?\b/.test(t) ||
    /\ball-over\b/.test(t)
  );
}

export function stylePrefixRequiresVibrantColor(stylePrefix: string): boolean {
  const t = stylePrefix.toLowerCase();
  return (
    /\bvibrant\b/.test(t) ||
    /\bavoid white\b/.test(t) ||
    /\bflat solid vibrant\b/.test(t) ||
    /\bbright vibrant\b/.test(t)
  );
}

export function stylePrefixIsMinimalIcon(stylePrefix: string, styleName: string): boolean {
  const combined = `${styleName} ${stylePrefix}`.toLowerCase();
  return (
    /\bminimal(?:ist)?\s+icon\b/.test(combined) ||
    /\bcreate a minimal icon of\b/.test(stylePrefix.toLowerCase())
  );
}

export function stylePrefixIsSingleMotif(stylePrefix: string, styleName: string): boolean {
  const combined = `${styleName} ${stylePrefix}`.toLowerCase();
  return (
    stylePrefixIsMinimalIcon(stylePrefix, styleName) ||
    /\bcentered graphic\b/.test(combined) ||
    /\billustrated motif\b/.test(combined) ||
    /\bcreate a (?:centered graphic|illustrated motif) of\b/.test(stylePrefix.toLowerCase())
  );
}

/**
 * Detect when a selected style's prefix fights the customer's description.
 * Returns null when generation can proceed without warning.
 */
export function detectStylePromptMismatch(
  userPrompt: string | null | undefined,
  stylePrefix: string | null | undefined,
  styleName: string | null | undefined,
): StylePromptMismatch | null {
  const user = (userPrompt || "").trim();
  const prefix = (stylePrefix || "").trim();
  const name = (styleName || "").trim();

  if (!hasUserArtworkDescription(user)) return null;
  if (!prefix && !name) return null;

  const wordCount = user.split(/\s+/).filter(Boolean).length;
  const reasons: string[] = [];
  const suggestedStyleNames: string[] = [];

  // High-confidence conflicts — fire even on short prompts (e.g. "rainbow pattern").
  if (userPromptRequestsPattern(user) && stylePrefixIsSingleMotif(prefix, name)) {
    reasons.push(
      "Your description asks for a repeating pattern, but this style is built for a single centered icon or motif.",
    );
    suggestedStyleNames.push("Pattern Maker");
  }

  if (userPromptRequestsMonochrome(user) && stylePrefixRequiresVibrantColor(prefix)) {
    reasons.push(
      "Your description asks for black & white or monochrome, but this style requires vibrant colors and limits white in the design.",
    );
    suggestedStyleNames.push("Free 4 All", "Pattern Maker");
  }

  // Minimalist Icon: long or descriptive prompts get replaced by generic icons.
  if (
    stylePrefixIsMinimalIcon(prefix, name) &&
    wordCount >= 4 &&
    !userPromptRequestsPattern(user) &&
    reasons.length === 0
  ) {
    reasons.push(
      "This style always steers toward a generic minimalist icon. Your detailed subject may be simplified or replaced.",
    );
    suggestedStyleNames.push("Illustrated Motif", "Centered Graphic", "Free 4 All");
  }

  if (reasons.length === 0) return null;

  return {
    reasons,
    suggestedStyleNames: [...new Set(suggestedStyleNames)],
  };
}

function nameMatchesCanonical(presetName: string, canonicalKey: string): boolean {
  const lower = presetName.trim().toLowerCase();
  const aliases = CANONICAL_STYLE_ALIASES[canonicalKey] || [canonicalKey];
  return aliases.some(
    (alias) => lower === alias || lower.includes(alias) || alias.includes(lower),
  );
}

/** Map canonical suggestions to presets available on this page/product. */
export function resolveSuggestedStylePresets(
  presets: StylePresetLike[],
  suggestedStyleNames: string[],
  currentPresetId?: string,
): StylePresetLike[] {
  const resolved: StylePresetLike[] = [];
  for (const suggested of suggestedStyleNames) {
    const key = suggested.trim().toLowerCase();
    const match = presets.find(
      (p) =>
        p.id !== currentPresetId &&
        (p.name.trim().toLowerCase() === key || nameMatchesCanonical(p.name, key)),
    );
    if (match && !resolved.some((r) => r.id === match.id)) {
      resolved.push(match);
    }
  }
  return resolved;
}
