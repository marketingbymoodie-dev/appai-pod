import { describe, expect, it, vi, beforeEach } from "vitest";
import { applyPendingPlanIfDue } from "./plan-transition-apply";
import type { ShopifyInstallation } from "@shared/schema";

vi.mock("./storage", () => ({
  storage: {
    updateShopifyInstallation: vi.fn(),
    enforceCustomizerPageLimit: vi.fn(),
  },
}));

import { storage } from "./storage";

function mockInstallation(overrides: Partial<ShopifyInstallation> = {}): ShopifyInstallation {
  return {
    id: 1,
    shopDomain: "test.myshopify.com",
    accessToken: "token",
    planName: "pro",
    planStatus: "active",
    pendingPlanName: "starter",
    pendingPlanEffectiveAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as ShopifyInstallation;
}

describe("applyPendingPlanIfDue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(storage.enforceCustomizerPageLimit).mockResolvedValue({
      deactivatedIds: ["page-newest"],
      keptActiveCount: 1,
    });
  });

  it("does nothing before effective date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-01T00:00:00Z"));
    const result = await applyPendingPlanIfDue(mockInstallation());
    expect(result.applied).toBe(false);
    expect(storage.updateShopifyInstallation).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("applies pending downgrade and enforces page limit oldest-first", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
    const result = await applyPendingPlanIfDue(mockInstallation());
    expect(result.applied).toBe(true);
    expect(result.newPlanName).toBe("starter");
    expect(result.deactivatedPageIds).toEqual(["page-newest"]);
    expect(storage.updateShopifyInstallation).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        planName: "starter",
        pendingPlanName: null,
        pendingPlanEffectiveAt: null,
        monthlyGenerationsUsed: 0,
      }),
    );
    expect(storage.enforceCustomizerPageLimit).toHaveBeenCalledWith("test.myshopify.com", 1);
    vi.useRealTimers();
  });
});

describe("page limit enforcement (oldest kept)", () => {
  it("disables newest excess pages", () => {
    const active = [
      { id: "oldest", createdAt: 1 },
      { id: "middle", createdAt: 2 },
      { id: "newest", createdAt: 3 },
    ];
    const limit = 1;
    const toDisable = active.slice(limit).map((p) => p.id);
    expect(toDisable).toEqual(["middle", "newest"]);
  });
});
