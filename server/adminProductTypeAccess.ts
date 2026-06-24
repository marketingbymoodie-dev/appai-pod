import type { Request } from "express";
import type { Merchant, ProductType } from "@shared/schema";
import { isPlatformAdminRequest } from "./platformAdmin";

/**
 * Whether an authenticated admin may mutate a product type.
 * Platform operators may manage any catalog entry; merchants only their own
 * (legacy rows with null merchantId remain editable until backfilled).
 */
export function canAdminAccessProductType(
  req: Pick<Request, "shopDomain">,
  productType: ProductType | null | undefined,
  merchant: Merchant | null | undefined,
): productType is ProductType {
  if (!productType) return false;
  if (isPlatformAdminRequest(req)) return true;
  if (!merchant) return false;
  if (!productType.merchantId) return true;
  return productType.merchantId === merchant.id;
}
