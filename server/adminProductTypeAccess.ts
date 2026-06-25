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
  return adminProductTypeAccessError(req, productType, merchant) === null;
}

/** Distinguish missing rows from cross-merchant catalog entries. */
export function adminProductTypeAccessError(
  req: Pick<Request, "shopDomain">,
  productType: ProductType | null | undefined,
  merchant: Merchant | null | undefined,
): { status: number; error: string; code: string } | null {
  if (!productType) {
    return { status: 404, error: "Product type not found", code: "PRODUCT_TYPE_NOT_FOUND" };
  }
  if (canAdminAccessProductTypeInternal(req, productType, merchant)) {
    return null;
  }
  return {
    status: 403,
    error:
      "This product belongs to another store's catalog. Import it into your shop to manage it here.",
    code: "PRODUCT_TYPE_FORBIDDEN",
  };
}

function canAdminAccessProductTypeInternal(
  req: Pick<Request, "shopDomain">,
  productType: ProductType,
  merchant: Merchant | null | undefined,
): boolean {
  if (isPlatformAdminRequest(req)) return true;
  if (!merchant) return false;
  if (!productType.merchantId) return true;
  return productType.merchantId === merchant.id;
}
