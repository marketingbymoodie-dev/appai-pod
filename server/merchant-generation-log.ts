/**
 * Best-effort generation_logs writes for merchant admin analytics.
 * Plan quota enforcement uses shopify_installations counters separately.
 */
import { storage } from "./storage";
import type { ShopifyInstallation } from "@shared/schema";

export interface MerchantGenerationLogInput {
  installation: Pick<ShopifyInstallation, "merchantId"> | { merchantId?: string | null };
  customerId?: string | null;
  designId?: string | number | null;
  promptLength: number;
  hadReferenceImage?: boolean;
  stylePreset?: string | null;
  size?: string | null;
  success: boolean;
  errorMessage?: string | null;
}

export async function logMerchantGeneration(input: MerchantGenerationLogInput): Promise<void> {
  const merchantId = input.installation.merchantId;
  if (!merchantId) return;

  try {
    await storage.createGenerationLog({
      merchantId,
      customerId: input.customerId ?? undefined,
      designId: typeof input.designId === "number" ? input.designId : undefined,
      promptLength: input.promptLength,
      hadReferenceImage: input.hadReferenceImage ?? false,
      stylePreset: input.stylePreset ?? undefined,
      size: input.size ?? undefined,
      success: input.success,
      errorMessage: input.errorMessage ?? undefined,
    });
  } catch (err) {
    console.warn("[generation-log] failed to write:", (err as Error).message);
  }
}
