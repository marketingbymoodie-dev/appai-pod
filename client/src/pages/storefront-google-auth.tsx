import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { STOREFRONT_GOOGLE_AUTH_MESSAGE, isAllowedStorefrontOpenerOrigin } from "@shared/storefront-auth";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
          }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, string | number | boolean>) => void;
        };
      };
    };
  }
}

function readSearchParam(name: string): string {
  return new URLSearchParams(window.location.search).get(name)?.trim() || "";
}

export default function StorefrontGoogleAuthPage() {
  const shop = readSearchParam("shop");
  const openerOrigin = readSearchParam("openerOrigin");
  const nonce = readSearchParam("nonce");
  const googleBtnRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "working" | "done" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shop || !openerOrigin || !nonce) {
      setStatus("error");
      setError("Missing sign-in parameters. Close this window and try again from the customizer.");
      return;
    }
    if (!isAllowedStorefrontOpenerOrigin(openerOrigin)) {
      setStatus("error");
      setError("Invalid return origin.");
      return;
    }
    if (!window.opener) {
      setStatus("error");
      setError("This page must be opened from the design customizer.");
      return;
    }

    let cancelled = false;

    const finish = (payload: {
      ok: boolean;
      customerId?: string;
      identityToken?: string;
      credits?: number;
      freeGenerationsUsed?: number;
      email?: string;
      error?: string;
    }) => {
      try {
        window.opener?.postMessage(
          {
            type: STOREFRONT_GOOGLE_AUTH_MESSAGE,
            nonce,
            ...payload,
          },
          openerOrigin,
        );
      } catch (err) {
        console.warn("[Google Auth Popup] postMessage failed", err);
      }
      setStatus(payload.ok ? "done" : "error");
      if (!payload.ok) setError(payload.error || "Google sign-in failed");
      window.setTimeout(() => window.close(), payload.ok ? 400 : 2500);
    };

    const handleCredential = (credential: string) => {
      setStatus("working");
      fetch("/api/storefront/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential, shop }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          if (data.ok) {
            finish({
              ok: true,
              customerId: data.customerId,
              identityToken: data.identityToken,
              credits: data.credits,
              freeGenerationsUsed: data.freeGenerationsUsed,
              email: data.email,
            });
          } else {
            finish({ ok: false, error: data.error || "Google sign-in failed" });
          }
        })
        .catch(() => {
          if (!cancelled) finish({ ok: false, error: "Google sign-in failed" });
        });
    };

    fetch(`/api/storefront/auth/config?shop=${encodeURIComponent(shop)}`)
      .then((res) => res.json())
      .then((config) => {
        if (cancelled) return;
        const clientId = config.googleClientId as string | undefined;
        if (!clientId) {
          setStatus("error");
          setError("Google sign-in is not configured.");
          return;
        }

        const renderButton = () => {
          const container = googleBtnRef.current;
          if (!container || !window.google?.accounts?.id) return;
          window.google.accounts.id.initialize({
            client_id: clientId,
            callback: (response) => {
              if (response?.credential) handleCredential(response.credential);
            },
            auto_select: false,
            cancel_on_tap_outside: true,
          });
          container.innerHTML = "";
          window.google.accounts.id.renderButton(container, {
            type: "standard",
            theme: "outline",
            size: "large",
            text: "signin_with",
            width: 320,
          });
          setStatus("ready");
        };

        const scriptId = "google-gsi-client-popup";
        const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
        if (existing) {
          if (window.google?.accounts?.id) renderButton();
          else existing.addEventListener("load", renderButton);
          return;
        }

        const script = document.createElement("script");
        script.id = scriptId;
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.defer = true;
        script.onload = renderButton;
        script.onerror = () => {
          if (!cancelled) {
            setStatus("error");
            setError("Could not load Google sign-in.");
          }
        };
        document.head.appendChild(script);
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
          setError("Could not load sign-in configuration.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [shop, openerOrigin, nonce]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-4 text-center">
        <h1 className="text-lg font-semibold">Sign in with Google</h1>
        <p className="text-sm text-muted-foreground">
          Continue to save designs and track your artwork credits.
        </p>

        {status === "loading" && (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-6">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading…
          </div>
        )}

        {status === "working" && (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-6">
            <Loader2 className="w-4 h-4 animate-spin" />
            Signing you in…
          </div>
        )}

        {(status === "ready" || status === "loading") && (
          <div ref={googleBtnRef} className="flex justify-center min-h-[44px]" />
        )}

        {status === "done" && (
          <p className="text-sm text-muted-foreground py-4">Success! You can close this window.</p>
        )}

        {status === "error" && error && (
          <p className="text-sm text-destructive py-4">{error}</p>
        )}
      </div>
    </div>
  );
}
