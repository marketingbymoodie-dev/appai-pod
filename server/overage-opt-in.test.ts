import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  budgetCentsToOverageUnits,
  includedUsedFromCounters,
  isOverageOptInActive,
  planMaxOverageBudgetCents,
  resolveEffectiveOverageCap,
  OVERAGE_PRICE_CENTS,
} from "./overage-settings";
import { resolveGenerationQuota } from "./customizer-plans";
import { buildUpgradePreview } from "./plan-transitions";

describe("overage opt-in settings", () => {
  const starterQuota = resolveGenerationQuota("starter", true);

  it("returns 0 effective cap when not opted in", () => {
    const cap = resolveEffectiveOverageCap(
      { overageOptInEnabled: false, overageBudgetCents: 800, overageRecurring: false, overageOptInBucketKey: "2026-06" },
      starterQuota,
    );
    expect(cap).toBe(0);
  });

  it("opt-in $8 USD → max 100 extra units on Starter", () => {
    const cap = resolveEffectiveOverageCap(
      {
        overageOptInEnabled: true,
        overageBudgetCents: 800,
        overageRecurring: false,
        overageOptInBucketKey: starterQuota.bucketKey,
      },
      starterQuota,
    );
    expect(cap).toBe(100);
    expect(budgetCentsToOverageUnits(800)).toBe(100);
    expect(100 * OVERAGE_PRICE_CENTS).toBe(800);
  });

  it("caps merchant budget by plan max units", () => {
    const cap = resolveEffectiveOverageCap(
      {
        overageOptInEnabled: true,
        overageBudgetCents: planMaxOverageBudgetCents("starter"),
        overageRecurring: true,
        overageOptInBucketKey: starterQuota.bucketKey,
      },
      starterQuota,
    );
    expect(cap).toBe(starterQuota.overageCap);
  });

  it("includedUsed excludes overage counters", () => {
    expect(includedUsedFromCounters(260, 10)).toBe(250);
  });

  it("isOverageOptInActive requires matching bucket key", () => {
    expect(
      isOverageOptInActive(
        {
          overageOptInEnabled: true,
          overageBudgetCents: 800,
          overageRecurring: false,
          overageOptInBucketKey: "2026-05",
        },
        "2026-06",
      ),
    ).toBe(false);
  });
});

describe("buildUpgradePreview", () => {
  it("remaining included = newFreeQuota - carryover (overage does not reduce)", () => {
    const preview = buildUpgradePreview({
      currentPlan: "starter",
      newPlan: "pro",
      carryoverIncludedUsed: 200,
      newFreeQuota: 1500,
      newPriceUsd: 99,
    });
    expect(preview.newIncludedRemaining).toBe(1300);
    expect(preview.includedConsumed).toBe(200);
    expect(preview.currency).toBe("USD");
    expect(preview.confirmationMessage).toMatch(/USD/);
  });
});

vi.mock("./storage", () => ({
  storage: {
    syncOverageOptInForBucket: vi.fn(),
    getShopifyInstallation: vi.fn(),
    getMerchantGenerationUsage: vi.fn(),
    consumeMerchantGeneration: vi.fn(),
  },
}));

vi.mock("./usage-billing", () => ({
  emitOverageUsageCharge: vi.fn().mockResolvedValue({ status: "charged" }),
}));

import { storage } from "./storage";
import {
  consumeMerchantGenerationQuota,
  peekMerchantGenerationQuota,
} from "./generation-quota";

const paidInstall = {
  id: 1,
  shopDomain: "test-shop.myshopify.com",
  planName: "starter",
  planStatus: "active",
  overageOptInEnabled: false,
  overageBudgetCents: null,
  overageRecurring: false,
  overageOptInBucketKey: null,
  generationMonth: "2026-06",
} as any;

describe("opt-in gating", () => {
  let currentInstall = paidInstall;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OWNER_SHOP_DOMAIN;
    currentInstall = paidInstall;
    (storage.syncOverageOptInForBucket as any).mockResolvedValue(undefined);
    (storage.getShopifyInstallation as any).mockImplementation(async () => currentInstall);
  });

  it("blocks at included cap without opt-in (OVERAGE_OPT_IN_REQUIRED)", async () => {
    (storage.getMerchantGenerationUsage as any).mockResolvedValue({ used: 250, overageUsed: 0 });
    const decision = await peekMerchantGenerationQuota(paidInstall);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("OVERAGE_OPT_IN_REQUIRED");
  });

  it("allows extra gens when opted in with budget", async () => {
    (storage.getMerchantGenerationUsage as any).mockResolvedValue({ used: 250, overageUsed: 0 });
    currentInstall = {
      ...paidInstall,
      overageOptInEnabled: true,
      overageBudgetCents: 800,
      overageOptInBucketKey: "2026-06",
    };
    const decision = await peekMerchantGenerationQuota(currentInstall);
    expect(decision.allowed).toBe(true);
    expect(decision.extraLimit).toBe(100);
  });

  it("blocks when opted-in budget exhausted (OVERAGE_BUDGET_EXHAUSTED)", async () => {
    (storage.getMerchantGenerationUsage as any).mockResolvedValue({ used: 350, overageUsed: 100 });
    currentInstall = {
      ...paidInstall,
      overageOptInEnabled: true,
      overageBudgetCents: 800,
      overageOptInBucketKey: "2026-06",
    };
    const decision = await peekMerchantGenerationQuota(currentInstall);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("OVERAGE_BUDGET_EXHAUSTED");
  });

  it("does not emit overage charge when consume blocked", async () => {
    (storage.consumeMerchantGeneration as any).mockResolvedValue({
      allowed: false,
      used: 250,
      overageUsed: 0,
      isOverage: false,
    });
    const decision = await consumeMerchantGenerationQuota(paidInstall);
    expect(decision.allowed).toBe(false);
    const { emitOverageUsageCharge } = await import("./usage-billing");
    expect(emitOverageUsageCharge).not.toHaveBeenCalled();
  });
});
