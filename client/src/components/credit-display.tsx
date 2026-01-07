import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { AlertCircle, Plus } from "lucide-react";
import type { Customer } from "@shared/schema";

interface CreditDisplayProps {
  customer: Customer | undefined;
  isLoading: boolean;
  showWarning?: boolean;
  warningThreshold?: number;
}

export function CreditDisplay({ 
  customer, 
  isLoading, 
  showWarning = true,
  warningThreshold = 2 
}: CreditDisplayProps) {
  const { toast } = useToast();
  const [couponDialogOpen, setCouponDialogOpen] = useState(false);
  const [couponCode, setCouponCode] = useState("");

  const redeemCouponMutation = useMutation({
    mutationFn: async (code: string) => {
      const response = await apiRequest("POST", "/api/coupons/redeem", { code });
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/customer"] });
      setCouponDialogOpen(false);
      setCouponCode("");
      toast({
        title: "Coupon redeemed!",
        description: `You received ${data.creditsAdded} credits. New balance: ${data.newBalance}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Invalid coupon",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return <Skeleton className="h-5 w-20" />;
  }

  const credits = customer?.credits ?? 0;
  const isLow = credits <= warningThreshold;

  return (
    <div className="flex items-center gap-2">
      <Dialog open={couponDialogOpen} onOpenChange={setCouponDialogOpen}>
        <DialogTrigger asChild>
          <button 
            className={`text-sm flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${
              isLow && showWarning
                ? "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800" 
                : "text-muted-foreground hover:bg-muted"
            }`}
            data-testid="button-credit-topup"
          >
            {isLow && showWarning && <AlertCircle className="h-3.5 w-3.5" />}
            <span data-testid="text-credits">{credits} credit{credits !== 1 ? "s" : ""}</span>
            <Plus className="h-3 w-3" />
          </button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Get More Credits</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <p className="text-sm text-muted-foreground">
              You currently have <strong>{credits}</strong> credit{credits !== 1 ? "s" : ""}. 
              Each AI artwork generation uses 1 credit.
            </p>
            
            <div className="space-y-3">
              <Button className="w-full" data-testid="button-buy-credits">
                Buy 5 Credits for $1
              </Button>
              
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">Or</span>
                </div>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="coupon-input-header">Redeem a coupon code</Label>
                <div className="flex gap-2">
                  <Input
                    id="coupon-input-header"
                    placeholder="e.g., WELCOME10"
                    value={couponCode}
                    onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                    data-testid="input-redeem-coupon-header"
                  />
                  <Button
                    variant="outline"
                    onClick={() => redeemCouponMutation.mutate(couponCode)}
                    disabled={!couponCode || redeemCouponMutation.isPending}
                    data-testid="button-submit-redeem-header"
                  >
                    {redeemCouponMutation.isPending ? "..." : "Redeem"}
                  </Button>
                </div>
              </div>
            </div>
            
            <p className="text-xs text-muted-foreground">
              Credits spent are refunded up to $1 when you place an order!
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
