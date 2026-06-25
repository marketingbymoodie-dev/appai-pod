/**
 * Parse Printify catalog variant titles/options into size and colour labels.
 * Used by import, variant preview, and refresh-variants — keep in sync here.
 */

export const PRINTIFY_APPAREL_SIZE_TOKENS = [
  "XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "XXL", "XXXL",
] as const;

export const PRINTIFY_NAMED_SIZE_TOKENS = [
  "small",
  "medium",
  "large",
  "extra large",
  "king",
  "queen",
  "twin",
  "full",
  "one size",
] as const;

export function looksLikePrintifySize(str: string): boolean {
  const lower = str.toLowerCase().trim();
  if (lower.match(/^\d+[""']?\s*[xX×]\s*\d+[""']?$/)) return true;
  if (PRINTIFY_APPAREL_SIZE_TOKENS.map((s) => s.toLowerCase()).includes(lower)) return true;
  if ((PRINTIFY_NAMED_SIZE_TOKENS as readonly string[]).includes(lower)) return true;
  if (lower.match(/^\d+\s*oz$/i)) return true;
  if (lower.match(/^iphone\s+(\d|x|xs|xr|se|pro|plus|max)/i)) return true;
  if (lower.match(/^galaxy\s+(s\d|a\d|note|z\s*(fold|flip)|ultra)/i)) return true;
  if (lower.match(/^pixel\s+(\d|fold|pro)/i)) return true;
  if (lower.match(/^samsung\s+(galaxy|note)/i)) return true;
  if (lower.match(/^oneplus\s+\d/i)) return true;
  if (lower.match(/^for\s+(iphone|galaxy|pixel|samsung)/i)) return true;
  if (lower.match(/^(youth|kid'?s?|toddler|infant|baby)\s/i)) return true;
  return false;
}

function isSizeOptionKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === "size" || lower === "sizes" || lower.includes("size");
}

function isColorOptionKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (isSizeOptionKey(key)) return false;
  return (
    lower === "color" ||
    lower === "colour" ||
    lower === "colors" ||
    lower === "colours" ||
    lower === "frame_color" ||
    lower === "frame color" ||
    lower.includes("color") ||
    lower.includes("colour")
  );
}

/** Read colour from variant.options — handles Printify's varying option key names. */
export function extractPrintifyColorFromOptions(
  options: Record<string, string> | null | undefined,
  colorOptionName?: string | null,
): string {
  if (!options || typeof options !== "object") return "";

  if (colorOptionName) {
    if (options[colorOptionName]) return String(options[colorOptionName]).trim();
    const target = colorOptionName.toLowerCase();
    for (const [key, val] of Object.entries(options)) {
      if (key.toLowerCase() === target && val) return String(val).trim();
    }
  }

  for (const key of Object.keys(options)) {
    if (isColorOptionKey(key) && options[key]) {
      return String(options[key]).trim();
    }
  }

  return "";
}

/** Parse colour from variant title when options omit it (e.g. "S / Black"). */
export function extractPrintifyColorFromTitle(title: string): string {
  if (!title || (!title.includes(" / ") && !title.includes("/"))) return "";

  const hasSeparator = title.includes(" / ");
  const parts = hasSeparator
    ? title.split(" / ").map((p) => p.trim())
    : title.split("/").map((p) => p.trim());

  if (parts.length >= 3 && looksLikePrintifySize(parts[0]!)) {
    const colorParts = parts.slice(1).filter((p) => !looksLikePrintifySize(p));
    if (colorParts.length > 0) return colorParts.join(" / ");
  }

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (!looksLikePrintifySize(part)) return part;
  }

  return "";
}

export function extractPrintifyColorName(
  options: Record<string, string> | null | undefined,
  title: string,
  colorOptionName?: string | null,
): string {
  const fromOptions = extractPrintifyColorFromOptions(options, colorOptionName);
  if (fromOptions) return fromOptions;
  return extractPrintifyColorFromTitle(title);
}
