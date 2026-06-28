import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  resolveGenerationQuota,
  generationMonthKey,
  computeGenerationConsume,
  getPlanOverageCappedAmountUsd,
  OVERAGE_PRICE_USD,
  PLAN_GENERATION_QUOTAS,
  PLAN_OVERAGE_CAPS,
} from "./customizer-plans";

// ── Pure quota resolution ──────────────────────────────────────────────────

describe("resolveGenerationQuota", () => {
  const fixedNow = new Date(Date.UTC(2026, 5, 6)); // 2026-06-06

  it("maps each active paid plan to its monthly quota + overage cap", () => {
    for (const plan of ["starter", "dabbler", "pro", "pro_plus"] as const) {
      const q = resolveGenerationQuota(plan, true, fixedNow);
      expect(q.effectivePlan).toBe(plan);
      expect(q.freeQuota).toBe(PLAN_GENERATION_QUOTAS[plan]);
      expect(q.overageCap).toBe(PLAN_OVERAGE_CAPS[plan]);
      expect(q.hardCap).toBe(PLAN_GENERATION_QUOTAS[plan] + PLAN_OVERAGE_CAPS[plan]);
      expect(q.overagePriceUsd).toBe(0.08);
      expect(q.monthly).toBe(true);
      expect(q.bucketKey).toBe("2026-06");
    }
  });

  it("gives the trial allotment (20 free, no overage, cumulative) for trial plan", () => {
    const q = resolveGenerationQuota("trial", true, fixedNow);
    expect(q.effectivePlan).toBe("trial");
    expect(q.freeQuota).toBe(20);
    expect(q.overageCap).toBe(0);
    expect(q.hardCap).toBe(20);
    expect(q.overagePriceUsd).toBe(0);
    expect(q.monthly).toBe(false);
    expect(q.bucketKey).toBe("trial");
  });

  it("falls back to trial allotment when there is no plan or it is inactive", () => {
    expect(resolveGenerationQuota(null, false, fixedNow).effectivePlan).toBe("trial");
    expect(resolveGenerationQuota(undefined, true, fixedNow).effectivePlan).toBe("trial");
    // An inactive (cancelled/expired) paid plan should not grant the paid quota.
    const inactivePaid = resolveGenerationQuota("pro", false, fixedNow);
    expect(inactivePaid.effectivePlan).toBe("trial");
    expect(inactivePaid.hardCap).toBe(20);
  });
});

describe("getPlanOverageCappedAmountUsd", () => {
  it("computes the max monthly overage cost = cap × $0.08 per paid plan", () => {
    expect(getPlanOverageCappedAmountUsd("starter")).toBe(16);   // 200 × 0.08
    expect(getPlanOverageCappedAmountUsd("dabbler")).toBe(24);   // 300 × 0.08
    expect(getPlanOverageCappedAmountUsd("pro")).toBe(40);       // 500 × 0.08
    expect(getPlanOverageCappedAmountUsd("pro_plus")).toBe(80);  // 1000 × 0.08
  });

  it("matches cap × OVERAGE_PRICE_USD exactly (no float drift)", () => {
    for (const plan of ["starter", "dabbler", "pro", "pro_plus"] as const) {
      const expected = Math.round(PLAN_OVERAGE_CAPS[plan] * OVERAGE_PRICE_USD * 100) / 100;
      expect(getPlanOverageCappedAmountUsd(plan)).toBe(expected);
      expect(Number.isInteger(getPlanOverageCappedAmountUsd(plan) * 100)).toBe(true);
    }
  });

  it("is 0 for trial / unknown / null plans (no overage line)", () => {
    expect(getPlanOverageCappedAmountUsd("trial")).toBe(0);
    expect(getPlanOverageCappedAmountUsd(null)).toBe(0);
    expect(getPlanOverageCappedAmountUsd(undefined)).toBe(0);
    expect(getPlanOverageCappedAmountUsd("bogus")).toBe(0);
  });
});

