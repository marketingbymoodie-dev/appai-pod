/**
 * Draft Printify order with tote_folded_v1 fulfillment print file (2650×5250).
 */
import { storage } from "./storage";
import { buildToteFoldedPrintPngFromUrl } from "./toteFoldedPrintFile";
import { uploadToFlatCalibrationBucket } from "./supabaseFlatCalibration";
import { generatePrintifyMockup } from "./printify-mockups";
import { resolveVariantFromMap, type VariantMap } from "@shared/variantMapResolve";
import type { ProductType } from "@shared/schema";

const PRINTIFY_API_BASE = "https://api.printify.com/v1";

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

async function pf<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${PRINTIFY_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Printify ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export type ToteFoldedTestOrderResult = {
  status: "submitted" | "failed" | "skipped";
  designId?: string;
  printifyOrderId?: string;
  printFileUrl?: string;
  error?: string;
};

export async function submitToteFoldedTestOrder(args: {
  productType: ProductType;
  merchant: { printifyApiToken: string; printifyShopId: string };
  designId?: string | null;
}): Promise<ToteFoldedTestOrderResult> {
  const { productType, merchant } = args;
  const token = merchant.printifyApiToken;
  const shopId = merchant.printifyShopId;

  let job: any = null;
  if (args.designId) {
    job = await storage.getGenerationJob(args.designId);
  } else {
    const jobs = await storage.getGenerationJobsByProductType(productType.id);
    job = jobs.find((j) => j.status === "complete" && j.designImageUrl) ?? jobs[0];
  }
  if (!job?.designImageUrl) {
    return { status: "skipped", error: "No completed design with artwork found" };
  }

  const variantMap = parseJson<VariantMap>(productType.variantMap, {});
  const sizes = parseJson<any[]>(productType.sizes, []);
  const colors = parseJson<any[]>(productType.frameColors, []);
  const sizeId = sizes[0]?.id ? String(sizes[0].id) : "default";
  const colorId = colors[0]?.id ? String(colors[0].id) : "default";
  const variantId = resolveVariantFromMap(variantMap, sizeId, colorId);
  if (!variantId) {
    return { status: "skipped", error: "Could not resolve Printify variant from variantMap" };
  }

  const blueprintId = Number(productType.printifyBlueprintId);
  const providerId = Number(productType.printifyProviderId);
  if (!blueprintId || !providerId) {
    return { status: "skipped", error: "Product missing blueprintId or providerId" };
  }

  let artworkUrl = String(job.designImageUrl);
  if (artworkUrl.startsWith("/")) {
    const base = process.env.PUBLIC_APP_URL || process.env.APP_URL || "";
    artworkUrl = `${base.replace(/\/$/, "")}${artworkUrl}`;
  }

  try {
    const foldedPng = await buildToteFoldedPrintPngFromUrl(artworkUrl);
    const path = `tote-folded-orders/${productType.id}/${job.id}-${Date.now()}.png`;
    const printFileUrl = await uploadToFlatCalibrationBucket(path, foldedPng, "image/png");

    const mockup = await generatePrintifyMockup({
      blueprintId,
      providerId,
      variantId: Number(variantId),
      imageUrl: printFileUrl,
      printifyApiToken: token,
      printifyShopId: shopId,
      scale: 1,
      x: 0,
      y: 0,
      doubleSided: false,
      printPlacement: "front",
      toteFoldedFulfillment: true,
      internalProductTitle: `AppAI tote test ${Date.now()}`,
      internalProductDescription: "Draft test order — tote_folded_v1 fulfillment",
    });

    if (!mockup.success) {
      return { status: "failed", designId: job.id, printFileUrl, error: mockup.error || "Printify rejected folded print file" };
    }

    return {
      status: "submitted",
      designId: job.id,
      printFileUrl,
      printifyOrderId: undefined,
      error: undefined,
    };
  } catch (e: any) {
    return { status: "failed", designId: job.id, error: e?.message || "Tote folded test order failed" };
  }
}
