import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { OverageOptInForm, planMaxBudgetFromApi } from "./OverageOptInForm";

export interface PlanGenerationQuota {
  plan: string | null;
  unlimited: boolean;
  freeQuota: number | null;
  overageCap: number;
  planOverageCap?: number;
  limit: number | null;
  used: number;
  remaining: number | null;
  overageUsed: number;
  overagePriceUsd: number;
  isOverage: boolean;
  includedUsed?: number;
  includedLimit?: number | null;
  includedRemaining?: number | null;
  extraUsed?: number;
  extraLimit?: number;
  extraBudgetCents?: number | null;
  extraSpentCents?: number;
  extraRemainingCents?: number | null;
  overageOptInEnabled?: boolean;
  overageRecurring?: boolean;
  showOptInForm?: boolean;
  includedExhausted?: boolean;
  currency?: string;
}

export interface PlanOverageBlock {
  priceCents: number;
  priceUsd: number;
  currency: string;
  optInEnabled: boolean;
  recurring: boolean;
  budgetCents: number | null;
  spentCents: number;
  remainingCents: number | null;
  planMaxBudgetCents: number;
  planMaxUnits: number;
  effectiveUnitCap: number;
  requiresOptIn: boolean;
  showOptInForm: boolean;
}

export interface PlanApiResponse {
  planName: string | null;
  planStatus: string | null;
  isActive: boolean;
  generationQuota: PlanGenerationQuota;
  included?: { used: number; limit: number | null; remaining: number | null; currency: string };
  extra?: {
    used: number;
    unitLimit: number;
    budgetCents: number | null;
    spentCents: number;
    remainingCents: number | null;
    currency: string;
  };
  overage?: PlanOverageBlock;
  usdDisclaimer?: string;
}

const PLAN_DISPLAY: Record<string, string> = {
  trial: "Trial",
  starter: "Starter",
  dabbler: "Dabbler",
  pro: "Pro",
  pro_plus: "Pro Plus",
};

function quotaLabel(quota: PlanGenerationQuota): string {
  if (quota.unlimited) return "Unlimited (owner store)";
  if (quota.plan === "trial") return "trial total";
  return "this month";
}

interface GenerationQuotaUsageProps {
  variant?: "card" | "inline";
  upgradeHref?: string;
  onUpgradeClick?: () => void;
  showManageLink?: boolean;
  /** Show overage opt-in form when at ≥90% included (default true). */
  showOptInForm?: boolean;
  className?: string;
}

export function usePlanGenerationQuota(enabled = true) {
  return useQuery<PlanApiResponse>({
    queryKey: ["/api/appai/plan"],
    enabled,
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/appai/plan");
      return res.json();
    },
  });
}

