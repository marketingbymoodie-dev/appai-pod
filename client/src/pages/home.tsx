import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Palette, Image, ShoppingCart, Sparkles, Settings } from "lucide-react";
import type { Customer } from "@shared/schema";

export default function Home() {
  const { user, isLoading: authLoading, isAuthenticated } = useAuth();

  const { data: customer, isLoading: customerLoading } = useQuery<Customer>({
    queryKey: ["/api/customer"],
    enabled: isAuthenticated,
  });

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Skeleton className="h-32 w-32 rounded-full" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LandingPage />;
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Palette className="h-6 w-6 text-primary" />
            <h1 className="text-xl font-semibold">AI Art Studio</h1>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            {customerLoading ? (
              <Skeleton className="h-6 w-24" />
            ) : (
              <span className="text-sm text-muted-foreground" data-testid="text-credits">
                {customer?.credits ?? 0} credits
              </span>
            )}
            <span className="text-sm text-muted-foreground" data-testid="text-username">
              {user?.firstName || user?.email}
            </span>
            <Link href="/admin">
              <Button variant="ghost" size="icon" data-testid="button-admin">
                <Settings className="h-5 w-5" />
              </Button>
            </Link>
            <Button variant="ghost" onClick={() => window.location.href = "/api/logout"} data-testid="button-logout">
              Logout
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h2 className="text-2xl font-bold mb-2">Welcome back, {user?.firstName || "Artist"}!</h2>
          <p className="text-muted-foreground">Create stunning AI artwork for premium framed prints.</p>
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          <Link href="/design">
            <Card className="cursor-pointer hover-elevate h-full">
              <CardHeader>
                <Sparkles className="h-8 w-8 text-primary mb-2" />
                <CardTitle>Create New Design</CardTitle>
                <CardDescription>
                  Generate AI artwork from your ideas
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Enter a prompt, choose a style, and watch AI bring your vision to life.
                </p>
              </CardContent>
            </Card>
          </Link>

          <Link href="/designs">
            <Card className="cursor-pointer hover-elevate h-full">
              <CardHeader>
                <Image className="h-8 w-8 text-primary mb-2" />
                <CardTitle>My Designs</CardTitle>
                <CardDescription>
                  View your saved artwork
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Browse and manage your previously generated designs.
                </p>
              </CardContent>
            </Card>
          </Link>

          <Link href="/orders">
            <Card className="cursor-pointer hover-elevate h-full">
              <CardHeader>
                <ShoppingCart className="h-8 w-8 text-primary mb-2" />
                <CardTitle>My Orders</CardTitle>
                <CardDescription>
                  Track your print orders
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  View order history and track shipments.
                </p>
              </CardContent>
            </Card>
          </Link>
        </div>

        {customer && customer.credits <= 2 && (
          <Card className="mt-8 border-primary/20 bg-primary/5">
            <CardHeader>
              <CardTitle className="text-lg">Running low on credits?</CardTitle>
              <CardDescription>
                You have {customer.credits} credit{customer.credits !== 1 ? "s" : ""} remaining.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button data-testid="button-buy-credits">
                Buy 5 Credits for $1
              </Button>
              <p className="text-xs text-muted-foreground mt-2">
                Credits spent are refunded up to $1 when you place an order!
              </p>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}

function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Palette className="h-6 w-6 text-primary" />
            <h1 className="text-xl font-semibold">AI Art Studio</h1>
          </div>
          <Button onClick={() => window.location.href = "/api/login"} data-testid="button-login">
            Sign In
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-16">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-4xl font-bold mb-6">
            Create Custom AI Artwork for Premium Framed Prints
          </h1>
          <p className="text-xl text-muted-foreground mb-8">
            Transform your ideas into stunning wall art. Simply describe what you want, 
            choose a style, and our AI will generate beautiful artwork ready for printing.
          </p>
          <Button size="lg" onClick={() => window.location.href = "/api/login"} data-testid="button-get-started">
            Get Started Free
          </Button>
          <p className="text-sm text-muted-foreground mt-4">
            5 free generations when you sign up
          </p>
        </div>

        <div className="grid gap-8 md:grid-cols-3 mt-16">
          <div className="text-center">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <Sparkles className="h-8 w-8 text-primary" />
            </div>
            <h3 className="font-semibold mb-2">AI-Powered Creation</h3>
            <p className="text-sm text-muted-foreground">
              Describe your vision and watch it come to life with cutting-edge AI technology.
            </p>
          </div>
          <div className="text-center">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <Image className="h-8 w-8 text-primary" />
            </div>
            <h3 className="font-semibold mb-2">Premium Quality Prints</h3>
            <p className="text-sm text-muted-foreground">
              Museum-quality prints on premium paper with beautiful frames.
            </p>
          </div>
          <div className="text-center">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <ShoppingCart className="h-8 w-8 text-primary" />
            </div>
            <h3 className="font-semibold mb-2">Easy Ordering</h3>
            <p className="text-sm text-muted-foreground">
              Choose your size and frame, then get it delivered to your door.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
