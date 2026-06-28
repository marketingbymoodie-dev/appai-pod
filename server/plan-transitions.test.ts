import { describe, expect, it } from "vitest";
import {
  classifyPlanChange,
  resolveCarryoverIncludedUsed,
  buildUpgradePreview,
  buildDowngradePreview,
  comparePlanTier,
} from "./plan-transitions";

describe("classifyPlanChange", () => {
  it("trial to starter is trial_to_paid", () => {
    expect(classifyPlanChange("trial", "starter")).toBe("trial_to_paid");
  });

  it("starter to dabbler is paid_upgrade", () => {
    expect(classifyPlanChange("starter", "dabbler")).toBe("paid_upgrade");
  });

  it("pro to starter is paid_downgrade", () => {
    expect(classifyPlanChange("pro", "starter")).toBe("paid_downgrade");
  });

  it("comparePlanTier orders paid plans", () => {
    expect(comparePlanTier("starter", "dabbler")).toBeGreaterThan(0);
    expect(comparePlanTier("pro", "starter")).toBeLessThan(0);
  });
});

describe("resolveCarryoverIncludedUsed", () => {
  it("trial usage does not carry to paid", () => {
    expect(
      resolveCarryoverIncludedUsed({
        fromPlan: "trial",
        toPlan: "starter",
        includedUsed: 20,
      }),
    ).toBe(0);
  });

  it("paid upgrade carries included usage", () => {
    expect(
      resolveCarryoverIncludedUsed({
        fromPlan: "starter",
        toPlan: "dabbler",
        includedUsed: 200,
      }),
    ).toBe(200);
  });
});

describe("buildUpgradePreview", () => {
  it("trial to starter with 20 used shows full 250 remaining", () => {
    const p = buildUpgradePreview({
      currentPlan: "trial",
      newPlan: "starter",
      carryoverIncludedUsed: 0,
      newFreeQuota: 250,
      newPriceUsd: 29,
    });
    expect(p.newIncludedRemaining).toBe(250);
    expect(p.confirmationMessage).toMatch(/trial generations do not count/i);
    expect(p.confirmationMessage).not.toMatch(/20 already used/i);
  });

  it("starter to dabbler with 200 used shows 400 remaining", () => {
    const p = buildUpgradePreview({
      currentPlan: "starter",
      newPlan: "dabbler",
      carryoverIncludedUsed: 200,
      newFreeQuota: 600,
      newPriceUsd: 49,
    });
    expect(p.newIncludedRemaining).toBe(400);
    expect(p.confirmationMessage).toMatch(/200 already used/i);
  });
});

describe("buildDowngradePreview", () => {
  it("mentions deferred effective date", () => {
    const effective = new Date("2026-07-01T00:00:00Z");
    const p = buildDowngradePreview({
      currentPlan: "pro",
      newPlan: "starter",
      effectiveAt: effective,
      currentPeriodEnd: effective,
    });
    expect(p.isDowngrade).toBe(true);
    expect(p.confirmationMessage).toMatch(/until then you keep/i);
    expect(p.confirmationMessage).toMatch(/no rollover/i);
  });
});
