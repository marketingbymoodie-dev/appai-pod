import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link } from "wouter";
import { ArrowLeft, Trash2, ShoppingCart, Plus, Image } from "lucide-react";
import type { Design } from "@shared/schema";

export default function DesignsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const { data: designs, isLoading: designsLoading } = useQuery<Design[]>({
    queryKey: ["/api/designs"],
    enabled: isAuthenticated,
  });

  const deleteMutation = useMutation({
    mutationFn: async (designId: number) => {
      await apiRequest("DELETE", `/api/designs/${designId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/designs"] });
      toast({
        title: "Design deleted",
        description: "Your design has been removed.",
      });
    },
    onError: () => {
      toast({
        title: "Delete failed",
        description: "Failed to delete design",
        variant: "destructive",
      });
    },
  });

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Skeleton className="h-32 w-32 rounded-full" />
      </div>
    );
  }

  if (!isAuthenticated) {
    window.location.href = "/api/login";
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 bg-background z-50">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link href="/">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <h1 className="text-lg font-semibold">My Designs</h1>
          </div>
          <Link href="/design">
            <Button data-testid="button-new-design">
              <Plus className="h-4 w-4 mr-2" />
              New Design
            </Button>
          </Link>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        {designsLoading ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="aspect-[3/4] rounded-lg" />
            ))}
          </div>
        ) : designs && designs.length > 0 ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {designs.map((design) => (
              <Card key={design.id} className="overflow-hidden" data-testid={`card-design-${design.id}`}>
                <div className="aspect-[3/4] bg-muted relative overflow-hidden">
                  {design.generatedImageUrl ? (
                    <img
                      src={design.generatedImageUrl}
                      alt={design.prompt}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Image className="h-12 w-12 text-muted-foreground opacity-50" />
                    </div>
                  )}
                </div>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                    {design.prompt}
                  </p>
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground mb-3">
                    <span>{design.size}</span>
                    <span className="capitalize">{design.frameColor} frame</span>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="flex-1" data-testid={`button-order-${design.id}`}>
                      <ShoppingCart className="h-4 w-4 mr-1" />
                      Order
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteMutation.mutate(design.id)}
                      disabled={deleteMutation.isPending}
                      data-testid={`button-delete-${design.id}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="text-center py-16">
            <Image className="h-16 w-16 mx-auto text-muted-foreground opacity-50 mb-4" />
            <h2 className="text-xl font-semibold mb-2">No designs yet</h2>
            <p className="text-muted-foreground mb-6">
              Create your first AI artwork to get started
            </p>
            <Link href="/design">
              <Button data-testid="button-create-first">
                <Plus className="h-4 w-4 mr-2" />
                Create Design
              </Button>
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
