/**
 * PatternCustomizer — two-step AOP pattern tool.
 *
 * After the AI generates a motif, AOP products need it tiled into a seamless
 * pattern via Picsart before the mockup can be generated.
 *
 * Usage:
 *   <PatternCustomizer
 *     motifUrl={generatedImageUrl}
 *     productWidth={4500}
 *     productHeight={5400}
 *     hasPairedPanels={true}
 *     onApply={(patternUrl, options) => triggerMockup(patternUrl, options)}
 *   />
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type PatternType = "tile" | "hex" | "mirror" | "diamond" | "hex2";

interface PatternOption {
  value: PatternType;
  label: string;
  description: string;
}

const PATTERN_OPTIONS: PatternOption[] = [
  { value: "tile",    label: "Grid",    description: "Classic straight repeat" },
  { value: "mirror",  label: "Mirror",  description: "Reflected on each tile" },
  { value: "hex",     label: "Hex",     description: "Honeycomb offset repeat" },
  { value: "hex2",    label: "Hex Alt", description: "Alternate honeycomb" },
  { value: "diamond", label: "Diamond", description: "Diagonal diamond grid" },
];

const PREVIEW_SIZE = 1024;
const APPLY_CAP = 2048;
const COUNTDOWN_SECONDS = 5;

export interface PatternApplyOptions {
  mirrorLegs: boolean;
}

interface PatternCustomizerProps {
  motifUrl: string;
  /** Largest panel width in px (used to size Picsart output, capped at APPLY_CAP) */
  productWidth?: number;
  /** Largest panel height in px (used to size Picsart output, capped at APPLY_CAP) */
  productHeight?: number;
  /** When true, show the "Mirror left/right panels" toggle */
  hasPairedPanels?: boolean;
  onApply: (patternUrl: string, options: PatternApplyOptions) => void | Promise<void>;
  isLoading?: boolean;
}

