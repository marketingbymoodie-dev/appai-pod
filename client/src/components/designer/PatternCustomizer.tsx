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
 *     onApply={(patternUrl) => triggerMockup(patternUrl)}
 *   />
 */

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
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

interface PatternCustomizerProps {
  motifUrl: string;
  /** Largest panel width in px (used to size Picsart output, capped at 4000) */
  productWidth?: number;
  /** Largest panel height in px (used to size Picsart output, capped at 4000) */
  productHeight?: number;
  onApply: (patternUrl: string) => void | Promise<void>;
  isLoading?: boolean;
}

export function PatternCustomizer({
  motifUrl,
  productWidth = 2000,
  productHeight = 2000,
  onApply,
  isLoading = false,
}: PatternCustomizerProps) {
  const [pattern, setPattern] = useState<PatternType>("tile");
  const [scale, setScale] = useState<number>(1.5);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cap output at 4000px to keep Picsart calls fast; leggings panels are ~4500px
  const outWidth = Math.min(productWidth, 4000);
  const outHeight = Math.min(productHeight, 4000);

  const callPatternApi = useCallback(async (): Promise<string | null> => {
    setError(null);
    const body = {
      imageUrl: motifUrl,
      pattern,
      scale,
      width: outWidth,
      height: outHeight,
    };
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
  }, [motifUrl, pattern, scale, outWidth, outHeight]);

  const handlePreview = async () => {
    setIsPreviewing(true);
    try {
      const url = await callPatternApi();
      if (url) setPreviewUrl(url);
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleApply = async () => {
    setIsApplying(true);
    try {
      const url = previewUrl ?? (await callPatternApi());
      if (url) {
        await onApply(url);
      }
    } finally {
      setIsApplying(false);
    }
  };

  const busy = isPreviewing || isApplying || isLoading;

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
          <div className="aspect-square rounded overflow-hidden border bg-background flex items-center justify-center">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt="Pattern preview"
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="text-xs text-muted-foreground px-2 text-center">
                Click "Preview" to see the tiled pattern
              </span>
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
          {isPreviewing ? "Generating preview…" : "Preview Pattern"}
        </Button>
        <Button
          size="sm"
          onClick={handleApply}
          disabled={busy}
          className="flex-1"
        >
          {isApplying ? "Applying…" : "Apply to Product"}
        </Button>
      </div>
    </div>
  );
}
