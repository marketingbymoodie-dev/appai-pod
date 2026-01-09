export type ColorTier = "light" | "dark";

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

export function getRelativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const srgb = c / 255;
    return srgb <= 0.03928
      ? srgb / 12.92
      : Math.pow((srgb + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

export function getColorTier(hex: string, threshold: number = 0.35): ColorTier {
  const rgb = hexToRgb(hex);
  if (!rgb) return "light";
  
  const luminance = getRelativeLuminance(rgb.r, rgb.g, rgb.b);
  return luminance <= threshold ? "dark" : "light";
}

export function isColorDark(hex: string, threshold: number = 0.35): boolean {
  return getColorTier(hex, threshold) === "dark";
}

export function isColorLight(hex: string, threshold: number = 0.35): boolean {
  return getColorTier(hex, threshold) === "light";
}
