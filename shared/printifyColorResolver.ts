export const UNKNOWN_COLOR_HEX = "#888888";

export type ColorResolutionSource = "stored" | "printify" | "library" | "derived" | "fallback";

export type ColorResolution = {
  hex: string;
  source: ColorResolutionSource;
};

const COLOR_HEX_LIBRARY: Record<string, string> = {
  black: "#1a1a1a",
  white: "#f5f5f5",
  red: "#C41E3A",
  blue: "#2563EB",
  navy: "#1B2838",
  green: "#22C55E",
  yellow: "#FACC15",
  orange: "#F97316",
  pink: "#EC4899",
  purple: "#A855F7",
  gray: "#9E9E9E",
  grey: "#9E9E9E",
  brown: "#795548",
  beige: "#F5F5DC",
  cream: "#FFFDD0",
  tan: "#D2B48C",
  walnut: "#5D4037",
  natural: "#D7CCC8",
  gold: "#FFD700",
  silver: "#C0C0C0",
  oak: "#C4A35A",
  cherry: "#9B2335",
  mahogany: "#4E2728",
  espresso: "#3C2415",
  "solid black": "#1a1a1a",
  "solid white": "#f5f5f5",
  "solid red": "#C41E3A",
  "solid blue": "#2563EB",
  "solid navy": "#1B2838",
  "solid green": "#22C55E",
  "heather grey": "#9CA3AF",
  "heather gray": "#9CA3AF",
  "dark heather": "#4B5563",
  "heather navy": "#374151",
  "heather blue": "#60A5FA",
  "heather red": "#F87171",
  "heather forest": "#166534",
  "heather purple": "#A855F7",
  "heather orange": "#FB923C",
  "heather green": "#6B8E6B",
  "heather yellow gold": "#D9A441",
  "heather sand dune": "#C8B99A",
  "arctic white": "#F8FAFC",
  "jet black": "#0a0a0a",
  charcoal: "#36454F",
  burgundy: "#800020",
  maroon: "#800000",
  cardinal: "#8C1D40",
  "cardinal red": "#C41E3A",
  "fire red": "#FF3131",
  scarlet: "#FF2400",
  coral: "#FF7F50",
  "hot pink": "#FF69B4",
  "baby pink": "#F4C2C2",
  "light pink": "#FFB6C1",
  "soft pink": "#F7B6C8",
  magenta: "#FF00FF",
  fuchsia: "#FF00FF",
  rose: "#FF007F",
  "sky blue": "#87CEEB",
  "light blue": "#ADD8E6",
  "royal blue": "#4169E1",
  royal: "#4169E1",
  "navy blue": "#000080",
  cobalt: "#0047AB",
  "steel blue": "#4682B4",
  "oxford navy": "#1C2541",
  indigo: "#4B0082",
  "midnight navy": "#191970",
  "cool blue": "#4A90D9",
  "tahiti blue": "#3AB09E",
  "kelly green": "#4CBB17",
  "forest green": "#228B22",
  "military green": "#4B5320",
  olive: "#808000",
  sage: "#9DC183",
  mint: "#98FF98",
  lime: "#32CD32",
  "bottle green": "#006A4E",
  "dark green": "#006400",
  emerald: "#50C878",
  mustard: "#FFDB58",
  lemon: "#FFF44F",
  "banana cream": "#FFE9A1",
  "light yellow": "#FFFFE0",
  "sun yellow": "#FFE81F",
  canary: "#FFEF00",
  "orange crush": "#FF6600",
  "burnt orange": "#CC5500",
  peach: "#FFCBA4",
  rust: "#B7410E",
  terracotta: "#E2725B",
  pumpkin: "#FF7518",
  lavender: "#E6E6FA",
  violet: "#EE82EE",
  plum: "#DDA0DD",
  lilac: "#C8A2C8",
  grape: "#6F2DA8",
  eggplant: "#614051",
  "purple rush": "#9B59B6",
  "hot chocolate": "#4A2C2A",
  chocolate: "#7B3F00",
  coffee: "#6F4E37",
  mocha: "#967969",
  "dark chocolate": "#3D2314",
  sand: "#C2B280",
  khaki: "#C3B091",
  taupe: "#483C32",
  camel: "#C19A6B",
  nude: "#E3BC9A",
  champagne: "#F7E7CE",
  "desert pink": "#EDC9AF",
  ash: "#B2BEB5",
  slate: "#708090",
  "steel grey": "#71797E",
  "steel gray": "#71797E",
  gunmetal: "#2A3439",
  anthracite: "#293133",
  "light grey": "#D3D3D3",
  "light gray": "#D3D3D3",
  "heavy metal": "#3D3D3D",
  teal: "#008080",
  cyan: "#00FFFF",
  aqua: "#00FFFF",
  turquoise: "#40E0D0",
  seafoam: "#93E9BE",
  ivory: "#FFFFF0",
  pearl: "#FDEEF4",
  oatmeal: "#D5C4A1",
  ecru: "#C2B280",
  "athletic heather": "#B8B8B8",
  "sport grey": "#9E9E9E",
  "sport gray": "#9E9E9E",
  "dark grey heather": "#4B4B4B",
  "dark gray heather": "#4B4B4B",
  "ice grey": "#D3D3D3",
  "ice gray": "#D3D3D3",
  "vintage black": "#2B2B2B",
  "vintage navy": "#2C3E50",
  "washed black": "#3D3D3D",
  "stonewash blue": "#5DADE2",
};

const DERIVED_COLOR_TERMS = Object.keys(COLOR_HEX_LIBRARY)
  .sort((a, b) => b.length - a.length);

export function normalizeColorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^solid\s+/i, "")
    .trim();
}

function normalizeBlueprintColors(
  blueprintColors?: Record<string, string>
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, hex] of Object.entries(blueprintColors || {})) {
    if (hex) normalized[normalizeColorName(name)] = hex;
  }
  return normalized;
}

export function resolvePrintifyColorHex(
  colorName: string,
  blueprintColors?: Record<string, string>
): ColorResolution {
  const normalizedName = normalizeColorName(colorName);
  const normalizedBlueprintColors = normalizeBlueprintColors(blueprintColors);

  if (normalizedBlueprintColors[normalizedName]) {
    return { hex: normalizedBlueprintColors[normalizedName], source: "printify" };
  }

  if (COLOR_HEX_LIBRARY[normalizedName]) {
    return { hex: COLOR_HEX_LIBRARY[normalizedName], source: "library" };
  }

  for (const term of DERIVED_COLOR_TERMS) {
    if (normalizedName.includes(term)) {
      return { hex: COLOR_HEX_LIBRARY[term], source: "derived" };
    }
  }

  return { hex: UNKNOWN_COLOR_HEX, source: "fallback" };
}

export function resolveStoredColorHex(colorName: string, storedHex?: string | null): ColorResolution {
  if (storedHex && storedHex.toLowerCase() !== UNKNOWN_COLOR_HEX) {
    return { hex: storedHex, source: "stored" };
  }
  return resolvePrintifyColorHex(colorName);
}
