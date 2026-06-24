import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { adminProductTypeAccessError, canAdminAccessProductType } from "./adminProductTypeAccess";
import type { Merchant, ProductType } from "@shared/schema";

const merchantA = { id: "merchant-a" } as Merchant;
const productType = {
  id: 20,
  merchantId: "merchant-b",
} as ProductType;

describe("canAdminAccessProductType", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    delete process.env.OWNER_SHOP_DOMAIN;
  });

  it("allows platform admin on owner shop regardless of merchantId", () => {
    process.env.NODE_ENV = "production";
    process.env.OWNER_SHOP_DOMAIN = "appai-2.myshopify.com";
    const req = { shopDomain: "appai-2.myshopify.com" };
    expect(canAdminAccessProductType(req, productType, merchantA)).toBe(true);
  });

  it("denies other merchants when product belongs elsewhere", () => {
    process.env.NODE_ENV = "production";
    process.env.OWNER_SHOP_DOMAIN = "appai-2.myshopify.com";
    const req = { shopDomain: "other-shop.myshopify.com" };
    expect(canAdminAccessProductType(req, productType, merchantA)).toBe(false);
  });

  it("allows matching merchant", () => {
    process.env.NODE_ENV = "production";
    const req = { shopDomain: "other-shop.myshopify.com" };
    const owned = { ...productType, merchantId: "merchant-a" } as ProductType;
    expect(canAdminAccessProductType(req, owned, merchantA)).toBe(true);
  });

  it("allows legacy product types with null merchantId", () => {
    process.env.NODE_ENV = "production";
    const req = { shopDomain: "other-shop.myshopify.com" };
    const legacy = { ...productType, merchantId: null } as ProductType;
    expect(canAdminAccessProductType(req, legacy, merchantA)).toBe(true);
  });

  it("allows any product in development", () => {
    process.env.NODE_ENV = "development";
    const req = { shopDomain: "dev.localhost" };
    expect(canAdminAccessProductType(req, productType, merchantA)).toBe(true);
  });
});

describe("adminProductTypeAccessError", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    delete process.env.OWNER_SHOP_DOMAIN;
  });

  it("returns 404 when product type is missing", () => {
    process.env.NODE_ENV = "production";
    const req = { shopDomain: "other-shop.myshopify.com" };
    expect(adminProductTypeAccessError(req, null, merchantA)).toEqual({
      status: 404,
      error: "Product type not found",
      code: "PRODUCT_TYPE_NOT_FOUND",
    });
  });

  it("returns 403 when product belongs to another merchant", () => {
    process.env.NODE_ENV = "production";
    process.env.OWNER_SHOP_DOMAIN = "appai-2.myshopify.com";
    const req = { shopDomain: "other-shop.myshopify.com" };
    expect(adminProductTypeAccessError(req, productType, merchantA)).toEqual({
      status: 403,
      error:
        "This product belongs to another store's catalog. Import it into your shop to manage it here.",
      code: "PRODUCT_TYPE_FORBIDDEN",
    });
  });
});