function UsageBar({
  label,
  used,
  limit,
  spentCents,
  budgetCents,
  atLimit,
  nearLimit,
}: {
  label: string;
  used: number;
  limit: number | null;
  spentCents?: number;
  budgetCents?: number | null;
  atLimit: boolean;
  nearLimit: boolean;
}) {
  const pct = limit && limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs gap-2 flex-wrap">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          {limit != null ? `${used} / ${limit}` : `${used} used`}
          {spentCents != null && budgetCents != null && budgetCents > 0 && (
            <> · ${(spentCents / 100).toFixed(2)} / ${(budgetCents / 100).toFixed(2)} USD</>
          )}
        </span>
      </div>
      {limit != null && limit > 0 && (
        <div className="h-2 bg-muted rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              atLimit ? "bg-red-500" : nearLimit ? "bg-amber-500" : "bg-primary"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

export default function GenerationQuotaUsage({
  variant = "card",
  upgradeHref = "/admin/plan",
  onUpgradeClick,
  showManageLink = true,
  showOptInForm = true,
  className,
}: GenerationQuotaUsageProps) {
  const { data, isLoading } = usePlanGenerationQuota();
  const quota = data?.generationQuota;
  const planName = data?.planName;
  const planStatus = data?.planStatus;
  const overage = data?.overage;

  if (isLoading) {
    if (variant === "inline") {
      return <Skeleton className={`h-10 w-full ${className ?? ""}`} />;
    }
    return (
      <Card className={className}>
        <CardContent className="pt-4 pb-4">
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!quota) return null;

  const includedUsed = data?.included?.used ?? quota.includedUsed ?? quota.used;
  const includedLimit = data?.included?.limit ?? quota.includedLimit ?? quota.freeQuota;
  const extraUsed = data?.extra?.used ?? quota.extraUsed ?? quota.overageUsed;
  const extraLimit = data?.extra?.unitLimit ?? quota.extraLimit ?? quota.overageCap;
  const extraBudgetCents = data?.extra?.budgetCents ?? quota.extraBudgetCents ?? null;
  const extraSpentCents = data?.extra?.spentCents ?? quota.extraSpentCents ?? 0;

  const includedAtLimit =
    !quota.unlimited && includedLimit != null && includedUsed >= includedLimit;
  const includedNearLimit =
    !quota.unlimited && includedLimit != null && includedUsed >= includedLimit * 0.9;
  const extraAtLimit = extraLimit > 0 && extraUsed >= extraLimit;
  const displayPlan = planName ? (PLAN_DISPLAY[planName] ?? planName) : "—";
  const period = quotaLabel(quota);
  const showForm =
    showOptInForm &&
    (overage?.showOptInForm || quota.showOptInForm) &&
    !quota.unlimited &&
    planName !== "trial";

  const bar = (
    <>
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <span className="text-sm font-medium flex items-center gap-2">
          AI generations
          {planName && (
            <Badge variant="secondary" className="capitalize">
              {displayPlan}
            </Badge>
          )}
          {planStatus === "trialing" && (
            <Badge variant="outline" className="text-yellow-600 border-yellow-400">
              Trial
            </Badge>
          )}
        </span>
        <div className="flex items-center gap-3">
          {!quota.unlimited && includedLimit != null && (
            <span className="text-sm text-muted-foreground" data-testid="text-generation-quota">
              {includedUsed} / {includedLimit} included ({period})
            </span>
          )}
          {quota.unlimited && (
            <span className="text-sm text-muted-foreground">{includedUsed.toLocaleString()} used</span>
          )}
          {showManageLink && (onUpgradeClick || upgradeHref) && (
            onUpgradeClick ? (
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onUpgradeClick}>
                <ArrowUpRight className="h-3 w-3 mr-1" />
                {includedAtLimit ? "Upgrade" : "Manage Plan"}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" className="h-7 text-xs" asChild>
                <Link href={upgradeHref!}>
                  <ArrowUpRight className="h-3 w-3 mr-1" />
                  {includedAtLimit ? "Upgrade" : "Manage Plan"}
                </Link>
              </Button>
            )
          )}
        </div>
      </div>

      {!quota.unlimited && (
        <div className="space-y-3">
          <UsageBar
            label="Included (USD plan allowance)"
            used={includedUsed}
            limit={includedLimit}
            atLimit={includedAtLimit}
            nearLimit={includedNearLimit && !includedAtLimit}
          />
          {(overage?.optInEnabled || quota.overageOptInEnabled || showForm || includedNearLimit) &&
            planName !== "trial" && (
              <UsageBar
                label="Extra pay-as-you-go (USD)"
                used={extraUsed}
                limit={extraLimit > 0 ? extraLimit : null}
                spentCents={extraSpentCents}
                budgetCents={extraBudgetCents}
                atLimit={extraAtLimit}
                nearLimit={false}
              />
            )}
        </div>
      )}

      {quota.unlimited && (
        <p className="text-xs text-muted-foreground mt-1">Owner store — no plan cap.</p>
      )}

      {includedAtLimit && !quota.overageOptInEnabled && !overage?.optInEnabled && !quota.unlimited && (
        <p className="text-xs text-red-600 mt-3 flex items-start gap-1">
          <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
          {quota.plan === "trial"
            ? "Trial limit reached. Upgrade to Starter to keep generating."
            : "Included allowance used up. Merchant-billed generations are blocked until next period, you enable extra usage, or upgrade. Customer credit packs still work."}
        </p>
      )}

      {showForm && (
        <OverageOptInForm
          className="mt-4"
          planMaxBudgetCents={planMaxBudgetFromApi(data)}
        />
      )}

      <p className="text-xs text-muted-foreground mt-3">
        {data?.usdDisclaimer ?? "All prices in USD."} Customer-purchased credit packs ($1 / 10) do not
        count toward this shop quota.
      </p>
    </>
  );

  if (variant === "inline") {
    return <div className={className}>{bar}</div>;
  }

  return (
    <Card className={className}>
      <CardContent className="pt-4 pb-4">{bar}</CardContent>
    </Card>
  );
}
