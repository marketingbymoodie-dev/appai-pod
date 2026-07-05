/**
 * Printify blank mockup harvest for the AOP Panel Mapper.
 * Creates a temporary transparent-print product, polls mockups, downloads
 * front/back garment photos, and stores them as mapper mockup assets.
 */
import {
  readTemplateText,
  writeAssetBuffer,
  MOCKUPS_DIR,
  ensureLocalMapperDirs,
} from "./aopMapperStorage";
import { ensureHoodieTemplatesBucket } from "./supabaseHoodieTemplates";

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
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const form = new FormData();
  form.append(
    "file",
    new Blob([png], { type: "image/png" }),
    "blank.png",
  );
  const res = await fetch(`${PRINTIFY_API_BASE}/uploads/images.json`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Printify image upload → ${res.status}`);
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

export type FetchPrintifyBlanksResult = {
  ok: true;
  blueprintId: number;
  downloaded: Array<{ view: "front" | "back"; filename: string; url: string; bytes: number }>;
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

  const catalog = await pf<any>(`/catalog/blueprints/${blueprintId}.json`, token);
  const providers = catalog?.print_providers ?? [];
  const providerId = providers[0]?.id;
  if (!providerId) throw new Error(`No print provider found for blueprint ${blueprintId}`);
  const provider = await pf<any>(
    `/catalog/blueprints/${blueprintId}/print_providers/${providerId}.json`,
    token,
  );
  const variant = provider?.variants?.[0];
  if (!variant?.id) throw new Error(`No catalog variant for blueprint ${blueprintId}`);

  const placeholders = (variant.placeholders ?? []) as Array<{ position: string; width: number; height: number }>;
  const primary =
    placeholders.find((p) => p.position === "front") ||
    placeholders.find((p) => p.position === "default") ||
    placeholders[0];
  if (!primary) throw new Error("Blueprint variant has no print placeholders");

  const hasBack = placeholders.some((p) => p.position === "back");
  const transparentId = await uploadTransparentPng(token);

  const printAreas: Array<{ variant_ids: number[]; placeholders: Array<{ position: string; images: unknown[] }> }> =
    [];
  const variantId = variant.id;
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
      const filename = `${templateName}-${view}.png`;
      await writeAssetBuffer("mockups", filename, buf);
      downloaded.push({
        view,
        filename,
        url: `${mockupUrlBase}/${encodeURIComponent(filename)}`,
        bytes: buf.length,
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
