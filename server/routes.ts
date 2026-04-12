import { generateImageBase64 } from "./replit_integrations/image/client";
import { generatePattern, removeBackground, type PatternType } from "./picsart-client";
import { tileImage, type TileMode } from "./sharp-tiler";
import pg from "pg";
import express, { type Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { storage } from "./storage";
import { pool, db } from "./db";
import { customizerDesigns, customizerPages, generationJobs, productTypes, publishedProducts } from "@shared/schema";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { setupAuth, isAuthenticated, registerAuthRoutes } from "./replit_integrations/auth";
import { PRINT_SIZES, FRAME_COLORS, STYLE_PRESETS, APPAREL_DARK_TIER_PROMPTS, type InsertDesign, getColorTier, type ColorTier } from "@shared/schema";
import { registerShopifyRoutes, registerCartScript, shopifyApiCall } from "./shopify";
import { registerAdminBrandingRoutes } from "./routes/admin-branding";
import Stripe from "stripe";
import { getPageLimit, canCreatePage, getEffectivePlan, PLAN_PRICES_USD, PLAN_DISPLAY_NAMES, PAID_PLANS } from "./customizer-plans";
import type { CustomizerPage } from "@shared/schema";
import { ObjectStorageService, registerObjectStorageRoutes, objectStorageClient, getStorageDir } from "./replit_integrations/object_storage";
import {
  isSupabaseDesignsConfigured,
  uploadDesignToSupabase,
  uploadDesignFileToSupabase,
  getSupabaseDesignPublicUrl,
} from "./supabaseDesigns";
function toUint8Array(buf: Buffer) {
  // Creates a NEW Uint8Array backed by a normal ArrayBuffer (fixes TS BlobPart typing)
  return Uint8Array.from(buf);
}

function toCleanBuffer(buf: Buffer) {
  // Re-wrap via Uint8Array so TypeScript stops treating it as Buffer<ArrayBufferLike>
  return Buffer.from(toUint8Array(buf));
}

const objectStorage = new ObjectStorageService();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" }) : null;

/**
 * Wrap an async Express handler so rejected promises are forwarded to next(err)
 * instead of crashing the process with an unhandled rejection.
 */
function asyncHandler(fn: (req: any, res: Response, next: NextFunction) => Promise<any>) {
  return (req: any, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

const THUMBNAIL_SIZE = 256; // Max dimension for thumbnails

// Helper function to fetch an image from storage (local or Supabase URL) and convert to base64
async function fetchImageFromStorageAsBase64(objectPath: string): Promise<{ base64: string; mimeType: string }> {
  let buffer: Buffer;
  let extension: string;

  if (objectPath.startsWith("http://") || objectPath.startsWith("https://")) {
    const res = await fetch(objectPath);
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "";
    extension = contentType.includes("png") ? "png" : "jpg";
  } else {
    // Local path: /objects/designs/abc123.png
    const relativePath = objectPath.replace(/^\/objects\//, "");
    const localPath = path.join(getStorageDir(), relativePath);
    buffer = await fs.promises.readFile(localPath);
    extension = path.extname(localPath).slice(1).toLowerCase();
  }

  const base64 = buffer.toString("base64");
  const mimeType = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : "image/png";
  return { base64, mimeType };
}

async function generateThumbnail(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: 80 })
    .toBuffer();
}

// Helper function to calculate generation dimensions from aspect ratio
const calculateGenDimensions = (aspectRatioStr: string): { genWidth: number; genHeight: number } => {
  const [w, h] = aspectRatioStr.split(":").map(Number);
  if (!w || !h || isNaN(w) || isNaN(h)) {
    return { genWidth: 1024, genHeight: 1024 };
  }
  const ratio = w / h;
  const maxDim = 1024;
  if (ratio >= 1) {
    // Landscape or square
    return { genWidth: maxDim, genHeight: Math.round(maxDim / ratio) };
  } else {
    // Portrait
    return { genWidth: Math.round(maxDim * ratio), genHeight: maxDim };
  }
};

// Helper function to map aspect ratio to Gemini-supported aspect ratios
const mapToGeminiAspectRatio = (aspectRatioStr: string): string => {
  const [w, h] = aspectRatioStr.split(":").map(Number);
  if (!w || !h || isNaN(w) || isNaN(h)) return "1:1";
  const ratio = w / h;
  if (ratio >= 2.1) return "21:9";
  if (ratio >= 1.65) return "16:9";
  if (ratio >= 1.4) return "3:2";
  if (ratio >= 1.2) return "4:3";
  if (ratio >= 1.1) return "5:4";
  if (ratio >= 0.9) return "1:1";
  if (ratio >= 0.75) return "4:5";
  if (ratio >= 0.65) return "3:4";
  if (ratio >= 0.55) return "2:3";
  return "9:16";
};

interface SaveImageResult {
  imageUrl: string;
  thumbnailUrl: string;
}

interface TargetDimensions {
  width: number;
  height: number;
}

async function resizeToAspectRatio(buffer: Buffer, targetDims: TargetDimensions, outputFormat: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
  const metadata = await sharp(buffer).metadata();
  const srcWidth = metadata.width || 1024;
  const srcHeight = metadata.height || 1024;
  
  const targetRatio = targetDims.width / targetDims.height;
  const srcRatio = srcWidth / srcHeight;
  
  let cropWidth = srcWidth;
  let cropHeight = srcHeight;
  let cropLeft = 0;
  let cropTop = 0;
  
  if (srcRatio > targetRatio) {
    cropWidth = Math.round(srcHeight * targetRatio);
    cropLeft = Math.round((srcWidth - cropWidth) / 2);
  } else if (srcRatio < targetRatio) {
    cropHeight = Math.round(srcWidth / targetRatio);
    cropTop = Math.round((srcHeight - cropHeight) / 2);
  }
  
  const sharpInstance = sharp(buffer)
    .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
    .resize(targetDims.width, targetDims.height, { fit: 'fill' });
  
  if (outputFormat === 'jpeg') {
    return sharpInstance.jpeg({ quality: 90 }).toBuffer();
  }
  return sharpInstance.png().toBuffer();
}

/**
 * Chroma key background removal with smart fallback.
 *
 * 1. Try removing #FF00FF (hot pink) pixels — the intended chroma key.
 * 2. If <10% of pixels were pink (AI ignored the instruction), detect the actual
 *    background color by sampling the four corners, then remove that color instead.
 */
async function removeChromaKeyBackground(buffer: Buffer, tolerance: number = 60): Promise<Buffer> {
  console.log(`[Chroma Key] Starting background removal (tolerance=${tolerance})...`);
  const startTime = Date.now();

  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const pixels = new Uint8Array(data);
  const total = width * height;

  // Pass 1: try #FF00FF chroma key
  let removed = 0;
  const targetR = 255, targetG = 0, targetB = 255;

  for (let i = 0; i < pixels.length; i += channels) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const dist = Math.abs(r - targetR) + Math.abs(g - targetG) + Math.abs(b - targetB);
    if (dist <= tolerance) {
      pixels[i + 3] = 0;
      removed++;
    }
  }

  const pinkPct = (removed / total) * 100;
  console.log(`[Chroma Key] Pink pass: removed ${removed}/${total} (${pinkPct.toFixed(1)}%)`);

  // If pink removal worked (>10% of image was pink background), we're done
  if (pinkPct >= 10) {
    const elapsed = Date.now() - startTime;
    console.log(`[Chroma Key] Complete in ${elapsed}ms — pink chroma key succeeded`);
    return sharp(Buffer.from(pixels), { raw: { width, height, channels } }).png().toBuffer();
  }

  // Pass 2: pink didn't work — detect actual bg color from corners and remove it
  console.log(`[Chroma Key] Pink pass removed <10%, falling back to corner-sample detection...`);

  // Re-read raw pixels (undo the few pink removals)
  const { data: data2 } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = new Uint8Array(data2);

  // Sample the four corners (5x5 pixel blocks) to find the dominant background color
  const cornerSamples: { r: number; g: number; b: number }[] = [];
  const sampleSize = 5;
  const corners = [
    [0, 0], [width - sampleSize, 0],
    [0, height - sampleSize], [width - sampleSize, height - sampleSize],
  ];
  for (const [cx, cy] of corners) {
    for (let dy = 0; dy < sampleSize; dy++) {
      for (let dx = 0; dx < sampleSize; dx++) {
        const idx = ((cy + dy) * width + (cx + dx)) * channels;
        cornerSamples.push({ r: px[idx], g: px[idx + 1], b: px[idx + 2] });
      }
    }
  }

  // Average the corner samples to get the background color
  const avgR = Math.round(cornerSamples.reduce((s, c) => s + c.r, 0) / cornerSamples.length);
  const avgG = Math.round(cornerSamples.reduce((s, c) => s + c.g, 0) / cornerSamples.length);
  const avgB = Math.round(cornerSamples.reduce((s, c) => s + c.b, 0) / cornerSamples.length);
  console.log(`[Chroma Key] Detected corner bg color: rgb(${avgR},${avgG},${avgB})`);

  // Remove all pixels matching the detected background color (with tolerance)
  let fallbackRemoved = 0;
  const bgTolerance = 45;
  for (let i = 0; i < px.length; i += channels) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const dist = Math.abs(r - avgR) + Math.abs(g - avgG) + Math.abs(b - avgB);
    if (dist <= bgTolerance) {
      px[i + 3] = 0;
      fallbackRemoved++;
    }
  }

  const fallbackPct = (fallbackRemoved / total) * 100;
  const elapsed = Date.now() - startTime;
  console.log(`[Chroma Key] Fallback pass: removed ${fallbackRemoved}/${total} (${fallbackPct.toFixed(1)}%) in ${elapsed}ms`);

  return sharp(Buffer.from(px), { raw: { width, height, channels } }).png().toBuffer();
}

/**
 * Legacy pixel-based background removal for white/dark backgrounds.
 * Used as fallback when chroma key is not applicable.
 */
async function removeBackgroundFallback(buffer: Buffer, isDarkBackground: boolean = false): Promise<Buffer> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  
  const width = info.width;
  const height = info.height;
  const pixels = new Uint8Array(data);
  const totalPixels = width * height;
  
  // Thresholds for white background (luminance >= 245, low chroma)
  // Thresholds for dark background (luminance <= 60, low chroma)
  const LIGHT_LUMINANCE_THRESHOLD = 245;
  const DARK_LUMINANCE_THRESHOLD = 60;
  const MAX_CHROMA = 8;
  
  let pixelsRemoved = 0;
  
  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    const a = pixels[idx + 3];
    
    if (a === 0) continue;
    
    const luminance = (r + g + b) / 3;
    const maxRGB = Math.max(r, g, b);
    const minRGB = Math.min(r, g, b);
    const chromaDistance = maxRGB - minRGB;
    
    const shouldRemove = isDarkBackground
      ? (luminance <= DARK_LUMINANCE_THRESHOLD && chromaDistance <= MAX_CHROMA)
      : (luminance >= LIGHT_LUMINANCE_THRESHOLD && chromaDistance <= MAX_CHROMA);
    
    if (shouldRemove) {
      pixels[idx + 3] = 0;
      pixelsRemoved++;
    }
  }
  
  console.log(`Fallback background removal (${isDarkBackground ? 'dark' : 'light'}): removed ${pixelsRemoved} pixels (${(pixelsRemoved / totalPixels * 100).toFixed(1)}%)`);
  
  return sharp(Buffer.from(pixels), {
    raw: { width, height, channels: 4 }
  })
    .png()
    .toBuffer();
}

/**
 * Determines whether a product should be printed double-sided.
 * Checks both the stored doubleSidedPrint flag AND the placeholderPositions
 * (in case the product was imported before the flag was auto-detected).
 * Apparel is always front-only regardless.
 */
function resolveDoubleSided(productType: any): boolean {
  if (productType.designerType === "apparel") return false;
  if (productType.doubleSidedPrint) return true;
  // Defensive fallback: check if a "back" placeholder exists in stored positions
  try {
    const positions: { position: string }[] = typeof productType.placeholderPositions === "string"
      ? JSON.parse(productType.placeholderPositions || "[]")
      : (productType.placeholderPositions || []);
    return positions.some((p) => p.position === "back");
  } catch {
    return false;
  }
}

/**
 * Detect wrap-around products: double-sided products whose "front" placeholder
 * is significantly wider than tall (ratio > 1.5), indicating a single continuous
 * wrap area (e.g. pillows) rather than separate front/back print areas.
 * For these, we duplicate the artwork side-by-side to fill the full wrap.
 */
function resolveWrapAround(productType: any): boolean {
  if (productType.designerType === "apparel") return false;
  if (!resolveDoubleSided(productType)) return false;
  try {
    const positions: { position: string; width?: number; height?: number }[] =
      typeof productType.placeholderPositions === "string"
        ? JSON.parse(productType.placeholderPositions || "[]")
        : (productType.placeholderPositions || []);
    // If there's a "back" placeholder with its own dimensions, it's truly separate front/back
    const hasBackWithDims = positions.some(
      (p) => p.position === "back" && p.width && p.height && p.width > 0 && p.height > 0
    );
    if (hasBackWithDims) return false;
    // Check if "front" placeholder is wider than tall (wrap-around)
    const front = positions.find((p) => p.position === "front" || p.position === "default");
    if (front && front.width && front.height) {
      const ratio = front.width / front.height;
      if (ratio > 1.5) {
        console.log(`[resolveWrapAround] Detected wrap-around: front placeholder ${front.width}x${front.height} ratio=${ratio.toFixed(2)}`);
        return true;
      }
    }
    // Fallback: if doubleSidedPrint=true but no back placeholder exists at all, it's likely wrap-around
    const hasBack = positions.some((p) => p.position === "back");
    if (!hasBack && positions.length > 0) {
      console.log(`[resolveWrapAround] Detected wrap-around: doubleSided=true but no back placeholder`);
      return true;
    }
    // Extra fallback: check stored aspectRatio — if wider than tall (e.g. "2:1"), it's wrap-around
    if (positions.length === 0 && productType.aspectRatio) {
      const parts = String(productType.aspectRatio).split(":").map(Number);
      if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
        const ratio = parts[0] / parts[1];
        if (ratio > 1.5) {
          console.log(`[resolveWrapAround] Detected wrap-around from aspectRatio=${productType.aspectRatio} (ratio=${ratio.toFixed(2)})`);
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Determine the wrap direction for wrap-around products.
 * If the front placeholder is wider than tall (ratio > 1.5), wrap horizontally (side-by-side).
 * If the front placeholder is taller than wide (ratio < 0.67), wrap vertically (top-to-bottom).
 * For square-ish placeholders, default to horizontal.
 */
function resolveWrapDirection(productType: any): 'horizontal' | 'vertical' {
  try {
    const positions: { position: string; width?: number; height?: number }[] =
      typeof productType.placeholderPositions === "string"
        ? JSON.parse(productType.placeholderPositions || "[]")
        : (productType.placeholderPositions || []);
    const front = positions.find((p) => p.position === "front" || p.position === "default");
    if (front && front.width && front.height) {
      const ratio = front.width / front.height;
      if (ratio < 0.67) {
        console.log(`[resolveWrapDirection] Vertical wrap: front placeholder ${front.width}x${front.height} ratio=${ratio.toFixed(2)}`);
        return 'vertical';
      }
    }
    // Also check aspect ratio as fallback
    if (positions.length === 0 && productType.aspectRatio) {
      const parts = String(productType.aspectRatio).split(":").map(Number);
      if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
        const ratio = parts[0] / parts[1];
        if (ratio < 0.67) {
          console.log(`[resolveWrapDirection] Vertical wrap from aspectRatio=${productType.aspectRatio}`);
          return 'vertical';
        }
      }
    }
    return 'horizontal';
  } catch {
    return 'horizontal';
  }
}

interface SaveImageOptions {
  isApparel?: boolean;
  isAllOverPrint?: boolean;
  targetDims?: TargetDimensions;
  colorTier?: ColorTier;
}

async function saveImageToStorage(base64Data: string, mimeType: string, options?: SaveImageOptions): Promise<SaveImageResult> {
  const { isApparel = false, isAllOverPrint = false, targetDims } = options || {};
  const imageId = crypto.randomUUID();
  let actualMimeType = mimeType.toLowerCase();
  let extension = actualMimeType.includes("png") ? "png" : "jpg";

  let buffer: Buffer = Buffer.from(base64Data, "base64");

  // For apparel, remove background using Picsart — including AOP
  // This ensures the motif is clean before tiling or placement
  if (isApparel) {
    console.log(`[saveImageToStorage] Removing background for apparel (AOP=${isAllOverPrint})...`);
    try {
      // 1. Upload temporary file to Supabase to get a public URL for Picsart
      const tempImageId = `temp_${crypto.randomUUID()}`;
      const tempFilename = `${tempImageId}.${extension}`;
      const tempUrl = await uploadDesignFileToSupabase({
        buffer,
        filename: tempFilename,
        contentType: actualMimeType,
      });

      if (tempUrl) {
        // 2. Call remove.bg
        const removeBgResult = await removeBackground({ imageUrl: tempUrl });
        
        // 3. Handle result — remove.bg returns a data URL directly
        if (removeBgResult.url.startsWith("data:")) {
          const base64Data = removeBgResult.url.split(",")[1];
          buffer = Buffer.from(base64Data, "base64");
          extension = "png";
          actualMimeType = "image/png";
          console.log("[saveImageToStorage] remove.bg background removal successful");
        } else {
          // Legacy URL format fallback
          const response = await fetch(removeBgResult.url);
          if (response.ok) {
            buffer = Buffer.from(await response.arrayBuffer());
            extension = "png";
            actualMimeType = "image/png";
            console.log("[saveImageToStorage] remove.bg background removal successful (URL)");
          } else {
            throw new Error(`Failed to download remove.bg result: ${response.statusText}`);
          }
        }
      }
    } catch (err) {
      console.error("[saveImageToStorage] remove.bg failed, falling back to chroma key:", (err as Error).message);
      // Fallback to chroma key if Picsart fails (only for non-AOP)
      if (!isAllOverPrint) {
        buffer = await removeChromaKeyBackground(buffer);
        extension = "png";
        actualMimeType = "image/png";
      }
    }
  } else if (targetDims && targetDims.width !== targetDims.height) {
    const outputFormat =
      actualMimeType.includes("jpeg") || actualMimeType.includes("jpg")
        ? "jpeg"
        : "png";
    buffer = (await resizeToAspectRatio(buffer, targetDims, outputFormat)) as Buffer;
    extension = outputFormat === "jpeg" ? "jpg" : "png";
    actualMimeType = outputFormat === "jpeg" ? "image/jpeg" : "image/png";
  }

  const filename = `${imageId}.${extension}`;
  const thumbnailBuffer = await generateThumbnail(buffer);

  // Prefer Supabase Storage when configured (persists across Railway redeploys)
  if (isSupabaseDesignsConfigured()) {
    try {
      const result = await uploadDesignToSupabase({
        imageBuffer: buffer,
        thumbnailBuffer,
        imageId,
        extension: extension as "png" | "jpg",
      });
      if (result) return result;
    } catch (err) {
      console.warn("[saveImageToStorage] Supabase upload failed, falling back to local:", (err as Error).message);
    }
  }

  // Local fallback (ephemeral on Railway unless STORAGE_DIR points to a volume)
  const storageDir = getStorageDir();
  const designsDir = path.join(storageDir, "designs");
  await fs.promises.mkdir(designsDir, { recursive: true });
  const thumbFilename = `thumb_${imageId}.jpg`;
  await fs.promises.writeFile(path.join(designsDir, filename), buffer);
  await fs.promises.writeFile(path.join(designsDir, thumbFilename), thumbnailBuffer);

  return {
    imageUrl: `/objects/designs/${filename}`,
    thumbnailUrl: `/objects/designs/${thumbFilename}`,
  };
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<globalThis.Response> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const delay = retryAfter 
          ? parseInt(retryAfter) * 1000 
          : baseDelay * Math.pow(2, attempt);
        
        if (attempt < maxRetries) {
          console.log(`Rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
      
      return response;
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`Fetch error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}):`, error);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError || new Error('Max retries exceeded');
}

/** Shopify Admin GraphQL helper — supports selecting API version (menus need 2024-07+) */
async function shopifyGraphQL(
  shop: string,
  accessToken: string,
  query: string,
  variables: Record<string, any> = {},
  apiVersion = "2024-07",
): Promise<any> {
  const res = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Shopify GraphQL HTTP ${res.status}: ${text}`);
  }
  const body = await res.json();
  // Check for top-level GraphQL errors (validation failures, type mismatches, etc.).
  // These are different from userErrors — they mean the mutation never executed at all.
  // Without this check, callers that only inspect `data.*.userErrors` would silently
  // report success when the entire operation was rejected.
  if (body.errors?.length && !body.data) {
    const msgs = body.errors.map((e: any) => e.message).join("; ");
    console.error(`[shopifyGraphQL] Top-level GraphQL errors for ${shop}: ${msgs}`);
    throw new Error(`Shopify GraphQL error: ${msgs}`);
  }
  return body;
}

/**
 * Fetches the full main-menu with nested items (up to 2 levels deep).
 */
async function getMainMenu(shop: string, accessToken: string): Promise<any | null> {
  // Fetch all menus and pick the best one:
  // Priority: handle contains "main", then the menu with the most items, then first result.
  const queryRes = await shopifyGraphQL(shop, accessToken, `
    query GetMenus {
      menus(first: 20) {
        nodes {
          id
          title
          handle
          items {
            id
            title
            type
            url
            resourceId
            items {
              id
              title
              type
              url
              resourceId
            }
          }
        }
      }
    }
  `, {});
  console.log(`[nav] getMainMenu raw response: ${JSON.stringify(queryRes?.data)} errors=${JSON.stringify(queryRes?.errors)}`);
  // If Shopify returned ACCESS_DENIED, the token is missing read_online_store_navigation.
  // Throw immediately so ensureNavigationLink returns a proper warning instead of
  // silently falling through and creating an orphan menu.
  const accessDenied = (queryRes?.errors ?? []).some(
    (e: any) => e?.extensions?.code === "ACCESS_DENIED"
  );
  if (accessDenied) {
    throw new Error(
      "Navigation scope missing: the app needs to be reinstalled to grant " +
      "read_online_store_navigation permission. Visit /shopify/reinstall?shop=" +
      shop + " to fix this."
    );
  }
  const menus: any[] = queryRes?.data?.menus?.nodes ?? [];
  if (menus.length > 0) {
    // Prefer a menu whose handle contains "main"
    const mainMenu = menus.find((m: any) => m.handle?.includes("main"));
    if (mainMenu) return mainMenu;
    // Fallback: pick the menu with the most top-level items
    return menus.reduce((best: any, m: any) =>
      (m.items?.length ?? 0) > (best.items?.length ?? 0) ? m : best
    , menus[0]);
  }
  // Fallback: menus query failed or returned empty — try fetching by common handles
  console.log(`[nav] menus query returned empty, falling back to handle-based lookup`);
  const MENU_ITEM_FRAGMENT = `
    id title type url resourceId
    items { id title type url resourceId }
  `;
  const handles = ["main-menu", "main", "header-menu", "header", "customizer"];
  for (const handle of handles) {
    const fallbackRes = await shopifyGraphQL(shop, accessToken, `
      query GetMenu($handle: String!) {
        menu(handle: $handle) {
          id title handle
          items { ${MENU_ITEM_FRAGMENT} }
        }
      }
    `, { handle });
    const m = fallbackRes?.data?.menu;
    if (m?.id) {
      console.log(`[nav] Found menu via handle fallback: handle="${handle}" id=${m.id}`);
      return m;
    }
  }
  return null;
}

/**
 * Converts a menu item (with optional nested items) to a MenuItemCreateInput shape.
 * Used when rebuilding the full menu tree for menuUpdate.
 * Preserves the original item type (FRONTPAGE, CATALOG, PAGE, etc.) so existing
 * menu items are not corrupted when we rebuild the tree.
 */
function menuItemToInput(item: any): any {
  const input: any = { title: item.title };

  // type is REQUIRED (non-null) in MenuItemUpdateInput — must always be provided.
  // Types that don't need a resource reference:
  const STANDALONE_TYPES = new Set(["FRONTPAGE", "CATALOG", "HTTP", "SEARCH", "COLLECTIONS"]);
  const itemType: string = item.type ?? "HTTP";

  if (item.id) {
    input.id = item.id;
  }

  if (STANDALONE_TYPES.has(itemType)) {
    // These types work without resourceId. HTTP needs url; others are implicit.
    input.type = itemType;
    if (itemType === "HTTP" && item.url) {
      input.url = item.url;
    } else if (itemType === "HTTP") {
      input.url = item.url ?? "/";
    }
    // FRONTPAGE, CATALOG, SEARCH, COLLECTIONS don't need url or resourceId
  } else if (item.resourceId) {
    // Resource-based type (PAGE, COLLECTION, PRODUCT, BLOG, ARTICLE, etc.)
    // with a valid resourceId — preserve the original type.
    input.type = itemType;
    input.resourceId = item.resourceId;
  } else {
    // Resource-based type but missing resourceId — fall back to HTTP with url
    // to avoid "Subject can't be blank" errors.
    input.type = "HTTP";
    input.url = item.url ?? "/";
  }

  if (item.items && item.items.length > 0) {
    input.items = item.items.map(menuItemToInput);
  }
  return input;
}

/**
 * Finds the parent menu item that "owns" our customizer pages.
 * Detection strategy (rename-proof):
 *   1. Look for any top-level item whose children contain at least one URL
 *      matching a known customizer page handle (/pages/<handle>).
 *   2. Fall back to title === "Customizer" only when no URL match is found
 *      (e.g., the very first page being added).
 */
async function findCustomizerParent(
  menuItems: any[],
  knownHandles: string[],
): Promise<any | null> {
  // Strategy 1: find by child URL matching a known handle
  for (const item of menuItems) {
    if (!item.items?.length) continue;
    const hasKnownChild = item.items.some((sub: any) =>
      knownHandles.some(h => sub.url === `/pages/${h}` || sub.url?.endsWith(`/pages/${h}`))
    );
    if (hasKnownChild) return item;
  }
  // Strategy 2: fall back to title match
  return menuItems.find((item: any) => item.title === "Customizer") ?? null;
}

/**
 * Ensures a customizer page exists as a sub-item under the app's Customizer
 * parent in the main-menu. Creates the "Customizer" parent if it doesn't exist.
 * Parent detection is URL-based (rename-proof) — falls back to title only on
 * first publish when no children exist yet.
 * Idempotent — skips if the sub-item already exists.
 */
async function ensureNavigationLink(
  shop: string,
  accessToken: string,
  pageHandle: string,
  pageTitle: string,
): Promise<{ added: boolean; warning?: string }> {
  const targetUrl = `/pages/${pageHandle}`;
  const PARENT_LABEL = "Customizer";

  try {
    const menu = await getMainMenu(shop, accessToken);
    console.log(`[nav] getMainMenu result for ${shop}: id=${menu?.id} title="${menu?.title}" itemCount=${menu?.items?.length ?? 0}`);

    if (!menu?.id) {
      // No main-menu at all — create one with the Customizer parent + sub-item
      const createRes = await shopifyGraphQL(shop, accessToken, `
        mutation CreateMenu($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
          menuCreate(title: $title, handle: $handle, items: $items) {
            menu { id }
            userErrors { field message }
          }
        }
      `, {
        title: "Main menu",
        handle: "main-menu",
        items: [{
          title: PARENT_LABEL,
          type: "HTTP",
          url: "/",
          items: [{ title: pageTitle, type: "HTTP", url: targetUrl }],
        }],
      });
      const errs = createRes?.data?.menuCreate?.userErrors ?? [];
      if (errs.length > 0) {
        const msg = errs.map((e: any) => e.message).join("; ");
        console.warn(`[nav] menuCreate userErrors: ${msg}`);
        return { added: false, warning: msg };
      }
      console.log(`[nav] Created main-menu with Customizer > "${pageTitle}" for ${shop}`);
      return { added: true };
    }

    // Fetch all known customizer page handles for this shop to enable URL-based detection
    const knownPages = await storage.listCustomizerPages(shop);
    const knownHandles = knownPages.map((p: any) => p.handle);

    // Find the parent item (rename-proof: URL-based, falls back to title)
    const customizerParent = await findCustomizerParent(menu.items ?? [], knownHandles);

    if (customizerParent) {
      // Check if the sub-item already exists (by URL)
      const alreadyExists = (customizerParent.items ?? []).some(
        (sub: any) => sub.url === targetUrl || sub.url?.endsWith(targetUrl)
      );
      if (alreadyExists) {
        console.log(`[nav] Sub-item ${targetUrl} already exists under "${customizerParent.title}"`);
        return { added: false };
      }

      // Add the new sub-item — rebuild full menu tree.
      // IMPORTANT: The parent item MUST be type HTTP to support children (dropdown).
      // Shopify silently ignores children on resource-based types (PAGE, FRONTPAGE, etc.)
      // and also ignores type changes on existing items (when id is provided).
      // So if the parent is not already HTTP, we must REPLACE it: omit the id so Shopify
      // deletes the old resource-based item and creates a fresh HTTP item with children.
      const parentIsHTTP = customizerParent.type === "HTTP";
      const newMenuItems = (menu.items ?? []).map((item: any) => {
        if (item.id === customizerParent.id) {
          const parentInput: any = {
            title: item.title,
            type: "HTTP",
            url: item.url ?? "/",
            items: [
              ...(item.items ?? []).map(menuItemToInput),
              { title: pageTitle, type: "HTTP", url: targetUrl },
            ],
          };
          // Only keep the id if the item is already HTTP (so Shopify updates in-place).
          // For non-HTTP items (PAGE, FRONTPAGE, etc.), omit id to replace the item.
          if (parentIsHTTP) parentInput.id = item.id;
          return parentInput;
        }
        return menuItemToInput(item);
      });

      console.log(`[nav] Sending menuUpdate (add sub-item) for ${shop}: menuId=${menu.id} title="${menu.title}" items=${JSON.stringify(newMenuItems)}`);
      const updateRes = await shopifyGraphQL(shop, accessToken, `
        mutation UpdateMenu($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
          menuUpdate(id: $id, title: $title, items: $items) {
            menu { id }
            userErrors { field message }
          }
        }
      `, { id: menu.id, title: menu.title, items: newMenuItems });
      console.log(`[nav] menuUpdate response (add sub-item): ${JSON.stringify(updateRes?.data)}`);

      const userErrors = updateRes?.data?.menuUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        const msg = userErrors.map((e: any) => e.message).join("; ");
        console.warn(`[nav] menuUpdate userErrors: ${msg}`);
        return { added: false, warning: msg };
      }

      console.log(`[nav] Added "${pageTitle}" under "${customizerParent.title}" in main-menu for ${shop}`);
      return { added: true };
    } else {
      // No parent found — create the "Customizer" parent with the sub-item
      const existingItems = (menu.items ?? []).map(menuItemToInput);
      const newMenuItems = [
        ...existingItems,
        {
          title: PARENT_LABEL,
          type: "HTTP",
          url: "/",
          items: [{ title: pageTitle, type: "HTTP", url: targetUrl }],
        },
      ];

      console.log(`[nav] Sending menuUpdate (create Customizer parent) for ${shop}: menuId=${menu.id} title="${menu.title}" items=${JSON.stringify(newMenuItems)}`);
      const updateRes = await shopifyGraphQL(shop, accessToken, `
        mutation UpdateMenu($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
          menuUpdate(id: $id, title: $title, items: $items) {
            menu { id }
            userErrors { field message }
          }
        }
      `, { id: menu.id, title: menu.title, items: newMenuItems });
      console.log(`[nav] menuUpdate response (create parent): ${JSON.stringify(updateRes?.data)}`);

      const userErrors = updateRes?.data?.menuUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        const msg = userErrors.map((e: any) => e.message).join("; ");
        console.warn(`[nav] menuUpdate userErrors: ${msg}`);
        return { added: false, warning: msg };
      }

      console.log(`[nav] Created Customizer parent with "${pageTitle}" sub-item in main-menu for ${shop}`);
      return { added: true };
    }
  } catch (err: any) {
    console.warn(`[nav] ensureNavigationLink failed for ${shop}: ${err.message}`);
    return { added: false, warning: err.message };
  }
}

/**
 * Removes a customizer page sub-item from the app's Customizer parent in main-menu.
 * Parent detection is URL-based (rename-proof).
 * If removing the sub-item leaves the parent empty, removes the parent too.
 * Idempotent — does nothing if the item doesn't exist.
 */
async function removeNavigationLink(
  shop: string,
  accessToken: string,
  pageHandle: string,
): Promise<{ removed: boolean; warning?: string }> {
  const targetUrl = `/pages/${pageHandle}`;

  try {
    const menu = await getMainMenu(shop, accessToken);
    if (!menu?.id) return { removed: false };

    // Fetch all known handles (excluding the one being removed) for URL-based detection
    const knownPages = await storage.listCustomizerPages(shop);
    const knownHandles = knownPages
      .map((p: any) => p.handle)
      .filter((h: string) => h !== pageHandle);

    // Find the parent — use all known handles plus the one being removed for detection
    const allHandles = [...knownHandles, pageHandle];
    const customizerParent = await findCustomizerParent(menu.items ?? [], allHandles);
    if (!customizerParent) return { removed: false };

    const subItemExists = (customizerParent.items ?? []).some(
      (sub: any) => sub.url === targetUrl || sub.url?.endsWith(targetUrl)
    );
    if (!subItemExists) return { removed: false };

    // Filter out the sub-item
    const remainingSubItems = (customizerParent.items ?? []).filter(
      (sub: any) => sub.url !== targetUrl && !sub.url?.endsWith(targetUrl)
    );

    // Rebuild the full menu tree
    let newMenuItems: any[];
    if (remainingSubItems.length === 0) {
      // Remove the parent entirely — no more customizer sub-items
      newMenuItems = (menu.items ?? [])
        .filter((item: any) => item.id !== customizerParent.id)
        .map(menuItemToInput);
      console.log(`[nav] Removed "${customizerParent.title}" parent (empty) from menu for ${shop}`);
    } else {
      // Keep the parent with the remaining sub-items (preserve any rename)
      newMenuItems = (menu.items ?? []).map((item: any) => {
        if (item.id === customizerParent.id) {
          return {
            title: item.title,
            type: "HTTP",
            url: item.url ?? "/",
            items: remainingSubItems.map(menuItemToInput),
          };
        }
        return menuItemToInput(item);
      });
      console.log(`[nav] Removed "${pageHandle}" sub-item from "${customizerParent.title}" in main-menu for ${shop}`);
    }

    const updateRes = await shopifyGraphQL(shop, accessToken, `
      mutation UpdateMenu($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
        menuUpdate(id: $id, title: $title, items: $items) {
          menu { id }
          userErrors { field message }
        }
      }
    `, { id: menu.id, title: menu.title, items: newMenuItems });

    const userErrors = updateRes?.data?.menuUpdate?.userErrors ?? [];
    if (userErrors.length > 0) {
      const msg = userErrors.map((e: any) => e.message).join("; ");
      console.warn(`[nav] removeNavigationLink menuUpdate userErrors: ${msg}`);
      return { removed: false, warning: msg };
    }

    return { removed: true };
  } catch (err: any) {
    console.warn(`[nav] removeNavigationLink failed for ${shop}: ${err.message}`);
    return { removed: false, warning: err.message };
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Track server start time and DB readiness
  const serverStartTime = Date.now();
  let dbReady = false;

  // Stripe Webhook to handle successful payments (must be registered before other body parsers)
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req: Request, res: Response) => {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!stripe || !sig || !webhookSecret) {
      console.error("[Stripe Webhook] Error: Missing configuration", { hasStripe: !!stripe, hasSig: !!sig, hasSecret: !!webhookSecret });
      return res.status(400).send("Webhook Error: Missing configuration");
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err: any) {
      console.error(`[Stripe Webhook] Error: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const { customerId, creditsToAdd } = session.metadata || {};

      if (customerId && creditsToAdd) {
        const customer = await storage.getCustomer(customerId);
        if (customer) {
          const amount = parseInt(creditsToAdd);
          const priceInCents = session.amount_total || 0;
          
          // Update customer
          const newCredits = customer.credits + amount;
          const newTotalSpent = parseFloat(customer.totalSpent) + (priceInCents / 100);
          
          await storage.updateCustomer(customer.id, {
            credits: newCredits,
            totalSpent: newTotalSpent.toFixed(2),
          });

          // Log transaction
          await storage.createCreditTransaction({
            customerId: customer.id,
            type: "purchase",
            amount,
            priceInCents,
            description: `Purchased ${amount} credits via Stripe`,
          });

          console.log(`[Stripe Webhook] Credited ${amount} to customer ${customerId}`);
        }
      }
    }

    res.json({ received: true });
  });

  // In-memory cache for /api/config — avoids a DB hit on every storefront page load.
  // Style presets change only when a merchant edits them (rare), so 5 minutes is safe.
  interface ConfigCacheEntry { data: object; expiresAt: number; }
  const configCache = new Map<string, ConfigCacheEntry>();
  const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Test DB connection asynchronously (non-blocking).
  // Uses a dedicated fresh pg.Client (not the shared pool) so a failed attempt
  // never leaves a dangling checked-out connection that exhausts the pool.
  (async () => {
    const maxAttempts = 20;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const testClient = new pg.Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 6000,
        statement_timeout: 5000,
      });
      try {
        await testClient.connect();
        await testClient.query("SELECT 1");
        await testClient.end();
        dbReady = true;
        console.log(`[Health] Database ready after ${Date.now() - serverStartTime}ms (attempt ${attempt})`);
        // Pre-warm the shared pool: acquire and release several connections so they
        // are alive and idle when the first real requests arrive. Without this, the
        // first few requests hit cold/dead pool connections and time out.
        try {
          const warmupCount = Math.min(5, pool.options.max || 5);
          const warmupClients = await Promise.all(
            Array.from({ length: warmupCount }, () => pool.connect())
          );
          warmupClients.forEach(c => c.release());
          console.log(`[Health] Pool pre-warmed with ${warmupCount} connections`);
          // Keep-alive ping every 25s to prevent Railway's ~30s TCP idle timeout
          // from silently terminating pool connections.
          setInterval(async () => {
            try {
              const c = await pool.connect();
              await c.query("SELECT 1");
              c.release();
            } catch (_) { /* non-fatal */ }
          }, 25000);
        } catch (warmupErr: any) {
          console.warn(`[Health] Pool pre-warm failed (non-fatal): ${warmupErr?.message}`);
        }
        return;
      } catch (err: any) {
        try { await testClient.end(); } catch (_) { /* ignore */ }
        console.error(`[Health] Database connection test failed (attempt ${attempt}/${maxAttempts}): ${err?.message ?? err}`);
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    console.error("[Health] Database never became ready after all retries — some routes may be degraded");
  })();

  // Storefront request logging middleware
  app.use("/api/storefront", (req: Request, res: Response, next) => {
    const startTime = Date.now();
    const requestId = crypto.randomBytes(4).toString("hex");

    console.log(`[Storefront ${requestId}] ${req.method} ${req.originalUrl} - started`);

    // Log when response finishes
    res.on("finish", () => {
      const duration = Date.now() - startTime;
      console.log(`[Storefront ${requestId}] ${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
    });

    next();
  });

  // Health check - always responds fast, shows DB status
  app.get("/api/health", (_req: Request, res: Response) => {
    const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
    res.json({
      ok: true,
      uptime,
      dbReady,
      timestamp: new Date().toISOString(),
      version: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || "dev"
    });
  });

  // ── Diagnostic: test nav menus query with different API versions ──
  app.get("/api/appai/debug/nav-test", async (req: Request, res: Response) => {
    const shop = (req.query.shop as string) || "appai-2.myshopify.com";
    const installation = await storage.getShopifyInstallationByShop(shop);
    if (!installation?.accessToken) {
      return res.json({ error: "No installation or token found", shop });
    }
    const results: any = { shop, storedScope: installation.scope, tests: [] };
    const versions = ["2024-07", "2024-10", "2025-01", "2025-04", "2025-10"];
    for (const ver of versions) {
      try {
        const gqlRes = await fetch(`https://${shop}/admin/api/${ver}/graphql.json`, {
          method: "POST",
          headers: { "X-Shopify-Access-Token": installation.accessToken, "Content-Type": "application/json" },
          body: JSON.stringify({ query: `query { menus(first: 5) { nodes { id title handle } } }` }),
        });
        const body = await gqlRes.json();
        results.tests.push({ apiVersion: ver, httpStatus: gqlRes.status, data: body.data, errors: body.errors });
      } catch (err: any) {
        results.tests.push({ apiVersion: ver, error: err.message });
      }
    }
    // Query the app's actual granted scopes via GraphQL
    try {
      const scopeRes = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": installation.accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({ query: `query { currentAppInstallation { accessScopes { handle } } }` }),
      });
      const scopeBody = await scopeRes.json();
      results.actualScopes = scopeBody.data?.currentAppInstallation?.accessScopes?.map((s: any) => s.handle) ?? [];
      results.scopeErrors = scopeBody.errors;
    } catch (err: any) {
      results.scopeError = err.message;
    }
    // Test the actual getMainMenu function used by ensureNavigationLink
    try {
      const menu = await getMainMenu(shop, installation.accessToken);
      results.getMainMenuResult = {
        id: menu?.id,
        title: menu?.title,
        handle: menu?.handle,
        itemCount: menu?.items?.length ?? 0,
        items: (menu?.items ?? []).map((i: any) => ({
          id: i.id, title: i.title, type: i.type, url: i.url,
          children: (i.items ?? []).map((c: any) => ({ title: c.title, url: c.url }))
        })),
      };
    } catch (err: any) {
      results.getMainMenuError = err.message;
    }
    // Dry-run ensureNavigationLink (test handle or custom handle/title)
    if (req.query.dryrun === "true") {
      const testHandle = (req.query.handle as string) || "__nav-test-page__";
      const testTitle = (req.query.title as string) || "Nav Test Page";
      const cleanup = req.query.cleanup !== "false"; // default: cleanup after test
      try {
        const navResult = await ensureNavigationLink(shop, installation.accessToken, testHandle, testTitle);
        results.ensureNavResult = navResult;
        if (cleanup && testHandle === "__nav-test-page__") {
          await removeNavigationLink(shop, installation.accessToken, testHandle);
          results.cleanedUp = true;
        }
      } catch (err: any) {
        results.ensureNavError = err.message;
      }
      // Re-read the menu AFTER the mutation to see if it actually changed
      try {
        const menuAfter = await getMainMenu(shop, installation.accessToken);
        results.menuAfterMutation = {
          id: menuAfter?.id,
          title: menuAfter?.title,
          itemCount: menuAfter?.items?.length ?? 0,
          items: (menuAfter?.items ?? []).map((i: any) => ({
            id: i.id, title: i.title, type: i.type, url: i.url,
            children: (i.items ?? []).map((c: any) => ({ id: c.id, title: c.title, type: c.type, url: c.url }))
          })),
        };
      } catch (err: any) {
        results.menuAfterError = err.message;
      }
    }
    // Direct mutation test: manually build and send the menuUpdate to capture full response
    if (req.query.directtest === "true") {
      try {
        const menu = await getMainMenu(shop, installation.accessToken);
        const testHandle = (req.query.handle as string) || "__direct-test__";
        const testTitle = (req.query.title as string) || "Direct Test";
        const targetUrl = `/pages/${testHandle}`;
        // Build items array: keep existing items by id, add new Customizer parent with child
        // First, remove any existing Customizer item
        const otherItems = (menu?.items ?? []).filter((i: any) => i.title !== "Customizer").map(menuItemToInput);
        const newItems = [
          ...otherItems,
          {
            title: "Customizer",
            type: "HTTP",
            url: "/",
            items: [{ title: testTitle, type: "HTTP", url: targetUrl }],
          },
        ];
        results.directMutationInput = { id: menu?.id, title: menu?.title, items: newItems };
        const mutRes = await shopifyGraphQL(shop, installation.accessToken, `
          mutation UpdateMenu($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
            menuUpdate(id: $id, title: $title, items: $items) {
              menu {
                id
                title
                items {
                  id title type url
                  items {
                    id title type url
                  }
                }
              }
              userErrors { field message code }
            }
          }
        `, { id: menu?.id, title: menu?.title, items: newItems });
        results.directMutationResponse = mutRes;
      } catch (err: any) {
        results.directMutationError = err.message;
      }
    }
    // Test removeNavigationLink
    if (req.query.removetest === "true") {
      const removeHandle = (req.query.handle as string) || "__remove-test__";
      try {
        const removeResult = await removeNavigationLink(shop, installation.accessToken, removeHandle);
        results.removeResult = removeResult;
      } catch (err: any) {
        results.removeError = err.message;
      }
      // Re-read menu after removal
      try {
        const menuAfterRemove = await getMainMenu(shop, installation.accessToken);
        results.menuAfterRemove = {
          id: menuAfterRemove?.id,
          title: menuAfterRemove?.title,
          itemCount: menuAfterRemove?.items?.length ?? 0,
          items: (menuAfterRemove?.items ?? []).map((i: any) => ({
            id: i.id, title: i.title, type: i.type, url: i.url,
            children: (i.items ?? []).map((c: any) => ({ id: c.id, title: c.title, type: c.type, url: c.url }))
          })),
        };
      } catch (err: any) {
        results.menuAfterRemoveError = err.message;
      }
    }
    res.json(results);
  });

  // Ready check - returns 503 if DB not ready
  app.get("/api/ready", async (_req: Request, res: Response) => {
    if (!dbReady) {
      res.set('Retry-After', '2');
      return res.status(503).json({
        ok: false,
        reason: "Database not ready",
        uptime: Math.floor((Date.now() - serverStartTime) / 1000)
      });
    }
    res.json({ ok: true, dbReady: true });
  });

  // ✅ Public: Get product configuration (MUST be before setupAuth)
  app.get("/api/config", async (_req: Request, res: Response) => {
    const t0 = Date.now();
    console.log("[CONFIG] HIT /api/config");

    // Allow Shopify CDN and browsers to cache; stale-while-revalidate means
    // clients serve cached data instantly while refreshing in the background.
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");

    const hardcodedFallback = STYLE_PRESETS.map((s) => ({
      id: s.id,
      name: s.name,
      promptSuffix: s.promptPrefix,
      category: s.category,
      promptPlaceholder: (s as any).promptPlaceholder,
      options: (s as any).options,
      baseImageUrl: (s as any).baseImageUrl,
      descriptionOptional: false,
    }));

    // ── Cache hit: respond immediately without touching the DB ──────────────
    const cacheKey = "global";
    const cached = configCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      console.log(`[CONFIG] cache hit, responded in ${Date.now() - t0}ms`);
      return res.json(cached.data);
    }

    console.log(`[CONFIG] cache miss, DB start +${Date.now() - t0}ms`);
    try {
      // 5s timeout — a slow DB query must not block the storefront generator
      const dbStyles = await Promise.race([
        storage.getAllActiveStylePresets(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("getAllActiveStylePresets DB timeout")), 5000)
        ),
      ]);

      console.log(`[CONFIG] DB done ${Date.now() - t0}ms, ${dbStyles.length} styles`);

      const stylePresets =
        dbStyles.length > 0
          ? dbStyles.map((s) => {
              // Merge options and baseImageUrl from hardcoded STYLE_PRESETS (DB doesn't store sub-options)
              // promptPlaceholder: prefer DB value (merchant-editable), fall back to hardcoded default
              const hardcoded = STYLE_PRESETS.find(h => h.id === s.id.toString() || h.name === s.name);
              // Prefer DB-stored options (merchant-edited) over hardcoded defaults
              const dbOptions = (s as any).options ?? null;
              const hardcodedOptions = (hardcoded as any)?.options ?? null;
              return {
                id: s.id.toString(),
                name: s.name,
                promptSuffix: s.promptPrefix,
                category: s.category || "all",
                promptPlaceholder: (s as any).promptPlaceholder || (hardcoded as any)?.promptPlaceholder,
                options: dbOptions || hardcodedOptions,
                baseImageUrl: (s as any).baseImageUrl || (hardcoded as any)?.baseImageUrl || undefined,
                descriptionOptional: !!(s as any).descriptionOptional,
              };
            })
          : hardcodedFallback;

      const payload = {
        sizes: PRINT_SIZES,
        frameColors: FRAME_COLORS,
        stylePresets,
        blueprintId: 540,
      };
      configCache.set(cacheKey, { data: payload, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
      console.log(`[CONFIG] responded in ${Date.now() - t0}ms (DB path)`);
      return res.json(payload);
    } catch (error) {
      console.error(`[CONFIG] DB error after ${Date.now() - t0}ms:`, error);

      // Return hardcoded fallback immediately so the storefront doesn't time out.
      // Cache the fallback too so subsequent requests don't hit the failing DB.
      const fallbackPayload = {
        sizes: PRINT_SIZES,
        frameColors: FRAME_COLORS,
        stylePresets: hardcodedFallback,
        blueprintId: 540,
      };
      configCache.set(cacheKey, { data: fallbackPayload, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
      console.log(`[CONFIG] responded in ${Date.now() - t0}ms (fallback path)`);
      return res.json(fallbackPayload);
    }
  });

  // 🔒 Everything below may register /api auth middleware
  await setupAuth(app);
  registerAuthRoutes(app);
  registerShopifyRoutes(app);
  registerObjectStorageRoutes(app);

  // ─────────────────────────────────────────────────────────────────────────
  // DEV-ONLY: list all product types for the storefront preview launcher.
  // Only active in development — never reachable in production.
  // ─────────────────────────────────────────────────────────────────────────
  if (process.env.NODE_ENV === "development") {
    app.get("/api/dev/product-types", async (_req: Request, res: Response) => {
      // Use a fresh client (not the shared pool) to avoid pool exhaustion issues in dev
      const client = new pg.Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 8000,
        statement_timeout: 8000,
        keepAlive: true,
      });
      try {
        await client.connect();
        const result = await client.query(
          "SELECT id, name, designer_type FROM product_types ORDER BY sort_order, id"
        );
        await client.end();
        return res.json(
          result.rows.map((pt: any) => ({
            id: pt.id,
            name: pt.name,
            designerType: pt.designer_type ?? null,
          }))
        );
      } catch (err: any) {
        try { await client.end(); } catch (_) { /* ignore */ }
        console.error("[dev/product-types] Error:", err);
        return res.status(500).json({ error: err?.message || String(err) });
      }
    });
    console.log("[dev] /api/dev/product-types endpoint registered");
  }

  // Get or create customer profile
  app.get("/api/customer", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      let customer = await storage.getCustomerByUserId(userId);
      
      if (!customer) {
        customer = await storage.createCustomer({
          userId,
          credits: 5,
          freeGenerationsUsed: 0,
          totalGenerations: 0,
          totalSpent: "0.00",
        });
      }
      
      res.json(customer);
    } catch (error) {
      console.error("Error fetching customer:", error);
      res.status(500).json({ error: "Failed to fetch customer" });
    }
  });

  // Get customer's designs (paginated)
  app.get("/api/designs", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const customer = await storage.getCustomerByUserId(userId);
      
      if (!customer) {
        return res.json({ designs: [], total: 0, hasMore: false });
      }
      
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 12;
      const offset = (page - 1) * limit;
      
      const { designs, total } = await storage.getDesignsByCustomerPaginated(customer.id, limit, offset);
      const hasMore = offset + designs.length < total;
      
      res.json({ designs, total, hasMore });
    } catch (error) {
      console.error("Error fetching designs:", error);
      res.status(500).json({ error: "Failed to fetch designs" });
    }
  });

  // Get single design
  app.get("/api/designs/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const designId = parseInt(req.params.id);
      const design = await storage.getDesign(designId);
      
      if (!design) {
        return res.status(404).json({ error: "Design not found" });
      }
      
      res.json(design);
    } catch (error) {
      console.error("Error fetching design:", error);
      res.status(500).json({ error: "Failed to fetch design" });
    }
  });

  // Update design transforms
  app.patch("/api/designs/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const designId = parseInt(req.params.id);
      const { transformScale, transformX, transformY, size, frameColor } = req.body;
      
      const design = await storage.getDesign(designId);
      if (!design) {
        return res.status(404).json({ error: "Design not found" });
      }

      const customer = await storage.getCustomerByUserId(userId);
      if (!customer || design.customerId !== customer.id) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const clamp = (val: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, val)));

      const updateData: Partial<typeof design> = {
        transformScale: clamp(transformScale ?? design.transformScale ?? 135, 25, 135),
        transformX: clamp(transformX ?? design.transformX ?? 50, 0, 100),
        transformY: clamp(transformY ?? design.transformY ?? 50, 0, 100),
      };

      if (size !== undefined) {
        updateData.size = size;
      }
      if (frameColor !== undefined) {
        updateData.frameColor = frameColor;
      }

      const updated = await storage.updateDesign(designId, updateData);

      res.json(updated);
    } catch (error) {
      console.error("Error updating design:", error);
      res.status(500).json({ error: "Failed to update design" });
    }
  });

  // Generate artwork
  app.post("/api/generate", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      let customer = await storage.getCustomerByUserId(userId);
      
      if (!customer) {
        customer = await storage.createCustomer({
          userId,
          credits: 5,
          freeGenerationsUsed: 0,
          totalGenerations: 0,
          totalSpent: "0.00",
        });
      }

      // Owner bypass: app creator gets unlimited generations
      const ownerShop = process.env.OWNER_SHOP_DOMAIN?.toLowerCase().trim();
      const isOwner = !!(ownerShop && (req as any).shopDomain?.toLowerCase() === ownerShop);
      if (isOwner) console.log(`[/api/generate] Owner bypass active for shop: ${(req as any).shopDomain}`);

      // Check credits (bypassed for app owner)
      if (!isOwner && customer.credits <= 0) {
        return res.status(400).json({ 
          error: "No credits remaining. Please purchase more credits.",
          needsCredits: true 
        });
      }

      // Check design gallery limit (50 max)
      const designCount = await storage.getDesignCountByCustomer(customer.id);
      if (designCount >= 50) {
        return res.status(400).json({ 
          error: "Your design gallery is full (50 designs max). Please delete some designs to save new ones.",
          galleryFull: true 
        });
      }

      const { prompt, userPrompt: rawUserPromptAdmin, stylePreset, size, frameColor, referenceImage, productTypeId, bgRemovalSensitivity, baseImageUrl: clientBaseImageUrl } = req.body;

      if (!prompt || !size) {
        return res.status(400).json({ error: "Prompt and size are required" });
      }

      // Load product type if provided (needed for style lookup)
      let productType = null;
      if (productTypeId) {
        productType = await storage.getProductType(parseInt(productTypeId));
      }

      // Look up style preset and get its promptSuffix
      let stylePromptPrefix = "";
      let styleCategory = "all"; // Track category for base prompt enforcement
      let styleBaseImageUrl: string | undefined; // Style-level base reference image
      if (stylePreset) {
        // Use product type's merchant for style lookup (merchant-scoped styles)
        const merchantId = productType?.merchantId;
        if (merchantId) {
          const dbStyles = await storage.getStylePresetsByMerchant(merchantId);
          const selectedStyle = dbStyles.find((s: { id: number; promptPrefix: string | null; category?: string | null; baseImageUrl?: string | null }) => s.id.toString() === stylePreset);
          if (selectedStyle && selectedStyle.promptPrefix) {
            stylePromptPrefix = selectedStyle.promptPrefix;
            styleCategory = selectedStyle.category || "all";
            // Prefer baseImageUrls array, fall back to single baseImageUrl
            const dbBaseUrls: string[] = (selectedStyle as any).baseImageUrls ||
              (selectedStyle.baseImageUrl ? [selectedStyle.baseImageUrl] : []);
            if (dbBaseUrls.length > 0) styleBaseImageUrl = dbBaseUrls[0];
            // Store all URLs for later use
            (req as any)._styleBaseImageUrls = dbBaseUrls;
          }
        }
        // Fall back to hardcoded STYLE_PRESETS only if no merchant context or no match
        if (!stylePromptPrefix) {
          const hardcodedStyle = STYLE_PRESETS.find(s => s.id === stylePreset);
          if (hardcodedStyle && hardcodedStyle.promptPrefix) {
            stylePromptPrefix = hardcodedStyle.promptPrefix;
            styleCategory = hardcodedStyle.category || "all";
          }
        }
      }
      // Client can pass a resolved baseImageUrl (from sub-option choices); use it if server didn't find one
      if (!styleBaseImageUrl && clientBaseImageUrl) {
        styleBaseImageUrl = clientBaseImageUrl;
      }


      // Find size config - check product type sizes first, then fall back to PRINT_SIZES
      let sizeConfig = PRINT_SIZES.find(s => s.id === size);
      


      if (!sizeConfig && productType) {
        // Try to find size in product type's sizes (for apparel, etc.)
        const productSizes = JSON.parse(productType.sizes || "[]");
        const productSize = productSizes.find((s: any) => s.id === size);
        if (productSize) {
          let aspectRatioStr = productSize.aspectRatio || productType.aspectRatio || "3:4";

          // For double-sided products, convert combined ratio to per-side ratio
          if (productType.doubleSidedPrint) {
            const [arW, arH] = aspectRatioStr.split(":").map(Number);
            if (arW && arH && !isNaN(arW) && !isNaN(arH) && arW / arH >= 1.9) {
              const perSideW = arW / 2;
              const gcdFn = (a: number, b: number): number => b === 0 ? a : gcdFn(b, a % b);
              const d = gcdFn(Math.round(perSideW), arH);
              aspectRatioStr = `${Math.round(perSideW / d)}:${Math.round(arH / d)}`;
              console.log(`[Admin Gen] Double-sided ratio override → ${aspectRatioStr} (per-side)`);
            }
          }

          const genDims = calculateGenDimensions(aspectRatioStr);
          
          sizeConfig = {
            id: productSize.id,
            name: productSize.name,
            width: productSize.width || 12,
            height: productSize.height || 16,
            aspectRatio: aspectRatioStr,
            genWidth: genDims.genWidth,
            genHeight: genDims.genHeight,
          } as any;
        }
      }
      
      if (!sizeConfig) {
        // Default fallback - use product type's aspect ratio if available
        let aspectRatioStr = productType?.aspectRatio || "3:4";

        // For double-sided products, convert combined ratio to per-side ratio
        if (productType?.doubleSidedPrint) {
          const [arW, arH] = aspectRatioStr.split(":").map(Number);
          if (arW && arH && !isNaN(arW) && !isNaN(arH) && arW / arH >= 1.9) {
            const perSideW = arW / 2;
            const gcdFn = (a: number, b: number): number => b === 0 ? a : gcdFn(b, a % b);
            const d = gcdFn(Math.round(perSideW), arH);
            aspectRatioStr = `${Math.round(perSideW / d)}:${Math.round(arH / d)}`;
          }
        }

        const genDims = calculateGenDimensions(aspectRatioStr);
        sizeConfig = { id: size, name: size, width: 12, height: 16, aspectRatio: aspectRatioStr, genWidth: genDims.genWidth, genHeight: genDims.genHeight } as any;
      }

      // Now sizeConfig is guaranteed to be defined
      const finalSizeConfig = sizeConfig!;
      const aspectRatioStr = (finalSizeConfig as any).aspectRatio || "1:1";
      
      // Check if this is an apparel product - either from productType or from style preset category
      // This covers both hardcoded and merchant-created styles via styleCategory
      let isApparel = productType?.designerType === "apparel";
      
      // Also detect apparel from style category (works for both DB and hardcoded styles)
      if (!isApparel && styleCategory === "apparel") {
        isApparel = true;
      }

      const isAllOverPrint = !!(productType?.isAllOverPrint);      // Determine color tier for apparel products
      let colorTier: ColorTier = "light"; // Default to light (dark designs on white background)
      
      if (isApparel && frameColor) {
        // Look up the color's hex value from product type's frameColors
        let colorHex = "#f5f5f5"; // Default to white/light
        
        if (productType) {
          const frameColors = JSON.parse(productType.frameColors || "[]");
          const selectedColor = frameColors.find((c: { id: string; hex: string }) => c.id === frameColor);
          if (selectedColor?.hex) {
            colorHex = selectedColor.hex;
          }
        } else {
          // Fall back to FRAME_COLORS for framed prints
          const selectedColor = FRAME_COLORS.find(c => c.id === frameColor);
          if (selectedColor?.hex) {
            colorHex = selectedColor.hex;
          }
        }
        
        colorTier = getColorTier(colorHex);
        console.log(`[Generate] Apparel color tier: ${colorTier} (color: ${frameColor}, hex: ${colorHex})`);
      }

      // Apply style prompt prefix - use dark tier variant for apparel on dark colors
      // User description comes first so the AI treats it as the primary subject.
      const userDescAdmin = (rawUserPromptAdmin || "").trim();
      let fullPrompt: string;
      
      if (isApparel && colorTier === "dark" && stylePreset && APPAREL_DARK_TIER_PROMPTS[stylePreset]) {
        // Use dark tier prompt for dark apparel (light designs on dark background)
        const darkTierPrompt = APPAREL_DARK_TIER_PROMPTS[stylePreset];
        if (darkTierPrompt) {
          fullPrompt = userDescAdmin ? `${userDescAdmin}, ${darkTierPrompt}` : darkTierPrompt;
        } else {
          fullPrompt = prompt;
        }
        console.log(`[Generate] Using dark tier prompt for ${stylePreset}`);
      } else {
        if (stylePromptPrefix) {
          fullPrompt = userDescAdmin ? `${userDescAdmin}, ${stylePromptPrefix}` : stylePromptPrefix;
        } else {
          fullPrompt = prompt;
        }
      }

      // Different requirements for apparel vs wall art
      let sizingRequirements: string;
      
      if (isApparel) {
        // All apparel (AOP and standard) now uses white background for Picsart removebg
        sizingRequirements = `
MANDATORY IMAGE REQUIREMENTS FOR APPAREL PRINTING - FOLLOW EXACTLY:
1. ISOLATED DESIGN: Create a SINGLE, centered graphic design that is ISOLATED from any background scenery.
2. SOLID FLAT WHITE BACKGROUND: The ENTIRE background MUST be a flat, solid, uniform pure white (#FFFFFF) color. Every pixel that is not part of the design must be exactly #FFFFFF. DO NOT create scenic backgrounds, gradients, or detailed environments.
3. DESIGN COLORS: Use VIBRANT, BOLD colors. The design MUST NOT contain any pure white pixels in the main subject — white is reserved exclusively for the background.
4. CENTERED COMPOSITION: The main design subject should be centered and take up approximately 60-70% of the canvas, leaving clean white space around it.
5. CLEAN EDGES: The design must have crisp, clean edges against the white background. No fuzzy, gradient, or semi-transparent edges.
6. NO RECTANGULAR FRAMES: Do NOT put the design inside a rectangular box, border, or frame. The design should stand alone on the solid white background.
7. PRINT-READY: This is for apparel printing — create an isolated graphic that can be printed on fabric.
8. COMPOSITION FORMAT: Fill the canvas matching the requested aspect ratio with the design centered.
9. STRICT PROMPT ADHERENCE: ONLY depict exactly what the user described. Do NOT add text, slogans, words, brand names, themed scenarios, or additional story elements unless the user explicitly asked for them.
`;
      } else {
        // Wall art needs full-bleed edge-to-edge designs
        // Build shape-specific safe zone instructions
        const printShape = productType?.printShape || "rectangle";
        const bleedMargin = productType?.bleedMarginPercent || 5;
        const safeZonePercent = 100 - (bleedMargin * 2);
        
        let shapeInstructions = "";
        if (printShape === "circle") {
          shapeInstructions = `
CIRCULAR PRINT AREA: This design is for a CIRCULAR product (like a round pillow or coaster).
- Center all important elements (faces, text, focal points) within the inner ${safeZonePercent}% of the circle
- Keep a ${bleedMargin}% margin from the circular edge for manufacturing bleed
- The corners of the canvas will be cropped to a circle - nothing important should be in the corners
- Design with radial/circular composition in mind`;
        } else if (printShape === "square") {
          shapeInstructions = `
SQUARE PRINT AREA: This design is for a square product.
- Center important elements within the inner ${safeZonePercent}% of the canvas
- Keep a ${bleedMargin}% margin from all edges for bleed`;
        } else {
          shapeInstructions = `
RECTANGULAR PRINT AREA:
- Keep important elements within the inner ${safeZonePercent}% of the canvas
- Maintain a ${bleedMargin}% margin from edges for bleed`;
        }
        
        // Determine if this is landscape, portrait, or square based on aspect ratio
        const [arW, arH] = aspectRatioStr.split(":").map(Number);
        const aspectRatioValue = arW / arH;
        let orientationDescription: string;
        if (aspectRatioValue > 1.05) {
          orientationDescription = `HORIZONTAL LANDSCAPE (wider than tall)`;
        } else if (aspectRatioValue < 0.95) {
          orientationDescription = `VERTICAL PORTRAIT (taller than wide)`;
        } else {
          orientationDescription = `SQUARE`;
        }
        
        // For wrap-around products like tumblers, add specific guidance
        const isWrapAround = aspectRatioValue >= 1.2; // 4:3 or wider is wrap-around
        const textEdgeRestrictions = isWrapAround 
          ? `
TEXT AND ELEMENT PLACEMENT - CRITICAL:
- DO NOT place any text, letters, words, or important elements within 20% of ANY edge
- ALL text must be positioned in the CENTER 60% of the image both horizontally and vertically
- The outer 20% margins on ALL sides should contain ONLY background/scenery - NO text whatsoever
- This is a WRAP-AROUND cylindrical product - edges will be hidden or wrapped around`
          : `
TEXT AND ELEMENT PLACEMENT:
- Keep all text and important elements within the central 75% of the image
- Avoid placing critical content near the edges where it may be cut off during printing`;
        
        sizingRequirements = `

=== CRITICAL CANVAS REQUIREMENTS (MUST FOLLOW) ===
CANVAS: ${orientationDescription} format
FULL-BLEED MANDATORY: The artwork MUST fill the ENTIRE canvas edge-to-edge with NO blank margins, borders, or empty space. Paint/draw to ALL four edges.
${shapeInstructions}
${textEdgeRestrictions}

=== IMAGE CONTENT REQUIREMENTS ===
1. The background/scene MUST extend fully to ALL four edges - no visible canvas boundaries
2. NO decorative borders, picture frames, drop shadows, or vignettes
3. The subject must NOT appear floating - complete the background behind and around it
4. This is for high-quality printing - create finished artwork that bleeds to all edges
`;
      }

      // Build final prompt: CONSTRAINTS FIRST, then style, then user description
      // This ensures Gemini prioritizes our dimensional requirements over style biases
      const geminiAspectRatio = mapToGeminiAspectRatio(aspectRatioStr);
      
      // Restructure prompt: constraints first, then style/content
      const constraintsFirst = sizingRequirements;
      const styleAndContent = fullPrompt; // Already has style prefix + user prompt
      fullPrompt = `${constraintsFirst}\n\n=== ARTWORK DESCRIPTION ===\n${styleAndContent}`;
      
      console.log(`[Generate] Using Gemini aspect ratio: ${geminiAspectRatio} (from ${aspectRatioStr})`);

      // Resolve reference image for Replicate — pass data URLs directly to avoid URL-accessibility issues
      let customerImageUrl: string | null = null;
      if (referenceImage) {
        try {
          if (referenceImage.startsWith("data:")) {
            customerImageUrl = referenceImage;
          } else if (referenceImage.startsWith("http")) {
            customerImageUrl = referenceImage;
          } else if (referenceImage.startsWith("/objects/")) {
            const appUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
            customerImageUrl = `${appUrl}${referenceImage}`;
          }
          if (customerImageUrl) {
            const urlType = customerImageUrl.startsWith("data:") ? "data-url" : "http-url";
            const urlSize = customerImageUrl.length;
            console.log(`[Generate] Reference image: type=${urlType}, size=${urlSize} chars`);
          }
        } catch (refErr) {
          console.warn("[Generate] Could not process reference image, generating without it:", refErr);
          customerImageUrl = null;
        }
      }

      // Build image input array: all style base images + customer reference image
      const imageInputUrls: string[] = [];
      const allStyleBaseUrls: string[] = (req as any)._styleBaseImageUrls ||
        (styleBaseImageUrl ? [styleBaseImageUrl] : []);
      imageInputUrls.push(...allStyleBaseUrls);
      if (customerImageUrl) imageInputUrls.push(customerImageUrl);
      const inputImageUrl: string | string[] | null = imageInputUrls.length > 1 ? imageInputUrls : imageInputUrls[0] || null;

      // When reference images are provided, instruct the model how to use them
      if (imageInputUrls.length > 0) {
        let refInstruction: string;
        if (styleBaseImageUrl && customerImageUrl) {
          refInstruction = `Two reference images are provided. The FIRST is a style/scene foundation — use it as the visual template and overall composition guide. The SECOND is the customer's subject (e.g. their pet, logo, or photo) — incorporate this subject into the design as the focal element. Do NOT duplicate or repeat the subject.`;
        } else if (customerImageUrl) {
          const isTextStyle = stylePreset && ["opinionated", "quotes"].includes(stylePreset);
          refInstruction = isTextStyle
            ? `Using the provided reference image as visual inspiration, incorporate its subject as a SINGLE mascot or icon element integrated INTO the typographic composition — positioned between, behind, or alongside the text as part of the overall layout. Do NOT simply overlay or duplicate the reference subject on top of the text. Do NOT repeat the subject multiple times.`
            : `Using the provided reference image as visual inspiration, incorporate its key elements, style, and subject into the design.`;
        } else {
          refInstruction = `Using the provided style reference image as visual inspiration and composition guide, create the design following its overall style and layout.`;
        }
        fullPrompt = `${refInstruction} ${fullPrompt}`;
      }

      // Generate image using Replicate
      const { mimeType, data } = await generateImageBase64({
        prompt: fullPrompt,
        aspectRatio: geminiAspectRatio,
        inputImageUrl,
        isApparel,
        isAllOverPrint,
      });
console.log("[api/generate] replicate returned", {
  mimeType,
  dataType: typeof data,
  dataLen: data?.length,
  dataHead: data?.slice?.(0, 32),
});

      if (!data) {
        await storage.createGenerationLog({
          customerId: customer.id,
          promptLength: prompt.length,
          hadReferenceImage: !!referenceImage,
          stylePreset,
          size,
          success: false,
          errorMessage: "No image data in response",
        });
        return res.status(500).json({ error: "Failed to generate image" });
      }

      // Get target dimensions for resizing - skip for apparel (keep square)
      let targetDims: TargetDimensions | undefined;
      if (!isApparel) {
        const genWidth = (finalSizeConfig as any).genWidth || 1024;
        const genHeight = (finalSizeConfig as any).genHeight || 1024;
        targetDims = { width: genWidth, height: genHeight };
      }

      // Save image to object storage (with background removal for apparel, aspect ratio resizing for wall art)
      let generatedImageUrl: string;
      let thumbnailImageUrl: string | undefined;
      try {
        console.log("[api/generate] saving image", {
  mimeType,
  base64Len: data?.length,
  isApparel,
  targetDims,
  colorTier: isApparel ? colorTier : undefined,
});

       const result = await saveImageToStorage(data, mimeType, {

  isApparel,
  isAllOverPrint,
  targetDims,
});

console.log("[api/shopify/generate] saved image", result);

        generatedImageUrl = result.imageUrl;
        thumbnailImageUrl = result.thumbnailUrl;
      } catch (storageError) {
        console.error("Failed to save to object storage, falling back to base64:", storageError);
        generatedImageUrl = `data:${mimeType};base64,${data}`;
      }

      // Create design record
      const design = await storage.createDesign({
        customerId: customer.id,
        prompt,
        stylePreset: stylePreset || null,
        referenceImageUrl: referenceImage ? "uploaded" : null,
        generatedImageUrl,
        thumbnailImageUrl,
        size,
        frameColor: frameColor || "black",
        aspectRatio: aspectRatioStr,
        colorTier: isApparel ? colorTier : null,
        status: "completed",
      });

      // Deduct credit (skipped for app owner)
      if (!isOwner) {
        await storage.updateCustomer(customer.id, {
          credits: customer.credits - 1,
          totalGenerations: customer.totalGenerations + 1,
        });
      } else {
        await storage.updateCustomer(customer.id, {
          totalGenerations: customer.totalGenerations + 1,
        });
      }

      // Log generation
      await storage.createGenerationLog({
        customerId: customer.id,
        designId: design.id,
        promptLength: prompt.length,
        hadReferenceImage: !!referenceImage,
        stylePreset,
        size,
        success: true,
      });

      // Create credit transaction (skipped for app owner)
      if (!isOwner) {
        await storage.createCreditTransaction({
          customerId: customer.id,
          type: "generation",
          amount: -1,
          description: `Generated artwork: ${prompt.substring(0, 50)}...`,
        });
      }

      res.json({
        design,
        creditsRemaining: isOwner ? 999999 : customer.credits - 1,
      });
    } catch (error: any) {
      console.error("Error generating artwork:", error);
      // Return detailed error message for debugging
      const errorMessage = error?.message || String(error) || "Unknown error";
      res.status(500).json({
        error: "Failed to generate artwork",
        details: errorMessage
      });
    }
  });

  // Regenerate design for a different color tier (costs 1 credit)
  // Used when user switches between light/dark apparel colors
  app.post("/api/generate/regenerate-tier", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const customer = await storage.getCustomerByUserId(userId);
      
      if (!customer) {
        return res.status(401).json({ error: "Customer not found" });
      }

      const { designId, newColorTier, newFrameColor } = req.body;
      
      if (!designId || !newColorTier) {
        return res.status(400).json({ error: "Design ID and new color tier are required" });
      }

      // Owner bypass: app creator gets unlimited regenerations
      const ownerShopRegen = process.env.OWNER_SHOP_DOMAIN?.toLowerCase().trim();
      const isOwnerRegen = !!(ownerShopRegen && (req as any).shopDomain?.toLowerCase() === ownerShopRegen);
      if (isOwnerRegen) console.log(`[/api/generate/regenerate-tier] Owner bypass active for shop: ${(req as any).shopDomain}`);

      // Check credits (regeneration costs 1 credit; bypassed for app owner)
      if (!isOwnerRegen && customer.credits < 1) {
        return res.status(402).json({ 
          error: "Insufficient credits", 
          creditsRequired: 1,
          creditsRemaining: customer.credits
        });
      }

      // Get the original design
      const originalDesign = await storage.getDesign(designId);
      if (!originalDesign) {
        return res.status(404).json({ error: "Design not found" });
      }

      // Verify ownership
      if (originalDesign.customerId !== customer.id) {
        return res.status(403).json({ error: "Not authorized to modify this design" });
      }

      // Get the product type for style lookup
      let productType = null;
      if (originalDesign.productTypeId) {
        productType = await storage.getProductType(originalDesign.productTypeId);
      }

      // Look up the original style preset
      let stylePromptPrefix = "";
      const stylePreset = originalDesign.stylePreset;
      
      if (stylePreset) {
        // For dark tier, use the dark tier prompt variants
        if (newColorTier === "dark" && APPAREL_DARK_TIER_PROMPTS[stylePreset]) {
          stylePromptPrefix = APPAREL_DARK_TIER_PROMPTS[stylePreset];
        } else {
          // Use regular prompt
          const hardcodedStyle = STYLE_PRESETS.find(s => s.id === stylePreset);
          if (hardcodedStyle && hardcodedStyle.promptPrefix) {
            stylePromptPrefix = hardcodedStyle.promptPrefix;
          }
        }
      }

      // Build the prompt
      const prompt = originalDesign.prompt;
      let fullPrompt = stylePromptPrefix ? `${stylePromptPrefix} ${prompt}` : prompt;
      
      // Add sizing requirements — always use #FF00FF chroma key background for apparel
      const isDarkTier = newColorTier === "dark";
      const designColors = isDarkTier 
        ? "BRIGHT, VIBRANT colors including white and light tones. AVOID dark, black, and hot pink/magenta colors in the design."
        : "VIBRANT colors. AVOID white, light colors, and hot pink/magenta in the design.";
      
      fullPrompt += `

MANDATORY IMAGE REQUIREMENTS FOR APPAREL PRINTING - FOLLOW EXACTLY:
1. ISOLATED DESIGN: Create a SINGLE, centered graphic design that is ISOLATED from any background scenery.
2. SOLID HOT PINK (#FF00FF) BACKGROUND: The ENTIRE background MUST be a flat, uniform hot pink (#FF00FF) color. Every pixel that is not part of the design must be exactly #FF00FF. DO NOT create scenic backgrounds, landscapes, or detailed environments.
3. DESIGN COLORS: Use ${designColors} The design MUST NOT contain any hot pink or magenta (#FF00FF) pixels — this color is reserved exclusively for the background.
4. CENTERED COMPOSITION: The main design subject should be centered and take up approximately 60-70% of the canvas, leaving clean #FF00FF space around it.
5. CLEAN EDGES: The design must have crisp, clean edges against the hot pink background. No fuzzy, gradient, or semi-transparent edges.
6. NO RECTANGULAR FRAMES: Do NOT put the design inside a rectangular box, border, or frame. The design should stand alone on the solid hot pink background.
7. PRINT-READY: This is for t-shirt/apparel printing — create an isolated graphic that can be printed on fabric.
8. COMPOSITION FORMAT: Fill the canvas matching the requested aspect ratio with the design centered.
9. STRICT PROMPT ADHERENCE: ONLY depict exactly what the user described. Do NOT add text, slogans, words, brand names, themed scenarios, or additional story elements unless the user explicitly asked for them.
`;

      console.log(`[Regenerate-Tier] Regenerating design ${designId} for ${newColorTier} tier`);

      // Generate the new image (Replicate)
      const recolorIsAllOverPrint = !!(productType as any)?.isAllOverPrint;
const { data: base64Data, mimeType } = await generateImageBase64({
  prompt: fullPrompt,
  isApparel: true,
  isAllOverPrint: recolorIsAllOverPrint,
});

// Match the old Gemini shape so the rest of the code still works
const imagePart = {
  inlineData: {
    data: base64Data,
    mimeType: mimeType || "image/png",
  },
};

if (!imagePart.inlineData.data) {
  return res.status(500).json({ error: "Failed to regenerate image" });
}

      // Save image with background removal
      let generatedImageUrl: string;
      let thumbnailImageUrl: string | undefined;
      try {
        const finalMimeType = mimeType || "image/png";
const result = await saveImageToStorage(base64Data, finalMimeType, { 
          isApparel: true, 
          colorTier: newColorTier as ColorTier
        });
        generatedImageUrl = result.imageUrl;
        thumbnailImageUrl = result.thumbnailUrl;
      } catch (storageError) {
        console.error("Failed to save regenerated image:", storageError);
        generatedImageUrl = `data:${mimeType};base64,${imagePart.inlineData.data}`;
      }

      // Store the current image as alternate before updating
      const updateData: any = {
        colorTier: newColorTier,
        frameColor: newFrameColor || originalDesign.frameColor,
      };

      // If we have an existing image and it's different from the new one, store it as alternate
      if (originalDesign.generatedImageUrl && !originalDesign.generatedImageUrl.startsWith('data:')) {
        updateData.alternateImageUrl = originalDesign.generatedImageUrl;
      }
      
      updateData.generatedImageUrl = generatedImageUrl;
      if (thumbnailImageUrl) {
        updateData.thumbnailImageUrl = thumbnailImageUrl;
      }

      // Update the design with new image and tier
      const updatedDesign = await storage.updateDesign(designId, updateData);

      // Deduct 1 credit for regeneration (skipped for app owner)
      if (!isOwnerRegen) {
        await storage.updateCustomer(customer.id, { credits: customer.credits - 1 });
      }

      // Log the regeneration
      await storage.createGenerationLog({
        customerId: customer.id,
        designId: designId,
        promptLength: prompt.length,
        hadReferenceImage: false,
        stylePreset,
        size: originalDesign.size,
        success: true,
      });

      // Create credit transaction (skipped for app owner)
      if (!isOwnerRegen) {
        await storage.createCreditTransaction({
          customerId: customer.id,
          type: "generation",
          amount: -1,
          description: `Regenerated design for ${newColorTier} apparel colors`,
        });
      }

      console.log(`[Regenerate-Tier] Successfully regenerated design ${designId} for ${newColorTier} tier${isOwnerRegen ? " (owner bypass)" : " (1 credit deducted)"}`);

      res.json({
        design: updatedDesign,
        creditsRemaining: isOwnerRegen ? 999999 : customer.credits - 1,
        message: `Design regenerated for ${newColorTier} colored apparel`,
      });
    } catch (error) {
      console.error("Error regenerating design for tier:", error);
      res.status(500).json({ error: "Failed to regenerate design" });
    }
  });

  // Rate limiting for Shopify generation (per shop per hour)
  const shopifyGenerationRateLimits = new Map<string, { count: number; resetAt: number }>();
  const SHOPIFY_RATE_LIMIT = 100; // 100 generations per shop per hour
  const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
  
  // Rate limiting for Shopify session creation (per IP per minute)
  const shopifySessionRateLimits = new Map<string, { count: number; resetAt: number }>();
  const SESSION_RATE_LIMIT = 10; // 10 session requests per IP per minute
  const SESSION_RATE_WINDOW_MS = 60 * 1000; // 1 minute
  
  // Session token store for Shopify storefronts (token -> { shop, expiresAt, clientIp, customerId?, customerEmail? })
  interface ShopifySession {
    shop: string;
    expiresAt: number;
    clientIp: string;
    customerId?: string;
    customerEmail?: string;
    customerName?: string;
    internalCustomerId?: string;
  }
  const shopifySessionTokens = new Map<string, ShopifySession>();
  const SESSION_TOKEN_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

  // Generate session token for Shopify storefront (called from iframe)
  // Security layers:
  // 1. Origin validation (requests must come from our app's embed page)
  // 2. Shop domain format validation (must be valid *.myshopify.com)
  // 3. Active installation check (shop must be installed in our system)
  // 4. Timestamp validation (request must be within 5 minutes)
  // 5. Rate limiting (10 requests per IP per minute)
  // 6. IP binding on session tokens
  app.post("/api/shopify/session", async (req: Request, res: Response) => {
    try {
      const { shop, productId, timestamp, customerId, customerEmail, customerName } = req.body;

      if (!shop) {
        return res.status(400).json({ error: "Shop domain required" });
      }

      // Log the session request for debugging
      const referer = req.headers.referer || req.headers.origin || "";
      const host = req.headers.host || "";
      console.log(`Shopify session request: shop=${shop}, referer=${referer}, host=${host}`);
      
      // Note: Origin validation is relaxed to allow Shopify storefronts (custom domains, CDN, etc.)
      // Security is enforced by verifying the shop installation exists and is active (below)

      // Validate shop domain format - accept myshopify.com domains
      // Custom domains are also accepted and will be looked up
      const isMyshopifyDomain = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
      if (!isMyshopifyDomain) {
        console.log(`Shopify session: Non-myshopify domain received: ${shop}, will attempt to look up`);
      }

      // Rate limit session creation per IP to prevent abuse
      const clientIp = req.ip || req.headers["x-forwarded-for"] || "unknown";
      const ipKey = typeof clientIp === "string" ? clientIp : clientIp[0];
      const now = Date.now();
      const sessionRateLimit = shopifySessionRateLimits.get(ipKey);
      if (sessionRateLimit) {
        if (now < sessionRateLimit.resetAt) {
          if (sessionRateLimit.count >= SESSION_RATE_LIMIT) {
            console.warn(`Shopify session rate limit exceeded for IP: ${ipKey}`);
            return res.status(429).json({ error: "Too many requests. Please wait before trying again." });
          }
          sessionRateLimit.count++;
        } else {
          shopifySessionRateLimits.set(ipKey, { count: 1, resetAt: now + SESSION_RATE_WINDOW_MS });
        }
      } else {
        shopifySessionRateLimits.set(ipKey, { count: 1, resetAt: now + SESSION_RATE_WINDOW_MS });
      }

      // Verify shop is installed first (this is the primary security check)
      // We check installation before referer since custom domains won't match myshopify.com patterns
      let installation = await storage.getShopifyInstallationByShop(shop);
      
      // If not found and it's not a myshopify domain, the frontend might be passing a custom domain
      // Log this for debugging and return a helpful error
      if (!installation && !isMyshopifyDomain) {
        console.log(`Shopify session: No installation found for custom domain: ${shop}`);
        // Try to give a helpful error - the theme extension needs to pass the myshopify.com domain
        return res.status(403).json({ 
          error: "Shop not authorized",
          details: "Custom domain detected. Theme extension may need to be updated to pass the myshopify.com domain."
        });
      }
      
      if (!installation || installation.status !== "active") {
        console.log(`Shopify session: Installation not found or inactive for: ${shop}`);
        return res.status(403).json({ error: "Shop not authorized" });
      }
console.log("[shopify/session] installation ok", {
  shop,
  merchantId: installation.merchantId,
  status: installation.status,
});
      // Verify timestamp is recent (within 5 minutes)
      const requestTimestamp = parseInt(timestamp) || 0;
      if (Math.abs(now - requestTimestamp) > 5 * 60 * 1000) {
        return res.status(400).json({ error: "Request timestamp expired" });
      }

      // Generate session token with IP binding for additional security
      const sessionToken = crypto.randomBytes(32).toString("hex");
      
      // Create session data (ipKey is already extracted for rate limiting)
      const sessionData: ShopifySession = {
        shop,
        expiresAt: now + SESSION_TOKEN_EXPIRY_MS,
        clientIp: ipKey,
      };
      
      // If customer is logged in, create/get their customer record
      let internalCustomer = null;
      if (customerId) {
        try {
          internalCustomer = await storage.getOrCreateShopifyCustomer(shop, customerId, customerEmail);
          sessionData.customerId = customerId;
          sessionData.customerEmail = customerEmail;
          sessionData.customerName = customerName;
          sessionData.internalCustomerId = internalCustomer.id;
        } catch (e) {
          console.error("Error creating Shopify customer:", e);
        }
      }
      
      shopifySessionTokens.set(sessionToken, sessionData);

      // Clean up expired tokens periodically
      const tokenEntries = Array.from(shopifySessionTokens.entries());
      for (const [token, data] of tokenEntries) {
        if (data.expiresAt < now) {
          shopifySessionTokens.delete(token);
        }
      }

      res.json({ 
        sessionToken, 
        expiresIn: SESSION_TOKEN_EXPIRY_MS / 1000,
        customer: internalCustomer ? {
          id: internalCustomer.id,
          credits: internalCustomer.credits,
          isLoggedIn: true,
        } : {
          isLoggedIn: false,
          credits: 0,
        }
      });
    } catch (error) {
      console.error("Error creating Shopify session:", error);
      res.status(500).json({ error: "Failed to create session" });
    }
  });

  // Shopify Storefront Generate (for embedded design studio)
  // Requires valid session token from /api/shopify/session
  app.post("/api/shopify/generate", async (req: Request, res: Response) => {
    try {
      const { prompt, userPrompt: rawUserPromptEmbed, stylePreset, size, frameColor, referenceImage, referenceImages: referenceImagesArr, shop, sessionToken, bgRemovalSensitivity, baseImageUrl: clientBaseImageUrlEmbed } = req.body;

      if (!shop) {
        return res.status(400).json({ error: "Shop domain required" });
      }

      // Validate shop domain format
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
        return res.status(400).json({ error: "Invalid shop domain format" });
      }

      // Verify session token
      if (!sessionToken) {
        return res.status(401).json({ error: "Session token required" });
      }

      const session = shopifySessionTokens.get(sessionToken);
      if (!session) {
        return res.status(401).json({ error: "Invalid session token" });
      }

      if (Date.now() > session.expiresAt) {
        shopifySessionTokens.delete(sessionToken);
        return res.status(401).json({ error: "Session token expired" });
      }

      if (session.shop !== shop) {
        return res.status(403).json({ error: "Session token mismatch" });
      }

      // Verify shop is installed
      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }

      // For Shopify embedded mode, customer login is OPTIONAL
      // Business model: Shop pays for generation capacity via rate limits.
      // If a customer is logged in with personal credits, we deduct from their credits first.
      // If no credits or not logged in, generation is allowed under shop's rate limit.
      let customer = null;
      let creditDeducted = false;
      if (session.internalCustomerId) {
        customer = await storage.getCustomer(session.internalCustomerId);
        if (customer && customer.credits > 0) {
          // Atomically decrement credits BEFORE generation
          const updatedCustomer = await storage.decrementCreditsIfAvailable(customer.id);
          if (updatedCustomer) {
            customer = updatedCustomer;
            creditDeducted = true;
          }
          // If decrement fails (race condition), still allow generation via shop's rate limit
        }
        // If customer has no personal credits, generation is allowed via shop's rate limit
        // This is intentional - shop is paying for capacity, individual credits are optional
      }
      // Anonymous Shopify customers are allowed - shop-level rate limiting handles abuse

      // Rate limiting per shop
      const now = Date.now();
      let rateLimit = shopifyGenerationRateLimits.get(shop);
      
      if (!rateLimit || now > rateLimit.resetAt) {
        rateLimit = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
        shopifyGenerationRateLimits.set(shop, rateLimit);
      }
      
      if (rateLimit.count >= SHOPIFY_RATE_LIMIT) {
        return res.status(429).json({ 
          error: "Rate limit exceeded. Please try again later.",
          retryAfter: Math.ceil((rateLimit.resetAt - now) / 1000)
        });
      }
      
      rateLimit.count++;

      const { productTypeId } = req.body;

      if (!prompt || !size) {
        return res.status(400).json({ error: "Prompt and size are required" });
      }

      // Look up style preset and get its promptSuffix
      let stylePromptPrefix = "";
      let embedStyleCategory = "all";
      let embedStyleBaseImageUrl: string | undefined;
      let embedStyleBaseImageUrls: string[] = [];
      if (stylePreset && installation.merchantId) {
        const dbStyles = await storage.getStylePresetsByMerchant(installation.merchantId);
        const selectedStyle = dbStyles.find((s: { id: number; promptPrefix: string | null; category?: string | null; baseImageUrl?: string | null }) => s.id.toString() === stylePreset);
        if (selectedStyle && selectedStyle.promptPrefix) {
          stylePromptPrefix = selectedStyle.promptPrefix;
          embedStyleCategory = selectedStyle.category || "all";
          const dbBaseUrls: string[] = (selectedStyle as any).baseImageUrls ||
            (selectedStyle.baseImageUrl ? [selectedStyle.baseImageUrl] : []);
          embedStyleBaseImageUrls = dbBaseUrls;
          if (dbBaseUrls.length > 0) embedStyleBaseImageUrl = dbBaseUrls[0];
        }
        if (!stylePromptPrefix) {
          const hardcodedStyle = STYLE_PRESETS.find(s => s.id === stylePreset);
          if (hardcodedStyle && hardcodedStyle.promptPrefix) {
            stylePromptPrefix = hardcodedStyle.promptPrefix;
            embedStyleCategory = hardcodedStyle.category || "all";
          }
        }
      }
      if (!embedStyleBaseImageUrl && clientBaseImageUrlEmbed) {
        embedStyleBaseImageUrl = clientBaseImageUrlEmbed;
        embedStyleBaseImageUrls = [clientBaseImageUrlEmbed];
      }

      // Load product type config if provided
      let productType = null;
      if (productTypeId) {
        productType = await storage.getProductType(parseInt(productTypeId));
      }


      


      // Find size config - check product type first, then fall back to PRINT_SIZES
      let sizeConfig = PRINT_SIZES.find(s => s.id === size);
      
      if (!sizeConfig && productType) {
        // Use size-specific or product type's aspect ratio to calculate proper generation dimensions
        const productSizes = JSON.parse(productType.sizes || "[]");
        const productSize = productSizes.find((s: any) => s.id === size);
        const aspectRatioStr = productSize?.aspectRatio || productType.aspectRatio || "3:4";
        const genDims = calculateGenDimensions(aspectRatioStr);
        
        sizeConfig = {
          id: productSize?.id || size,
          name: productSize?.name || size,
          width: productSize?.width || 12,
          height: productSize?.height || 16,
          aspectRatio: aspectRatioStr,
          genWidth: genDims.genWidth,
          genHeight: genDims.genHeight,
        } as any;
      }
      
      if (!sizeConfig) {
        // Default fallback
        sizeConfig = PRINT_SIZES[0];
      }

      // Apply style prompt prefix if available
      // When user provides a description, it becomes the subject; style prefix provides the artistic direction.
      // Pattern: "[userDescription], rendered as [stylePrefix]" so the AI prioritises the user's intent.
      const userDescEmbed = (rawUserPromptEmbed || "").trim();
      let fullPrompt: string;
      if (stylePromptPrefix) {
        if (userDescEmbed) {
          // User description first so the model treats it as the primary subject
          fullPrompt = `${userDescEmbed}, ${stylePromptPrefix}`;
        } else {
          // No description — style prefix drives the generation (uses reference image as subject)
          fullPrompt = stylePromptPrefix;
        }
      } else {
        fullPrompt = prompt;
      }

      // Build shape-specific safe zone instructions
      const printShape = productType?.printShape || "rectangle";
      const bleedMargin = productType?.bleedMarginPercent || 5;
      const safeZonePercent = 100 - (bleedMargin * 2);
      
      let shapeInstructions = "";
      if (printShape === "circle") {
        shapeInstructions = `
CIRCULAR PRINT AREA: This design is for a CIRCULAR product (like a round pillow or coaster).
- Center all important elements (faces, text, focal points) within the inner ${safeZonePercent}% of the circle
- Keep a ${bleedMargin}% margin from the circular edge for manufacturing bleed
- The corners of the canvas will be cropped to a circle - nothing important should be in the corners
- Design with radial/circular composition in mind`;
      } else if (printShape === "square") {
        shapeInstructions = `
SQUARE PRINT AREA: This design is for a square product.
- Center important elements within the inner ${safeZonePercent}% of the canvas
- Keep a ${bleedMargin}% margin from all edges for bleed`;
      } else {
        shapeInstructions = `
RECTANGULAR PRINT AREA:
- Keep important elements within the inner ${safeZonePercent}% of the canvas
- Maintain a ${bleedMargin}% margin from edges for bleed`;
      }

      // Determine aspect ratio and orientation
      const [arW, arH] = sizeConfig.aspectRatio.split(":").map(Number);
      const aspectRatioValue = arW / arH;
      let orientationDescription: string;
      if (aspectRatioValue > 1.05) {
        orientationDescription = `HORIZONTAL LANDSCAPE (wider than tall)`;
      } else if (aspectRatioValue < 0.95) {
        orientationDescription = `VERTICAL PORTRAIT (taller than wide)`;
      } else {
        orientationDescription = `SQUARE`;
      }
      
      // For wrap-around products like tumblers, add specific guidance
      const isWrapAround = aspectRatioValue >= 1.2; // 4:3 or wider is wrap-around
      const textEdgeRestrictions = isWrapAround 
        ? `
TEXT AND ELEMENT PLACEMENT - CRITICAL:
- DO NOT place any text, letters, words, or important elements within 20% of ANY edge
- ALL text must be positioned in the CENTER 60% of the image both horizontally and vertically
- The outer 20% margins on ALL sides should contain ONLY background/scenery - NO text whatsoever
- This is a WRAP-AROUND cylindrical product - edges will be hidden or wrapped around`
        : `
TEXT AND ELEMENT PLACEMENT:
- Keep all text and important elements within the central 75% of the image
- Avoid placing critical content near the edges where it may be cut off during printing`;
      
      const sizingRequirements = `

=== CRITICAL CANVAS REQUIREMENTS (MUST FOLLOW) ===
CANVAS: ${orientationDescription} format
FULL-BLEED MANDATORY: The artwork MUST fill the ENTIRE canvas edge-to-edge with NO blank margins, borders, or empty space. Paint/draw to ALL four edges.
${shapeInstructions}
${textEdgeRestrictions}

=== IMAGE CONTENT REQUIREMENTS ===
1. The background/scene MUST extend fully to ALL four edges - no visible canvas boundaries
2. NO decorative borders, picture frames, drop shadows, or vignettes
3. The subject must NOT appear floating - complete the background behind and around it
4. This is for high-quality printing - create finished artwork that bleeds to all edges
`;

      // Build final prompt: CONSTRAINTS FIRST, then style, then user description
      const geminiAspectRatio = mapToGeminiAspectRatio(sizeConfig.aspectRatio);
      const constraintsFirst = sizingRequirements;
      const styleAndContent = fullPrompt;
      fullPrompt = `${constraintsFirst}\n\n=== ARTWORK DESCRIPTION ===\n${styleAndContent}`;
      
      console.log(`[Shopify Generate] Using Gemini aspect ratio: ${geminiAspectRatio} (from ${sizeConfig.aspectRatio})`);

      // Resolve customer reference image(s) — supports both single and array
      const embedCustomerImageUrls: string[] = [];
      const rawRefImages: string[] = Array.isArray(referenceImagesArr) && referenceImagesArr.length > 0
        ? referenceImagesArr
        : referenceImage ? [referenceImage] : [];
      for (const refImg of rawRefImages.slice(0, 5)) {
        try {
          let resolvedUrl: string | null = null;
          if (refImg.startsWith("data:")) {
            resolvedUrl = refImg;
          } else if (refImg.startsWith("http")) {
            resolvedUrl = refImg;
          } else if (refImg.startsWith("/objects/")) {
            const appUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
            resolvedUrl = `${appUrl}${refImg}`;
          }
          if (resolvedUrl) {
            embedCustomerImageUrls.push(resolvedUrl);
            console.log(`[Shopify Generate] Reference image ${embedCustomerImageUrls.length}: type=${resolvedUrl.startsWith("data:") ? "data-url" : "http-url"}, size=${resolvedUrl.length} chars`);
          }
        } catch (refErr) {
          console.warn("[Shopify Generate] Could not process reference image, skipping:", refErr);
        }
      }
      const embedCustomerImageUrl: string | null = embedCustomerImageUrls[0] || null;

      // Check if this is an apparel product (covers both DB and hardcoded styles)
      let isApparel = productType?.designerType === "apparel";
      if (!isApparel && embedStyleCategory === "apparel") {
        isApparel = true;
      }

      const isAllOverPrint = !!(productType?.isAllOverPrint);
      const embedImageInputUrls: string[] = [];
      // Push all style base images (up to 5), not just the first one
      for (const u of embedStyleBaseImageUrls) embedImageInputUrls.push(u);
      for (const u of embedCustomerImageUrls) embedImageInputUrls.push(u);
      const inputImageUrl: string | string[] | null = embedImageInputUrls.length > 1 ? embedImageInputUrls : embedImageInputUrls[0] || null;

      if (embedImageInputUrls.length > 0) {
        let refInstruction: string;
        if (embedStyleBaseImageUrl && embedCustomerImageUrls.length > 0) {
          refInstruction = `Multiple reference images are provided. The FIRST is a style/scene foundation — use it as the visual template and overall composition guide. The remaining image(s) are the customer's subject(s) — incorporate them into the design as focal elements. Do NOT duplicate or repeat subjects.`;
        } else if (embedCustomerImageUrls.length > 1) {
          refInstruction = `Multiple reference images are provided by the customer. Incorporate all subjects and elements from these images into a cohesive design. Do NOT duplicate subjects.`;
        } else if (embedCustomerImageUrl) {
          const isTextStyle = stylePreset && ["opinionated", "quotes"].includes(stylePreset);
          refInstruction = isTextStyle
            ? `Using the provided reference image as visual inspiration, incorporate its subject as a SINGLE element integrated INTO the typographic composition. Do NOT duplicate the subject.`
            : `Using the provided reference image as visual inspiration, incorporate its key elements, style, and subject into the design.`;
        } else {
          refInstruction = `Using the provided style reference image as visual inspiration and composition guide, create the design following its overall style and layout.`;
        }
        fullPrompt = `${refInstruction} ${fullPrompt}`;
      }

      // Generate image via Replicate
      const { data: base64Data, mimeType: generatedMimeType } = await generateImageBase64({
        prompt: fullPrompt,
        aspectRatio: geminiAspectRatio ?? "1:1",
        inputImageUrl,
        isApparel,
        isAllOverPrint,
      });

      if (!base64Data) {
        console.error("[Shopify Generate] Replicate returned no image data");
        return res.status(500).json({ error: "Failed to generate image" });
      }

      const mimeType = generatedMimeType || "image/png";
      
      // Get target dimensions for resizing - skip for apparel (keep square)
      let targetDims: TargetDimensions | undefined;
      if (!isApparel) {
        const genWidth = (sizeConfig as any).genWidth || 1024;
        const genHeight = (sizeConfig as any).genHeight || 1024;
        targetDims = { width: genWidth, height: genHeight };
      }
      
      // Save image to object storage (retry once, then fall back to data URL)
      let imageUrl: string;
      let thumbnailUrl: string | undefined;
      try {
        const result = await saveImageToStorage(base64Data, mimeType, {
          isApparel,
          isAllOverPrint,
          targetDims,
        });
        imageUrl = result.imageUrl;
        thumbnailUrl = result.thumbnailUrl;
      } catch (storageError) {
        console.warn("[Shopify Generate] Storage save failed, retrying once:", storageError);
        try {
          const result = await saveImageToStorage(base64Data, mimeType, {
            isApparel,
            isAllOverPrint,
            targetDims,
          });
          imageUrl = result.imageUrl;
          thumbnailUrl = result.thumbnailUrl;
        } catch (retryError) {
          // Fall back to data URL so the user still sees their generated image.
          // The client's ensureHostedUrl() will upload data URLs to storage
          // before sending them to the mockup endpoint.
          console.error("[Shopify Generate] Storage save failed on retry, falling back to data URL:", retryError);
          imageUrl = `data:${mimeType};base64,${base64Data}`;
        }
      }

      const designId = `shopify-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Log the generation only if credits were deducted from a customer account
      if (creditDeducted && customer) {
        await storage.createCreditTransaction({
          customerId: customer.id,
          type: "generation",
          amount: -1,
          description: `Shopify artwork: ${prompt.substring(0, 50)}...`,
        });
      }

      res.json({
        imageUrl,
        thumbnailUrl,
        designId,
        prompt,
        creditsRemaining: customer?.credits ?? 0,
      });
    } catch (error) {
      console.error("Error generating Shopify artwork:", error);
      // Note: Credit was already deducted. In production, consider refunding on failure.
      res.status(500).json({ error: "Failed to generate artwork" });
    }
  });

  // ==================== SHOPIFY PRODUCT CREATION ====================

  /**
   * Returns the correct Shopify option name for the "color" dimension.
   * For phone cases, frameColors contains device models (iPhone 14, Galaxy S23, etc.)
   * so we label the option "Model" instead of "Color".
   */
  function getColorOptionName(colors: Array<{ id: string; name: string; hex?: string }>, storedName?: string | null): string {
    // 1. Use the stored name from Printify blueprint if available
    if (storedName && storedName.trim().length > 0) {
      return storedName;
    }

    // 2. Fallback to heuristic if no stored name
    if (!colors || colors.length === 0) return "Color";
    
    const phoneModelPatterns = [
      /^iphone\s+(\d|x|xs|xr|se|pro|plus|max)/i,
      /^samsung\s+(galaxy|note)/i,
      /^galaxy\s+/i,
      /^pixel\s+\d/i,
      /^for\s+(iphone|galaxy|pixel|samsung)/i,
      /^(iphone|samsung|galaxy|pixel|oneplus|motorola|lg|htc)\b/i,
      /^\d+\s+(pro|plus|max|mini)/i,
      /^(pro|plus|max|mini)\b/i,
    ];
    const isPhoneModel = colors.some((c) =>
      phoneModelPatterns.some((p) => p.test((c.name || "").trim()))
    );
    if (isPhoneModel) return "Model";

    // 3. Check for known color terms
    const colorTerms = ["black", "white", "red", "blue", "green", "yellow", "pink", "purple", "orange", "gray", "grey", "navy", "brown", "beige", "cream", "tan", "gold", "silver", "oak", "walnut", "cherry", "mahogany", "espresso", "natural"];
    const hasColors = colors.some(c => {
      const name = (c.name || "").toLowerCase();
      return colorTerms.some(term => name.includes(term));
    });
    if (hasColors) return "Color";

    // 4. Final fallback for unknown non-phone, non-color options (like "Polyester Fleece")
    return "Option";
  }

  // Create a draft product in merchant's Shopify store with design studio widget
  /**
   * Shared helper: create (or re-create) a Shopify product for a given product type.
   * Called directly (no HTTP) so it works inside other route handlers.
   * Returns { shopifyProductId, shopifyHandle } on success, throws on failure.
   */
  async function createShopifyProductForType(
    shop: string,
    accessToken: string,
    productType: any,
    merchant: any,
    selectedColorIds?: string[],
    variantPrices?: Record<string, string>,
  ): Promise<{ shopifyProductId: string; shopifyHandle: string }> {
    const allSizes = typeof productType.sizes === 'string' ? JSON.parse(productType.sizes) : productType.sizes || [];
    const allColors = typeof productType.frameColors === 'string' ? JSON.parse(productType.frameColors) : productType.frameColors || [];
    const baseMockupImages = typeof productType.baseMockupImages === 'string' ? JSON.parse(productType.baseMockupImages) : productType.baseMockupImages || {};
    const variantMap = typeof productType.variantMap === 'string' ? JSON.parse(productType.variantMap) : productType.variantMap || {};

    const savedSizeIds: string[] = typeof productType.selectedSizeIds === 'string' ? JSON.parse(productType.selectedSizeIds || '[]') : productType.selectedSizeIds || [];
    const savedColorIds: string[] = typeof productType.selectedColorIds === 'string' ? JSON.parse(productType.selectedColorIds || '[]') : productType.selectedColorIds || [];

    const sizeIdsToUse = savedSizeIds.length > 0 ? savedSizeIds : allSizes.map((s: any) => s.id);
    const colorIdsToUse = selectedColorIds && selectedColorIds.length > 0 ? selectedColorIds : savedColorIds.length > 0 ? savedColorIds : allColors.map((c: any) => c.id);

    const sizesToUse = allSizes.filter((s: any) => sizeIdsToUse.includes(s.id));
    const colorsToUse = allColors.filter((c: any) => colorIdsToUse.includes(c.id));
    const priceMap: Record<string, string> = variantPrices && typeof variantPrices === 'object' ? variantPrices : {};

    const shopifyVariants: any[] = [];
    if (colorsToUse.length > 0) {
      for (const size of sizesToUse) {
        for (const color of colorsToUse) {
          const variantKey = `${size.id}:${color.id}`;
          if (variantMap[variantKey]) {
            const p = priceMap[variantKey];
            shopifyVariants.push({ option1: size.name, option2: color.name, price: p && parseFloat(p) > 0 ? parseFloat(p).toFixed(2) : '0.00', sku: `${productType.printifyBlueprintId || 'PT'}-${size.id}-${color.id}`, inventory_management: null, inventory_policy: 'continue' });
          }
        }
      }
    }

    // If no variants were produced by the color loop (e.g. phone cases where most variants use
    // 'default' as the color key even though a stray color entry exists in frameColors), fall back
    // to the size-only path and look for '{sizeId}:default' keys in the variantMap.
    if (shopifyVariants.length === 0) {
      for (const size of sizesToUse) {
        const variantKey = `${size.id}:default`;
        if (variantMap[variantKey]) {
          const p = priceMap[variantKey];
          shopifyVariants.push({ option1: size.name, price: p && parseFloat(p) > 0 ? parseFloat(p).toFixed(2) : '0.00', sku: `${productType.printifyBlueprintId || 'PT'}-${size.id}`, inventory_management: null, inventory_policy: 'continue' });
        }
      }
    }

    // If no variants were found in variantMap, create a default one from sizes and colors
    if (shopifyVariants.length === 0) {
      console.warn(`[createShopifyProductForType] variantMap is empty or has no matching entries. Creating default variants from sizes/colors.`);
      // Create default variants for all size/color combinations
      if (colorsToUse.length > 0) {
        for (const size of sizesToUse) {
          for (const color of colorsToUse) {
            shopifyVariants.push({ option1: size.name, option2: color.name, price: '0.00', sku: `${productType.printifyBlueprintId || 'PT'}-${size.id}-${color.id}`, inventory_management: null, inventory_policy: 'continue' });
          }
        }
      } else {
        for (const size of sizesToUse) {
          shopifyVariants.push({ option1: size.name, price: '0.00', sku: `${productType.printifyBlueprintId || 'PT'}-${size.id}`, inventory_management: null, inventory_policy: 'continue' });
        }
      }
    }
    if (shopifyVariants.length === 0) throw new Error('No variants to create — check size/color selections.');
    if (shopifyVariants.length > 100) throw new Error(`Too many variants (${shopifyVariants.length}). Shopify allows max 100.`);

    const productOptions: any[] = [];
    if (allSizes.length > 0) productOptions.push({ name: 'Size', values: Array.from(new Set(shopifyVariants.map((v: any) => v.option1))) });
    if (allColors.length > 0) productOptions.push({ name: getColorOptionName(allColors, productType.colorOptionName), values: Array.from(new Set(shopifyVariants.filter((v: any) => v.option2).map((v: any) => v.option2!))) });

    const images: any[] = [];
    if (baseMockupImages.front) images.push({ src: baseMockupImages.front, alt: `${productType.name} - Front` });
    if (baseMockupImages.lifestyle) images.push({ src: baseMockupImages.lifestyle, alt: `${productType.name} - Lifestyle` });

    const cleanDescription = (productType.description || '').replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    const appUrl = (process.env.PUBLIC_APP_URL || process.env.APP_URL || '').replace(/\/$/, '') || `http://localhost:${process.env.PORT || 5000}`;
    const displayName = productType.name;

    const shopifyProduct = {
      product: {
        title: `Custom ${productType.name}`,
        body_html: `<div style="padding: 15px 0;"><h4 style="margin: 0 0 10px 0; font-size: 16px; font-weight: 600;">Product Details</h4><p>${cleanDescription}</p></div>`,
        vendor: merchant.storeName || 'AI Art Studio',
        product_type: productType.name,
        status: 'unlisted',
        published: false,
        tags: ['custom-design', 'ai-artwork', 'design-studio', 'ai-art-studio-enabled'],
        options: productOptions.length > 0 ? productOptions : undefined,
        variants: shopifyVariants.length > 0 ? shopifyVariants : [{ price: '0.00' }],
        images: images.length > 0 ? images : undefined,
        metafields: [
          { namespace: 'ai_art_studio', key: 'enable', value: 'true', type: 'single_line_text_field' },
          { namespace: 'ai_art_studio', key: 'product_type_id', value: String(productType.id), type: 'single_line_text_field' },
          { namespace: 'ai_art_studio', key: 'app_url', value: appUrl, type: 'single_line_text_field' },
          { namespace: 'ai_art_studio', key: 'display_name', value: displayName, type: 'single_line_text_field' },
          { namespace: 'ai_art_studio', key: 'description', value: `Use AI to generate a unique artwork for your ${displayName.toLowerCase()}. Describe your vision and our AI will bring it to life.`, type: 'single_line_text_field' },
          { namespace: 'ai_art_studio', key: 'design_studio_url', value: `${appUrl}/embed/design?productTypeId=${productType.id}`, type: 'single_line_text_field' },
          { namespace: 'ai_art_studio', key: 'hide_add_to_cart', value: 'true', type: 'single_line_text_field' },
        ],
      },
    };

    // Delete existing Shopify product if present (re-publish scenario)
    if (productType.shopifyProductId) {
      try {
        await fetch(`https://${shop}/admin/api/2025-10/products/${productType.shopifyProductId}.json`, { method: 'DELETE', headers: { 'X-Shopify-Access-Token': accessToken } });
      } catch (_) { /* ignore delete errors */ }
    }

    const shopifyResponse = await fetch(`https://${shop}/admin/api/2025-10/products.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify(shopifyProduct),
    });

    if (!shopifyResponse.ok) {
      const errorText = await shopifyResponse.text();
      throw new Error(`Shopify API error ${shopifyResponse.status}: ${errorText}`);
    }

    const createdProduct = await shopifyResponse.json();
    const newShopifyProductId = String(createdProduct.product.id);
    const shopifyHandle = createdProduct.product.handle;
    const createdVariants = createdProduct.product.variants || [];

    const shopifyVariantIds: Record<string, number> = {};
    for (const v of createdVariants) {
      const sizeOption = v.option1 || 'default';
      const colorOption = v.option2 || 'default';
      shopifyVariantIds[`${sizeOption}:${colorOption}`] = v.id;
    }

    try { await ensureProductPublishedToOnlineStore(shop, accessToken, newShopifyProductId); } catch (_) { /* non-fatal */ }

    await storage.updateProductType(productType.id, {
      shopifyProductId: newShopifyProductId,
      shopifyProductHandle: shopifyHandle,
      shopifyProductUrl: `https://${shop}/admin/products/${newShopifyProductId}`,
      shopifyShopDomain: shop,
      shopifyVariantIds: shopifyVariantIds,
      lastPushedToShopify: new Date(),
    });

    return { shopifyProductId: newShopifyProductId, shopifyHandle };
  }

  app.post("/api/shopify/products", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(403).json({ error: "Merchant not found" });
      }

      const { productTypeId, shopDomain, selectedColorIds, variantPrices } = req.body;

      if (!productTypeId) {
        return res.status(400).json({ error: "Product type ID is required" });
      }

      if (!shopDomain) {
        return res.status(400).json({ error: "Shop domain is required" });
      }

      // Validate shop domain format
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
        return res.status(400).json({ error: "Invalid shop domain format" });
      }

      // Get the Shopify installation for this shop
      const installation = await storage.getShopifyInstallationByShop(shopDomain);
      if (!installation || installation.status !== "active") {
        return res.status(400).json({ 
          error: "Shopify store not connected",
          details: "Please install the app on your Shopify store first"
        });
      }

      // Security: Verify the installation belongs to this merchant
      // If merchantId is set, it must match. If not set, link it to this merchant.
      if (installation.merchantId && installation.merchantId !== merchant.id) {
        return res.status(403).json({ 
          error: "Access denied",
          details: "This Shopify store is linked to a different merchant account"
        });
      }
      
      // Link unlinked installations to the current merchant
      if (!installation.merchantId) {
        await storage.updateShopifyInstallation(installation.id, {
          merchantId: merchant.id,
        });
      }

      // Get the product type data
      const productType = await storage.getProductType(productTypeId);
      if (!productType) {
        return res.status(404).json({ error: "Product type not found" });
      }

      // Security: Verify the product type belongs to this merchant
      if (productType.merchantId && productType.merchantId !== merchant.id) {
        return res.status(403).json({ 
          error: "Access denied",
          details: "This product type belongs to a different merchant"
        });
      }

      // Handle republishing: If product already exists in Shopify, delete it first
      // This ensures variant IDs are always up-to-date with the current access token
      if (productType.shopifyProductId) {
        // Verify this product was published to the same shop - prevent cross-shop deletion
        const existingShopDomain = productType.shopifyShopDomain;
        
        // Safety guard: If we have a product ID but no shop domain (legacy record), 
        // cannot safely delete - just clear local data and create new
        if (!existingShopDomain) {
          console.log(`[Shopify Publish] Legacy product record without shop domain - clearing and creating new`);
          await storage.updateProductType(productType.id, {
            shopifyProductId: null,
            shopifyProductHandle: null,
            shopifyProductUrl: null,
            shopifyShopDomain: null,
            shopifyVariantIds: null,
          });
        } else if (existingShopDomain !== shopDomain) {
          console.log(`[Shopify Publish] Product was published to ${existingShopDomain}, but publishing to ${shopDomain} - creating new product`);
          // Different shop - don't delete, just clear local data and create new
          await storage.updateProductType(productType.id, {
            shopifyProductId: null,
            shopifyProductHandle: null,
            shopifyProductUrl: null,
            shopifyShopDomain: null,
            shopifyVariantIds: null,
          });
        } else {
          console.log(`[Shopify Publish] Product already exists (${productType.shopifyProductId}), deleting for republish...`);
          
          try {
            const deleteResponse = await fetch(
              `https://${shopDomain}/admin/api/2025-10/products/${productType.shopifyProductId}.json`,
              {
                method: "DELETE",
                headers: {
                  "X-Shopify-Access-Token": installation.accessToken,
                  "Content-Type": "application/json",
                },
              }
            );
            
            if (deleteResponse.ok || deleteResponse.status === 404) {
              console.log(`[Shopify Publish] Previous product deleted (or already gone)`);
              // Clear old data before creating new product
              await storage.updateProductType(productType.id, {
                shopifyProductId: null,
                shopifyProductHandle: null,
                shopifyProductUrl: null,
                shopifyShopDomain: null,
                shopifyVariantIds: null,
              });
            } else if (deleteResponse.status === 401 || deleteResponse.status === 403) {
              // Token is invalid - abort publish and require reinstall
              console.error(`[Shopify Publish] Token invalid (${deleteResponse.status}), aborting publish`);
              await storage.updateShopifyInstallation(installation.id, {
                status: "token_invalid",
                accessToken: "", // Clear invalid token
              });
              return res.status(401).json({
                error: "Shopify connection expired",
                details: "Please reinstall the app on your Shopify store to restore the connection",
                needsReinstall: true,
                reinstallUrl: `/shopify/install?shop=${encodeURIComponent(shopDomain)}`
              });
            } else {
              // Other errors (500, 429, etc.) - abort to prevent orphaned products
              console.error(`[Shopify Publish] Failed to delete old product: ${deleteResponse.status}`);
              return res.status(500).json({
                error: "Failed to update existing product",
                details: `Could not remove the existing Shopify product (error ${deleteResponse.status}). Please try again or delete the product manually in Shopify admin.`
              });
            }
          } catch (deleteError) {
            console.error(`[Shopify Publish] Error deleting old product:`, deleteError);
            return res.status(500).json({
              error: "Failed to update existing product",
              details: "Network error while removing the existing product. Please try again."
            });
          }
        }
      }

      // Parse product type data
      const allSizes = typeof productType.sizes === 'string' 
        ? JSON.parse(productType.sizes) 
        : productType.sizes || [];
      const allColors = typeof productType.frameColors === 'string' 
        ? JSON.parse(productType.frameColors) 
        : productType.frameColors || [];
      const baseMockupImages = typeof productType.baseMockupImages === 'string'
        ? JSON.parse(productType.baseMockupImages)
        : productType.baseMockupImages || {};
      const variantMap = typeof productType.variantMap === 'string'
        ? JSON.parse(productType.variantMap)
        : productType.variantMap || {};
      
      // Parse saved variant selections from product type
      const savedSizeIds: string[] = typeof productType.selectedSizeIds === 'string'
        ? JSON.parse(productType.selectedSizeIds || "[]")
        : productType.selectedSizeIds || [];
      const savedColorIds: string[] = typeof productType.selectedColorIds === 'string'
        ? JSON.parse(productType.selectedColorIds || "[]")
        : productType.selectedColorIds || [];

      // Build variants for Shopify
      // For products with both sizes and colors, create a variant for each combination
      // For products with only sizes (no colors), create a variant for each size
      const shopifyVariants: Array<{
        option1: string;
        option2?: string;
        price: string;
        sku: string;
        inventory_management: null;
        inventory_policy: string;
      }> = [];

      // Use saved selections if available, otherwise use request params or all available
      const sizeIdsToUse = savedSizeIds.length > 0 ? savedSizeIds : allSizes.map((s: { id: string }) => s.id);
      const colorIdsToUse = selectedColorIds && selectedColorIds.length > 0 
        ? selectedColorIds 
        : savedColorIds.length > 0 
          ? savedColorIds 
          : allColors.map((c: { id: string }) => c.id);

      // Filter sizes and colors based on selections
      const sizesToUse = allSizes.filter((s: { id: string }) => sizeIdsToUse.includes(s.id));
      const colorsToUse = allColors.filter((c: { id: string }) => colorIdsToUse.includes(c.id));

      // variantPrices is keyed by "sizeId:colorId" (or "sizeId:default") → price string
      const priceMap: Record<string, string> = variantPrices && typeof variantPrices === "object" ? variantPrices : {};

      if (colorsToUse.length > 0) {
        for (const size of sizesToUse) {
          for (const color of colorsToUse) {
            const variantKey = `${size.id}:${color.id}`;
            if (variantMap[variantKey]) {
              const p = priceMap[variantKey];
              shopifyVariants.push({
                option1: size.name,
                option2: color.name,
                price: p && parseFloat(p) > 0 ? parseFloat(p).toFixed(2) : "0.00",
                sku: `${productType.printifyBlueprintId || 'PT'}-${size.id}-${color.id}`,
                inventory_management: null,
                inventory_policy: "continue",
              });
            }
          }
        }
      } else if (allColors.length === 0) {
        for (const size of sizesToUse) {
          const variantKey = `${size.id}:default`;
          if (variantMap[variantKey]) {
            const p = priceMap[variantKey];
            shopifyVariants.push({
              option1: size.name,
              price: p && parseFloat(p) > 0 ? parseFloat(p).toFixed(2) : "0.00",
              sku: `${productType.printifyBlueprintId || 'PT'}-${size.id}`,
              inventory_management: null,
              inventory_policy: "continue", // Allow overselling (POD)
            });
          }
        }
      }

      // Validate Shopify's 100 variant limit
      const SHOPIFY_VARIANT_LIMIT = 100;
      if (shopifyVariants.length > SHOPIFY_VARIANT_LIMIT) {
        return res.status(400).json({ 
          error: `Too many variants (${shopifyVariants.length})`,
          details: `Shopify allows a maximum of ${SHOPIFY_VARIANT_LIMIT} variants per product. Please select fewer colors.`
        });
      }

      if (shopifyVariants.length === 0) {
        return res.status(400).json({ 
          error: "No variants to create",
          details: "Please select at least one color to include in the product."
        });
      }

      // Build product options
      const productOptions: Array<{ name: string; values: string[] }> = [];
      
      if (allSizes.length > 0) {
        productOptions.push({
          name: "Size",
          values: Array.from(new Set(shopifyVariants.map(v => v.option1))),
        });
      }
      
      if (allColors.length > 0) {
        productOptions.push({
          name: getColorOptionName(allColors),
          values: Array.from(new Set(shopifyVariants.filter(v => v.option2).map(v => v.option2!))),
        });
      }

      // Build images array from mockups
      const images: Array<{ src: string; alt: string }> = [];
      if (baseMockupImages.front) {
        images.push({ src: baseMockupImages.front, alt: `${productType.name} - Front` });
      }
      if (baseMockupImages.lifestyle) {
        images.push({ src: baseMockupImages.lifestyle, alt: `${productType.name} - Lifestyle` });
      }

      // Strip HTML from description for cleaner Shopify display
      const cleanDescription = (productType.description || "")
        .replace(/<[^>]*>/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();

      // Get the app URL for the design studio embed
     const appUrl =
  (process.env.PUBLIC_APP_URL || process.env.APP_URL || "").replace(/\/$/, "") ||
  `http://localhost:${process.env.PORT || 5000}`;

      // Create display name for dynamic text (strip "Custom" prefix if product title would have it)
      const displayName = productType.name;

      // Create the product in Shopify configured for Online Store only
      // Note: The design studio is embedded via theme extension (ai-art-embed.liquid) using metafields
      const shopifyProduct = {
        product: {
          title: `Custom ${productType.name}`,
          // Note: The design studio is embedded via theme extension (ai-art-embed.liquid)
          // No iframe here to avoid duplicates - metafields control the embed
          body_html: `
            <div style="padding: 15px 0;">
              <h4 style="margin: 0 0 10px 0; font-size: 16px; font-weight: 600;">Product Details</h4>
              <p>${cleanDescription}</p>
            </div>
          `,
          vendor: merchant.storeName || "AI Art Studio",
          product_type: productType.name,
          status: "unlisted",
          published: false,
          tags: ["custom-design", "ai-artwork", "design-studio", "ai-art-studio-enabled"],
          options: productOptions.length > 0 ? productOptions : undefined,
          variants: shopifyVariants.length > 0 ? shopifyVariants : [{ price: "0.00" }],
          images: images.length > 0 ? images : undefined,
          metafields: [
            {
              namespace: "ai_art_studio",
              key: "enable",
              value: "true",
              type: "single_line_text_field",
            },
            {
              namespace: "ai_art_studio",
              key: "product_type_id",
              value: String(productType.id),
              type: "single_line_text_field",
            },
            {
              namespace: "ai_art_studio", 
              key: "app_url",
              value: appUrl,
              type: "single_line_text_field",
            },
            {
              namespace: "ai_art_studio", 
              key: "display_name",
              value: displayName,
              type: "single_line_text_field",
            },
            {
              namespace: "ai_art_studio", 
              key: "description",
              value: `Use AI to generate a unique artwork for your ${displayName.toLowerCase()}. Describe your vision and our AI will bring it to life.`,
              type: "single_line_text_field",
            },
            {
              namespace: "ai_art_studio", 
              key: "design_studio_url",
              value: `${appUrl}/embed/design?productTypeId=${productType.id}`,
              type: "single_line_text_field",
            },
            {
              namespace: "ai_art_studio",
              key: "hide_add_to_cart",
              value: "true",
              type: "single_line_text_field",
            },
          ],
        },
      };

      // Call Shopify Admin API to create the product
      const shopifyResponse = await fetch(
        `https://${shopDomain}/admin/api/2025-10/products.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": installation.accessToken,
          },
          body: JSON.stringify(shopifyProduct),
        }
      );

      if (!shopifyResponse.ok) {
        const errorText = await shopifyResponse.text();
        console.error("Shopify API error:", shopifyResponse.status, errorText);
        
        // Handle token expiration
        if (shopifyResponse.status === 401 || shopifyResponse.status === 403) {
          await storage.updateShopifyInstallation(installation.id, {
            status: "token_invalid",
            accessToken: "", // Clear invalid token
          });
          return res.status(401).json({
            error: "Shopify connection expired",
            details: "Please reinstall the app on your Shopify store to restore the connection",
            needsReinstall: true,
            reinstallUrl: `/shopify/install?shop=${encodeURIComponent(shopDomain)}`
          });
        }
        
        return res.status(shopifyResponse.status).json({ 
          error: "Failed to create Shopify product",
          details: errorText
        });
      }

      const createdProduct = await shopifyResponse.json();
      const shopifyProductId = createdProduct.product.id;
      const shopifyHandle = createdProduct.product.handle;
      const createdVariants = createdProduct.product.variants || [];
      
      console.log(`Created Shopify product ${shopifyProductId} (handle: ${shopifyHandle}) for product type ${productType.id}`);

      // Build a map of size:color to Shopify variant ID for future lookups
      const shopifyVariantIds: Record<string, number> = {};
      for (const v of createdVariants) {
        const sizeOption = v.option1 || 'default';
        const colorOption = v.option2 || 'default';
        const key = `${sizeOption}:${colorOption}`;
        shopifyVariantIds[key] = v.id;
      }

      // Publish to Online Store so /cart/add.js accepts the variant IDs
      try {
        await ensureProductPublishedToOnlineStore(shopDomain, installation.accessToken, shopifyProductId);
        console.log(`Product ${shopifyProductId} published to Online Store sales channel`);
      } catch (pubErr: any) {
        console.warn(`Failed to publish product ${shopifyProductId} to Online Store: ${pubErr.message}`);
      }

      // Save Shopify product ID, handle, shop domain, and variant IDs to the product type for future updates
      await storage.updateProductType(productType.id, {
        shopifyProductId: String(shopifyProductId),
        shopifyProductHandle: shopifyHandle,
        shopifyProductUrl: `https://${shopDomain}/admin/products/${shopifyProductId}`,
        shopifyShopDomain: shopDomain, // Track which shop this was published to
        shopifyVariantIds: shopifyVariantIds,
        lastPushedToShopify: new Date(),
      });

      res.json({
        success: true,
        shopifyProductId: shopifyProductId,
        shopifyProductHandle: createdProduct.product.handle,
        adminUrl: `https://${shopDomain}/admin/products/${shopifyProductId}`,
        message: "Product created as draft for Online Store only. The AI Design Studio will appear automatically when you activate the product. Set your retail prices and publish when ready.",
      });

    } catch (error) {
      console.error("Error creating Shopify product:", error);
      res.status(500).json({ error: "Failed to create Shopify product" });
    }
  });

  // ==================== MERCHANT SHOPIFY INSTALLATIONS ====================
  // NOTE: Main installations endpoint is defined later with auto-creation logic

  // ==================== SHOPIFY PRODUCT UPDATE ====================
  // Update an existing Shopify product with new variants/info from local product type
  app.put("/api/shopify/products/:productTypeId", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      const productTypeId = parseInt(req.params.productTypeId);
      
      if (!merchant) {
        return res.status(403).json({ error: "Merchant not found" });
      }

      const { shopDomain } = req.body;

      if (!shopDomain) {
        return res.status(400).json({ error: "Shop domain is required" });
      }

      // Validate shop domain format
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
        return res.status(400).json({ error: "Invalid shop domain format" });
      }

      // Get the product type
      const productType = await storage.getProductType(productTypeId);
      if (!productType) {
        return res.status(404).json({ error: "Product type not found" });
      }

      // Security: Verify ownership - must match current merchant
      // Reject unowned product types - they need to be claimed via proper import flow first
      if (!productType.merchantId) {
        return res.status(403).json({ 
          error: "Product not linked to merchant",
          details: "This product type is not associated with any merchant. Please re-import it from Printify."
        });
      }
      
      if (productType.merchantId !== merchant.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      // If product was not pushed to Shopify, we'll create it now
      if (!productType.shopifyProductId) {
        console.log(`[Update Shopify] Product ${productTypeId} not yet in Shopify. Creating now...`);
        
        // Get installation
        const installation = await storage.getShopifyInstallationByShop(shopDomain);
        if (!installation || installation.status !== "active") {
          return res.status(400).json({ error: "Shopify store not connected" });
        }

        try {
          // Build product creation payload inline (same logic as POST /api/shopify/products)
          const allSizes = typeof productType.sizes === 'string' ? JSON.parse(productType.sizes) : productType.sizes || [];
          const allColors = typeof productType.frameColors === 'string' ? JSON.parse(productType.frameColors) : productType.frameColors || [];
          const baseMockupImages = typeof productType.baseMockupImages === 'string' ? JSON.parse(productType.baseMockupImages) : productType.baseMockupImages || {};
          const variantMap = typeof productType.variantMap === 'string' ? JSON.parse(productType.variantMap) : productType.variantMap || {};
          const savedSizeIds: string[] = typeof productType.selectedSizeIds === 'string' ? JSON.parse(productType.selectedSizeIds || "[]") : productType.selectedSizeIds || [];
          const savedColorIds: string[] = typeof productType.selectedColorIds === 'string' ? JSON.parse(productType.selectedColorIds || "[]") : productType.selectedColorIds || [];

          const shopifyVariants: Array<{ option1: string; option2?: string; price: string; sku: string; inventory_management: null; inventory_policy: string }> = [];
          const sizeIdsToUse = savedSizeIds.length > 0 ? savedSizeIds : allSizes.map((s: { id: string }) => s.id);
          const colorIdsToUse = savedColorIds.length > 0 ? savedColorIds : allColors.map((c: { id: string }) => c.id);
          const sizesToUse = allSizes.filter((s: { id: string }) => sizeIdsToUse.includes(s.id));
          const colorsToUse = allColors.filter((c: { id: string }) => colorIdsToUse.includes(c.id));

          if (colorsToUse.length > 0) {
            for (const size of sizesToUse) {
              for (const color of colorsToUse) {
                const variantKey = `${size.id}:${color.id}`;
                if (variantMap[variantKey]) {
                  shopifyVariants.push({ option1: size.name, option2: color.name, price: "0.00", sku: `${productType.printifyBlueprintId || 'PT'}-${size.id}-${color.id}`, inventory_management: null, inventory_policy: "continue" });
                }
              }
            }
          } else if (allColors.length === 0) {
            for (const size of sizesToUse) {
              const variantKey = `${size.id}:default`;
              if (variantMap[variantKey]) {
                shopifyVariants.push({ option1: size.name, price: "0.00", sku: `${productType.printifyBlueprintId || 'PT'}-${size.id}`, inventory_management: null, inventory_policy: "continue" });
              }
            }
          }

          const productOptions: Array<{ name: string; values: string[] }> = [];
          if (allSizes.length > 0) productOptions.push({ name: "Size", values: Array.from(new Set(shopifyVariants.map(v => v.option1))) });
          if (allColors.length > 0) productOptions.push({ name: getColorOptionName(allColors), values: Array.from(new Set(shopifyVariants.filter(v => v.option2).map(v => v.option2!))) });

          const images: Array<{ src: string; alt: string }> = [];
          if (baseMockupImages.front) images.push({ src: baseMockupImages.front, alt: `${productType.name} - Front` });
          if (baseMockupImages.lifestyle) images.push({ src: baseMockupImages.lifestyle, alt: `${productType.name} - Lifestyle` });

          const cleanDescription = (productType.description || "").replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
          const displayName = productType.name;
          const appUrl = (process.env.PUBLIC_APP_URL || process.env.APP_URL || "").replace(/\/$/, "") || `http://localhost:${process.env.PORT || 5000}`;

          const shopifyProduct = {
            product: {
              title: `Custom ${productType.name}`,
              body_html: `<div style="padding: 15px 0;"><h4 style="margin: 0 0 10px 0; font-size: 16px; font-weight: 600;">Product Details</h4><p>${cleanDescription}</p></div>`,
              vendor: merchant.storeName || "AI Art Studio",
              product_type: productType.designerType,
              status: "unlisted",
              published: false,
              tags: ["custom-design", "ai-artwork", "design-studio", "ai-art-studio-enabled"],
              options: productOptions.length > 0 ? productOptions : undefined,
              variants: shopifyVariants.length > 0 ? shopifyVariants : [{ price: "0.00" }],
              images: images.length > 0 ? images : undefined,
              metafields: [
                { namespace: "ai_art_studio", key: "enable", value: "true", type: "single_line_text_field" },
                { namespace: "ai_art_studio", key: "product_type_id", value: String(productType.id), type: "single_line_text_field" },
                { namespace: "ai_art_studio", key: "app_url", value: appUrl, type: "single_line_text_field" },
                { namespace: "ai_art_studio", key: "display_name", value: displayName, type: "single_line_text_field" },
                { namespace: "ai_art_studio", key: "description", value: `Use AI to generate a unique artwork for your ${displayName.toLowerCase()}. Describe your vision and our AI will bring it to life.`, type: "single_line_text_field" },
                { namespace: "ai_art_studio", key: "design_studio_url", value: `${appUrl}/embed/design?productTypeId=${productType.id}`, type: "single_line_text_field" },
                { namespace: "ai_art_studio", key: "hide_add_to_cart", value: "true", type: "single_line_text_field" },
              ],
            },
          };

          const shopifyResponse = await fetch(`https://${shopDomain}/admin/api/2025-10/products.json`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": installation.accessToken },
            body: JSON.stringify(shopifyProduct),
          });

          if (!shopifyResponse.ok) {
            const errorText = await shopifyResponse.text();
            console.error("[Update Shopify] Create product API error:", shopifyResponse.status, errorText);
            return res.status(shopifyResponse.status).json({ error: "Failed to create Shopify product", details: errorText });
          }

          const createdProduct = await shopifyResponse.json();
          const shopifyProductId = createdProduct.product.id;
          const shopifyHandle = createdProduct.product.handle;
          const createdVariants = createdProduct.product.variants || [];

          const shopifyVariantIds: Record<string, number> = {};
          for (const v of createdVariants) {
            const key = `${v.option1 || 'default'}:${v.option2 || 'default'}`;
            shopifyVariantIds[key] = v.id;
          }

          // Publish to Online Store so /cart/add.js accepts the variant IDs
          try {
            await ensureProductPublishedToOnlineStore(shopDomain, installation.accessToken, shopifyProductId);
            console.log(`Product ${shopifyProductId} published to Online Store sales channel`);
          } catch (pubErr: any) {
            console.warn(`Failed to publish product ${shopifyProductId} to Online Store: ${pubErr.message}`);
          }

          // Save Shopify product ID, handle, shop domain, and variant IDs
          await storage.updateProductType(productTypeId, {
            shopifyProductId: String(shopifyProductId),
            shopifyProductHandle: shopifyHandle,
            shopifyProductUrl: `https://${shopDomain}/admin/products/${shopifyProductId}`,
            shopifyShopDomain: shopDomain,
            shopifyVariantIds: shopifyVariantIds,
            lastPushedToShopify: new Date(),
          });

          return res.json({
            success: true,
            message: "Product created in Shopify",
            shopifyProductId: shopifyProductId,
            adminUrl: `https://${shopDomain}/admin/products/${shopifyProductId}`,
          });
        } catch (err: any) {
          console.error("[Update Shopify] Failed to create product:", err);
          return res.status(500).json({ error: "Failed to create Shopify product", details: err.message });
        }
      }

      // Get installation
      const installation = await storage.getShopifyInstallationByShop(shopDomain);
      if (!installation || installation.status !== "active") {
        return res.status(400).json({ error: "Shopify store not connected" });
      }

      // Security: Verify the installation belongs to this merchant
      if (!installation.merchantId) {
        // Link unlinked installations to the current merchant
        await storage.updateShopifyInstallation(installation.id, {
          merchantId: merchant.id,
        });
      } else if (installation.merchantId !== merchant.id) {
        return res.status(403).json({ 
          error: "Access denied",
          details: "This Shopify store is linked to a different merchant account"
        });
      }

      // Refresh Shopify: delete the existing product and re-create it from scratch.
      // This is the only reliable way to update Shopify variants (Shopify's REST API
      // does not support replacing all variants in a single PUT call).
      // We always delete-and-recreate so the variant list stays in sync with the DB.
      console.log(`[Update Shopify] Deleting existing product ${productType.shopifyProductId} to re-create with correct variants...`);

      const deleteResp = await fetch(
        `https://${shopDomain}/admin/api/2025-10/products/${productType.shopifyProductId}.json`,
        {
          method: "DELETE",
          headers: { "X-Shopify-Access-Token": installation.accessToken },
        }
      );

      if (!deleteResp.ok && deleteResp.status !== 404) {
        const delErr = await deleteResp.text();
        console.error("[Update Shopify] Delete failed:", deleteResp.status, delErr);
        return res.status(deleteResp.status).json({ error: "Failed to delete existing Shopify product", details: delErr });
      }

      // Clear the stale ID so the create-new-product path below handles re-creation
      await storage.updateProductType(productTypeId, {
        shopifyProductId: null,
        shopifyProductHandle: null,
        shopifyProductUrl: null,
        shopifyShopDomain: null,
        shopifyVariantIds: null,
      });

      // Reload the product type with the cleared ID so the create path below works correctly
      const freshProductType = await storage.getProductType(productTypeId);
      if (!freshProductType) {
        return res.status(404).json({ error: "Product type not found after clearing stale ID" });
      }

      // ---- Re-use the create-new-product path ----
      // Parse product type data
      const allSizes = JSON.parse(freshProductType.sizes || "[]");
      const allColors = JSON.parse(freshProductType.frameColors || "[]");
      const savedSizeIds: string[] = JSON.parse(freshProductType.selectedSizeIds || "[]");
      const savedColorIds: string[] = JSON.parse(freshProductType.selectedColorIds || "[]");
      const variantMap = JSON.parse(freshProductType.variantMap || "{}");
      const baseMockupImages = JSON.parse(freshProductType.baseMockupImages || "{}");

      // Build variants — treat empty savedColorIds as intentionally cleared (no colors)
      const shopifyVariants: Array<{
        option1: string;
        option2?: string;
        price: string;
        sku: string;
        inventory_management: null;
        inventory_policy: string;
      }> = [];

      const sizesToUse = savedSizeIds.length > 0
        ? allSizes.filter((s: { id: string }) => savedSizeIds.includes(s.id))
        : allSizes;
      // Empty savedColorIds = merchant deliberately cleared colors; don't fall back to all
      const colorsToUse = savedColorIds.length > 0
        ? allColors.filter((c: { id: string }) => savedColorIds.includes(c.id))
        : [];

      if (colorsToUse.length > 0) {
        for (const size of sizesToUse) {
          for (const color of colorsToUse) {
            const variantKey = `${size.id}:${color.id}`;
            if (variantMap[variantKey]) {
              shopifyVariants.push({
                option1: size.name,
                option2: color.name,
                price: "0.00",
                sku: `${freshProductType.printifyBlueprintId || 'PT'}-${size.id}-${color.id}`,
                inventory_management: null,
                inventory_policy: "continue",
              });
            }
          }
        }
      }

      // Size-only path: used when colors are empty (either intentionally cleared or never existed)
      if (shopifyVariants.length === 0) {
        for (const size of sizesToUse) {
          const variantKey = `${size.id}:default`;
          if (variantMap[variantKey]) {
            shopifyVariants.push({
              option1: size.name,
              price: "0.00",
              sku: `${freshProductType.printifyBlueprintId || 'PT'}-${size.id}`,
              inventory_management: null,
              inventory_policy: "continue",
            });
          }
        }
      }

      // Validate variant limit
      if (shopifyVariants.length > 100) {
        return res.status(400).json({ 
          error: `Too many variants (${shopifyVariants.length})`,
          details: "Shopify allows a maximum of 100 variants per product."
        });
      }

      // Build product options — only include color option if colors are actually used
      const productOptions: Array<{ name: string; values: string[] }> = [];
      
      if (allSizes.length > 0) {
        productOptions.push({
          name: "Size",
          values: Array.from(new Set(shopifyVariants.map(v => v.option1))),
        });
      }
      
      if (colorsToUse.length > 0) {
        productOptions.push({
          name: getColorOptionName(allColors),
          values: Array.from(new Set(shopifyVariants.filter(v => v.option2).map(v => v.option2!))),
        });
      }

      // Build images
      const images: Array<{ src: string; alt: string }> = [];
      if (baseMockupImages.front) {
        images.push({ src: baseMockupImages.front, alt: `${freshProductType.name} - Front` });
      }
      if (baseMockupImages.lifestyle) {
        images.push({ src: baseMockupImages.lifestyle, alt: `${freshProductType.name} - Lifestyle` });
      }

      const cleanDescription = (freshProductType.description || "")
        .replace(/<[^>]*>/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();

      const displayName = freshProductType.name;
      const appUrl =
        (process.env.PUBLIC_APP_URL || process.env.APP_URL || "").replace(/\/$/, "") ||
        `http://localhost:${process.env.PORT || 5000}`;

      const createPayload = {
        product: {
          title: `Custom ${displayName}`,
          body_html: `<div style="padding: 15px 0;"><h4 style="margin: 0 0 10px 0; font-size: 16px; font-weight: 600;">Product Details</h4><p>${cleanDescription}</p></div>`,
          vendor: merchant.storeName || "AI Art Studio",
          product_type: freshProductType.designerType,
          status: "unlisted",
          published: false,
          tags: ["custom-design", "ai-artwork", "design-studio", "ai-art-studio-enabled"],
          options: productOptions.length > 0 ? productOptions : undefined,
          variants: shopifyVariants.length > 0 ? shopifyVariants : [{ price: "0.00" }],
          images: images.length > 0 ? images : undefined,
          metafields: [
            { namespace: "ai_art_studio", key: "enable", value: "true", type: "single_line_text_field" },
            { namespace: "ai_art_studio", key: "product_type_id", value: String(freshProductType.id), type: "single_line_text_field" },
            { namespace: "ai_art_studio", key: "app_url", value: appUrl, type: "single_line_text_field" },
            { namespace: "ai_art_studio", key: "display_name", value: displayName, type: "single_line_text_field" },
            { namespace: "ai_art_studio", key: "description", value: `Use AI to generate a unique artwork for your ${displayName.toLowerCase()}. Describe your vision and our AI will bring it to life.`, type: "single_line_text_field" },
            { namespace: "ai_art_studio", key: "design_studio_url", value: `${appUrl}/embed/design?productTypeId=${freshProductType.id}`, type: "single_line_text_field" },
            { namespace: "ai_art_studio", key: "hide_add_to_cart", value: "true", type: "single_line_text_field" },
          ],
        },
      };

      const shopifyResponse = await fetch(
        `https://${shopDomain}/admin/api/2025-10/products.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": installation.accessToken,
          },
          body: JSON.stringify(createPayload),
        }
      );

      if (!shopifyResponse.ok) {
        const errorText = await shopifyResponse.text();
        console.error("[Update Shopify] Re-create API error:", shopifyResponse.status, errorText);
        return res.status(shopifyResponse.status).json({ error: "Failed to re-create Shopify product", details: errorText });
      }

      const createdProduct = await shopifyResponse.json();
      const shopifyProductId = createdProduct.product.id;
      const shopifyHandle = createdProduct.product.handle;
      const createdVariants = createdProduct.product.variants || [];
      const shopifyVariantIds: Record<string, number> = {};
      for (const v of createdVariants) {
        shopifyVariantIds[`${v.option1 || 'default'}:${v.option2 || 'default'}`] = v.id;
      }

      try {
        await ensureProductPublishedToOnlineStore(shopDomain, installation.accessToken, shopifyProductId);
        console.log(`[Update Shopify] Product ${shopifyProductId} published to Online Store`);
      } catch (pubErr: any) {
        console.warn(`[Update Shopify] Failed to publish product ${shopifyProductId}: ${pubErr.message}`);
      }

      await storage.updateProductType(productTypeId, {
        shopifyProductId: String(shopifyProductId),
        shopifyProductHandle: shopifyHandle,
        shopifyProductUrl: `https://${shopDomain}/admin/products/${shopifyProductId}`,
        shopifyShopDomain: shopDomain,
        shopifyVariantIds: shopifyVariantIds,
        lastPushedToShopify: new Date(),
      });

      return res.json({
        success: true,
        message: `Product re-created in Shopify with ${shopifyVariants.length} variant(s)`,
        shopifyProductId: shopifyProductId,
        adminUrl: `https://${shopDomain}/admin/products/${shopifyProductId}`,
      });



    } catch (error) {
      console.error("Error updating Shopify product:", error);
      res.status(500).json({ error: "Failed to update Shopify product" });
    }
  });

  // ==================== SYNC PRODUCT METAFIELDS ====================
  // Bulk update metafields for all AI Art Studio products in a shop
  // This is useful when the app URL changes (e.g., migrating from Replit to Railway)
  app.post("/api/shopify/sync-metafields", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);

      if (!merchant) {
        return res.status(403).json({ error: "Merchant not found" });
      }

      const { shopDomain } = req.body;

      if (!shopDomain) {
        return res.status(400).json({ error: "Shop domain is required" });
      }

      // Validate shop domain format
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
        return res.status(400).json({ error: "Invalid shop domain format" });
      }

      // Get installation
      const installation = await storage.getShopifyInstallationByShop(shopDomain);
      if (!installation || installation.status !== "active") {
        return res.status(400).json({ error: "Shopify store not connected" });
      }

      // Security: Verify the installation belongs to this merchant
      if (installation.merchantId && installation.merchantId !== merchant.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Get the current app URL
      const appUrl =
        (process.env.PUBLIC_APP_URL || process.env.APP_URL || "").replace(/\/$/, "") ||
        `http://localhost:${process.env.PORT || 5000}`;

      console.log(`[Sync Metafields] Starting sync for ${shopDomain} with app URL: ${appUrl}`);

      // Find all products with the ai-art-studio-enabled tag
      const searchResponse = await fetch(
        `https://${shopDomain}/admin/api/2025-10/products.json?tag=ai-art-studio-enabled&limit=250`,
        {
          headers: {
            "X-Shopify-Access-Token": installation.accessToken,
          },
        }
      );

      if (!searchResponse.ok) {
        const errorText = await searchResponse.text();
        console.error("Failed to fetch products:", errorText);
        return res.status(searchResponse.status).json({
          error: "Failed to fetch products from Shopify",
          details: errorText
        });
      }

      const { products } = await searchResponse.json();
      console.log(`[Sync Metafields] Found ${products.length} AI Art Studio products`);

      if (products.length === 0) {
        return res.json({
          success: true,
          message: "No AI Art Studio products found to update",
          updated: 0,
        });
      }

      let updated = 0;
      let failed = 0;
      const errors: string[] = [];

      // Update metafields for each product
      for (const product of products) {
        try {
          // Get product metafields to find our namespace
          const metafieldsResponse = await fetch(
            `https://${shopDomain}/admin/api/2025-10/products/${product.id}/metafields.json`,
            {
              headers: {
                "X-Shopify-Access-Token": installation.accessToken,
              },
            }
          );

          if (!metafieldsResponse.ok) {
            console.error(`Failed to fetch metafields for product ${product.id}`);
            failed++;
            continue;
          }

          const { metafields } = await metafieldsResponse.json();

          // Find and update our metafields
          const productTypeIdMeta = metafields.find(
            (m: any) => m.namespace === "ai_art_studio" && m.key === "product_type_id"
          );
          const productTypeId = productTypeIdMeta?.value;

          // Update app_url metafield
          const appUrlMeta = metafields.find(
            (m: any) => m.namespace === "ai_art_studio" && m.key === "app_url"
          );

          if (appUrlMeta) {
            // Update existing metafield
            const updateResponse = await fetch(
              `https://${shopDomain}/admin/api/2025-10/metafields/${appUrlMeta.id}.json`,
              {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  "X-Shopify-Access-Token": installation.accessToken,
                },
                body: JSON.stringify({
                  metafield: {
                    id: appUrlMeta.id,
                    value: appUrl,
                  },
                }),
              }
            );

            if (!updateResponse.ok) {
              console.error(`Failed to update app_url metafield for product ${product.id}`);
              failed++;
              continue;
            }
          } else {
            // Create new metafield
            const createResponse = await fetch(
              `https://${shopDomain}/admin/api/2025-10/products/${product.id}/metafields.json`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Shopify-Access-Token": installation.accessToken,
                },
                body: JSON.stringify({
                  metafield: {
                    namespace: "ai_art_studio",
                    key: "app_url",
                    value: appUrl,
                    type: "single_line_text_field",
                  },
                }),
              }
            );

            if (!createResponse.ok) {
              console.error(`Failed to create app_url metafield for product ${product.id}`);
              failed++;
              continue;
            }
          }

          // Update design_studio_url metafield
          const designUrlMeta = metafields.find(
            (m: any) => m.namespace === "ai_art_studio" && m.key === "design_studio_url"
          );

          const designStudioUrl = productTypeId
            ? `${appUrl}/embed/design?productTypeId=${productTypeId}`
            : `${appUrl}/embed/design`;

          if (designUrlMeta) {
            await fetch(
              `https://${shopDomain}/admin/api/2025-10/metafields/${designUrlMeta.id}.json`,
              {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  "X-Shopify-Access-Token": installation.accessToken,
                },
                body: JSON.stringify({
                  metafield: {
                    id: designUrlMeta.id,
                    value: designStudioUrl,
                  },
                }),
              }
            );
          }

          // Also update the product body_html to remove old iframe or update URL
          // The theme extension now handles embedding, so we can simplify the body_html
          if (product.body_html && (product.body_html.includes('replit') || product.body_html.includes('iframe'))) {
            console.log(`[Sync Metafields] Updating body_html for product ${product.id} to remove old iframe`);

            // Get product type info for display name
            const displayName = product.title.replace(/^Custom\s+/i, '');

            // Replace old body_html with clean version (no iframe - theme extension handles it)
            const cleanBodyHtml = `
              <div id="ai-art-studio-container" style="margin: 0 0 20px 0; padding: 20px; background: #f9fafb; border-radius: 8px;">
                <h3 style="margin: 0 0 10px 0; font-size: 18px; font-weight: 600;">Create Your Custom Design</h3>
                <p style="margin: 0 0 15px 0; color: #666;">Use AI to generate a unique artwork for your ${displayName.toLowerCase()}, or upload your own design!</p>
                <p style="margin: 0; color: #999; font-size: 14px;">The design studio will appear on your store's product page.</p>
              </div>
            `;

            const updateProductResponse = await fetch(
              `https://${shopDomain}/admin/api/2025-10/products/${product.id}.json`,
              {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  "X-Shopify-Access-Token": installation.accessToken,
                },
                body: JSON.stringify({
                  product: {
                    id: product.id,
                    body_html: cleanBodyHtml,
                  },
                }),
              }
            );

            if (!updateProductResponse.ok) {
              console.error(`[Sync Metafields] Failed to update body_html for product ${product.id}`);
            } else {
              console.log(`[Sync Metafields] Cleaned body_html for product ${product.id}`);
            }
          }

          updated++;
          console.log(`[Sync Metafields] Updated product ${product.id}: ${product.title}`);
        } catch (err) {
          console.error(`Error updating product ${product.id}:`, err);
          failed++;
          errors.push(`Product ${product.id}: ${(err as Error).message}`);
        }
      }

      console.log(`[Sync Metafields] Completed: ${updated} updated, ${failed} failed`);

      res.json({
        success: true,
        message: `Updated ${updated} products${failed > 0 ? `, ${failed} failed` : ""}`,
        updated,
        failed,
        errors: errors.length > 0 ? errors : undefined,
        appUrl,
      });

    } catch (error) {
      console.error("Error syncing metafields:", error);
      res.status(500).json({ error: "Failed to sync metafields" });
    }
  });

  // Rate limiting for product variants endpoint
  const variantFetchRateLimit = new Map<string, { count: number; resetTime: number }>();
  const VARIANT_RATE_LIMIT = 100; // Max requests per shop per hour
  const VARIANT_RATE_WINDOW = 60 * 60 * 1000; // 1 hour in ms

  // Proxy endpoint to fetch Shopify product variants (validated against known installations)
  app.get("/api/shopify/product-variants", async (req: Request, res: Response) => {
    try {
      const { shop, handle, productTypeId } = req.query;
      
      // Need shop and either handle or productTypeId
      if (!shop || typeof shop !== 'string') {
        return res.status(400).json({ error: "Missing shop parameter" });
      }
      
      if ((!handle || typeof handle !== 'string') && (!productTypeId || typeof productTypeId !== 'string')) {
        return res.status(400).json({ error: "Missing handle or productTypeId parameter" });
      }
      
      // Normalize shop domain - extract the myshopify.com domain
      let shopDomain = shop.toLowerCase().trim();
      
      // Remove protocol if present
      shopDomain = shopDomain.replace(/^https?:\/\//, '');
      
      // Validate shop domain format - must be a valid Shopify domain pattern
      // Accept: store.myshopify.com, store-name.myshopify.com
      // The theme extension always passes window.Shopify.shop which is the myshopify.com domain
      if (!shopDomain.match(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)) {
        // Try adding .myshopify.com if it looks like just a store name
        if (shopDomain.match(/^[a-z0-9][a-z0-9-]*$/)) {
          shopDomain = `${shopDomain}.myshopify.com`;
        } else {
          console.log(`[Product Variants] Rejected invalid shop domain: ${shop}`);
          return res.status(400).json({ error: "Invalid shop domain. Please use the myshopify.com domain." });
        }
      }
      
      // Validate against known Shopify installations for security
      const installation = await storage.getShopifyInstallationByShop(shopDomain);
      if (!installation) {
        console.log(`[Product Variants] Shop not found in installations: ${shopDomain}`);
        return res.status(403).json({ error: "Shop not authorized" });
      }
      
      // Rate limiting per shop
      const now = Date.now();
      const rateKey = shopDomain;
      const rateData = variantFetchRateLimit.get(rateKey);
      
      if (rateData) {
        if (now < rateData.resetTime) {
          if (rateData.count >= VARIANT_RATE_LIMIT) {
            console.log(`[Product Variants] Rate limit exceeded for: ${shopDomain}`);
            return res.status(429).json({ error: "Rate limit exceeded" });
          }
          rateData.count++;
        } else {
          // Reset window
          variantFetchRateLimit.set(rateKey, { count: 1, resetTime: now + VARIANT_RATE_WINDOW });
        }
      } else {
        variantFetchRateLimit.set(rateKey, { count: 1, resetTime: now + VARIANT_RATE_WINDOW });
      }
      
      let fetchUrl: string;
      
      // If productTypeId is provided, look up the Shopify product ID from our database
      if (productTypeId && typeof productTypeId === 'string') {
        const parsedId = parseInt(productTypeId, 10);
        if (isNaN(parsedId)) {
          console.log(`[Product Variants] Invalid productTypeId format: ${productTypeId}`);
          return res.status(400).json({ error: "Invalid productTypeId format" });
        }
        
        const productType = await storage.getProductType(parsedId);
        
        if (!productType) {
          console.log(`[Product Variants] Product type not found: ${productTypeId}`);
          return res.status(404).json({ error: "Product type not found" });
        }
        
        // Verify the product type belongs to the shop's merchant
        if (productType.merchantId !== installation.merchantId) {
          console.log(`[Product Variants] Product type ${productTypeId} does not belong to shop ${shopDomain}`);
          return res.status(403).json({ error: "Product not authorized for this shop" });
        }
        
        if (!productType.shopifyProductId) {
          console.log(`[Product Variants] Product type ${productTypeId} has no Shopify product ID`);
          return res.status(404).json({ error: "Product not published to Shopify yet" });
        }
        
        // Use Shopify Admin API to get product variants
        const adminApiUrl = `https://${shopDomain}/admin/api/2025-10/products/${productType.shopifyProductId}.json`;
        console.log(`[Product Variants] Fetching from Admin API: ${adminApiUrl}`);
        
        const adminResponse = await fetch(adminApiUrl, {
          headers: {
            'X-Shopify-Access-Token': installation.accessToken
          }
        });
        
        if (!adminResponse.ok) {
          const errorText = await adminResponse.text().catch(() => '');
          console.log(`[Product Variants] Admin API failed with status ${adminResponse.status}: ${errorText}`);
          
          // Fallback 1: Try the public product JSON endpoint (no auth required)
          if (productType.shopifyProductHandle) {
            try {
              const publicUrl = `https://${shopDomain}/products/${productType.shopifyProductHandle}.json`;
              console.log(`[Product Variants] Trying public endpoint: ${publicUrl}`);
              const publicResponse = await fetch(publicUrl);
              if (publicResponse.ok) {
                const publicData = await publicResponse.json();
                const publicVariants = publicData.product?.variants || [];
                if (publicVariants.length > 0) {
                  console.log(`[Product Variants] Fetched ${publicVariants.length} variants via public endpoint`);
                  return res.json({
                    variants: publicVariants.map((v: any) => ({
                      id: v.id,
                      title: v.title,
                      option1: v.option1,
                      option2: v.option2,
                      option3: v.option3,
                      price: v.price,
                      available: v.available
                    })),
                    source: "public"
                  });
                }
              }
            } catch (publicError) {
              console.log(`[Product Variants] Public endpoint failed:`, publicError);
            }
          }
          
          // Fallback 2: Use product type's own variant data from our database
          // This allows add-to-cart to work even when Shopify API has auth issues
          const sizes = (typeof productType.sizes === 'string' ? JSON.parse(productType.sizes) : productType.sizes) as Array<{id: string, name: string}> || [];
          const shopifyVariantIds = (typeof productType.shopifyVariantIds === 'string' 
            ? JSON.parse(productType.shopifyVariantIds) 
            : productType.shopifyVariantIds) as Record<string, number> || {};
          
          if (sizes.length > 0) {
            console.log(`[Product Variants] Using fallback variant data from product type (${sizes.length} sizes)`);
            
            // Build variants from our product type data
            const fallbackVariants = sizes.map((size, index) => {
              // Look up Shopify variant ID from shopifyVariantIds (key is sizeName:colorName)
              const variantKey = `${size.name}:default`;
              const shopifyVariantId = shopifyVariantIds[variantKey];
              
              return {
                id: shopifyVariantId || `fallback-${productType.id}-${size.id}`,
                title: size.name,
                option1: size.name,
                option2: null,
                option3: null,
                price: "0.00", // Price will be set by Shopify when adding to cart
                available: true
              };
            });
            
            return res.json({ variants: fallbackVariants, source: "fallback" });
          }
          
          return res.status(404).json({ error: "Could not fetch product variants from Shopify" });
        } else {
          const data = await adminResponse.json();
          const variants = data.product?.variants || [];
          
          console.log(`[Product Variants] Fetched ${variants.length} variants via Admin API for productTypeId ${productTypeId}`);
          
          // Filter out design variants (those with option3 set — the 'Design' option)
          // to prevent base variant infiltration in the storefront customizer.
          const baseVariants = variants.filter((v: any) => !v.option3 || v.option3 === 'base');
          return res.json({
            variants: baseVariants.map((v: any) => ({
              id: v.id,
              title: v.title,
              option1: v.option1,
              option2: v.option2,
              option3: v.option3,
              price: v.price,
              available: true // Admin API doesn't include available field
            }))
          });
        }
      } else {
        // Use handle to fetch from public endpoint
        const safeHandle = (handle as string).replace(/[^a-z0-9-]/gi, '');
        if (safeHandle !== handle) {
          return res.status(400).json({ error: "Invalid product handle" });
        }
        fetchUrl = `https://${shopDomain}/products/${safeHandle}.json`;
      }
      
      // Fetch public product JSON from Shopify
      const response = await fetch(fetchUrl);
      
      if (!response.ok) {
        console.log(`[Product Variants] Failed to fetch from ${fetchUrl}: ${response.status}`);
        return res.status(404).json({ error: "Product not found" });
      }
      
      const data = await response.json();
      const variants = data.product?.variants || [];
      
      console.log(`[Product Variants] Fetched ${variants.length} variants from ${fetchUrl}`);
      
      // Return just the essential variant data
      // Filter out design variants (those with option3 set — the 'Design' option)
      const baseVariants = variants.filter((v: any) => !v.option3 || v.option3 === 'base');
      res.json({
        variants: baseVariants.map((v: any) => ({
          id: v.id,
          title: v.title,
          option1: v.option1,
          option2: v.option2,
          option3: v.option3,
          price: v.price,
          available: v.available
        }))
      });
    } catch (error) {
      console.error("Error fetching Shopify product variants:", error);
      res.status(500).json({ error: "Failed to fetch product variants" });
    }
  });

  // Get merchant's connected Shopify shops
  app.get("/api/shopify/shops", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.json({ shops: [] });
      }

      // Get installations linked to this merchant
      const installations = await storage.getShopifyInstallationsByMerchant(merchant.id);
      
      res.json({
        shops: installations.map((i: { id: number; shopDomain: string; installedAt: Date }) => ({
          id: i.id,
          shopDomain: i.shopDomain,
          installedAt: i.installedAt,
        })),
      });
    } catch (error) {
      console.error("Error fetching Shopify shops:", error);
      res.status(500).json({ error: "Failed to fetch connected shops" });
    }
  });

  // Get detailed Shopify installations for admin settings
  app.get("/api/shopify/installations", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const shopDomain = req.shopDomain; // From session token verification
      console.log("[/api/shopify/installations] userId:", userId, "shopDomain:", shopDomain);

      let merchant = await storage.getMerchantByUserId(userId);

      // Auto-create merchant if doesn't exist
      if (!merchant) {
        console.log(`[/api/shopify/installations] Auto-creating merchant for user ${userId}`);
        try {
          merchant = await storage.createMerchant({
            userId,
            storeName: shopDomain || "My Store",
            useBuiltInNanoBanana: true,
          });
        } catch (createError: any) {
          // Handle race condition
          if (createError.code === '23505') {
            merchant = await storage.getMerchantByUserId(userId);
          } else {
            throw createError;
          }
        }
      }

      if (!merchant) {
        console.log("[/api/shopify/installations] Still no merchant after create attempt");
        return res.json({ installations: [] });
      }

      // Get installations linked to this merchant
      let installations = await storage.getShopifyInstallationsByMerchant(merchant.id);

      // Also get unlinked installations (for first-time linking)
      const allInstallations = await storage.getAllShopifyInstallations();
      const unlinkedInstallations = allInstallations.filter(
        (i: { merchantId: number | null }) => !i.merchantId
      );

      // Auto-link unlinked installations to this merchant
      for (const installation of unlinkedInstallations) {
        console.log(`Auto-linking unlinked installation ${installation.shopDomain} to merchant ${merchant.id}`);
        await storage.updateShopifyInstallation(installation.id, { merchantId: merchant.id });
      }

      let combined = [...installations, ...unlinkedInstallations];

      // If we have a shop domain from session but no installation, create a placeholder
      if (shopDomain && combined.length === 0) {
        console.log(`[/api/shopify/installations] Creating placeholder installation for ${shopDomain}`);
        try {
          const existingInstallation = await storage.getShopifyInstallationByShop(shopDomain);

          if (!existingInstallation) {
            // Create a new installation - mark as needing reconnection
            const newInstallation = await storage.createShopifyInstallation({
              shopDomain,
              accessToken: "NEEDS_RECONNECT", // Placeholder until OAuth completes
              scope: "",
              status: "needs_reconnect", // Needs OAuth to complete
              installedAt: new Date(),
              merchantId: merchant.id,
            });
            combined = [newInstallation];
            console.log(`[/api/shopify/installations] Created placeholder installation for ${shopDomain}`);
          } else {
            // Link existing installation to this merchant
            console.log(`[/api/shopify/installations] Linking existing installation to merchant`);
            await storage.updateShopifyInstallation(existingInstallation.id, { merchantId: merchant.id });
            combined = [existingInstallation];
          }
        } catch (installError: any) {
          // Handle unique constraint - installation might exist from another attempt
          if (installError.code === '23505') {
            console.log(`[/api/shopify/installations] Installation exists (race condition), fetching...`);
            const existing = await storage.getShopifyInstallationByShop(shopDomain);
            if (existing) {
              combined = [existing];
            }
          } else {
            console.error(`[/api/shopify/installations] Error creating installation:`, installError);
            // Don't throw - just continue with empty installations
          }
        }
      }

      res.json({
        installations: combined.map((i: { id: number; shopDomain: string; status: string; scope: string | null }) => ({
          id: i.id,
          shopDomain: i.shopDomain,
          status: i.status,
          scope: i.scope,
        }))
      });
    } catch (error: any) {
      console.error("Error fetching Shopify installations:", error);
      res.status(500).json({ error: "Failed to fetch installations", details: error?.message || String(error) });
    }
  }));

  // Register cart script for a Shopify shop
  app.post("/api/shopify/register-script", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { shopDomain } = req.body;

      if (!shopDomain) {
        return res.status(400).json({ error: "Shop domain is required" });
      }

      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) {
        return res.status(403).json({ error: "Merchant not found" });
      }

      // Get the installation for this shop
      const installation = await storage.getShopifyInstallationByShop(shopDomain);
      if (!installation || installation.status !== "active") {
        return res.status(400).json({ error: "Shopify store not connected" });
      }

      // Verify merchant owns this installation
      if (installation.merchantId !== merchant.id) {
        return res.status(403).json({ error: "Not authorized for this shop" });
      }

      // Register the cart script
      await registerCartScript(shopDomain, installation.accessToken!);

      res.json({ success: true, message: "Cart script registered successfully" });
    } catch (error) {
      console.error("Error registering cart script:", error);
      res.status(500).json({ error: "Failed to register cart script" });
    }
  });

  // Product Types API (public endpoint for Shopify embed)
  app.get("/api/product-types", async (_req: Request, res: Response) => {
    try {
      const types = await storage.getActiveProductTypes();
      res.json(types);
    } catch (error) {
      console.error("Error fetching product types:", error);
      res.status(500).json({ error: "Failed to fetch product types" });
    }
  });

  app.get("/api/product-types/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const productType = await storage.getProductType(id);
      if (!productType) {
        return res.status(404).json({ error: "Product type not found" });
      }
      res.json(productType);
    } catch (error) {
      console.error("Error fetching product type:", error);
      res.status(500).json({ error: "Failed to fetch product type" });
    }
  });

  app.get("/api/product-types/:id/designer", async (req: Request, res: Response) => {
    console.log(`[Designer API] Route handler entered for ${req.params.id}`);
    try {
      const id = parseInt(req.params.id);
      console.log(`[Designer API] Fetching product type ${id}`);

      // Add timeout wrapper to detect hanging queries
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Database query timeout after 5s')), 5000)
      );

      const productType = await Promise.race([
        storage.getProductType(id),
        timeoutPromise
      ]);

      console.log(`[Designer API] Product type ${id} found:`, productType ? 'yes' : 'no');
      if (!productType) {
        // Prevent caching of 404 responses
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.status(404).json({ error: "Product type not found" });
      }

      const sizes = typeof productType.sizes === 'string' 
        ? JSON.parse(productType.sizes) 
        : productType.sizes || [];
      const frameColors = typeof productType.frameColors === 'string' 
        ? JSON.parse(productType.frameColors) 
        : productType.frameColors || [];

      const [aspectW, aspectH] = (productType.aspectRatio || "1:1").split(":").map(Number);
      const aspectRatio = aspectW / aspectH;

      const maxDimension = 1024;
      let canvasWidth: number, canvasHeight: number;
      if (aspectRatio >= 1) {
        canvasWidth = maxDimension;
        canvasHeight = Math.round(maxDimension / aspectRatio);
      } else {
        canvasHeight = maxDimension;
        canvasWidth = Math.round(maxDimension * aspectRatio);
      }

      const bleedMarginPercent = productType.bleedMarginPercent || 5;
      const safeZoneMargin = Math.round(Math.min(canvasWidth, canvasHeight) * (bleedMarginPercent / 100));

      // Determine sizeType (dimensional vs label-only)
      const sizeType = (productType as any).sizeType || "dimensional";

      // Parse base mockup images if available
      const baseMockupImages = typeof productType.baseMockupImages === 'string'
        ? JSON.parse(productType.baseMockupImages)
        : productType.baseMockupImages || {};

      // Parse variant map for size/color availability
      const variantMap = typeof productType.variantMap === 'string'
        ? JSON.parse(productType.variantMap)
        : productType.variantMap || {};

      console.log(`[Designer API] Building config for product type ${id}: ${productType.name}`);
      const designerConfig = {
        id: productType.id,
        name: productType.name,
        description: productType.description,
        printifyBlueprintId: productType.printifyBlueprintId,
        aspectRatio: productType.aspectRatio,
        printShape: productType.printShape || "rectangle",
        printAreaWidth: productType.printAreaWidth,
        printAreaHeight: productType.printAreaHeight,
        bleedMarginPercent,
        designerType: productType.designerType || "generic",
        sizeType,
        hasPrintifyMockups: productType.hasPrintifyMockups || false,
        baseMockupImages,
        primaryMockupIndex: productType.primaryMockupIndex || 0,
        doubleSidedPrint: productType.doubleSidedPrint || false,
        sizes: sizes.map((s: any) => {
          // Calculate aspect ratio from dimensions if available
          let sizeAspectRatio = s.aspectRatio || productType.aspectRatio;
          if (sizeType === "dimensional" && s.width && s.height) {
            // Calculate proper aspect ratio from dimensions
            const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
            const divisor = gcd(s.width, s.height);
            sizeAspectRatio = `${s.width / divisor}:${s.height / divisor}`;
          }
          return {
            id: s.id,
            name: s.name,
            width: s.width || 0,
            height: s.height || 0,
            aspectRatio: sizeType === "dimensional" ? sizeAspectRatio : undefined,
          };
        }),
        frameColors: frameColors.map((c: any) => ({
          id: c.id,
          name: c.name,
          hex: c.hex,
        })),
        // Determine the label for the color/option selector
        colorLabel: getColorOptionName(frameColors, productType.colorOptionName),
        canvasConfig: {
          maxDimension,
          width: canvasWidth,
          height: canvasHeight,
          safeZoneMargin,
        },
        variantMap,
        isAllOverPrint: productType.isAllOverPrint || false,
        placeholderPositions: typeof productType.placeholderPositions === "string"
          ? JSON.parse(productType.placeholderPositions || "[]")
          : productType.placeholderPositions || [],
        panelFlatLayImages: (() => {
          // Parse stored value (defensive — column may not exist yet on older DBs)
          let stored: Record<string, string> = {};
          try {
            stored = typeof productType.panelFlatLayImages === "string"
              ? JSON.parse(productType.panelFlatLayImages || "{}")
              : (productType.panelFlatLayImages as any) || {};
          } catch { stored = {}; }
          // Apply static fallback for known blueprints where Printify API returns empty views
          if (Object.keys(stored).length === 0 && productType.printifyBlueprintId) {
            const STATIC_FLAT_LAY_SVGS: Record<number, Record<string, string>> = {
              // Complete Printify panel SVG mapping (auto-generated from Printify catalog)
              // Women's Cut & Sew Racerback Dress
              276: {
                "back"                : "https://images.printify.com/api/catalog/59fc4d34b8e7e30175347441.svg",
                "front"               : "https://images.printify.com/api/catalog/59fc4d2bb8e7e301856c6fa9.svg",
              },
              // Unisex Cut & Sew Tee
              281: {
                "back"                : "https://images.printify.com/api/catalog/5a01d4b4b8e7e32813350528.svg",
                "front"               : "https://images.printify.com/api/catalog/5a01d4ceb8e7e3281f2da8e7.svg",
              },
              // Women's Pencil Skirt
              285: {
                "back"                : "https://images.printify.com/api/catalog/5a0ef125b8e7e307bc4e601c.svg",
                "front"               : "https://images.printify.com/api/catalog/5a0ef133b8e7e3087c7ebf08.svg",
              },
              // Unisex Sweatshirt
              449: {
                "back"                : "https://images.printify.com/api/catalog/5d9c87f418831d27426218b0.svg",
                "front"               : "https://images.printify.com/api/catalog/5d9b4bc1a54cf735a33aa246.svg",
                "left_sleeve"         : "https://images.printify.com/api/catalog/5d9b5255e577547f153b80dc.svg",
                "right_sleeve"        : "https://images.printify.com/api/catalog/5d9b35ebd41cb4389d15e043.svg",
              },
              // Unisex Pullover Hoodie
              450: {
                "back"                : "https://images.printify.com/api/catalog/5d971e0a2947a61bef6f40cd.svg",
                "front"               : "https://images.printify.com/api/catalog/5d96fefa40e8da18a2274ad9.svg",
                "left_sleeve"         : "https://images.printify.com/api/catalog/5d971d7ad69994742d3a03fb.svg",
                "right_sleeve"        : "https://images.printify.com/api/catalog/5d971dfcc4c83a05fc3a5492.svg",
              },
              // Unisex Zip Hoodie
              451: {
                "back"                : "https://images.printify.com/api/catalog/5d9ae61ccf4e077eb561b028.svg",
                "front_left"          : "https://images.printify.com/api/catalog/5d9c8b82c92a2a02ac3662dd.svg",
                "front_right"         : "https://images.printify.com/api/catalog/631b2116174f5066ca0759d4.svg",
                "left_cuff_panel"     : "https://images.printify.com/api/catalog/5d9ae385cf4e077eb561b01c.svg",
                "left_hood"           : "https://images.printify.com/api/catalog/5d9ae1fa4e699c71a202db06.svg",
                "left_sleeve"         : "https://images.printify.com/api/catalog/5d9ae1b44e699c71a202db03.svg",
                "pocket_left"         : "https://images.printify.com/api/catalog/5d9c8e67c92a2a02ac3662e0.svg",
                "pocket_right"        : "https://images.printify.com/api/catalog/5d9c8e76c92a2a02ac3662e3.svg",
                "right_cuff_panel"    : "https://images.printify.com/api/catalog/5d9c8335c92a2a02ac3662d4.svg",
                "right_hood"          : "https://images.printify.com/api/catalog/5d9ae1e932345a5ce56f1e1c.svg",
                "right_sleeve"        : "https://images.printify.com/api/catalog/5d9ae1d58bb77340c7729745.svg",
                "waistband"           : "https://images.printify.com/api/catalog/5d9b0eda32345a5ce56f1e37.svg",
              },
              // Crop Tee
              627: {
                "back"                : "https://images.printify.com/api/catalog/612e2dbdce911f74dc7fc430.svg",
                "front"               : "https://images.printify.com/api/catalog/61165b745cbffb455d742be8.svg",
              },
              // Women's Capri Leggings
              1050: {
                "left_leg"            : "https://images.printify.com/api/catalog/627268e348bb29a669061ca2.svg",
                "right_leg"           : "https://images.printify.com/api/catalog/627268d3ae9e71e7850a0ff1.svg",
              },
              // Tote Bag
              1389: {
                "front"               : "https://images.printify.com/api/catalog/6564848e6a2aafb6fe0ba0d3.svg",
              },
              // Men's Hawaiian Camp Shirt
              1533: {
                "back"                : "https://images.printify.com/api/catalog/66a21741405a59f9070d94c2.svg",
                "front_left"          : "https://images.printify.com/api/catalog/66a21c3817e48cae5b0ddbe2.svg",
                "front_right"         : "https://images.printify.com/api/catalog/66a21bb8f38ac84cd908f752.svg",
                "left_placket"        : "https://images.printify.com/api/catalog/69a6e89c7c21676d1f0bf552.svg",
                "right_placket"       : "https://images.printify.com/api/catalog/69a6e8695763f46f33003910.svg",
              },
              // Basketball Training Shorts
              1589: {
                "back_left_leg"       : "https://images.printify.com/api/catalog/66d70a472e7c84cf240029e6.svg",
                "back_right_leg"      : "https://images.printify.com/api/catalog/66d70a16650830a5b305c264.svg",
                "front_left_leg"      : "https://images.printify.com/api/catalog/66d709cd7438963da401ba55.svg",
                "front_right_leg"     : "https://images.printify.com/api/catalog/66d709486f43297fff0ce8a5.svg",
                "left_inner_pocket_back": "https://images.printify.com/api/catalog/66d70a44f835b084520c4364.svg",
                "left_inner_pocket_front": "https://images.printify.com/api/catalog/66d70a13febb2981ab02c692.svg",
                "right_inner_pocket_back": "https://images.printify.com/api/catalog/66d70a07c810c0506505ba93.svg",
                "right_inner_pocket_front": "https://images.printify.com/api/catalog/66d70a39619c41921c006035.svg",
              },
              // Unisex Polo Shirt
              1604: {
                "back"                : "https://images.printify.com/api/catalog/66e45967b94b48b3b80449f2.svg",
                "front"               : "https://images.printify.com/api/catalog/66e459529ec5cf39800ccb42.svg",
                "left_sleeve"         : "https://images.printify.com/api/catalog/66e4597bb94b48b3b80449f3.svg",
                "placket"             : "https://images.printify.com/api/catalog/66e459946fc58997a50cf387.svg",
                "right_sleeve"        : "https://images.printify.com/api/catalog/66e459726fc58997a50cf384.svg",
              },
              // Pixel Fleece Blanket
              1911: {
                "front"               : "https://images.printify.com/api/catalog/67b745ed32ecb119d80897c9.svg",
              },
            };
            const fallback = STATIC_FLAT_LAY_SVGS[productType.printifyBlueprintId];
            if (fallback) return fallback;
          }
          return stored;
        })(),
      };

      console.log(`[Designer API] Returning config for ${productType.name}, designerType: ${designerConfig.designerType}`);
      // Prevent browser caching to ensure fresh data
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      res.json(designerConfig);
    } catch (error) {
      console.error("Error fetching designer config:", error);
      res.status(500).json({ error: "Failed to fetch designer configuration" });
    }
  });

  // Helper: wrap any promise with a timeout
  const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded ${ms}ms`)), ms)
      )
    ]);
  };

  // ==================== SHARED STOREFRONT PRODUCT TYPE RESOLVER ====================
  // Centralized fallback: given a productTypeId and merchantId, resolve to a valid
  // product type owned by that merchant. Never returns null when the merchant has at
  // least one product type — instead falls back through a resolution chain.
  // Admin endpoints should NOT use this; they should 404 on invalid IDs.
  async function resolveStorefrontProductType(
    requestedId: number | null | undefined,
    merchantId: string,
    logPrefix: string = "[Storefront]"
  ): Promise<{ productType: any; resolvedFrom?: string } | { error: string }> {
    // 1) Direct lookup by ID
    if (requestedId && !isNaN(requestedId)) {
      const pt = await storage.getProductType(requestedId);
      if (pt && pt.merchantId === merchantId) {
        return { productType: pt };
      }
      if (pt) {
        console.warn(`${logPrefix} Ownership mismatch: productType(${requestedId}).merchantId=${pt.merchantId} vs merchantId=${merchantId}`);
      } else {
        console.warn(`${logPrefix} Product type ${requestedId} not found in database`);
      }
    }

    // 2) Fallback chain — resolve to a valid product type for this merchant
    const merchantProductTypes = await storage.getProductTypesByMerchant(merchantId);
    const availableIds = merchantProductTypes.map(pt => pt.id);
    console.warn(`${logPrefix} FALLBACK: requested=${requestedId ?? "none"}, merchant ${merchantId} has [${availableIds.join(", ")}]`);

    if (merchantProductTypes.length === 0) {
      return { error: "No product types configured for this merchant" };
    }

    let resolved: any;
    let resolvedFrom: string;

    if (merchantProductTypes.length === 1) {
      resolved = merchantProductTypes[0];
      resolvedFrom = "only_available";
    } else {
      // Deterministic: pick the smallest ID
      resolved = merchantProductTypes.reduce((a, b) => a.id < b.id ? a : b);
      resolvedFrom = "smallest_id_fallback";
    }

    console.warn(`${logPrefix} FALLBACK RESOLVED: requested=${requestedId ?? "none"} → resolved=${resolved.id} (${resolved.name}) reason=${resolvedFrom}`);
    return { productType: resolved, resolvedFrom };
  }

  /**
   * Pure CPU function: given a product type row, build the designer config object.
   * Extracted so we can call it from the fast path (direct ID lookup) and the
   * full fallback path (merchant lookup chain) without duplicating 100 lines of code.
   */
  function buildDesignerConfig(
    productTypeToUse: any,
    requestedId: number,
    resolvedFrom?: string
  ): Record<string, any> {
    const allSizes = typeof productTypeToUse.sizes === "string"
      ? JSON.parse(productTypeToUse.sizes)
      : productTypeToUse.sizes || [];
    const allFrameColors = typeof productTypeToUse.frameColors === "string"
      ? JSON.parse(productTypeToUse.frameColors)
      : productTypeToUse.frameColors || [];

    // Filter sizes and colors to only those the merchant has selected.
    // Empty array means the merchant deliberately cleared the selection (e.g. no color option).
    // null/undefined means never configured — fall back to showing all.
    const rawSizeIds = typeof productTypeToUse.selectedSizeIds === "string"
      ? productTypeToUse.selectedSizeIds
      : JSON.stringify(productTypeToUse.selectedSizeIds ?? null);
    const rawColorIds = typeof productTypeToUse.selectedColorIds === "string"
      ? productTypeToUse.selectedColorIds
      : JSON.stringify(productTypeToUse.selectedColorIds ?? null);

    // Parse — treat null JSON as "never set"
    const savedSizeIds: string[] | null = rawSizeIds && rawSizeIds !== "null"
      ? JSON.parse(rawSizeIds)
      : null;
    const savedColorIds: string[] | null = rawColorIds && rawColorIds !== "null"
      ? JSON.parse(rawColorIds)
      : null;

    // null = never configured → show all; [] = deliberately cleared → show none
    const sizes = savedSizeIds !== null
      ? allSizes.filter((s: any) => savedSizeIds.includes(s.id))
      : allSizes;
    const frameColors = savedColorIds !== null
      ? allFrameColors.filter((c: any) => savedColorIds.includes(c.id))
      : allFrameColors;

    const [aspectW, aspectH] = (productTypeToUse.aspectRatio || "1:1").split(":").map(Number);
    const aspectRatio = aspectW / aspectH;

    const maxDimension = 1024;
    let canvasWidth: number, canvasHeight: number;
    if (aspectRatio >= 1) {
      canvasWidth = maxDimension;
      canvasHeight = Math.round(maxDimension / aspectRatio);
    } else {
      canvasHeight = maxDimension;
      canvasWidth = Math.round(maxDimension * aspectRatio);
    }

    const bleedMarginPercent = productTypeToUse.bleedMarginPercent || 5;
    const safeZoneMargin = Math.round(Math.min(canvasWidth, canvasHeight) * (bleedMarginPercent / 100));
    const sizeType = (productTypeToUse as any).sizeType || "dimensional";

    const baseMockupImages = typeof productTypeToUse.baseMockupImages === "string"
      ? JSON.parse(productTypeToUse.baseMockupImages)
      : productTypeToUse.baseMockupImages || {};

    const variantMap = typeof productTypeToUse.variantMap === "string"
      ? JSON.parse(productTypeToUse.variantMap)
      : productTypeToUse.variantMap || {};

    const config: Record<string, any> = {
      id: productTypeToUse.id,
      name: productTypeToUse.name,
      description: productTypeToUse.description,
      printifyBlueprintId: productTypeToUse.printifyBlueprintId,
      aspectRatio: productTypeToUse.aspectRatio,
      printShape: productTypeToUse.printShape || "rectangle",
      printAreaWidth: productTypeToUse.printAreaWidth,
      printAreaHeight: productTypeToUse.printAreaHeight,
      bleedMarginPercent,
      designerType: productTypeToUse.designerType || "generic",
      sizeType,
      hasPrintifyMockups: productTypeToUse.hasPrintifyMockups || false,
      baseMockupImages,
      primaryMockupIndex: productTypeToUse.primaryMockupIndex || 0,
      doubleSidedPrint: productTypeToUse.doubleSidedPrint || false,
      isAllOverPrint: productTypeToUse.isAllOverPrint || false,
      placeholderPositions: typeof productTypeToUse.placeholderPositions === "string"
        ? JSON.parse(productTypeToUse.placeholderPositions || "[]")
        : productTypeToUse.placeholderPositions || [],
      panelFlatLayImages: (() => {
        // Parse stored value (defensive — column may not exist yet on older DBs)
        let stored2: Record<string, string> = {};
        try {
          stored2 = typeof productTypeToUse.panelFlatLayImages === "string"
            ? JSON.parse(productTypeToUse.panelFlatLayImages || "{}")
            : (productTypeToUse.panelFlatLayImages as any) || {};
        } catch { stored2 = {}; }
        if (Object.keys(stored2).length === 0 && productTypeToUse.printifyBlueprintId) {
          const STATIC_FLAT_LAY_SVGS2: Record<number, Record<string, string>> = {
              // Complete Printify panel SVG mapping (auto-generated from Printify catalog)
              // Women's Cut & Sew Racerback Dress
              276: {
                "back"                : "https://images.printify.com/api/catalog/59fc4d34b8e7e30175347441.svg",
                "front"               : "https://images.printify.com/api/catalog/59fc4d2bb8e7e301856c6fa9.svg",
              },
              // Unisex Cut & Sew Tee
              281: {
                "back"                : "https://images.printify.com/api/catalog/5a01d4b4b8e7e32813350528.svg",
                "front"               : "https://images.printify.com/api/catalog/5a01d4ceb8e7e3281f2da8e7.svg",
              },
              // Women's Pencil Skirt
              285: {
                "back"                : "https://images.printify.com/api/catalog/5a0ef125b8e7e307bc4e601c.svg",
                "front"               : "https://images.printify.com/api/catalog/5a0ef133b8e7e3087c7ebf08.svg",
              },
              // Unisex Sweatshirt
              449: {
                "back"                : "https://images.printify.com/api/catalog/5d9c87f418831d27426218b0.svg",
                "front"               : "https://images.printify.com/api/catalog/5d9b4bc1a54cf735a33aa246.svg",
                "left_sleeve"         : "https://images.printify.com/api/catalog/5d9b5255e577547f153b80dc.svg",
                "right_sleeve"        : "https://images.printify.com/api/catalog/5d9b35ebd41cb4389d15e043.svg",
              },
              // Unisex Pullover Hoodie
              450: {
                "back"                : "https://images.printify.com/api/catalog/5d971e0a2947a61bef6f40cd.svg",
                "front"               : "https://images.printify.com/api/catalog/5d96fefa40e8da18a2274ad9.svg",
                "left_sleeve"         : "https://images.printify.com/api/catalog/5d971d7ad69994742d3a03fb.svg",
                "right_sleeve"        : "https://images.printify.com/api/catalog/5d971dfcc4c83a05fc3a5492.svg",
              },
              // Unisex Zip Hoodie
              451: {
                "back"                : "https://images.printify.com/api/catalog/5d9ae61ccf4e077eb561b028.svg",
                "front_left"          : "https://images.printify.com/api/catalog/5d9c8b82c92a2a02ac3662dd.svg",
                "front_right"         : "https://images.printify.com/api/catalog/631b2116174f5066ca0759d4.svg",
                "left_cuff_panel"     : "https://images.printify.com/api/catalog/5d9ae385cf4e077eb561b01c.svg",
                "left_hood"           : "https://images.printify.com/api/catalog/5d9ae1fa4e699c71a202db06.svg",
                "left_sleeve"         : "https://images.printify.com/api/catalog/5d9ae1b44e699c71a202db03.svg",
                "pocket_left"         : "https://images.printify.com/api/catalog/5d9c8e67c92a2a02ac3662e0.svg",
                "pocket_right"        : "https://images.printify.com/api/catalog/5d9c8e76c92a2a02ac3662e3.svg",
                "right_cuff_panel"    : "https://images.printify.com/api/catalog/5d9c8335c92a2a02ac3662d4.svg",
                "right_hood"          : "https://images.printify.com/api/catalog/5d9ae1e932345a5ce56f1e1c.svg",
                "right_sleeve"        : "https://images.printify.com/api/catalog/5d9ae1d58bb77340c7729745.svg",
                "waistband"           : "https://images.printify.com/api/catalog/5d9b0eda32345a5ce56f1e37.svg",
              },
              // Crop Tee
              627: {
                "back"                : "https://images.printify.com/api/catalog/612e2dbdce911f74dc7fc430.svg",
                "front"               : "https://images.printify.com/api/catalog/61165b745cbffb455d742be8.svg",
              },
              // Women's Capri Leggings
              1050: {
                "left_leg"            : "https://images.printify.com/api/catalog/627268e348bb29a669061ca2.svg",
                "right_leg"           : "https://images.printify.com/api/catalog/627268d3ae9e71e7850a0ff1.svg",
              },
              // Tote Bag
              1389: {
                "front"               : "https://images.printify.com/api/catalog/6564848e6a2aafb6fe0ba0d3.svg",
              },
              // Men's Hawaiian Camp Shirt
              1533: {
                "back"                : "https://images.printify.com/api/catalog/66a21741405a59f9070d94c2.svg",
                "front_left"          : "https://images.printify.com/api/catalog/66a21c3817e48cae5b0ddbe2.svg",
                "front_right"         : "https://images.printify.com/api/catalog/66a21bb8f38ac84cd908f752.svg",
                "left_placket"        : "https://images.printify.com/api/catalog/69a6e89c7c21676d1f0bf552.svg",
                "right_placket"       : "https://images.printify.com/api/catalog/69a6e8695763f46f33003910.svg",
              },
              // Basketball Training Shorts
              1589: {
                "back_left_leg"       : "https://images.printify.com/api/catalog/66d70a472e7c84cf240029e6.svg",
                "back_right_leg"      : "https://images.printify.com/api/catalog/66d70a16650830a5b305c264.svg",
                "front_left_leg"      : "https://images.printify.com/api/catalog/66d709cd7438963da401ba55.svg",
                "front_right_leg"     : "https://images.printify.com/api/catalog/66d709486f43297fff0ce8a5.svg",
                "left_inner_pocket_back": "https://images.printify.com/api/catalog/66d70a44f835b084520c4364.svg",
                "left_inner_pocket_front": "https://images.printify.com/api/catalog/66d70a13febb2981ab02c692.svg",
                "right_inner_pocket_back": "https://images.printify.com/api/catalog/66d70a07c810c0506505ba93.svg",
                "right_inner_pocket_front": "https://images.printify.com/api/catalog/66d70a39619c41921c006035.svg",
              },
              // Unisex Polo Shirt
              1604: {
                "back"                : "https://images.printify.com/api/catalog/66e45967b94b48b3b80449f2.svg",
                "front"               : "https://images.printify.com/api/catalog/66e459529ec5cf39800ccb42.svg",
                "left_sleeve"         : "https://images.printify.com/api/catalog/66e4597bb94b48b3b80449f3.svg",
                "placket"             : "https://images.printify.com/api/catalog/66e459946fc58997a50cf387.svg",
                "right_sleeve"        : "https://images.printify.com/api/catalog/66e459726fc58997a50cf384.svg",
              },
              // Pixel Fleece Blanket
              1911: {
                "front"               : "https://images.printify.com/api/catalog/67b745ed32ecb119d80897c9.svg",
              },
            };
          const fallback2 = STATIC_FLAT_LAY_SVGS2[productTypeToUse.printifyBlueprintId];
          if (fallback2) return fallback2;
        }
        return stored2;
      })(),
      sizes: sizes.map((s: any) => {
        let sizeAspectRatio = s.aspectRatio || productTypeToUse.aspectRatio;
        if (sizeType === "dimensional" && s.width && s.height) {
          const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
          const divisor = gcd(s.width, s.height);
          sizeAspectRatio = `${s.width / divisor}:${s.height / divisor}`;
        }
        return {
          id: s.id,
          name: s.name,
          width: s.width || 0,
          height: s.height || 0,
          aspectRatio: sizeType === "dimensional" ? sizeAspectRatio : undefined,
        };
      }),
      frameColors: frameColors.map((c: any) => ({
        id: c.id,
        name: c.name,
        hex: c.hex,
      })),
      // Determine the label for the color/option selector
      colorLabel: getColorOptionName(frameColors, productTypeToUse.colorOptionName),
      canvasConfig: {
        maxDimension,
        width: canvasWidth,
        height: canvasHeight,
        safeZoneMargin,
      },
      variantMap,
    };

    if (resolvedFrom) {
      config.resolvedProductTypeId = productTypeToUse.id;
      config.requestedProductTypeId = requestedId;
      config.resolutionReason = resolvedFrom;
    }

    return config;
  }

  // Storefront-safe designer endpoint (no auth required, validates via shop param)
  app.get("/api/storefront/product-types/:id/designer", async (req: Request, res: Response) => {
    const requestId = crypto.randomBytes(4).toString("hex");
    const startTime = Date.now();
    let killSwitchTimeout: NodeJS.Timeout | null = null;
    let responded = false;

    // 1️⃣ STRUCTURED LOGGING AT VERY TOP
    console.log(`[SF-DESIGNER ${requestId}] ========== REQUEST START ==========`);
    console.log(`[SF-DESIGNER ${requestId}] timestamp=${new Date().toISOString()}`);
    console.log(`[SF-DESIGNER ${requestId}] originalUrl=${req.originalUrl}`);
    console.log(`[SF-DESIGNER ${requestId}] params.id=${req.params.id}`);
    console.log(`[SF-DESIGNER ${requestId}] query.shop=${req.query.shop}`);
    console.log(`[SF-DESIGNER ${requestId}] NODE_ENV=${process.env.NODE_ENV}`);
    console.log(`[SF-DESIGNER ${requestId}] headers.host=${req.headers.host}`);
    console.log(`[SF-DESIGNER ${requestId}] headers.origin=${req.headers.origin}`);

    let shop = req.query.shop as string;
    const id = parseInt(req.params.id);

    // 🛡️ DEFENSIVE FALLBACK: If shop param is missing, try to derive from Origin/Referer
    const originHeader = req.headers.origin as string | undefined;
    const refererHeader = (req.headers.referer || req.headers.referrer) as string | undefined;

    if (!shop) {
      console.log(`[SF-DESIGNER ${requestId}] ⚠️ SHOP MISSING from query params`);
      console.log(`[SF-DESIGNER ${requestId}] Headers available: origin=${originHeader}, referer=${refererHeader}`);

      // Try Origin header first (most reliable for cross-origin requests)
      if (originHeader) {
        try {
          const originUrl = new URL(originHeader);
          console.log(`[SF-DESIGNER ${requestId}] Parsed origin hostname: ${originUrl.hostname}`);
          if (originUrl.hostname.endsWith('.myshopify.com')) {
            shop = originUrl.hostname;
            console.log(`[SF-DESIGNER ${requestId}] ✅ DERIVED shop from Origin: ${shop}`);
          } else {
            console.log(`[SF-DESIGNER ${requestId}] Origin hostname does not end with .myshopify.com`);
          }
        } catch (e) {
          console.log(`[SF-DESIGNER ${requestId}] Failed to parse Origin: ${originHeader}`, e);
        }
      } else {
        console.log(`[SF-DESIGNER ${requestId}] No Origin header present`);
      }

      // Try Referer header as backup
      if (!shop && refererHeader) {
        try {
          const refererUrl = new URL(refererHeader);
          console.log(`[SF-DESIGNER ${requestId}] Parsed referer hostname: ${refererUrl.hostname}`);
          if (refererUrl.hostname.endsWith('.myshopify.com')) {
            shop = refererUrl.hostname;
            console.log(`[SF-DESIGNER ${requestId}] ✅ DERIVED shop from Referer: ${shop}`);
          } else {
            console.log(`[SF-DESIGNER ${requestId}] Referer hostname does not end with .myshopify.com`);
          }
        } catch (e) {
          console.log(`[SF-DESIGNER ${requestId}] Failed to parse Referer: ${refererHeader}`, e);
        }
      }

      // Final result logging
      if (shop) {
        console.log(`[SF-DESIGNER ${requestId}] 🎯 FALLBACK SUCCEEDED: derivedShop=${shop}`);
      } else {
        console.log(`[SF-DESIGNER ${requestId}] ❌ FALLBACK FAILED: shop still missing after checking headers`, { originHeader, refererHeader });
      }
    } else {
      console.log(`[SF-DESIGNER ${requestId}] Shop provided in query: ${shop}`);
    }

    // 2️⃣ SERVER-SIDE KILL SWITCH (5 seconds)
    killSwitchTimeout = setTimeout(() => {
      if (!responded) {
        responded = true;
        console.error(`[SF-DESIGNER ${requestId}] ⚠️ KILL SWITCH FIRED after 5000ms - request did not complete`);
        console.error(`[SF-DESIGNER ${requestId}] Last known state: shop=${shop} id=${id}`);
        res.status(504).json({
          error: "server-side timeout kill switch",
          requestId,
          elapsed: Date.now() - startTime,
          shop,
          productTypeId: id
        });
      }
    }, 5000);

    try {
      // Validate shop parameter (after fallback attempt)
      if (!shop) {
        console.log(`[SF-DESIGNER ${requestId}] ERROR: Missing shop parameter and fallback failed`);
        console.log(`[SF-DESIGNER ${requestId}] Headers: origin=${req.headers.origin}, referer=${req.headers.referer}`);
        responded = true;
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.status(400).json({
          error: "Missing shop parameter",
          message: "The shop parameter is required. Provide ?shop=yourstore.myshopify.com or ensure Origin/Referer headers contain a .myshopify.com domain.",
          debug: {
            productTypeId: id,
            originHeader: req.headers.origin || null,
            refererHeader: req.headers.referer || null
          }
        });
      }

      // ⚡ FAST PATH: When productTypeId > 0, load the product type directly by ID.
      // This skips the expensive merchant lookup chain entirely and typically returns
      // in <50ms vs potentially 5s+ for the merchant chain when no merchant row exists.
      if (id > 0) {
        console.log(`[SF-DESIGNER ${requestId}] FAST PATH: attempting direct lookup for id=${id}`);
        const fastPt = await withTimeout(
          storage.getProductType(id),
          4000,
          "getProductType_fast_path"
        );
        if (fastPt) {
          const totalMs = Date.now() - startTime;
          console.log(`[SF-DESIGNER ${requestId}] ✅ FAST PATH SUCCESS: id=${id} name="${fastPt.name}" ms=${totalMs}`);
          if (killSwitchTimeout) clearTimeout(killSwitchTimeout);
          responded = true;
          res.set("Cache-Control", "no-cache, no-store, must-revalidate");
          res.set("Pragma", "no-cache");
          res.set("Expires", "0");
          return res.json(buildDesignerConfig(fastPt, id));
        }
        console.log(`[SF-DESIGNER ${requestId}] FAST PATH miss for id=${id} — falling back to merchant lookup`);
      }

      // 3️⃣ MERCHANT LOOKUP - getMerchantByShop (fallback when id is 0 or not found)
      console.log(`[SF-DESIGNER ${requestId}] [STEP 1] Before getMerchantByShop(${shop})`);
      const merchantStart = Date.now();
      let merchant = await withTimeout(
        storage.getMerchantByShop(shop),
        4000,
        "getMerchantByShop"
      );
      console.log(`[SF-DESIGNER ${requestId}] [STEP 1] After getMerchantByShop - ${Date.now() - merchantStart}ms - found=${!!merchant}`);

      if (!merchant) {
        console.log(`[SF-DESIGNER ${requestId}] [STEP 2] Before getShopifyInstallationByShop(${shop})`);
        const installStart = Date.now();
        const installation = await withTimeout(
          storage.getShopifyInstallationByShop(shop),
          4000,
          "getShopifyInstallationByShop"
        );
        console.log(`[SF-DESIGNER ${requestId}] [STEP 2] After getShopifyInstallationByShop - ${Date.now() - installStart}ms - found=${!!installation}`);

        if (installation && installation.merchantId) {
          console.log(`[SF-DESIGNER ${requestId}] [STEP 3] Before getMerchant(${installation.merchantId})`);
          const getMerchStart = Date.now();
          merchant = await withTimeout(
            storage.getMerchant(installation.merchantId),
            4000,
            "getMerchant"
          );
          console.log(`[SF-DESIGNER ${requestId}] [STEP 3] After getMerchant - ${Date.now() - getMerchStart}ms - found=${!!merchant}`);
        }
      }

      if (!merchant) {
        console.log(`[SF-DESIGNER ${requestId}] ERROR: Merchant not found for shop: ${shop}`);
        responded = true;
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.status(404).json({
          error: "Shop not found",
          debug: { shop, expectedUserId: `shopify:merchant:${shop}`, productTypeId: id }
        });
      }

      console.log(`[SF-DESIGNER ${requestId}] Found merchant ID: ${merchant.id}`);

      // 4️⃣ PRODUCT TYPE LOOKUP
      console.log(`[SF-DESIGNER ${requestId}] [STEP 4] Before getProductType(${id})`);
      const ptStart = Date.now();
      const productType = await withTimeout(
        storage.getProductType(id),
        4000,
        "getProductType"
      );
      console.log(`[SF-DESIGNER ${requestId}] [STEP 4] After getProductType - ${Date.now() - ptStart}ms - found=${!!productType}`);

      // Extra context from query params for smart matching
      const displayName = req.query.displayName as string | undefined;
      const productHandle = req.query.productHandle as string | undefined;

      let resolvedProductType = productType;
      let resolvedFrom: string | undefined;

      // Ownership mismatch counts as "not found" for this merchant
      if (productType && productType.merchantId && productType.merchantId !== merchant.id) {
        console.log(`[SF-DESIGNER ${requestId}] Ownership mismatch: productType.merchantId=${productType.merchantId} vs merchant.id=${merchant.id} - treating as not found`);
        resolvedProductType = undefined;
      }

      if (!resolvedProductType) {
        // FALLBACK: Auto-resolve to a valid product type for this merchant
        console.log(`[SF-DESIGNER ${requestId}] Product type ${id} not found/not owned - attempting fallback`);
        const merchantProductTypes = await withTimeout(
          storage.getProductTypesByMerchant(merchant.id),
          4000,
          "getProductTypesByMerchant"
        );
        console.log(`[SF-DESIGNER ${requestId}] Merchant has ${merchantProductTypes.length} product types: [${merchantProductTypes.map(pt => `${pt.id}:${pt.name}`).join(', ')}]`);

        if (merchantProductTypes.length === 0) {
          // True misconfiguration - no product types at all
          console.error(`[SF-DESIGNER ${requestId}] ❌ ZERO product types for merchant ${merchant.id} - cannot fallback`);
          responded = true;
          res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
          return res.status(404).json({
            error: "No product types configured for this shop",
            debug: { requestedId: id, merchantId: merchant.id, availableIdsForMerchant: [] }
          });
        }

        // Try matching by productHandle first (most precise)
        if (productHandle && !resolvedProductType) {
          resolvedProductType = merchantProductTypes.find(
            pt => (pt as any).shopifyProductHandle === productHandle
          );
          if (resolvedProductType) {
            resolvedFrom = "handle_match";
            console.log(`[SF-DESIGNER ${requestId}] ✅ Matched by productHandle "${productHandle}" → id=${resolvedProductType.id}`);
          }
        }

        // Try matching by displayName (fuzzy)
        if (displayName && !resolvedProductType) {
          const normalizedDisplay = displayName.toLowerCase().trim();
          resolvedProductType = merchantProductTypes.find(
            pt => pt.name.toLowerCase().trim() === normalizedDisplay
          );
          if (resolvedProductType) {
            resolvedFrom = "displayName_match";
            console.log(`[SF-DESIGNER ${requestId}] ✅ Matched by displayName "${displayName}" → id=${resolvedProductType.id}`);
          }
        }

        // If exactly one product type, use it
        if (!resolvedProductType && merchantProductTypes.length === 1) {
          resolvedProductType = merchantProductTypes[0];
          resolvedFrom = "only_available";
          console.log(`[SF-DESIGNER ${requestId}] ✅ Only one product type available → id=${resolvedProductType.id}`);
        }

        // Last resort: pick the smallest ID (deterministic)
        if (!resolvedProductType) {
          resolvedProductType = merchantProductTypes.reduce((a, b) => a.id < b.id ? a : b);
          resolvedFrom = "smallest_id_fallback";
          console.log(`[SF-DESIGNER ${requestId}] ⚠️ Multiple product types, picking smallest id=${resolvedProductType.id}`);
        }

        console.warn(`[SF-DESIGNER ${requestId}] ⚠️ FALLBACK RESOLVED: requested=${id} → resolved=${resolvedProductType.id} reason=${resolvedFrom} shop=${shop}`);
      }

      const productTypeToUse = resolvedProductType;
      console.log(`[SF-DESIGNER ${requestId}] Using product type: ${productTypeToUse.name} (id=${productTypeToUse.id}, merchantId: ${productTypeToUse.merchantId})`);


      // 5️⃣ BUILD CONFIG using shared helper
      console.log(`[SF-DESIGNER ${requestId}] [STEP 6] Building designer config...`);
      const buildStart = Date.now();
      const designerConfig = buildDesignerConfig(productTypeToUse, id, resolvedFrom);
      console.log(`[SF-DESIGNER ${requestId}] [STEP 6] Config built - ${Date.now() - buildStart}ms`);

      // 6️⃣ SEND RESPONSE
      const totalMs = Date.now() - startTime;
      console.log(`[SF-DESIGNER ${requestId}] [STEP 7] Before sending response - total elapsed: ${totalMs}ms`);

      responded = true;
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      res.json(designerConfig);

      console.log(`[SF-DESIGNER ${requestId}] ✅ SUCCESS - shop=${shop} id=${id} ms=${totalMs}`);
      console.log(`[SF-DESIGNER ${requestId}] ========== REQUEST END ==========`);

    } catch (error) {
      // 4️⃣ CATCH BLOCK - log full error stack
      const totalMs = Date.now() - startTime;
      console.error(`[SF-DESIGNER ${requestId}] ❌ EXCEPTION after ${totalMs}ms`);
      console.error(`[SF-DESIGNER ${requestId}] Error name: ${(error as Error).name}`);
      console.error(`[SF-DESIGNER ${requestId}] Error message: ${(error as Error).message}`);
      console.error(`[SF-DESIGNER ${requestId}] Error stack: ${(error as Error).stack}`);

      if (!responded) {
        responded = true;
        res.status(500).json({
          error: "Failed to fetch designer configuration",
          requestId,
          elapsed: totalMs,
          errorMessage: (error as Error).message
        });
      }
    } finally {
      // 5️⃣ CLEAR TIMEOUT IN FINALLY
      if (killSwitchTimeout) {
        clearTimeout(killSwitchTimeout);
        console.log(`[SF-DESIGNER ${requestId}] Kill switch timeout cleared`);
      }
    }
  });

  // Debug endpoint to list all product types for a shop (no auth, for troubleshooting)
  app.get("/api/storefront/debug/product-types", async (req: Request, res: Response) => {
    const shop = req.query.shop as string;

    if (!shop) {
      return res.status(400).json({ error: "Missing shop parameter" });
    }

    try {
      // Try to find merchant
      let merchant = await storage.getMerchantByShop(shop);
      let merchantSource = "direct";

      if (!merchant) {
        const installation = await storage.getShopifyInstallationByShop(shop);
        if (installation && installation.merchantId) {
          merchant = await storage.getMerchant(installation.merchantId);
          merchantSource = "installation";
        }
      }

      const allProductTypes = await storage.getActiveProductTypes();
      const merchantProductTypes = merchant
        ? await storage.getProductTypesByMerchant(merchant.id)
        : [];

      console.log(`[debug/product-types] shop=${shop} merchantId=${merchant?.id || 'none'} count=${merchantProductTypes.length}`);

      res.json({
        shop,
        merchant: merchant ? { id: merchant.id, userId: merchant.userId } : null,
        merchantSource,
        productTypes: {
          forMerchant: merchantProductTypes.map(pt => ({
            id: pt.id,
            name: pt.name,
            merchantId: pt.merchantId,
            designerType: pt.designerType,
            shopifyProductHandle: pt.shopifyProductHandle || null,
            printifyBlueprintId: pt.printifyBlueprintId || null
          })),
          allActive: allProductTypes.map(pt => ({
            id: pt.id,
            name: pt.name,
            merchantId: pt.merchantId,
            designerType: pt.designerType,
            shopifyProductHandle: pt.shopifyProductHandle || null
          }))
        }
      });
    } catch (error) {
      console.error("[Storefront Debug] Error:", error);
      res.status(500).json({ error: "Failed to fetch debug info" });
    }
  });

  // Storefront ping endpoint - quick health check for embed to verify connectivity
  app.get("/api/storefront/ping", (req: Request, res: Response) => {
    const timestamp = Date.now();
    const reqId = (req as any).reqId || "none";
    console.log(`[SF PING] reqId=${reqId}`);
    res.json({
      ok: true,
      timestamp,
      service: "appai-pod",
      env: process.env.NODE_ENV || "development",
      buildId: process.env.BUILD_ID || "unknown",
      gitCommit: (process.env.RAILWAY_GIT_COMMIT_SHA || "unknown").substring(0, 8),
      reqId,
    });
  });

  // Get storefront status (credits, generation limits)
  app.get("/api/storefront/status", async (req: Request, res: Response) => {
    try {
      const { shop, sessionId, customerId } = req.query;
      if (!shop) return res.status(400).json({ error: "Shop domain required" });

      const FREE_GENERATION_LIMIT = 10;

      // If customer is logged in, check their credits and free generations
      if (customerId) {
        const customer = await storage.getOrCreateShopifyCustomer(shop as string, customerId as string);

        if (customer.credits > 0) {
          await storage.decrementCreditsIfAvailable(customer.id);
        } else if (customer.freeGenerationsUsed < FREE_GENERATION_LIMIT) {
          await storage.updateCustomer(customer.id, { freeGenerationsUsed: customer.freeGenerationsUsed + 1 });
        } else {
          return res.status(403).json({ error: "FREE_LIMIT_REACHED", message: "You have used all 10 of your free generations. Please purchase more credits to continue." });
        }
      } else if (sessionId) {
        // Anonymous session limit
        const count = await storage.countSessionGenerations(shop as string, sessionId as string);
        if (count >= FREE_GENERATION_LIMIT) {
          return res.status(403).json({
            error: "FREE_LIMIT_REACHED",
            message: "You have used all 10 of your free generations. Please log in to purchase more credits.",
          });
        }
      }
      let generationsUsed = 0;
      let creditsRemaining = 0;

      if (customerId) {
        const customer = await storage.getOrCreateShopifyCustomer(shop as string, customerId as string);
        generationsUsed = customer.freeGenerationsUsed || 0;
        creditsRemaining = customer.credits || 0;
      } else if (sessionId) {
        generationsUsed = await storage.countSessionGenerations(shop as string, sessionId as string);
      }

      res.json({
        generationsUsed,
        freeLimit: FREE_GENERATION_LIMIT,
        creditsRemaining,
        isLimitReached: generationsUsed >= FREE_GENERATION_LIMIT && creditsRemaining <= 0
      });
    } catch (error) {
      console.error("Error checking storefront status:", error);
      res.status(500).json({ error: "Failed to check status" });
    }
  });

  // Resolve product type ID from shop + product handle
  app.get("/api/storefront/resolve-product-type", asyncHandler(async (req: Request, res: Response) => {
    const shop = req.query.shop as string;
    const handle = req.query.handle as string;
    const startTime = Date.now();

    if (!shop) {
      return res.status(400).json({ error: "Missing shop parameter" });
    }
    if (!handle) {
      return res.status(400).json({ error: "Missing handle parameter" });
    }

    // 5-second server-side timeout: if DB lookups take too long, return 503
    // so the client doesn't hang for 30s waiting for a response.
    const TIMEOUT_MS = 5000;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => {
        timedOut = true;
        reject(new Error("resolve-product-type server timeout"));
      }, TIMEOUT_MS)
    );

    try {
      await Promise.race([timeoutPromise, (async () => {
        // Resolve merchant
        let merchant = await storage.getMerchantByShop(shop);

        if (!merchant) {
          const installation = await storage.getShopifyInstallationByShop(shop);
          if (installation && installation.merchantId) {
            merchant = await storage.getMerchant(installation.merchantId);
          }
        }

        if (!merchant) {
          console.log(`[resolve-product-type] shop=${shop} handle=${handle} error=merchant_not_found ms=${Date.now() - startTime}`);
          res.status(404).json({ error: "Shop not found", shop, handle });
          return;
        }

        // Get all product types for this merchant
        const merchantProductTypes = await storage.getProductTypesByMerchant(merchant.id);

        // Try to match by shopifyProductHandle
        let matchedProductType = merchantProductTypes.find(
          (pt: any) => pt.shopifyProductHandle?.toLowerCase() === handle.toLowerCase()
        );
        let reason = "matched_by_shopify_handle";

        if (!matchedProductType) {
          const handleWords = handle.toLowerCase().replace(/-/g, ' ').split(' ').filter((w: string) => w.length > 2);
          matchedProductType = merchantProductTypes.find((pt: any) => {
            const ptNameLower = pt.name.toLowerCase();
            return handleWords.some((word: string) => ptNameLower.includes(word));
          });
          if (matchedProductType) reason = "fuzzy_matched_by_name";
        }

        if (!matchedProductType) {
          const handleLower = handle.toLowerCase();
          if (handleLower.includes('tumbler') || handleLower.includes('mug') || handleLower.includes('cup')) {
            matchedProductType = merchantProductTypes.find((pt: any) => pt.designerType === 'mug');
            if (matchedProductType) reason = "matched_by_designer_type_mug";
          } else if (handleLower.includes('frame') || handleLower.includes('poster') || handleLower.includes('print') || handleLower.includes('art')) {
            matchedProductType = merchantProductTypes.find((pt: any) => pt.designerType === 'framed-print');
            if (matchedProductType) reason = "matched_by_designer_type_framed_print";
          } else if (handleLower.includes('shirt') || handleLower.includes('tee') || handleLower.includes('hoodie')) {
            matchedProductType = merchantProductTypes.find((pt: any) => pt.designerType === 'apparel');
            if (matchedProductType) reason = "matched_by_designer_type_apparel";
          } else if (handleLower.includes('pillow') || handleLower.includes('cushion')) {
            matchedProductType = merchantProductTypes.find((pt: any) => pt.designerType === 'pillow');
            if (matchedProductType) reason = "matched_by_designer_type_pillow";
          }
        }

        const ms = Date.now() - startTime;

        if (matchedProductType) {
          console.log(`[resolve-product-type] shop=${shop} handle=${handle} resolved=${matchedProductType.id} reason=${reason} ms=${ms}`);
          res.json({
            productTypeId: matchedProductType.id,
            productTypeName: matchedProductType.name,
            designerType: matchedProductType.designerType,
            reason, shop, handle, merchantId: merchant.id
          });
        } else {
          console.log(`[resolve-product-type] shop=${shop} handle=${handle} error=no_match ms=${ms}`);
          res.status(404).json({
            error: "No matching product type found",
            shop, handle, merchantId: merchant.id,
            availableProductTypes: merchantProductTypes.map((pt: any) => ({
              id: pt.id, name: pt.name, designerType: pt.designerType,
              shopifyProductHandle: pt.shopifyProductHandle || null
            })),
            hint: "Set shopifyProductHandle on the product type or use data attribute in storefront"
          });
        }
      })()]);
    } catch (error: any) {
      const ms = Date.now() - startTime;
      if (timedOut) {
        console.warn(`[resolve-product-type] TIMEOUT shop=${shop} handle=${handle} ms=${ms}`);
        if (!res.headersSent) res.status(503).json({ error: "Resolver timed out", shop, handle });
      } else {
        console.error(`[resolve-product-type] Error shop=${shop} handle=${handle} ms=${ms}:`, error?.message ?? error);
        if (!res.headersSent) res.status(500).json({ error: "Failed to resolve product type" });
      }
    }
  }));

  // ==================== STOREFRONT GENERATE (NO SESSION TOKEN) ====================
  // Used by storefront embeds where App Bridge session tokens are not available.
  // Validates shop domain + active installation instead of session token.
  app.post("/api/storefront/generate", async (req: Request, res: Response) => {
    const P = "[SF GEN]";
    const t0 = Date.now();
    const reqId = (req as any).reqId || req.headers["x-req-id"] || `gen-${Date.now().toString(36)}`;

    function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
      return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
        ),
      ]);
    }

    try {
      const { prompt, userPrompt: rawUserPrompt, stylePreset, size, frameColor, referenceImage, referenceImages: referenceImagesArrSf, shop, bgRemovalSensitivity, productTypeId, sessionId, customerId, baseImageUrl: clientBaseImageUrlSf } = req.body;
      console.log(P, reqId, "start", { shop, sessionId: sessionId?.substring(0, 8), customerId, productTypeId, contentType: req.headers["content-type"] });

      if (!shop) {
        return res.status(400).json({ error: "Shop domain required", reqId, stage: "validation" });
      }

      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
        return res.status(400).json({ error: "Invalid shop domain format", reqId, stage: "validation" });
      }

      // Verify shop is installed
      let t1 = Date.now();
      const installation = await withTimeout(
        storage.getShopifyInstallationByShop(shop), 5000, "getShopifyInstallationByShop"
      );
      console.log(P, reqId, `installation lookup ok in ${Date.now() - t1}ms`);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized", reqId, stage: "auth" });
      }

      // Generation limit logic (10 free generations total per customer/session)
      const FREE_GENERATION_LIMIT = 10;

      // Credit/limit check is handled in the block below (single deduction)
      let customer: any = null;

      if (customerId) {
        // Determine if this is an OTP customer (internal UUID) or Shopify-native customer (numeric ID).
        // OTP customers are already in the DB by their internal UUID; Shopify-native customers are
        // looked up/created via getOrCreateShopifyCustomer using their Shopify numeric ID.
        const isOtpCustomer = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customerId);
        if (isOtpCustomer) {
          customer = await storage.getCustomer(customerId);
          if (!customer) {
            console.warn(P, reqId, `OTP customer ${customerId} not found in DB`);
          }
        } else {
          customer = await storage.getOrCreateShopifyCustomer(shop, customerId);
        }
        
        if (customer) {
          // If customer has credits, use them first
          if (customer.credits > 0) {
            console.log(P, reqId, `customer ${customerId} has ${customer.credits} credits, deducting 1`);
            const updated = await storage.decrementCreditsIfAvailable(customer.id);
            if (!updated) {
              return res.status(403).json({ error: "INSUFFICIENT_CREDITS", message: "You've run out of credits. Purchase more to continue." });
            }
          } else {
            // No credits, check free limit
            const freeUsed = customer.freeGenerationsUsed || 0;
            if (freeUsed >= FREE_GENERATION_LIMIT) {
              return res.status(403).json({
                error: "FREE_LIMIT_REACHED",
                message: "You've used all 10 free generations. Purchase credits to continue.",
                generationsUsed: freeUsed,
                limit: FREE_GENERATION_LIMIT,
              });
            }
            // Increment free usage
            await storage.updateCustomer(customer.id, { freeGenerationsUsed: freeUsed + 1 });
            console.log(P, reqId, `customer ${customerId} used free generation ${freeUsed + 1}/${FREE_GENERATION_LIMIT}`);
          }
        }
      } else if (sessionId) {
        // Anonymous session limit
        const count = await storage.countSessionGenerations(shop, sessionId);
        if (count >= FREE_GENERATION_LIMIT) {
          return res.status(403).json({
            error: "FREE_LIMIT_REACHED",
            message: "You've used all 10 free generations. Create an account to continue.",
            generationsUsed: count,
            limit: FREE_GENERATION_LIMIT,
          });
        }
      }

      // Gallery limit check for logged-in customers (20 saved designs max)
      const GALLERY_LIMIT = 20;
      if (customerId) {
        const savedCount = await db
          .select({ count: sql<number>`count(*)` })
          .from(generationJobs)
          .where(
            and(
              eq(generationJobs.shop, shop),
              eq(generationJobs.customerId, customerId),
              eq(generationJobs.status, "complete")
            )
          );
        const currentCount = Number(savedCount[0]?.count ?? 0);
        if (currentCount >= GALLERY_LIMIT) {
          return res.status(400).json({
            error: "GALLERY_FULL",
            message: `Your saved designs gallery is full (${GALLERY_LIMIT} max). Please delete some designs to generate new ones.`,
            count: currentCount,
            limit: GALLERY_LIMIT,
          });
        }
      }

      // Rate limiting per shop (shared with admin endpoint)
      const now = Date.now();
      let rateLimit = shopifyGenerationRateLimits.get(shop);

      if (!rateLimit || now > rateLimit.resetAt) {
        rateLimit = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
        shopifyGenerationRateLimits.set(shop, rateLimit);
      }

      if (rateLimit.count >= SHOPIFY_RATE_LIMIT) {
        return res.status(429).json({
          error: "Rate limit exceeded. Please try again later.",
          retryAfter: Math.ceil((rateLimit.resetAt - now) / 1000)
        });
      }

      rateLimit.count++;

      if (!prompt || !size) {
        return res.status(400).json({ error: "Prompt and size are required" });
      }

      // Look up style preset
      let stylePromptPrefix = "";
      let sfStyleCategory = "all";
      let sfStyleBaseImageUrl: string | undefined;
      let sfStyleBaseImageUrls: string[] = [];
      if (stylePreset && installation.merchantId) {
        t1 = Date.now();
        const dbStyles = await withTimeout(
          storage.getStylePresetsByMerchant(installation.merchantId), 5000, "getStylePresetsByMerchant"
        );
        console.log(P, reqId, `style presets lookup ok in ${Date.now() - t1}ms`);
        const selectedStyle = dbStyles.find((s: { id: number; promptPrefix: string | null; category?: string | null; baseImageUrl?: string | null }) => s.id.toString() === stylePreset);
        if (selectedStyle && selectedStyle.promptPrefix) {
          stylePromptPrefix = selectedStyle.promptPrefix;
          sfStyleCategory = selectedStyle.category || "all";
          const dbBaseUrls: string[] = (selectedStyle as any).baseImageUrls ||
            (selectedStyle.baseImageUrl ? [selectedStyle.baseImageUrl] : []);
          sfStyleBaseImageUrls = dbBaseUrls;
          if (dbBaseUrls.length > 0) sfStyleBaseImageUrl = dbBaseUrls[0];
        }
        if (!stylePromptPrefix) {
          const hardcodedStyle = STYLE_PRESETS.find(s => s.id === stylePreset);
          if (hardcodedStyle && hardcodedStyle.promptPrefix) {
            stylePromptPrefix = hardcodedStyle.promptPrefix;
            sfStyleCategory = hardcodedStyle.category || "all";
          }
        }
      }
      if (!sfStyleBaseImageUrl && clientBaseImageUrlSf) {
        sfStyleBaseImageUrl = clientBaseImageUrlSf;
        sfStyleBaseImageUrls = [clientBaseImageUrlSf];
      }

      // Load product type config
      let productType: any = null;
      if (productTypeId && installation.merchantId) {
        t1 = Date.now();
        const resolved = await withTimeout(
          resolveStorefrontProductType(parseInt(productTypeId), installation.merchantId, "[Storefront Generate]"),
          5000, "resolveStorefrontProductType"
        );
        console.log(P, reqId, `product type resolve ok in ${Date.now() - t1}ms`);
        if ("productType" in resolved) {
          productType = resolved.productType;
        }
      } else if (productTypeId) {
        t1 = Date.now();
        productType = await withTimeout(
          storage.getProductType(parseInt(productTypeId)), 5000, "getProductType"
        );
        console.log(P, reqId, `product type lookup ok in ${Date.now() - t1}ms`);
      }





      // Find size config
      let sizeConfig = PRINT_SIZES.find(s => s.id === size);

      if (!sizeConfig && productType) {
        const productSizes = JSON.parse(productType.sizes || "[]");
        const productSize = productSizes.find((s: any) => s.id === size);
        let aspectRatioStr = productSize?.aspectRatio || productType.aspectRatio || "3:4";

        // For double-sided products, the stored ratio may be the combined front+back ratio.
        // Convert to per-side ratio so the AI generates artwork for one side only.
        if (productType.doubleSidedPrint) {
          const [arW, arH] = aspectRatioStr.split(":").map(Number);
          if (arW && arH && !isNaN(arW) && !isNaN(arH)) {
            const ratio = arW / arH;
            if (ratio >= 1.9) {
              // Likely a combined ratio (e.g. 2:1 for square pillow front+back).
              // Halve the width to get per-side ratio.
              const perSideW = arW / 2;
              const gcdFn = (a: number, b: number): number => b === 0 ? a : gcdFn(b, a % b);
              const d = gcdFn(Math.round(perSideW), arH);
              aspectRatioStr = `${Math.round(perSideW / d)}:${Math.round(arH / d)}`;
              console.log(P, reqId, `Double-sided ratio override: ${arW}:${arH} → ${aspectRatioStr} (per-side)`);
            }
          }
        }

        const genDims = calculateGenDimensions(aspectRatioStr);

        sizeConfig = {
          id: productSize?.id || size,
          name: productSize?.name || size,
          width: productSize?.width || 12,
          height: productSize?.height || 16,
          aspectRatio: aspectRatioStr,
          genWidth: genDims.genWidth,
          genHeight: genDims.genHeight,
        } as any;
      }

      if (!sizeConfig) {
        let aspectRatioStr = productType?.aspectRatio || "3:4";

        if (productType?.doubleSidedPrint) {
          const [arW, arH] = aspectRatioStr.split(":").map(Number);
          if (arW && arH && !isNaN(arW) && !isNaN(arH) && arW / arH >= 1.9) {
            const perSideW = arW / 2;
            const gcdFn = (a: number, b: number): number => b === 0 ? a : gcdFn(b, a % b);
            const d = gcdFn(Math.round(perSideW), arH);
            aspectRatioStr = `${Math.round(perSideW / d)}:${Math.round(arH / d)}`;
            console.log(P, reqId, `Double-sided fallback ratio override → ${aspectRatioStr} (per-side)`);
          }
        }

        const genDims = calculateGenDimensions(aspectRatioStr);
        sizeConfig = { id: size, name: size, width: 12, height: 16, aspectRatio: aspectRatioStr, genWidth: genDims.genWidth, genHeight: genDims.genHeight } as any;
      }

      // Determine apparel status early — affects both prompt and dimensions
      let isApparel = productType?.designerType === "apparel";
      if (!isApparel && sfStyleCategory === "apparel") {
        isApparel = true;
      }

      const isAllOverPrint = !!(productType?.isAllOverPrint);
      // When user provides a description, it becomes the subject; style prefix provides artistic direction.
      // Pattern: "[userDescription], [stylePrefix]" so the AI prioritises the user's intent.
      const userDescSf = (rawUserPrompt || "").trim();
      let fullPrompt: string;
      if (stylePromptPrefix) {
        if (userDescSf) {
          fullPrompt = `${userDescSf}, ${stylePromptPrefix}`;
        } else {
          fullPrompt = stylePromptPrefix;
        }
      } else {
        fullPrompt = prompt;
      }

      let sizingRequirements: string;

      if (isApparel && isAllOverPrint) {
        // AOP: solid white background so Picsart removebg can cleanly strip it
        sizingRequirements = `
MANDATORY IMAGE REQUIREMENTS FOR ALL-OVER PRINT (AOP) - FOLLOW EXACTLY:
1. ISOLATED MOTIF: Create a SINGLE, centered graphic design that is ISOLATED from any background scenery. This motif will be tiled into a repeating pattern.
2. SOLID FLAT WHITE BACKGROUND: The ENTIRE background MUST be a flat, solid, uniform pure white (#FFFFFF) color. Every pixel that is not part of the design must be exactly #FFFFFF. DO NOT create scenic backgrounds, gradients, or detailed environments.
3. DESIGN COLORS: Use VIBRANT, BOLD colors. The design MUST NOT contain any pure white pixels in the main subject — white is reserved exclusively for the background.
4. CENTERED COMPOSITION: The main design subject should be centered and take up approximately 60-70% of the canvas, leaving clean white space around it.
5. CLEAN EDGES: The design must have crisp, clean edges against the white background. No fuzzy, gradient, or semi-transparent edges.
6. NO RECTANGULAR FRAMES: Do NOT put the design inside a rectangular box, border, or frame. The design should stand alone on the solid white background.
7. PRINT-READY: This is for all-over print fabric — create an isolated motif graphic.
8. COMPOSITION FORMAT: Fill the canvas matching the requested aspect ratio with the design centered.
9. STRICT PROMPT ADHERENCE: ONLY depict exactly what the user described. Do NOT add text, slogans, words, brand names, themed scenarios, or additional story elements unless the user explicitly asked for them.
`;
      } else if (isApparel) {
        // Apparel: #FF00FF chroma key background for precise removal
        const frameColor = req.body.frameColor;
        let colorTier: ColorTier = "light";
        if (frameColor && productType) {
          const frameColors = JSON.parse(productType.frameColors || "[]");
          const selectedColor = frameColors.find((c: any) => c.id === frameColor);
          if (selectedColor?.hex) {
            colorTier = getColorTier(selectedColor.hex);
          }
        }
        const isDarkTier = colorTier === "dark";
        const designColors = isDarkTier
          ? "BRIGHT, VIBRANT colors including white and light tones. AVOID dark, black, and hot pink/magenta colors in the design."
          : "VIBRANT colors. AVOID white, light colors, and hot pink/magenta in the design.";

        // Use dark tier prompt variant if available
        if (isDarkTier && stylePreset && APPAREL_DARK_TIER_PROMPTS[stylePreset]) {
          const darkTierPrompt = APPAREL_DARK_TIER_PROMPTS[stylePreset];
          if (darkTierPrompt) {
            fullPrompt = userDescSf ? `${userDescSf}, ${darkTierPrompt}` : darkTierPrompt;
          }
        }

        sizingRequirements = `

MANDATORY IMAGE REQUIREMENTS FOR APPAREL PRINTING - FOLLOW EXACTLY:
1. ISOLATED DESIGN: Create a SINGLE, centered graphic design that is ISOLATED from any background scenery.
2. SOLID HOT PINK (#FF00FF) BACKGROUND: The ENTIRE background MUST be a flat, uniform hot pink (#FF00FF) color. Every pixel that is not part of the design must be exactly #FF00FF. DO NOT create scenic backgrounds, landscapes, or detailed environments.
3. DESIGN COLORS: Use ${designColors} The design MUST NOT contain any hot pink or magenta (#FF00FF) pixels — this color is reserved exclusively for the background.
4. CENTERED COMPOSITION: The main design subject should be centered and take up approximately 60-70% of the canvas, leaving clean #FF00FF space around it.
5. CLEAN EDGES: The design must have crisp, clean edges against the hot pink background. No fuzzy, gradient, or semi-transparent edges.
6. NO RECTANGULAR FRAMES: Do NOT put the design inside a rectangular box, border, or frame. The design should stand alone on the solid hot pink background.
7. PRINT-READY: This is for t-shirt/apparel printing — create an isolated graphic that can be printed on fabric.
8. COMPOSITION FORMAT: Fill the canvas matching the requested aspect ratio with the design centered.
9. STRICT PROMPT ADHERENCE: ONLY depict exactly what the user described. Do NOT add text, slogans, words, brand names, themed scenarios, or additional story elements unless the user explicitly asked for them.
`;
      } else {
        // Decor: full-bleed edge-to-edge designs
        const printShape = productType?.printShape || "rectangle";
        const bleedMargin = productType?.bleedMarginPercent || 5;
        const safeZonePercent = 100 - (bleedMargin * 2);

        let shapeInstructions = "";
        if (printShape === "circle") {
          shapeInstructions = `
CIRCULAR PRINT AREA: This design is for a CIRCULAR product (like a round pillow or coaster).
- Center all important elements (faces, text, focal points) within the inner ${safeZonePercent}% of the circle
- Keep a ${bleedMargin}% margin from the circular edge for manufacturing bleed
- The corners of the canvas will be cropped to a circle - nothing important should be in the corners
- Design with radial/circular composition in mind`;
        } else if (printShape === "square") {
          shapeInstructions = `
SQUARE PRINT AREA: This design is for a square product.
- Center important elements within the inner ${safeZonePercent}% of the canvas
- Keep a ${bleedMargin}% margin from all edges for bleed`;
        } else {
          shapeInstructions = `
RECTANGULAR PRINT AREA:
- Keep important elements within the inner ${safeZonePercent}% of the canvas
- Maintain a ${bleedMargin}% margin from edges for bleed`;
        }

        const [arW, arH] = sizeConfig.aspectRatio.split(":").map(Number);
        const aspectRatioValue = arW / arH;
        let orientationDescription: string;
        if (aspectRatioValue > 1.05) {
          orientationDescription = `HORIZONTAL LANDSCAPE (wider than tall)`;
        } else if (aspectRatioValue < 0.95) {
          orientationDescription = `VERTICAL PORTRAIT (taller than wide)`;
        } else {
          orientationDescription = `SQUARE`;
        }

        const isWrapAround = aspectRatioValue >= 1.2;
        const textEdgeRestrictions = isWrapAround
          ? `
TEXT AND ELEMENT PLACEMENT - CRITICAL:
- DO NOT place any text, letters, words, or important elements within 20% of ANY edge
- ALL text must be positioned in the CENTER 60% of the image both horizontally and vertically
- The outer 20% margins on ALL sides should contain ONLY background/scenery - NO text whatsoever
- This is a WRAP-AROUND cylindrical product - edges will be hidden or wrapped around`
          : `
TEXT AND ELEMENT PLACEMENT:
- Keep all text and important elements within the central 75% of the image
- Avoid placing critical content near the edges where it may be cut off during printing`;

        sizingRequirements = `

=== CRITICAL CANVAS REQUIREMENTS (MUST FOLLOW) ===
CANVAS: ${orientationDescription} format
FULL-BLEED MANDATORY: The artwork MUST fill the ENTIRE canvas edge-to-edge with NO blank margins, borders, or empty space. Paint/draw to ALL four edges.
${shapeInstructions}
${textEdgeRestrictions}

=== IMAGE CONTENT REQUIREMENTS ===
1. The background/scene MUST extend fully to ALL four edges - no visible canvas boundaries
2. NO decorative borders, picture frames, drop shadows, or vignettes
3. The subject must NOT appear floating - complete the background behind and around it
4. This is for high-quality printing - create finished artwork that bleeds to all edges
`;
      }

      const geminiAspectRatio = mapToGeminiAspectRatio(sizeConfig.aspectRatio);
      fullPrompt = `${sizingRequirements}\n\n=== ARTWORK DESCRIPTION ===\n${fullPrompt}`;

      // Capture appUrl from request before responding (used for reference image resolution in worker)
      const appUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
      let targetDims: TargetDimensions | undefined;
      if (!isApparel) {
        const genWidth = (sizeConfig as any).genWidth || 1024;
        const genHeight = (sizeConfig as any).genHeight || 1024;
        targetDims = { width: genWidth, height: genHeight };
      }

      // ── Create job record and return immediately ──────────────────────────────
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min TTL
      t1 = Date.now();
      const job = await withTimeout(storage.createGenerationJob({
        shop,
        sessionId: sessionId ?? null,
        customerId: customerId ?? null,
        status: "pending",
        prompt,
        userPrompt: rawUserPrompt ?? null,
        stylePreset: stylePreset ?? null,
        size: size ?? null,
        frameColor: frameColor ?? null,
        productTypeId: productTypeId ? String(productTypeId) : null,
        referenceImageUrl: null,
        expiresAt,
      }), 8000, "createGenerationJob");
      const jobId = job.id;
      console.log(P, reqId, `created jobId=${jobId} in ${Date.now() - t1}ms (total pre-response ${Date.now() - t0}ms)`);

      // ── Background worker: AI call + storage save ─────────────────────────────
      // Fire-and-forget; never awaited. Railway keeps the process alive.
      (async () => {
        const wStart = Date.now();
        const W = `[SF-GEN ${reqId}]`;
        try {
          await storage.updateGenerationJob(jobId, { status: "running" });
          console.log(`${W} worker started jobId=${jobId} +${Date.now() - wStart}ms`);

          // Resolve customer reference image(s) — supports both single and array
          const sfCustomerImageUrls: string[] = [];
          const sfRawRefImages: string[] = Array.isArray(referenceImagesArrSf) && referenceImagesArrSf.length > 0
            ? referenceImagesArrSf
            : referenceImage ? [referenceImage] : [];
          for (const refImg of sfRawRefImages.slice(0, 5)) {
            try {
              let resolvedUrl: string | null = null;
              if (refImg.startsWith("data:")) {
                resolvedUrl = refImg;
              } else if (refImg.startsWith("http")) {
                resolvedUrl = refImg;
              } else if (refImg.startsWith("/objects/")) {
                resolvedUrl = `${appUrl}${refImg}`;
              }
              if (resolvedUrl) {
                sfCustomerImageUrls.push(resolvedUrl);
                const urlType = resolvedUrl.startsWith("data:") ? "data-url" : "http-url";
                console.log(`${W} Reference image ${sfCustomerImageUrls.length}: type=${urlType}, size=${resolvedUrl.length} chars`);
                if (sfCustomerImageUrls.length === 1) {
                  await storage.updateGenerationJob(jobId, { referenceImageUrl: urlType === "data-url" ? "data-url-provided" : resolvedUrl });
                }
              }
            } catch (refErr) {
              console.warn(`${W} Could not process reference image, skipping:`, refErr);
            }
          }
          const sfCustomerImageUrl: string | null = sfCustomerImageUrls[0] || null;
          console.log(`${W} ref image resolved +${Date.now() - wStart}ms`);

          // Build image input array: all style base images (up to 5) + customer reference(s)
          const sfImageInputUrls: string[] = [];
          for (const u of sfStyleBaseImageUrls) sfImageInputUrls.push(u);
          for (const u of sfCustomerImageUrls) sfImageInputUrls.push(u);
          const inputImageUrl: string | string[] | null = sfImageInputUrls.length > 1 ? sfImageInputUrls : sfImageInputUrls[0] || null;

          if (sfImageInputUrls.length > 0) {
            let refInstruction: string;
            if (sfStyleBaseImageUrl && sfCustomerImageUrls.length > 0) {
              refInstruction = `Multiple reference images are provided. The FIRST is a style/scene foundation — use it as the visual template. The remaining image(s) are the customer's subject(s) — incorporate them as focal elements. Do NOT duplicate subjects.`;
            } else if (sfCustomerImageUrls.length > 1) {
              refInstruction = `Multiple reference images are provided by the customer. Incorporate all subjects and elements from these images into a cohesive design. Do NOT duplicate subjects.`;
            } else if (sfCustomerImageUrl) {
              const isTextStyle = stylePreset && ["opinionated", "quotes"].includes(stylePreset);
              refInstruction = isTextStyle
                ? `Using the provided reference image, incorporate its subject as a SINGLE element integrated INTO the typographic composition. Do NOT duplicate.`
                : `Using the provided reference image as visual inspiration, incorporate its key elements, style, and subject into the design.`;
            } else {
              refInstruction = `Using the provided style reference image as visual inspiration and composition guide, create the design following its overall style and layout.`;
            }
            fullPrompt = `${refInstruction} ${fullPrompt}`;
          }

          // Call AI image generation
          const aiStart = Date.now();
          console.log(`${W} calling AI (aspectRatio=${geminiAspectRatio ?? "1:1"}) +${aiStart - wStart}ms`);
          const { data: base64Data, mimeType: generatedMimeType } = await generateImageBase64({
            prompt: fullPrompt,
            aspectRatio: geminiAspectRatio ?? "1:1",
            inputImageUrl,
            isApparel,
            isAllOverPrint,
          });
          console.log(`${W} AI returned ${Date.now() - aiStart}ms, hasData=${!!base64Data}, total +${Date.now() - wStart}ms`);

          if (!base64Data) {
            await storage.updateGenerationJob(jobId, { status: "failed", errorMessage: "AI model returned no image data" });
            console.error(`${W} AI returned no image data — job failed`);
            return;
          }

          const mimeType = generatedMimeType || "image/png";

          // Save image to object storage (retry once, then fall back to data URL)
          const saveStart = Date.now();
          let imageUrl: string;
          let thumbnailUrl: string | undefined;
          try {
            const result = await saveImageToStorage(base64Data, mimeType, { isApparel, isAllOverPrint, targetDims });
            imageUrl = result.imageUrl;
            thumbnailUrl = result.thumbnailUrl;
            console.log(`${W} storage save OK ${Date.now() - saveStart}ms`);
          } catch (storageError) {
            console.warn(`${W} Storage save failed, retrying once:`, storageError);
            try {
              const result = await saveImageToStorage(base64Data, mimeType, { isApparel, isAllOverPrint, targetDims });
              imageUrl = result.imageUrl;
              thumbnailUrl = result.thumbnailUrl;
              console.log(`${W} storage save OK on retry ${Date.now() - saveStart}ms`);
            } catch (retryError) {
              console.error(`${W} Storage save failed on retry, using data URL:`, retryError);
              imageUrl = `data:${mimeType};base64,${base64Data}`;
            }
          }

          const designId = `storefront-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

          await storage.updateGenerationJob(jobId, {
            status: "complete",
            designImageUrl: imageUrl,
            thumbnailUrl: thumbnailUrl ?? null,
            designId,
          });

          console.log(`${W} complete designId=${designId} total=${Date.now() - wStart}ms`);
        } catch (workerErr: any) {
          console.error(`${W} worker failed +${Date.now() - wStart}ms stage=unknown:`, workerErr.message ?? workerErr);
          await storage.updateGenerationJob(jobId, {
            status: "failed",
            errorMessage: workerErr.message ?? "Unknown generation error",
          }).catch(() => {});
        }
      })();

      // Return jobId immediately — client will poll /generate/status
      console.log(P, reqId, `responding jobId=${jobId} — total ${Date.now() - t0}ms`);
      return res.json({ jobId, reqId });
    } catch (error: any) {
      const isTimeout = error?.message?.includes("timed out after");
      const status = isTimeout ? 503 : 500;
      const stage = isTimeout ? error.message.split(" timed")[0] : "unknown";
      console.error(P, reqId, `Error (${Date.now() - t0}ms):`, error?.message ?? error);
      res.status(status).json({
        error: isTimeout ? error.message : "Failed to start generation",
        reqId,
        stage,
        elapsed: Date.now() - t0,
      });
    }
  });

  // ==================== STOREFRONT GENERATE STATUS ====================
  // Poll this endpoint after POST /api/storefront/generate returns { jobId }.
  app.get("/api/storefront/generate/status", async (req: Request, res: Response) => {
    const reqId = (req as any).reqId || "none";
    const t0 = Date.now();
    try {
      const { jobId, shop } = req.query as { jobId?: string; shop?: string };

      if (!jobId || !shop) {
        return res.status(400).json({ error: "jobId and shop are required", reqId });
      }

      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
        return res.status(400).json({ error: "Invalid shop domain format" });
      }

      // Fetch the job directly — shop mismatch check below replaces the installation lookup.
      // Removing the installation query halves DB load per poll (called every 2s).
      const job = await Promise.race([
        storage.getGenerationJob(jobId),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("getGenerationJob DB timeout")), 5000)
        ),
      ]);

      if (!job || job.shop !== shop) {
        return res.status(404).json({ error: "Job not found", reqId });
      }

      console.log(`[SF STATUS] ${reqId} jobId=${jobId} status=${job.status} ${Date.now() - t0}ms`);

      if (job.status === "complete") {
        let creditsRemaining = 0;
        if (job.customerId) {
          const isOtpCust = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.customerId);
          const cust = isOtpCust
            ? await storage.getCustomer(job.customerId)
            : await storage.getOrCreateShopifyCustomer(shop, job.customerId);
          creditsRemaining = cust?.credits ?? 0;
        } else if (job.sessionId) {
          const count = await storage.countSessionGenerations(shop, job.sessionId);
          creditsRemaining = Math.max(0, 10 - count);
        }

        return res.json({
          status: "complete",
          imageUrl: job.designImageUrl,
          thumbnailUrl: job.thumbnailUrl,
          designId: job.designId,
          creditsRemaining,
          mockupUrls: (job as any).mockupUrls || null,
          designState: (job as any).designState || null,
          prompt: (job as any).userPrompt || job.prompt || null,
          stylePreset: job.stylePreset || null,
          size: job.size || null,
          frameColor: job.frameColor || null,
          reqId,
        });
      }

      if (job.status === "failed") {
        return res.json({ status: "failed", error: job.errorMessage ?? "Generation failed", reqId });
      }

      // pending or running
      return res.json({ status: job.status, reqId });
    } catch (error: any) {
      console.error(`[SF STATUS] ${reqId} Error after ${Date.now() - t0}ms:`, error.message);
      res.status(500).json({ error: "Failed to fetch job status", reqId });
    }
  });

  // ==================== STOREFRONT MERGE SESSION ====================
  // After a customer logs in on the storefront, merge their anonymous
  // generations into their account so designs are not lost.
  app.post("/api/storefront/merge-session", async (req: Request, res: Response) => {
    try {
      const { sessionId, customerId, shop } = req.body;

      if (!sessionId || !customerId || !shop) {
        return res.status(400).json({ error: "sessionId, customerId, and shop are required" });
      }

      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
        return res.status(400).json({ error: "Invalid shop domain format" });
      }

      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }

      const merged = await storage.mergeSessionToCustomer(shop, sessionId, customerId);
      console.log(`[Storefront Merge] shop=${shop} session=${sessionId} customer=${customerId} merged=${merged}`);

      return res.json({ merged });
    } catch (error) {
      console.error("[Storefront Merge Session] Error:", error);
      res.status(500).json({ error: "Failed to merge session" });
    }
  });

  // ==================== STOREFRONT SAVE DESIGN ====================
  // Persists a generation to a customer's account. Requires customerId.
  app.post("/api/storefront/save-design", async (req: Request, res: Response) => {
    try {
      const { jobId, customerId, shop } = req.body;

      if (!jobId || !shop) {
        return res.status(400).json({ error: "jobId and shop are required" });
      }
      if (!customerId) {
        return res.status(401).json({ error: "LOGIN_REQUIRED", message: "Please log in to save designs." });
      }

      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
        return res.status(400).json({ error: "Invalid shop domain format" });
      }

      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }

      const job = await storage.getGenerationJob(jobId);
      console.log(`[SaveDesign] jobId=${jobId} found=${!!job} jobShop=${job?.shop} reqShop=${shop} status=${job?.status} hasImage=${!!job?.designImageUrl} existingCustomerId=${job?.customerId}`);
      if (!job || job.shop !== shop) {
        return res.status(404).json({ error: "Design not found" });
      }

      // Only save if the job is complete (has an image)
      if (job.status !== 'complete' || !job.designImageUrl) {
        return res.status(400).json({ error: "Design generation is not complete yet" });
      }

      // Link the job to the customer account
      await storage.updateGenerationJob(jobId, {
        customerId,
        sessionId: null,
      });
      console.log(`[SaveDesign] Linked jobId=${jobId} to customerId=${customerId}`);

      return res.json({ saved: true, jobId });
    } catch (error) {
      console.error("[Storefront Save Design] Error:", error);
      res.status(500).json({ error: "Failed to save design" });
    }
  });

  // ==================== STOREFRONT SAVE MOCKUP URLS ====================
  // Called by the client after mockups are generated, to persist them on the job record.
  // Also accepts optional baseProductId + baseVariantId to pre-create a shadow product
  // in the background, so Add to Cart is instant when the user clicks it.
  app.post("/api/storefront/save-mockups", async (req: Request, res: Response) => {
    try {
      const { shop, jobId, mockupUrls, baseProductId, baseVariantId } = req.body;
      if (!shop || !jobId || !Array.isArray(mockupUrls)) {
        return res.status(400).json({ error: "shop, jobId, and mockupUrls[] are required" });
      }
      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }
      const job = await storage.getGenerationJob(jobId);
      if (!job || job.shop !== shop) {
        return res.status(404).json({ error: "Job not found" });
      }
      // Only store valid absolute URLs (Printify CDN URLs)
      const validUrls = mockupUrls.filter((u: any) => typeof u === 'string' && u.startsWith('http'));
      await storage.updateGenerationJob(jobId, { mockupUrls: validUrls } as any);
      console.log(`[SaveMockups] jobId=${jobId} saved ${validUrls.length} mockup URLs`);

      // ── Pre-create shadow product in background ──────────────────────────────
      // If the client provided base product/variant info and we have a mockup URL,
      // kick off shadow product creation now so Add to Cart is instant.
      // We respond immediately and let this run in the background.
      const primaryMockupUrl = validUrls[0];
      if (baseProductId && baseVariantId && primaryMockupUrl && installation.accessToken) {
        const token = installation.accessToken;
        const apiBase = `https://${shop}/admin/api/2025-10`;
        const headers: Record<string, string> = { "Content-Type": "application/json", "X-Shopify-Access-Token": token };

        // Fire-and-forget: don't await, respond to client immediately
        (async () => {
          try {
            // Check if shadow product already exists for this job
            const freshJob = await storage.getGenerationJob(jobId);
            if (freshJob?.shadowVariantId && freshJob?.shadowProductId) {
              console.log(`[PreShadow] jobId=${jobId} already has shadow product ${freshJob.shadowProductId}`);
              return;
            }

            // Check published_products table (existing shadow product for this designId)
            const designId = jobId; // generationJob.id is used as designId in published_products
            const existing = await storage.getPublishedProduct(shop, designId);
            if (existing && existing.status === 'active') {
              // Reuse existing shadow product — just store the IDs on the job
              console.log(`[PreShadow] jobId=${jobId} reusing existing shadow product ${existing.shopifyProductId}`);
              await storage.updateGenerationJob(jobId, {
                shadowProductId: existing.shopifyProductId,
                shadowVariantId: existing.shopifyVariantId,
                shadowExpiresAt: existing.expiresAt,
              } as any);
              return;
            }

            // Fetch base product to get price/title
            const productRes = await fetch(`${apiBase}/products/${baseProductId}.json`, { headers });
            if (!productRes.ok) {
              console.warn(`[PreShadow] Failed to fetch base product ${baseProductId}: ${productRes.status}`);
              return;
            }
            const { product: baseProduct } = await productRes.json();
            const baseVariant = baseProduct.variants.find((v: any) => String(v.id) === String(baseVariantId));
            if (!baseVariant) {
              console.warn(`[PreShadow] Base variant ${baseVariantId} not found on product ${baseProductId}`);
              return;
            }

            // Build shadow product title
            const variantOptionParts = [baseVariant.option1, baseVariant.option2, baseVariant.option3]
              .filter((o: any) => o && o !== 'Default Title' && o !== 'base')
              .join(' / ');
            const shadowTitle = `${baseProduct.title}${variantOptionParts ? ' — ' + variantOptionParts : ''}`;

            // Create the shadow product — expires in 1 hour if not added to cart
            const oneHourFromNow = new Date(Date.now() + 1 * 60 * 60 * 1000);
            const createRes = await fetch(`${apiBase}/products.json`, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                product: {
                  title: shadowTitle,
                  status: 'unlisted',
                  published: false,
                  tags: 'appai-shadow',
                  variants: [{
                    price: baseVariant.price,
                    compare_at_price: baseVariant.compare_at_price || null,
                    taxable: baseVariant.taxable,
                    requires_shipping: baseVariant.requires_shipping,
                    weight: baseVariant.weight,
                    weight_unit: baseVariant.weight_unit,
                    inventory_management: null,
                    inventory_policy: 'continue',
                    fulfillment_service: 'manual',
                  }],
                  images: [{ src: primaryMockupUrl }],
                },
              }),
            });
            if (!createRes.ok) {
              const errText = await createRes.text();
              console.error(`[PreShadow] Failed to create shadow product: ${createRes.status}`, errText.substring(0, 200));
              return;
            }
            const { product: shadowProduct } = await createRes.json();
            const shadowVariant = shadowProduct.variants[0];
            console.log(`[PreShadow] Created shadow product ${shadowProduct.id} variant ${shadowVariant.id} for jobId=${jobId}`);

            // Publish to Online Store channel
            try { await ensureProductPublishedToOnlineStore(shop, token, Number(shadowProduct.id)); } catch (_) { /* non-fatal */ }

            // Assign mockup image to the variant
            if (shadowProduct.images?.length > 0) {
              const imgId = shadowProduct.images[0].id;
              await fetch(`${apiBase}/products/${shadowProduct.id}/images/${imgId}.json`, {
                method: 'PUT', headers,
                body: JSON.stringify({ image: { id: imgId, variant_ids: [shadowVariant.id] } }),
              }).catch(() => {});
            }

            // Persist in published_products table
            await storage.createPublishedProduct({
              shop,
              designId,
              customerKey: null,
              shopifyProductId: String(shadowProduct.id),
              shopifyVariantId: String(shadowVariant.id),
              shopifyProductHandle: shadowProduct.handle || null,
              baseVariantId: String(baseVariantId),
              status: 'active',
              expiresAt: oneHourFromNow,
              cartAddedAt: null,
            } as any);

            // Store shadow product IDs on the job record for instant cart add
            await storage.updateGenerationJob(jobId, {
              shadowProductId: String(shadowProduct.id),
              shadowVariantId: String(shadowVariant.id),
              shadowExpiresAt: oneHourFromNow,
            } as any);

            console.log(`[PreShadow] jobId=${jobId} shadow product ready — variantId=${shadowVariant.id}`);
          } catch (bgErr: any) {
            console.error(`[PreShadow] Background error for jobId=${jobId}:`, bgErr?.message);
          }
        })();
      }

      return res.json({ saved: true });
    } catch (err: any) {
      console.error("[SaveMockups]", err);
      return res.status(500).json({ error: "Failed to save mockups" });
    }
  });

  // ==================== STOREFRONT SAVE DESIGN STATE ====================
  app.post("/api/storefront/save-state", async (req: Request, res: Response) => {
    try {
      const { shop, jobId, designState } = req.body;
      if (!shop || !jobId || !designState || typeof designState !== 'object') {
        return res.status(400).json({ error: "shop, jobId, and designState are required" });
      }
      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }
      const job = await storage.getGenerationJob(jobId);
      if (!job || job.shop !== shop) {
        return res.status(404).json({ error: "Job not found" });
      }
      await storage.updateGenerationJob(jobId, { designState } as any);
      console.log(`[SaveState] jobId=${jobId} saved designState keys=${Object.keys(designState).join(',')}`);
      return res.json({ saved: true });
    } catch (err: any) {
      console.error("[SaveState]", err);
      return res.status(500).json({ error: "Failed to save design state" });
    }
  });

  // ==================== STOREFRONT GET SHADOW VARIANT ====================
  // Lightweight endpoint to check if a pre-created shadow product is ready for a job.
  // Called by the client after save-mockups to get the shadowVariantId for instant cart add.
  app.get("/api/storefront/shadow-variant/:jobId", async (req: Request, res: Response) => {
    try {
      const shop = req.query.shop as string;
      const { jobId } = req.params;
      if (!shop || !jobId) {
        return res.status(400).json({ error: "shop and jobId are required" });
      }
      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }
      const job = await storage.getGenerationJob(jobId);
      if (!job || job.shop !== shop) {
        return res.status(404).json({ error: "Job not found" });
      }
      const shadowVariantId = (job as any).shadowVariantId || null;
      const shadowProductId = (job as any).shadowProductId || null;
      const shadowExpiresAt = (job as any).shadowExpiresAt || null;
      const ready = !!(shadowVariantId && shadowProductId);
      console.log(`[ShadowVariant] jobId=${jobId} ready=${ready} variantId=${shadowVariantId}`);
      return res.json({ ready, shadowVariantId, shadowProductId, shadowExpiresAt });
    } catch (err: any) {
      console.error("[ShadowVariant]", err);
      return res.status(500).json({ error: "Failed to get shadow variant" });
    }
  });

  // ==================== STOREFRONT DELETE SAVED DESIGN ====================
  app.delete("/api/storefront/customizer/my-designs/:id", async (req: Request, res: Response) => {
    try {
      // Support both req.body (POST-style) and req.query (DELETE with no body)
      const shop = (req.body?.shop || req.query?.shop) as string;
      // customerId is optional from client — we verify ownership using the job's stored customerId.
      // The client may pass it, but we don't require it to avoid issues in Shopify-embedded contexts
      // where the internal UUID may not be available on the client side.
      const clientCustomerId = (req.body?.customerId || req.query?.customerId) as string | undefined;
      const jobId = req.params.id;
      if (!shop || !jobId) {
        return res.status(400).json({ error: "shop and id are required" });
      }
      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }
      const job = await storage.getGenerationJob(jobId);
      if (!job || job.shop !== shop) {
        return res.status(404).json({ error: "Design not found" });
      }
      // If client provided a customerId, verify it matches (extra security check)
      if (clientCustomerId && job.customerId && job.customerId !== clientCustomerId) {
        console.warn(`[DeleteDesign] customerId mismatch: job=${job.customerId} client=${clientCustomerId}`);
        return res.status(403).json({ error: "Not authorized to delete this design" });
      }
      const ownerCustomerId = job.customerId || clientCustomerId || 'unknown';
      // Unlink the design from the customer (don't delete the job, just disown it)
      await storage.updateGenerationJob(jobId, { customerId: null } as any);
      console.log(`[DeleteDesign] Unlinked jobId=${jobId} from customerId=${ownerCustomerId}`);
      return res.json({ deleted: true });
    } catch (err: any) {
      console.error("[DeleteDesign]", err);
      return res.status(500).json({ error: "Failed to delete design" });
    }
  });

  // ==================== STOREFRONT MOCKUP (NO SESSION TOKEN) ====================
  // Used by storefront embeds to generate Printify mockups without session tokens.
  // Includes auto-resolution of productTypeId (same logic as designer endpoint).
  app.post("/api/storefront/mockup", async (req: Request, res: Response) => {
    // Generate correlationId before try so it's available in catch
    const correlationId = `mockup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const { productTypeId: requestedProductTypeId, designImageUrl, patternUrl, sizeId, colorId, scale, x, y, shop, mirrorLegs, panelUrls } = req.body;

      if (!shop) {
        return res.status(400).json({ error: "Shop domain required" });
      }

      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
        return res.status(400).json({ error: "Invalid shop domain format" });
      }

      // Verify shop is installed
      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }

      if (!requestedProductTypeId || !designImageUrl) {
        return res.status(400).json({ ok: false, step: "validation", correlationId, error: "Missing required fields (productTypeId, designImageUrl)" });
      }

      // Sanitized URL prefix for logging (never log full data URLs)
      const urlPrefix = designImageUrl.startsWith("data:")
        ? `data:${designImageUrl.substring(5, 30)}... (${designImageUrl.length} chars)`
        : designImageUrl.substring(0, 120);
      console.log(`[Storefront Mockup] [${correlationId}] Incoming:`, { shop, requestedProductTypeId, sizeId, colorId, urlPrefix });

      // Reject obviously malformed URLs (e.g. API_BASE + data: concatenation, blob:)
      if (designImageUrl.includes("appdata:") || designImageUrl.includes("blob:")) {
        return res.status(400).json({
          ok: false, step: "validation", correlationId,
          error: "Invalid designImageUrl: appears to be a malformed or local URL."
        });
      }

      // Strip Shopify App Proxy prefix if present (client sends /apps/appai/objects/... in proxy mode)
      // For AOP products, prefer patternUrl (Picsart-tiled) over designImageUrl
      let normalizedImageUrl = (patternUrl || designImageUrl) as string;
      if (normalizedImageUrl.startsWith("/apps/appai/objects/")) {
        normalizedImageUrl = normalizedImageUrl.replace("/apps/appai", "");
        console.log(`[Storefront Mockup] [${correlationId}] Stripped proxy prefix → ${normalizedImageUrl}`);
      }

      // Resolve designImageUrl to an absolute URL (or pass data URLs through).
      // uploadImageToPrintify() in printify-mockups.ts natively handles data URLs
      // by extracting the base64 and sending { contents: base64Data } to Printify.
      let absoluteImageUrl = normalizedImageUrl;
      if (normalizedImageUrl.startsWith("data:")) {
        // Data URL from generate fallback — pass through to Printify upload
        console.log(`[Storefront Mockup] [${correlationId}] Data URL (${normalizedImageUrl.length} chars) — will upload base64 to Printify`);
      } else if (normalizedImageUrl.startsWith("/objects/")) {
        const host = req.get("host") || process.env.REPLIT_DEV_DOMAIN;
        const protocol = req.protocol || "https";
        absoluteImageUrl = `${protocol}://${host}${normalizedImageUrl}`;
        console.log(`[Storefront Mockup] [${correlationId}] Converted relative path:`, absoluteImageUrl);
      } else if (normalizedImageUrl.startsWith("https://")) {
        console.log(`[Storefront Mockup] [${correlationId}] Using absolute URL:`, absoluteImageUrl);
      } else {
        return res.status(400).json({
          ok: false, step: "validation", correlationId,
          error: "Invalid designImageUrl: must start with https://, /objects/, or data:"
        });
      }

      // Get merchant from shop installation
      if (!installation.merchantId) {
        return res.status(404).json({ error: "Shop not associated with a merchant" });
      }
      const merchant = await storage.getMerchant(installation.merchantId);
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found for shop" });
      }

      // ========== AUTO-RESOLUTION OF PRODUCT TYPE ==========
      // Uses centralized resolver — never 404s on invalid productTypeId in storefront mode.
      const parsedId = parseInt(requestedProductTypeId);
      const resolved = await resolveStorefrontProductType(parsedId, merchant.id, `[Storefront Mockup] [${correlationId}]`);

      if ("error" in resolved) {
        return res.status(400).json({
          error: resolved.error,
          debug: { requestedProductTypeId: parsedId, merchantId: merchant.id }
        });
      }

      const productType = resolved.productType;
      console.log(`[Storefront Mockup] [${correlationId}] Using productType: id=${productType.id} name="${productType.name}" merchantId=${productType.merchantId}${resolved.resolvedFrom ? ` (resolved via ${resolved.resolvedFrom})` : ""}`);

      // ========== VALIDATE PRINTIFY CONFIGURATION ==========
      if (!merchant.printifyApiToken || !merchant.printifyShopId) {
        return res.json({
          success: false,
          mockupUrls: [],
          mockupImages: [],
          source: "fallback",
          message: "Printify credentials not configured for merchant",
        });
      }

      if (!productType.printifyBlueprintId) {
        return res.json({
          success: false,
          mockupUrls: [],
          mockupImages: [],
          source: "fallback",
          message: `Product type "${productType.name}" (id=${productType.id}) has no Printify blueprint configured`,
        });
      }

      // ========== RESOLVE VARIANT ==========
      const variantMapData = JSON.parse(productType.variantMap as string || "{}");
      const variantKey = `${sizeId || 'default'}:${colorId || 'default'}`;

      const variantData = variantMapData[variantKey] ||
                          variantMapData[`${sizeId || 'default'}:default`] ||
                          variantMapData[`default:${colorId || 'default'}`] ||
                          variantMapData['default:default'] ||
                          Object.values(variantMapData)[0];

      if (!variantData || !variantData.printifyVariantId) {
        return res.status(400).json({
          error: "Could not resolve Printify variant for mockup",
          debug: {
            productTypeId: productType.id,
            requestedKey: variantKey,
            availableKeys: Object.keys(variantMapData),
          }
        });
      }

      const blueprintId = productType.printifyBlueprintId;
      const providerId = variantData.providerId || productType.printifyProviderId || 1;
      const targetVariantId = variantData.printifyVariantId;

      // ========== STRUCTURED LOGGING BEFORE PRINTIFY CALL ==========
      console.log(`[Storefront Mockup] [${correlationId}] Printify params:`, {
        shop,
        resolvedProductTypeId: productType.id,
        requestedProductTypeId: parsedId,
        resolvedFrom: resolved.resolvedFrom || "direct_match",
        blueprintId,
        providerId,
        variantId: targetVariantId,
        merchantId: merchant.id,
        printifyShopId: merchant.printifyShopId,
        sizeId: sizeId || 'default',
        colorId: colorId || 'default',
        doubleSided: resolveDoubleSided(productType),
      });

      // ========== GENERATE MOCKUP ==========
      const resolvedDoubleSided = resolveDoubleSided(productType);
      const resolvedWrapAround = resolveWrapAround(productType);
      console.log(`[Storefront Mockup] [${correlationId}] resolveDoubleSided=${resolvedDoubleSided}, resolveWrapAround=${resolvedWrapAround}, productType.doubleSidedPrint=${productType.doubleSidedPrint}, productType.designerType=${productType.designerType}, productType.placeholderPositions=${productType.placeholderPositions}`);
      const { generatePrintifyMockup } = await import("./printify-mockups.js");

      const result = await generatePrintifyMockup({
        blueprintId,
        providerId,
        variantId: targetVariantId,
        imageUrl: absoluteImageUrl,
        printifyApiToken: merchant.printifyApiToken,
        printifyShopId: merchant.printifyShopId,
        scale: scale ? scale / 100 : 1,
        x: x !== undefined ? (x - 50) / 50 : 0,
        y: y !== undefined ? (y - 50) / 50 : 0,
        doubleSided: resolvedDoubleSided,
        wrapAround: resolvedWrapAround,
        wrapDirection: resolvedWrapAround ? resolveWrapDirection(productType) : undefined,
        aopPositions: productType.isAllOverPrint && productType.placeholderPositions
          ? JSON.parse(productType.placeholderPositions as string)
          : undefined,
        mirrorLegs: !!mirrorLegs,
        panelUrls: Array.isArray(panelUrls) && panelUrls.length > 0 ? panelUrls : undefined,
      });

      console.log(`[Storefront Mockup] [${correlationId}] Result:`, {
        success: result.success,
        mockupCount: result.mockupUrls?.length,
        source: result.source,
        error: result.error || null,
        resolvedProductTypeId: productType.id,
        requestedProductTypeId: parsedId,
      });
      res.json({ ...result, correlationId });
    } catch (error: any) {
      console.error(`[Storefront Mockup] [${correlationId}] Error:`, error);
      res.status(500).json({
        ok: false,
        step: "server_error",
        error: error?.message || "Failed to generate mockup",
        correlationId,
      });
    }
  });

  // ==================== STOREFRONT VARIANT IMAGE (FOR CHECKOUT) ====================
  // Updates the Shopify variant image so checkout displays the custom mockup.
  // Called before add-to-cart; no session auth (storefront customers).
  app.post("/api/storefront/variant-image", async (req: Request, res: Response) => {
    try {
      const { shop, productId, variantId, mockupUrl } = req.body;

      if (!shop || !productId || !variantId || !mockupUrl) {
        return res.status(400).json({
          success: false,
          error: "Missing required fields: shop, productId, variantId, mockupUrl",
        });
      }

      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
        return res.status(400).json({ success: false, error: "Invalid shop domain format" });
      }

      if (!mockupUrl.startsWith("https://")) {
        return res.status(400).json({ success: false, error: "mockupUrl must be an absolute https URL" });
      }

      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ success: false, error: "Shop not authorized" });
      }

      const productIdNum = typeof productId === "string" ? parseInt(productId, 10) : Number(productId);
      const variantIdNum = typeof variantId === "string" ? parseInt(variantId, 10) : Number(variantId);
      if (isNaN(productIdNum) || isNaN(variantIdNum)) {
        return res.status(400).json({ success: false, error: "Invalid productId or variantId" });
      }

      // 1. Upload image to Shopify product
      const imageRes = await fetch(
        `https://${shop}/admin/api/2025-10/products/${productIdNum}/images.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": installation.accessToken!,
          },
          body: JSON.stringify({ image: { src: mockupUrl } }),
        }
      );

      if (!imageRes.ok) {
        const errText = await imageRes.text();
        console.error("[Variant Image] Shopify image upload failed:", imageRes.status, errText);
        return res.status(imageRes.status).json({
          success: false,
          error: "Failed to upload image to Shopify",
          details: errText.substring(0, 200),
        });
      }

      const imageData = await imageRes.json();
      const imageId = imageData?.image?.id;
      if (!imageId) {
        return res.status(500).json({ success: false, error: "Shopify did not return image ID" });
      }

      // 2. Assign image to variant
      const variantRes = await fetch(
        `https://${shop}/admin/api/2025-10/variants/${variantIdNum}.json`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": installation.accessToken!,
          },
          body: JSON.stringify({ variant: { id: variantIdNum, image_id: imageId } }),
        }
      );

      if (!variantRes.ok) {
        const errText = await variantRes.text();
        console.error("[Variant Image] Shopify variant update failed:", variantRes.status, errText);
        return res.status(variantRes.status).json({
          success: false,
          error: "Failed to assign image to variant",
          details: errText.substring(0, 200),
        });
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error("[Variant Image] Error:", error);
      res.status(500).json({ success: false, error: error?.message || "Internal server error" });
    }
  });

  // ==================== RESOLVE DESIGN VARIANT ====================
  // ── Shadow product cart-added webhook ──────────────────────────────────────
  // Called by the theme extension when a shadow product variant is added to cart,
  // so we can extend its expiry from 6h to 7d.
  app.post("/api/storefront/shadow-product/cart-added", async (req: Request, res: Response) => {
    try {
      const { shop, shadowProductId } = req.body;
      if (!shop || !shadowProductId) return res.status(400).json({ error: "shop and shadowProductId required" });
      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") return res.status(403).json({ error: "Shop not authorized" });
      // Find the published product record by shopifyProductId
      const rows = await db
        .select()
        .from(publishedProducts)
        .where(and(eq(publishedProducts.shop, shop), eq(publishedProducts.shopifyProductId, String(shadowProductId))))
        .limit(1);
      if (rows.length > 0) {
        await storage.markShadowProductCartAdded(rows[0].id);
        console.log(`[ShadowProduct] Extended expiry to 7d for product ${shadowProductId} (cart-added)`);
      }
      return res.json({ success: true });
    } catch (e: any) {
      console.error("[ShadowProduct] cart-added error:", e?.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Shadow product creation (replaces resolve-design-variant) ────────────────
  // Creates one hidden Shopify product per design with a single variant.
  // The shadow product is status=draft, not in any collection, tagged appai-shadow.
  // Expiry: 6 hours from creation (extended to 7 days if added to cart).
  // Reuse: if a shadow product already exists for this designId+shop, return it.
  // Legacy alias kept so old clients still work during rollout.
  app.post("/api/storefront/resolve-design-variant", async (req: Request, res: Response) => {
    try {
      const { shop, productId, variantId, designId, mockupUrl } = req.body;
      if (!shop || !productId || !variantId || !designId || !mockupUrl) {
        return res.status(400).json({ success: false, error: "shop, productId, variantId, designId and mockupUrl are required" });
      }
      if (!mockupUrl.startsWith("https://")) {
        return res.status(400).json({ success: false, error: "mockupUrl must be an https URL" });
      }
      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ success: false, error: "Shop not authorized" });
      }
      const token = installation.accessToken!;
      const apiBase = `https://${shop}/admin/api/2025-10`;
      const headers: Record<string, string> = { "Content-Type": "application/json", "X-Shopify-Access-Token": token };

      // ── Shadow product path ────────────────────────────────────────────────
      // 1. Check if a shadow product already exists for this designId
      const existing = await storage.getPublishedProduct(shop, designId);
      if (existing && existing.status === "active") {
        console.log(`[ShadowProduct] Reusing existing shadow product ${existing.shopifyProductId} for design ${designId}`);
        // Refresh expiry: if not yet cart-added, reset the 6h window from now
        if (!existing.cartAddedAt) {
          const sixHours = new Date(Date.now() + 6 * 60 * 60 * 1000);
          await storage.updatePublishedProduct(existing.id, { expiresAt: sixHours });
        }
        return res.json({ success: true, variantId: existing.shopifyVariantId, reused: true });
      }

      // 2. Fetch the base variant to copy price/title/weight
      const productRes = await fetch(`${apiBase}/products/${productId}.json`, { headers });
      if (!productRes.ok) {
        const t = await productRes.text();
        console.error(`[ShadowProduct] Failed to fetch base product ${productId}:`, t.substring(0, 200));
        return res.status(productRes.status).json({ success: false, error: "Failed to fetch base product" });
      }
      const { product: baseProduct } = await productRes.json();
      const baseVariant = baseProduct.variants.find((v: any) => String(v.id) === String(variantId));
      if (!baseVariant) {
        console.warn(`[ShadowProduct] Base variant ${variantId} not found on product ${productId}`);
        return res.json({ success: false, error: "Base variant not found", fallback: true, variantId: String(variantId) });
      }

      // 3. Build a clean human-readable title from the base variant options
      const variantOptionParts = [baseVariant.option1, baseVariant.option2, baseVariant.option3]
        .filter((o: any) => o && o !== 'Default Title' && o !== 'base')
        .join(' / ');
      const shadowTitle = `${baseProduct.title}${variantOptionParts ? ' — ' + variantOptionParts : ''}`;

      // 4. Create the shadow product in Shopify
      // Must be status=active + published=true so the storefront cart API can add it.
      // It stays hidden from customers because it is not added to any collection and
      // is not linked from navigation — Shopify only surfaces products in collections.
      const sixHoursFromNow = new Date(Date.now() + 6 * 60 * 60 * 1000);
      const createProductRes = await fetch(`${apiBase}/products.json`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          product: {
            title: shadowTitle,
            status: 'unlisted',                   // accessible by direct link, hidden from browse/search
            published: false,
            tags: 'appai-shadow',
            variants: [{
              price: baseVariant.price,
              compare_at_price: baseVariant.compare_at_price || null,
              taxable: baseVariant.taxable,
              requires_shipping: baseVariant.requires_shipping,
              weight: baseVariant.weight,
              weight_unit: baseVariant.weight_unit,
              inventory_management: null,          // untracked — never sold-out
              inventory_policy: 'continue',
              fulfillment_service: 'manual',
            }],
            images: [{ src: mockupUrl }],
          },
        }),
      });
      if (!createProductRes.ok) {
        const errText = await createProductRes.text();
        console.error(`[ShadowProduct] Failed to create shadow product:`, createProductRes.status, errText.substring(0, 300));
        return res.json({ success: false, error: errText.substring(0, 200), fallback: true, variantId: String(variantId) });
      }
      const { product: shadowProduct } = await createProductRes.json();
      const shadowVariant = shadowProduct.variants[0];
      console.log(`[ShadowProduct] Created shadow product ${shadowProduct.id} variant ${shadowVariant.id} for design ${designId}`);

      // 5. Ensure the shadow product is published to the Online Store sales channel
      //    (required for unlisted products to be accessible via the storefront cart API)
      try { await ensureProductPublishedToOnlineStore(shop, token, Number(shadowProduct.id)); } catch (_) { /* non-fatal */ }

      // 6. Assign the mockup image to the variant
      if (shadowProduct.images && shadowProduct.images.length > 0) {
        const imgId = shadowProduct.images[0].id;
        await fetch(`${apiBase}/products/${shadowProduct.id}/images/${imgId}.json`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ image: { id: imgId, variant_ids: [shadowVariant.id] } }),
        }).catch(() => { /* non-fatal */ });
      }

      // 6. Persist the shadow product record in our DB
      await storage.createPublishedProduct({
        shop,
        designId,
        customerKey: null,
        shopifyProductId: String(shadowProduct.id),
        shopifyVariantId: String(shadowVariant.id),
        shopifyProductHandle: shadowProduct.handle || null,
        baseVariantId: String(variantId),
        status: 'active',
        expiresAt: sixHoursFromNow,
        cartAddedAt: null,
      } as any);

      return res.json({ success: true, variantId: String(shadowVariant.id), created: true });
    } catch (error: any) {
      console.error("[ShadowProduct] Error:", error);
      res.status(500).json({ success: false, error: error?.message || "Internal server error" });
    }
  });

  // ==================== STOREFRONT BLANKS ====================
  // Returns the list of customizable blank products/variants for the customizer page.
  // Results are cached per shop for 5 minutes.
  const blanksCache = new Map<string, { data: any[]; expiresAt: number }>();

  app.get("/api/storefront/blanks", async (req: Request, res: Response) => {
    try {
      const shop = req.query.shop as string;
      if (!shop || !/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
        return res.status(400).json({ error: "Valid shop domain required" });
      }

      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }

      const cached = blanksCache.get(shop);
      if (cached && Date.now() < cached.expiresAt) {
        return res.json({ blanks: cached.data });
      }

      const allTypes = installation.merchantId
        ? await storage.getProductTypesByMerchant(installation.merchantId)
        : await storage.getActiveProductTypes();

      const blanks = allTypes
        .filter((pt) => pt.isActive && pt.shopifyProductId)
        .map((pt) => {
          let variantMap: Record<string, any> = {};
          let sizes: any[] = [];
          let frameColors: any[] = [];
          let primaryMockupImage: string | null = null;
          try { variantMap = JSON.parse(pt.variantMap as string || "{}"); } catch (_) {}
          try { sizes = JSON.parse(pt.sizes as string || "[]"); } catch (_) {}
          try { frameColors = JSON.parse(pt.frameColors as string || "[]"); } catch (_) {}
          try {
            const imgs = JSON.parse(pt.baseMockupImages as string || "{}");
            primaryMockupImage = (Object.values(imgs)[0] as string) || null;
          } catch (_) {}

          const variants = Object.keys(variantMap)
            .filter((k) => variantMap[k]?.shopifyVariantId)
            .map((k) => {
              const v = variantMap[k];
              const [sizeId = "", colorId = ""] = k.split(":");
              const size = sizes.find((s: any) => s.id === sizeId);
              const color = frameColors.find((c: any) => c.id === colorId);
              return {
                key: k,
                shopifyVariantId: String(v.shopifyVariantId),
                sizeId,
                colorId,
                sizeLabel: size?.name || sizeId,
                colorLabel: color?.name || colorId,
                price: v.price || null,
              };
            });

          return {
            productTypeId: pt.id,
            name: pt.name,
            description: pt.description || null,
            shopifyProductId: pt.shopifyProductId,
            shopifyProductHandle: pt.shopifyProductHandle || null,
            shopifyProductUrl: pt.shopifyProductUrl || null,
            aspectRatio: pt.aspectRatio,
            designerType: pt.designerType,
            primaryMockupImage,
            variants,
            sizes,
            frameColors,
          };
        });

      blanksCache.set(shop, { data: blanks, expiresAt: Date.now() + 5 * 60 * 1000 });
      return res.json({ blanks });
    } catch (err: any) {
      console.error("[Storefront Blanks]", err);
      return res.status(500).json({ error: "Failed to load blank products" });
    }
  });

  // ==================== STOREFRONT CUSTOMIZER DESIGNS ====================
  // POST: create a new customizer design record, kick off async generation.
  // GET /:id: poll status; returns artworkUrl + mockupUrls when READY.

  async function runCustomizerGeneration(
    designId: string,
    params: { shop: string; productTypeId?: string; sizeId?: string; colorId?: string; prompt: string; stylePreset?: string },
    appHost: string
  ) {
    try {
      // Step 1 — Generate AI artwork (reuse existing storefront generate endpoint)
      const genRes = await fetch(`${appHost}/api/storefront/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop: params.shop,
          prompt: params.prompt,
          stylePreset: params.stylePreset || "",
          size: params.sizeId || "12x16",
          frameColor: params.colorId || "black",
          productTypeId: params.productTypeId || "",
        }),
      });
      const genData = await genRes.json();
      if (!genRes.ok || !genData.imageUrl) {
        await storage.updateCustomizerDesign(designId, {
          status: "FAILED",
          errorMessage: genData.error || "Image generation failed",
        });
        return;
      }

      // Step 2 — Generate Printify mockup (reuse existing storefront mockup endpoint)
      let mockupUrls: string[] = [];
      let mockupUrl: string = genData.imageUrl;

      if (params.productTypeId) {
        try {
          const mockupRes = await fetch(`${appHost}/api/storefront/mockup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              shop: params.shop,
              productTypeId: params.productTypeId,
              designImageUrl: genData.imageUrl,
              sizeId: params.sizeId,
              colorId: params.colorId,
            }),
          });
          const mockupData = await mockupRes.json();
          if (mockupData.mockupUrls?.length) {
            mockupUrls = mockupData.mockupUrls as string[];
            mockupUrl = mockupUrls[0];
          }
        } catch (mErr) {
          console.warn("[Customizer] Mockup step failed, using artwork URL:", mErr);
        }
      }

      if (mockupUrls.length === 0) mockupUrls = [genData.imageUrl];

      await storage.updateCustomizerDesign(designId, {
        artworkUrl: genData.imageUrl,
        mockupUrl,
        mockupUrls,
        status: "READY",
      });
      console.log(`[Customizer] Design ${designId} READY. mockup=${mockupUrl}`);
    } catch (err: any) {
      console.error(`[Customizer] Generation error for ${designId}:`, err);
      try {
        await storage.updateCustomizerDesign(designId, {
          status: "FAILED",
          errorMessage: err?.message || "Unknown error",
        });
      } catch (_) {}
    }
  }

  app.post("/api/storefront/customizer/designs", async (req: Request, res: Response) => {
    try {
      const { shop, productTypeId, baseVariantId, sizeId, colorId, prompt, stylePreset, shopifyCustomerId } = req.body;

      if (!shop || !/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
        return res.status(400).json({ error: "Valid shop domain required" });
      }
      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        return res.status(400).json({ error: "prompt is required" });
      }
      if (!baseVariantId) {
        return res.status(400).json({ error: "baseVariantId is required" });
      }

      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }

      let baseTitle: string | undefined;
      if (productTypeId && installation.merchantId) {
        const pt = await storage.getProductType(parseInt(productTypeId));
        if (pt) baseTitle = pt.name;
      }

      const design = await storage.createCustomizerDesign({
        shop,
        shopifyCustomerId: shopifyCustomerId || null,
        baseVariantId: String(baseVariantId),
        baseProductId: productTypeId ? String(productTypeId) : null,
        baseTitle: baseTitle || null,
        prompt: prompt.trim(),
        options: { stylePreset, sizeId, colorId, productTypeId },
        status: "GENERATING",
      });

      const appHost = process.env.APP_URL || `http://127.0.0.1:${process.env.PORT || 5000}`;
      runCustomizerGeneration(design.id, { shop, productTypeId, sizeId, colorId, prompt: prompt.trim(), stylePreset }, appHost)
        .catch((e) => console.error("[Customizer] Background gen error:", e));

      return res.json({ designId: design.id, status: design.status });
    } catch (err: any) {
      console.error("[Customizer POST]", err);
      return res.status(500).json({ error: "Failed to start design generation" });
    }
  });

  app.get("/api/storefront/customizer/designs/:id", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const shop = req.query.shop as string;

      if (!id) return res.status(400).json({ error: "Design ID required" });

      const design = await storage.getCustomizerDesign(id);
      if (!design) return res.status(404).json({ error: "Design not found" });

      if (shop && design.shop !== shop) {
        return res.status(403).json({ error: "Access denied" });
      }

      return res.json({
        designId: design.id,
        status: design.status,
        artworkUrl: design.artworkUrl,
        mockupUrl: design.mockupUrl,
        mockupUrls: (design.mockupUrls as string[]) || [],
        prompt: design.prompt,
        baseVariantId: design.baseVariantId,
        baseTitle: design.baseTitle,
        options: design.options,
        errorMessage: design.errorMessage,
        createdAt: design.createdAt,
      });
    } catch (err: any) {
      console.error("[Customizer GET]", err);
      return res.status(500).json({ error: "Failed to fetch design" });
    }
  });


  // ==================== STOREFRONT CUSTOMER DESIGNS LIST ====================
  // POST instead of GET so customerId (UUID) is sent in the body, not the URL.
  // The Shopify App Proxy truncates long query parameter values, which broke UUID lookups.
  app.post("/api/storefront/customizer/my-designs", async (req: Request, res: Response) => {
    try {
      const shop = (req.body.shop || req.query.shop) as string;
      const customerId = (req.body.customerId || req.query.customerId) as string;
      if (!shop || !customerId) {
        return res.status(400).json({ error: "shop and customerId are required" });
      }
      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }
      const GALLERY_LIMIT = 20;
      console.log(`[MyDesigns] shop=${shop} customerId=${customerId}`);
      const rows = await db
        .select()
        .from(generationJobs)
        .where(
          and(
            eq(generationJobs.shop, shop),
            eq(generationJobs.customerId, customerId),
            eq(generationJobs.status, "complete")
          )
        )
        .orderBy(desc(generationJobs.createdAt))
        .limit(GALLERY_LIMIT);
      console.log(`[MyDesigns] found ${rows.length} designs for customerId=${customerId}`);

      // Resolve product type names AND page handles for all unique productTypeIds
      const ptIds = [...new Set(rows.map(r => r.productTypeId).filter(Boolean))] as string[];
      const ptMap: Record<string, string> = {};   // productTypeId → name
      const handleMap: Record<string, string> = {}; // productTypeId → page handle
      if (ptIds.length > 0) {
        const numericIds = ptIds.map(Number).filter(n => !isNaN(n));
        if (numericIds.length > 0) {
          const pts = await db.select({ id: productTypes.id, name: productTypes.name })
            .from(productTypes)
            .where(inArray(productTypes.id, numericIds));
          for (const pt of pts) ptMap[String(pt.id)] = pt.name;

          // Look up customizer page handles by productTypeId + shop
          const pages = await db
            .select({ productTypeId: customizerPages.productTypeId, handle: customizerPages.handle })
            .from(customizerPages)
            .where(
              and(
                eq(customizerPages.shop, shop),
                eq(customizerPages.status, "active"),
                inArray(customizerPages.productTypeId, numericIds)
              )
            );
          for (const p of pages) if (p.productTypeId) handleMap[String(p.productTypeId)] = p.handle;
        }
      }

      // Build image URLs using the Shopify App Proxy path so they load without CORS issues
      // from inside the storefront iframe. Shopify rewrites /apps/appai/... → /api/proxy/...
      // For Supabase/external URLs, pass them through directly so gallery previews work.
      const proxyUrl = (u?: string | null) => {
        if (!u) return null;
        // Supabase or other absolute URL — pass through directly (needed for gallery previews)
        if (u.startsWith('http')) return u;
        // Relative path like /objects/designs/xxx.png → serve via App Proxy
        const clean = u.startsWith('/') ? u : `/${u}`;
        return `/apps/appai${clean}`;
      };

      return res.json({
        count: rows.length,
        limit: GALLERY_LIMIT,
        designs: rows.map(d => ({
          id: d.id,
          artworkUrl: proxyUrl(d.designImageUrl) || proxyUrl(d.thumbnailUrl),
          mockupUrls: Array.isArray(d.mockupUrls) ? (d.mockupUrls as string[]) : [],
          designState: d.designState || null,
          prompt: (d as any).userPrompt || d.prompt,
          stylePreset: d.stylePreset,
          size: d.size,
          frameColor: d.frameColor,
          productTypeId: d.productTypeId,
          baseTitle: d.productTypeId ? (ptMap[d.productTypeId] || null) : null,
          pageHandle: d.productTypeId ? (handleMap[d.productTypeId] || null) : null,
          customerId: d.customerId,
          createdAt: d.createdAt,
        }))
      });
    } catch (err: any) {
      console.error("[MyDesigns GET]", err);
      return res.status(500).json({ error: "Failed to fetch designs" });
    }
  });

  // ==================== STOREFRONT OTP AUTH ====================
  // Email-based OTP login for storefront customers.
  // Uses Resend to send 6-digit codes; codes expire after 10 minutes.

  app.post("/api/storefront/auth/request-otp", async (req: Request, res: Response) => {
    try {
      const { email, shop } = req.body;
      if (!email || !shop) {
        return res.status(400).json({ error: "Email and shop are required" });
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
        return res.status(400).json({ error: "Invalid shop domain" });
      }
      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }

      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
      const emailNorm = email.toLowerCase().trim();
      const userId = `email:${shop}:${emailNorm}`;

      let customer = await storage.getCustomerByUserId(userId);
      if (!customer) {
        customer = await storage.createCustomer({
          userId,
          credits: 5,
          freeGenerationsUsed: 0,
          totalGenerations: 0,
          totalSpent: "0.00",
        });
      }

      await pool.query(
        `UPDATE customers SET otp_code = $1, otp_expires_at = $2, email = $3 WHERE id = $4`,
        [otpCode, otpExpiresAt, emailNorm, customer.id]
      );

      const resendKey = process.env.RESEND_API_KEY;
      if (!resendKey) {
        console.error("[OTP] RESEND_API_KEY not set");
        return res.status(500).json({ error: "Email service not configured" });
      }

      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "AppAI <onboarding@resend.dev>",
          to: [emailNorm],
          subject: "Your AppAI Login Code",
          html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px"><h2 style="text-align:center">Your Login Code</h2><div style="background:#f5f5f5;border-radius:8px;padding:20px;text-align:center;margin:20px 0"><span style="font-size:32px;letter-spacing:8px;font-weight:bold">${otpCode}</span></div><p style="color:#666;text-align:center">This code expires in 10 minutes.</p></div>`,
        }),
      });

      if (!emailRes.ok) {
        const errText = await emailRes.text();
        console.error("[OTP] Resend error:", errText);
        return res.status(500).json({ error: "Failed to send email" });
      }

      console.log(`[OTP] Code sent to ${emailNorm} for shop ${shop}`);
      res.json({ ok: true, message: "OTP sent" });
    } catch (error: any) {
      console.error("[OTP] request-otp error:", error);
      res.status(500).json({ error: "Failed to send OTP" });
    }
  });

  app.post("/api/storefront/auth/verify-otp", async (req: Request, res: Response) => {
    try {
      const { email, code, shop } = req.body;
      if (!email || !code || !shop) {
        return res.status(400).json({ error: "Email, code, and shop are required" });
      }

      const emailNorm = email.toLowerCase().trim();
      const userId = `email:${shop}:${emailNorm}`;
      const customer = await storage.getCustomerByUserId(userId);

      if (!customer) {
        return res.status(401).json({ error: "Invalid email or code" });
      }

      const result = await pool.query(
        `SELECT otp_code, otp_expires_at FROM customers WHERE id = $1`,
        [customer.id]
      );
      const row = result.rows[0];

      if (!row || !row.otp_code || row.otp_code !== code) {
        return res.status(401).json({ error: "Invalid code" });
      }

      if (new Date(row.otp_expires_at) < new Date()) {
        return res.status(401).json({ error: "Code expired. Please request a new one." });
      }

      // Clear OTP after successful verification
      await pool.query(
        `UPDATE customers SET otp_code = NULL, otp_expires_at = NULL WHERE id = $1`,
        [customer.id]
      );

      console.log(`[OTP] Verified ${emailNorm} for shop ${shop}, customer ${customer.id}`);
      res.json({
        ok: true,
        customerId: customer.id,
        credits: customer.credits,
        freeGenerationsUsed: customer.freeGenerationsUsed,
      });
    } catch (error: any) {
      console.error("[OTP] verify-otp error:", error);
      res.status(500).json({ error: "Failed to verify OTP" });
    }
  });

  // ==================== STOREFRONT COUPON REDEMPTION ====================
  app.post("/api/storefront/auth/redeem-coupon", async (req: Request, res: Response) => {
    try {
      const { code, customerId, shop } = req.body;
      if (!code || !customerId || !shop) {
        return res.status(400).json({ error: "Code, customerId, and shop are required" });
      }
      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }
      const customer = await storage.getCustomer(customerId);
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }
      const coupon = await storage.getCouponByCode(code);
      if (!coupon) {
        return res.status(404).json({ error: "Invalid coupon code" });
      }
      if (!coupon.isActive) {
        return res.status(400).json({ error: "Coupon is no longer active" });
      }
      if (coupon.expiresAt && new Date() > coupon.expiresAt) {
        return res.status(400).json({ error: "Coupon has expired" });
      }
      if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
        return res.status(400).json({ error: "Coupon has reached maximum uses" });
      }
      await storage.updateCustomer(customer.id, {
        credits: customer.credits + coupon.creditAmount,
      });
      await storage.createCouponRedemption({
        couponId: coupon.id,
        customerId: customer.id,
      });
      await storage.updateCoupon(coupon.id, {
        usedCount: coupon.usedCount + 1,
      });
      await storage.createCreditTransaction({
        customerId: customer.id,
        type: "coupon",
        amount: coupon.creditAmount,
        description: `Redeemed coupon: ${coupon.code}`,
      });
      res.json({
        ok: true,
        creditsAdded: coupon.creditAmount,
        newBalance: customer.credits + coupon.creditAmount,
      });
    } catch (error: any) {
      console.error("[Storefront Coupon] redeem error:", error);
      res.status(500).json({ error: "Failed to redeem coupon" });
    }
  });

  // ==================== STOREFRONT DESIGN SKU (SHADOW SKU FOR CHECKOUT) ====================
  // Creates or reuses a hidden Shopify product+variant with the mockup as its image.
  // The storefront adds this shadow variant to cart so checkout renders the exact mockup.
  app.post("/api/storefront/design-sku", async (req: Request, res: Response) => {
    try {
      const { shop, sourceVariantId, designId, mockupUrl } = req.body;

      if (!shop || !sourceVariantId || !designId || !mockupUrl) {
        return res.status(400).json({
          ok: false,
          error: "Missing required fields: shop, sourceVariantId, designId, mockupUrl",
        });
      }

      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
        return res.status(400).json({ ok: false, error: "Invalid shop domain format" });
      }

      if (!mockupUrl.startsWith("https://")) {
        return res.status(400).json({ ok: false, error: "mockupUrl must be an absolute https URL" });
      }

      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ ok: false, error: "Shop not authorized" });
      }

      const accessToken = installation.accessToken!;
      const apiBase = `https://${shop}/admin/api/2024-10`;

      // Check for an existing (non-expired) mapping for this design
      const existing = await storage.getDesignSkuMapping(shop, String(sourceVariantId), String(designId));
      if (existing && new Date(existing.expiresAt) > new Date()) {
        return res.json({
          ok: true,
          shadowVariantId: existing.shadowShopifyVariantId,
          shadowProductId: existing.shadowShopifyProductId,
          mockupUrl: existing.mockupUrl,
          reused: true,
        });
      }

      // Create hidden shadow product on Shopify
      const productPayload = {
        product: {
          title: `AppAI Design ${designId}`,
          body_html: "",
          vendor: "AppAI",
          product_type: "appai-shadow",
          status: "draft",          // hidden from Online Store
          published: false,
          tags: "appai-shadow,appai-cleanup",
          variants: [
            {
              price: "0.00",
              inventory_management: null,
              inventory_policy: "continue",
              requires_shipping: false,
              taxable: false,
              sku: `appai-shadow-${designId}`,
            },
          ],
          images: [{ src: mockupUrl, alt: "AppAI custom design mockup" }],
        },
      };

      const createRes = await fetch(`${apiBase}/products.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify(productPayload),
      });

      if (!createRes.ok) {
        const errText = await createRes.text();
        console.error("[Design SKU] Product creation failed:", createRes.status, errText);
        return res.status(createRes.status).json({
          ok: false,
          error: "Failed to create shadow product",
          details: errText.substring(0, 300),
        });
      }

      const productData = await createRes.json();
      const shadowProduct = productData?.product;
      const shadowVariant = shadowProduct?.variants?.[0];

      if (!shadowProduct?.id || !shadowVariant?.id) {
        return res.status(500).json({ ok: false, error: "Shopify did not return product/variant ID" });
      }

      const shadowProductId = String(shadowProduct.id);
      const shadowVariantId = String(shadowVariant.id);

      // Assign the uploaded image to the variant so checkout uses it as its thumbnail
      const imageId = shadowProduct?.images?.[0]?.id;
      if (imageId) {
        await fetch(`${apiBase}/variants/${shadowVariantId}.json`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({ variant: { id: Number(shadowVariantId), image_id: imageId } }),
        }).catch((e: Error) => console.warn("[Design SKU] image_id assignment failed:", e.message));
      }

      // Persist mapping (7-day TTL)
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await storage.createDesignSkuMapping({
        shopDomain: shop,
        sourceVariantId: String(sourceVariantId),
        designId: String(designId),
        mockupUrl,
        shadowShopifyProductId: shadowProductId,
        shadowShopifyVariantId: shadowVariantId,
        expiresAt,
      });

      console.log(`[Design SKU] Created shadow variant ${shadowVariantId} for design ${designId} on ${shop}`);

      return res.json({
        ok: true,
        shadowVariantId,
        shadowProductId,
        mockupUrl,
        reused: false,
      });
    } catch (error: any) {
      console.error("[Design SKU] Error:", error);
      return res.status(500).json({ ok: false, error: error?.message || "Internal server error" });
    }
  });

  // ==================== SHADOW SKU CLEANUP ====================
  // Deletes expired shadow products from Shopify and removes DB mapping rows.
  // Runs automatically every 6 hours and can be triggered manually via the admin endpoint below.
  async function runDesignSkuCleanup(): Promise<{ deleted: number; errors: number }> {
    let deleted = 0;
    let errors = 0;
    try {
      const expired = await storage.getExpiredDesignSkuMappings(new Date());
      if (expired.length === 0) return { deleted, errors };

      // Group by shop so we can batch-delete per installation
      const byShop: Record<string, typeof expired> = {};
      for (const row of expired) {
        if (!byShop[row.shopDomain]) byShop[row.shopDomain] = [];
        byShop[row.shopDomain].push(row);
      }

      for (const shopDomain of Object.keys(byShop)) {
        const rows = byShop[shopDomain];
        const installation = await storage.getShopifyInstallationByShop(shopDomain);
        if (!installation?.accessToken) {
          errors += rows.length;
          continue;
        }

        for (const row of rows) {
          try {
            // Delete the shadow product from Shopify (also deletes its variant + images)
            await fetch(
              `https://${shopDomain}/admin/api/2024-10/products/${row.shadowShopifyProductId}.json`,
              {
                method: "DELETE",
                headers: { "X-Shopify-Access-Token": installation.accessToken },
              }
            );
            await storage.deleteDesignSkuMapping(row.id);
            deleted++;
          } catch (e: any) {
            console.warn(`[Design SKU Cleanup] Failed for product ${row.shadowShopifyProductId}:`, e.message);
            errors++;
          }
        }
      }
    } catch (e: any) {
      console.error("[Design SKU Cleanup] Unexpected error:", e);
      errors++;
    }
    console.log(`[Design SKU Cleanup] Done: deleted=${deleted} errors=${errors}`);
    return { deleted, errors };
  }

  // Manual trigger endpoint (ops/testing)
  app.post("/api/admin/design-sku-cleanup", isAuthenticated, async (_req: any, res: Response) => {
    const result = await runDesignSkuCleanup();
    res.json({ ok: true, ...result });
  });

  // ── Shadow product cleanup ──────────────────────────────────────────────────
  // Runs every hour. Deletes Shopify shadow products whose expiresAt has passed
  // and marks them as archived in the DB.
  async function runShadowProductCleanup(): Promise<{ deleted: number; errors: number }> {
    let deleted = 0;
    let errors = 0;
    try {
      const expired = await storage.getExpiredShadowProducts();
      if (expired.length === 0) return { deleted, errors };
      console.log(`[ShadowProduct Cleanup] Found ${expired.length} expired shadow products to clean up`);

      // Group by shop for efficient token lookup
      const byShop: Record<string, typeof expired> = {};
      for (const row of expired) {
        if (!byShop[row.shop]) byShop[row.shop] = [];
        byShop[row.shop].push(row);
      }

      for (const shopDomain of Object.keys(byShop)) {
        const rows = byShop[shopDomain];
        const installation = await storage.getShopifyInstallationByShop(shopDomain);
        if (!installation?.accessToken) {
          errors += rows.length;
          continue;
        }
        for (const row of rows) {
          try {
            // Delete the shadow product from Shopify (also removes its variant + images)
            const delRes = await fetch(
              `https://${shopDomain}/admin/api/2025-10/products/${row.shopifyProductId}.json`,
              { method: "DELETE", headers: { "X-Shopify-Access-Token": installation.accessToken } }
            );
            if (delRes.ok || delRes.status === 404) {
              // 404 = already gone from Shopify, still clean up our record
              await storage.updatePublishedProduct(row.id, { status: "archived" });
              deleted++;
            } else {
              const errText = await delRes.text();
              console.warn(`[ShadowProduct Cleanup] Shopify DELETE failed (${delRes.status}) for product ${row.shopifyProductId}: ${errText.substring(0, 150)}`);
              errors++;
            }
          } catch (e: any) {
            console.warn(`[ShadowProduct Cleanup] Error deleting product ${row.shopifyProductId}:`, e?.message);
            errors++;
          }
        }
      }
    } catch (e: any) {
      console.error("[ShadowProduct Cleanup] Unexpected error:", e);
      errors++;
    }
    console.log(`[ShadowProduct Cleanup] Done: deleted=${deleted} errors=${errors}`);
    return { deleted, errors };
  }

  // Manual trigger endpoint
  app.post("/api/admin/shadow-product-cleanup", isAuthenticated, async (_req: any, res: Response) => {
    const result = await runShadowProductCleanup();
    res.json({ ok: true, ...result });
  });

  // Auto-run shadow product cleanup every hour
  setInterval(() => {
    runShadowProductCleanup().catch((e: Error) => console.error("[ShadowProduct Cleanup] Interval error:", e));
  }, 60 * 60 * 1000);

  // POST /api/pattern/preview - Generate a tiled AOP pattern
  // Accepts { imageUrl, mode, pattern, scale, width, height, bgColor,
  //           singleScale, singleRotation, singlePosX, singlePosY }
  // Returns { patternUrl }
  // ── Background removal endpoint (separate from preview) ──────────────────
  // Called by the client's optional "Remove BG" button in PatternCustomizer.
  // Returns a data URL (base64 PNG) of the subject with background removed.
  app.post("/api/pattern/remove-bg", async (req: any, res: Response) => {
    try {
      const { imageUrl } = req.body as { imageUrl: string };
      if (!imageUrl) return res.status(400).json({ error: "imageUrl is required" });

      // Fetch the image buffer
      let sourceBuffer: Buffer;
      if (imageUrl.startsWith("/objects/")) {
        const host = req.get("host") || process.env.RAILWAY_PUBLIC_DOMAIN || "localhost";
        const protocol = req.protocol || "https";
        const absoluteUrl = `${protocol}://${host}${imageUrl}`;
        const srcRes = await fetch(absoluteUrl, { signal: AbortSignal.timeout(15000) });
        if (!srcRes.ok) throw new Error(`Failed to fetch image (${srcRes.status})`);
        sourceBuffer = Buffer.from(await srcRes.arrayBuffer());
      } else if (imageUrl.startsWith("data:")) {
        const base64Part = imageUrl.split(",")[1];
        sourceBuffer = Buffer.from(base64Part, "base64");
      } else {
        const srcRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
        if (!srcRes.ok) throw new Error(`Failed to fetch image (${srcRes.status})`);
        sourceBuffer = Buffer.from(await srcRes.arrayBuffer());
      }

      const { removeBackground } = await import("./picsart-client");
      const result = await removeBackground({ imageBuffer: sourceBuffer });
      res.json({ url: result.url });
    } catch (err: any) {
      console.error("[Remove BG] Error:", err.message);
      res.status(500).json({ error: err.message ?? "Background removal failed" });
    }
  });

  //
  // mode="pattern" pipeline:
  //   (1) [Optional, separate endpoint] remove-bg — transparent PNG cutout.
  //   (2) Sharp tileImage — seamless grid/brick/half-drop tile.
  //
  // mode="single" pipeline:
  //   (1) [Optional, separate endpoint] remove-bg — transparent PNG cutout.
  //   (2) Sharp composite — place artwork at specified transform on a blank canvas.
  app.post("/api/pattern/preview", async (req: any, res: Response) => {
    try {
      const {
        imageUrl,
        mode: editorMode = "pattern",
        pattern = "grid",
        scale = 1.5,
        width = 1024,
        height = 1024,
        bgColor,
        // Single image transform params
        singleScale = 1.0,
        singleRotation = 0,
        singlePosX = 0,
        singlePosY = 0,
      } = req.body as {
        imageUrl: string;
        mode?: string;
        pattern?: string;
        scale?: number;
        width?: number;
        height?: number;
        bgColor?: string;
        singleScale?: number;
        singleRotation?: number;
        singlePosX?: number;
        singlePosY?: number;
      };

      if (!imageUrl) {
        return res.status(400).json({ error: "imageUrl is required" });
      }

      // Step 1: Fetch the source image buffer.
      // Background removal is now a SEPARATE optional step done by /api/pattern/remove-bg.
      // The imageUrl here may already be a bg-removed data URL if the user clicked "Remove BG".
      console.log(`[Pattern Preview] Fetching source image (mode=${editorMode})...`);
      let motifBuffer: Buffer;
      try {
        if (imageUrl.startsWith("data:")) {
          // Already a data URL (e.g. bg-removed result from client)
          const base64Part = imageUrl.split(",")[1];
          motifBuffer = Buffer.from(base64Part, "base64");
          console.log("[Pattern Preview] Using data URL, buffer:", motifBuffer.length, "bytes");
        } else if (imageUrl.startsWith("/objects/")) {
          const host = req.get("host") || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.REPLIT_DEV_DOMAIN;
          const protocol = req.protocol || "https";
          const absoluteUrl = `${protocol}://${host}${imageUrl}`;
          console.log("[Pattern Preview] Fetching source from:", absoluteUrl);
          const srcResponse = await fetch(absoluteUrl, { signal: AbortSignal.timeout(15000) });
          if (!srcResponse.ok) throw new Error(`Failed to fetch source image (${srcResponse.status})`);
          motifBuffer = Buffer.from(await srcResponse.arrayBuffer());
          console.log("[Pattern Preview] Source image fetched:", motifBuffer.length, "bytes");
        } else {
          const srcResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
          if (!srcResponse.ok) throw new Error(`Failed to fetch source image (${srcResponse.status})`);
          motifBuffer = Buffer.from(await srcResponse.arrayBuffer());
          console.log("[Pattern Preview] External image fetched:", motifBuffer.length, "bytes");
        }
      } catch (fetchErr: any) {
        return res.status(500).json({ error: `Failed to load image: ${fetchErr.message}` });
      }

      // Step 2a (Single Image mode): Sharp composite — place artwork at transform on blank canvas.
      let patternBuffer: Buffer;

      if (editorMode === "single") {
        const sharp = (await import("sharp")).default;
        const outW = Math.min(width, 4096);
        const outH = Math.min(height, 4096);

        // Get motif dimensions
        const motifMeta = await sharp(motifBuffer).metadata();
        const motifW = motifMeta.width ?? 512;
        const motifH = motifMeta.height ?? 512;

        // Base size: fit to canvas
        const imgAR = motifW / motifH;
        const canvasAR = outW / outH;
        let baseW: number, baseH: number;
        if (imgAR > canvasAR) { baseW = outW; baseH = Math.round(outW / imgAR); }
        else { baseH = outH; baseW = Math.round(outH * imgAR); }

        const iw = Math.round(baseW * singleScale);
        const ih = Math.round(baseH * singleScale);

        // Centre + position offset
        const cx = Math.round(outW / 2 + (singlePosX / 100) * outW);
        const cy = Math.round(outH / 2 + (singlePosY / 100) * outH);

        // Resize motif to target size
        const resizedMotif = await sharp(motifBuffer)
          .resize(iw, ih, { fit: "fill" })
          .rotate(singleRotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .toBuffer();

        // Get rotated dimensions (rotation may change bounding box)
        const rotatedMeta = await sharp(resizedMotif).metadata();
        const rw = rotatedMeta.width ?? iw;
        const rh = rotatedMeta.height ?? ih;

        // Build canvas with background colour
        const bgRgb = bgColor && bgColor !== "transparent"
          ? { r: parseInt(bgColor.slice(1, 3), 16), g: parseInt(bgColor.slice(3, 5), 16), b: parseInt(bgColor.slice(5, 7), 16), alpha: 255 }
          : { r: 255, g: 255, b: 255, alpha: 0 };

        const left = cx - Math.round(rw / 2);
        const top = cy - Math.round(rh / 2);

        const canvas = sharp({
          create: { width: outW, height: outH, channels: 4, background: bgRgb },
        });

        patternBuffer = await canvas
          .composite([{ input: resizedMotif, left, top, blend: "over" }])
          .png()
          .toBuffer();

        console.log(`[Pattern Preview] Single image composite complete: ${outW}x${outH} canvas, motif at (${left},${top}) size ${rw}x${rh}`);

      } else {
        // Step 2b (Pattern mode): Sharp tileImage — tile the transparent motif onto a canvas.
        const modeMap: Record<string, TileMode> = {
          tile: "grid",
          grid: "grid",
          mirror: "grid",
          hex: "brick",
          hex2: "brick",
          diamond: "half",
          brick: "brick",
          half: "half",
        };
        const tileMode: TileMode = modeMap[pattern] ?? "grid";

        console.log(`[Pattern Preview] Tiling with Sharp: mode=${tileMode} scale=${scale} size=${width}x${height} bg=${bgColor ?? "transparent"}`);
        const tileResult = await tileImage({
          motifBuffer,
          outputWidth: Math.min(width, 4096),
          outputHeight: Math.min(height, 4096),
          scale,
          mode: tileMode,
          bgColor: bgColor || "",
        });
        patternBuffer = tileResult.buffer;
        console.log(`[Pattern Preview] Sharp tiling complete: ${tileResult.cols}x${tileResult.rows} tiles, buffer=${patternBuffer.length} bytes`);
      }

      // Persist the pattern so Printify (and our own server) can always reach it.
      const patternId = crypto.randomUUID();
      const patternFilename = `pattern_${patternId}.png`;

      let patternUrl: string;
      if (isSupabaseDesignsConfigured()) {
        try {
          const supabaseUrl = await uploadDesignFileToSupabase({
            buffer: patternBuffer,
            filename: patternFilename,
            contentType: "image/png",
          });
          if (supabaseUrl) {
            patternUrl = supabaseUrl;
            console.log("[Pattern Preview] Pattern saved to Supabase:", patternUrl.substring(0, 80));
          } else {
            throw new Error("Supabase upload returned null");
          }
        } catch (err) {
          console.warn("[Pattern Preview] Supabase failed, using local:", (err as Error).message);
          const storageDir = getStorageDir();
          const designsDir = path.join(storageDir, "designs");
          await fs.promises.mkdir(designsDir, { recursive: true });
          await fs.promises.writeFile(path.join(designsDir, patternFilename), patternBuffer);
          patternUrl = `/objects/designs/${patternFilename}`;
        }
      } else {
        const storageDir = getStorageDir();
        const designsDir = path.join(storageDir, "designs");
        await fs.promises.mkdir(designsDir, { recursive: true });
        await fs.promises.writeFile(path.join(designsDir, patternFilename), patternBuffer);
        patternUrl = `/objects/designs/${patternFilename}`;
      }

      res.json({ patternUrl, patternId });
    } catch (error: any) {
      console.error("[Pattern Preview] Error:", error);
      res.status(500).json({ error: error.message ?? "Failed to generate pattern" });
    }
  });

  // Admin endpoints for product types (requires authentication)
  app.post("/api/admin/product-types", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) {
        return res.status(403).json({ error: "Merchant not found" });
      }

      const { name, description, printifyBlueprintId, mockupTemplateUrl, sizes, frameColors, aspectRatio } = req.body;
      
      const newProductType = await storage.createProductType({
        merchantId: merchant.id,
        name,
        description,
        printifyBlueprintId,
        mockupTemplateUrl,
        sizes: JSON.stringify(sizes || []),
        frameColors: JSON.stringify(frameColors || []),
        aspectRatio: aspectRatio || "3:4",
        isActive: true,
        sortOrder: 0,
      });

      res.json(newProductType);
    } catch (error) {
      console.error("Error creating product type:", error);
      res.status(500).json({ error: "Failed to create product type" });
    }
  });

  app.patch("/api/admin/product-types/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;
      
      if (updates.sizes && Array.isArray(updates.sizes)) {
        updates.sizes = JSON.stringify(updates.sizes);
      }
      if (updates.frameColors && Array.isArray(updates.frameColors)) {
        updates.frameColors = JSON.stringify(updates.frameColors);
      }

      const updated = await storage.updateProductType(id, updates);
      if (!updated) {
        return res.status(404).json({ error: "Product type not found" });
      }
      res.json(updated);
    } catch (error) {
      console.error("Error updating product type:", error);
      res.status(500).json({ error: "Failed to update product type" });
    }
  });

  app.delete("/api/admin/product-types/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      await storage.deleteProductType(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting product type:", error);
      res.status(500).json({ error: "Failed to delete product type" });
    }
  });

  app.post("/api/admin/product-types/seed", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) {
        return res.status(403).json({ error: "Merchant not found" });
      }

      const existing = await storage.getProductTypesByMerchant(merchant.id);
      if (existing.length > 0) {
        return res.json({ message: "Product types already exist", productTypes: existing });
      }

      const defaultProductTypes = [
        {
          merchantId: merchant.id,
          name: "Framed Prints",
          description: "Museum-quality framed artwork with premium materials",
          printifyBlueprintId: 540,
          aspectRatio: "3:4",
          sizes: JSON.stringify([
            { id: "11x14", name: "11\" x 14\"", width: 11, height: 14 },
            { id: "12x16", name: "12\" x 16\"", width: 12, height: 16 },
            { id: "16x20", name: "16\" x 20\"", width: 16, height: 20 },
            { id: "18x24", name: "18\" x 24\"", width: 18, height: 24 },
            { id: "24x32", name: "24\" x 32\"", width: 24, height: 32 },
          ]),
          frameColors: JSON.stringify([
            { id: "black", name: "Black", hex: "#1a1a1a" },
            { id: "white", name: "White", hex: "#f5f5f5" },
            { id: "natural", name: "Natural Wood", hex: "#d4a574" },
          ]),
          isActive: true,
          sortOrder: 0,
        },
        {
          merchantId: merchant.id,
          name: "Throw Pillows",
          description: "Cozy decorative throw pillows with custom artwork",
          printifyBlueprintId: 83,
          aspectRatio: "1:1",
          sizes: JSON.stringify([
            { id: "16x16", name: "16\" x 16\"", width: 16, height: 16 },
            { id: "18x18", name: "18\" x 18\"", width: 18, height: 18 },
            { id: "20x20", name: "20\" x 20\"", width: 20, height: 20 },
          ]),
          frameColors: JSON.stringify([]),
          isActive: true,
          sortOrder: 1,
        },
        {
          merchantId: merchant.id,
          name: "Ceramic Mugs",
          description: "Premium ceramic mugs with wraparound artwork",
          printifyBlueprintId: 19,
          aspectRatio: "3:2",
          sizes: JSON.stringify([
            { id: "11oz", name: "11 oz", width: 11, height: 11 },
            { id: "15oz", name: "15 oz", width: 15, height: 15 },
          ]),
          frameColors: JSON.stringify([]),
          isActive: true,
          sortOrder: 2,
        },
      ];

      const created = [];
      for (const pt of defaultProductTypes) {
        const newPt = await storage.createProductType(pt);
        created.push(newPt);
      }

      res.json({ message: "Default product types seeded", productTypes: created });
    } catch (error) {
      console.error("Error seeding product types:", error);
      res.status(500).json({ error: "Failed to seed product types" });
    }
  });

  // Delete design
  app.delete("/api/designs/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const designId = parseInt(req.params.id);
      const userId = req.user.claims.sub;
      const customer = await storage.getCustomerByUserId(userId);
      
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }

      const design = await storage.getDesign(designId);
      if (!design || design.customerId !== customer.id) {
        return res.status(404).json({ error: "Design not found" });
      }

      await storage.deleteDesign(designId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting design:", error);
      res.status(500).json({ error: "Failed to delete design" });
    }
  });

  // Create share link for a design (public endpoint for Shopify embed)
  app.post("/api/designs/share", async (req: Request, res: Response) => {
    try {
      const { 
        imageUrl,
        thumbnailUrl,
        prompt,
        stylePreset,
        size,
        frameColor,
        transformScale,
        transformX,
        transformY,
        productTypeId,
        shopDomain,
        productId,
        productHandle,
      } = req.body;

      if (!imageUrl || !prompt || !size || !frameColor) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      // Validate image URL is from our storage domain (security check)
      // Use strict hostname matching to prevent bypass via subdomains
      const allowedDomains = [
        "storage.googleapis.com",
        "storage.cloud.google.com",
        process.env.REPL_SLUG ? `${process.env.REPL_SLUG}.replit.app` : null,
        "localhost",
      ].filter(Boolean) as string[];
      
      try {
        const imageUrlObj = new URL(imageUrl);
        // Require https for non-localhost URLs
        if (imageUrlObj.hostname !== "localhost" && imageUrlObj.protocol !== "https:") {
          return res.status(400).json({ error: "Image URL must use HTTPS" });
        }
        // Strict hostname matching: exact match or ends with .domain
        const isAllowedDomain = allowedDomains.some(domain => {
          const hostname = imageUrlObj.hostname;
          return hostname === domain || hostname.endsWith(`.${domain}`);
        });
        if (!isAllowedDomain) {
          return res.status(400).json({ error: "Invalid image URL" });
        }
      } catch {
        return res.status(400).json({ error: "Invalid image URL format" });
      }

      // Generate unique share token
      const shareToken = crypto.randomBytes(16).toString("hex");
      
      // Set expiration to 30 days from now
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      const sharedDesign = await storage.createSharedDesign({
        designId: null, // Nullable for unsaved designs
        shareToken,
        imageUrl,
        thumbnailUrl: thumbnailUrl || null,
        prompt,
        stylePreset: stylePreset || null,
        size,
        frameColor,
        transformScale: Math.round(transformScale ?? 100),
        transformX: Math.round(transformX ?? 50),
        transformY: Math.round(transformY ?? 50),
        productTypeId: productTypeId || null,
        shopDomain: shopDomain || null,
        productId: productId || null,
        productHandle: productHandle || null,
        expiresAt,
        viewCount: 0,
      });

      // Build share URL
      let shareUrl = "";
      if (shopDomain && productHandle) {
        // For Shopify embeds, return the merchant's product page URL with design ID
        shareUrl = `https://${shopDomain}/products/${productHandle}?sharedDesignId=${sharedDesign.id}`;
      } else {
        // For non-Shopify, use our embed design page
        shareUrl = `/embed/design?productTypeId=${productTypeId}&sharedDesignId=${sharedDesign.id}`;
      }

      res.json({ 
        sharedDesignId: sharedDesign.id,
        shareToken: sharedDesign.shareToken,
        shareUrl,
        expiresAt: sharedDesign.expiresAt,
      });
    } catch (error) {
      console.error("Error creating share link:", error);
      res.status(500).json({ error: "Failed to create share link" });
    }
  });

  // Get shared design by ID (public endpoint)
  app.get("/api/shared-designs/:id", async (req: Request, res: Response) => {
    try {
      const sharedDesign = await storage.getSharedDesign(req.params.id);
      
      if (!sharedDesign) {
        return res.status(404).json({ error: "Shared design not found" });
      }

      // Check if expired
      if (sharedDesign.expiresAt && new Date(sharedDesign.expiresAt) < new Date()) {
        return res.status(410).json({ error: "This shared design has expired" });
      }

      // Increment view count
      await storage.incrementSharedDesignViewCount(sharedDesign.id);

      res.json({
        id: sharedDesign.id,
        imageUrl: sharedDesign.imageUrl,
        thumbnailUrl: sharedDesign.thumbnailUrl,
        prompt: sharedDesign.prompt,
        stylePreset: sharedDesign.stylePreset,
        size: sharedDesign.size,
        frameColor: sharedDesign.frameColor,
        transformScale: sharedDesign.transformScale,
        transformX: sharedDesign.transformX,
        transformY: sharedDesign.transformY,
        productTypeId: sharedDesign.productTypeId,
        shopDomain: sharedDesign.shopDomain,
        productId: sharedDesign.productId,
        productHandle: sharedDesign.productHandle,
        viewCount: sharedDesign.viewCount + 1,
        createdAt: sharedDesign.createdAt,
      });
    } catch (error) {
      console.error("Error fetching shared design:", error);
      res.status(500).json({ error: "Failed to fetch shared design" });
    }
  });

  // Validate and prepare imported design (for Kittl/custom uploads)
  // This endpoint validates the uploaded image and returns metadata for previewing
  app.post("/api/designs/import", async (req: Request, res: Response) => {
    try {
      const { 
        imageUrl, 
        source = "upload",
        name = "Imported Design",
      } = req.body;

      if (!imageUrl) {
        return res.status(400).json({ error: "Missing image URL" });
      }

      // Validate source
      const validSources = ["upload", "kittl"];
      if (!validSources.includes(source)) {
        return res.status(400).json({ error: "Invalid design source" });
      }

      // SECURITY: Only accept internal /objects/ paths from our upload system
      // This prevents users from importing arbitrary external URLs
      if (!imageUrl.startsWith("/objects/")) {
        return res.status(400).json({ error: "Invalid image path - please upload your design first" });
      }

      // Additional validation: ensure path is under expected upload directory
      const expectedPrefix = "/objects/uploads/";
      if (!imageUrl.startsWith(expectedPrefix)) {
        return res.status(400).json({ error: "Invalid upload path" });
      }

      // Fetch the image to validate it and get dimensions
      let width = 0;
      let height = 0;
      let contentType = "";
      let finalImageUrl = imageUrl;
      
      try {
        // Resolve internal path to full URL for fetching
        const baseUrl =
  (process.env.PUBLIC_APP_URL || process.env.APP_URL || "").replace(/\/$/, "") ||
  `http://localhost:${process.env.PORT || 5000}`;

        const fetchUrl = `${baseUrl}${imageUrl}`;

        const response = await fetch(fetchUrl);
        if (!response.ok) {
          return res.status(400).json({ error: "Could not fetch uploaded image" });
        }

        contentType = response.headers.get("content-type") || "";
        // SECURITY: Reject SVG files to avoid XSS risks from embedded scripts
        // Only allow safe raster image formats
        const allowedTypes = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
        if (contentType.includes("svg")) {
          return res.status(400).json({ error: "SVG files are not supported. Please upload PNG, JPG, or WebP images." });
        }
        if (!allowedTypes.some(type => contentType.includes(type))) {
          return res.status(400).json({ error: "Invalid file type. Please upload PNG, JPG, or WebP images." });
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        // Check file size (max 10MB)
        const MAX_SIZE = 10 * 1024 * 1024; // 10MB
        if (buffer.length > MAX_SIZE) {
          return res.status(400).json({ error: "File too large. Maximum size is 10MB." });
        }

        // For raster images, get dimensions using sharp
        {
          // For raster images, just get dimensions
          const metadata = await sharp(buffer).metadata();
          width = metadata.width || 0;
          height = metadata.height || 0;
        }
      } catch (fetchError) {
        console.error("Error validating image:", fetchError);
        return res.status(400).json({ error: "Could not validate uploaded image" });
      }

      // Calculate aspect ratio
      let aspectRatio = "1:1";
      if (width && height) {
        const ratio = width / height;
        if (ratio > 1.3) aspectRatio = "4:3";
        else if (ratio > 1.1) aspectRatio = "1:1";
        else if (ratio > 0.9) aspectRatio = "1:1";
        else if (ratio > 0.7) aspectRatio = "3:4";
        else aspectRatio = "2:3";
      }

      res.json({
        success: true,
        imageUrl: finalImageUrl,
        name,
        source,
        width,
        height,
        aspectRatio,
        contentType,
      });
    } catch (error) {
      console.error("Error importing design:", error);
      res.status(500).json({ error: "Failed to import design" });
    }
  });

  // Reuse existing artwork on a different product/size/color
  // Creates a new design record using the same image from an existing design
  app.post("/api/designs/reuse", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      let customer = await storage.getCustomerByUserId(userId);
      
      if (!customer) {
        customer = await storage.createCustomer({
          userId,
          credits: 5,
          freeGenerationsUsed: 0,
          totalGenerations: 0,
          totalSpent: "0.00",
        });
      }

      // Check design gallery limit (50 max)
      const designCount = await storage.getDesignCountByCustomer(customer.id);
      if (designCount >= 50) {
        return res.status(400).json({ 
          error: "Your design gallery is full (50 designs max). Please delete some designs to save new ones.",
          galleryFull: true 
        });
      }

      const { 
        sourceDesignId, 
        productTypeId, 
        size, 
        frameColor,
        transformScale = 100,
        transformX = 50,
        transformY = 50,
      } = req.body;

      if (!sourceDesignId) {
        return res.status(400).json({ error: "Source design ID is required" });
      }

      if (!productTypeId || !size || !frameColor) {
        return res.status(400).json({ error: "Product type, size, and color are required" });
      }

      // Fetch the source design
      const sourceDesign = await storage.getDesign(parseInt(sourceDesignId));
      if (!sourceDesign) {
        return res.status(404).json({ error: "Source design not found" });
      }

      // Verify the user owns the source design
      if (sourceDesign.customerId !== customer.id) {
        return res.status(403).json({ error: "You can only reuse your own designs" });
      }

      // Create a new design record with the same image
      // Ensure transform values are integers (database columns are integer type)
      const newDesign = await storage.createDesign({
        customerId: customer.id,
        prompt: sourceDesign.prompt,
        stylePreset: sourceDesign.stylePreset,
        size,
        frameColor: frameColor || sourceDesign.frameColor,
        generatedImageUrl: sourceDesign.generatedImageUrl,
        thumbnailImageUrl: sourceDesign.thumbnailImageUrl,
        transformScale: Math.round(transformScale),
        transformX: Math.round(transformX),
        transformY: Math.round(transformY),
        productTypeId: parseInt(productTypeId),
        designSource: "ai", // Mark as AI-generated since it came from an AI design
      });

      res.json({
        success: true,
        design: newDesign,
        message: "Design saved to your gallery",
      });
    } catch (error) {
      console.error("Error reusing design:", error);
      res.status(500).json({ error: "Failed to save reused design" });
    }
  });

  // Purchase credits via Stripe Checkout
  app.post("/api/credits/purchase", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { package: creditPackage, shop } = req.body;
      
      if (!stripe) {
        return res.status(503).json({ error: "Payments not configured. Please add STRIPE_SECRET_KEY to Railway." });
      }

      let customer = await storage.getCustomerByUserId(userId);
      if (!customer) {
        customer = await storage.createCustomer({
          userId,
          credits: 0,
          freeGenerationsUsed: 0,
          totalGenerations: 0,
          totalSpent: "0.00",
        });
      }

      // Credit packages: $1 for 10 credits
      let creditsToAdd = 0;
      let priceInCents = 0;
      
      if (creditPackage === "10") {
        creditsToAdd = 10;
        priceInCents = 100; // $1.00
      } else {
        return res.status(400).json({ error: "Invalid credit package. Currently only '10' is supported." });
      }

      const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
      
      // Create Stripe Checkout Session
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: `${creditsToAdd} AI Generation Credits`,
                description: "Credits for generating custom AI artwork",
              },
              unit_amount: priceInCents,
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: `${appUrl}/designs?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/designs?payment=cancelled`,
        customer_email: customer.email || undefined,
        metadata: {
          customerId: customer.id,
          creditsToAdd: creditsToAdd.toString(),
          shop: shop || "",
        },
      });

      if (session.url) {
        res.json({ url: session.url });
      } else {
        res.status(500).json({ error: "Failed to create checkout session" });
      }
    } catch (error: any) {
      console.error("Error creating checkout session:", error);
      res.status(500).json({ error: error.message || "Failed to initiate purchase" });
    }
  });



  // Get credit transactions
  app.get("/api/credits/transactions", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const customer = await storage.getCustomerByUserId(userId);
      
      if (!customer) {
        return res.json([]);
      }

      const transactions = await storage.getCreditTransactionsByCustomer(customer.id);
      res.json(transactions);
    } catch (error) {
      console.error("Error fetching transactions:", error);
      res.status(500).json({ error: "Failed to fetch transactions" });
    }
  });

  // Get customer orders
  app.get("/api/orders", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const customer = await storage.getCustomerByUserId(userId);
      
      if (!customer) {
        return res.json([]);
      }

      const orders = await storage.getOrdersByCustomer(customer.id);
      res.json(orders);
    } catch (error) {
      console.error("Error fetching orders:", error);
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  });

  // Create order (add to cart / checkout)
  app.post("/api/orders", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { designId, shippingAddress } = req.body;
      
      const customer = await storage.getCustomerByUserId(userId);
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }

      const design = await storage.getDesign(designId);
      if (!design || design.customerId !== customer.id) {
        return res.status(404).json({ error: "Design not found" });
      }

      // Calculate credit refund (max $1.00 = 100 cents)
      const transactions = await storage.getCreditTransactionsByCustomer(customer.id);
      const purchasedCreditsSpent = transactions
        .filter(t => t.type === "purchase")
        .reduce((sum, t) => sum + (t.priceInCents || 0), 0);
      
      const creditRefundInCents = Math.min(purchasedCreditsSpent, 100);

      // Get price based on size (mock prices for now - would come from Printify API)
      const sizeConfig = PRINT_SIZES.find(s => s.id === design.size);
      const basePrices: Record<string, number> = {
        "11x14": 3999,
        "12x16": 4499,
        "16x20": 5499,
        "16x24": 5999,
        "20x30": 7999,
        "16x16": 4999,
      };
      const priceInCents = basePrices[design.size] || 4999;
      const shippingInCents = 899; // $8.99 flat rate USA

      const order = await storage.createOrder({
        designId: design.id,
        customerId: customer.id,
        status: "pending",
        size: design.size,
        frameColor: design.frameColor,
        quantity: 1,
        priceInCents,
        shippingInCents,
        creditRefundInCents,
        shippingAddress: JSON.stringify(shippingAddress),
      });

      res.json({
        order,
        totalInCents: priceInCents + shippingInCents - creditRefundInCents,
      });
    } catch (error) {
      console.error("Error creating order:", error);
      res.status(500).json({ error: "Failed to create order" });
    }
  });

  // ==================== MERCHANT ADMIN ENDPOINTS ====================

  // Get or create merchant profile
  app.get("/api/merchant", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      console.log("[/api/merchant] Getting merchant for userId:", userId);

      let merchant = await storage.getMerchantByUserId(userId);
      console.log("[/api/merchant] Existing merchant:", merchant ? "found" : "not found");

      if (!merchant) {
        console.log("[/api/merchant] Creating new merchant...");
        try {
          merchant = await storage.createMerchant({
            userId,
            useBuiltInNanoBanana: true,
            subscriptionTier: "free",
            monthlyGenerationLimit: 100,
            generationsThisMonth: 0,
          });
          console.log("[/api/merchant] Created merchant:", merchant.id);
        } catch (createError: any) {
          // Handle unique constraint violation - merchant might have been created by another request
          if (createError.code === '23505') {
            console.log("[/api/merchant] Merchant already exists (race condition), fetching again...");
            merchant = await storage.getMerchantByUserId(userId);
          } else {
            throw createError;
          }
        }
      }

      res.json(merchant);
    } catch (error: any) {
      console.error("[/api/merchant] Error:", error);
      res.status(500).json({ error: "Failed to fetch merchant", details: error?.message || String(error) });
    }
  }));

  // Update merchant settings
  app.put("/api/merchant", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      let merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        merchant = await storage.createMerchant({
          userId,
          useBuiltInNanoBanana: true,
          subscriptionTier: "free",
          monthlyGenerationLimit: 100,
          generationsThisMonth: 0,
        });
      }

      const { printifyApiToken, printifyShopId, useBuiltInNanoBanana, customNanoBananaToken } = req.body;
      
      const updated = await storage.updateMerchant(merchant.id, {
        printifyApiToken: printifyApiToken || merchant.printifyApiToken,
        printifyShopId: printifyShopId || merchant.printifyShopId,
        useBuiltInNanoBanana: useBuiltInNanoBanana !== undefined ? useBuiltInNanoBanana : merchant.useBuiltInNanoBanana,
        customNanoBananaToken: customNanoBananaToken || merchant.customNanoBananaToken,
      });

      res.json(updated);
    } catch (error: any) {
      console.error("Error updating merchant:", error);
      res.status(500).json({ error: "Failed to update merchant", details: error?.message || String(error) });
    }
  }));

  // Get merchant generation stats
  app.get("/api/admin/stats", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.json({ total: 0, successful: 0, failed: 0 });
      }

      // Get stats for the last 30 days
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);

      const stats = await storage.getGenerationStats(merchant.id, startDate, endDate);
      res.json(stats);
    } catch (error) {
      console.error("Error fetching stats:", error);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  }));

  // Migrate existing designs to have thumbnails (and migrate base64 to object storage)
  app.post("/api/admin/migrate-thumbnails", isAuthenticated, async (req: any, res: Response) => {
    try {
      const batchSize = req.body.batchSize || 10;
      const designs = await storage.getDesignsNeedingThumbnails(batchSize);
      
      if (designs.length === 0) {
        return res.json({ migrated: 0, message: "No designs need thumbnail migration" });
      }

      const storageDir = getStorageDir();
      const designsDir = path.join(storageDir, "designs");
      await fs.promises.mkdir(designsDir, { recursive: true });

      let migratedCount = 0;
      const errors: string[] = [];

      for (const design of designs) {
        try {
          const imageUrl = design.generatedImageUrl;
          
          if (!imageUrl) continue;
          
          let buffer: Buffer;
          let imageId: string;
          let newGeneratedImageUrl: string | undefined;
          let thumbnailUrl: string | undefined;
          
          if (imageUrl.startsWith("data:")) {
            // Base64 image — extract, decode, and migrate to storage
            const base64Match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
            if (!base64Match) {
              errors.push(`Design ${design.id}: Invalid base64 format`);
              continue;
            }
            const imageFormat = base64Match[1];
            const extension = imageFormat === "png" ? "png" : "jpg";
            buffer = Buffer.from(base64Match[2], "base64");
            imageId = crypto.randomUUID();
            const filename = `${imageId}.${extension}`;

            if (isSupabaseDesignsConfigured()) {
              try {
                const thumbBuf = await generateThumbnail(buffer);
                const result = await uploadDesignToSupabase({
                  imageBuffer: buffer,
                  thumbnailBuffer: thumbBuf,
                  imageId,
                  extension: extension as "png" | "jpg",
                });
                if (result) {
                  newGeneratedImageUrl = result.imageUrl;
                  // thumbnailUrl set below
                  thumbnailUrl = result.thumbnailUrl;
                }
              } catch (err) {
                errors.push(`Design ${design.id}: Supabase upload failed: ${(err as Error).message}`);
                continue;
              }
            }
            if (!newGeneratedImageUrl) {
              await fs.promises.writeFile(path.join(designsDir, filename), buffer);
              newGeneratedImageUrl = `/objects/designs/${filename}`;
            }
            
          } else if (imageUrl.startsWith("/objects/")) {
            // Already in local storage — read the file to generate thumbnail
            const filenameMatch = imageUrl.match(/\/objects\/designs\/([^.]+\.(png|jpg))$/);
            if (!filenameMatch) {
              errors.push(`Design ${design.id}: Could not parse filename from URL`);
              continue;
            }
            const filename = filenameMatch[1];
            imageId = filename.replace(/\.(png|jpg)$/, "");
            const localPath = path.join(designsDir, filename);
            try {
              buffer = await fs.promises.readFile(localPath);
            } catch {
              errors.push(`Design ${design.id}: Source image not found at ${localPath}`);
              continue;
            }
            
          } else {
            errors.push(`Design ${design.id}: Unknown image URL format`);
            continue;
          }

          // Generate thumbnail (skip if already set by Supabase upload)
          if (!thumbnailUrl) {
            const thumbnailBuffer = await generateThumbnail(buffer);
            const thumbFilename = `thumb_${imageId}.jpg`;
            await fs.promises.writeFile(path.join(designsDir, thumbFilename), thumbnailBuffer);
            thumbnailUrl = `/objects/designs/${thumbFilename}`;
          }
          
          if (!thumbnailUrl) continue;

          // Update design with new URLs
          const updateData: { thumbnailImageUrl: string; generatedImageUrl?: string } = { 
            thumbnailImageUrl: thumbnailUrl 
          };
          if (newGeneratedImageUrl) {
            updateData.generatedImageUrl = newGeneratedImageUrl;
          }
          await storage.updateDesign(design.id, updateData);
          migratedCount++;
          
        } catch (err) {
          errors.push(`Design ${design.id}: ${(err as Error).message}`);
        }
      }

      res.json({
        migrated: migratedCount,
        total: designs.length,
        errors: errors.length > 0 ? errors : undefined,
        hasMore: designs.length === batchSize
      });
    } catch (error) {
      console.error("Error migrating thumbnails:", error);
      res.status(500).json({ error: "Failed to migrate thumbnails" });
    }
  });

  // Backfill product type for existing designs (defaults to Framed Vertical Poster with ID 20)
  app.post("/api/admin/backfill-product-types", isAuthenticated, async (req: any, res: Response) => {
    try {
      const batchSize = req.body.batchSize || 50;
      const defaultProductTypeId = req.body.defaultProductTypeId || 20; // Framed Vertical Poster
      
      const designs = await storage.getDesignsNeedingProductType(batchSize);
      
      if (designs.length === 0) {
        return res.json({ updated: 0, message: "No designs need product type backfill" });
      }

      let updatedCount = 0;
      const errors: string[] = [];

      for (const design of designs) {
        try {
          await storage.updateDesign(design.id, { productTypeId: defaultProductTypeId });
          updatedCount++;
        } catch (err) {
          errors.push(`Design ${design.id}: ${(err as Error).message}`);
        }
      }

      res.json({
        updated: updatedCount,
        total: designs.length,
        errors: errors.length > 0 ? errors : undefined,
        hasMore: designs.length === batchSize
      });
    } catch (error) {
      console.error("Error backfilling product types:", error);
      res.status(500).json({ error: "Failed to backfill product types" });
    }
  });

  // ==================== COUPON MANAGEMENT ====================

  // Get merchant's coupons
  app.get("/api/admin/coupons", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.json([]);
      }

      const coupons = await storage.getCouponsByMerchant(merchant.id);
      res.json(coupons);
    } catch (error) {
      console.error("Error fetching coupons:", error);
      res.status(500).json({ error: "Failed to fetch coupons" });
    }
  });

  // Create coupon
  app.post("/api/admin/coupons", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const { code, creditAmount, maxUses, expiresAt } = req.body;
      
      if (!code || !creditAmount) {
        return res.status(400).json({ error: "Code and credit amount are required" });
      }

      // Check if code already exists
      const existingCoupon = await storage.getCouponByCode(code);
      if (existingCoupon) {
        return res.status(400).json({ error: "Coupon code already exists" });
      }

      const coupon = await storage.createCoupon({
        merchantId: merchant.id,
        code,
        creditAmount: parseInt(creditAmount),
        maxUses: maxUses ? parseInt(maxUses) : null,
        isActive: true,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      });

      res.json(coupon);
    } catch (error) {
      console.error("Error creating coupon:", error);
      res.status(500).json({ error: "Failed to create coupon" });
    }
  });

  // Update coupon
  app.patch("/api/admin/coupons/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const couponId = parseInt(req.params.id);
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const coupon = await storage.getCoupon(couponId);
      if (!coupon || coupon.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Coupon not found" });
      }

      const { isActive, maxUses, expiresAt } = req.body;
      
      const updated = await storage.updateCoupon(couponId, {
        isActive: isActive !== undefined ? isActive : coupon.isActive,
        maxUses: maxUses !== undefined ? maxUses : coupon.maxUses,
        expiresAt: expiresAt ? new Date(expiresAt) : coupon.expiresAt,
      });

      res.json(updated);
    } catch (error) {
      console.error("Error updating coupon:", error);
      res.status(500).json({ error: "Failed to update coupon" });
    }
  });

  // Delete coupon
  app.delete("/api/admin/coupons/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const couponId = parseInt(req.params.id);
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const coupon = await storage.getCoupon(couponId);
      if (!coupon || coupon.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Coupon not found" });
      }

      await storage.deleteCoupon(couponId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting coupon:", error);
      res.status(500).json({ error: "Failed to delete coupon" });
    }
  });

  // Redeem coupon (customer endpoint)
  app.post("/api/coupons/redeem", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { code } = req.body;
      
      if (!code) {
        return res.status(400).json({ error: "Coupon code is required" });
      }

      const customer = await storage.getCustomerByUserId(userId);
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }

      const coupon = await storage.getCouponByCode(code);
      if (!coupon) {
        return res.status(404).json({ error: "Invalid coupon code" });
      }

      if (!coupon.isActive) {
        return res.status(400).json({ error: "Coupon is no longer active" });
      }

      if (coupon.expiresAt && new Date() > coupon.expiresAt) {
        return res.status(400).json({ error: "Coupon has expired" });
      }

      if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
        return res.status(400).json({ error: "Coupon has reached maximum uses" });
      }

      // Add credits to customer
      await storage.updateCustomer(customer.id, {
        credits: customer.credits + coupon.creditAmount,
      });

      // Record redemption
      await storage.createCouponRedemption({
        couponId: coupon.id,
        customerId: customer.id,
      });

      // Update coupon usage count
      await storage.updateCoupon(coupon.id, {
        usedCount: coupon.usedCount + 1,
      });

      // Log credit transaction
      await storage.createCreditTransaction({
        customerId: customer.id,
        type: "coupon",
        amount: coupon.creditAmount,
        description: `Redeemed coupon: ${coupon.code}`,
      });

      res.json({
        success: true,
        creditsAdded: coupon.creditAmount,
        newBalance: customer.credits + coupon.creditAmount,
      });
    } catch (error) {
      console.error("Error redeeming coupon:", error);
      res.status(500).json({ error: "Failed to redeem coupon" });
    }
  });

  // ==================== STYLE PRESET MANAGEMENT ====================

  // Get merchant's style presets
  app.get("/api/admin/styles", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.json([]);
      }
      const presets = await storage.getStylePresetsByMerchant(merchant.id);
      // Enrich each DB record with hardcoded options/promptPlaceholder when the DB column is null
      // (styles seeded before the options column was added won't have these fields populated)
      const enriched = presets.map((s: any) => {
        const hardcoded = STYLE_PRESETS.find((h: any) => h.id === s.id.toString() || h.name === s.name);
        return {
          ...s,
          options: s.options ?? (hardcoded as any)?.options ?? null,
          promptPlaceholder: s.promptPlaceholder ?? (hardcoded as any)?.promptPlaceholder ?? null,
          baseImageUrl: s.baseImageUrl ?? (hardcoded as any)?.baseImageUrl ?? null,
          baseImageUrls: s.baseImageUrls ?? null,
        };
      });
      res.json(enriched);
    } catch (error) {
      console.error("Error fetching style presets:", error);
      res.status(500).json({ error: "Failed to fetch style presets" });
    }
  });

  // Create style preset
  app.post("/api/admin/styles", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const { name, promptPrefix, category, isActive, sortOrder, baseImageUrl, baseImageUrls, promptPlaceholder, descriptionOptional, options } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: "Style name is required" });
      }
      const preset = await storage.createStylePreset({
        merchantId: merchant.id,
        name,
        promptPrefix: promptPrefix || "",
        category: category || "all",
        isActive: isActive !== undefined ? isActive : true,
        sortOrder: sortOrder || 0,
        baseImageUrl: baseImageUrl || null,
        promptPlaceholder: promptPlaceholder || null,
        descriptionOptional: !!descriptionOptional,
        ...(options !== undefined ? { options: options || null } : {}),
        ...(baseImageUrls !== undefined ? { baseImageUrls: baseImageUrls || null } : {}),
      } as any);
      configCache.delete("global"); // invalidate so storefront picks up new style
      res.json(preset);
    } catch (error) {
      console.error("Error creating style preset:", error);
      res.status(500).json({ error: "Failed to create style preset" });
    }
  });

  // Update style preset
  app.patch("/api/admin/styles/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const presetId = parseInt(req.params.id);
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const preset = await storage.getStylePreset(presetId);
      if (!preset || preset.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Style preset not found" });
      }

      const { name, promptPrefix, category, isActive, sortOrder, baseImageUrl, baseImageUrls, promptPlaceholder, descriptionOptional, options } = req.body;
      
      const updated = await storage.updateStylePreset(presetId, {
        name: name !== undefined ? name : preset.name,
        promptPrefix: promptPrefix !== undefined ? promptPrefix : preset.promptPrefix,
        category: category !== undefined ? category : preset.category,
        isActive: isActive !== undefined ? isActive : preset.isActive,
        sortOrder: sortOrder !== undefined ? sortOrder : preset.sortOrder,
        baseImageUrl: baseImageUrl !== undefined ? (baseImageUrl || null) : (preset as any).baseImageUrl,
        promptPlaceholder: promptPlaceholder !== undefined ? (promptPlaceholder || null) : (preset as any).promptPlaceholder,
        descriptionOptional: descriptionOptional !== undefined ? !!descriptionOptional : !!(preset as any).descriptionOptional,
        ...(options !== undefined ? { options: options || null } : {}),
        ...(baseImageUrls !== undefined ? { baseImageUrls: baseImageUrls || null } : {}),
      } as any);

      configCache.delete("global"); // invalidate so storefront picks up new placeholder
      res.json(updated);
    } catch (error) {
      console.error("Error updating style preset:", error);
      res.status(500).json({ error: "Failed to update style preset" });
    }
  });

  // Delete style preset
  app.delete("/api/admin/styles/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const presetId = parseInt(req.params.id);
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const preset = await storage.getStylePreset(presetId);
      if (!preset || preset.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Style preset not found" });
      }

      await storage.deleteStylePreset(presetId);
      configCache.delete("global"); // invalidate so storefront no longer shows deleted style
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting style preset:", error);
      res.status(500).json({ error: "Failed to delete style preset" });
    }
  });


  // Seed default styles for merchant (on first admin load)
  app.post("/api/admin/styles/seed", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      // Check if merchant already has styles
      const existingStyles = await storage.getStylePresetsByMerchant(merchant.id);
      if (existingStyles.length > 0) {
        return res.json({ message: "Styles already seeded", styles: existingStyles });
      }

      // Seed default styles with their categories
      const defaultStyles = STYLE_PRESETS.map((style, index) => ({
        merchantId: merchant.id,
        name: style.name,
        promptPrefix: style.promptPrefix,
        category: style.category,
        isActive: true,
        sortOrder: index,
      }));

      const createdStyles = [];
      for (const style of defaultStyles) {
        const created = await storage.createStylePreset(style);
        createdStyles.push(created);
      }

      res.json({ message: "Default styles seeded", styles: createdStyles });
    } catch (error) {
      console.error("Error seeding styles:", error);
      res.status(500).json({ error: "Failed to seed styles" });
    }
  });

  // Reseed styles - update existing styles with proper categories and add missing ones
  app.post("/api/admin/styles/reseed", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const existingStyles = await storage.getStylePresetsByMerchant(merchant.id);
      const existingByName = new Map(existingStyles.map(s => [s.name, s]));
      
      const updatedStyles = [];
      const createdStyles = [];

      for (let i = 0; i < STYLE_PRESETS.length; i++) {
        const preset = STYLE_PRESETS[i];
        const existing = existingByName.get(preset.name);
        
        if (existing) {
          // Update existing style with correct category
          const updated = await storage.updateStylePreset(existing.id, {
            category: preset.category,
            promptPrefix: preset.promptPrefix,
            sortOrder: i,
          });
          if (updated) updatedStyles.push(updated);
        } else {
          // Create missing style
          const created = await storage.createStylePreset({
            merchantId: merchant.id,
            name: preset.name,
            promptPrefix: preset.promptPrefix,
            category: preset.category,
            isActive: true,
            sortOrder: i,
          });
          createdStyles.push(created);
        }
      }

      res.json({ 
        message: "Styles reseeded successfully",
        updated: updatedStyles.length,
        created: createdStyles.length,
        styles: [...updatedStyles, ...createdStyles]
      });
    } catch (error) {
      console.error("Error reseeding styles:", error);
      res.status(500).json({ error: "Failed to reseed styles" });
    }
  });

  // ==================== PRINTIFY CATALOG INTEGRATION ====================

  // Cache for provider location mappings (provider_id -> location data)
  const providerLocationCache = new Map<string, { location?: { country: string }, fulfillment_countries: string[] }>();
  
  // Cache for blueprint provider IDs (blueprint_id -> provider_ids[])
  const blueprintProviderCache = new Map<number, number[]>();
  
  // Track cache warm-up state
  let cacheWarmUpInProgress = false;
  let cacheLastWarmedAt: Date | null = null;
  
  // Endpoint to warm up Printify provider and blueprint caches
  // This runs in background when admin opens Printify tab
  app.post("/api/admin/printify/warm-cache", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant || !merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }
      
      // Return immediately if cache is already warm (within last 10 minutes)
      const cacheAge = cacheLastWarmedAt ? Date.now() - cacheLastWarmedAt.getTime() : Infinity;
      if (cacheAge < 10 * 60 * 1000 && providerLocationCache.size > 0 && blueprintProviderCache.size > 0) {
        return res.json({ 
          status: "ready",
          providers: providerLocationCache.size,
          blueprints: blueprintProviderCache.size
        });
      }
      
      // Return immediately if warm-up is already in progress
      if (cacheWarmUpInProgress) {
        return res.json({ status: "warming" });
      }
      
      // Start warming in background
      cacheWarmUpInProgress = true;
      res.json({ status: "warming" });
      
      // Background warm-up process
      (async () => {
        try {
          const pLimit = (await import('p-limit')).default;
          const limit = pLimit(5);
          
          // Step 1: Fetch all providers and their details
          const providersResponse = await fetch("https://api.printify.com/v1/catalog/print_providers.json", {
            headers: {
              "Authorization": `Bearer ${merchant.printifyApiToken}`,
              "Content-Type": "application/json"
            }
          });
          
          if (providersResponse.ok) {
            const allProviders = await providersResponse.json();
            
            await Promise.all(
              allProviders.map((provider: any) => 
                limit(async () => {
                  try {
                    const detailResponse = await fetchWithRetry(
                      `https://api.printify.com/v1/catalog/print_providers/${provider.id}.json`,
                      {
                        headers: {
                          "Authorization": `Bearer ${merchant.printifyApiToken}`,
                          "Content-Type": "application/json"
                        }
                      },
                      2,
                      2000
                    );
                    
                    if (detailResponse.ok) {
                      const details = await detailResponse.json();
                      providerLocationCache.set(String(provider.id), {
                        location: details.location,
                        fulfillment_countries: details.fulfillment_countries || [],
                      });
                    }
                  } catch (err) {
                    console.error(`Error caching provider ${provider.id}:`, err);
                  }
                })
              )
            );
          }
          
          // Step 2: Fetch all blueprints and their provider mappings
          const blueprintsResponse = await fetch("https://api.printify.com/v1/catalog/blueprints.json", {
            headers: {
              "Authorization": `Bearer ${merchant.printifyApiToken}`,
              "Content-Type": "application/json"
            }
          });
          
          if (blueprintsResponse.ok) {
            const allBlueprints = await blueprintsResponse.json();
            
            await Promise.all(
              allBlueprints.map((blueprint: any) =>
                limit(async () => {
                  try {
                    const provResponse = await fetchWithRetry(
                      `https://api.printify.com/v1/catalog/blueprints/${blueprint.id}/print_providers.json`,
                      {
                        headers: {
                          "Authorization": `Bearer ${merchant.printifyApiToken}`,
                          "Content-Type": "application/json"
                        }
                      },
                      2,
                      2000
                    );
                    
                    if (provResponse.ok) {
                      const providers = await provResponse.json();
                      blueprintProviderCache.set(blueprint.id, providers.map((p: any) => p.id));
                    }
                  } catch (err) {
                    console.error(`Error caching blueprint ${blueprint.id} providers:`, err);
                  }
                })
              )
            );
          }
          
          cacheLastWarmedAt = new Date();
          console.log(`Cache warm-up complete: ${providerLocationCache.size} providers, ${blueprintProviderCache.size} blueprints`);
        } catch (err) {
          console.error("Cache warm-up error:", err);
        } finally {
          cacheWarmUpInProgress = false;
        }
      })();
    } catch (error) {
      console.error("Error starting cache warm-up:", error);
      res.status(500).json({ error: "Failed to start cache warm-up" });
    }
  });
  
  // Check cache status
  app.get("/api/admin/printify/cache-status", isAuthenticated, async (req: any, res: Response) => {
    res.json({
      status: cacheWarmUpInProgress ? "warming" : (providerLocationCache.size > 0 ? "ready" : "cold"),
      providers: providerLocationCache.size,
      blueprints: blueprintProviderCache.size,
      lastWarmed: cacheLastWarmedAt?.toISOString() || null
    });
  });

  // Fetch all blueprints from Printify catalog with optional location filtering
  app.get("/api/admin/printify/blueprints", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const locationFilter = req.query.location as string | undefined;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant || !merchant.printifyApiToken) {
        return res.status(400).json({ 
          error: "Printify API token not configured",
          message: "Please add your Printify API token in Settings first"
        });
      }

      const response = await fetch("https://api.printify.com/v1/catalog/blueprints.json", {
        headers: {
          "Authorization": `Bearer ${merchant.printifyApiToken}`,
          "Content-Type": "application/json"
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          return res.status(401).json({ error: "Invalid Printify API token" });
        }
        throw new Error(`Printify API error: ${response.status}`);
      }

      let blueprints = await response.json();
      
      // If location filter provided, filter using cached data only (no API calls)
      if (locationFilter && locationFilter !== "all") {
        // Check if cache is ready
        if (blueprintProviderCache.size === 0 || providerLocationCache.size === 0) {
          // Cache not ready - return error asking to wait
          return res.status(202).json({
            error: "cache_not_ready",
            message: "Provider data is still loading. Please wait a moment.",
            cacheStatus: {
              providers: providerLocationCache.size,
              blueprints: blueprintProviderCache.size,
              warming: cacheWarmUpInProgress
            }
          });
        }
        
        // Filter blueprints locally using cached data (no API calls!)
        blueprints = blueprints.filter((blueprint: any) => {
          const providerIds = blueprintProviderCache.get(blueprint.id);
          if (!providerIds || providerIds.length === 0) return false;
          
          // Check if any provider matches the location filter
          return providerIds.some((providerId: number) => {
            const providerData = providerLocationCache.get(String(providerId));
            if (!providerData) return false;
            
            const locationCountry = providerData.location?.country || "";
            const fulfillmentCountries = providerData.fulfillment_countries || [];
            
            return locationCountry.includes(locationFilter) || 
                   fulfillmentCountries.some((c: string) => c.includes(locationFilter));
          });
        });
      }
      
      res.json(blueprints);
    } catch (error) {
      console.error("Error fetching Printify blueprints:", error);
      res.status(500).json({ error: "Failed to fetch Printify catalog" });
    }
  });

  // Batch fetch provider location data for multiple blueprints (for on-demand geo-filtering)
  app.post("/api/admin/printify/blueprints/batch-providers", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { blueprintIds } = req.body;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant || !merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      if (!Array.isArray(blueprintIds) || blueprintIds.length === 0) {
        return res.status(400).json({ error: "blueprintIds array is required" });
      }

      // Limit to 100 blueprints at a time to prevent abuse
      const idsToFetch = blueprintIds.slice(0, 100);
      
      const pLimit = (await import('p-limit')).default;
      const limit = pLimit(5); // Concurrency limit to avoid rate limits
      
      // Fetch provider lists for each blueprint
      const blueprintProviderMap: Record<number, number[]> = {};
      const providersToFetch = new Set<number>();
      
      await Promise.all(
        idsToFetch.map((blueprintId: number) =>
          limit(async () => {
            try {
              // Check cache first
              if (blueprintProviderCache.has(blueprintId)) {
                const providerIds = blueprintProviderCache.get(blueprintId)!;
                blueprintProviderMap[blueprintId] = providerIds;
                providerIds.forEach((id: number) => {
                  if (!providerLocationCache.has(String(id))) {
                    providersToFetch.add(id);
                  }
                });
                return;
              }
              
              const response = await fetchWithRetry(
                `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers.json`,
                {
                  headers: {
                    "Authorization": `Bearer ${merchant.printifyApiToken}`,
                    "Content-Type": "application/json"
                  }
                },
                2,
                1000
              );
              
              if (response.ok) {
                const providers = await response.json();
                const providerIds = providers.map((p: any) => p.id);
                blueprintProviderMap[blueprintId] = providerIds;
                blueprintProviderCache.set(blueprintId, providerIds);
                providerIds.forEach((id: number) => {
                  if (!providerLocationCache.has(String(id))) {
                    providersToFetch.add(id);
                  }
                });
              }
            } catch (err) {
              console.error(`Error fetching providers for blueprint ${blueprintId}:`, err);
            }
          })
        )
      );
      
      // Fetch location details for any providers not yet cached
      if (providersToFetch.size > 0) {
        await Promise.all(
          Array.from(providersToFetch).map((providerId) =>
            limit(async () => {
              try {
                const response = await fetchWithRetry(
                  `https://api.printify.com/v1/catalog/print_providers/${providerId}.json`,
                  {
                    headers: {
                      "Authorization": `Bearer ${merchant.printifyApiToken}`,
                      "Content-Type": "application/json"
                    }
                  },
                  2,
                  1000
                );
                
                if (response.ok) {
                  const details = await response.json();
                  providerLocationCache.set(String(providerId), {
                    location: details.location,
                    fulfillment_countries: details.fulfillment_countries || [],
                  });
                }
              } catch (err) {
                console.error(`Error fetching provider ${providerId} details:`, err);
              }
            })
          )
        );
      }
      
      // Build response with blueprint -> location data mapping
      const result: Record<number, { providerIds: number[]; locations: string[] }> = {};
      
      for (const [bpId, providerIds] of Object.entries(blueprintProviderMap)) {
        const locations = new Set<string>();
        
        for (const providerId of providerIds as number[]) {
          const providerData = providerLocationCache.get(String(providerId));
          if (providerData) {
            if (providerData.location?.country) {
              locations.add(providerData.location.country);
            }
            providerData.fulfillment_countries?.forEach((c: string) => locations.add(c));
          }
        }
        
        result[Number(bpId)] = {
          providerIds: providerIds as number[],
          locations: Array.from(locations)
        };
      }
      
      res.json(result);
    } catch (error) {
      console.error("Error batch fetching blueprint providers:", error);
      res.status(500).json({ error: "Failed to fetch provider data" });
    }
  });

  // Fetch specific blueprint details from Printify
  app.get("/api/admin/printify/blueprints/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const blueprintId = req.params.id;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant || !merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      const response = await fetch(`https://api.printify.com/v1/catalog/blueprints/${blueprintId}.json`, {
        headers: {
          "Authorization": `Bearer ${merchant.printifyApiToken}`,
          "Content-Type": "application/json"
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          return res.status(401).json({ error: "Invalid Printify API token" });
        }
        if (response.status === 404) {
          return res.status(404).json({ error: "Blueprint not found" });
        }
        throw new Error(`Printify API error: ${response.status}`);
      }

      const blueprint = await response.json();
      res.json(blueprint);
    } catch (error) {
      console.error("Error fetching Printify blueprint:", error);
      res.status(500).json({ error: "Failed to fetch blueprint details" });
    }
  });

  // Fetch print providers for a blueprint with enriched location data
  app.get("/api/admin/printify/blueprints/:id/providers", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const blueprintId = req.params.id;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant || !merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      // Fetch blueprint-specific providers
      const response = await fetch(`https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers.json`, {
        headers: {
          "Authorization": `Bearer ${merchant.printifyApiToken}`,
          "Content-Type": "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(`Printify API error: ${response.status}`);
      }

      const providers = await response.json();
      
      // Fetch detailed info for each provider to get location data
      const enrichedProviders = await Promise.all(
        providers.map(async (provider: any) => {
          try {
            const detailResponse = await fetch(
              `https://api.printify.com/v1/catalog/print_providers/${provider.id}.json`,
              {
                headers: {
                  "Authorization": `Bearer ${merchant.printifyApiToken}`,
                  "Content-Type": "application/json"
                }
              }
            );
            
            if (detailResponse.ok) {
              const details = await detailResponse.json();
              return {
                ...provider,
                location: details.location,
                fulfillment_countries: details.fulfillment_countries || [],
              };
            }
          } catch (err) {
            console.error(`Error fetching provider ${provider.id} details:`, err);
          }
          return provider;
        })
      );
      
      res.json(enrichedProviders);
    } catch (error) {
      console.error("Error fetching print providers:", error);
      res.status(500).json({ error: "Failed to fetch print providers" });
    }
  });

  // Fetch all print providers with location data for filtering
  app.get("/api/admin/printify/providers", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant || !merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      const response = await fetch("https://api.printify.com/v1/catalog/print_providers.json", {
        headers: {
          "Authorization": `Bearer ${merchant.printifyApiToken}`,
          "Content-Type": "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(`Printify API error: ${response.status}`);
      }

      const providers = await response.json();
      
      // Fetch detailed info for each provider to get location data
      const enrichedProviders = await Promise.all(
        providers.map(async (provider: any) => {
          try {
            const detailResponse = await fetch(
              `https://api.printify.com/v1/catalog/print_providers/${provider.id}.json`,
              {
                headers: {
                  "Authorization": `Bearer ${merchant.printifyApiToken}`,
                  "Content-Type": "application/json"
                }
              }
            );
            
            if (detailResponse.ok) {
              const details = await detailResponse.json();
              return {
                ...provider,
                location: details.location,
                fulfillment_countries: details.fulfillment_countries || [],
              };
            }
          } catch (err) {
            console.error(`Error fetching provider ${provider.id} details:`, err);
          }
          return provider;
        })
      );
      
      res.json(enrichedProviders);
    } catch (error) {
      console.error("Error fetching all print providers:", error);
      res.status(500).json({ error: "Failed to fetch print providers" });
    }
  });

  // Fetch variants for a blueprint from a specific provider
  app.get("/api/admin/printify/blueprints/:blueprintId/providers/:providerId/variants", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { blueprintId, providerId } = req.params;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant || !merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      const response = await fetch(
        `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json`,
        {
          headers: {
            "Authorization": `Bearer ${merchant.printifyApiToken}`,
            "Content-Type": "application/json"
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Printify API error: ${response.status}`);
      }

      const variants = await response.json();
      res.json(variants);
    } catch (error) {
      console.error("Error fetching variants:", error);
      res.status(500).json({ error: "Failed to fetch variants" });
    }
  });

  // Fetch parsed variant options (sizes/colors) for import wizard
  app.get("/api/admin/printify/blueprints/:blueprintId/variants", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { blueprintId } = req.params;
      const { providerId } = req.query;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant || !merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      // Get providers if no providerId specified
      let actualProviderId = providerId;
      if (!actualProviderId) {
        const providersResponse = await fetch(
          `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers.json`,
          {
            headers: {
              "Authorization": `Bearer ${merchant.printifyApiToken}`,
              "Content-Type": "application/json"
            }
          }
        );
        if (providersResponse.ok) {
          const providers = await providersResponse.json();
          if (providers && providers.length > 0) {
            actualProviderId = providers[0].id;
          }
        }
      }

      if (!actualProviderId) {
        return res.status(400).json({ error: "No provider available for this blueprint" });
      }

      const response = await fetch(
        `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers/${actualProviderId}/variants.json`,
        {
          headers: {
            "Authorization": `Bearer ${merchant.printifyApiToken}`,
            "Content-Type": "application/json"
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Printify API error: ${response.status}`);
      }

      const variantsData = await response.json();
      const variants = variantsData.variants || variantsData || [];
      
      // Parse variants to extract sizes and colors (simplified version of import logic)
      const sizesMap = new Map<string, { id: string; name: string; width: number; height: number }>();
      const colorsMap = new Map<string, { id: string; name: string; hex: string }>();
      
      const apparelSizes = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "XXL", "XXXL"];
      const apparelSizesLower = apparelSizes.map(s => s.toLowerCase());
      const namedSizes = ["small", "medium", "large", "extra large", "king", "queen", "twin", "full", "one size"];
      
      const looksLikeSize = (str: string): boolean => {
        const lower = str.toLowerCase().trim();
        if (lower.match(/^\d+[""']?\s*[xX×]\s*\d+[""']?$/)) return true;
        if (apparelSizesLower.includes(lower)) return true;
        if (namedSizes.includes(lower)) return true;
        if (lower.match(/^\d+\s*oz$/i)) return true;
        if (lower.match(/^iphone\s+(\d|x|xs|xr|se|pro|plus|max)/i)) return true;
        if (lower.match(/^galaxy\s+(s\d|a\d|note|z\s*(fold|flip)|ultra)/i)) return true;
        if (lower.match(/^pixel\s+(\d|fold|pro)/i)) return true;
        if (lower.match(/^(youth|kid'?s?|toddler|infant|baby)\s/i)) return true;
        return false;
      };
      
      for (const variant of variants) {
        const title = variant.title || "";
        const options = variant.options || {};
        
        const normalizedTitle = title
          .replace(/[″″‶‴]/g, '"')
          .replace(/[′′‵]/g, "'")
          .replace(/[""]/g, '"')
          .replace(/['']/g, "'");
        
        let extractedSizeId = "";
        
        // Try dimensional sizes
        const dimMatch = normalizedTitle.match(/(\d+)[""']?\s*[xX×]\s*(\d+)[""']?/);
        if (dimMatch) {
          const width = parseInt(dimMatch[1]);
          const height = parseInt(dimMatch[2]);
          extractedSizeId = `${width}x${height}`;
          const sizeName = `${width}" x ${height}"`;
          if (!sizesMap.has(extractedSizeId)) {
            sizesMap.set(extractedSizeId, { id: extractedSizeId, name: sizeName, width, height });
          }
        }
        
        // Check options for size
        if (!extractedSizeId && (options.size || options.Size)) {
          const sizeVal = options.size || options.Size;
          extractedSizeId = sizeVal.toLowerCase().replace(/\s+/g, '_');
          if (!sizesMap.has(extractedSizeId)) {
            sizesMap.set(extractedSizeId, { id: extractedSizeId, name: sizeVal, width: 0, height: 0 });
          }
        }
        
        // Try title parts
        // Use " / " (space-slash-space) split to preserve combined model names like "iPhone 12/12 Pro".
        // Fall back to "/" split only if no " / " separator exists.
        if (!extractedSizeId && title && (title.includes(" / ") || title.includes("/"))) {
          const hasSeparator = title.includes(" / ");
          const parts = hasSeparator
            ? title.split(" / ").map((p: string) => p.trim())
            : title.split("/").map((p: string) => p.trim());
          for (const part of parts) {
            const volumeMatch = part.match(/^(\d+)\s*oz$/i);
            if (volumeMatch) {
              extractedSizeId = `${volumeMatch[1]}oz`;
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: `${volumeMatch[1]}oz`, width: 0, height: 0 });
              }
              break;
            }
            if (apparelSizesLower.includes(part.toLowerCase())) {
              extractedSizeId = part.toLowerCase();
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: part, width: 0, height: 0 });
              }
              break;
            }
            // Named sizes (Small, Medium, Large, King, Queen, One Size, etc.)
            if (namedSizes.includes(part.toLowerCase())) {
              extractedSizeId = part.toLowerCase().replace(/\s+/g, '_');
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: part, width: 0, height: 0 });
              }
              break;
            }
            // Phone/device models (iPhone 14, Galaxy S23, Pixel 7, etc.)
            // Combined model names like "iPhone 12/12 Pro" are preserved as a single token
            // because we split on " / " above.
            if (part.match(/^iphone\s+(\d|x|xs|xr|se|pro|plus|max)/i) ||
                part.match(/^galaxy\s+(s\d|a\d|note|z\s*(fold|flip)|ultra)/i) ||
                part.match(/^pixel\s+(\d|fold|pro)/i) ||
                part.match(/^samsung\s+(galaxy|note)/i) ||
                part.match(/^oneplus\s+\d/i) ||
                part.match(/^for\s+(iphone|galaxy|pixel|samsung)/i)) {
              extractedSizeId = part.toLowerCase().replace(/\s+/g, '_');
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: part, width: 0, height: 0 });
              }
              break;
            }
          }
        }
        
        // Extract color
        let colorName = "";
        if (options.color || options.colour || options.Color || options.Colour || options.frame_color) {
          colorName = options.color || options.colour || options.Color || options.Colour || options.frame_color;
        } else if (title.includes(" / ") || title.includes("/")) {
          // Use " / " split to preserve combined model names like "iPhone 12/12 Pro"
          const _cParts = title.includes(" / ")
            ? title.split(" / ").map((p: string) => p.trim())
            : title.split("/").map((p: string) => p.trim());
          for (let i = _cParts.length - 1; i >= 0; i--) {
            if (!looksLikeSize(_cParts[i])) {
              colorName = _cParts[i];
              break;
            }
          }
        }
        
        if (colorName && !colorsMap.has(colorName.toLowerCase())) {
          const colorId = colorName.toLowerCase().replace(/\s+/g, '_');
          // Comprehensive color hex lookup - Printify API doesn't provide hex codes
          const colorHexMap: Record<string, string> = {
            // Basic colors
            "black": "#1a1a1a", "white": "#f5f5f5", "red": "#C41E3A", "blue": "#2563EB",
            "navy": "#1B2838", "green": "#22C55E", "yellow": "#FACC15", "orange": "#F97316",
            "pink": "#EC4899", "purple": "#A855F7", "gray": "#9E9E9E", "grey": "#9E9E9E",
            "brown": "#795548", "beige": "#F5F5DC", "cream": "#FFFDD0", "tan": "#D2B48C",
            // Solid prefix variants
            "solid black": "#1a1a1a", "solid white": "#f5f5f5", "solid red": "#C41E3A",
            "solid blue": "#2563EB", "solid navy": "#1B2838", "solid green": "#22C55E",
            // Heather variants
            "heather grey": "#9CA3AF", "heather gray": "#9CA3AF", "dark heather": "#4B5563",
            "heather navy": "#374151", "heather blue": "#60A5FA", "heather red": "#F87171",
            "heather forest": "#166534", "heather purple": "#A855F7", "heather orange": "#FB923C",
            // Common apparel colors
            "arctic white": "#F8FAFC", "jet black": "#0a0a0a", "charcoal": "#36454F",
            "burgundy": "#800020", "maroon": "#800000", "cardinal red": "#C41E3A",
            "fire red": "#FF3131", "scarlet": "#FF2400", "coral": "#FF7F50",
            "hot pink": "#FF69B4", "baby pink": "#F4C2C2", "light pink": "#FFB6C1",
            "magenta": "#FF00FF", "fuchsia": "#FF00FF", "rose": "#FF007F",
            "sky blue": "#87CEEB", "light blue": "#ADD8E6", "royal blue": "#4169E1",
            "navy blue": "#000080", "cobalt": "#0047AB", "steel blue": "#4682B4",
            "oxford navy": "#1C2541", "indigo": "#4B0082",
            "kelly green": "#4CBB17", "forest green": "#228B22", "military green": "#4B5320",
            "olive": "#808000", "sage": "#9DC183", "mint": "#98FF98", "lime": "#32CD32",
            "bottle green": "#006A4E", "dark green": "#006400", "emerald": "#50C878",
            "gold": "#FFD700", "mustard": "#FFDB58", "lemon": "#FFF44F",
            "light yellow": "#FFFFE0", "sun yellow": "#FFE81F", "canary": "#FFEF00",
            "orange crush": "#FF6600", "burnt orange": "#CC5500", "peach": "#FFCBA4",
            "rust": "#B7410E", "terracotta": "#E2725B", "pumpkin": "#FF7518",
            "lavender": "#E6E6FA", "violet": "#EE82EE", "plum": "#DDA0DD",
            "lilac": "#C8A2C8", "grape": "#6F2DA8", "eggplant": "#614051",
            "hot chocolate": "#4A2C2A", "chocolate": "#7B3F00", "coffee": "#6F4E37",
            "mocha": "#967969", "espresso": "#4E312D", "walnut": "#773F1A",
            "sand": "#C2B280", "khaki": "#C3B091", "taupe": "#483C32",
            "camel": "#C19A6B", "nude": "#E3BC9A", "champagne": "#F7E7CE",
            "silver": "#C0C0C0", "ash": "#B2BEB5", "slate": "#708090",
            "steel grey": "#71797E", "gunmetal": "#2A3439", "anthracite": "#293133",
            "teal": "#008080", "cyan": "#00FFFF", "aqua": "#00FFFF",
            "turquoise": "#40E0D0", "seafoam": "#93E9BE",
            "ivory": "#FFFFF0", "pearl": "#FDEEF4", "natural": "#FAF0E6",
            "oatmeal": "#D5C4A1", "ecru": "#C2B280",
            // Sport specific
            "athletic heather": "#B8B8B8", "sport grey": "#9E9E9E",
            "dark grey heather": "#4B4B4B", "ice grey": "#D3D3D3",
            "vintage black": "#2B2B2B", "vintage navy": "#2C3E50",
            "washed black": "#3D3D3D", "stonewash blue": "#5DADE2"
          };
          // Try exact match first, then try partial matches
          let hex = colorHexMap[colorName.toLowerCase()];
          if (!hex) {
            // Try to find a partial match (e.g., "Solid Cream" matches "cream")
            const lowerName = colorName.toLowerCase();
            for (const [key, value] of Object.entries(colorHexMap)) {
              if (lowerName.includes(key) || key.includes(lowerName)) {
                hex = value;
                break;
              }
            }
          }
          hex = hex || "#888888";
          colorsMap.set(colorName.toLowerCase(), { id: colorId, name: colorName, hex });
        }
      }

      res.json({
        sizes: Array.from(sizesMap.values()),
        colors: Array.from(colorsMap.values())
      });
    } catch (error) {
      console.error("Error fetching variant options:", error);
      res.status(500).json({ error: "Failed to fetch variant options" });
    }
  });

  // Update variant selection for a product type
  app.patch("/api/admin/product-types/:id/variants", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const productTypeId = parseInt(req.params.id);
      const { selectedSizeIds, selectedColorIds } = req.body;
      
      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const productType = await storage.getProductType(productTypeId);
      if (!productType) {
        return res.status(404).json({ error: "Product type not found" });
      }

      // Verify merchant ownership
      if (productType.merchantId && productType.merchantId !== merchant.id) {
        return res.status(403).json({ error: "Not authorized to modify this product" });
      }

      // Validate variant count
      const sizeCount = Array.isArray(selectedSizeIds) ? selectedSizeIds.length : 0;
      const colorCount = Array.isArray(selectedColorIds) ? selectedColorIds.length : 0;
      const totalVariants = sizeCount * (colorCount || 1);
      
      if (totalVariants > 100) {
        return res.status(400).json({ 
          error: "Too many variants",
          details: `Selected options would create ${totalVariants} variants. Maximum is 100.`
        });
      }

      const updated = await storage.updateProductType(productTypeId, {
        selectedSizeIds: JSON.stringify(selectedSizeIds || []),
        selectedColorIds: JSON.stringify(selectedColorIds || []),
      });

      res.json(updated);
    } catch (error) {
      console.error("Error updating variant selection:", error);
      res.status(500).json({ error: "Failed to update variant selection" });
    }
  });

  // Import a Printify blueprint as a product type
  app.post("/api/admin/printify/import", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { blueprintId, name, description, selectedSizeIds, selectedColorIds } = req.body;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      if (!merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      if (!blueprintId || !name) {
        return res.status(400).json({ error: "Blueprint ID and name are required" });
      }

      // Check if this blueprint is already imported
      const existingTypes = await storage.getProductTypes();
      const alreadyImported = existingTypes.find(pt => pt.printifyBlueprintId === parseInt(blueprintId));
      if (alreadyImported) {
        return res.status(400).json({ 
          error: "Blueprint already imported",
          existingProductType: alreadyImported
        });
      }

      // Fetch print providers for this blueprint with retry logic
      const providersResponse = await fetchWithRetry(
        `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers.json`,
        {
          headers: {
            "Authorization": `Bearer ${merchant.printifyApiToken}`,
            "Content-Type": "application/json"
          }
        },
        3,
        1500
      );

      if (!providersResponse.ok) {
        throw new Error(`Failed to fetch providers: ${providersResponse.status}`);
      }

      const providers = await providersResponse.json();
      if (!providers || providers.length === 0) {
        return res.status(400).json({ error: "No print providers available for this blueprint" });
      }

      // Use provided provider ID or default to first provider
      const providerId = req.body.providerId || providers[0].id;

      // Fetch blueprint details to get color hex codes from options
      const blueprintResponse = await fetchWithRetry(
        `https://api.printify.com/v1/catalog/blueprints/${blueprintId}.json`,
        {
          headers: {
            "Authorization": `Bearer ${merchant.printifyApiToken}`,
            "Content-Type": "application/json"
          }
        },
        3,
        1500
      );

      let blueprintColors: Record<string, string> = {}; // colorName -> hex
      let blueprintColorOptionName: string | null = null; // Actual option name from Printify (e.g. "Material", "Fabric", "Color")
      if (blueprintResponse.ok) {
        const blueprintData = await blueprintResponse.json();
        // Extract the non-size option from blueprint options
        // First try color-type options, then fall back to any non-size option
        const colorOptions = blueprintData.options?.find((opt: any) => 
          opt.type === 'color' || opt.name?.toLowerCase() === 'color' || opt.name?.toLowerCase() === 'colors'
        );
        if (!colorOptions) {
          // No explicit color option — look for any option that isn't "size"
          const nonSizeOption = (blueprintData.options || []).find((opt: any) => {
            const name = (opt.name || '').toLowerCase();
            return name !== 'size' && name !== 'sizes' && opt.type !== 'size';
          });
          if (nonSizeOption) {
            blueprintColorOptionName = nonSizeOption.name || null;
            console.log(`Blueprint non-size option found: "${blueprintColorOptionName}" (type: ${nonSizeOption.type})`);
            // Extract values from this option for hex mapping if available
            if (nonSizeOption.values) {
              for (const val of nonSizeOption.values) {
                const valName = (val.title || val.name || '').toLowerCase();
                if (val.colors && val.colors.length > 0) {
                  blueprintColors[valName] = val.colors[0];
                } else if (val.hex_code) {
                  blueprintColors[valName] = val.hex_code;
                } else if (val.value && val.value.startsWith('#')) {
                  blueprintColors[valName] = val.value;
                }
              }
            }
          }
        } else {
          blueprintColorOptionName = colorOptions.name || 'Color';
        }
        if (colorOptions?.values) {
          for (const colorVal of colorOptions.values) {
            const colorName = (colorVal.title || colorVal.name || '').toLowerCase();
            // Prefer colors array with hex, or hex_code field, or try to extract from value
            if (colorVal.colors && colorVal.colors.length > 0) {
              blueprintColors[colorName] = colorVal.colors[0];
            } else if (colorVal.hex_code) {
              blueprintColors[colorName] = colorVal.hex_code;
            } else if (colorVal.value && colorVal.value.startsWith('#')) {
              blueprintColors[colorName] = colorVal.value;
            }
          }
        }
        console.log(`Extracted ${Object.keys(blueprintColors).length} colors from blueprint options:`, Object.keys(blueprintColors).slice(0, 5).join(', '), '...');
      } else {
        console.log(`Blueprint options API - color extraction: no color options found or options missing`);
      }

      // Fetch variants for this provider with retry logic
      const variantsResponse = await fetchWithRetry(
        `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json`,
        {
          headers: {
            "Authorization": `Bearer ${merchant.printifyApiToken}`,
            "Content-Type": "application/json"
          }
        },
        3,
        1500
      );

      if (!variantsResponse.ok) {
        throw new Error(`Failed to fetch variants: ${variantsResponse.status}`);
      }

      const variantsData = await variantsResponse.json();
      const variants = variantsData.variants || variantsData || [];
      // Extract flat-lay SVG images from the `views` field of the variants response.
      // views[] contains { position, label, files[{ src, variant_ids }] } — one entry per
      // print panel position. We build a map of position → SVG URL for the Place on Item viewer.
      const panelFlatLayImages: Record<string, string> = {};
      const views: Array<{ id?: number; label?: string; position: string; files: Array<{ src: string; variant_ids?: number[] }> }> =
        variantsData.views || [];
      for (const view of views) {
        if (view.position && view.files && view.files.length > 0 && view.files[0].src) {
          panelFlatLayImages[view.position] = view.files[0].src;
        }
      }
      // Static fallback: hard-coded SVG IDs for known blueprints where the Printify API
      // returns an empty `views` array. SVGs are served from the Printify public CDN.
      // Identified by loading the Printify editor and intercepting network requests.
      const STATIC_FLAT_LAY_SVGS: Record<number, Record<string, string>> = {
              // Complete Printify panel SVG mapping (auto-generated from Printify catalog)
              // Women's Cut & Sew Racerback Dress
              276: {
                "back"                : "https://images.printify.com/api/catalog/59fc4d34b8e7e30175347441.svg",
                "front"               : "https://images.printify.com/api/catalog/59fc4d2bb8e7e301856c6fa9.svg",
              },
              // Unisex Cut & Sew Tee
              281: {
                "back"                : "https://images.printify.com/api/catalog/5a01d4b4b8e7e32813350528.svg",
                "front"               : "https://images.printify.com/api/catalog/5a01d4ceb8e7e3281f2da8e7.svg",
              },
              // Women's Pencil Skirt
              285: {
                "back"                : "https://images.printify.com/api/catalog/5a0ef125b8e7e307bc4e601c.svg",
                "front"               : "https://images.printify.com/api/catalog/5a0ef133b8e7e3087c7ebf08.svg",
              },
              // Unisex Sweatshirt
              449: {
                "back"                : "https://images.printify.com/api/catalog/5d9c87f418831d27426218b0.svg",
                "front"               : "https://images.printify.com/api/catalog/5d9b4bc1a54cf735a33aa246.svg",
                "left_sleeve"         : "https://images.printify.com/api/catalog/5d9b5255e577547f153b80dc.svg",
                "right_sleeve"        : "https://images.printify.com/api/catalog/5d9b35ebd41cb4389d15e043.svg",
              },
              // Unisex Pullover Hoodie
              450: {
                "back"                : "https://images.printify.com/api/catalog/5d971e0a2947a61bef6f40cd.svg",
                "front"               : "https://images.printify.com/api/catalog/5d96fefa40e8da18a2274ad9.svg",
                "left_sleeve"         : "https://images.printify.com/api/catalog/5d971d7ad69994742d3a03fb.svg",
                "right_sleeve"        : "https://images.printify.com/api/catalog/5d971dfcc4c83a05fc3a5492.svg",
              },
              // Unisex Zip Hoodie
              451: {
                "back"                : "https://images.printify.com/api/catalog/5d9ae61ccf4e077eb561b028.svg",
                "front_left"          : "https://images.printify.com/api/catalog/5d9c8b82c92a2a02ac3662dd.svg",
                "front_right"         : "https://images.printify.com/api/catalog/631b2116174f5066ca0759d4.svg",
                "left_cuff_panel"     : "https://images.printify.com/api/catalog/5d9ae385cf4e077eb561b01c.svg",
                "left_hood"           : "https://images.printify.com/api/catalog/5d9ae1fa4e699c71a202db06.svg",
                "left_sleeve"         : "https://images.printify.com/api/catalog/5d9ae1b44e699c71a202db03.svg",
                "pocket_left"         : "https://images.printify.com/api/catalog/5d9c8e67c92a2a02ac3662e0.svg",
                "pocket_right"        : "https://images.printify.com/api/catalog/5d9c8e76c92a2a02ac3662e3.svg",
                "right_cuff_panel"    : "https://images.printify.com/api/catalog/5d9c8335c92a2a02ac3662d4.svg",
                "right_hood"          : "https://images.printify.com/api/catalog/5d9ae1e932345a5ce56f1e1c.svg",
                "right_sleeve"        : "https://images.printify.com/api/catalog/5d9ae1d58bb77340c7729745.svg",
                "waistband"           : "https://images.printify.com/api/catalog/5d9b0eda32345a5ce56f1e37.svg",
              },
              // Crop Tee
              627: {
                "back"                : "https://images.printify.com/api/catalog/612e2dbdce911f74dc7fc430.svg",
                "front"               : "https://images.printify.com/api/catalog/61165b745cbffb455d742be8.svg",
              },
              // Women's Capri Leggings
              1050: {
                "left_leg"            : "https://images.printify.com/api/catalog/627268e348bb29a669061ca2.svg",
                "right_leg"           : "https://images.printify.com/api/catalog/627268d3ae9e71e7850a0ff1.svg",
              },
              // Tote Bag
              1389: {
                "front"               : "https://images.printify.com/api/catalog/6564848e6a2aafb6fe0ba0d3.svg",
              },
              // Men's Hawaiian Camp Shirt
              1533: {
                "back"                : "https://images.printify.com/api/catalog/66a21741405a59f9070d94c2.svg",
                "front_left"          : "https://images.printify.com/api/catalog/66a21c3817e48cae5b0ddbe2.svg",
                "front_right"         : "https://images.printify.com/api/catalog/66a21bb8f38ac84cd908f752.svg",
                "left_placket"        : "https://images.printify.com/api/catalog/69a6e89c7c21676d1f0bf552.svg",
                "right_placket"       : "https://images.printify.com/api/catalog/69a6e8695763f46f33003910.svg",
              },
              // Basketball Training Shorts
              1589: {
                "back_left_leg"       : "https://images.printify.com/api/catalog/66d70a472e7c84cf240029e6.svg",
                "back_right_leg"      : "https://images.printify.com/api/catalog/66d70a16650830a5b305c264.svg",
                "front_left_leg"      : "https://images.printify.com/api/catalog/66d709cd7438963da401ba55.svg",
                "front_right_leg"     : "https://images.printify.com/api/catalog/66d709486f43297fff0ce8a5.svg",
                "left_inner_pocket_back": "https://images.printify.com/api/catalog/66d70a44f835b084520c4364.svg",
                "left_inner_pocket_front": "https://images.printify.com/api/catalog/66d70a13febb2981ab02c692.svg",
                "right_inner_pocket_back": "https://images.printify.com/api/catalog/66d70a07c810c0506505ba93.svg",
                "right_inner_pocket_front": "https://images.printify.com/api/catalog/66d70a39619c41921c006035.svg",
              },
              // Unisex Polo Shirt
              1604: {
                "back"                : "https://images.printify.com/api/catalog/66e45967b94b48b3b80449f2.svg",
                "front"               : "https://images.printify.com/api/catalog/66e459529ec5cf39800ccb42.svg",
                "left_sleeve"         : "https://images.printify.com/api/catalog/66e4597bb94b48b3b80449f3.svg",
                "placket"             : "https://images.printify.com/api/catalog/66e459946fc58997a50cf387.svg",
                "right_sleeve"        : "https://images.printify.com/api/catalog/66e459726fc58997a50cf384.svg",
              },
              // Pixel Fleece Blanket
              1911: {
                "front"               : "https://images.printify.com/api/catalog/67b745ed32ecb119d80897c9.svg",
              },
            };
      if (Object.keys(panelFlatLayImages).length === 0) {
        const staticSvgs = STATIC_FLAT_LAY_SVGS[parseInt(blueprintId)];
        if (staticSvgs) {
          Object.assign(panelFlatLayImages, staticSvgs);
          console.log(`[Import] Using static flat-lay SVG mapping for blueprint ${blueprintId}: ${Object.keys(staticSvgs).join(", ")}`);
        }
      }
      console.log(`[Import] Extracted ${Object.keys(panelFlatLayImages).length} flat-lay images from views:`, Object.keys(panelFlatLayImages).join(", "));

      // Parse variants to extract sizes and colors
      // Sizes are purely catalog metadata - variant info goes in variantMap
      const sizesMap = new Map<string, { id: string; name: string; width: number; height: number }>();
      const colorsMap = new Map<string, { id: string; name: string; hex: string }>();
      // Map of "sizeId:colorId" -> printifyVariantId for accurate mockup generation
      const variantMap: Record<string, { printifyVariantId: number; providerId: number }> = {};
      let maxWidth = 0;
      let maxHeight = 0;
      
      // Track print area dimensions in pixels from Printify placeholders by position
      // These are used ONLY for aspect ratio calculation, not storage
      // Store per-position to handle multi-placement products correctly
      const placeholderDimensions: Record<string, { width: number; height: number }> = {};

      // Per-size placeholder dimensions: keyed by sizeId -> primary-position dims
      // Populated after extractedSizeId is known for each variant
      const placeholderDimensionsBySize: Record<string, { width: number; height: number }> = {};

      // Known size patterns for various product types
      const apparelSizes = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "XXL", "XXXL"];
      const apparelSizesLower = apparelSizes.map(s => s.toLowerCase());
      const namedSizes = ["small", "medium", "large", "extra large", "king", "queen", "twin", "full", "one size"];
      
      // Helper function to check if a string looks like a size (not a color)
      const looksLikeSize = (str: string): boolean => {
        const lower = str.toLowerCase().trim();
        // Dimensional (8x10, 12"x16")
        if (lower.match(/^\d+[""']?\s*[xX×]\s*\d+[""']?$/)) return true;
        // Apparel sizes (S, M, L, XL, 2XL)
        if (apparelSizesLower.includes(lower)) return true;
        // Named sizes (Small, Medium, Large, King, Queen)
        if (namedSizes.includes(lower)) return true;
        // Volume sizes (11oz, 15 oz)
        if (lower.match(/^\d+\s*oz$/i)) return true;
        // Device models - must have model identifier after brand
        // Don't match just "Galaxy" as it could be a color name like "Galaxy Blue"
        // iPhone: iPhone 14, iPhone X, iPhone XS, iPhone SE, iPhone Pro Max, etc.
        if (lower.match(/^iphone\s+(\d|x|xs|xr|se|pro|plus|max)/i)) return true;
        // Galaxy: Galaxy S23, Galaxy A54, Galaxy Note, Galaxy Z Fold/Flip, etc.
        if (lower.match(/^galaxy\s+(s\d|a\d|note|z\s*(fold|flip)|ultra)/i)) return true;
        // Pixel: Pixel 7, Pixel Fold, Pixel Pro, etc.
        if (lower.match(/^pixel\s+(\d|fold|pro)/i)) return true;
        // Samsung with model identifiers
        if (lower.match(/^samsung\s+(galaxy|note)/i)) return true;
        // OnePlus with model numbers
        if (lower.match(/^oneplus\s+\d/i)) return true;
        // Generic "for iPhone/Galaxy/etc" patterns often seen in case listings
        if (lower.match(/^for\s+(iphone|galaxy|pixel|samsung)/i)) return true;
        // Youth/Kids sizes
        if (lower.match(/^(youth|kid'?s?|toddler|infant|baby)\s/i)) return true;
        // Size with numbers (14x14, 50x60, etc for blankets/pillows)
        if (lower.match(/^\d+\s*["'']?\s*[xX×]\s*\d+/)) return true;
        return false;
      };
      
      for (const variant of variants) {
        const title = variant.title || "";
        const options = variant.options || {};
        
        // Extract print area dimensions from placeholders (if available)
        // Printify API returns placeholders[].width/height in pixels
        // Track dimensions per position (front, back, wrap, etc.) across all variants
        const placeholders = variant.placeholders || [];
        for (const placeholder of placeholders) {
          if (placeholder.width && placeholder.height) {
            const position = placeholder.position || "default";
            const existing = placeholderDimensions[position];
            // Keep the largest dimensions for each position across variants
            if (!existing || placeholder.width * placeholder.height > existing.width * existing.height) {
              placeholderDimensions[position] = { 
                width: placeholder.width, 
                height: placeholder.height 
              };
            }
          }
        }
        
        // Normalize Unicode quotes/primes to standard characters
        const normalizedTitle = title
          .replace(/[″″‶‴]/g, '"')
          .replace(/[′′‵]/g, "'")
          .replace(/[""]/g, '"')
          .replace(/['']/g, "'");
        
        // Track the extracted sizeId for this variant (used for variantMap)
        let extractedSizeId = "";
        
        // 1. Try dimensional sizes (8x10, 12"x16", etc.) for prints, pillows, blankets
        const dimMatch = normalizedTitle.match(/(\d+)[""']?\s*[xX×]\s*(\d+)[""']?/);
        if (dimMatch) {
          const width = parseInt(dimMatch[1]);
          const height = parseInt(dimMatch[2]);
          extractedSizeId = `${width}x${height}`;
          const sizeName = `${width}" x ${height}"`;
          
          // Sizes are purely catalog metadata - no variant-specific fields
          if (!sizesMap.has(extractedSizeId)) {
            sizesMap.set(extractedSizeId, { id: extractedSizeId, name: sizeName, width, height });
          }
          if (width > maxWidth) maxWidth = width;
          if (height > maxHeight) maxHeight = height;
        }
        
        // 2. Check options for size (normalize various key names)
        if (!extractedSizeId && (options.size || options.Size)) {
          const sizeVal = options.size || options.Size;
          extractedSizeId = sizeVal.toLowerCase().replace(/\s+/g, '_');
          if (!sizesMap.has(extractedSizeId)) {
            sizesMap.set(extractedSizeId, { id: extractedSizeId, name: sizeVal, width: 0, height: 0 });
          }
        }
        
        // 3. Try to extract from title for other patterns
        if (!extractedSizeId && title) {
          // Printify uses " / " (space-slash-space) as the separator between size and color/option.
          // Combined phone model names like "iPhone 12/12 Pro" use a bare "/" without spaces.
          // So splitting on " / " correctly preserves combined model names as a single token.
          // Fall back to "/" split only if no " / " separator exists (e.g. "8x10" alone).
          const hasSeparator = title.includes(" / ");
          const parts = hasSeparator
            ? title.split(" / ").map((p: string) => p.trim())
            : title.split("/").map((p: string) => p.trim());
          
          for (const part of parts) {
            // Check for volume sizes (11oz, 15oz for mugs)
            const volumeMatch = part.match(/^(\d+)\s*oz$/i);
            if (volumeMatch) {
              extractedSizeId = `${volumeMatch[1]}oz`;
              const sizeName = `${volumeMatch[1]}oz`;
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: sizeName, width: 0, height: 0 });
              }
              break;
            }
            
            // Check apparel sizes (S, M, L, XL, 2XL, etc.)
            if (apparelSizesLower.includes(part.toLowerCase())) {
              extractedSizeId = part.toLowerCase();
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: part, width: 0, height: 0 });
              }
              break;
            }
            
            // Check named sizes (Small, Medium, Large, King, Queen)
            if (namedSizes.includes(part.toLowerCase())) {
              extractedSizeId = part.toLowerCase().replace(/\s+/g, '_');
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: part, width: 0, height: 0 });
              }
              break;
            }
            
            // Check youth/kids sizes
            if (part.match(/^(youth|kid'?s?|toddler|infant|baby)\s/i)) {
              extractedSizeId = part.toLowerCase().replace(/\s+/g, '_').replace(/'/g, '');
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: part, width: 0, height: 0 });
              }
              break;
            }
            
            // Check device models (iPhone 14, Galaxy S23, etc. for phone cases)
            // Must have model identifier to avoid matching colors like "Galaxy Blue"
            if (part.match(/^iphone\s+(\d|x|xs|xr|se|pro|plus|max)/i) || 
                part.match(/^galaxy\s+(s\d|a\d|note|z\s*(fold|flip)|ultra)/i) || 
                part.match(/^pixel\s+(\d|fold|pro)/i) ||
                part.match(/^samsung\s+(galaxy|note)/i) ||
                part.match(/^oneplus\s+\d/i) ||
                part.match(/^for\s+(iphone|galaxy|pixel|samsung)/i)) {
              extractedSizeId = part.toLowerCase().replace(/\s+/g, '_');
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: part, width: 0, height: 0 });
              }
              break;
            }
          }
        }
        
        // 4. Fallback: If still no size and title has parts, use first non-color part
        if (!extractedSizeId && title && title.includes("/")) {
          const parts = title.split("/").map((p: string) => p.trim());
          // Take the first part as size if it's not obviously a color
          const firstPart = parts[0];
          if (firstPart && !firstPart.match(/^(black|white|red|blue|green|yellow|pink|purple|orange|gray|grey|navy|brown|beige|cream|tan)/i)) {
            extractedSizeId = firstPart.toLowerCase().replace(/\s+/g, '_');
            if (!sizesMap.has(extractedSizeId)) {
              sizesMap.set(extractedSizeId, { id: extractedSizeId, name: firstPart, width: 0, height: 0 });
            }
          }
        }

        // Track per-size placeholder dimensions now that extractedSizeId is known.
        // Use the same primary-position priority (front > default > first available).
        if (extractedSizeId) {
          const variantPlaceholders: Record<string, { width: number; height: number }> = {};
          for (const ph of (variant.placeholders || [])) {
            if (ph.width && ph.height) {
              const pos = ph.position || "default";
              const ex = variantPlaceholders[pos];
              if (!ex || ph.width * ph.height > ex.width * ex.height) {
                variantPlaceholders[pos] = { width: ph.width, height: ph.height };
              }
            }
          }
          const primaryDims =
            variantPlaceholders["front"] ||
            variantPlaceholders["default"] ||
            Object.values(variantPlaceholders)[0];
          if (primaryDims) {
            const existing = placeholderDimensionsBySize[extractedSizeId];
            // Keep the largest area seen for this size across variants
            if (!existing || primaryDims.width * primaryDims.height > existing.width * existing.height) {
              placeholderDimensionsBySize[extractedSizeId] = primaryDims;
            }
          }
        }

        // Try to extract color from title (after the "/" or from options)
        let colorName = "";
        // First check options object (normalize various color option names)
        if (options.color) {
          colorName = options.color;
        } else if (options.colour) {
          colorName = options.colour;
        } else if (options.frame_color) {
          colorName = options.frame_color;
        } else if (options.Color) {
          colorName = options.Color;
        } else if (options.Colour) {
          colorName = options.Colour;
        } else if (title.includes(" / ") || title.includes("/")) {
          // Use " / " (space-slash-space) split to preserve combined model names like "iPhone 12/12 Pro".
          // Fall back to "/" split only if no " / " separator exists.
          const _cParts = title.includes(" / ")
            ? title.split(" / ").map((p: string) => p.trim())
            : title.split("/").map((p: string) => p.trim());
          for (let i = _cParts.length - 1; i >= 0; i--) {
            if (looksLikeSize(_cParts[i])) continue;
            colorName = _cParts[i];
            break;
          }
        }

        // Extract color and track the extractedColorId for this variant
        let extractedColorId = "";
        if (colorName) {
          extractedColorId = colorName.toLowerCase().replace(/\s+/g, '_');
          
          if (!colorsMap.has(colorName.toLowerCase())) {
            // Map common color names to hex values (frames + apparel)
            // Normalize "Solid X" pattern by extracting base color name
            const baseColorName = colorName.toLowerCase()
              .replace(/^solid\s+/i, '')
              .replace(/^heather\s+/i, 'heather ')
              .trim();
            
            const colorHexMap: Record<string, string> = {
              // Basic colors
              "black": "#1a1a1a", "white": "#f5f5f5", "red": "#C41E3A", "blue": "#2563EB",
              "navy": "#1B2838", "green": "#22C55E", "yellow": "#FACC15", "orange": "#F97316",
              "pink": "#EC4899", "purple": "#A855F7", "gray": "#9E9E9E", "grey": "#9E9E9E",
              "brown": "#795548", "beige": "#F5F5DC", "cream": "#FFFDD0", "tan": "#D2B48C",
              // Frame colors
              "walnut": "#5D4037", "natural": "#D7CCC8", "gold": "#FFD700", "silver": "#C0C0C0",
              "oak": "#C4A35A", "cherry": "#9B2335", "mahogany": "#4E2728", "espresso": "#3C2415",
              // Heather variants
              "heather grey": "#9CA3AF", "heather gray": "#9CA3AF", "dark heather": "#4B5563",
              "heather navy": "#374151", "heather blue": "#60A5FA", "heather red": "#F87171",
              "heather forest": "#166534", "heather purple": "#A855F7", "heather orange": "#FB923C",
              // Common apparel colors
              "arctic white": "#F8FAFC", "jet black": "#0a0a0a", "charcoal": "#36454F",
              "burgundy": "#800020", "maroon": "#800000", "cardinal red": "#C41E3A",
              "fire red": "#FF3131", "scarlet": "#FF2400", "coral": "#FF7F50",
              "hot pink": "#FF69B4", "baby pink": "#F4C2C2", "light pink": "#FFB6C1",
              "magenta": "#FF00FF", "fuchsia": "#FF00FF", "rose": "#FF007F",
              "sky blue": "#87CEEB", "light blue": "#ADD8E6", "royal blue": "#4169E1",
              "royal": "#4169E1", "navy blue": "#000080", "cobalt": "#0047AB", "steel blue": "#4682B4",
              "oxford navy": "#1C2541", "indigo": "#4B0082", "midnight navy": "#191970",
              "cool blue": "#4A90D9", "tahiti blue": "#3AB09E",
              "kelly green": "#4CBB17", "forest green": "#228B22", "military green": "#4B5320",
              "olive": "#808000", "sage": "#9DC183", "mint": "#98FF98", "lime": "#32CD32",
              "bottle green": "#006A4E", "dark green": "#006400", "emerald": "#50C878",
              "mustard": "#FFDB58", "lemon": "#FFF44F", "banana cream": "#FFE9A1",
              "light yellow": "#FFFFE0", "sun yellow": "#FFE81F", "canary": "#FFEF00",
              "orange crush": "#FF6600", "burnt orange": "#CC5500", "peach": "#FFCBA4",
              "rust": "#B7410E", "terracotta": "#E2725B", "pumpkin": "#FF7518",
              "lavender": "#E6E6FA", "violet": "#EE82EE", "plum": "#DDA0DD",
              "lilac": "#C8A2C8", "grape": "#6F2DA8", "eggplant": "#614051", "purple rush": "#9B59B6",
              "hot chocolate": "#4A2C2A", "chocolate": "#7B3F00", "coffee": "#6F4E37",
              "mocha": "#967969", "dark chocolate": "#3D2314",
              "sand": "#C2B280", "khaki": "#C3B091", "taupe": "#483C32",
              "camel": "#C19A6B", "nude": "#E3BC9A", "champagne": "#F7E7CE", "desert pink": "#EDC9AF",
              "ash": "#B2BEB5", "slate": "#708090",
              "steel grey": "#71797E", "gunmetal": "#2A3439", "anthracite": "#293133",
              "light grey": "#D3D3D3", "light gray": "#D3D3D3", "heavy metal": "#3D3D3D",
              "teal": "#008080", "cyan": "#00FFFF", "aqua": "#00FFFF",
              "turquoise": "#40E0D0", "seafoam": "#93E9BE",
              "ivory": "#FFFFF0", "pearl": "#FDEEF4", "oatmeal": "#D5C4A1", "ecru": "#C2B280",
              // Sport specific
              "athletic heather": "#B8B8B8", "sport grey": "#9E9E9E",
              "dark grey heather": "#4B4B4B", "ice grey": "#D3D3D3",
              "vintage black": "#2B2B2B", "vintage navy": "#2C3E50",
              "washed black": "#3D3D3D", "stonewash blue": "#5DADE2"
            };
            
            // Priority: 1) Blueprint API colors, 2) Fallback hex map (normalized), 3) Fallback hex map (full name), 4) Gray default
            let hex = blueprintColors[colorName.toLowerCase()];
            let source = "blueprint";
            if (!hex) {
              hex = colorHexMap[baseColorName];
              source = "normalized";
            }
            if (!hex) {
              hex = colorHexMap[colorName.toLowerCase()];
              source = "full";
            }
            if (!hex) {
              hex = "#888888";
              source = "fallback";
              console.log(`Color not found in map: "${colorName}" (normalized: "${baseColorName}")`);
            }
            colorsMap.set(colorName.toLowerCase(), { 
              id: extractedColorId, 
              name: colorName, 
              hex 
            });
          }
        }

        // Store the size+color -> variant mapping for mockup generation
        // Use the extractedSizeId and extractedColorId captured during this iteration
        // Only add to variantMap if we have at least a size or color - no fallback keys
        if (extractedSizeId || extractedColorId) {
          const mapKey = `${extractedSizeId || 'default'}:${extractedColorId || 'default'}`;
          variantMap[mapKey] = { printifyVariantId: variant.id, providerId };
        } else {
          // Neither size nor color could be extracted - skip this variant for mockup generation
          // This ensures we never send the wrong variant to Printify
          console.warn(`Skipping variant for mockup mapping - could not extract size or color: ${title} (id: ${variant.id})`);
        }
      }

      // Convert maps to arrays
      let sizes = Array.from(sizesMap.values());
      const frameColors = Array.from(colorsMap.values());

      // Compute per-size aspect ratios from per-size placeholder dimensions collected above.
      // Helper uses the same thresholds as the product-level ratio calculation.
      const computeAspectRatioFromDims = (w: number, h: number): string => {
        const gcdFn = (a: number, b: number): number => b === 0 ? a : gcdFn(b, a % b);
        const divisor = gcdFn(w, h);
        const sw = w / divisor;
        const sh = h / divisor;
        if (sw <= 20 && sh <= 20) return `${sw}:${sh}`;
        const r = w / h;
        if (r >= 1.7) return "16:9";
        if (r >= 1.4) return "3:2";
        if (r >= 1.2) return "4:3";
        if (r >= 0.9) return "1:1";
        if (r >= 0.7) return "3:4";
        if (r >= 0.6) return "2:3";
        return "9:16";
      };
      sizes = sizes.map(s => {
        const dims = placeholderDimensionsBySize[s.id];
        if (dims) {
          const ar = computeAspectRatioFromDims(dims.width, dims.height);
          console.log(`[Import] Per-size aspect ratio: sizeId=${s.id} pxDims=${dims.width}x${dims.height} → ${ar}`);
          return { ...s, aspectRatio: ar };
        }
        return s;
      });

      // Fallback: If no sizes extracted, create from product name or use default
      // This handles single-variant products and products where size wasn't parseable
      if (sizes.length === 0) {
        // Try to extract size from product name (e.g., "Tumbler 20oz" -> "20oz")
        const sizeFromName = name.match(/(\d+\s*oz)/i);
        const defaultSizeId = sizeFromName ? sizeFromName[1].toLowerCase().replace(/\s+/g, '') : "default";
        const defaultSizeName = sizeFromName ? sizeFromName[1] : "One Size";
        sizes = [{ id: defaultSizeId, name: defaultSizeName, width: 0, height: 0 }];
        console.log(`[Import] Created fallback size "${defaultSizeName}" (id: ${defaultSizeId})`);

        // Update variantMap keys if we extracted a size from name
        if (defaultSizeId !== "default") {
          for (const key of Object.keys(variantMap)) {
            if (key.startsWith("default:")) {
              const colorId = key.slice(8); // "default:" is 8 chars
              const newKey = `${defaultSizeId}:${colorId}`;
              variantMap[newKey] = variantMap[key];
              delete variantMap[key];
            }
          }
        }

        // For single-variant products with no variantMap entries, create one
        if (Object.keys(variantMap).length === 0 && variants.length > 0) {
          const variantKey = `${defaultSizeId}:default`;
          variantMap[variantKey] = { printifyVariantId: variants[0].id, providerId };
          console.log(`[Import] Created fallback variantMap entry: ${variantKey}`);
        }
      }

      // Fetch base mockup images (placeholder images) from the first variant
      // This gives us product preview images before any design is applied
      let baseMockupImages: { front?: string; lifestyle?: string; variantImages?: Record<string, string> } = {};
      const firstVariant = variants[0];
      if (firstVariant?.id) {
        try {
          // Fetch variant placeholder images from Printify
          const placeholderResponse = await fetchWithRetry(
            `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants/${firstVariant.id}/placeholders.json`,
            {
              headers: {
                "Authorization": `Bearer ${merchant.printifyApiToken}`,
                "Content-Type": "application/json"
              }
            },
            2,
            1000
          );
          
          if (placeholderResponse.ok) {
            const placeholderData = await placeholderResponse.json();
            console.log(`Placeholder API response for blueprint ${blueprintId}, variant ${firstVariant.id}:`, JSON.stringify(placeholderData).slice(0, 500));
            
            const placeholders = placeholderData.placeholders || placeholderData || [];
            
            // Find front and lifestyle images
            for (const placeholder of placeholders) {
              const position = (placeholder.position || "").toLowerCase();
              const images = placeholder.images || [];
              
              if (images.length > 0) {
                const imgUrl = images[0].src || images[0].url;
                if (position === "front" || position.includes("front")) {
                  baseMockupImages.front = imgUrl;
                } else if (position === "lifestyle" || position.includes("lifestyle")) {
                  baseMockupImages.lifestyle = imgUrl;
                } else if (!baseMockupImages.front) {
                  // Use first available position as front if no explicit front
                  baseMockupImages.front = imgUrl;
                }
              }
            }
            console.log(`Fetched base mockup images for blueprint ${blueprintId}:`, Object.keys(baseMockupImages));
          } else {
            console.warn(`Placeholder API returned ${placeholderResponse.status} for blueprint ${blueprintId}`);
          }
        } catch (e) {
          console.warn("Could not fetch base mockup placeholders:", e);
        }
      }

      // Detect product type FIRST to determine sizeType
      // This is more reliable than checking dimensions since some dimensional products
      // may not have dimensions in the variant data
      const lowerName = name.toLowerCase();
      const lowerDesc = (description || "").toLowerCase();
      const combined = `${lowerName} ${lowerDesc}`;
      
      // Helper function for word boundary matching (prevents "bra" matching "bracelet")
      const matchesWord = (text: string, word: string): boolean => {
        const regex = new RegExp(`\\b${word}\\b`, 'i');
        return regex.test(text);
      };
      
      // Apparel-like products use label sizes (S/M/L/XL)
      const apparelKeywords = [
        "shirt", "t-shirt", "tshirt", "hoodie", "sweatshirt", "tank top",
        "tee", "apparel", "jersey", "jacket", "leggings", "shorts", 
        "dress", "skirt", "polo", "onesie", "bodysuit", "sweater", 
        "pants", "joggers", "romper", "blouse", "cardigan", "vest", 
        "coat", "bikini", "swimsuit", "underwear", "boxers", "briefs", 
        "socks", "apron", "scrubs"
      ];
      const isApparelProduct = apparelKeywords.some(kw => matchesWord(combined, kw));
      
      // Known dimensional products that may not have dimension data in variants
      const dimensionalKeywords = [
        "pillow", "cushion", "blanket", "throw", "mug", "cup", "tumbler",
        "poster", "print", "canvas", "frame", "artwork", "wall art",
        "phone case", "iphone", "samsung", "bag", "tote", "backpack", 
        "towel", "mat", "rug", "coaster", "mousepad", "sticker", "magnet",
        "puzzle", "ornament", "clock"
      ];
      const isDimensionalProduct = dimensionalKeywords.some(kw => matchesWord(combined, kw));
      
      // Check if we have dimensional sizes as backup
      const hasDimensionalSizes = sizes.some(s => s.width > 0 && s.height > 0);
      
      // Determine sizeType:
      // 1. Apparel always uses labels
      // 2. Known dimensional products use dimensional (even without parsed dimensions)
      // 3. Products with parsed dimensions use dimensional
      // 4. Unknown products without dimensions default to label
      let sizeType: string;
      if (isApparelProduct) {
        sizeType = "label";
      } else if (isDimensionalProduct || hasDimensionalSizes) {
        sizeType = "dimensional";
      } else {
        sizeType = "label";
      }

      // Determine aspect ratio using GCD for accurate ratio
      const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
      
      // Get primary placeholder dimensions - prefer "front", then "default", then first available
      const primaryPosition = placeholderDimensions["front"] || 
                              placeholderDimensions["default"] || 
                              Object.values(placeholderDimensions)[0];
      const printAreaWidthPx = primaryPosition?.width || 0;
      const printAreaHeightPx = primaryPosition?.height || 0;
      
      // Detect phone cases for special aspect ratio handling
      const isPhoneCase = combined.includes("phone") || combined.includes("iphone") || 
                          combined.includes("samsung") || combined.includes("case");
      
      // Start with product-type-appropriate defaults
      let aspectRatio: string;
      if (isApparelProduct) {
        // Apparel print areas are typically portrait ~2:3
        aspectRatio = "2:3";
      } else if (isPhoneCase) {
        // Phone cases are tall portrait ~9:16
        aspectRatio = "9:16";
      } else {
        // Default for other products
        aspectRatio = "3:4";
      }
      
      // PRIORITY 1: Use print area pixel dimensions from Printify placeholders (most accurate)
      // This handles wrap-around products like tumblers correctly
      if (printAreaWidthPx > 0 && printAreaHeightPx > 0) {
        const w = printAreaWidthPx;
        const h = printAreaHeightPx;
        const divisor = gcd(w, h);
        const simplifiedW = w / divisor;
        const simplifiedH = h / divisor;
        // Limit simplification to reasonable ratios (avoid things like 2795:2100)
        if (simplifiedW <= 20 && simplifiedH <= 20) {
          aspectRatio = `${simplifiedW}:${simplifiedH}`;
        } else {
          // For complex ratios, approximate to common aspect ratios
          const ratio = w / h;
          if (ratio >= 1.7) aspectRatio = "16:9";
          else if (ratio >= 1.4) aspectRatio = "3:2";
          else if (ratio >= 1.2) aspectRatio = "4:3";
          else if (ratio >= 0.9) aspectRatio = "1:1";
          else if (ratio >= 0.7) aspectRatio = "3:4";
          else if (ratio >= 0.6) aspectRatio = "2:3";
          else aspectRatio = "9:16";
        }
      }
      // PRIORITY 2: Override with calculated dimensions from size names if no placeholder data
      else if (hasDimensionalSizes && sizes.length > 0) {
        const firstDimensionalSize = sizes.find(s => s.width > 0 && s.height > 0);
        if (firstDimensionalSize) {
          const w = firstDimensionalSize.width;
          const h = firstDimensionalSize.height;
          const divisor = gcd(w, h);
          const simplifiedW = w / divisor;
          const simplifiedH = h / divisor;
          aspectRatio = `${simplifiedW}:${simplifiedH}`;
        }
      }

      // Product type detection for designer type, shape, and bleed margin
      // IMPORTANT: Check apparel FIRST because descriptions often contain "print" (e.g. "print surface")
      // which would incorrectly match framed-print if checked first
      
      let designerType: string = "generic";
      let printShape: string = "rectangle";
      let bleedMarginPercent = 5;
      
      // Detect apparel FIRST (before framed-print check)
      if (isApparelProduct) {
        designerType = "apparel";
        printShape = "rectangle";
        bleedMarginPercent = 5;
      }
      // Detect pillows
      else if (combined.includes("pillow") || combined.includes("cushion")) {
        designerType = "pillow";
        if (combined.includes("round") || combined.includes("circle") || combined.includes("circular")) {
          printShape = "circle";
          bleedMarginPercent = 8;
        } else if (maxWidth === maxHeight && maxWidth > 0) {
          printShape = "square";
          bleedMarginPercent = 5;
        } else {
          printShape = "rectangle";
          bleedMarginPercent = 5;
        }
      }
      // Detect blankets
      else if (combined.includes("blanket") || combined.includes("throw")) {
        designerType = "pillow";
        printShape = "rectangle";
        bleedMarginPercent = 5;
      }
      // Detect mugs
      else if (combined.includes("mug") || combined.includes("cup") || combined.includes("tumbler")) {
        designerType = "mug";
        printShape = "rectangle";
        bleedMarginPercent = 3;
      }
      // Detect framed prints AFTER apparel (to avoid false positives from "print surface" in descriptions)
      else if (combined.includes("frame") || combined.includes("poster") || combined.includes("canvas") || 
               matchesWord(combined, "print") || combined.includes("wall art")) {
        designerType = "framed-print";
        printShape = "rectangle";
        bleedMarginPercent = 3;
      }
      // Detect round products
      else if (combined.includes("round") || combined.includes("circle") || combined.includes("coaster")) {
        printShape = "circle";
        bleedMarginPercent = 8;
      }

      // Detect double-sided print from description (decode HTML entities first)
      const decodedCombined = combined
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
        .replace(/<[^>]*>/g, ' ') // Strip HTML tags
        .toLowerCase();
      const hasBackPlaceholder = !!placeholderDimensions["back"];
      // Apparel (t-shirts, hoodies, etc.) always defaults to front-only print.
      // Having a "back" placeholder does NOT mean we should print on the back by default.
      // Only non-apparel products (pillows, tote bags, etc.) should be auto-flagged as double-sided.
      const doubleSidedPrint = designerType !== "apparel" && (
        hasBackPlaceholder ||
        decodedCombined.includes("double sided") ||
        decodedCombined.includes("double-sided") ||
        decodedCombined.includes("two sided") ||
        decodedCombined.includes("two-sided") ||
        decodedCombined.includes("both sides")
      );

      // Detect All-Over-Print (AOP) products: leggings, swimwear, all-over tees, etc.
      // AOP products have multiple distinct print panels beyond just front/back.
      const AOP_POSITION_NAMES = new Set([
        "left_leg", "right_leg", "gusset",
        "front_waistband", "back_waistband",
        "left_panel", "right_panel",
        "left_sleeve", "right_sleeve",
        "left_side", "right_side",
        "all_over", "full_body",
      ]);
      const positionKeys = Object.keys(placeholderDimensions);
      const hasAOPPositions = positionKeys.some(p => AOP_POSITION_NAMES.has(p));
      // Also flag as AOP if there are 2+ positions and none of them are the standard front/back pair
      const isStandardFrontBack = positionKeys.length <= 2 &&
        positionKeys.every(p => p === "front" || p === "back" || p === "default");
      const isAllOverPrint = hasAOPPositions || (positionKeys.length >= 2 && !isStandardFrontBack);

      // Build the persisted placeholder positions list (all positions with their dimensions)
      const placeholderPositions = positionKeys.map(pos => ({
        position: pos,
        width: placeholderDimensions[pos].width,
        height: placeholderDimensions[pos].height,
      }));

      // Create the product type with parsed data
      const productType = await storage.createProductType({
        merchantId: merchant.id,
        name,
        description: description || null,
        printifyBlueprintId: parseInt(blueprintId),
        printifyProviderId: providerId,
        sizes: JSON.stringify(sizes),
        frameColors: JSON.stringify(frameColors),
        variantMap: JSON.stringify(variantMap),
        selectedSizeIds: JSON.stringify(selectedSizeIds || sizes.map((s: { id: string }) => s.id)),
        selectedColorIds: JSON.stringify(selectedColorIds || frameColors.map((c: { id: string }) => c.id)),
        aspectRatio,
        printShape,
        // Store only physical dimensions (inches) for unit consistency
        // Pixel dimensions are used only for aspect ratio calculation above
        printAreaWidth: maxWidth || null,
        printAreaHeight: maxHeight || null,
        bleedMarginPercent,
        designerType,
        sizeType,
        hasPrintifyMockups: true,
        baseMockupImages: JSON.stringify(baseMockupImages),
        primaryMockupIndex: 0,
        doubleSidedPrint,
        isAllOverPrint,
        placeholderPositions: JSON.stringify(placeholderPositions),
        panelFlatLayImages: JSON.stringify(panelFlatLayImages),
        colorOptionName: blueprintColorOptionName,
        isActive: true,
        sortOrder: existingTypes.length,
      });

      res.json(productType);
    } catch (error) {
      console.error("Error importing Printify blueprint:", error);
      res.status(500).json({ error: "Failed to import blueprint" });
    }
  });

  // DELETE /api/admin/product-types/:id - Delete a product type
  app.delete("/api/admin/product-types/:id", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const productTypeId = parseInt(req.params.id);

      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const productType = await storage.getProductType(productTypeId);
      if (!productType || productType.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Product type not found" });
      }

      await storage.deleteProductType(productTypeId);
      res.json({ success: true, message: "Product type deleted" });
    } catch (error) {
      console.error("Error deleting product type:", error);
      res.status(500).json({ error: "Failed to delete product type" });
    }
  });

  // POST /api/admin/product-types/:id/refresh-images - Refresh product images from Printify
  app.post("/api/admin/product-types/:id/refresh-images", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const productTypeId = parseInt(req.params.id);

      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      if (!merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      const productType = await storage.getProductType(productTypeId);
      if (!productType || productType.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Product type not found" });
      }

      if (!productType.printifyBlueprintId || !productType.printifyProviderId) {
        return res.status(400).json({ error: "Product type is not linked to Printify" });
      }

      // Helper to extract URL from image entry (handles both string and object formats)
      const extractImageUrl = (img: any): string | undefined => {
        if (typeof img === 'string') return img;
        if (img && typeof img === 'object') return img.src || img.url;
        return undefined;
      };

      let baseMockupImages: { front?: string; lifestyle?: string } = {};

      // First, fetch blueprint details which contains product images
      const blueprintResponse = await fetch(
        `https://api.printify.com/v1/catalog/blueprints/${productType.printifyBlueprintId}.json`,
        {
          headers: {
            "Authorization": `Bearer ${merchant.printifyApiToken}`,
            "Content-Type": "application/json"
          }
        }
      );

      if (blueprintResponse.ok) {
        const blueprintData = await blueprintResponse.json();
        const images = blueprintData.images || [];
        
        // Blueprint images are product mockups - use first as front, second as lifestyle if available
        if (images.length > 0) {
          baseMockupImages.front = extractImageUrl(images[0]);
        }
        if (images.length > 1) {
          baseMockupImages.lifestyle = extractImageUrl(images[1]);
        }
      }

      // If no images from blueprint, try print provider specific endpoint
      if (!baseMockupImages.front) {
        const providerResponse = await fetch(
          `https://api.printify.com/v1/catalog/blueprints/${productType.printifyBlueprintId}/print_providers/${productType.printifyProviderId}.json`,
          {
            headers: {
              "Authorization": `Bearer ${merchant.printifyApiToken}`,
              "Content-Type": "application/json"
            }
          }
        );

        if (providerResponse.ok) {
          const providerData = await providerResponse.json();
          // Provider data may have location-specific images
          if (providerData.image) {
            baseMockupImages.front = extractImageUrl(providerData.image);
          }
        }
      }

      // Also fetch placeholder data for print-area/safe-zone information
      const variantsResponse = await fetch(
        `https://api.printify.com/v1/catalog/blueprints/${productType.printifyBlueprintId}/print_providers/${productType.printifyProviderId}/variants.json`,
        {
          headers: {
            "Authorization": `Bearer ${merchant.printifyApiToken}`,
            "Content-Type": "application/json"
          }
        }
      );

      if (variantsResponse.ok) {
        const variantsData = await variantsResponse.json();
        const variants = variantsData.variants || [];
        
        if (variants.length > 0) {
          const firstVariant = variants[0];
          const variantId = firstVariant.variant_id || firstVariant.id;
          
          if (variantId) {
            const placeholderResponse = await fetch(
              `https://api.printify.com/v1/catalog/blueprints/${productType.printifyBlueprintId}/print_providers/${productType.printifyProviderId}/variants/${variantId}/placeholders.json`,
              {
                headers: {
                  "Authorization": `Bearer ${merchant.printifyApiToken}`,
                  "Content-Type": "application/json"
                }
              }
            );

            if (placeholderResponse.ok) {
              const placeholderData = await placeholderResponse.json();
              const placeholders = placeholderData.placeholders || [];
              
              // Fallback: If no images from blueprint/provider, try to extract from placeholder images
              if (!baseMockupImages.front || !baseMockupImages.lifestyle) {
                for (const placeholder of placeholders) {
                  const position = placeholder.position?.toLowerCase() || "";
                  const images = placeholder.images || [];
                  
                  if (images.length > 0) {
                    const imgUrl = extractImageUrl(images[0]);
                    if (imgUrl) {
                      if (!baseMockupImages.front && (position === "front" || position.includes("front"))) {
                        baseMockupImages.front = imgUrl;
                      } else if (!baseMockupImages.lifestyle && (position === "lifestyle" || position.includes("lifestyle"))) {
                        baseMockupImages.lifestyle = imgUrl;
                      } else if (!baseMockupImages.front) {
                        // Use first available image as front if no specific position match yet
                        baseMockupImages.front = imgUrl;
                      } else if (!baseMockupImages.lifestyle) {
                        // Use subsequent image as lifestyle if front is already set
                        baseMockupImages.lifestyle = imgUrl;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      // Check if we found any images
      if (!baseMockupImages.front && !baseMockupImages.lifestyle) {
        return res.status(400).json({ 
          error: "No product images available from Printify for this blueprint",
          hint: "This product type may not have catalog images. You can add a custom mockup template URL instead."
        });
      }

      // Update the product type with new images
      const updated = await storage.updateProductType(productTypeId, {
        baseMockupImages: JSON.stringify(baseMockupImages)
      });

      res.json({ 
        success: true, 
        baseMockupImages,
        productType: updated 
      });
    } catch (error) {
      console.error("Error refreshing product images:", error);
      res.status(500).json({ error: "Failed to refresh images" });
    }
  });

  // POST /api/admin/product-types/:id/refresh-variants - Re-fetch sizes and colors from Printify
  // This re-runs the variant parsing logic to fix products with missing sizes/colors
  app.post("/api/admin/product-types/:id/refresh-variants", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const productTypeId = parseInt(req.params.id);

      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      if (!merchant.printifyApiToken) {
        return res.status(400).json({ error: "Printify API token not configured" });
      }

      const productType = await storage.getProductType(productTypeId);
      if (!productType || productType.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Product type not found" });
      }

      if (!productType.printifyBlueprintId || !productType.printifyProviderId) {
        return res.status(400).json({ error: "Product type not linked to Printify blueprint" });
      }

      const blueprintId = productType.printifyBlueprintId;
      const providerId = productType.printifyProviderId;

      // Fetch variants from Printify
      const variantsResponse = await fetchWithRetry(
        `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json`,
        {
          headers: {
            "Authorization": `Bearer ${merchant.printifyApiToken}`,
            "Content-Type": "application/json"
          }
        },
        3,
        1500
      );

      if (!variantsResponse.ok) {
        throw new Error(`Failed to fetch variants: ${variantsResponse.status}`);
      }

      const variantsData = await variantsResponse.json();
      const variants = variantsData.variants || variantsData || [];

      // Log first few variants to debug
      console.log(`[Refresh Variants] Blueprint ${blueprintId} returned ${variants.length} variants`);
      if (variants.length > 0) {
        console.log(`[Refresh Variants] Sample variant:`, JSON.stringify(variants[0]).slice(0, 500));
        console.log(`[Refresh Variants] First 5 variant titles:`, variants.slice(0, 5).map((v: any) => v.title));
      }

      // Parse variants to extract sizes and colors (same logic as import)
      const sizesMap = new Map<string, { id: string; name: string; width: number; height: number }>();
      const colorsMap = new Map<string, { id: string; name: string; hex: string }>();
      const variantMap: Record<string, { printifyVariantId: number; providerId: number }> = {};

      // Known size patterns
      const apparelSizes = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "XXL", "XXXL"];
      const apparelSizesLower = apparelSizes.map(s => s.toLowerCase());
      const namedSizes = ["small", "medium", "large", "extra large", "king", "queen", "twin", "full", "one size"];

      const looksLikeSize = (str: string): boolean => {
        const lower = str.toLowerCase().trim();
        if (lower.match(/^\d+[""']?\s*[xX×]\s*\d+[""']?$/)) return true;
        if (apparelSizesLower.includes(lower)) return true;
        if (namedSizes.includes(lower)) return true;
        if (lower.match(/^\d+\s*oz$/i)) return true;
        // Phone/device models
        if (lower.match(/^iphone\s+(\d|x|xs|xr|se|pro|plus|max)/i)) return true;
        if (lower.match(/^galaxy\s+(s\d|a\d|note|z\s*(fold|flip)|ultra)/i)) return true;
        if (lower.match(/^pixel\s+(\d|fold|pro)/i)) return true;
        if (lower.match(/^samsung\s+(galaxy|note)/i)) return true;
        if (lower.match(/^oneplus\s+\d/i)) return true;
        if (lower.match(/^for\s+(iphone|galaxy|pixel|samsung)/i)) return true;
        return false;
      };

      // Color hex lookup map
      const colorHexMap: Record<string, string> = {
        "black": "#1a1a1a", "white": "#f5f5f5", "red": "#C41E3A", "blue": "#2563EB",
        "navy": "#1B2838", "green": "#22C55E", "yellow": "#FACC15", "orange": "#F97316",
        "pink": "#EC4899", "purple": "#A855F7", "gray": "#9E9E9E", "grey": "#9E9E9E",
        "brown": "#795548", "beige": "#F5F5DC", "cream": "#FFFDD0", "tan": "#D2B48C",
        "gold": "#FFD700", "silver": "#C0C0C0", "forest": "#228B22", "maroon": "#800000",
        "coral": "#FF7F50", "teal": "#008080", "aqua": "#00FFFF", "mint": "#98FF98",
        "lavender": "#E6E6FA", "peach": "#FFCBA4", "olive": "#808000", "charcoal": "#36454F",
      };

      for (const variant of variants) {
        const title = variant.title || "";
        const options = variant.options || {};

        const normalizedTitle = title
          .replace(/[″″‶‴]/g, '"')
          .replace(/[′′‵]/g, "'")
          .replace(/[""]/g, '"')
          .replace(/['']/g, "'");

        let extractedSizeId = "";

        // Try dimensional sizes
        const dimMatch = normalizedTitle.match(/(\d+)[""']?\s*[xX×]\s*(\d+)[""']?/);
        if (dimMatch) {
          const width = parseInt(dimMatch[1]);
          const height = parseInt(dimMatch[2]);
          extractedSizeId = `${width}x${height}`;
          const sizeName = `${width}" x ${height}"`;
          if (!sizesMap.has(extractedSizeId)) {
            sizesMap.set(extractedSizeId, { id: extractedSizeId, name: sizeName, width, height });
          }
        }

        // Check options for size
        if (!extractedSizeId && (options.size || options.Size)) {
          const sizeVal = options.size || options.Size;
          extractedSizeId = sizeVal.toLowerCase().replace(/\s+/g, '_');
          if (!sizesMap.has(extractedSizeId)) {
            sizesMap.set(extractedSizeId, { id: extractedSizeId, name: sizeVal, width: 0, height: 0 });
          }
        }

        // Extract from title patterns
        if (!extractedSizeId && title) {
          // Printify uses " / " (space-slash-space) as the separator between size and color/option.
          // Combined phone model names like "iPhone 12/12 Pro" use a bare "/" without spaces.
          // Splitting on " / " correctly preserves combined model names as a single token.
          const hasSeparator = title.includes(" / ");
          const parts = hasSeparator
            ? title.split(" / ").map((p: string) => p.trim())
            : title.split("/").map((p: string) => p.trim());
          for (const part of parts) {
            const volumeMatch = part.match(/^(\d+)\s*oz$/i);
            if (volumeMatch) {
              extractedSizeId = `${volumeMatch[1]}oz`;
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: `${volumeMatch[1]}oz`, width: 0, height: 0 });
              }
              break;
            }
            if (apparelSizesLower.includes(part.toLowerCase())) {
              extractedSizeId = part.toLowerCase();
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: part, width: 0, height: 0 });
              }
              break;
            }
            // Named sizes (Small, Medium, Large, King, Queen, One Size, etc.)
            if (namedSizes.includes(part.toLowerCase())) {
              extractedSizeId = part.toLowerCase().replace(/\s+/g, '_');
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: part, width: 0, height: 0 });
              }
              break;
            }
            // Phone/device models (iPhone 14, Galaxy S23, Pixel 7, etc.)
            if (part.match(/^iphone\s+(\d|x|xs|xr|se|pro|plus|max)/i) ||
                part.match(/^galaxy\s+(s\d|a\d|note|z\s*(fold|flip)|ultra)/i) ||
                part.match(/^pixel\s+(\d|fold|pro)/i) ||
                part.match(/^samsung\s+(galaxy|note)/i) ||
                part.match(/^oneplus\s+\d/i) ||
                part.match(/^for\s+(iphone|galaxy|pixel|samsung)/i)) {
              extractedSizeId = part.toLowerCase().replace(/\s+/g, '_');
              if (!sizesMap.has(extractedSizeId)) {
                sizesMap.set(extractedSizeId, { id: extractedSizeId, name: part, width: 0, height: 0 });
              }
              break;
            }
          }
        }

        // Extract color - check all possible option keys
        let colorName = "";
        const optionKeys = Object.keys(options);
        // Check various color-related option names
        for (const key of optionKeys) {
          const lowerKey = key.toLowerCase();
          if (lowerKey === 'color' || lowerKey === 'colour' || lowerKey === 'colors' ||
              lowerKey === 'frame_color' || lowerKey === 'frame color' || lowerKey.includes('color')) {
            colorName = options[key];
            break;
          }
        }

        // If no color in options, try to extract from title
        if (!colorName) {
          // Use " / " split to preserve combined model names like "iPhone 12/12 Pro"
          const _cParts = title.includes(" / ")
            ? title.split(" / ").map((p: string) => p.trim())
            : title.split("/").map((p: string) => p.trim());
          for (let i = _cParts.length - 1; i >= 0; i--) {
            if (!looksLikeSize(_cParts[i])) {
              colorName = _cParts[i];
              break;
            }
          }
        }

        // Log what we found for debugging
        if (variants.indexOf(variant) < 3) {
          console.log(`[Refresh Variants] Variant "${title}" -> size: "${extractedSizeId}", color: "${colorName}", options:`, optionKeys);
        }

        let extractedColorId = "";
        if (colorName) {
          extractedColorId = colorName.toLowerCase().replace(/\s+/g, '_');
          if (!colorsMap.has(colorName.toLowerCase())) {
            const hex = colorHexMap[colorName.toLowerCase()] || "#808080";
            colorsMap.set(colorName.toLowerCase(), { id: extractedColorId, name: colorName, hex });
          }
        }

        // Add to variantMap
        if (extractedSizeId || extractedColorId) {
          const mapKey = `${extractedSizeId || 'default'}:${extractedColorId || 'default'}`;
          variantMap[mapKey] = { printifyVariantId: variant.id, providerId };
        }
      }

      let sizes = Array.from(sizesMap.values());
      const frameColors = Array.from(colorsMap.values());

      // Fallback: If no sizes extracted, create from product name or use default
      // This handles single-variant products and products where size wasn't parseable
      if (sizes.length === 0) {
        const sizeFromName = productType.name.match(/(\d+\s*oz)/i);
        const defaultSizeId = sizeFromName ? sizeFromName[1].toLowerCase().replace(/\s+/g, '') : "default";
        const defaultSizeName = sizeFromName ? sizeFromName[1] : "One Size";
        sizes = [{ id: defaultSizeId, name: defaultSizeName, width: 0, height: 0 }];
        console.log(`[Refresh Variants] Created fallback size "${defaultSizeName}" (id: ${defaultSizeId})`);

        // Update variantMap keys if we extracted a size from name
        if (defaultSizeId !== "default") {
          for (const key of Object.keys(variantMap)) {
            if (key.startsWith("default:")) {
              const colorId = key.slice(8);
              const newKey = `${defaultSizeId}:${colorId}`;
              variantMap[newKey] = variantMap[key];
              delete variantMap[key];
            }
          }
        }

        // For single-variant products with no variantMap entries, create one
        if (Object.keys(variantMap).length === 0 && variants.length > 0) {
          const variantKey = `${defaultSizeId}:default`;
          variantMap[variantKey] = { printifyVariantId: variants[0].id, providerId };
          console.log(`[Refresh Variants] Created fallback variantMap entry: ${variantKey}`);
        }
      }

      // Update product type.
      // Preserve any existing manual selections — only reset to "all" if the merchant has never
      // explicitly saved a selection (i.e. the stored array is empty / matches the old full set).
      const existingSizeIds: string[] = typeof productType.selectedSizeIds === 'string'
        ? JSON.parse(productType.selectedSizeIds || '[]')
        : productType.selectedSizeIds || [];
      const existingColorIds: string[] = typeof productType.selectedColorIds === 'string'
        ? JSON.parse(productType.selectedColorIds || '[]')
        : productType.selectedColorIds || [];

      // Keep only IDs that still exist in the refreshed data (remove stale ones).
      const newSizeIdSet = new Set(sizes.map((s: { id: string }) => s.id));
      const newColorIdSet = new Set(frameColors.map((c: { id: string }) => c.id));
      const filteredSizeIds = existingSizeIds.filter((id: string) => newSizeIdSet.has(id));
      const filteredColorIds = existingColorIds.filter((id: string) => newColorIdSet.has(id));

      // Preserve the existing selection as-is after filtering out stale IDs.
      // Since the import flow always writes explicit IDs, an empty existingColorIds/existingSizeIds
      // means the merchant intentionally cleared all options — respect that and keep it empty.
      // Only fall back to "all available" when the product has never been imported at all
      // (existingSizeIds is empty AND the product has no variantMap entries), which shouldn't
      // happen in practice but is a safe guard.
      const finalSizeIds = filteredSizeIds;
      const finalColorIds = filteredColorIds;

      const updated = await storage.updateProductType(productTypeId, {
        sizes: JSON.stringify(sizes),
        frameColors: JSON.stringify(frameColors),
        variantMap: JSON.stringify(variantMap),
        selectedSizeIds: JSON.stringify(finalSizeIds),
        selectedColorIds: JSON.stringify(finalColorIds),
      });

      console.log(`[Refresh Variants] Final result: ${sizes.length} sizes, ${frameColors.length} colors from ${variants.length} variants`);

      res.json({
        success: true,
        message: `Found ${sizes.length} sizes and ${frameColors.length} colors from ${variants.length} Printify variants`,
        variantCount: variants.length,
        sizes,
        frameColors,
        variantMapKeys: Object.keys(variantMap).slice(0, 10),
        productType: updated
      });
    } catch (error) {
      console.error("Error refreshing product variants:", error);
      res.status(500).json({ error: "Failed to refresh variants" });
    }
  });

  // POST /api/admin/product-types/:id/refresh-colors - Refresh color hex values using local lookup map
  // This only updates hex values - does NOT modify size/color selections
  // Note: Does NOT require Printify API token - uses local color lookup map
  app.post("/api/admin/product-types/:id/refresh-colors", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const productTypeId = parseInt(req.params.id);

      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const productType = await storage.getProductType(productTypeId);
      if (!productType || productType.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Product type not found" });
      }

      // Comprehensive color hex lookup - Printify API doesn't provide hex codes
      const colorHexMap: Record<string, string> = {
        // Basic colors
        "black": "#1a1a1a", "white": "#f5f5f5", "red": "#C41E3A", "blue": "#2563EB",
        "navy": "#1B2838", "green": "#22C55E", "yellow": "#FACC15", "orange": "#F97316",
        "pink": "#EC4899", "purple": "#A855F7", "gray": "#9E9E9E", "grey": "#9E9E9E",
        "brown": "#795548", "beige": "#F5F5DC", "cream": "#FFFDD0", "tan": "#D2B48C",
        // Frame colors
        "walnut": "#5D4037", "natural": "#D7CCC8", "gold": "#FFD700", "silver": "#C0C0C0",
        "oak": "#C4A35A", "cherry": "#9B2335", "mahogany": "#4E2728", "espresso": "#3C2415",
        // Heather variants
        "heather grey": "#9CA3AF", "heather gray": "#9CA3AF", "dark heather": "#4B5563",
        "heather navy": "#374151", "heather blue": "#60A5FA", "heather red": "#F87171",
        "heather forest": "#166534", "heather purple": "#A855F7", "heather orange": "#FB923C",
        // Common apparel colors
        "arctic white": "#F8FAFC", "jet black": "#0a0a0a", "charcoal": "#36454F",
        "burgundy": "#800020", "maroon": "#800000", "cardinal red": "#C41E3A",
        "fire red": "#FF3131", "scarlet": "#FF2400", "coral": "#FF7F50",
        "hot pink": "#FF69B4", "baby pink": "#F4C2C2", "light pink": "#FFB6C1",
        "magenta": "#FF00FF", "fuchsia": "#FF00FF", "rose": "#FF007F",
        "sky blue": "#87CEEB", "light blue": "#ADD8E6", "royal blue": "#4169E1",
        "royal": "#4169E1", "navy blue": "#000080", "cobalt": "#0047AB", "steel blue": "#4682B4",
        "oxford navy": "#1C2541", "indigo": "#4B0082", "midnight navy": "#191970",
        "cool blue": "#4A90D9", "tahiti blue": "#3AB09E",
        "kelly green": "#4CBB17", "forest green": "#228B22", "military green": "#4B5320",
        "olive": "#808000", "sage": "#9DC183", "mint": "#98FF98", "lime": "#32CD32",
        "bottle green": "#006A4E", "dark green": "#006400", "emerald": "#50C878",
        "mustard": "#FFDB58", "lemon": "#FFF44F", "banana cream": "#FFE9A1",
        "light yellow": "#FFFFE0", "sun yellow": "#FFE81F", "canary": "#FFEF00",
        "orange crush": "#FF6600", "burnt orange": "#CC5500", "peach": "#FFCBA4",
        "rust": "#B7410E", "terracotta": "#E2725B", "pumpkin": "#FF7518",
        "lavender": "#E6E6FA", "violet": "#EE82EE", "plum": "#DDA0DD",
        "lilac": "#C8A2C8", "grape": "#6F2DA8", "eggplant": "#614051", "purple rush": "#9B59B6",
        "hot chocolate": "#4A2C2A", "chocolate": "#7B3F00", "coffee": "#6F4E37",
        "mocha": "#967969", "dark chocolate": "#3D2314",
        "sand": "#C2B280", "khaki": "#C3B091", "taupe": "#483C32",
        "camel": "#C19A6B", "nude": "#E3BC9A", "champagne": "#F7E7CE", "desert pink": "#EDC9AF",
        "ash": "#B2BEB5", "slate": "#708090",
        "steel grey": "#71797E", "gunmetal": "#2A3439", "anthracite": "#293133",
        "light grey": "#D3D3D3", "light gray": "#D3D3D3", "heavy metal": "#3D3D3D",
        "teal": "#008080", "cyan": "#00FFFF", "aqua": "#00FFFF",
        "turquoise": "#40E0D0", "seafoam": "#93E9BE",
        "ivory": "#FFFFF0", "pearl": "#FDEEF4", "oatmeal": "#D5C4A1", "ecru": "#C2B280",
        // Sport specific
        "athletic heather": "#B8B8B8", "sport grey": "#9E9E9E",
        "dark grey heather": "#4B4B4B", "ice grey": "#D3D3D3",
        "vintage black": "#2B2B2B", "vintage navy": "#2C3E50",
        "washed black": "#3D3D3D", "stonewash blue": "#5DADE2"
      };

      // Get existing colors
      const existingColors: Array<{ id: string; name: string; hex: string }> = JSON.parse(productType.frameColors || "[]");
      
      // Update each color's hex value using the lookup map
      let updatedCount = 0;
      const updatedColors = existingColors.map(color => {
        const colorName = color.name.toLowerCase();
        const baseColorName = colorName
          .replace(/^solid\s+/i, '')
          .replace(/^heather\s+/i, 'heather ')
          .trim();
        
        // Try to find a matching hex: 1) exact match, 2) normalized match, 3) partial match
        let newHex = colorHexMap[colorName] || colorHexMap[baseColorName];
        
        // Partial matching if no exact match
        if (!newHex) {
          for (const [mapKey, mapHex] of Object.entries(colorHexMap)) {
            if (baseColorName.includes(mapKey) || mapKey.includes(baseColorName)) {
              newHex = mapHex;
              break;
            }
          }
        }
        
        if (newHex && newHex !== color.hex) {
          updatedCount++;
          return { ...color, hex: newHex };
        }
        return color;
      });

      // Update the product type
      const updated = await storage.updateProductType(productTypeId, {
        frameColors: JSON.stringify(updatedColors)
      });

      res.json({ 
        success: true, 
        message: `Updated ${updatedCount} color${updatedCount !== 1 ? 's' : ''} with new hex values`,
        updatedCount,
        frameColors: updatedColors,
        productType: updated 
      });
    } catch (error) {
      console.error("Error refreshing product colors:", error);
      res.status(500).json({ error: "Failed to refresh colors" });
    }
  });

  // POST /api/admin/printify/detect-shop - Detect Printify shop using provided token (before saving)
  app.post("/api/admin/printify/detect-shop", isAuthenticated, async (req: any, res: Response) => {
    try {
      const { token } = req.body;

      if (!token) {
        return res.status(400).json({
          error: "Token is required",
          instructions: ["Please enter your Printify API token first"]
        });
      }

      // Call Printify API to list shops
      const response = await fetch("https://api.printify.com/v1/shops.json", {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          return res.status(401).json({
            error: "Invalid API token",
            instructions: [
              "Your Printify API token appears to be invalid",
              "Make sure you copied the full token",
              "Try generating a new token in Printify → Settings → API"
            ]
          });
        }
        throw new Error(`Printify API error: ${response.status}`);
      }

      const responseData = await response.json();
      const shops = Array.isArray(responseData) ? responseData : (responseData.data || responseData || []);

      if (!Array.isArray(shops) || shops.length === 0) {
        return res.json({
          shops: [],
          error: "No shops found",
          instructions: [
            "You need to create a shop in Printify first",
            "Go to printify.com → My Stores → Add Store",
            "Connect a store or create a manual/API store"
          ]
        });
      }

      res.json({
        shops: shops.map((shop: any) => ({
          id: String(shop.id),
          title: shop.title || `Shop ${shop.id}`,
        })),
      });
    } catch (error) {
      console.error("Error detecting Printify shop:", error);
      res.status(500).json({ error: "Failed to detect shop" });
    }
  });

  // GET /api/admin/printify/shops - Fetch available Printify shops using API token
  app.get("/api/admin/printify/shops", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      // Check if we have a Printify API token
      const apiToken = merchant.printifyApiToken;
      if (!apiToken) {
        return res.status(400).json({ 
          error: "Printify API token not configured",
          message: "Please save your Printify API token first, then try detecting your shop."
        });
      }

      // Call Printify API to list shops
      const response = await fetch("https://api.printify.com/v1/shops.json", {
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          return res.status(401).json({ 
            error: "Invalid API token",
            message: "Your Printify API token appears to be invalid. Please check it and try again."
          });
        }
        throw new Error(`Printify API error: ${response.status}`);
      }

      const responseData = await response.json();
      
      // Printify API returns shops directly as an array (not wrapped in {data:...})
      const shops = Array.isArray(responseData) ? responseData : (responseData.data || responseData || []);
      
      if (!Array.isArray(shops) || shops.length === 0) {
        return res.json({ 
          shops: [],
          message: "No shops found. You need to create a shop in Printify first.",
          instructions: [
            "1. Go to printify.com and log in",
            "2. Click 'Add new store' or go to 'My Stores'",
            "3. Choose 'Manual orders' or 'Other' as your platform",
            "4. Name your store and complete setup",
            "5. Come back here and click 'Detect Shop ID' again"
          ]
        });
      }

      // Return the list of shops
      res.json({ 
        shops: shops.map((shop: any) => ({
          id: shop.id,
          title: shop.title,
          sales_channel: shop.sales_channel
        })),
        message: shops.length === 1 
          ? "Found your shop! Click to use this Shop ID."
          : `Found ${shops.length} shops. Select the one you want to use.`
      });
    } catch (error) {
      console.error("Error fetching Printify shops:", error);
      res.status(500).json({ error: "Failed to fetch shops from Printify" });
    }
  });

  // ── Printify Cost & Shipping Endpoints ──────────────────────────────────────

  // Helper: fetch the first placeholder position for a blueprint/provider/variant
  async function fetchPlaceholderPosition(
    blueprintId: number,
    providerId: number,
    variantId: number,
    apiToken: string
  ): Promise<string> {
    try {
      const resp = await fetch(
        `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants/${variantId}/placeholders.json`,
        { headers: { Authorization: `Bearer ${apiToken}` } }
      );
      if (resp.ok) {
        const data = await resp.json();
        const list = data.placeholders || data || [];
        if (Array.isArray(list) && list.length > 0 && list[0]?.position) {
          console.log(`[Printify Costs] Placeholder position: "${list[0].position}"`);
          return list[0].position;
        }
      } else {
        console.warn(`[Printify Costs] Placeholder API returned ${resp.status}`);
      }
    } catch (e) {
      console.warn("[Printify Costs] Could not fetch placeholder position:", e);
    }
    return "front";
  }

  // Helper: attempt to create a Printify temp product and immediately delete it, returning variant costs.
  // Returns { success, costs, tempProductId, error } — always deletes the product if created.
  async function tryCreateTempProductForCosts(
    shopId: string,
    apiToken: string,
    blueprintId: number,
    providerId: number,
    variantIds: number[],
    placeholderPosition: string,
    imageSpec: { id: string; x: number; y: number; scale: number; angle: number } | null
  ): Promise<{ success: boolean; costs: Record<string, number>; tempProductId?: string; status?: number; error?: string }> {
    const body: any = {
      title: `_cost_probe_${Date.now()}`,
      description: "Temporary product for cost lookup - will be deleted immediately",
      blueprint_id: blueprintId,
      print_provider_id: providerId,
      variants: variantIds.map(id => ({ id, price: 100, is_enabled: true })),
      print_areas: [{
        variant_ids: variantIds,
        placeholders: [{ position: placeholderPosition, images: imageSpec ? [imageSpec] : [] }],
      }],
    };
    const createResp = await fetch(`https://api.printify.com/v1/shops/${shopId}/products.json`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const status = createResp.status;
    if (!createResp.ok) {
      const errorText = await createResp.text();
      return { success: false, costs: {}, status, error: errorText };
    }
    const product = await createResp.json();
    const tempProductId: string = product.id;
    let costs: Record<string, number> = {};
    for (const v of (product.variants || [])) {
      if (v.id && typeof v.cost === "number") {
        costs[String(v.id)] = v.cost;
      }
    }

    // Some blueprints don't include v.cost in the creation response.
    // If costs are empty, fetch the product again to get fully populated variant data.
    if (Object.keys(costs).length === 0) {
      console.log(`[Printify Costs] Creation response had no costs — fetching product ${tempProductId} to get variant costs`);
      try {
        const fetchResp = await fetch(`https://api.printify.com/v1/shops/${shopId}/products/${tempProductId}.json`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        if (fetchResp.ok) {
          const fetchedProduct = await fetchResp.json();
          for (const v of (fetchedProduct.variants || [])) {
            if (v.id && typeof v.cost === "number") {
              costs[String(v.id)] = v.cost;
            }
          }
          console.log(`[Printify Costs] Re-fetch extracted ${Object.keys(costs).length} costs for product ${tempProductId}`);
        } else {
          console.warn(`[Printify Costs] Re-fetch of product ${tempProductId} failed: ${fetchResp.status}`);
        }
      } catch (fetchErr) {
        console.warn(`[Printify Costs] Re-fetch error for product ${tempProductId}:`, fetchErr);
      }
    }

    // Clean up immediately
    try {
      await fetch(`https://api.printify.com/v1/shops/${shopId}/products/${tempProductId}.json`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      console.log(`[Printify Costs] Deleted temp product ${tempProductId}`);
    } catch (delErr) {
      console.error(`[Printify Costs] Failed to delete temp product ${tempProductId}:`, delErr);
    }
    return { success: true, costs, tempProductId, status };
  }

  // Helper: get an existing image ID from the merchant's Printify uploads library
  async function getExistingUploadId(apiToken: string): Promise<string | null> {
    try {
      const resp = await fetch("https://api.printify.com/v1/uploads.json?limit=1", {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        const uploads = data.data || data || [];
        if (Array.isArray(uploads) && uploads.length > 0 && uploads[0]?.id) {
          console.log(`[Printify Costs] Found existing upload id=${uploads[0].id}`);
          return String(uploads[0].id);
        }
      }
    } catch (e) {
      console.warn("[Printify Costs] Could not fetch existing uploads:", e);
    }
    return null;
  }

  // Helper: upload a public image URL to Printify and return the image ID
  async function uploadPublicImageToPrintify(apiToken: string, imageUrl: string): Promise<string | null> {
    try {
      const resp = await fetch("https://api.printify.com/v1/uploads/images.json", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ file_name: "cost_probe.png", url: imageUrl }),
      });
      if (resp.ok) {
        const data = await resp.json();
        console.log(`[Printify Costs] Uploaded image via URL, id=${data.id}`);
        return data.id ? String(data.id) : null;
      } else {
        const errText = await resp.text();
        console.warn(`[Printify Costs] URL image upload failed (${resp.status}): ${errText}`);
      }
    } catch (e) {
      console.warn("[Printify Costs] URL image upload error:", e);
    }
    return null;
  }

  // Core waterfall logic: tries three strategies to create a temp product and get costs.
  // Returns { costs, strategyUsed, diagnostics }
  async function fetchPrintifyCostsWaterfall(
    shopId: string,
    apiToken: string,
    blueprintId: number,
    providerId: number,
    variantIds: number[],
    baseMockupImages: Record<string, string>
  ): Promise<{
    costs: Record<string, number>;
    strategyUsed: string | null;
    diagnostics: Array<{ strategy: string; status?: number; success: boolean; error?: string }>;
  }> {
    const diagnostics: Array<{ strategy: string; status?: number; success: boolean; error?: string }> = [];
    const firstVid = variantIds[0];
    const position = await fetchPlaceholderPosition(blueprintId, providerId, firstVid, apiToken);
    const imageSpec = (id: string) => ({ id, x: 0.5, y: 0.5, scale: 1, angle: 0 });

    // Printify API rejects temp product creation if variant count exceeds 100.
    // Costs are catalog-level per variant ID, so a subset is sufficient.
    const VARIANT_CHUNK_SIZE = 50;
    const variantChunk = variantIds.slice(0, VARIANT_CHUNK_SIZE);

    // Strategy 0: read costs from an existing Printify product with the same blueprint + provider (no temp product needed)
    console.log(`[Printify Costs] Strategy 0 — reading costs from existing shop products for blueprint ${blueprintId}`);
    try {
      let page = 1;
      let found = false;
      while (page <= 5) {
        const listResp = await fetch(`https://api.printify.com/v1/shops/${shopId}/products.json?limit=100&page=${page}`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        if (!listResp.ok) {
          diagnostics.push({ strategy: "read_existing_product", status: listResp.status, success: false, error: `List products failed: ${listResp.status}` });
          break;
        }
        const listData = await listResp.json();
        const products: any[] = listData.data || listData || [];
        if (products.length === 0) break;
        for (const p of products) {
          if (p.blueprint_id === blueprintId && p.print_provider_id === providerId) {
            // Fetch full product to get variant costs
            const fullResp = await fetch(`https://api.printify.com/v1/shops/${shopId}/products/${p.id}.json`, {
              headers: { Authorization: `Bearer ${apiToken}` },
            });
            if (!fullResp.ok) continue;
            const fullProduct = await fullResp.json();
            const costs: Record<string, number> = {};
            for (const v of (fullProduct.variants || [])) {
              if (v.id && typeof v.cost === "number") {
                costs[String(v.id)] = v.cost;
              }
            }
            if (Object.keys(costs).length > 0) {
              console.log(`[Printify Costs] Strategy 0 succeeded — found ${Object.keys(costs).length} costs from existing product ${p.id}`);
              diagnostics.push({ strategy: "read_existing_product", success: true });
              found = true;
              return { costs, strategyUsed: "read_existing_product", diagnostics };
            }
          }
        }
        if (!listData.next_page_url && (!listData.last_page || page >= listData.last_page)) break;
        page++;
      }
      if (!found) {
        diagnostics.push({ strategy: "read_existing_product", success: false, error: "No matching product found in shop" });
        console.warn("[Printify Costs] Strategy 0 found no matching products");
      }
    } catch (s0Err: any) {
      diagnostics.push({ strategy: "read_existing_product", success: false, error: String(s0Err) });
      console.warn("[Printify Costs] Strategy 0 error:", s0Err);
    }

    // Strategy 1: print_areas with empty images array
    console.log(`[Printify Costs] Strategy 1 — empty images[] for position "${position}"`);
    const s1 = await tryCreateTempProductForCosts(shopId, apiToken, blueprintId, providerId, variantChunk, position, null);
    diagnostics.push({ strategy: "empty_images", status: s1.status, success: s1.success, error: s1.error });
    if (s1.success) return { costs: s1.costs, strategyUsed: "empty_images", diagnostics };

    console.warn(`[Printify Costs] Strategy 1 failed (${s1.status}): ${s1.error?.slice(0, 200)}`);

    // Strategy 2: reuse an existing image from the merchant's Printify library
    console.log("[Printify Costs] Strategy 2 — reuse existing upload from library");
    const existingId = await getExistingUploadId(apiToken);
    if (existingId) {
      const s2 = await tryCreateTempProductForCosts(shopId, apiToken, blueprintId, providerId, variantChunk, position, imageSpec(existingId));
      diagnostics.push({ strategy: "reuse_existing_upload", status: s2.status, success: s2.success, error: s2.error });
      if (s2.success) return { costs: s2.costs, strategyUsed: "reuse_existing_upload", diagnostics };
      console.warn(`[Printify Costs] Strategy 2 failed (${s2.status}): ${s2.error?.slice(0, 200)}`);
    } else {
      diagnostics.push({ strategy: "reuse_existing_upload", success: false, error: "No existing uploads found in library" });
      console.warn("[Printify Costs] Strategy 2 skipped — no existing uploads in library");
    }

    // Strategy 3: upload the stored mockup image URL (Printify CDN)
    const mockupUrl: string | undefined =
      baseMockupImages.front || baseMockupImages.lifestyle || (Object.values(baseMockupImages)[0] as string | undefined);
    if (mockupUrl) {
      console.log(`[Printify Costs] Strategy 3a — upload product mockup URL: ${mockupUrl.slice(0, 80)}`);
      const uploadedId = await uploadPublicImageToPrintify(apiToken, mockupUrl);
      if (uploadedId) {
        const s3a = await tryCreateTempProductForCosts(shopId, apiToken, blueprintId, providerId, variantChunk, position, imageSpec(uploadedId));
        diagnostics.push({ strategy: "upload_mockup_url", status: s3a.status, success: s3a.success, error: s3a.error });
        if (s3a.success) return { costs: s3a.costs, strategyUsed: "upload_mockup_url", diagnostics };
        console.warn(`[Printify Costs] Strategy 3a failed (${s3a.status}): ${s3a.error?.slice(0, 200)}`);
      } else {
        diagnostics.push({ strategy: "upload_mockup_url", success: false, error: "Upload of mockup URL failed" });
      }
    }

    // Strategy 3b: upload a known-good public placeholder image
    const fallbackUrls = [
      "https://images.printify.com/mockup/5d39b411749d0a000f30e0f4/45740/2x2-white.jpg",
      "https://via.assets.so/img.jpg?w=1200&h=1200&tc=white&bg=999999",
      "https://placehold.co/1200x1200/png",
    ];
    for (const url of fallbackUrls) {
      console.log(`[Printify Costs] Strategy 3b — upload fallback public URL: ${url}`);
      const uploadedId = await uploadPublicImageToPrintify(apiToken, url);
      if (uploadedId) {
        const s3b = await tryCreateTempProductForCosts(shopId, apiToken, blueprintId, providerId, variantChunk, position, imageSpec(uploadedId));
        diagnostics.push({ strategy: `upload_fallback_url:${url}`, status: s3b.status, success: s3b.success, error: s3b.error });
        if (s3b.success) return { costs: s3b.costs, strategyUsed: `upload_fallback_url`, diagnostics };
        console.warn(`[Printify Costs] Strategy 3b (${url}) failed (${s3b.status}): ${s3b.error?.slice(0, 200)}`);
      } else {
        diagnostics.push({ strategy: `upload_fallback_url:${url}`, success: false, error: "Upload failed" });
      }
    }

    return { costs: {}, strategyUsed: null, diagnostics };
  }

  // POST /api/admin/printify/costs/clear-cache
  // Clears cached printify_costs for ALL product types belonging to this merchant,
  // forcing a fresh fetch next time each product type's costs are requested.
  app.post("/api/admin/printify/costs/clear-cache", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) return res.status(404).json({ error: "Merchant not found" });

      const productTypes = await storage.getProductTypesByMerchant(merchant.id);
      let cleared = 0;
      for (const pt of productTypes) {
        await storage.updateProductType(pt.id, { printifyCosts: "{}" });
        cleared++;
      }
      console.log(`[Printify Costs] Cache cleared for ${cleared} product types (merchant ${merchant.id})`);
      return res.json({ success: true, cleared, message: `Cleared costs cache for ${cleared} product types` });
    } catch (err: any) {
      console.error("[/api/admin/printify/costs/clear-cache]", err);
      return res.status(500).json({ error: "Failed to clear costs cache", detail: String(err) });
    }
  });

  // GET /api/admin/printify/costs/:productTypeId
  // Creates a temporary Printify product to read variant production costs, then deletes it.
  // Returns cached costs if available and less than 24 hours old.
  app.get("/api/admin/printify/costs/:productTypeId", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) return res.status(404).json({ error: "Merchant not found" });

      const apiToken = merchant.printifyApiToken;
      const shopId = merchant.printifyShopId;
      if (!apiToken || !shopId) {
        return res.status(400).json({ error: "Printify API token and shop ID are required. Configure them in Settings." });
      }

      const productTypeId = parseInt(req.params.productTypeId, 10);
      if (!productTypeId) return res.status(400).json({ error: "Invalid product type ID" });

      const productType = await storage.getProductType(productTypeId);
      if (!productType) return res.status(404).json({ error: "Product type not found" });
      if (!productType.printifyBlueprintId || !productType.printifyProviderId) {
        return res.status(400).json({ error: "Product type is missing Printify blueprint or provider info" });
      }

      // Check cache first (24h TTL)
      const cachedRaw = JSON.parse(productType.printifyCosts || "{}");
      const cacheAge = cachedRaw._fetchedAt ? Date.now() - new Date(cachedRaw._fetchedAt).getTime() : Infinity;
      if (cacheAge < 24 * 60 * 60 * 1000 && Object.keys(cachedRaw).length > 1) {
        const { _fetchedAt, ...cachedCosts } = cachedRaw;
        const svIds = (typeof productType.shopifyVariantIds === "string"
          ? JSON.parse(productType.shopifyVariantIds || "{}")
          : productType.shopifyVariantIds || {}) as Record<string, number>;
        const vm = JSON.parse(productType.variantMap || "{}");
        const sizes = JSON.parse(productType.sizes || "[]");
        const frameColors = JSON.parse(productType.frameColors || "[]");
        // Build sizeId:colorId → printifyVariantId label lookup
        // AND a sizeName:colorName → printifyVariantId bridge for shopifyVariantIds matching
        const nameToVmKey: Record<string, string> = {};
        const cachedLabels: Record<string, string> = {};
        for (const [key, entry] of Object.entries(vm) as [string, any][]) {
          if (entry?.printifyVariantId) {
            const [sizeId, colorId] = key.split(":");
            const sizeName = sizes.find((s: any) => String(s.id) === sizeId)?.name ?? sizeId;
            const colorName = frameColors.find((c: any) => String(c.id) === colorId)?.name;
            cachedLabels[String(entry.printifyVariantId)] = colorName && colorId !== "default" ? `${sizeName} / ${colorName}` : sizeName;
            // Build reverse lookup: sizeName:colorName → variantMap key
            const nameKey = colorName ? `${sizeName}:${colorName}` : `${sizeName}:default`;
            nameToVmKey[nameKey] = key;
          }
        }
        const cachedShopifyCosts: Record<string, number> = {};
        for (const [mapKey, shopifyVid] of Object.entries(svIds)) {
          // Try direct lookup first (in case keys happen to match)
          let vmEntry = vm[mapKey] as any;
          // If no match, try bridging via name → id lookup
          if (!vmEntry?.printifyVariantId) {
            const bridgedKey = nameToVmKey[mapKey];
            if (bridgedKey) vmEntry = vm[bridgedKey] as any;
          }
          if (vmEntry?.printifyVariantId && cachedCosts[String(vmEntry.printifyVariantId)] !== undefined) {
            cachedShopifyCosts[String(shopifyVid)] = cachedCosts[String(vmEntry.printifyVariantId)];
          }
        }
        return res.json({ costs: cachedCosts, shopifyVariantCosts: cachedShopifyCosts, printifyVariantLabels: cachedLabels, cached: true });
      }

      // Extract all unique Printify variant IDs from variantMap
      const variantMap = JSON.parse(productType.variantMap || "{}");
      const printifyVariantIds: number[] = [];
      const seen = new Set<number>();
      for (const entry of Object.values(variantMap) as any[]) {
        if (entry?.printifyVariantId && !seen.has(Number(entry.printifyVariantId))) {
          seen.add(Number(entry.printifyVariantId));
          printifyVariantIds.push(Number(entry.printifyVariantId));
        }
      }
      if (printifyVariantIds.length === 0) {
        return res.status(400).json({ error: "No Printify variant IDs found in product type" });
      }

      const baseMockupImages = typeof productType.baseMockupImages === "string"
        ? JSON.parse(productType.baseMockupImages || "{}")
        : (productType.baseMockupImages || {});

      console.log(`[Printify Costs] Starting waterfall for blueprint ${productType.printifyBlueprintId}, ${printifyVariantIds.length} variants`);
      const { costs, strategyUsed, diagnostics } = await fetchPrintifyCostsWaterfall(
        shopId, apiToken,
        productType.printifyBlueprintId, productType.printifyProviderId,
        printifyVariantIds, baseMockupImages
      );

      if (!strategyUsed || Object.keys(costs).length === 0) {
        console.error(`[Printify Costs] All strategies failed. Diagnostics:`, JSON.stringify(diagnostics));
        return res.status(502).json({ error: "Failed to fetch costs from Printify after all strategies", diagnostics });
      }

      console.log(`[Printify Costs] Success via "${strategyUsed}", extracted ${Object.keys(costs).length} costs`);

      // Cache costs on the product type
      await storage.updateProductType(productTypeId, { printifyCosts: JSON.stringify({ ...costs, _fetchedAt: new Date().toISOString() }) });

      // Build variant-key → cost mapping
      const variantKeyCosts: Record<string, number> = {};
      for (const [key, entry] of Object.entries(variantMap) as [string, any][]) {
        if (entry?.printifyVariantId && costs[String(entry.printifyVariantId)] !== undefined) {
          variantKeyCosts[key] = costs[String(entry.printifyVariantId)];
        }
      }

       // Build printifyVariantId → label mapping AND name-based bridge for shopifyVariantIds
      const printifyVariantLabels: Record<string, string> = {};
      const nameToVmKey: Record<string, string> = {};
      const sizes = JSON.parse(productType.sizes || "[]");
      const frameColors = JSON.parse(productType.frameColors || "[]");
      for (const [key, entry] of Object.entries(variantMap) as [string, any][]) {
        if (entry?.printifyVariantId) {
          const [sizeId, colorId] = key.split(":");
          const sizeName = sizes.find((s: any) => String(s.id) === sizeId)?.name ?? sizeId;
          const colorName = frameColors.find((c: any) => String(c.id) === colorId)?.name;
          printifyVariantLabels[String(entry.printifyVariantId)] = colorName && colorId !== "default" ? `${sizeName} / ${colorName}` : sizeName;
          // Build reverse lookup: sizeName:colorName → variantMap key
          const nameKey = colorName ? `${sizeName}:${colorName}` : `${sizeName}:default`;
          nameToVmKey[nameKey] = key;
        }
      }
      // Build Shopify variant ID → cost mapping (bridge sizeName:colorName → sizeId:colorId)
      const shopifyVariantCosts: Record<string, number> = {};
      const svIds = (typeof productType.shopifyVariantIds === "string"
        ? JSON.parse(productType.shopifyVariantIds || "{}")
        : productType.shopifyVariantIds || {}) as Record<string, number>;
      for (const [mapKey, shopifyVid] of Object.entries(svIds)) {
        // Try direct lookup first (in case keys happen to match)
        let vmEntry = variantMap[mapKey] as any;
        // If no match, try bridging via name → id lookup
        if (!vmEntry?.printifyVariantId) {
          const bridgedKey = nameToVmKey[mapKey];
          if (bridgedKey) vmEntry = variantMap[bridgedKey] as any;
        }
        if (vmEntry?.printifyVariantId && costs[String(vmEntry.printifyVariantId)] !== undefined) {
          shopifyVariantCosts[String(shopifyVid)] = costs[String(vmEntry.printifyVariantId)];
        }
      }

      return res.json({ costs, variantKeyCosts, shopifyVariantCosts, printifyVariantLabels, cached: false, strategyUsed });
    } catch (err: any) {
      console.error("[/api/admin/printify/costs]", err);
      return res.status(500).json({ error: "Failed to fetch Printify costs" });
    }
  });

  // GET /api/admin/printify/costs-debug/:productTypeId
  // Diagnostic endpoint: runs all waterfall strategies and reports what each one returns.
  // Does NOT cache results. Use this to diagnose why production costs aren't showing.
  app.get("/api/admin/printify/costs-debug/:productTypeId", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) return res.status(404).json({ error: "Merchant not found" });

      const apiToken = merchant.printifyApiToken;
      const shopId = merchant.printifyShopId;
      if (!apiToken || !shopId) {
        return res.status(400).json({ error: "Printify credentials not configured" });
      }

      const productTypeId = parseInt(req.params.productTypeId, 10);
      if (!productTypeId) return res.status(400).json({ error: "Invalid product type ID" });

      const productType = await storage.getProductType(productTypeId);
      if (!productType) return res.status(404).json({ error: "Product type not found" });
      if (!productType.printifyBlueprintId || !productType.printifyProviderId) {
        return res.status(400).json({ error: "Product type is missing Printify blueprint or provider info" });
      }

      const variantMap = JSON.parse(productType.variantMap || "{}");
      const printifyVariantIds: number[] = [];
      const seen = new Set<number>();
      for (const entry of Object.values(variantMap) as any[]) {
        if (entry?.printifyVariantId && !seen.has(Number(entry.printifyVariantId))) {
          seen.add(Number(entry.printifyVariantId));
          printifyVariantIds.push(Number(entry.printifyVariantId));
        }
      }

      if (printifyVariantIds.length === 0) {
        return res.status(400).json({ error: "No Printify variant IDs found" });
      }

      const baseMockupImages = typeof productType.baseMockupImages === "string"
        ? JSON.parse(productType.baseMockupImages || "{}")
        : (productType.baseMockupImages || {});

      const { costs, strategyUsed, diagnostics } = await fetchPrintifyCostsWaterfall(
        shopId, apiToken,
        productType.printifyBlueprintId, productType.printifyProviderId,
        printifyVariantIds, baseMockupImages
      );

      return res.json({
        success: strategyUsed !== null && Object.keys(costs).length > 0,
        strategyUsed,
        costsExtracted: Object.keys(costs).length,
        sampleCosts: Object.entries(costs).slice(0, 3).map(([id, c]) => ({ variantId: id, costCents: c })),
        diagnostics,
        productTypeInfo: {
          name: productType.name,
          blueprintId: productType.printifyBlueprintId,
          providerId: productType.printifyProviderId,
          variantCount: printifyVariantIds.length,
          hasMockupImages: Object.keys(baseMockupImages).length > 0,
        },
      });
    } catch (err: any) {
      console.error("[/api/admin/printify/costs-debug]", err);
      return res.status(500).json({ error: "Debug endpoint failed", detail: String(err) });
    }
  });

  // GET /api/admin/printify/shipping/:blueprintId/:providerId
  // Fetches shipping data from Printify v2 catalog API per tier, per country, per variant.
  app.get("/api/admin/printify/shipping/:blueprintId/:providerId", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) return res.status(404).json({ error: "Merchant not found" });

      const apiToken = merchant.printifyApiToken;
      if (!apiToken) return res.status(400).json({ error: "Printify API token not configured" });

      const { blueprintId, providerId } = req.params;
      if (!blueprintId || !providerId) return res.status(400).json({ error: "Blueprint and provider IDs are required" });

      const headers = { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" };

      // Fetch available shipping tiers
      const listResp = await fetch(
        `https://api.printify.com/v2/catalog/blueprints/${blueprintId}/print_providers/${providerId}/shipping.json`,
        { headers }
      );

      if (!listResp.ok) {
        // Fall back to v1 shipping if v2 isn't available
        const v1Resp = await fetch(
          `https://api.printify.com/v1/catalog/blueprints/${blueprintId}/print_providers/${providerId}/shipping.json`,
          { headers }
        );
        if (!v1Resp.ok) {
          return res.status(502).json({ error: "Failed to fetch shipping info from Printify" });
        }
        const v1Data = await v1Resp.json();
        return res.json({ version: "v1", shipping: v1Data });
      }

      const listData = await listResp.json();
      const availableTiers = (listData.data || []).map((m: any) => m.attributes?.name).filter(Boolean);

      // Fetch details for each tier in parallel
      const tierResults: Record<string, any[]> = {};
      await Promise.all(
        availableTiers.map(async (tier: string) => {
          try {
            const tierResp = await fetch(
              `https://api.printify.com/v2/catalog/blueprints/${blueprintId}/print_providers/${providerId}/shipping/${tier}.json`,
              { headers }
            );
            if (tierResp.ok) {
              const tierData = await tierResp.json();
              tierResults[tier] = (tierData.data || []).map((entry: any) => ({
                variantId: entry.attributes?.variantId,
                country: entry.attributes?.country?.code,
                firstItem: entry.attributes?.shippingCost?.firstItem?.amount,
                additionalItems: entry.attributes?.shippingCost?.additionalItems?.amount,
                currency: entry.attributes?.shippingCost?.firstItem?.currency || "USD",
                handlingTime: entry.attributes?.handlingTime,
              }));
            }
          } catch (e) {
            console.error(`[Printify Shipping] Failed to fetch tier ${tier}:`, e);
          }
        })
      );

      // Extract unique countries across all tiers for the frontend country selector
      const allCountries = new Set<string>();
      for (const entries of Object.values(tierResults)) {
        for (const e of entries) {
          if (e.country) allCountries.add(e.country);
        }
      }

      return res.json({
        version: "v2",
        tiers: availableTiers,
        shipping: tierResults,
        countries: Array.from(allCountries).sort((a, b) => {
          if (a === "US") return -1;
          if (b === "US") return 1;
          if (a === "REST_OF_THE_WORLD") return 1;
          if (b === "REST_OF_THE_WORLD") return -1;
          return a.localeCompare(b);
        }),
      });
    } catch (err: any) {
      console.error("[/api/admin/printify/shipping]", err);
      return res.status(500).json({ error: "Failed to fetch shipping info" });
    }
  });

  // POST /api/mockup/generate - Generate Printify mockup for a design
  app.post("/api/mockup/generate", isAuthenticated, async (req: any, res: Response) => {
    try {
      const userId = req.user.claims.sub;
      const { productTypeId, designImageUrl, patternUrl, sizeId, colorId, scale, x, y, mirrorLegs, panelUrls } = req.body;

      if (!productTypeId || !designImageUrl) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      // For AOP products, prefer patternUrl (Picsart-tiled) over designImageUrl
      const effectiveImageUrl = (patternUrl || designImageUrl) as string;

      // Convert relative URLs to absolute URLs for Printify
      let absoluteImageUrl = effectiveImageUrl;
      if (effectiveImageUrl.startsWith("/objects/")) {
        const host = req.get("host") || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.REPLIT_DEV_DOMAIN;
        const protocol = req.protocol || "https";
        absoluteImageUrl = `${protocol}://${host}${effectiveImageUrl}`;
        console.log("[Mockup Generate] Converting image URL for Printify:", absoluteImageUrl);
      }

      const merchant = await storage.getMerchantByUserId(userId);
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found" });
      }

      const productType = await storage.getProductType(parseInt(productTypeId));
      if (!productType || productType.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Product type not found" });
      }

      // Check if we have Printify credentials and blueprint ID
      if (!merchant.printifyApiToken || !merchant.printifyShopId || !productType.printifyBlueprintId) {
        // Return fallback response with local template suggestion
        const { getLocalMockupTemplate } = await import("./printify-mockups.js");
        const localTemplate = getLocalMockupTemplate(productType.designerType || "pillow");
        
        return res.json({
          success: false,
          mockupUrls: [],
          source: "fallback",
          localTemplate,
          message: "Printify not configured, using local preview",
        });
      }

      // Generate Printify mockup
      const { generatePrintifyMockup } = await import("./printify-mockups.js");
      
      // Look up the correct variant from the variantMap using server-side data only
      const variantMapData = JSON.parse(productType.variantMap as string || "{}");
      const variantKey = `${sizeId || 'default'}:${colorId || 'default'}`;
      
      // Try exact match first, then fallback to partial matches, then any available variant
      const variantData = variantMapData[variantKey] || 
                          variantMapData[`${sizeId || 'default'}:default`] ||
                          variantMapData[`default:${colorId || 'default'}`] ||
                          variantMapData['default:default'] ||
                          Object.values(variantMapData)[0];
      
      if (!variantData || !variantData.printifyVariantId) {
        return res.status(400).json({ 
          error: "Could not resolve product variant for the selected options",
          availableKeys: Object.keys(variantMapData)
        });
      }
      
      const providerId = variantData.providerId || productType.printifyProviderId || 1;
      const targetVariantId = variantData.printifyVariantId;

      const aopPositions = productType.isAllOverPrint && productType.placeholderPositions
        ? JSON.parse(productType.placeholderPositions as string)
        : undefined;

      console.log("[Mockup Generate] AOP:", !!aopPositions, "positions:", aopPositions?.length, "mirrorLegs:", !!mirrorLegs, "imageUrl:", absoluteImageUrl.substring(0, 80));

      const result = await generatePrintifyMockup({
        blueprintId: productType.printifyBlueprintId,
        providerId,
        variantId: targetVariantId,
        imageUrl: absoluteImageUrl,
        printifyApiToken: merchant.printifyApiToken,
        printifyShopId: merchant.printifyShopId,
        scale: scale ? scale / 100 : 1,
        x: x !== undefined ? (x - 50) / 50 : 0,
        y: y !== undefined ? (y - 50) / 50 : 0,
        doubleSided: resolveDoubleSided(productType),
        wrapAround: resolveWrapAround(productType),
        wrapDirection: resolveWrapAround(productType) ? resolveWrapDirection(productType) : undefined,
        aopPositions,
        mirrorLegs: !!mirrorLegs,
        panelUrls: Array.isArray(panelUrls) && panelUrls.length > 0 ? panelUrls : undefined,
      });

      console.log("[Mockup Generate] Result:", result.success, "mockups:", result.mockupImages?.length);
      res.json(result);
    } catch (error: any) {
      console.error("[Mockup Generate] Error:", error?.message || error);
      res.status(500).json({ error: error?.message || "Failed to generate mockup" });
    }
  });

  // Shopify Storefront Mockup Generation (for embedded design studio)
  // Uses Shopify session tokens instead of Replit auth
  app.post("/api/shopify/mockup", async (req: Request, res: Response) => {
    try {
      const { productTypeId, designImageUrl, patternUrl, sizeId, colorId, scale, x, y, shop, sessionToken, mirrorLegs, panelUrls } = req.body;

      if (!shop) {
        return res.status(400).json({ error: "Shop domain required" });
      }

      // Validate shop domain format
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
        return res.status(400).json({ error: "Invalid shop domain format" });
      }

      // Verify session token
      if (!sessionToken) {
        return res.status(401).json({ error: "Session token required" });
      }

      const session = shopifySessionTokens.get(sessionToken);
      if (!session) {
        return res.status(401).json({ error: "Invalid session token" });
      }

      if (Date.now() > session.expiresAt) {
        shopifySessionTokens.delete(sessionToken);
        return res.status(401).json({ error: "Session token expired" });
      }

      if (session.shop !== shop) {
        return res.status(403).json({ error: "Session token mismatch" });
      }

      // Verify shop is installed
      const installation = await storage.getShopifyInstallationByShop(shop);
      if (!installation || installation.status !== "active") {
        return res.status(403).json({ error: "Shop not authorized" });
      }

      if (!productTypeId || !designImageUrl) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      // Convert relative URLs to absolute URLs for Printify
      // For AOP products, prefer patternUrl (Picsart-tiled) over designImageUrl
      const effectiveShopifyImageUrl = (patternUrl || designImageUrl) as string;
      let absoluteImageUrl = effectiveShopifyImageUrl;
      if (effectiveShopifyImageUrl.startsWith("/objects/")) {
        const host = req.get("host") || process.env.REPLIT_DEV_DOMAIN;
        const protocol = req.protocol || "https";
        absoluteImageUrl = `${protocol}://${host}${effectiveShopifyImageUrl}`;
        console.log("[Shopify Mockup] Converting image URL for Printify:", absoluteImageUrl);
      }

      // Get merchant from shop installation
      if (!installation.merchantId) {
        return res.status(404).json({ error: "Shop not associated with a merchant" });
      }
      const merchant = await storage.getMerchant(installation.merchantId);
      if (!merchant) {
        return res.status(404).json({ error: "Merchant not found for shop" });
      }

      const productType = await storage.getProductType(parseInt(productTypeId));
      if (!productType || productType.merchantId !== merchant.id) {
        return res.status(404).json({ error: "Product type not found" });
      }

      // Check if we have Printify credentials and blueprint ID
      if (!merchant.printifyApiToken || !merchant.printifyShopId || !productType.printifyBlueprintId) {
        return res.json({
          success: false,
          mockupUrls: [],
          source: "fallback",
          message: "Printify not configured",
        });
      }

      // Generate Printify mockup
      const { generatePrintifyMockup } = await import("./printify-mockups.js");
      
      // Look up the correct variant from the variantMap
      const variantMapData = JSON.parse(productType.variantMap as string || "{}");
      const variantKey = `${sizeId || 'default'}:${colorId || 'default'}`;
      
      const variantData = variantMapData[variantKey] || 
                          variantMapData[`${sizeId || 'default'}:default`] ||
                          variantMapData[`default:${colorId || 'default'}`] ||
                          variantMapData['default:default'] ||
                          Object.values(variantMapData)[0];
      
      if (!variantData || !variantData.printifyVariantId) {
        return res.status(400).json({ 
          error: "Could not resolve product variant",
          availableKeys: Object.keys(variantMapData)
        });
      }
      
      const providerId = variantData.providerId || productType.printifyProviderId || 1;
      const targetVariantId = variantData.printifyVariantId;

      console.log("[Shopify Mockup] Generating mockup for:", { productTypeId, sizeId, colorId, variantId: targetVariantId });

      const result = await generatePrintifyMockup({
        blueprintId: productType.printifyBlueprintId,
        providerId,
        variantId: targetVariantId,
        imageUrl: absoluteImageUrl,
        printifyApiToken: merchant.printifyApiToken,
        printifyShopId: merchant.printifyShopId,
        scale: scale ? scale / 100 : 1,
        x: x !== undefined ? (x - 50) / 50 : 0,
        y: y !== undefined ? (y - 50) / 50 : 0,
        doubleSided: resolveDoubleSided(productType),
        wrapAround: resolveWrapAround(productType),
        wrapDirection: resolveWrapAround(productType) ? resolveWrapDirection(productType) : undefined,
        aopPositions: productType.isAllOverPrint && productType.placeholderPositions
          ? JSON.parse(productType.placeholderPositions as string)
          : undefined,
        mirrorLegs: !!mirrorLegs,
        panelUrls: Array.isArray(panelUrls) && panelUrls.length > 0 ? panelUrls : undefined,
      });

      console.log("[Shopify Mockup] Generated result:", { success: result.success, mockupCount: result.mockupUrls?.length });
      res.json(result);
    } catch (error) {
      console.error("[Shopify Mockup] Error generating mockup:", error);
      res.status(500).json({ error: "Failed to generate mockup" });
    }
  });

  // Auto-run shadow SKU cleanup every 6 hours
  setInterval(() => {
    runDesignSkuCleanup().catch((e: Error) => console.error("[Design SKU Cleanup] Interval error:", e));
  }, 6 * 60 * 60 * 1000);

  // ─────────────────────────────────────────────────────────────────────────
  // CUSTOMIZER PAGES — Admin API (requires Shopify JWT auth)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Resolve the Shopify installation from the JWT's shop domain.
   * Used by all /api/appai/* routes — no app-level merchant account required.
   * The Shopify session token (validated by isAuthenticated) attaches req.shopDomain.
   *
   * Error codes returned to client:
   *   NOT_AUTHENTICATED  — no shop in JWT
   *   SHOP_NOT_CONNECTED — no installation row found
   *   REAUTH_REQUIRED    — installation exists but token is invalid (needs OAuth re-install)
   *   SHOP_NOT_ACTIVE    — installation exists but is inactive/uninstalled
   */
  async function resolveShopInstallation(req: any): Promise<
    | { ok: true; installation: any }
    | { ok: false; status: number; error: string; reinstallUrl?: string }
  > {
    const rawDomain = req.shopDomain as string | undefined;
    if (!rawDomain) {
      console.log("[resolver] NOT_AUTHENTICATED — no shopDomain on request");
      return { ok: false, status: 401, error: "NOT_AUTHENTICATED" };
    }

    // Normalize: strip any protocol prefix, lowercase
    const shopDomain = rawDomain.toLowerCase().replace(/^https?:\/\//, "");

    const installation = await storage.getShopifyInstallationByShop(shopDomain);

    if (!installation) {
      console.log(`[resolver] SHOP_NOT_CONNECTED: ${shopDomain}`);
      return { ok: false, status: 400, error: "SHOP_NOT_CONNECTED" };
    }

    if (installation.status === "token_invalid") {
      console.log(`[resolver] REAUTH_REQUIRED: ${shopDomain}`);
      return {
        ok: false,
        status: 401,
        error: "REAUTH_REQUIRED",
        reinstallUrl: `/shopify/install?shop=${encodeURIComponent(shopDomain)}`,
      };
    }

    if (installation.status !== "active") {
      console.log(`[resolver] SHOP_NOT_ACTIVE: ${shopDomain} (status=${installation.status})`);
      return { ok: false, status: 403, error: "SHOP_NOT_ACTIVE" };
    }

    return { ok: true, installation };
  }

  /**
   * Legacy helper kept for older routes that still look up a merchant.
   * New /api/appai/* routes use resolveShopInstallation instead.
   */
  async function resolveInstallation(req: any): Promise<{
    ok: true; merchant: any; installation: any;
  } | { ok: false; status: number; error: string }> {
    const userId = req.user?.claims?.sub;
    if (!userId) return { ok: false, status: 401, error: "Not authenticated" };

    const merchant = await storage.getMerchantByUserId(userId);
    if (!merchant) return { ok: false, status: 403, error: "Merchant not found" };

    const shopDomain: string | undefined = req.body?.shopDomain ?? req.query?.shopDomain;
    if (!shopDomain) {
      const installations = await storage.getShopifyInstallationsByMerchant?.(merchant.id) ?? [];
      const active = installations.find((i: any) => i.status === "active");
      if (!active) return { ok: false, status: 400, error: "No active Shopify store connected" };
      return { ok: true, merchant, installation: active };
    }

    const installation = await storage.getShopifyInstallationByShop(shopDomain);
    if (!installation || installation.status !== "active") {
      return { ok: false, status: 400, error: "Shopify store not connected or not active" };
    }
    if (!installation.merchantId) {
      await storage.updateShopifyInstallation(installation.id, { merchantId: merchant.id });
    }
    return { ok: true, merchant, installation };
  }

  /** GET /api/appai/customizer-pages */
  app.get("/api/appai/customizer-pages", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    const resolved = await resolveShopInstallation(req);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, ...(resolved.reinstallUrl ? { reinstallUrl: resolved.reinstallUrl } : {}) });

    const { installation } = resolved;
    const shop: string = installation.shopDomain;

    const [pages, activeCount] = await Promise.all([
      storage.listCustomizerPages(shop),
      storage.countActiveCustomizerPages(shop),
    ]);

    // Backfill any pages that are missing baseProductHandle or productTypeId.
    // These were created before we started storing those fields.
    // Runs in the background — we await all, but individual failures are swallowed.
    const backfillResults = await Promise.allSettled(
      pages
        .filter((p) => p.baseVariantId && (!(p as any).baseProductHandle || !p.productTypeId))
        .map(async (p) => {
          try {
            const varRes = await shopifyApiCall(
              shop, installation.accessToken,
              `variants/${p.baseVariantId}.json?fields=id,product_id`
            );
            if (!varRes.ok || !varRes.data?.variant?.product_id) return;
            const productId = String(varRes.data.variant.product_id);

            const prodRes = await shopifyApiCall(
              shop, installation.accessToken,
              `products/${productId}.json?fields=id,handle`
            );
            const productHandle: string = prodRes.data?.product?.handle ?? "";

            const allTypes = await storage.getActiveProductTypes();
            const matchedType = allTypes.find(
              (pt: any) => String(pt.shopifyProductId) === productId
            );

            const updates: any = {};
            if (!(p as any).baseProductHandle && productHandle) {
              updates.baseProductHandle = productHandle;
            }
            if (!p.productTypeId && matchedType?.id) {
              updates.productTypeId = matchedType.id;
            }
            if (Object.keys(updates).length > 0) {
              await storage.updateCustomizerPage(p.id, updates);
              console.log(`[backfill] Updated page ${p.id} (${p.handle}):`, updates);
              // Mutate the in-memory object so the response is already up-to-date
              Object.assign(p, updates);
            }
          } catch (e: any) {
            console.warn(`[backfill] Could not backfill page ${p.id}:`, e?.message ?? e);
          }
        })
    );
    if (backfillResults.some((r) => r.status === "rejected")) {
      console.warn("[backfill] Some backfill tasks rejected unexpectedly");
    }

    const plan = getEffectivePlan(installation as any, shop);

    return res.json({
      pages,
      limit: plan.pageLimit,
      count: activeCount,
      planTier: plan.planName ?? "none",
      planName: plan.planName,
      planStatus: plan.planStatus,
      requiresPlan: plan.requiresPlan,
      overLimit: activeCount > plan.pageLimit && plan.isActive,
    });
  }));

  /** POST /api/appai/customizer-pages */
  app.post("/api/appai/customizer-pages", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    const resolved = await resolveShopInstallation(req);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, ...(resolved.reinstallUrl ? { reinstallUrl: resolved.reinstallUrl } : {}) });

    const { installation } = resolved;
    const shop: string = installation.shopDomain;

    const { title, handle, baseVariantId, baseProductId, productTypeId: incomingProductTypeId, variantPrices } = req.body as {
      title?: string;
      handle?: string;
      baseVariantId?: string;
      baseProductId?: string;
      productTypeId?: number;
      variantPrices?: Record<string, string>;
    };

    if (!title?.trim()) return res.status(400).json({ error: "Title is required" });
    if (!handle?.trim()) return res.status(400).json({ error: "Handle is required" });
    if (!baseVariantId && !baseProductId && !incomingProductTypeId) return res.status(400).json({ error: "baseProductId or productTypeId is required" });

    // Validate handle format
    if (!/^[a-z0-9][a-z0-9-]*$/.test(handle)) {
      return res.status(400).json({ error: "Handle must be lowercase letters, numbers, and hyphens only" });
    }

    // Plan gate: must have an active plan before creating pages
    const plan = getEffectivePlan(installation as any, shop);
    if (plan.requiresPlan) {
      return res.status(402).json({
        error: "No active plan. Start a free trial or pick a plan to create customizer pages.",
        requiresPlan: true,
      });
    }

    // Uniqueness check
    const existing = await storage.getCustomizerPageByHandle(shop, handle);
    if (existing) return res.status(409).json({ error: `Handle "${handle}" is already in use` });

    // If a productTypeId is provided but no shopify product exists yet, auto-send it to Shopify as a draft.
    let resolvedBaseProductId = baseProductId;
    if (!baseVariantId && !baseProductId && incomingProductTypeId) {
      const ptForSync = await storage.getProductType(incomingProductTypeId);
      if (!ptForSync) return res.status(400).json({ error: `Product type ${incomingProductTypeId} not found` });

      if (ptForSync.shopifyProductId) {
        // Already sent to Shopify previously — verify the product still exists and has all variants.
        // If the product was deleted from Shopify or has fewer variants than expected (e.g. after
        // Refresh Variants), clear the stale ID so the create-new-product path below handles it.
        try {
          const shopifyProdCheck = await shopifyApiCall(
            shop, installation.accessToken,
            `products/${ptForSync.shopifyProductId}.json?fields=id,variants`,
          );

          if (!shopifyProdCheck.ok || !shopifyProdCheck.data?.product) {
            // Product no longer exists in Shopify — clear stale ID so we re-create it below
            console.log(`[customizer-pages] Product ${ptForSync.shopifyProductId} not found in Shopify (deleted?). Clearing stale ID.`);
            await storage.updateProductType(incomingProductTypeId!, {
              shopifyProductId: null,
              shopifyProductHandle: null,
              shopifyProductUrl: null,
              shopifyShopDomain: null,
              shopifyVariantIds: null,
            });
            ptForSync.shopifyProductId = null;
          } else {
            // Product exists — check if variant count matches
            const allSizes = typeof ptForSync.sizes === 'string' ? JSON.parse(ptForSync.sizes || '[]') : (ptForSync.sizes || []);
            const allColors = typeof ptForSync.frameColors === 'string' ? JSON.parse(ptForSync.frameColors || '[]') : (ptForSync.frameColors || []);
            const savedSizeIds: string[] = typeof ptForSync.selectedSizeIds === 'string' ? JSON.parse(ptForSync.selectedSizeIds || '[]') : (ptForSync.selectedSizeIds || []);
            const savedColorIds: string[] = typeof ptForSync.selectedColorIds === 'string' ? JSON.parse(ptForSync.selectedColorIds || '[]') : (ptForSync.selectedColorIds || []);
            const activeSizes = savedSizeIds.length ? allSizes.filter((s: any) => savedSizeIds.includes(s.id)) : allSizes;
            const activeColors = savedColorIds.length ? allColors.filter((c: any) => savedColorIds.includes(c.id)) : allColors;
            const expectedVariantCount = activeColors.length > 0 ? activeSizes.length * activeColors.length : activeSizes.length;
            const shopifyVariantCount = shopifyProdCheck.data.product.variants?.length ?? 0;

            if (shopifyVariantCount < expectedVariantCount) {
              // Fewer variants than expected (e.g. after Refresh Variants) — clear and re-create
              console.log(`[customizer-pages] Product ${ptForSync.shopifyProductId} has ${shopifyVariantCount} Shopify variants but DB expects ${expectedVariantCount}. Clearing for re-creation.`);
              await storage.updateProductType(incomingProductTypeId!, {
                shopifyProductId: null,
                shopifyProductHandle: null,
                shopifyProductUrl: null,
                shopifyShopDomain: null,
                shopifyVariantIds: null,
              });
              ptForSync.shopifyProductId = null;
            }
          }
        } catch (syncCheckErr: any) {
          console.warn(`[customizer-pages] Variant count check failed: ${syncCheckErr.message}`);
        }
        resolvedBaseProductId = ptForSync.shopifyProductId ?? undefined;
      }

      // If resolvedBaseProductId is still unset (either never sent to Shopify, or stale ID was cleared above),
      // auto-publish the product to Shopify now.
      if (!resolvedBaseProductId) {
        try {
          const { shopifyProductId } = await createShopifyProductForType(shop, installation.accessToken, ptForSync, merchant, []);
          resolvedBaseProductId = shopifyProductId;
        } catch (e: any) {
          return res.status(400).json({ error: e.message || "Failed to send product to Shopify. Try using Generator Tester to send it first." });
        }
        if (!resolvedBaseProductId) {
          return res.status(400).json({ error: "Product was sent to Shopify but no product ID was returned. Try again." });
        }
      }
    }

    // Plan limit check - only for ACTIVE pages
    const activeCount = await storage.countActiveCustomizerPages(shop);
    const { allowed, limit } = canCreatePage(plan.planName, activeCount);
    
    // We allow creating INACTIVE pages even if over limit
    const initialStatus = allowed ? "active" : "disabled";

    // Resolve variant + product info via Admin API.
    // New flow: merchant selects a product → fetch product and use its first variant.
    // Legacy flow: merchant sends baseVariantId directly → look up variant then product.
    let variant: any;
    let productTitle: string;
    let productHandle: string;

    if (resolvedBaseProductId && !baseVariantId) {
      // New product-level flow
      const productNum = parseInt(String(resolvedBaseProductId).replace(/\D/g, ""), 10);
      if (!productNum) return res.status(400).json({ error: "Invalid baseProductId" });

      const prodResult = await shopifyApiCall(
        shop,
        installation.accessToken,
        `products/${productNum}.json?fields=id,title,handle,variants`,
      );
      if (!prodResult.ok || !prodResult.data?.product) {
        // Product not found — stale ID in DB. Clear it and re-create the product on Shopify.
        console.log(`[customizer-pages] Product ${resolvedBaseProductId} not found (stale ID). Clearing and re-creating...`);
        if (incomingProductTypeId) {
          await storage.updateProductType(incomingProductTypeId, {
            shopifyProductId: null as any,
            shopifyProductHandle: null as any,
            shopifyProductUrl: null as any,
            shopifyShopDomain: null as any,
            shopifyVariantIds: null as any,
          });
          try {
            const { shopifyProductId } = await createShopifyProductForType(shop, installation.accessToken, ptForSync, merchant, []);
            resolvedBaseProductId = shopifyProductId;
          } catch (e: any) {
            return res.status(400).json({ error: e.message || `Product ${resolvedBaseProductId} not found in Shopify. Please send it to Shopify first.` });
          }
          if (!resolvedBaseProductId) {
            return res.status(400).json({ error: "Product was re-created on Shopify but no product ID was returned. Try again." });
          }
          // Re-fetch the newly created product
          const newProdResult = await shopifyApiCall(shop, installation.accessToken, `products/${resolvedBaseProductId}.json?fields=id,title,handle,variants`);
          if (!newProdResult.ok || !newProdResult.data?.product) {
            return res.status(400).json({ error: `Newly created product ${resolvedBaseProductId} not found. Please try again.` });
          }
          const product = newProdResult.data.product;
          const firstVariant = product.variants?.[0];
          if (!firstVariant) return res.status(400).json({ error: `Product ${resolvedBaseProductId} has no variants` });
          variant = firstVariant;
          productTitle = product.title ?? "";
          productHandle = product.handle ?? "";
        } else {
          return res.status(400).json({ error: `Product ${resolvedBaseProductId} not found in this store` });
        }
      } else {
        const product = prodResult.data.product;
        const firstVariant = product.variants?.[0];
        if (!firstVariant) {
          return res.status(400).json({ error: `Product ${resolvedBaseProductId} has no variants` });
        }
        variant = firstVariant;
        productTitle = product.title ?? "";
        productHandle = product.handle ?? "";
      }
    } else {
      // Legacy variant-level flow (backward compat)
      const variantNum = parseInt(String(baseVariantId).replace(/\D/g, ""), 10);
      if (!variantNum) return res.status(400).json({ error: "Invalid baseVariantId" });

      const variantResult = await shopifyApiCall(
        shop,
        installation.accessToken,
        `variants/${variantNum}.json?fields=id,product_id,title,price`,
      );
      if (!variantResult.ok || !variantResult.data?.variant) {
        return res.status(400).json({ error: `Variant ${baseVariantId} not found in this store` });
      }
      variant = variantResult.data.variant;

      const productResult = await shopifyApiCall(
        shop,
        installation.accessToken,
        `products/${variant.product_id}.json?fields=id,title,handle`,
      );
      productTitle = productResult.data?.product?.title ?? "";
      productHandle = productResult.data?.product?.handle ?? "";
    }

    // Resolve productTypeId by matching the Shopify product ID against our productTypes table
    const productTypes = await storage.getActiveProductTypes();
    const matchedType = productTypes.find(
      (pt: any) => String(pt.shopifyProductId) === String(variant.product_id)
    );
    const resolvedProductTypeId: number | null = matchedType?.id ?? null;

    // ── Write variant prices to Shopify ──────────────────────────────────────
    if (variantPrices && typeof variantPrices === "object") {
      const priceEntries = Object.entries(variantPrices);
      if (priceEntries.length > 0) {
        // Validate all prices before writing any
        for (const [vid, price] of priceEntries) {
          const num = parseFloat(String(price));
          if (isNaN(num) || num <= 0) {
            return res.status(400).json({ error: `Invalid price for variant ${vid}: "${price}". Must be a positive number.` });
          }
        }

        // Build a printifyVariantId → shopifyVariantId mapping for products that
        // were just sent to Shopify (variantPrices keyed by "printify:XXXXX").
        // Strategy: use shopifyVariantIds (sizeName:colorName → shopifyVid) + variantMap
        // (sizeId:colorId → printifyVariantId) + sizes/frameColors to bridge the gap.
        const printifyToShopifyVariantId: Record<string, number> = {};
        if (matchedType?.variantMap) {
          const storedVm = typeof matchedType.variantMap === "string"
            ? JSON.parse(matchedType.variantMap || "{}")
            : (matchedType.variantMap || {});
          const svIds = (typeof matchedType.shopifyVariantIds === "string"
            ? JSON.parse(matchedType.shopifyVariantIds || "{}")
            : (matchedType.shopifyVariantIds || {})) as Record<string, number>;
          const ptSizes = (typeof (matchedType as any).sizes === "string"
            ? JSON.parse((matchedType as any).sizes || "[]")
            : ((matchedType as any).sizes || [])) as Array<{id: string; name: string}>;
          const ptColors = (typeof (matchedType as any).frameColors === "string"
            ? JSON.parse((matchedType as any).frameColors || "[]")
            : ((matchedType as any).frameColors || [])) as Array<{id: string; name: string}>;

          // Build sizeName:colorName → shopifyVariantId from stored shopifyVariantIds
          // (keys may be either sizeName:colorName or sizeId:colorId depending on when stored)
          // Also build sizeId:colorId → shopifyVariantId via name bridging
          const nameToShopifyId: Record<string, number> = {};
          for (const [mapKey, shopifyVid] of Object.entries(svIds)) {
            nameToShopifyId[mapKey] = shopifyVid as number;
            // Try to also add a name-based key if mapKey looks like IDs
            const [kSizeId, kColorId] = mapKey.split(":");
            const sizeName = ptSizes.find((s: any) => String(s.id) === kSizeId)?.name;
            const colorName = ptColors.find((c: any) => String(c.id) === kColorId)?.name;
            if (sizeName) {
              const nameKey = colorName ? `${sizeName}:${colorName}` : `${sizeName}:default`;
              nameToShopifyId[nameKey] = shopifyVid as number;
            }
          }

          // Map printifyVariantId → shopifyVariantId via variantMap
          for (const [vmKey, entry] of Object.entries(storedVm)) {
            const e = entry as any;
            if (!e.printifyVariantId) continue;
            const [sizeId, colorId] = vmKey.split(":");
            const sizeName = ptSizes.find((s: any) => String(s.id) === sizeId)?.name ?? sizeId;
            const colorName = ptColors.find((c: any) => String(c.id) === colorId)?.name;
            // Try multiple key formats to find the shopify variant ID
            const candidates = [
              vmKey,                                                          // sizeId:colorId
              colorName ? `${sizeName}:${colorName}` : `${sizeName}:default`, // sizeName:colorName
              `${sizeName}:${colorId}`,                                        // sizeName:colorId
              `${sizeId}:${colorName ?? colorId}`,                             // sizeId:colorName
            ];
            for (const candidate of candidates) {
              if (nameToShopifyId[candidate]) {
                printifyToShopifyVariantId[String(e.printifyVariantId)] = nameToShopifyId[candidate];
                break;
              }
            }
          }

          // Fallback: match by Shopify variant title (handles material variants like Polyester/Microfiber)
          if (Object.keys(printifyToShopifyVariantId).length === 0) {
            const allVariantsResult = await shopifyApiCall(
              shop, installation.accessToken,
              `products/${variant.product_id}.json?fields=id,variants`,
            );
            const allShopifyVariants: any[] = allVariantsResult.data?.product?.variants ?? [];
            // Build title → shopify variant ID map (full title, option1, and option1 / option2)
            const titleToShopifyId: Record<string, number> = {};
            for (const sv of allShopifyVariants) {
              if (sv.title) titleToShopifyId[sv.title.toLowerCase()] = sv.id;
              if (sv.option1) titleToShopifyId[sv.option1.toLowerCase()] = sv.id;
              if (sv.option1 && sv.option2) titleToShopifyId[`${sv.option1} / ${sv.option2}`.toLowerCase()] = sv.id;
            }
            for (const [vmKey, entry] of Object.entries(storedVm)) {
              const e = entry as any;
              if (!e.printifyVariantId) continue;
              const [sizeId, colorId] = vmKey.split(":");
              const sizeName = ptSizes.find((s: any) => String(s.id) === sizeId)?.name ?? sizeId;
              const colorName = ptColors.find((c: any) => String(c.id) === colorId)?.name;
              // Try size / material first, then size alone
              const shopifyId = (colorName ? titleToShopifyId[`${sizeName} / ${colorName}`.toLowerCase()] : undefined)
                ?? titleToShopifyId[sizeName.toLowerCase()];
              if (shopifyId) {
                printifyToShopifyVariantId[String(e.printifyVariantId)] = shopifyId;
              }
            }
          }

          console.log(`[customizer-pages] printifyToShopifyVariantId mapping built: ${JSON.stringify(printifyToShopifyVariantId)}`);
        }

        // Write prices to Shopify
        for (const [vid, price] of priceEntries) {
          let variantNum: number;
          if (String(vid).startsWith("printify:")) {
            // Map printify:XXXXX → real Shopify variant ID
            const printifyId = String(vid).replace("printify:", "");
            variantNum = printifyToShopifyVariantId[printifyId] ?? 0;
          } else {
            variantNum = parseInt(String(vid).replace(/\D/g, ""), 10);
          }
          if (!variantNum) continue;
          const formatted = parseFloat(String(price)).toFixed(2);
          const priceResult = await shopifyApiCall(shop, installation.accessToken, `variants/${variantNum}.json`, {
            method: "PUT",
            body: JSON.stringify({ variant: { id: variantNum, price: formatted } }),
          });
          if (!priceResult.ok) {
            console.warn(`[customizer-pages] Failed to update price for variant ${vid}: ${priceResult.error}`);
          }
          // If this variant is the one we're using as the base, update local record
          if (String(variantNum) === String(variant.id)) {
            variant = { ...variant, price: formatted };
          }
        }
      }
    }

    // ── Ensure product is published to Online Store (but keep status as unlisted) ──
    // Shopify's "unlisted" status keeps the product hidden from collections/search
    // but still accessible via direct URL and purchasable via /cart/add.js.
    // We do NOT force status: "active" here — that would make the product visible
    // in the storefront catalog, which is not desired.
    {
      const productIdNum = parseInt(String(variant.product_id).replace(/\D/g, ""), 10);
      if (productIdNum) {
        // Ensure the product is published to the Online Store sales channel
        // (required for the customizer page URL to resolve and for /cart/add.js)
        try {
          await ensureProductPublishedToOnlineStore(shop, installation.accessToken, productIdNum);
          console.log(`[customizer-pages] Product ${productIdNum} published to Online Store (unlisted)`);
        } catch (pubErr: any) {
          console.warn(`[customizer-pages] Failed to publish product ${productIdNum} to Online Store: ${pubErr.message}`);
        }
      }
    }

    // Create Shopify Page
    // First, check if a page with this handle already exists and delete it
    // (can happen if a previous creation attempt left a stale Shopify page)
    try {
      const existingPageRes = await shopifyApiCall(
        shop,
        installation.accessToken,
        `pages.json?handle=${encodeURIComponent(handle.trim())}`,
        { method: "GET" }
      );
      if (existingPageRes.ok && existingPageRes.data?.pages?.length > 0) {
        const existingPageId = existingPageRes.data.pages[0].id;
        console.log(`[customizer-pages] Deleting stale Shopify page ${existingPageId} with handle '${handle.trim()}'`);
        await shopifyApiCall(
          shop,
          installation.accessToken,
          `pages/${existingPageId}.json`,
          { method: "DELETE" }
        );
      }
    } catch (cleanupErr: any) {
      console.warn(`[customizer-pages] Could not clean up existing page: ${cleanupErr.message}`);
    }

    const pageBody = await shopifyApiCall(
      shop,
      installation.accessToken,
      "pages.json",
      {
        method: "POST",
        body: JSON.stringify({
          page: {
            title: title.trim(),
            handle: handle.trim(),
            body_html: "",
            published: true,
          },
        }),
      }
    );
    if (!pageBody.ok || !pageBody.data?.page?.id) {
      return res.status(500).json({ error: `Failed to create Shopify page: ${pageBody.error ?? "unknown error"}` });
    }
    const shopifyPage = pageBody.data.page;

    // Save DB record
    const page = await storage.createCustomizerPage({
      shop,
      shopifyPageId: String(shopifyPage.id),
      handle: handle.trim(),
      title: title.trim(),
      baseVariantId: String(variant.id),
      baseProductId: String(variant.product_id),
      baseProductHandle: productHandle,
      baseProductTitle: productTitle,
      baseVariantTitle: variant.title ?? "",
      baseProductPrice: variant.price ?? "",
      productTypeId: resolvedProductTypeId,
      status: initialStatus,
    });

    // ── Add navigation menu link (only if active) ──────────────────────────────
    let navWarning: string | null = null;
    if (initialStatus === "active") {
      try {
        const navResult = await ensureNavigationLink(shop, installation.accessToken, handle.trim(), title.trim());
        if (navResult.warning) navWarning = navResult.warning;
      } catch (navErr: any) {
        navWarning = navErr.message ?? "Navigation link could not be added";
        console.warn(`[customizer-pages] Nav link step failed: ${navWarning}`);
      }
    }

    return res.status(201).json({
      page,
      storefrontUrl: `/pages/${page.handle}`,
      navWarning,
    });
  }));

  /** PATCH /api/appai/customizer-pages/:id */
  app.patch("/api/appai/customizer-pages/:id", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    const resolved = await resolveShopInstallation(req);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, ...(resolved.reinstallUrl ? { reinstallUrl: resolved.reinstallUrl } : {}) });

    const { installation } = resolved;
    const shop: string = installation.shopDomain;

    const dbPage = await storage.getCustomizerPageForShop(req.params.id, shop);
    if (!dbPage) {
      console.warn(`[PATCH customizer-page] NOT_FOUND or SHOP_MISMATCH id=${req.params.id} shop=${shop}`);
      return res.status(404).json({ error: "Page not found" });
    }

    const updates: Partial<CustomizerPage> = {};

    if (req.body.title !== undefined) {
      updates.title = String(req.body.title).trim();
    }
    if (req.body.status !== undefined) {
      const s = req.body.status;
      if (s !== "active" && s !== "disabled") {
        return res.status(400).json({ error: 'Status must be "active" or "disabled"' });
      }
      
      if (s === "active" && dbPage.status !== "active") {
        // Plan limit check
        const plan = getEffectivePlan(installation as any, shop);
        const activeCount = await storage.countActiveCustomizerPages(shop);
        const { allowed, limit } = canCreatePage(plan.planName, activeCount);
        if (!allowed) {
          return res.status(402).json({
            error: `Plan limit reached. Your ${plan.displayName} plan allows ${limit} active customizer page${limit === 1 ? "" : "s"}. Upgrade to activate more.`,
            limit,
            activeCount,
            planName: plan.planName,
          });
        }
      }
      
      updates.status = s;
    }
    if (req.body.baseVariantId !== undefined) {
      const variantNum = parseInt(String(req.body.baseVariantId).replace(/\D/g, ""), 10);
      if (!variantNum) return res.status(400).json({ error: "Invalid baseVariantId" });
      const variantResult = await shopifyApiCall(
        shop,
        installation.accessToken,
        `variants/${variantNum}.json?fields=id,product_id,title,price`,
      );
      if (!variantResult.ok || !variantResult.data?.variant) {
        return res.status(400).json({ error: `Variant ${req.body.baseVariantId} not found in this store` });
      }
      const v = variantResult.data.variant;
      updates.baseVariantId = String(variantNum);
      updates.baseProductId = String(v.product_id);
      updates.baseVariantTitle = v.title ?? "";
      updates.baseProductPrice = v.price ?? "";
    }

    // Sync title to Shopify page if changed
    if (updates.title && dbPage.shopifyPageId) {
      await shopifyApiCall(
        shop,
        installation.accessToken,
        `pages/${dbPage.shopifyPageId}.json`,
        { method: "PUT", body: JSON.stringify({ page: { title: updates.title } }) }
      );
    }

    // Manage navigation menu link on status change (best-effort)
    if (updates.status === "disabled" && dbPage.status === "active") {
      // Page is being disabled — remove from menu
      await removeNavigationLink(shop, installation.accessToken, dbPage.handle)
        .catch((e: Error) => console.warn("[PATCH customizer-page] Could not remove nav link:", e.message));
    } else if (updates.status === "active" && dbPage.status === "disabled") {
      // Page is being re-enabled — add back to menu
      const pageTitle = updates.title ?? dbPage.title;
      await ensureNavigationLink(shop, installation.accessToken, dbPage.handle, pageTitle)
        .catch((e: Error) => console.warn("[PATCH customizer-page] Could not re-add nav link:", e.message));
    }

    const updated = await storage.updateCustomizerPage(dbPage.id, updates);
    return res.json({ page: updated });
  }));

  /** DELETE /api/appai/customizer-pages/:id */
  app.delete("/api/appai/customizer-pages/:id", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    const resolved = await resolveShopInstallation(req);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, ...(resolved.reinstallUrl ? { reinstallUrl: resolved.reinstallUrl } : {}) });

    const { installation } = resolved;
    const shop: string = installation.shopDomain;

    console.log(`[DELETE customizer-page] id=${req.params.id} shop=${shop}`);
    const dbPage = await storage.getCustomizerPageForShop(req.params.id, shop);
    if (!dbPage) {
      const anyPage = await storage.getCustomizerPage(req.params.id);
      if (anyPage) {
        console.warn(`[DELETE customizer-page] SHOP_MISMATCH id=${req.params.id} stored="${anyPage.shop}" request="${shop}"`);
      } else {
        console.warn(`[DELETE customizer-page] NOT_FOUND id=${req.params.id} shop=${shop}`);
      }
      return res.status(404).json({ error: "Page not found" });
    }

    // Delete Shopify page (best-effort)
    if (dbPage.shopifyPageId) {
      await shopifyApiCall(
        shop,
        installation.accessToken,
        `pages/${dbPage.shopifyPageId}.json`,
        { method: "DELETE" }
      ).catch((e: Error) => console.warn("[Customizer Pages] Could not delete Shopify page:", e.message));
    }

    // Remove navigation menu link (best-effort)
    await removeNavigationLink(shop, installation.accessToken, dbPage.handle)
      .catch((e: Error) => console.warn("[Customizer Pages] Could not remove nav link:", e.message));

    await storage.deleteCustomizerPage(dbPage.id);
    return res.json({ success: true });
  }));

  /** POST /api/appai/customizer-pages/:id/sync-prices — update Shopify variant prices for an existing page */
  app.post("/api/appai/customizer-pages/:id/sync-prices", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    const resolved = await resolveShopInstallation(req);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, ...(resolved.reinstallUrl ? { reinstallUrl: resolved.reinstallUrl } : {}) });

    const { installation } = resolved;
    const shop: string = installation.shopDomain;

    const dbPage = await storage.getCustomizerPageForShop(req.params.id, shop);
    if (!dbPage) return res.status(404).json({ error: "Page not found" });

    const { variantPrices } = req.body as { variantPrices?: Record<string, string> };
    if (!variantPrices || typeof variantPrices !== "object" || Object.keys(variantPrices).length === 0) {
      return res.status(400).json({ error: "variantPrices is required" });
    }

    // Validate all prices
    for (const [vid, price] of Object.entries(variantPrices)) {
      const num = parseFloat(String(price));
      if (isNaN(num) || num <= 0) {
        return res.status(400).json({ error: `Invalid price for variant ${vid}: "${price}". Must be a positive number.` });
      }
    }

    // Find the product type for this page
    const productTypes = await storage.getActiveProductTypes();
    const matchedType = productTypes.find(
      (pt: any) => String(pt.shopifyProductId) === String(dbPage.baseProductId)
    );

    // Build printifyVariantId → shopifyVariantId mapping
    const printifyToShopifyVariantId: Record<string, number> = {};
    if (matchedType?.variantMap) {
      const storedVm = typeof matchedType.variantMap === "string"
        ? JSON.parse(matchedType.variantMap || "{}")
        : (matchedType.variantMap || {});
      const svIds = (typeof matchedType.shopifyVariantIds === "string"
        ? JSON.parse(matchedType.shopifyVariantIds || "{}")
        : (matchedType.shopifyVariantIds || {})) as Record<string, number>;
      const ptSizes = (typeof (matchedType as any).sizes === "string"
        ? JSON.parse((matchedType as any).sizes || "[]")
        : ((matchedType as any).sizes || [])) as Array<{id: string; name: string}>;
      const ptColors = (typeof (matchedType as any).frameColors === "string"
        ? JSON.parse((matchedType as any).frameColors || "[]")
        : ((matchedType as any).frameColors || [])) as Array<{id: string; name: string}>;

      const nameToShopifyId: Record<string, number> = {};
      for (const [mapKey, shopifyVid] of Object.entries(svIds)) {
        nameToShopifyId[mapKey] = shopifyVid as number;
        const [kSizeId, kColorId] = mapKey.split(":");
        const sizeName = ptSizes.find((s: any) => String(s.id) === kSizeId)?.name;
        const colorName = ptColors.find((c: any) => String(c.id) === kColorId)?.name;
        if (sizeName) {
          const nameKey = colorName ? `${sizeName}:${colorName}` : `${sizeName}:default`;
          nameToShopifyId[nameKey] = shopifyVid as number;
        }
      }

      for (const [vmKey, entry] of Object.entries(storedVm)) {
        const e = entry as any;
        if (!e.printifyVariantId) continue;
        const [sizeId, colorId] = vmKey.split(":");
        const sizeName = ptSizes.find((s: any) => String(s.id) === sizeId)?.name ?? sizeId;
        const colorName = ptColors.find((c: any) => String(c.id) === colorId)?.name;
        const candidates = [
          vmKey,
          colorName ? `${sizeName}:${colorName}` : `${sizeName}:default`,
          `${sizeName}:${colorId}`,
          `${sizeId}:${colorName ?? colorId}`,
        ];
        for (const candidate of candidates) {
          if (nameToShopifyId[candidate]) {
            printifyToShopifyVariantId[String(e.printifyVariantId)] = nameToShopifyId[candidate];
            break;
          }
        }
      }

      // Fallback: match by title from live Shopify variants
      if (Object.keys(printifyToShopifyVariantId).length === 0) {
        const allVariantsResult = await shopifyApiCall(
          shop, installation.accessToken,
          `products/${dbPage.baseProductId}.json?fields=id,variants`,
        );
        const allShopifyVariants: any[] = allVariantsResult.data?.product?.variants ?? [];
        const titleToShopifyId: Record<string, number> = {};
        for (const sv of allShopifyVariants) {
          if (sv.title) titleToShopifyId[sv.title.toLowerCase()] = sv.id;
          if (sv.option1) titleToShopifyId[sv.option1.toLowerCase()] = sv.id;
          if (sv.option1 && sv.option2) titleToShopifyId[`${sv.option1} / ${sv.option2}`.toLowerCase()] = sv.id;
        }
        for (const [vmKey, entry] of Object.entries(storedVm)) {
          const e = entry as any;
          if (!e.printifyVariantId) continue;
          const [sizeId, colorId] = vmKey.split(":");
          const sizeName = ptSizes.find((s: any) => String(s.id) === sizeId)?.name ?? sizeId;
          const colorName = ptColors.find((c: any) => String(c.id) === colorId)?.name;
          const shopifyId = (colorName ? titleToShopifyId[`${sizeName} / ${colorName}`.toLowerCase()] : undefined)
            ?? titleToShopifyId[sizeName.toLowerCase()];
          if (shopifyId) {
            printifyToShopifyVariantId[String(e.printifyVariantId)] = shopifyId;
          }
        }
      }
    }

    console.log(`[sync-prices] printifyToShopifyVariantId: ${JSON.stringify(printifyToShopifyVariantId)}`);

    // Also fetch live Shopify variants for direct ID matching
    const allVariantsResult = await shopifyApiCall(
      shop, installation.accessToken,
      `products/${dbPage.baseProductId}.json?fields=id,variants`,
    );
    const allShopifyVariants: any[] = allVariantsResult.data?.product?.variants ?? [];

    const updated: Array<{ variantId: number; price: string; success: boolean; error?: string }> = [];

    for (const [vid, price] of Object.entries(variantPrices)) {
      let variantNum: number;
      if (String(vid).startsWith("printify:")) {
        const printifyId = String(vid).replace("printify:", "");
        variantNum = printifyToShopifyVariantId[printifyId] ?? 0;
      } else {
        variantNum = parseInt(String(vid).replace(/\D/g, ""), 10);
      }
      if (!variantNum) {
        updated.push({ variantId: 0, price, success: false, error: `Could not resolve Shopify variant ID for key "${vid}"` });
        continue;
      }
      const formatted = parseFloat(String(price)).toFixed(2);
      const priceResult = await shopifyApiCall(shop, installation.accessToken, `variants/${variantNum}.json`, {
        method: "PUT",
        body: JSON.stringify({ variant: { id: variantNum, price: formatted } }),
      });
      if (priceResult.ok) {
        updated.push({ variantId: variantNum, price: formatted, success: true });
        // Update baseProductPrice if this is the base variant
        if (String(variantNum) === String(dbPage.baseVariantId)) {
          await storage.updateCustomizerPage(dbPage.id, { baseProductPrice: formatted });
        }
      } else {
        updated.push({ variantId: variantNum, price: formatted, success: false, error: priceResult.error });
        console.warn(`[sync-prices] Failed to update variant ${variantNum}: ${priceResult.error}`);
      }
    }

    const successCount = updated.filter(u => u.success).length;
    return res.json({ success: true, updated, successCount, totalCount: updated.length });
  }));

  /** GET /api/appai/blanks (admin-auth'd, uses offline session) */
  // Note: storefront uses /api/proxy/blanks; this endpoint is for the admin picker
  app.get("/api/appai/blanks", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    const resolved = await resolveShopInstallation(req);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, ...(resolved.reinstallUrl ? { reinstallUrl: resolved.reinstallUrl } : {}) });

    const { installation } = resolved;
    const shop: string = installation.shopDomain;

    try {
      const productTypes = await storage.getActiveProductTypes();

      // Enrich products that are already on Shopify with live variant data.
      // Products not yet on Shopify are included with needsShopifySync: true.
      const enriched: any[] = [];

      // Helper: build printifyVariantId → human-readable label from stored variantMap
      function buildPrintifyVariantLabels(pt: any): Record<string, string> {
        const storedVm = typeof pt.variantMap === "string" ? JSON.parse(pt.variantMap || "{}") : (pt.variantMap || {});
        const allSizes = JSON.parse(pt.sizes || pt.frameSizes || "[]");
        const allColors = JSON.parse(pt.frameColors || "[]");
        const savedSizeIds: string[] = JSON.parse(pt.selectedSizeIds || "[]");
        const savedColorIds: string[] = JSON.parse(pt.selectedColorIds || "[]");
        const activeSizes = savedSizeIds.length ? allSizes.filter((s: any) => savedSizeIds.includes(s.id)) : allSizes;
        const activeColors = savedColorIds.length ? allColors.filter((c: any) => savedColorIds.includes(c.id)) : allColors;
        const labels: Record<string, string> = {};
        for (const [key, entry] of Object.entries(storedVm)) {
          const [sizeId, colorId] = key.split(":");
          const sizeName = activeSizes.find((s: any) => s.id === sizeId)?.name ?? allSizes.find((s: any) => s.id === sizeId)?.name ?? sizeId;
          const colorName = activeColors.find((c: any) => c.id === colorId)?.name ?? allColors.find((c: any) => c.id === colorId)?.name;
          const vid = String((entry as any).printifyVariantId);
          labels[vid] = colorName && colorId !== "default" ? `${sizeName} / ${colorName}` : sizeName;
        }
        return labels;
      }

      for (const pt of productTypes) {
        // Build the variant list from the DB variantMap (source of truth for sizes/colors).
        // This ensures the pricing step always reflects the latest Refresh Variants result,
        // without requiring the merchant to re-send the product to Shopify.
        // The Shopify product is only fetched to get the image URL and current prices.
        const pvLabels = buildPrintifyVariantLabels(pt);

        // Build variants from DB variantMap — deduplicated by full label so that products
        // with meaningful material/color variants (e.g. Body Pillow: Polyester vs Microfiber)
        // each get their own pricing row. Phone cases with cosmetic color variants will show
        // multiple rows but the auto-calculator fills them with the same price anyway.
        const seenLabels = new Set<string>();
        const dbVariants: any[] = [];
        for (const [printifyVariantId, label] of Object.entries(pvLabels)) {
          // Deduplicate by full label to avoid exact duplicates, but keep all distinct variants.
          if (seenLabels.has(label as string)) continue;
          seenLabels.add(label as string);
          dbVariants.push({
            id: `printify:${printifyVariantId}`,
            title: label as string,
            price: "0.00",
            sku: "",
          });
        }

        // Fetch image and current prices from Shopify if the product is already there.
        let imageUrl: string | null = (pt as any).mockupImageUrl ?? null;
        let needsShopifySync = !pt.shopifyProductId;
        if (pt.shopifyProductId) {
          const pResult = await shopifyApiCall(
            shop,
            installation.accessToken,
            `products/${pt.shopifyProductId}.json?fields=id,title,images`,
          );
          if (pResult.ok && pResult.data?.product) {
            imageUrl = pResult.data.product.images?.[0]?.src ?? imageUrl;
            needsShopifySync = false;
          }
        }

        enriched.push({
          productTypeId: pt.id,
          productId: pt.shopifyProductId ?? null,
          title: pt.name,
          imageUrl,
          needsShopifySync,
          printifyBlueprintId: pt.printifyBlueprintId ?? null,
          printifyProviderId: pt.printifyProviderId ?? null,
          printifyVariantLabels: pvLabels,
          variants: dbVariants,
        });
      }
      return res.json({ blanks: enriched });
    } catch (err: any) {
      console.error("[/api/appai/blanks]", err);
      return res.status(500).json({ error: "Failed to load blanks" });
    }
  }));

  // ─────────────────────────────────────────────────────────────────────────
  // APP PROXY — Storefront → Backend (HMAC-verified, no CORS issues)
  //
  // Shopify rewrites /apps/appai/<path> to /api/proxy/<path>?shop=...&signature=...
  // We verify the signature then dispatch to the appropriate handler.
  // Responses must be JSON (or Liquid). We return JSON.
  // ─────────────────────────────────────────────────────────────────────────

  function verifyProxySignature(query: Record<string, string>): boolean {
    const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET ?? "";
    if (!SHOPIFY_API_SECRET) return false;
    const { signature, ...rest } = query;
    if (!signature) return false;
    // Sort keys, join as key=value with NO separator between pairs
    const message = Object.keys(rest)
      .sort()
      .map((k) => `${k}=${rest[k]}`)
      .join("");
    const computed = crypto
      .createHmac("sha256", SHOPIFY_API_SECRET)
      .update(message)
      .digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(signature, "hex"));
    } catch {
      return false;
    }
  }

  /**
   * Ensures a product is published to the Online Store sales channel.
   * Tries GraphQL publishablePublish first (requires write_publications scope),
   * then always falls back to REST published_at (uses write_products scope).
   */
  async function ensureProductPublishedToOnlineStore(shop: string, accessToken: string, productId: number) {
    const gqlEndpoint = `https://${shop}/admin/api/2025-10/graphql.json`;
    const gqlHeaders = { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" };
    const productGid = `gid://shopify/Product/${productId}`;

    try {
      // Step 1: Get all publications (sales channels)
      const pubQuery = JSON.stringify({
        query: `{ publications(first: 20) { edges { node { id name } } } }`,
      });
      const pubRes = await fetch(gqlEndpoint, { method: "POST", headers: gqlHeaders, body: pubQuery });
      if (!pubRes.ok) {
        console.warn(`[ensurePublished] Failed to fetch publications: ${pubRes.status}`);
        return;
      }
      const pubData = await pubRes.json() as any;
      if (pubData?.errors) {
        console.warn(`[ensurePublished] GraphQL errors:`, JSON.stringify(pubData.errors).slice(0, 300));
        return;
      }

      const publications = pubData?.data?.publications?.edges ?? [];
      const onlineStore = publications.find((e: any) => /online store/i.test(e.node.name));
      const otherChannels = publications.filter((e: any) => !/online store/i.test(e.node.name));

      console.log(`[ensurePublished] Found ${publications.length} channels. Online Store: ${onlineStore ? 'yes' : 'no'}, Others: ${otherChannels.map((e: any) => e.node.name).join(', ')}`);

      // Step 2: Publish to Online Store only
      if (onlineStore) {
        const publishMutation = JSON.stringify({
          query: `mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
            publishablePublish(id: $id, input: $input) {
              publishable { ... on Product { id title } }
              userErrors { field message }
            }
          }`,
          variables: {
            id: productGid,
            input: [{ publicationId: onlineStore.node.id }],
          },
        });
        const publishRes = await fetch(gqlEndpoint, { method: "POST", headers: gqlHeaders, body: publishMutation });
        if (publishRes.ok) {
          const publishData = await publishRes.json() as any;
          const userErrors = publishData?.data?.publishablePublish?.userErrors ?? [];
          if (userErrors.length > 0 && !userErrors.some((e: any) => /already/i.test(e.message))) {
            console.warn(`[ensurePublished] Publish userErrors:`, JSON.stringify(userErrors));
          } else {
            console.log(`[ensurePublished] Published product ${productId} to Online Store`);
          }
        }
      } else {
        console.warn(`[ensurePublished] No Online Store publication found`);
      }

      // Step 3: Unpublish from all OTHER channels (Point of Sale, etc.)
      for (const channel of otherChannels) {
        try {
          const unpublishMutation = JSON.stringify({
            query: `mutation publishableUnpublish($id: ID!, $input: [PublicationInput!]!) {
              publishableUnpublish(id: $id, input: $input) {
                publishable { ... on Product { id } }
                userErrors { field message }
              }
            }`,
            variables: {
              id: productGid,
              input: [{ publicationId: channel.node.id }],
            },
          });
          const unpubRes = await fetch(gqlEndpoint, { method: "POST", headers: gqlHeaders, body: unpublishMutation });
          if (unpubRes.ok) {
            const unpubData = await unpubRes.json() as any;
            const ue = unpubData?.data?.publishableUnpublish?.userErrors ?? [];
            if (ue.length > 0) {
              console.warn(`[ensurePublished] Unpublish from ${channel.node.name} errors:`, JSON.stringify(ue));
            } else {
              console.log(`[ensurePublished] Unpublished product ${productId} from ${channel.node.name}`);
            }
          }
        } catch (unpubErr: any) {
          console.warn(`[ensurePublished] Failed to unpublish from ${channel.node.name}: ${unpubErr.message}`);
        }
      }

      // Step 4: Set seo.hidden=1 metafield to make it "Unlisted" (hidden from search/collections)
      try {
        console.log(`[ensurePublished] Setting seo.hidden=1 for product ${productId}`);
        const metafieldRes = await fetch(
          `https://${shop}/admin/api/2025-10/products/${productId}/metafields.json`,
          {
            method: "POST",
            headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
            body: JSON.stringify({
              metafield: {
                namespace: "seo",
                key: "hidden",
                value: 1,
                type: "integer"
              }
            }),
          }
        );
        if (metafieldRes.ok) {
          console.log(`[ensurePublished] Successfully set seo.hidden=1 for product ${productId}`);
        } else {
          const errText = await metafieldRes.text().catch(() => "");
          console.warn(`[ensurePublished] Failed to set seo.hidden: ${metafieldRes.status} ${errText.slice(0, 200)}`);
        }
      } catch (metaErr: any) {
        console.warn(`[ensurePublished] Metafield error: ${metaErr.message}`);
      }

    } catch (err: any) {
      console.warn(`[ensurePublished] Overall error: ${err.message}`);
    }
  }

  /** Middleware that verifies the Shopify App Proxy HMAC and attaches req.proxyShop */
  function proxyAuth(req: Request, res: Response, next: Function) {
    const query = req.query as Record<string, string>;
    if (!verifyProxySignature(query)) {
      // In dev mode (no secret configured) allow through for local testing
      if (process.env.NODE_ENV === "production") {
        return res.status(401).json({ error: "Invalid proxy signature" });
      }
    }
    (req as any).proxyShop = query.shop ?? "";
    next();
  }

  /** GET /api/proxy/customizer-pages — returns all pages for this shop (active + disabled) plus fallbackUrl */
  app.get("/api/proxy/customizer-pages", proxyAuth, async (req: Request, res: Response) => {
    const shop: string = (req as any).proxyShop;
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const [allPages, installation] = await Promise.all([
      storage.listCustomizerPages(shop),
      storage.getShopifyInstallationByShop(shop),
    ]);

    const pages = allPages.map((p) => ({
      id: p.id,
      handle: p.handle,
      title: p.title,
      baseVariantId: p.baseVariantId,
      baseProductTitle: p.baseProductTitle,
      baseVariantTitle: p.baseVariantTitle,
      baseProductPrice: p.baseProductPrice,
      status: p.status,
    }));

    // Include fallback URL so embed can redirect disabled-page visitors
    const fallbackUrl: string = (installation as any)?.customizerHubUrl ?? "/";

    return res.json({ pages, fallbackUrl });
  });

  /** Rewrites local /objects/... storage paths to go through the App Proxy so storefront can load them */
  function rewriteStoragePath(url: string | null | undefined): string | null {
    if (!url) return null;
    if (url.startsWith("/objects/")) return `/apps/appai${url}`;
    return url;
  }

  /** GET /api/proxy/customizer-page — single page config by handle, for storefront embed */
  app.get("/api/proxy/customizer-page", proxyAuth, asyncHandler(async (req: Request, res: Response) => {
    const shop: string = (req as any).proxyShop;
    const handle = (req.query.handle as string) || "";
    if (!shop || !handle) return res.status(400).json({ error: "Missing shop or handle" });

    const page = await storage.getCustomizerPageByHandle(shop, handle);
    if (!page || page.status !== "active") return res.status(404).json({ error: "Customizer page not found" });

    // Embed the full designer config so the iframe never needs to call
    // /api/storefront/product-types/:id/designer (eliminates the timeout).
    let designerConfig = null;
    if (page.productTypeId) {
      try {
        const pt = await storage.getProductType(page.productTypeId);
        if (pt) {
          designerConfig = buildDesignerConfig(pt, page.productTypeId);
        }
      } catch (e) {
        console.warn(`[proxy/customizer-page] Failed to load designerConfig for productTypeId=${page.productTypeId}:`, e);
      }
    }

    // Fetch all variants for the base product so the storefront can render a
    // variant selector with prices before the customer generates artwork.
    // Also check product status and auto-publish if needed so /cart/add.js accepts the variant.
    let variants: Array<{ id: string; title: string; price: string }> = [];
    let productPublished: boolean | null = null;
    if (page.baseProductId) {
      try {
        const installation = await storage.getShopifyInstallationByShop(shop);
        if (installation?.accessToken) {
          const prodResult = await shopifyApiCall(
            shop,
            installation.accessToken,
            `products/${page.baseProductId}.json?fields=id,status,published_at,variants`
          );
          const rawVariants: any[] = prodResult.data?.product?.variants ?? [];
          variants = rawVariants.map((v: any) => ({
            id: String(v.id),
            title: v.title || "",
            price: v.price || "0.00",
          }));

          // Ensure the product is published to the Online Store channel.
          // Shopify "unlisted" products are accessible via direct URL and purchasable
          // via /cart/add.js — we do NOT force status: "active" which would make the
          // product visible in the storefront catalog.
          const productStatus: string = prodResult.data?.product?.status ?? "";
          const publishedAt: string | null = prodResult.data?.product?.published_at ?? null;
          console.log(`[proxy/customizer-page] Product ${page.baseProductId} status="${productStatus}" published_at="${publishedAt}"`);
          productPublished = (productStatus === "active" || productStatus === "unlisted") && !!publishedAt;

          const productIdNum = parseInt(String(page.baseProductId).replace(/\D/g, ""), 10);

          // Ensure product is published to Online Store so /cart/add.js works.
          // "unlisted" products still work with /cart/add.js when published to Online Store.
          if (productIdNum) {
            try {
              await ensureProductPublishedToOnlineStore(shop, installation.accessToken, productIdNum);
              productPublished = true;
              console.log(`[proxy/customizer-page] Product ${productIdNum} published to Online Store (status: ${productStatus})`);
            } catch (pubErr: any) {
              console.warn(`[proxy/customizer-page] Failed to publish product ${productIdNum}: ${pubErr.message}`);
            }
          }
        }
      } catch (e) {
        console.warn(`[proxy/customizer-page] Failed to fetch variants for product=${page.baseProductId}:`, e);
      }
    }

    // Fetch style presets so the storefront iframe doesn't need a separate
    // /api/config round-trip (which can fail/timeout in CORS-restricted envs).
    let stylePresets: Array<{ id: string; name: string; promptSuffix: string; category: string; promptPlaceholder?: string; options?: any; baseImageUrl?: string; descriptionOptional?: boolean }> = [];
    try {
      const dbStyles = await storage.getAllActiveStylePresets();
      stylePresets = dbStyles.map((s: any) => {
        const hardcoded = STYLE_PRESETS.find(h => h.id === s.id.toString() || h.name === s.name);
        return {
          id: s.id.toString(),
          name: s.name,
          promptSuffix: s.promptPrefix,
          category: s.category || "all",
          promptPlaceholder: s.promptPlaceholder || (hardcoded as any)?.promptPlaceholder,
          options: s.options || (hardcoded as any)?.options,
          baseImageUrl: s.baseImageUrl || (hardcoded as any)?.baseImageUrl || undefined,
          descriptionOptional: !!s.descriptionOptional,
        };
      });
    } catch (e) {
      console.warn(`[proxy/customizer-page] Failed to load stylePresets:`, e);
    }

    return res.json({
      id: page.id,
      handle: page.handle,
      title: page.title,
      baseVariantId: page.baseVariantId,
      baseProductId: page.baseProductId ?? null,
      baseProductHandle: (page as any).baseProductHandle ?? null,
      baseProductTitle: page.baseProductTitle ?? null,
      baseVariantTitle: page.baseVariantTitle ?? null,
      baseProductPrice: page.baseProductPrice ?? null,
      productTypeId: page.productTypeId ?? null,
      appUrl: process.env.APP_URL || "https://appai-pod-production.up.railway.app",
      designerConfig,
      variants,
      stylePresets,
      productPublished,
    });
  }));

  /**
   * GET /api/proxy/objects/designs/:filename
   * Serves design/mockup images through the App Proxy so storefront JS can load
   * them without CORS issues (Shopify rewrites /apps/appai/objects/designs/… here).
   * Tries local first; if not found and Supabase configured, redirects to Supabase.
   */
  app.get("/api/proxy/objects/designs/:filename", proxyAuth, (req: Request, res: Response) => {
    const { filename } = req.params;
    // Block path traversal
    if (!filename || filename.includes("/") || filename.includes("..")) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    const storageDir = process.env.STORAGE_DIR || "./local-storage";
    const filePath = path.resolve(storageDir, "designs", filename);
    const allowedDir = path.resolve(storageDir, "designs");
    if (!filePath.startsWith(allowedDir)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filename).slice(1).toLowerCase();
      const ct =
        ext === "png" ? "image/png" :
        ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
        "application/octet-stream";
      res.setHeader("Content-Type", ct);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return fs.createReadStream(filePath).pipe(res);
    }

    // Local file missing — redirect to Supabase if configured (files may have been migrated)
    const supabaseUrl = getSupabaseDesignPublicUrl(filename);
    if (supabaseUrl) {
      return res.redirect(302, supabaseUrl);
    }

    return res.status(404).json({ error: "Not found" });
  });

  /** POST /api/proxy/designs — create a customizer design (async generation) */
  app.post("/api/proxy/designs", proxyAuth, async (req: Request, res: Response) => {
    const shop: string = (req as any).proxyShop;
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const { baseVariantId, prompt, options } = req.body as {
      baseVariantId?: string;
      prompt?: string;
      options?: Record<string, any>;
    };

    if (!baseVariantId) return res.status(400).json({ error: "baseVariantId is required" });
    if (!prompt?.trim()) return res.status(400).json({ error: "prompt is required" });

    const { productTypeId, sizeId, colorId, stylePreset, pageHandle } = options ?? {};

    // Proxy to existing design creation logic
    const appHost = process.env.APP_URL || `http://127.0.0.1:${process.env.PORT ?? 5000}`;
    const design = await storage.createCustomizerDesign({
      shop,
      baseVariantId: String(baseVariantId),
      prompt: prompt.trim(),
      options: { productTypeId, sizeId, colorId, stylePreset, pageHandle },
      status: "GENERATING",
    });

    // Kick off background generation (same as existing storefront route)
    runCustomizerGeneration(
      design.id,
      { shop, productTypeId, sizeId, colorId, prompt: prompt.trim(), stylePreset },
      appHost
    ).catch((e: Error) => console.error("[Proxy Design] Background gen error:", e));

    return res.json({ designId: design.id, status: design.status });
  });

  /** GET /api/proxy/designs/:id — poll design status */
  app.get("/api/proxy/designs/:id", proxyAuth, async (req: Request, res: Response) => {
    const shop: string = (req as any).proxyShop;
    const { id } = req.params;

    const design = await storage.getCustomizerDesign(id);
    if (!design) return res.status(404).json({ error: "Design not found" });
    if (design.shop !== shop) return res.status(403).json({ error: "Access denied" });

    return res.json({
      designId: design.id,
      status: design.status,
      artworkUrl: rewriteStoragePath(design.artworkUrl as string | null),
      mockupUrl: rewriteStoragePath(design.mockupUrl as string | null),
      mockupUrls: Array.isArray(design.mockupUrls)
        ? (design.mockupUrls as string[]).map((u) => rewriteStoragePath(u) ?? u)
        : design.mockupUrls,
      errorMessage: design.errorMessage,
    });
  });

  /**
   * POST /api/proxy/publish-design
   *
   * Creates a dedicated Shopify product for a completed design so that the
   * cart/checkout thumbnail is a native Shopify product image (no hacks).
   *
   * Flow:
   *  1. Verify proxy HMAC + shop
   *  2. Load design from DB, verify shop match
   *  3. Check for existing published product (idempotent)
   *  4. Enforce 20-design limit per customerKey (archive oldest if exceeded)
   *  5. Fetch base variant/product info from Shopify Admin API
   *  6. Create Shopify product (active, not in collections) with mockup images
   *  7. Save to published_products
   *  8. Return { shopifyProductId, shopifyVariantId, shopifyProductHandle, designId }
   */
  app.post("/api/proxy/publish-design", proxyAuth, async (req: Request, res: Response) => {
    const shop: string = (req as any).proxyShop;
    if (!shop) return res.status(400).json({ error: "Missing shop" });

    const { designId, customerKey, chosenMockupIndex } = req.body as {
      designId?: string;
      customerKey?: string;
      chosenMockupIndex?: number;
    };

    if (!designId) return res.status(400).json({ error: "designId is required" });

    // Load design
    const design = await storage.getCustomizerDesign(designId);
    if (!design) return res.status(404).json({ error: "Design not found" });
    if (design.shop !== shop) return res.status(403).json({ error: "Access denied" });
    if (design.status !== "READY") {
      return res.status(400).json({ error: "Design is not ready yet. Please wait for generation to complete." });
    }

    // Idempotency: return existing published product if already done
    const existing = await storage.getPublishedProduct(shop, designId);
    if (existing && existing.status === "active") {
      console.log(`[PublishDesign] Reusing existing product for design ${designId}`);
      return res.json({
        designId,
        shopifyProductId: existing.shopifyProductId,
        shopifyVariantId: existing.shopifyVariantId,
        shopifyProductHandle: existing.shopifyProductHandle,
        reused: true,
      });
    }

    // Get Shopify access token
    const installation = await storage.getShopifyInstallationByShop(shop);
    if (!installation || installation.status !== "active") {
      return res.status(400).json({ error: "Shopify store not connected" });
    }
    const accessToken: string = installation.accessToken;

    // Enforce per-customer 20-design limit
    const MAX_DESIGNS = 20;
    if (customerKey) {
      const designCount = await storage.countCustomerPublishedDesigns(shop, customerKey);
      if (designCount >= MAX_DESIGNS) {
        // Archive the oldest to make room
        const oldest = await storage.getOldestCustomerPublishedDesign(shop, customerKey);
        if (oldest) {
          await storage.updatePublishedProduct(oldest.id, { status: "archived" });
          console.log(`[PublishDesign] Archived oldest design ${oldest.designId} for customer ${customerKey}`);
        }
      }
    }

    // Resolve base variant → product info
    const variantNum = parseInt(design.baseVariantId, 10);
    if (!variantNum) return res.status(400).json({ error: "Invalid baseVariantId on design" });

    const variantResult = await shopifyApiCall(
      shop,
      accessToken,
      `variants/${variantNum}.json?fields=id,product_id,title,price,option1,option2,option3`
    );
    if (!variantResult.ok || !variantResult.data?.variant) {
      return res.status(400).json({ error: `Base variant ${variantNum} not found` });
    }
    const baseVariant = variantResult.data.variant;

    const productResult = await shopifyApiCall(
      shop,
      accessToken,
      `products/${baseVariant.product_id}.json?fields=id,title,body_html`
    );
    const baseProduct = productResult.data?.product ?? {};

    // Build mockup image list (up to 4, honouring chosenMockupIndex as first)
    const allMockups: string[] = Array.isArray(design.mockupUrls)
      ? (design.mockupUrls as string[]).slice(0, 4)
      : design.mockupUrl
      ? [design.mockupUrl]
      : [];

    // Put chosen mockup first
    const idx = typeof chosenMockupIndex === "number" ? chosenMockupIndex : 0;
    if (idx > 0 && idx < allMockups.length) {
      const [chosen] = allMockups.splice(idx, 1);
      allMockups.unshift(chosen);
    }

    // Unique product handle: base-handle + design prefix
    const designPrefix = designId.slice(0, 8);
    const baseSlug = String(baseProduct.title ?? "custom-product")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    const productHandle = `${baseSlug}-${designPrefix}`;
    const productTitle = `${baseProduct.title ?? "Custom Product"} — ${designPrefix}`;

    // Build images array — use src URL; Shopify will download them
    const images = allMockups
      .filter((u) => typeof u === "string" && u.startsWith("https://"))
      .map((u) => ({ src: u }));

    // Build Shopify product payload
    const productPayload: Record<string, any> = {
      title: productTitle,
      handle: productHandle,
      body_html: `<p>${design.prompt}</p>`,
      vendor: "AppAI Custom",
      product_type: "Custom",
      status: "active",
      published: true,   // Must be true for storefront /cart/add.js to accept
      tags: "appai-generated",
      images,
      variants: [
        {
          option1: baseVariant.title ?? "Default Title",
          price: baseVariant.price ?? "0.00",
          requires_shipping: true,
          taxable: true,
          inventory_management: null,
          fulfillment_service: "manual",
          inventory_policy: "deny",
        },
      ],
      metafields: [
        { namespace: "appai", key: "design_id",      value: designId,          type: "single_line_text_field" },
        { namespace: "appai", key: "base_variant_id", value: design.baseVariantId, type: "single_line_text_field" },
      ],
    };

    console.log(`[PublishDesign] Creating Shopify product for design ${designId} on shop ${shop}`);

    const createResult = await shopifyApiCall(shop, accessToken, "products.json", {
      method: "POST",
      body: JSON.stringify({ product: productPayload }),
    });

    if (!createResult.ok || !createResult.data?.product) {
      console.error(`[PublishDesign] Shopify product creation failed:`, createResult.error);
      return res.status(500).json({
        error: `Failed to create Shopify product: ${createResult.error ?? "unknown"}`,
      });
    }

    const createdProduct = createResult.data.product;
    const shopifyProductId = String(createdProduct.id);
    const shopifyVariantId = String(createdProduct.variants?.[0]?.id ?? "");
    const shopifyProductHandle: string = createdProduct.handle ?? productHandle;

    if (!shopifyVariantId) {
      console.error(`[PublishDesign] Created product has no variant:`, createdProduct);
      return res.status(500).json({ error: "Created product has no purchasable variant" });
    }

    // Publish to Online Store so /cart/add.js accepts the variant
    try {
      await ensureProductPublishedToOnlineStore(shop, accessToken, parseInt(shopifyProductId, 10));
      console.log(`[PublishDesign] Product ${shopifyProductId} published to Online Store`);
    } catch (pubErr: any) {
      console.warn(`[PublishDesign] Failed to publish product ${shopifyProductId}: ${pubErr.message}`);
    }

    // Redirect the shadow product's storefront URL to homepage so customers
    // can't browse to a confusing product page by clicking the cart link.
    try {
      await shopifyApiCall(shop, accessToken, "redirects.json", {
        method: "POST",
        body: JSON.stringify({ redirect: { path: `/products/${shopifyProductHandle}`, target: "/" } }),
      });
    } catch (rdErr: any) {
      console.warn(`[PublishDesign] Redirect creation failed for /products/${shopifyProductHandle}: ${rdErr.message}`);
    }

    // Update customerKey on design record
    if (customerKey && !design.customerKey) {
      await storage.updateCustomizerDesign(designId, { customerKey });
    }

    // Save to DB
    await storage.createPublishedProduct({
      shop,
      designId,
      customerKey: customerKey ?? null,
      shopifyProductId,
      shopifyVariantId,
      shopifyProductHandle,
      baseVariantId: design.baseVariantId,
      status: "active",
    });

    console.log(`[PublishDesign] Done — shopifyVariantId=${shopifyVariantId} for design ${designId}`);

    return res.json({
      designId,
      shopifyProductId,
      shopifyVariantId,
      shopifyProductHandle,
      reused: false,
    });
  });

  // ── Shop settings (admin-auth'd) ────────────────────────────────────────
  /** PATCH /api/appai/shop-settings — update per-shop customizer settings */
  app.patch("/api/appai/shop-settings", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    const resolved = await resolveShopInstallation(req);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, ...(resolved.reinstallUrl ? { reinstallUrl: resolved.reinstallUrl } : {}) });

    const { installation } = resolved;
    const { customizerHubUrl } = req.body as { customizerHubUrl?: string };

    if (customizerHubUrl !== undefined) {
      await storage.updateShopifyInstallation(installation.id, {
        customizerHubUrl: customizerHubUrl || null,
      } as any);
    }

    return res.json({ success: true });
  }));

  // ─────────────────────────────────────────────────────────────────────────
  // PLAN & BILLING — /api/appai/plan and /api/appai/billing/*
  // ─────────────────────────────────────────────────────────────────────────

  /** GET /api/appai/plan — return effective plan state for the authenticated shop */
  app.get("/api/appai/plan", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    const resolved = await resolveShopInstallation(req);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, ...(resolved.reinstallUrl ? { reinstallUrl: resolved.reinstallUrl } : {}) });

    const { installation } = resolved;
    const plan = getEffectivePlan(installation as any, installation.shopDomain);
    const pagesCount = await storage.countCustomizerPages(installation.shopDomain);

    return res.json({
      planName: plan.planName,
      planStatus: plan.planStatus,
      isActive: plan.isActive,
      requiresPlan: plan.requiresPlan,
      pageLimit: plan.pageLimit,
      pagesCount,
      displayName: plan.displayName,
      overLimit: plan.isActive && pagesCount > plan.pageLimit,
      trialStartedAt: (installation as any).trialStartedAt ?? null,
      billingCurrentPeriodEnd: (installation as any).billingCurrentPeriodEnd ?? null,
    });
  }));

  /** POST /api/appai/billing/start-trial — activate the trial plan (no credit card) */
  app.post("/api/appai/billing/start-trial", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    const resolved = await resolveShopInstallation(req);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, ...(resolved.reinstallUrl ? { reinstallUrl: resolved.reinstallUrl } : {}) });

    const { installation } = resolved;

    // Idempotent — if already on a plan or trial, just return current state
    const current = getEffectivePlan(installation as any, installation.shopDomain);
    if (current.isActive) {
      return res.json({ success: true, alreadyActive: true, plan: current });
    }

    await storage.updateShopifyInstallation(installation.id, {
      planName: "trial",
      planStatus: "trialing",
      trialStartedAt: new Date(),
    } as any);

    return res.json({
      success: true,
      planName: "trial",
      planStatus: "trialing",
      pageLimit: 1,
    });
  }));

  /**
   * POST /api/appai/billing/create-subscription
   * Body: { plan: "starter" | "dabbler" | "pro" | "pro_plus" }
   * Returns: { confirmationUrl: string }
   * The client redirects to confirmationUrl so the merchant can approve.
   */
  app.post("/api/appai/billing/create-subscription", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    const resolved = await resolveShopInstallation(req);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, ...(resolved.reinstallUrl ? { reinstallUrl: resolved.reinstallUrl } : {}) });

    const { installation } = resolved;
    const shop: string = installation.shopDomain;
    const { plan } = req.body as { plan?: string };

    if (!plan || !(PAID_PLANS as readonly string[]).includes(plan)) {
      return res.status(400).json({ error: `Invalid plan. Must be one of: ${PAID_PLANS.join(", ")}` });
    }

    // Owner bypass: skip Shopify Billing API entirely and write plan directly to DB
    const ownerShop = process.env.OWNER_SHOP_DOMAIN?.toLowerCase().trim();
    if (ownerShop && shop.toLowerCase() === ownerShop) {
      console.log(`[billing] Owner bypass: setting plan=${plan} for ${shop} without Shopify billing`);
      await storage.updateShopifyInstallation(installation.id, {
        planName: plan,
        planStatus: "active",
      });
      return res.json({ activated: true, plan });
    }

    const priceUsd = PLAN_PRICES_USD[plan];
    const displayName = PLAN_DISPLAY_NAMES[plan] ?? plan;
    const appUrl = process.env.APP_URL?.replace(/\/$/, "") ?? `https://${req.headers.host}`;
    const returnUrl = `${appUrl}/api/appai/billing/callback?shop=${encodeURIComponent(installation.shopDomain)}&plan=${encodeURIComponent(plan)}`;

    // Call Shopify Admin GraphQL to create app subscription
    const gqlBody = JSON.stringify({
      query: `
        mutation appSubscriptionCreate($name: String!, $returnUrl: URL!, $lineItems: [AppSubscriptionLineItemInput!]!, $test: Boolean) {
          appSubscriptionCreate(name: $name, returnUrl: $returnUrl, lineItems: $lineItems, test: $test) {
            userErrors { field message }
            appSubscription { id }
            confirmationUrl
          }
        }
      `,
      variables: {
        name: `${displayName} Plan`,
        returnUrl,
        test: process.env.NODE_ENV !== "production",
        lineItems: [{
          plan: {
            appRecurringPricingDetails: {
              price: { amount: priceUsd, currencyCode: "USD" },
              interval: "EVERY_30_DAYS",
            },
          },
        }],
      },
    });

    const gqlResponse = await fetch(
      `https://${installation.shopDomain}/admin/api/2025-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": installation.accessToken,
          "Content-Type": "application/json",
        },
        body: gqlBody,
      }
    );

    if (!gqlResponse.ok) {
      console.error("[Billing] GraphQL request failed:", gqlResponse.status);
      return res.status(502).json({ error: "Failed to contact Shopify billing API" });
    }

    const gqlData = await gqlResponse.json() as any;
    const result = gqlData?.data?.appSubscriptionCreate;

    if (result?.userErrors?.length) {
      console.error("[Billing] userErrors:", result.userErrors);
      return res.status(400).json({ error: result.userErrors[0].message });
    }

    const confirmationUrl = result?.confirmationUrl;
    if (!confirmationUrl) {
      return res.status(502).json({ error: "No confirmation URL returned from Shopify" });
    }

    // Store pending subscription ID so we can match it on callback
    if (result?.appSubscription?.id) {
      await storage.updateShopifyInstallation(installation.id, {
        billingSubscriptionId: result.appSubscription.id,
      } as any);
    }

    return res.json({ confirmationUrl, subscriptionId: result?.appSubscription?.id });
  }));

  /**
   * GET /api/appai/billing/callback
   * Browser redirect from Shopify after merchant approves/declines.
   * Query params: shop, plan, charge_id (Shopify AppSubscription GID)
   */
  app.get("/api/appai/billing/callback", asyncHandler(async (req: Request, res: Response) => {
    const { shop, plan, charge_id } = req.query as Record<string, string>;

    if (!shop || !plan) {
      return res.status(400).send("Missing shop or plan parameter");
    }

    const installation = await storage.getShopifyInstallationByShop(shop);
    if (!installation || installation.status !== "active") {
      return res.status(400).send("Shop not found or not active");
    }

    if (!charge_id) {
      // Merchant declined — redirect back to app without activating plan
      console.log(`[Billing] Merchant declined subscription for ${shop}`);
      return res.redirect(`https://${shop}/admin/apps`);
    }

    // Verify the subscription via Shopify GraphQL
    try {
      const gqlResponse = await fetch(
        `https://${shop}/admin/api/2025-10/graphql.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": installation.accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: `
              query getSubscription($id: ID!) {
                node(id: $id) {
                  ... on AppSubscription {
                    id status currentPeriodEnd
                  }
                }
              }
            `,
            variables: { id: charge_id },
          }),
        }
      );

      let subscriptionStatus = "ACTIVE";
      let currentPeriodEnd: Date | null = null;

      if (gqlResponse.ok) {
        const gqlData = await gqlResponse.json() as any;
        const sub = gqlData?.data?.node;
        if (sub) {
          subscriptionStatus = sub.status ?? "ACTIVE";
          if (sub.currentPeriodEnd) currentPeriodEnd = new Date(sub.currentPeriodEnd);
        }
      }

      if (subscriptionStatus === "ACTIVE" || subscriptionStatus === "PENDING") {
        await storage.updateShopifyInstallation(installation.id, {
          planName: plan,
          planStatus: "active",
          billingSubscriptionId: charge_id,
          billingCurrentPeriodEnd: currentPeriodEnd ?? undefined,
        } as any);
        console.log(`[Billing] Activated ${plan} plan for ${shop}`);
      }
    } catch (err: any) {
      console.error(`[Billing] Callback verification failed for ${shop}:`, err.message);
      // Still mark as active optimistically — Shopify wouldn't redirect here without approval
      await storage.updateShopifyInstallation(installation.id, {
        planName: plan,
        planStatus: "active",
        billingSubscriptionId: charge_id,
      } as any);
    }

    // Redirect back to the Shopify Admin app
    const apiKey = process.env.SHOPIFY_API_KEY ?? "";
    const adminUrl = apiKey
      ? `https://${shop}/admin/apps/${apiKey}`
      : `https://${shop}/admin/apps`;
    return res.redirect(adminUrl);
  }));

  /** POST /api/appai/billing/cancel — cancel current subscription */
  app.post("/api/appai/billing/cancel", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    const resolved = await resolveShopInstallation(req);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, ...(resolved.reinstallUrl ? { reinstallUrl: resolved.reinstallUrl } : {}) });

    const { installation } = resolved;
    const subscriptionId = (installation as any).billingSubscriptionId;

    if (subscriptionId) {
      // Cancel via Shopify GraphQL (best-effort)
      await fetch(`https://${installation.shopDomain}/admin/api/2025-10/graphql.json`, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": installation.accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `mutation { appSubscriptionCancel(id: "${subscriptionId}") { userErrors { message } } }`,
        }),
      }).catch((e: Error) => console.warn("[Billing] Cancel GraphQL failed:", e.message));
    }

    await storage.updateShopifyInstallation(installation.id, {
      planStatus: "cancelled",
    } as any);

    return res.json({ success: true });
  }));

  // ==================== BRANDING & STYLING ====================

  // GET branding settings for current merchant
  app.get("/api/admin/branding", isAuthenticated, asyncHandler(async (req: any, res: Response) => {
    const userId = req.user.claims.sub;
    const merchant = await storage.getMerchantByUserId(userId);
    
    if (!merchant) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    res.json({
      brandingSettings: merchant.brandingSettings || {
        primaryColor: "#000000",
        secondaryColor: "#f5f5f5",
        textColor: "#000000",
        borderColor: "#000000",
        backgroundColor: "#ffffff",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }
    });
  }));

  // Register admin branding routes
  registerAdminBrandingRoutes(app);

  return httpServer;
}
