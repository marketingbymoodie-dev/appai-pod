import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";

export interface PlanGenerationQuota {
  plan: string | null;
  unlimited: boolean;
  freeQuota: number | null;
  overageCap: number;
  limit: number | null;
  used: number;
  remaining: number | null;
  overageUsed: number;
  overagePriceUsd: number;
  isOverage: boolean;
}

export interface PlanApiResponse {
  planName: string | null;
  planStatus: string | null;
  isActive: boolean;
  generationQuota: PlanGenerationQuota;
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
  /** Show compact inline bar (Customizer Pages). Default: full card. */
  variant?: "card" | "inline";
  /** Link target for upgrade when at/near limit */
  upgradeHref?: string;
  onUpgradeClick?: () => void;
  /** Hide the manage/upgrade link (e.g. on Plan & Billing page). */
  showManageLink?: boolean;
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

export default function GenerationQuotaUsage({
  variant = "card",
  upgradeHref = "/admin/plan",
  onUpgradeClick,
  showManageLink = true,
  className,
}: GenerationQuotaUsageProps) {
  const { data, isLoading } = usePlanGenerationQuota();
  const quota = data?.generationQuota;
  const planName = data?.planName;
  const planStatus = data?.planStatus;

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

  const limit = quota.unlimited ? null : quota.limit;
  const used = quota.used ?? 0;
  const pct =
    limit && limit > 0 ? Math.min((used / limit) * 100, 100) : quota.unlimited ? 0 : 0;
  const atLimit = !quota.unlimited && limit != null && used >= limit;
  const nearLimit = !quota.unlimited && limit != null && used >= limit * 0.8;
  const displayPlan = planName ? (PLAN_DISPLAY[planName] ?? planName) : "—";
  const period = quotaLabel(quota);

  const bar = (
    <>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
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
          <span className="text-sm text-muted-foreground" data-testid="text-generation-quota">
            {quota.unlimited ? `${used.toLocaleString()} used` : `${used} / ${limit} (${period})`}
          </span>
          {(showManageLink && (onUpgradeClick || upgradeHref)) && (
            onUpgradeClick ? (
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onUpgradeClick}>
                <ArrowUpRight className="h-3 w-3 mr-1" />
                {atLimit ? "Upgrade" : "Manage Plan"}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" className="h-7 text-xs" asChild>
                <Link href={upgradeHref!}>
                  <ArrowUpRight className="h-3 w-3 mr-1" />
                  {atLimit ? "Upgrade" : "Manage Plan"}
                </Link>
              </Button>
            )
          )}
        </div>
      </div>
      {!quota.unlimited && (
        <div className="h-2 bg-muted rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              atLimit ? "bg-red-500" : nearLimit ? "bg-amber-500" : "bg-primary"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {quota.unlimited && (
        <p className="text-xs text-muted-foreground mt-1">Owner store — no plan cap.</p>
      )}
      {atLimit && !quota.unlimited && (
        <p className="text-xs text-red-600 mt-2 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          {quota.plan === "trial"
            ? "Trial limit reached. Upgrade to Starter to keep generating."
            : "Monthly generation limit reached. Resets at the start of next month, or upgrade for a higher cap."}
        </p>
      )}
      {!atLimit && !quota.unlimited && quota.isOverage && quota.overageCap > 0 && (
        <p className="text-xs text-muted-foreground mt-2">
          Using overage: {quota.overageUsed} paid generation
          {quota.overageUsed !== 1 ? "s" : ""} this period ($
          {quota.overagePriceUsd.toFixed(2)} each, max {quota.overageCap}/mo).
        </p>
      )}
      <p className="text-xs text-muted-foreground mt-2">
        Customer-purchased credit packs ($1 / 10) do not count toward this shop quota.
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
