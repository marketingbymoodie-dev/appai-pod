import { useState, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link, useLocation } from "wouter";
import { ArrowLeft, Trash2, ShoppingCart, Plus, Image, Pencil, Loader2, X, ZoomIn } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { CreditDisplay } from "@/components/credit-display";
import type { Design, Customer } from "@shared/schema";

interface DesignWithProductType extends Design {
  productTypeName: string | null;
}

interface DesignsResponse {
  designs: DesignWithProductType[];
  total: number;
  hasMore: boolean;
}

export default function DesignsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [allDesigns, setAllDesigns] = useState<DesignWithProductType[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedDesign, setSelectedDesign] = useState<DesignWithProductType | null>(null);

  const { data: customer, isLoading: customerLoading } = useQuery<Customer>({
    queryKey: ["/api/customer"],
    enabled: isAuthenticated,
  });

  const { isLoading: designsLoading } = useQuery<DesignsResponse>({
    queryKey: ["/api/designs", "initial"],
    queryFn: async () => {
      const res = await fetch(`/api/designs?page=1&limit=12`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch designs");
      const data = await res.json();
      setAllDesigns(data.designs);
      setHasMore(data.hasMore);
      setTotal(data.total);
      setPage(1);
      return data;
    },
    enabled: isAuthenticated,
    staleTime: 30000,
  });

  const handleLoadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const nextPage = page + 1;
      const res = await fetch(`/api/designs?page=${nextPage}&limit=12`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch designs");
      const data: DesignsResponse = await res.json();
      setAllDesigns(prev => [...prev, ...data.designs]);
      setHasMore(data.hasMore);
      setPage(nextPage);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to load more designs",
        variant: "destructive",
      });
    } finally {
      setLoadingMore(false);
    }
  }, [page, loadingMore, toast]);

  const deleteMutation = useMutation({
    mutationFn: async (designId: number) => {
      await apiRequest("DELETE", `/api/designs/${designId}`);
    },
    onSuccess: (_, deletedId) => {
      setAllDesigns(prev => prev.filter(d => d.id !== deletedId));
      setTotal(prev => prev - 1);
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

  const handleTweak = (designId: number) => {
    setLocation(`/design?tweak=${designId}`);
  };

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

  const isInitialLoading = designsLoading && allDesigns.length === 0;

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
            <div>
              <h1 className="text-lg font-semibold">My Designs</h1>
              {total > 0 && (
                <p className="text-xs text-muted-foreground">{total} of 50 slots used</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <CreditDisplay customer={customer} isLoading={customerLoading} />
            <Link href="/design">
              <Button data-testid="button-new-design">
                <Plus className="h-4 w-4 mr-2" />
                New Design
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        {isInitialLoading ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="aspect-[3/4] rounded-lg" />
            ))}
          </div>
        ) : allDesigns.length > 0 ? (
          <>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {allDesigns.map((design) => (
                <Card key={design.id} className="overflow-hidden" data-testid={`card-design-${design.id}`}>
                  <div 
                    className="aspect-[3/4] bg-muted relative overflow-hidden cursor-pointer group"
                    onClick={() => setSelectedDesign(design)}
                    data-testid={`image-container-${design.id}`}
                  >
                    {design.generatedImageUrl ? (
                      <>
                        <img
                          src={design.thumbnailImageUrl || design.generatedImageUrl}
                          alt={design.prompt}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                          <ZoomIn className="h-8 w-8 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Image className="h-12 w-12 text-muted-foreground opacity-50" />
                      </div>
                    )}
                  </div>
                  <CardContent className="p-4">
                    <p className="text-sm font-medium line-clamp-1 mb-2" data-testid={`text-product-type-${design.id}`}>
                      {design.productTypeName || "Artwork"}
                    </p>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground mb-3">
                      <span>{design.size}</span>
                      <span className="capitalize">{design.frameColor} frame</span>
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="flex-1"
                        onClick={() => handleTweak(design.id)}
                        data-testid={`button-tweak-${design.id}`}
                      >
                        <Pencil className="h-4 w-4 mr-1" />
                        Tweak
                      </Button>
                      <Button variant="outline" size="sm" className="flex-1" data-testid={`button-order-${design.id}`}>
                        <ShoppingCart className="h-4 w-4 mr-1" />
                        Order
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
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
            
            {hasMore && (
              <div className="flex justify-center mt-8">
                <Button
                  variant="outline"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  data-testid="button-load-more"
                >
                  {loadingMore ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    `Load More (${allDesigns.length} of ${total})`
                  )}
                </Button>
              </div>
            )}
          </>
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

      {/* Full-size image modal */}
      <Dialog open={!!selectedDesign} onOpenChange={(open) => !open && setSelectedDesign(null)}>
        <DialogContent className="max-w-4xl p-0 overflow-hidden" data-testid="dialog-fullsize-image">
          <VisuallyHidden>
            <DialogTitle>Design Preview</DialogTitle>
          </VisuallyHidden>
          {selectedDesign && (
            <div className="relative">
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-2 right-2 z-10 bg-black/50 hover:bg-black/70 text-white"
                onClick={() => setSelectedDesign(null)}
                data-testid="button-close-modal"
              >
                <X className="h-5 w-5" />
              </Button>
              <img
                src={selectedDesign.generatedImageUrl || ""}
                alt={selectedDesign.prompt}
                className="w-full h-auto max-h-[80vh] object-contain"
                data-testid="img-fullsize"
              />
              <div className="p-4 bg-background">
                <p className="text-sm font-medium mb-1" data-testid="text-modal-product-type">
                  {selectedDesign.productTypeName || "Artwork"}
                </p>
                <p className="text-sm text-muted-foreground" data-testid="text-design-prompt">
                  {selectedDesign.prompt}
                </p>
                <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                  <span>{selectedDesign.size}</span>
                  <span className="capitalize">{selectedDesign.frameColor} frame</span>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
