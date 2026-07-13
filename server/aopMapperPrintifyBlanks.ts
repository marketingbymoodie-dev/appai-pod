/**
 * Printify blank mockup harvest for the AOP Panel Mapper.
 * Creates a temporary transparent-print product, polls mockups, downloads
 * front/back garment photos, and stores them as mapper mockup assets.
 */
import fs from "node:fs";
import path from "node:path";
import {
  readTemplateText,
  writeAssetBuffer,
  MOCKUPS_DIR,
  ensureLocalMapperDirs,
} from "./aopMapperStorage";
import { ensureHoodieTemplatesBucket } from "./supabaseHoodieTemplates";
import sharp from "sharp";

const PRINTIFY_API_BASE = "https://api.printify.com/v1";
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000;

type MockupImage = { url: string; label: string };

async function pf<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${PRINTIFY_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Printify ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function extractCameraLabel(src: string): string {
  try {
    const u = new URL(src);
    const raw = u.searchParams.get("camera_label") || u.searchParams.get("cameraLabel") || "";
    return decodeURIComponent(raw.replace(/\+/g, " ")).trim().toLowerCase();
  } catch {
    return "";
  }
}

function extractImages(product: any): MockupImage[] {
  const out: MockupImage[] = [];
  for (const img of product?.images ?? []) {
    const src = img?.src || img?.url;
    if (!src) continue;
    out.push({ url: src, label: extractCameraLabel(src) || String(img?.position || img?.camera_label || "") });
  }
  return out;
}

async function uploadTransparentPng(token: string): Promise<string> {
  // Printify expects JSON { file_name, contents } — not multipart FormData.
  // Use a 1024² transparent PNG (same minimum size as mockup harvest elsewhere).
  const png = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();

  const res = await fetch(`${PRINTIFY_API_BASE}/uploads/images.json`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      file_name: `mapper-blank-${Date.now()}.png`,
      contents: png.toString("base64"),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Printify image upload → ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error("Printify image upload returned no id");
  return data.id;
}

async function pollMockups(
  token: string,
  shopId: string,
  productId: string,
  initial: MockupImage[],
): Promise<MockupImage[]> {
  if (initial.length > 0) return initial;
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const product = await pf<any>(`/shops/${shopId}/products/${productId}.json`, token);
    const imgs = extractImages(product);
    if (imgs.length > 0) return imgs;
  }
  throw new Error("Timed out waiting for Printify mockups");
}

async function deleteTempProduct(token: string, shopId: string, productId: string): Promise<void> {
  try {
    await fetch(`${PRINTIFY_API_BASE}/shops/${shopId}/products/${productId}.json`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    /* best-effort */
  }
}

function pickView(images: MockupImage[], view: "front" | "back"): MockupImage | undefined {
  const norm = (s: string) => s.toLowerCase();
  if (view === "front") {
    return (
      images.find((i) => norm(i.label).includes("front") && !norm(i.label).includes("back")) ||
      images.find((i) => norm(i.label) === "front") ||
      images[0]
    );
  }
  return (
    images.find((i) => norm(i.label).includes("back")) ||
    images.find((i) => norm(i.label) === "back") ||
    images[1] ||
    images[0]
  );
}

type PrintPlaceholder = { position: string; width: number; height: number };

function listVariantPrintPlaceholders(variant: any): PrintPlaceholder[] {
  const out: PrintPlaceholder[] = [];
  for (const ph of variant?.placeholders || []) {
    const w = Number(ph.width);
    const h = Number(ph.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
    out.push({ position: String(ph.position || "default"), width: w, height: h });
  }
  return out;
}

async function resolveProviderId(token: string, blueprintId: number): Promise<number> {
  const providers = await pf<any[]>(
    `/catalog/blueprints/${blueprintId}/print_providers.json`,
    token,
  );
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error(`No print providers listed for blueprint ${blueprintId}`);
  }
  const id = Number(providers[0]?.id);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`No print provider found for blueprint ${blueprintId}`);
  }
  return id;
}

async function resolveCatalogVariant(
  token: string,
  blueprintId: number,
  providerId: number,
): Promise<{ variantId: number; placeholders: PrintPlaceholder[] }> {
  const variantsData = await pf<any>(
    `/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json`,
    token,
  );
  const variants: any[] = variantsData?.variants ?? (Array.isArray(variantsData) ? variantsData : []);
  if (variants.length === 0) {
    throw new Error(`No catalog variants for blueprint ${blueprintId}, provider ${providerId}`);
  }
  const variant = variants[0];
  const variantId = Number(variant?.id ?? variant?.variant_id);
  if (!Number.isFinite(variantId) || variantId <= 0) {
    throw new Error(`Invalid catalog variant for blueprint ${blueprintId}`);
  }
  const placeholders = listVariantPrintPlaceholders(variant);
  if (placeholders.length === 0) {
    throw new Error("Blueprint variant has no print placeholders");
  }
  return { variantId, placeholders };
}

