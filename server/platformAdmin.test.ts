import { afterEach, describe, expect, it } from "vitest";
import { isPlatformAdminRequest } from "./platformAdmin";

describe("isPlatformAdminRequest", () => {
  const originalEnv = process.env.NODE_ENV;
  const originalOwner = process.env.OWNER_SHOP_DOMAIN;
  const originalList = process.env.PLATFORM_ADMIN_SHOP_DOMAINS;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    if (originalOwner === undefined) delete process.env.OWNER_SHOP_DOMAIN;
    else process.env.OWNER_SHOP_DOMAIN = originalOwner;
    if (originalList === undefined) delete process.env.PLATFORM_ADMIN_SHOP_DOMAINS;
    else process.env.PLATFORM_ADMIN_SHOP_DOMAINS = originalList;
  });

  it("allows all shops in non-production", () => {
    process.env.NODE_ENV = "development";
    expect(isPlatformAdminRequest({ shopDomain: "any.myshopify.com" })).toBe(true);
  });

  it("matches owner shop when env is bare handle and request is full domain", () => {
    process.env.NODE_ENV = "production";
    process.env.OWNER_SHOP_DOMAIN = "appai-2";
    delete process.env.PLATFORM_ADMIN_SHOP_DOMAINS;
    expect(isPlatformAdminRequest({ shopDomain: "appai-2.myshopify.com" })).toBe(true);
  });

  it("matches PLATFORM_ADMIN_SHOP_DOMAINS list", () => {
    process.env.NODE_ENV = "production";
    delete process.env.OWNER_SHOP_DOMAIN;
    process.env.PLATFORM_ADMIN_SHOP_DOMAINS = "other.myshopify.com, appai-2";
    expect(isPlatformAdminRequest({ shopDomain: "appai-2.myshopify.com" })).toBe(true);
  });

  it("denies when shop missing or not allowlisted", () => {
    process.env.NODE_ENV = "production";
    process.env.OWNER_SHOP_DOMAIN = "appai-2.myshopify.com";
    expect(isPlatformAdminRequest({ shopDomain: undefined })).toBe(false);
    expect(isPlatformAdminRequest({ shopDomain: "other.myshopify.com" })).toBe(false);
  });

  it("denies in production when no owner env is configured", () => {
    process.env.NODE_ENV = "production";
    delete process.env.OWNER_SHOP_DOMAIN;
    delete process.env.PLATFORM_ADMIN_SHOP_DOMAINS;
    expect(isPlatformAdminRequest({ shopDomain: "appai-2.myshopify.com" })).toBe(false);
  });
});
