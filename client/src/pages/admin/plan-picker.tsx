import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle, Zap, LayoutTemplate, Star, Rocket, Info } from "lucide-react";
import GenerationQuotaUsage from "@/components/admin/GenerationQuotaUsage";

/**
 * Shared note appended to every paid plan's info popover (and the Trial card).
 * Explains the per-customer 10-free-generation limit and the $1 top-up packs.
 */
const CUSTOMER_ABUSE_NOTE =
  "Free generations per customer are limited to 10 to avoid abuse of free generations. " +
  "Customers are offered extra packs of 10 generations for a dollar directly from AI Art Studio " +
  "if they wish to continue creating. The maximum of a dollar is reimbursed if the customer makes a physical transaction.";

interface PlanCardProps {
  name: string;
  displayName: string;
  price: number | null;
  pageLimit: number;
  /** Monthly free AI-generation allotment for this plan. */
  freeGenerations: number;
  description: string;
  /** First line of the info popover, describing this plan's overage terms (paid plans only). */
  overageNote?: string;
  /** Extra free-text shown on the Trial card explaining the upgrade path. */
  trialNote?: string;
  highlight?: boolean;
  icon: React.ReactNode;
  ctaLabel: string;
  onSelect: () => void;
  loading: boolean;
}

function PlanCard({
  displayName, price, pageLimit, freeGenerations, description, overageNote, trialNote,
  highlight, icon, ctaLabel, onSelect, loading,
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
            <span className="flex items-center gap-1">
              <span>
                {freeGenerations.toLocaleString()} free generation{freeGenerations !== 1 ? "s" : ""}
                {price === null ? "" : "/mo"}
              </span>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${displayName} generation details`}
                    className="inline-flex text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring rounded-full"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="text-sm leading-relaxed space-y-2">
                  {overageNote ? <p>{overageNote}</p> : null}
                  {trialNote ? <p>{trialNote}</p> : null}
                  <p className="text-muted-foreground">{CUSTOMER_ABUSE_NOTE}</p>
                </PopoverContent>
              </Popover>
            </span>
          </li>
          <li className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
            <span>{pageLimit} customizer page{pageLimit !== 1 ? "s" : ""}</span>
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
  const [upgradePlan, setUpgradePlan] = useState<string | null>(null);
  const [upgradePreview, setUpgradePreview] = useState<{
    confirmationMessage: string;
    newPriceUsd: number;
    newIncludedRemaining: number;
  } | null>(null);
  const [upgradeAcknowledged, setUpgradeAcknowledged] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

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

  const handlePaid = async (plan: string) => {
    setPreviewLoading(true);
    setUpgradePlan(plan);
    setUpgradeAcknowledged(false);
    try {
      const res = await apiRequest("GET", `/api/appai/billing/upgrade-preview?plan=${encodeURIComponent(plan)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load upgrade preview");
      setUpgradePreview({
        confirmationMessage: data.confirmationMessage,
        newPriceUsd: data.newPriceUsd,
        newIncludedRemaining: data.newIncludedRemaining,
      });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setUpgradePlan(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const confirmUpgrade = () => {
    if (!upgradePlan) return;
    setLoadingPlan(upgradePlan);
    subscriptionMutation.mutate(upgradePlan);
    setUpgradePlan(null);
    setUpgradePreview(null);
  };

  const content = (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <GenerationQuotaUsage showManageLink={false} className="mb-6" />

      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold mb-2">Pick a plan to get started</h2>
        <p className="text-muted-foreground">
          Start with a free trial, or pick a paid plan for more customizer pages and a larger
          monthly allotment of free AI generations.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 mb-8">
        {/* Trial */}
        <PlanCard
          name="trial"
          displayName="Trial"
          price={null}
          pageLimit={1}
          freeGenerations={20}
          description="Evaluate the app with 1 customizer page. No credit card needed."
          trialNote="Your trial includes 20 free generations. Once they're used, upgrade to the Starter plan to keep using the customizer page you set up."
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
          freeGenerations={250}
          description="Perfect for shops selling 1 custom product."
          overageNote="Additional generations can be added at $0.08 per generation, capped at an extra 200 generations per calendar month."
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
          freeGenerations={600}
          description="Try several products with up to 5 customizer pages."
          overageNote="Additional generations can be added at $0.08 per generation, capped at an extra 300 generations per calendar month."
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
          freeGenerations={1500}
          description="Scale across your full catalog with 15 pages."
          overageNote="Additional generations can be added at $0.08 per generation, capped at an extra 500 generations per calendar month."
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
          freeGenerations={3000}
          description="Maximum scale: 30 customizer pages for large catalogs."
          overageNote="Additional generations can be added at $0.08 per generation, capped at an extra 1000 generations per calendar month."
          icon={<Rocket className="h-5 w-5 text-orange-500" />}
          ctaLabel="Choose Pro Plus"
          onSelect={() => handlePaid("pro_plus")}
          loading={loadingPlan === "pro_plus"}
        />
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Paid plans are billed monthly through Shopify in USD. Cancel anytime.
        Extra generations require in-app opt-in ($0.08 USD each, pay-as-you-go). Tap ⓘ on a plan for details.
      </p>

      <Dialog open={!!upgradePlan} onOpenChange={(open) => !open && setUpgradePlan(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm plan upgrade</DialogTitle>
            <DialogDescription>Review billing before continuing to Shopify.</DialogDescription>
          </DialogHeader>
          {previewLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : upgradePreview ? (
            <div className="space-y-4 text-sm">
              <p>{upgradePreview.confirmationMessage}</p>
              <div className="flex items-start gap-2">
                <Checkbox
                  id="upgrade-ack"
                  checked={upgradeAcknowledged}
                  onCheckedChange={(c) => setUpgradeAcknowledged(!!c)}
                />
                <Label htmlFor="upgrade-ack" className="font-normal leading-relaxed">
                  I understand I will be charged through Shopify and my included usage carries over as
                  described above. All amounts in USD.
                </Label>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUpgradePlan(null)}>
              Cancel
            </Button>
            <Button disabled={!upgradeAcknowledged || previewLoading} onClick={confirmUpgrade}>
              Continue to Shopify
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

  if (inline) return content;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-muted/30 p-4">
      {content}
    </div>
  );
}
