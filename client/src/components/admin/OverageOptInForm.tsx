import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { PlanApiResponse } from "./GenerationQuotaUsage";

const OVERAGE_PRICE_USD = 0.08;

interface OverageOptInFormProps {
  planMaxBudgetCents: number;
  onSuccess?: () => void;
  className?: string;
}

export function OverageOptInForm({ planMaxBudgetCents, onSuccess, className }: OverageOptInFormProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const maxUsd = planMaxBudgetCents / 100;
  const [budgetUsd, setBudgetUsd] = useState(Math.min(8, maxUsd));
  const [recurring, setRecurring] = useState<"once" | "repeat">("once");
  const [acknowledged, setAcknowledged] = useState(false);

  const budgetCents = Math.round(budgetUsd * 100);
  const step = OVERAGE_PRICE_USD;

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/appai/billing/overage-opt-in", {
        budgetCents,
        recurring: recurring === "repeat",
        acknowledged: true,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to enable extra usage");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/appai/plan"] });
      toast({
        title: "Extra usage enabled",
        description: `Pay-as-you-go generations are active up to $${budgetUsd.toFixed(2)} USD this period.`,
      });
      onSuccess?.();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className={`rounded-lg border border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 p-4 space-y-4 ${className ?? ""}`}>
      <div>
        <p className="text-sm font-medium">Enable pay-as-you-go extra generations (USD)</p>
        <p className="text-xs text-muted-foreground mt-1">
          After your included allowance, each extra generation costs ${OVERAGE_PRICE_USD.toFixed(2)} USD,
          billed through Shopify up to your chosen cap (not a prepaid pack).
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="overage-budget">Maximum spend this period (USD)</Label>
        <Input
          id="overage-budget"
          type="number"
          min={step}
          max={maxUsd}
          step={step}
          value={budgetUsd}
          onChange={(e) => setBudgetUsd(Math.min(maxUsd, Math.max(step, Number(e.target.value) || step)))}
        />
        <p className="text-xs text-muted-foreground">
          Up to {Math.floor(budgetCents / 8)} extra generations · plan max ${maxUsd.toFixed(2)} USD
        </p>
      </div>

      <RadioGroup value={recurring} onValueChange={(v) => setRecurring(v as "once" | "repeat")}>
        <div className="flex items-center space-x-2">
          <RadioGroupItem value="once" id="recurring-once" />
          <Label htmlFor="recurring-once" className="font-normal">
            This month only
          </Label>
        </div>
        <div className="flex items-center space-x-2">
          <RadioGroupItem value="repeat" id="recurring-repeat" />
          <Label htmlFor="recurring-repeat" className="font-normal">
            Repeat every billing period until I turn off
          </Label>
        </div>
      </RadioGroup>

      <div className="flex items-start gap-2">
        <Checkbox
          id="overage-ack"
          checked={acknowledged}
          onCheckedChange={(c) => setAcknowledged(!!c)}
        />
        <Label htmlFor="overage-ack" className="text-xs font-normal leading-relaxed">
          I understand extra generations are <strong>${OVERAGE_PRICE_USD.toFixed(2)} USD each</strong>, billed
          pay-as-you-go up to <strong>${budgetUsd.toFixed(2)} USD</strong> this period (not a prepaid pack).
        </Label>
      </div>

      <Button
        size="sm"
        disabled={!acknowledged || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
        Enable extra usage
      </Button>
    </div>
  );
}

export function planMaxBudgetFromApi(data: PlanApiResponse | undefined): number {
  return data?.overage?.planMaxBudgetCents ?? 1600;
}
