import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Hoisted mocks (vi.mock factories run before imports) ────────────────────
const h = vi.hoisted(() => {
  const returning = vi.fn();
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    returning,
  };
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: updateWhere,
  };
  const db = {
    insert: vi.fn(() => insertChain),
    update: vi.fn(() => updateChain),
    select: vi.fn(),
  };
  return { returning, insertChain, updateChain, updateWhere, db };
});

vi.mock("./db", () => ({ db: h.db, pool: {} }));

import { extractUsageLineItemId, emitOverageUsageCharge } from "./usage-billing";

// ── Pure: extract the usage line item GID ───────────────────────────────────
describe("extractUsageLineItemId", () => {
  it("returns the line item whose pricing details are AppUsagePricingDetails", () => {
    const sub = {
      lineItems: [
        { id: "gid://shopify/AppSubscriptionLineItem/1", plan: { pricingDetails: { __typename: "AppRecurringPricingDetails" } } },
        { id: "gid://shopify/AppSubscriptionLineItem/2", plan: { pricingDetails: { __typename: "AppUsagePricingDetails" } } },
      ],
    };
    expect(extractUsageLineItemId(sub)).toBe("gid://shopify/AppSubscriptionLineItem/2");
  });

  it("returns null when there is no usage line (trial / legacy subscription)", () => {
    const sub = {
      lineItems: [
        { id: "gid://x/1", plan: { pricingDetails: { __typename: "AppRecurringPricingDetails" } } },
      ],
    };
    expect(extractUsageLineItemId(sub)).toBeNull();
    expect(extractUsageLineItemId(null)).toBeNull();
    expect(extractUsageLineItemId(undefined)).toBeNull();
    expect(extractUsageLineItemId({} as any)).toBeNull();
  });
});

// ── emitOverageUsageCharge (mocked DB + fetch) ──────────────────────────────
const installWithLine = {
  id: 7,
  shopDomain: "shop.myshopify.com",
  accessToken: "tok",
  billingUsageLineItemId: "gid://shopify/AppSubscriptionLineItem/99",
} as any;

function mockFetchOk(usageRecordId = "gid://shopify/AppUsageRecord/1", userErrors: any[] = []) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      data: { appUsageRecordCreate: { userErrors, appUsageRecord: userErrors.length ? null : { id: usageRecordId } } },
    }),
  });
}

describe("emitOverageUsageCharge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: the pending row was newly inserted (not a duplicate).
    h.returning.mockResolvedValue([{ id: 123 }]);
  });

  it("creates a Shopify usage record for the overage unit at the right price/line", async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);

    const res = await emitOverageUsageCharge({
      installation: installWithLine,
      bucketKey: "2026-06",
      overageSeq: 3,
      priceUsd: 0.08,
    });

    expect(res.status).toBe("charged");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/admin/api/2025-10/graphql.json");
    const body = JSON.parse(init.body);
    expect(body.query).toContain("appUsageRecordCreate");
    expect(body.variables.subscriptionLineItemId).toBe("gid://shopify/AppSubscriptionLineItem/99");
    expect(body.variables.price).toEqual({ amount: "0.08", currencyCode: "USD" });
    expect(body.variables.description).toContain("2026-06");

    vi.unstubAllGlobals();
  });

  it("does NOT call Shopify and records 'skipped' when the subscription has no usage line", async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);

    const res = await emitOverageUsageCharge({
      installation: { ...installWithLine, billingUsageLineItemId: null },
      bucketKey: "2026-06",
      overageSeq: 1,
      priceUsd: 0.08,
    });

    expect(res.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("is idempotent: a duplicate overage unit bills nothing", async () => {
    h.returning.mockResolvedValue([]); // ON CONFLICT DO NOTHING → no row
    const fetchMock = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);

    const res = await emitOverageUsageCharge({
      installation: installWithLine,
      bucketKey: "2026-06",
      overageSeq: 3,
      priceUsd: 0.08,
    });

    expect(res.status).toBe("duplicate");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("records 'failed' (and never throws) on a Shopify userError", async () => {
    const fetchMock = mockFetchOk("", [{ field: ["price"], message: "Capped amount exceeded" }]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await emitOverageUsageCharge({
      installation: installWithLine,
      bucketKey: "2026-06",
      overageSeq: 999,
      priceUsd: 0.08,
    });

    expect(res.status).toBe("failed");
    expect(res.error).toContain("Capped amount exceeded");
    vi.unstubAllGlobals();
  });

  it("never throws even if the network call rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await emitOverageUsageCharge({
      installation: installWithLine,
      bucketKey: "2026-06",
      overageSeq: 4,
      priceUsd: 0.08,
    });

    expect(res.status).toBe("failed");
    vi.unstubAllGlobals();
  });
});
