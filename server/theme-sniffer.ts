import { shopifyClient } from "./shopify";

/**
 * Branding settings detected from a Shopify theme
 */
export interface BrandingSettings {
  primaryColor?: string;      // Hex color for primary buttons/accents
  secondaryColor?: string;    // Hex color for secondary elements
  textColor?: string;         // Hex color for text
  borderColor?: string;       // Hex color for borders
  backgroundColor?: string;   // Hex color for backgrounds
  fontFamily?: string;        // Font family name
  syncedAt?: string;          // ISO timestamp of last sync
}

/**
 * Sniff theme colors and fonts from a Shopify store
 * Looks for standard CSS variables that most modern Shopify themes provide
 */
export async function sniffThemeColors(shopDomain: string): Promise<BrandingSettings> {
  try {
    // Fetch the theme CSS from the Shopify store
    const themeUrl = `https://${shopDomain}/cdn/shop/t/`;
    
    // Try to fetch the theme's CSS file to extract colors
    // Most Shopify themes expose CSS variables like --color-button, --color-text, etc.
    const response = await fetch(`https://${shopDomain}`, {
      headers: {
        "User-Agent": "AppAI-Theme-Sniffer/1.0",
      },
    });

    if (!response.ok) {
      console.warn(`Failed to fetch theme from ${shopDomain}: ${response.status}`);
      return getDefaultBranding();
    }

    const html = await response.text();
    
    // Extract CSS variables from the HTML
    const branding = extractCSSVariables(html);
    branding.syncedAt = new Date().toISOString();
    
    return branding;
  } catch (error) {
    console.error("Error sniffing theme colors:", error);
    return getDefaultBranding();
  }
}

/**
 * Extract CSS color variables from HTML
 * Looks for patterns like: --color-button: #000000; or var(--color-button)
 */
function extractCSSVariables(html: string): BrandingSettings {
  const branding: BrandingSettings = {};

  // Look for CSS custom properties in <style> tags or inline styles
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let styleMatch;

  while ((styleMatch = styleRegex.exec(html)) !== null) {
    const styleContent = styleMatch[1];

    // Common Shopify theme color variable patterns
    const colorPatterns = {
      primaryColor: [
        /--color-button\s*:\s*(#[0-9a-f]{3,8}|rgb\([^)]+\)|hsl\([^)]+\))/i,
        /--primary\s*:\s*(#[0-9a-f]{3,8}|rgb\([^)]+\)|hsl\([^)]+\))/i,
        /--color-primary\s*:\s*(#[0-9a-f]{3,8}|rgb\([^)]+\)|hsl\([^)]+\))/i,
      ],
      textColor: [
        /--color-text\s*:\s*(#[0-9a-f]{3,8}|rgb\([^)]+\)|hsl\([^)]+\))/i,
        /--text-color\s*:\s*(#[0-9a-f]{3,8}|rgb\([^)]+\)|hsl\([^)]+\))/i,
      ],
      borderColor: [
        /--color-border\s*:\s*(#[0-9a-f]{3,8}|rgb\([^)]+\)|hsl\([^)]+\))/i,
        /--border-color\s*:\s*(#[0-9a-f]{3,8}|rgb\([^)]+\)|hsl\([^)]+\))/i,
      ],
      backgroundColor: [
        /--color-background\s*:\s*(#[0-9a-f]{3,8}|rgb\([^)]+\)|hsl\([^)]+\))/i,
        /--background-color\s*:\s*(#[0-9a-f]{3,8}|rgb\([^)]+\)|hsl\([^)]+\))/i,
      ],
    };

    // Extract each color
    for (const [key, patterns] of Object.entries(colorPatterns)) {
      for (const pattern of patterns) {
        const match = styleContent.match(pattern);
        if (match && match[1]) {
          branding[key as keyof BrandingSettings] = match[1];
          break;
        }
      }
    }

    // Extract font family
    const fontMatch = styleContent.match(/--font-body-family\s*:\s*([^;]+)/i);
    if (fontMatch && fontMatch[1]) {
      branding.fontFamily = fontMatch[1].trim();
    }
  }

  return branding;
}

/**
 * Get default branding settings (fallback)
 * Uses a clean black & white theme that matches most stores
 */
export function getDefaultBranding(): BrandingSettings {
  return {
    primaryColor: "#000000",      // Black
    secondaryColor: "#f5f5f5",    // Light gray
    textColor: "#000000",         // Black text
    borderColor: "#000000",       // Black borders
    backgroundColor: "#ffffff",   // White background
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Convert hex color to CSS custom property format
 */
export function hexToHSL(hex: string): string {
  // Remove # if present
  hex = hex.replace("#", "");

  // Parse hex to RGB
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0,
    s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }

  const hslH = Math.round(h * 360);
  const hslS = Math.round(s * 100);
  const hslL = Math.round(l * 100);

  return `${hslH} ${hslS}% ${hslL}%`;
}
