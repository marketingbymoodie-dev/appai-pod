import { describe, expect, it } from "vitest";
import { normalizeMyshopifyShopDomain, shopDomainFromSessionClaim } from "./shopDomain";

describe("normalizeMyshopifyShopDomain", () => {
  it("normalizes bare handle, URL, and full domain", () => {
    expect(normalizeMyshopifyShopDomain("appai-2")).toBe("appai-2.myshopify.com");
    expect(normalizeMyshopifyShopDomain("appai-2.myshopify.com")).toBe("appai-2.myshopify.com");
    expect(normalizeMyshopifyShopDomain("https://appai-2.myshopify.com/admin")).toBe(
      "appai-2.myshopify.com",
    );
  });
});

describe("shopDomainFromSessionClaim", () => {
  it("parses dest with https scheme", () => {
    expect(shopDomainFromSessionClaim("https://appai-2.myshopify.com")).toEqual({
      shopDomain: "appai-2.myshopify.com",
      shopOrigin: "https://appai-2.myshopify.com",
    });
  });

  it("parses bare dest without scheme (Shopify docs form)", () => {
    expect(shopDomainFromSessionClaim("appai-2.myshopify.com")).toEqual({
      shopDomain: "appai-2.myshopify.com",
      shopOrigin: "https://appai-2.myshopify.com",
    });
  });

  it("falls back to iss when dest missing", () => {
    expect(shopDomainFromSessionClaim(undefined, "https://appai-2.myshopify.com/admin")).toEqual({
      shopDomain: "appai-2.myshopify.com",
      shopOrigin: "https://appai-2.myshopify.com",
    });
  });
});
