/**
 * Mapper mockups/source panels live behind platform-admin API routes that
 * require a Shopify session token (injected on fetch(), not on <img src>).
 */

const MAPPER_ASSET_PREFIX = "/api/platform/aop-mapper/";

export function isMapperAuthAssetUrl(src: string): boolean {
  try {
    const path = new URL(src, window.location.origin).pathname;
    return path.startsWith(MAPPER_ASSET_PREFIX);
  } catch {
    return src.startsWith(MAPPER_ASSET_PREFIX);
  }
}

function isCrossOrigin(src: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const url = new URL(src, window.location.href);
    return url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function loadViaImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (isCrossOrigin(src)) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image at ${src}`));
    img.src = src;
  });
}

/** Load a mapper asset URL with Shopify auth when needed. */
export async function loadMapperAssetImage(src: string): Promise<HTMLImageElement> {
  if (!isMapperAuthAssetUrl(src)) {
    return loadViaImageElement(src);
  }

  const res = await fetch(src, { credentials: "include", cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load mapper asset (${res.status})`);
  }
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  try {
    return await loadViaImageElement(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export async function readMapperAssetDimensions(
  src: string,
): Promise<{ width: number; height: number }> {
  const img = await loadMapperAssetImage(src);
  return { width: img.naturalWidth, height: img.naturalHeight };
}
