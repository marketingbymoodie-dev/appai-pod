import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle, Zap, LayoutTemplate, Star, Rocket } from "lucide-react";

interface PlanCardProps {
  name: string;
  displayName: string;
  price: number | null;
  pageLimit: number;
  description: string;
  highlight?: boolean;
  icon: React.ReactNode;
  ctaLabel: string;
  onSelect: () => void;
  loading: boolean;
}

function PlanCard({
  displayName, price, pageLimit, description, highlight, icon, ctaLabel, onSelect, loading,
}: PlanCardProps) {
  return (
    <Card className={`relative flex flex-col ${highlight ? "border-primary ring-2 ring-primary/20" : ""}`}>
      {highlight && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <Badge className="bg-primary text-primary-foreground px-3">Most Popular</Badge>
        </div>
      )}
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2 mb-1">
          {icon}
          <CardTitle className="text-lg">{displayName}</CardTitle>
        </div>
        <div className="flex items-baseline gap-1">
          {price === null ? (
            <span className="text-3xl font-bold">Free</span>
          ) : (
            <>
              <span className="text-3xl font-bold">${price}</span>
              <span className="text-muted-foreground text-sm">/month</span>
            </>
          )}
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col flex-1">
        <ul className="space-y-2 mb-6 flex-1 text-sm">
          <li className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
            <span>{pageLimit} customizer page{pageLimit !== 1 ? "s" : ""}</span>
          </li>
          <li className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
            <span>Unlimited customer designs</span>
          </li>
          <li className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
            <span>Native cart & checkout mockups</span>
          </li>
        </ul>
        <Button
          variant={highlight ? "default" : "outline"}
          className="w-full"
          onClick={onSelect}
          disabled={loading}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          {ctaLabel}
        </Button>
      </CardContent>
    </Card>
  );
}

interface PlanPickerProps {
  /** Called after a plan is activated (trial or paid) so parent can refetch. */
  onActivated?: () => void;
  /** If true, renders inline (no AdminLayout wrapping). */
  inline?: boolean;
}

export default function PlanPicker({ onActivated, inline = false }: PlanPickerProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);

  const trialMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/appai/billing/start-trial"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/appai/plan"] });
      queryClient.invalidateQueries({ queryKey: ["/api/appai/customizer-pages"] });
      toast({ title: "Trial started!", description: "You can now create 1 customizer page." });
      setLoadingPlan(null);
      onActivated?.();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setLoadingPlan(null);
    },
  });

  const subscriptionMutation = useMutation({
    mutationFn: (plan: string) =>
      apiRequest("POST", "/api/appai/billing/create-subscription", { plan }).then(r => r.json()),
    onSuccess: (data: { confirmationUrl?: string; activated?: boolean }) => {
      setLoadingPlan(null);
      if (data.activated) {
        // Owner bypass: plan was activated directly without Shopify billing
        queryClient.invalidateQueries({ queryKey: ["/api/appai/plan"] });
        queryClient.invalidateQueries({ queryKey: ["/api/appai/customizer-pages"] });
        toast({ title: "Plan activated!", description: "Your plan has been set." });
        onActivated?.();
      } else if (data.confirmationUrl) {
        // Redirect the full window to Shopify billing confirmation
        window.top ? (window.top.location.href = data.confirmationUrl) : (window.location.href = data.confirmationUrl);
      }
    },
    onError: (err: Error) => {
      toast({ title: "Billing error", description: err.message, variant: "destructive" });
      setLoadingPlan(null);
    },
  });

  const handleTrial = () => {
    setLoadingPlan("trial");
    trialMutation.mutate();
  };

  const handlePaid = (plan: string) => {
    setLoadingPlan(plan);
    subscriptionMutation.mutate(plan);
  };

  const content = (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold mb-2">Pick a plan to get started</h2>
        <p className="text-muted-foreground">
          Start with a free trial, or pick a paid plan to unlock more customizer pages.
          No monthly generation quotas — unlimited customer designs on all plans.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 mb-8">
        {/* Trial */}
        <PlanCard
          name="trial"
          displayName="Trial"
          price={null}
          pageLimit={1}
          description="Evaluate the app with 1 customizer page. No credit card needed."
          icon={<Zap className="h-5 w-5 text-yellow-500" />}
          ctaLabel="Start Free Trial"
          onSelect={handleTrial}
          loading={loadingPlan === "trial"}
        />
        {/* Starter */}
        <PlanCard
          name="starter"
          displayName="Starter"
          price={29}
          pageLimit={1}
          description="Perfect for shops selling 1 custom product."
          icon={<LayoutTemplate className="h-5 w-5 text-blue-500" />}
          ctaLabel="Choose Starter"
          onSelect={() => handlePaid("starter")}
          loading={loadingPlan === "starter"}
        />
        {/* Dabbler */}
        <PlanCard
          name="dabbler"
          displayName="Dabbler"
          price={49}
          pageLimit={5}
          description="Try several products with up to 5 customizer pages."
          highlight
          icon={<Star className="h-5 w-5 text-purple-500" />}
          ctaLabel="Choose Dabbler"
          onSelect={() => handlePaid("dabbler")}
          loading={loadingPlan === "dabbler"}
        />
        {/* Pro */}
        <PlanCard
          name="pro"
          displayName="Pro"
          price={99}
          pageLimit={15}
          description="Scale across your full catalog with 15 pages."
          icon={<Rocket className="h-5 w-5 text-green-500" />}
          ctaLabel="Choose Pro"
          onSelect={() => handlePaid("pro")}
          loading={loadingPlan === "pro"}
        />
        {/* Pro Plus */}
        <PlanCard
          name="pro_plus"
          displayName="Pro Plus"
          price={199}
          pageLimit={30}
          description="Maximum scale: 30 customizer pages for large catalogs."
          icon={<Rocket className="h-5 w-5 text-orange-500" />}
          ctaLabel="Choose Pro Plus"
          onSelect={() => handlePaid("pro_plus")}
          loading={loadingPlan === "pro_plus"}
        />
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Paid plans are billed monthly through Shopify. Cancel anytime.
        Generation quotas coming in a future release.
      </p>
    </div>
  );

  if (inline) return content;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-muted/30 p-4">
      {content}
    </div>
  );
}
