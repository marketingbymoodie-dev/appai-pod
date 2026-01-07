import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Ticket, Plus, Trash2, Edit2 } from "lucide-react";
import AdminLayout from "@/components/admin-layout";
import type { Coupon } from "@shared/schema";

export default function AdminCoupons() {
  const { toast } = useToast();
  
  const [couponDialogOpen, setCouponDialogOpen] = useState(false);
  const [editingCoupon, setEditingCoupon] = useState<Coupon | null>(null);
  const [newCouponCode, setNewCouponCode] = useState("");
  const [newCouponCredits, setNewCouponCredits] = useState("5");
  const [newCouponMaxUses, setNewCouponMaxUses] = useState("");

  const { data: coupons, isLoading: couponsLoading } = useQuery<Coupon[]>({
    queryKey: ["/api/admin/coupons"],
  });

  const createCouponMutation = useMutation({
    mutationFn: async (data: { code: string; creditAmount: number; maxUses?: number }) => {
      const response = await apiRequest("POST", "/api/admin/coupons", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/coupons"] });
      setCouponDialogOpen(false);
      resetCouponForm();
      toast({ title: "Coupon created", description: "Your coupon is ready to share." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create coupon", description: error.message, variant: "destructive" });
    },
  });

  const updateCouponMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: number; code: string; creditAmount: number; maxUses?: number }) => {
      const response = await apiRequest("PATCH", `/api/admin/coupons/${id}`, data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/coupons"] });
      setCouponDialogOpen(false);
      resetCouponForm();
      toast({ title: "Coupon updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update coupon", description: error.message, variant: "destructive" });
    },
  });

  const deleteCouponMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/admin/coupons/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/coupons"] });
      toast({ title: "Coupon deleted" });
    },
  });

  const resetCouponForm = () => {
    setEditingCoupon(null);
    setNewCouponCode("");
    setNewCouponCredits("5");
    setNewCouponMaxUses("");
  };

  const handleEditCoupon = (coupon: Coupon) => {
    setEditingCoupon(coupon);
    setNewCouponCode(coupon.code);
    setNewCouponCredits(coupon.creditAmount.toString());
    setNewCouponMaxUses(coupon.maxUses?.toString() || "");
    setCouponDialogOpen(true);
  };

  const handleSaveCoupon = () => {
    const data = {
      code: newCouponCode.toUpperCase(),
      creditAmount: parseInt(newCouponCredits),
      maxUses: newCouponMaxUses ? parseInt(newCouponMaxUses) : undefined,
    };
    
    if (editingCoupon) {
      updateCouponMutation.mutate({ id: editingCoupon.id, ...data });
    } else {
      createCouponMutation.mutate(data);
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-coupons-title">Coupons</h1>
            <p className="text-muted-foreground">Create discount codes for your customers</p>
          </div>
          <Button onClick={() => { resetCouponForm(); setCouponDialogOpen(true); }} data-testid="button-add-coupon">
            <Plus className="h-4 w-4 mr-2" />
            Add Coupon
          </Button>
        </div>

        {couponsLoading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        ) : coupons && coupons.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {coupons.map((coupon) => (
              <Card key={coupon.id} data-testid={`card-coupon-${coupon.id}`}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-lg font-mono">{coupon.code}</CardTitle>
                    <Badge variant={coupon.isActive ? "default" : "secondary"}>
                      {coupon.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-sm text-muted-foreground space-y-1 mb-4">
                    <div>Credits: {coupon.creditAmount}</div>
                    <div>
                      Uses: {coupon.usedCount}
                      {coupon.maxUses ? ` / ${coupon.maxUses}` : " (unlimited)"}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button 
                      variant="ghost" 
                      size="icon"
                      onClick={() => handleEditCoupon(coupon)}
                      data-testid={`button-edit-coupon-${coupon.id}`}
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="icon"
                      onClick={() => deleteCouponMutation.mutate(coupon.id)}
                      data-testid={`button-delete-coupon-${coupon.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <Ticket className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="font-medium mb-2">No coupons yet</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Create coupon codes to give customers free credits
              </p>
              <Button onClick={() => { resetCouponForm(); setCouponDialogOpen(true); }}>
                <Plus className="h-4 w-4 mr-2" />
                Add Coupon
              </Button>
            </CardContent>
          </Card>
        )}

        <Dialog open={couponDialogOpen} onOpenChange={setCouponDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingCoupon ? "Edit Coupon" : "Add New Coupon"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="coupon-code">Coupon Code</Label>
                <Input
                  id="coupon-code"
                  value={newCouponCode}
                  onChange={(e) => setNewCouponCode(e.target.value.toUpperCase())}
                  placeholder="SUMMER20"
                  className="font-mono"
                  data-testid="input-coupon-code"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="coupon-credits">Credit Amount</Label>
                <Input
                  id="coupon-credits"
                  type="number"
                  value={newCouponCredits}
                  onChange={(e) => setNewCouponCredits(e.target.value)}
                  placeholder="5"
                  min="1"
                  data-testid="input-coupon-credits"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="coupon-max-uses">Max Uses (optional)</Label>
                <Input
                  id="coupon-max-uses"
                  type="number"
                  value={newCouponMaxUses}
                  onChange={(e) => setNewCouponMaxUses(e.target.value)}
                  placeholder="Unlimited"
                  min="1"
                  data-testid="input-coupon-max-uses"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setCouponDialogOpen(false)}>
                  Cancel
                </Button>
                <Button 
                  onClick={handleSaveCoupon}
                  disabled={!newCouponCode || !newCouponCredits || createCouponMutation.isPending || updateCouponMutation.isPending}
                  data-testid="button-save-coupon"
                >
                  {editingCoupon ? "Update" : "Create"} Coupon
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