export type FetchPrintifyBlanksResult = {
  ok: true;
  blueprintId: number;
  downloaded: Array<{ view: "front" | "back"; filename: string; url: string; bytes: number; width: number; height: number }>;
};

export async function fetchPrintifyBlankMockups(args: {
  templateName: string;
  token: string;
  shopId: string;
  mockupUrlBase: string;
}): Promise<FetchPrintifyBlanksResult> {
  const { templateName, token, shopId, mockupUrlBase } = args;
  const raw = await readTemplateText(templateName);
  if (!raw) throw new Error(`Template "${templateName}" not found — save it first.`);
  const tpl = JSON.parse(raw) as { blueprintId?: number | null };
  const blueprintId = Number(tpl.blueprintId);
  if (!Number.isFinite(blueprintId) || blueprintId <= 0) {
    throw new Error("Template has no blueprintId — set blueprint in the mapper sidebar first.");
  }

  await ensureHoodieTemplatesBucket();
  ensureLocalMapperDirs();

  const providerId = await resolveProviderId(token, blueprintId);
  const { variantId, placeholders } = await resolveCatalogVariant(token, blueprintId, providerId);

  const primary =
    placeholders.find((p) => p.position === "front") ||
    placeholders.find((p) => p.position === "default") ||
    placeholders[0];
  const hasBack = placeholders.some((p) => p.position === "back");
  const transparentId = await uploadTransparentPng(token);

  const printAreas: Array<{ variant_ids: number[]; placeholders: Array<{ position: string; images: unknown[] }> }> =
    [];
  if (hasBack) {
    printAreas.push({
      variant_ids: [variantId],
      placeholders: ["front", "back"].map((pos) => ({
        position: pos,
        images: [{ id: transparentId, x: 0.5, y: 0.5, scale: 1, angle: 0 }],
      })),
    });
  } else {
    printAreas.push({
      variant_ids: [variantId],
      placeholders: [
        {
          position: primary.position,
          images: [{ id: transparentId, x: 0.5, y: 0.5, scale: 1, angle: 0 }],
        },
      ],
    });
  }

  const body = {
    title: `__appai_mapper_blank_${Date.now()}`,
    description: "temp blank mockup harvest (auto-deleted)",
    blueprint_id: blueprintId,
    print_provider_id: providerId,
    variants: [{ id: variantId, price: 100, is_enabled: true }],
    print_areas: printAreas,
  };

  const product = await pf<any>(`/shops/${shopId}/products.json`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const productId = String(product.id);
  const images = await pollMockups(token, shopId, productId, extractImages(product));

  const downloaded: FetchPrintifyBlanksResult["downloaded"] = [];
  try {
    for (const view of ["front", "back"] as const) {
      const match = pickView(images, view);
      if (!match) continue;
      const res = await fetch(match.url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const meta = await sharp(buf).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      if (width <= 0 || height <= 0) continue;
      const filename = `${templateName}-${view}.png`;
      // The blank harvest reuses the template's active mockup filename, so a
      // custom-authored mockup would be silently destroyed here (this clobbered
      // the zip hoodie's traced front mockup in June 2026). Keep a local
      // timestamped backup of whatever we're about to overwrite.
      const existing = path.join(MOCKUPS_DIR, filename);
      if (fs.existsSync(existing)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.copyFileSync(existing, path.join(MOCKUPS_DIR, `${templateName}-${view}.${stamp}.bak`));
      }
      await writeAssetBuffer("mockups", filename, buf);
      downloaded.push({
        view,
        filename,
        url: `${mockupUrlBase}/${encodeURIComponent(filename)}`,
        bytes: buf.length,
        width,
        height,
      });
    }
  } finally {
    await deleteTempProduct(token, shopId, productId);
  }

  if (downloaded.length === 0) {
    throw new Error("Printify returned mockups but none could be downloaded");
  }

  return { ok: true, blueprintId, downloaded };
}

/** @deprecated use resolveLocalMockupPath from aopMapperStorage */
export { MOCKUPS_DIR };