export function PatternCustomizer({
  motifUrl,
  productWidth = 2000,
  productHeight = 2000,
  hasPairedPanels = false,
  onApply,
  isLoading = false,
}: PatternCustomizerProps) {
  const [pattern, setPattern] = useState<PatternType>("tile");
  const [scale, setScale] = useState<number>(1.5);
  const [mirrorLegs, setMirrorLegs] = useState<boolean>(true);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Countdown state
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startCountdown = useCallback(() => {
    setCountdown(COUNTDOWN_SECONDS);
    if (countdownRef.current) clearInterval(countdownRef.current);
    const started = Date.now();
    countdownRef.current = setInterval(() => {
      const elapsed = (Date.now() - started) / 1000;
      const remaining = Math.max(0, COUNTDOWN_SECONDS - elapsed);
      setCountdown(Math.ceil(remaining));
      if (remaining <= 0 && countdownRef.current) {
        clearInterval(countdownRef.current);
      }
    }, 250);
  }, []);

  const stopCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setCountdown(null);
  }, []);

  useEffect(() => () => { if (countdownRef.current) clearInterval(countdownRef.current); }, []);

  const applyWidth = Math.min(productWidth, APPLY_CAP);
  const applyHeight = Math.min(productHeight, APPLY_CAP);

  const callPatternApi = useCallback(async (width: number, height: number): Promise<string | null> => {
    setError(null);
    const body = { imageUrl: motifUrl, pattern, scale, width, height };
    const res = await fetch("/api/pattern/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      setError(err.error || "Pattern generation failed");
      return null;
    }
    const data = await res.json();
    return data.patternUrl ?? null;
  }, [motifUrl, pattern, scale]);

  const handlePreview = async () => {
    setIsPreviewing(true);
    startCountdown();
    try {
      const url = await callPatternApi(PREVIEW_SIZE, PREVIEW_SIZE);
      if (url) setPreviewUrl(url);
    } finally {
      stopCountdown();
      setIsPreviewing(false);
    }
  };

  const handleApply = async () => {
    setIsApplying(true);
    startCountdown();
    try {
      const url = await callPatternApi(applyWidth, applyHeight);
      if (url) {
        setPreviewUrl(url);
        await onApply(url, { mirrorLegs });
      }
    } finally {
      stopCountdown();
      setIsApplying(false);
    }
  };

  const busy = isPreviewing || isApplying || isLoading;
  const showSpinner = isPreviewing || isApplying;
  const spinnerLabel = isApplying ? "Applying pattern to product…" : "Expanding pattern…";

  return (
    <div className="space-y-4 p-4 border rounded-lg bg-muted/30">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">Pattern Settings</span>
        <span className="text-xs text-muted-foreground">
          — Your motif will be tiled across all panels
        </span>
      </div>

      {/* Side-by-side: motif vs pattern preview */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground text-center">Your motif</p>
          <div className="aspect-square rounded overflow-hidden border bg-background flex items-center justify-center">
            <img
              src={motifUrl}
              alt="Motif"
              className="w-full h-full object-contain"
            />
          </div>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground text-center">Pattern preview</p>
          <div className="aspect-square rounded overflow-hidden border bg-background flex items-center justify-center relative">
            {previewUrl && !showSpinner ? (
              <img
                src={previewUrl}
                alt="Pattern preview"
                className="w-full h-full object-cover"
              />
            ) : showSpinner ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/80 z-10 gap-2">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <p className="text-xs font-medium text-muted-foreground">{spinnerLabel}</p>
                {countdown !== null && countdown > 0 && (
                  <span className="text-lg font-semibold tabular-nums text-primary">
                    {countdown}s
                  </span>
                )}
                {countdown === 0 && (
                  <span className="text-xs text-muted-foreground">Almost there…</span>
                )}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground px-2 text-center">
                Click "Preview" to see the tiled pattern
              </span>
            )}
            {/* Keep previous preview faintly visible behind spinner */}
            {previewUrl && showSpinner && (
              <img
                src={previewUrl}
                alt="Previous pattern"
                className="w-full h-full object-cover opacity-30"
              />
            )}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label className="text-xs">Pattern type</Label>
          <Select value={pattern} onValueChange={(v) => { setPattern(v as PatternType); setPreviewUrl(null); }}>
            <SelectTrigger className="h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PATTERN_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  <span className="font-medium">{opt.label}</span>
                  <span className="ml-1 text-xs text-muted-foreground">
                    — {opt.description}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">
            Scale <span className="text-muted-foreground">({scale.toFixed(1)}x)</span>
          </Label>
          <Slider
            min={0.5}
            max={5}
            step={0.1}
            value={[scale]}
            onValueChange={([v]) => { setScale(v); setPreviewUrl(null); }}
            className="mt-2"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Smaller</span>
            <span>Larger</span>
          </div>
        </div>
      </div>

      {/* Mirror toggle — only shown for products with paired left/right panels */}
      {hasPairedPanels && (
        <div className="flex items-center justify-between rounded-md border px-3 py-2 bg-background">
          <div className="space-y-0.5">
            <Label htmlFor="mirror-legs-toggle" className="text-xs font-medium cursor-pointer">
              Mirror left &amp; right panels
            </Label>
            <p className="text-xs text-muted-foreground">
              Flips the pattern on one leg for symmetry
            </p>
          </div>
          <Switch
            id="mirror-legs-toggle"
            checked={mirrorLegs}
            onCheckedChange={setMirrorLegs}
            disabled={busy}
          />
        </div>
      )}

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handlePreview}
          disabled={busy}
          className="flex-1"
        >
          {isPreviewing ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Generating…
            </span>
          ) : (
            "Preview Pattern"
          )}
        </Button>
        <Button
          size="sm"
          onClick={handleApply}
          disabled={busy}
          className="flex-1"
        >
          {isApplying ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Applying…
            </span>
          ) : (
            "Apply to Product"
          )}
        </Button>
      </div>
    </div>
  );
}