describe("generationMonthKey", () => {
  it("formats as YYYY-MM in UTC", () => {
    expect(generationMonthKey(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01");
    expect(generationMonthKey(new Date(Date.UTC(2026, 11, 31)))).toBe("2026-12");
  });
});

// ── Pure consume math (cap + overage boundaries) ────────────────────────────

describe("computeGenerationConsume", () => {
  it("allows generations under the free quota without marking overage", () => {
    const o = computeGenerationConsume(0, 250, 200);
    expect(o.allowed).toBe(true);
    expect(o.isOverage).toBe(false);
    expect(o.hardCap).toBe(450);
  });

  it("marks the first generation past the free quota as overage", () => {
    // currentUsed === freeQuota means the free allotment is fully spent.
    const o = computeGenerationConsume(250, 250, 200);
    expect(o.allowed).toBe(true);
    expect(o.isOverage).toBe(true);
  });

  it("blocks once free + overage cap is exhausted", () => {
    const o = computeGenerationConsume(450, 250, 200);
    expect(o.allowed).toBe(false);
    expect(o.isOverage).toBe(false);
  });

  it("blocks the trial at the free allotment (no overage)", () => {
    expect(computeGenerationConsume(19, 20, 0).allowed).toBe(true);
    expect(computeGenerationConsume(19, 20, 0).isOverage).toBe(false);
    expect(computeGenerationConsume(20, 20, 0).allowed).toBe(false);
  });
});

// Simulate sequential consumption to validate end-to-end boundary behavior.
function simulate(total: number, freeQuota: number, overageCap: number) {
  let used = 0;
  let overage = 0;
  let blockedAt: number | null = null;
  for (let i = 0; i < total; i++) {
    const o = computeGenerationConsume(used, freeQuota, overageCap);
    if (!o.allowed) {
      if (blockedAt === null) blockedAt = i;
      continue;
    }
    used++;
    if (o.isOverage) overage++;
  }
  return { used, overage, blockedAt };
}

describe("quota enforcement simulation", () => {
  it("starter: 250 free then 200 overage then hard block", () => {
    const r = simulate(500, 250, 200);
    expect(r.used).toBe(450); // 250 free + 200 overage
    expect(r.overage).toBe(200);
    expect(r.blockedAt).toBe(450); // 451st attempt blocked
  });

  it("pro_plus: 3000 free + 1000 overage", () => {
    const r = simulate(4100, PLAN_GENERATION_QUOTAS.pro_plus, PLAN_OVERAGE_CAPS.pro_plus);
    expect(r.used).toBe(4000);
    expect(r.overage).toBe(1000);
    expect(r.blockedAt).toBe(4000);
  });

  it("trial: 20 free then blocked, never any overage", () => {
    const r = simulate(25, 20, 0);
    expect(r.used).toBe(20);
    expect(r.overage).toBe(0);
    expect(r.blockedAt).toBe(20);
  });
});

// ── Orchestration helper (with mocked storage) ──────────────────────────────

vi.mock("./storage", () => ({
  storage: {
    syncOverageOptInForBucket: vi.fn(),
    getShopifyInstallation: vi.fn(),
    getMerchantGenerationUsage: vi.fn(),
    consumeMerchantGeneration: vi.fn(),
  },
}));

// Mock the usage-billing module so the orchestration test never reaches the
// real Shopify/DB layer (importing ./db would require DATABASE_URL).
vi.mock("./usage-billing", () => ({
  emitOverageUsageCharge: vi.fn().mockResolvedValue({ status: "charged" }),
}));

import { storage } from "./storage";
import { emitOverageUsageCharge } from "./usage-billing";
import {
  consumeMerchantGenerationQuota,
  peekMerchantGenerationQuota,
  quotaBlockBody,
} from "./generation-quota";

const baseInstall = {
  id: 1,
  shopDomain: "test-shop.myshopify.com",
  planName: "starter",
  planStatus: "active",
  overageOptInEnabled: true,
  overageBudgetCents: 1600,
  overageRecurring: false,
  overageOptInBucketKey: "2026-06",
  generationMonth: "2026-06",
} as any;

describe("merchant quota orchestration", () => {
  const savedOwner = process.env.OWNER_SHOP_DOMAIN;
  let currentInstall = baseInstall;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OWNER_SHOP_DOMAIN;
    currentInstall = baseInstall;
    (storage.syncOverageOptInForBucket as any).mockResolvedValue(undefined);
    (storage.getShopifyInstallation as any).mockImplementation(async () => currentInstall);
  });
  afterEach(() => {
    if (savedOwner === undefined) delete process.env.OWNER_SHOP_DOMAIN;
    else process.env.OWNER_SHOP_DOMAIN = savedOwner;
  });

  it("blocks a trial shop at 20 with an upgrade-to-Starter message", async () => {
    (storage.consumeMerchantGeneration as any).mockResolvedValue({
      allowed: false,
      used: 20,
      overageUsed: 0,
      isOverage: false,
    });
    const inst = {
      id: 1,
      shopDomain: "test-shop.myshopify.com",
      planName: "trial",
      planStatus: "trialing",
      overageOptInEnabled: false,
      overageBudgetCents: null,
      overageOptInBucketKey: null,
      generationMonth: "trial",
    };
    currentInstall = inst;
    const decision = await consumeMerchantGenerationQuota(inst);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("TRIAL_LIMIT_REACHED");
    expect(decision.status).toBe(402);
    expect(decision.message).toMatch(/upgrade to starter/i);

    const body = quotaBlockBody(decision);
    expect(body.upgrade).toBe(true);
    expect(body.limit).toBe(20);
  });

  it("blocks a paid shop over cap with OVERAGE_BUDGET_EXHAUSTED", async () => {
    (storage.consumeMerchantGeneration as any).mockResolvedValue({
      allowed: false,
      used: 450,
      overageUsed: 200,
      isOverage: false,
    });
    const inst = { ...baseInstall, planName: "starter", planStatus: "active" };
    const decision = await consumeMerchantGenerationQuota(inst);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("OVERAGE_BUDGET_EXHAUSTED");
    expect(quotaBlockBody(decision).upgrade).toBe(false);
  });

  it("reports overage when a paid generation falls into the overage band", async () => {
    (storage.consumeMerchantGeneration as any).mockResolvedValue({
      allowed: true,
      used: 251,
      overageUsed: 1,
      isOverage: true,
    });
    const inst = { ...baseInstall, planName: "starter", planStatus: "active" };
    const decision = await consumeMerchantGenerationQuota(inst);
    expect(decision.allowed).toBe(true);
    expect(decision.isOverage).toBe(true);
    expect(decision.overagePriceUsd).toBe(0.08);
    expect(decision.remaining).toBe(450 - 251);
  });

  it("emits a usage charge for an overage generation at $0.08 with the running overage count", async () => {
    (storage.consumeMerchantGeneration as any).mockResolvedValue({
      allowed: true,
      used: 255,
      overageUsed: 5,
      isOverage: true,
    });
    const inst = { ...baseInstall, planName: "starter", planStatus: "active" };
    await consumeMerchantGenerationQuota(inst);
    expect(emitOverageUsageCharge).toHaveBeenCalledTimes(1);
    expect(emitOverageUsageCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        installation: inst,
        overageSeq: 5,
        priceUsd: 0.08,
      })
    );
  });

  it("does NOT emit a usage charge for a within-allotment (non-overage) generation", async () => {
    (storage.consumeMerchantGeneration as any).mockResolvedValue({
      allowed: true,
      used: 10,
      overageUsed: 0,
      isOverage: false,
    });
    const inst = { ...baseInstall, planName: "starter", planStatus: "active" };
    await consumeMerchantGenerationQuota(inst);
    expect(emitOverageUsageCharge).not.toHaveBeenCalled();
  });

  it("never emits a usage charge for a trial shop (no overage band)", async () => {
    (storage.consumeMerchantGeneration as any).mockResolvedValue({
      allowed: true,
      used: 5,
      overageUsed: 0,
      isOverage: false,
    });
    const inst = { ...baseInstall, planName: "trial", planStatus: "trialing" };
    await consumeMerchantGenerationQuota(inst);
    expect(emitOverageUsageCharge).not.toHaveBeenCalled();
  });

  it("bypasses metering for the owner shop (unlimited, no storage call)", async () => {
    process.env.OWNER_SHOP_DOMAIN = "test-shop.myshopify.com";
    const inst = { ...baseInstall, planName: null, planStatus: null };
    const decision = await consumeMerchantGenerationQuota(inst);
    expect(decision.allowed).toBe(true);
    expect(decision.unlimited).toBe(true);
    expect(storage.consumeMerchantGeneration).not.toHaveBeenCalled();
  });

  it("peek allows when under cap and computes remaining", async () => {
    (storage.getMerchantGenerationUsage as any).mockResolvedValue({ used: 10, overageUsed: 0 });
    const inst = { ...baseInstall, planName: "starter", planStatus: "active" };
    const decision = await peekMerchantGenerationQuota(inst);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(450 - 10);
  });
});
