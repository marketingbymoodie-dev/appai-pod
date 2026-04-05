/**
 * PatternCustomizer — two-step AOP pattern tool.
 *
 * After the AI generates a motif, AOP products need it tiled into a seamless
 * pattern via Picsart before the mockup can be generated.
 *
 * Pipeline:
 *   1. Picsart removebg — strips the AI chroma-key (#FF00FF) background,
 *      replacing it with the user-chosen background colour (or transparency).
 *   2. Picsart pattern tiler — tiles the clean motif into a seamless repeat.
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

/** Preset background colours shown as quick-pick swatches */
const BG_PRESETS = [
  { label: "Transparent", value: "" },
  { label: "White",       value: "#ffffff" },
  { label: "Black",       value: "#000000" },
  { label: "Navy",        value: "#1e3a5f" },
  { label: "Forest",      value: "#2d5a27" },
  { label: "Burgundy",    value: "#800020" },
  { label: "Sky",         value: "#87ceeb" },
  { label: "Cream",       value: "#fffdd0" },
];

const PREVIEW_SIZE = 1024;
const APPLY_CAP = 2048;
const COUNTDOWN_SECONDS = 8; // removebg + pattern = two API calls

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
  // Default scale 1.5× — Picsart minimum is 1.0, 1.5 gives a good number of repeats
  const [scale, setScale] = useState<number>(1.5);
  const [mirrorLegs, setMirrorLegs] = useState<boolean>(true);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Background colour — empty string means transparent
  const [bgColor, setBgColor] = useState<string>("#ffffff");
  const [customBgColor, setCustomBgColor] = useState<string>("#ffffff");

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
    const body: Record<string, unknown> = { imageUrl: motifUrl, pattern, scale, width, height };
    if (bgColor) body.bgColor = bgColor;
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
  }, [motifUrl, pattern, scale, bgColor]);

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
  const spinnerLabel = isApplying ? "Applying pattern to product…" : "Removing background & tiling…";

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
          <div
            className="aspect-square rounded overflow-hidden border flex items-center justify-center relative"
            style={{ backgroundColor: bgColor || "transparent" }}
          >
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
          min={1.0}
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

      {/* Background colour picker */}
      <div className="space-y-2">
        <Label className="text-xs">Background colour</Label>
        <div className="flex flex-wrap gap-2 items-center">
          {BG_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              title={preset.label}
              onClick={() => { setBgColor(preset.value); setCustomBgColor(preset.value || "#ffffff"); setPreviewUrl(null); }}
              className="w-7 h-7 rounded-full border-2 flex-shrink-0 transition-transform hover:scale-110"
              style={{
                backgroundColor: preset.value || "transparent",
                borderColor: bgColor === preset.value ? "#111827" : "#d1d5db",
                backgroundImage: preset.value === ""
                  ? "linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)"
                  : undefined,
                backgroundSize: preset.value === "" ? "6px 6px" : undefined,
                backgroundPosition: preset.value === "" ? "0 0, 0 3px, 3px -3px, -3px 0px" : undefined,
                outline: bgColor === preset.value ? "2px solid #111827" : "none",
                outlineOffset: "2px",
              }}
            />
          ))}
          {/* Custom colour input */}
          <div className="flex items-center gap-1.5">
            <input
              type="color"
              value={customBgColor}
              onChange={(e) => {
                setCustomBgColor(e.target.value);
                setBgColor(e.target.value);
                setPreviewUrl(null);
              }}
              className="w-7 h-7 rounded cursor-pointer border border-gray-300"
              title="Custom colour"
            />
            <span className="text-xs text-muted-foreground">Custom</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The AI background will be removed and replaced with this colour.
          {bgColor === "" && " Transparent = subject only, no fill."}
        </p>
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
