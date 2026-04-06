/**
 * PatternCustomizer — AOP pattern/placement tool.
 *
 * Two modes:
 *   • Pattern  — tiles the motif across all panels (Sharp server-side tiling).
 *   • Single Image — places the full AI artwork on each panel with free-transform
 *                    (scale, rotation, position X/Y, canvas drag).
 *
 * Pipeline (Pattern mode):
 *   1. Picsart removebg — strips the AI white background → transparent PNG cutout.
 *   2. Sharp tileImage (server-side) — tiles the clean motif into a seamless grid.
 *
 * Pipeline (Single Image mode):
 *   1. Picsart removebg (optional — user can skip bg removal for single image).
 *   2. Sharp composite — places the artwork at the specified transform on each panel.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Loader2, LayoutGrid, ImageIcon, RotateCcw } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type PatternType = "grid" | "brick" | "half";
export type EditorMode = "pattern" | "single";

interface PatternOption {
  value: PatternType;
  label: string;
  description: string;
}

const PATTERN_OPTIONS: PatternOption[] = [
  { value: "grid",  label: "Grid",        description: "Classic straight repeat" },
  { value: "brick", label: "Brick offset", description: "Each row offset by 50%" },
  { value: "half",  label: "Half-drop",   description: "Each column offset by 50%" },
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
const COUNTDOWN_SECONDS = 10;

export interface PatternApplyOptions {
  mirrorLegs: boolean;
  mode: EditorMode;
  /** Single image transform — only present when mode === "single" */
  singleTransform?: {
    scale: number;
    rotation: number;
    posX: number; // percent of panel width, 0 = centred
    posY: number; // percent of panel height, 0 = centred
  };
}

interface PatternCustomizerProps {
  motifUrl: string;
  /** Largest panel width in px (used to size output, capped at APPLY_CAP) */
  productWidth?: number;
  /** Largest panel height in px (used to size output, capped at APPLY_CAP) */
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
  // ── Mode ──────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<EditorMode>("pattern");

  // ── Pattern mode state ────────────────────────────────────────────────────
  const [pattern, setPattern] = useState<PatternType>("grid");
  const [scale, setScale] = useState<number>(1.5);

  // ── Single image transform state ──────────────────────────────────────────
  const [singleScale, setSingleScale] = useState<number>(1.0);
  const [singleRotation, setSingleRotation] = useState<number>(0);
  const [singlePosX, setSinglePosX] = useState<number>(0);
  const [singlePosY, setSinglePosY] = useState<number>(0);

  // ── Shared state ──────────────────────────────────────────────────────────
  const [mirrorLegs, setMirrorLegs] = useState<boolean>(true);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bgColor, setBgColor] = useState<string>("#ffffff");
  const [customBgColor, setCustomBgColor] = useState<string>("#ffffff");

  // ── Canvas drag state (single image mode) ─────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // ── Countdown ─────────────────────────────────────────────────────────────
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
      if (remaining <= 0 && countdownRef.current) clearInterval(countdownRef.current);
    }, 250);
  }, []);

  const stopCountdown = useCallback(() => {
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    setCountdown(null);
  }, []);

  useEffect(() => () => { if (countdownRef.current) clearInterval(countdownRef.current); }, []);

  // ── Canvas preview for Single Image mode ─────────────────────────────────
  // Draws the motif on a canvas with the current transform so the user sees
  // live feedback without a server round-trip.
  useEffect(() => {
    if (mode !== "single") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      // Checkerboard background
      const sz = 10;
      for (let y = 0; y < H; y += sz) {
        for (let x = 0; x < W; x += sz) {
          ctx.fillStyle = ((x / sz + y / sz) % 2 === 0) ? "#e5e7eb" : "#f9fafb";
          ctx.fillRect(x, y, sz, sz);
        }
      }

      // Background colour fill
      if (bgColor) {
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, W, H);
      }

      // Compute base size (fit to canvas)
      const imgAR = img.width / img.height;
      const canvasAR = W / H;
      let baseW: number, baseH: number;
      if (imgAR > canvasAR) { baseW = W; baseH = W / imgAR; }
      else { baseH = H; baseW = H * imgAR; }
      const iw = baseW * singleScale;
      const ih = baseH * singleScale;
      const cx = W / 2 + (singlePosX / 100) * W;
      const cy = H / 2 + (singlePosY / 100) * H;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((singleRotation * Math.PI) / 180);
      ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
      ctx.restore();

      // Dashed bounding box
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((singleRotation * Math.PI) / 180);
      ctx.strokeStyle = "rgba(99,102,241,0.8)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(-iw / 2, -ih / 2, iw, ih);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(99,102,241,1)";
      [[-iw / 2, -ih / 2], [iw / 2, -ih / 2], [iw / 2, ih / 2], [-iw / 2, ih / 2]].forEach(([hx, hy]) => {
        ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2); ctx.fill();
      });
      ctx.restore();
    };
    img.src = motifUrl;
  }, [mode, motifUrl, singleScale, singleRotation, singlePosX, singlePosY, bgColor]);

  // ── Canvas drag handlers ──────────────────────────────────────────────────
  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== "single") return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      origX: singlePosX,
      origY: singlePosY,
    };
  }, [mode, singlePosX, singlePosY]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current || mode !== "single") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dx = e.clientX - rect.left - dragRef.current.startX;
    const dy = e.clientY - rect.top - dragRef.current.startY;
    const newX = Math.max(-100, Math.min(100, Math.round(dragRef.current.origX + (dx / canvas.width) * 100)));
    const newY = Math.max(-100, Math.min(100, Math.round(dragRef.current.origY + (dy / canvas.height) * 100)));
    setSinglePosX(newX);
    setSinglePosY(newY);
    setPreviewUrl(null);
  }, [mode]);

  const handleCanvasMouseUp = useCallback(() => { dragRef.current = null; }, []);

  // ── API calls ─────────────────────────────────────────────────────────────
  const applyWidth = Math.min(productWidth, APPLY_CAP);
  const applyHeight = Math.min(productHeight, APPLY_CAP);

  const callPatternApi = useCallback(async (width: number, height: number): Promise<string | null> => {
    setError(null);
    const body: Record<string, unknown> = {
      imageUrl: motifUrl,
      mode,
      width,
      height,
    };
    if (bgColor) body.bgColor = bgColor;

    if (mode === "pattern") {
      body.pattern = pattern;
      body.scale = scale;
    } else {
      body.singleScale = singleScale;
      body.singleRotation = singleRotation;
      body.singlePosX = singlePosX;
      body.singlePosY = singlePosY;
    }

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
  }, [motifUrl, mode, pattern, scale, bgColor, singleScale, singleRotation, singlePosX, singlePosY]);

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
        await onApply(url, {
          mirrorLegs,
          mode,
          ...(mode === "single" && {
            singleTransform: { scale: singleScale, rotation: singleRotation, posX: singlePosX, posY: singlePosY },
          }),
        });
      }
    } finally {
      stopCountdown();
      setIsApplying(false);
    }
  };

  const resetSingleTransform = () => {
    setSingleScale(1.0);
    setSingleRotation(0);
    setSinglePosX(0);
    setSinglePosY(0);
    setPreviewUrl(null);
  };

  const busy = isPreviewing || isApplying || isLoading;
  const showSpinner = isPreviewing || isApplying;
  const spinnerLabel = isApplying ? "Applying to product…" : "Processing image…";

  return (
    <div className="space-y-4 p-4 border rounded-lg bg-muted/30">

      {/* ── Mode selector ── */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">AOP Settings</span>
        <div className="ml-auto flex gap-1 rounded-md border p-0.5 bg-background">
          <button
            type="button"
            onClick={() => { setMode("pattern"); setPreviewUrl(null); }}
            disabled={busy}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
              mode === "pattern"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            Pattern
          </button>
          <button
            type="button"
            onClick={() => { setMode("single"); setPreviewUrl(null); }}
            disabled={busy}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
              mode === "single"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <ImageIcon className="h-3.5 w-3.5" />
            Single Image
          </button>
        </div>
      </div>

      {/* ── Preview area ── */}
      <div className="grid grid-cols-2 gap-3">
        {/* Motif */}
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground text-center">Your motif</p>
          <div className="aspect-square rounded overflow-hidden border bg-background flex items-center justify-center">
            <img src={motifUrl} alt="Motif" className="w-full h-full object-contain" />
          </div>
        </div>

        {/* Preview */}
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground text-center">
            {mode === "single" ? "Live preview (drag to reposition)" : "Pattern preview"}
          </p>
          <div className="aspect-square rounded overflow-hidden border relative">
            {/* Single image mode: live canvas preview */}
            {mode === "single" && (
              <canvas
                ref={canvasRef}
                width={256}
                height={256}
                className="w-full h-full"
                style={{ cursor: "grab", display: "block" }}
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                onMouseLeave={handleCanvasMouseUp}
              />
            )}

            {/* Pattern mode: server-rendered preview image */}
            {mode === "pattern" && (
              <div
                className="w-full h-full flex items-center justify-center"
                style={{ backgroundColor: bgColor || "transparent" }}
              >
                {previewUrl && !showSpinner ? (
                  <img src={previewUrl} alt="Pattern preview" className="w-full h-full object-cover" />
                ) : showSpinner ? null : (
                  <span className="text-xs text-muted-foreground px-2 text-center">
                    Click "Preview" to see the tiled pattern
                  </span>
                )}
              </div>
            )}

            {/* Spinner overlay */}
            {showSpinner && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/80 z-10 gap-2">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <p className="text-xs font-medium text-muted-foreground">{spinnerLabel}</p>
                {countdown !== null && countdown > 0 && (
                  <span className="text-lg font-semibold tabular-nums text-primary">{countdown}s</span>
                )}
                {countdown === 0 && (
                  <span className="text-xs text-muted-foreground">Almost there…</span>
                )}
              </div>
            )}
            {/* Keep previous preview faintly visible behind spinner */}
            {previewUrl && showSpinner && mode === "pattern" && (
              <img src={previewUrl} alt="Previous pattern" className="absolute inset-0 w-full h-full object-cover opacity-30" />
            )}
          </div>
        </div>
      </div>

      {/* ── Pattern mode controls ── */}
      {mode === "pattern" && (
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
                    <span className="ml-1 text-xs text-muted-foreground">— {opt.description}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">
              Scale <span className="text-muted-foreground">({scale.toFixed(1)}×)</span>
            </Label>
            <Slider
              min={1.0} max={5} step={0.1}
              value={[scale]}
              onValueChange={([v]) => { setScale(v); setPreviewUrl(null); }}
              className="mt-2"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Smaller</span><span>Larger</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Single image mode controls ── */}
      {mode === "single" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Drag on the preview to reposition, or use the sliders below.
          </p>

          {/* Scale */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Scale</Label>
              <span className="text-xs text-muted-foreground tabular-nums">{singleScale.toFixed(2)}×</span>
            </div>
            <Slider
              min={0.1} max={4} step={0.01}
              value={[singleScale]}
              onValueChange={([v]) => { setSingleScale(v); setPreviewUrl(null); }}
            />
          </div>

          {/* Rotation */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Rotation</Label>
              <span className="text-xs text-muted-foreground tabular-nums">{singleRotation}°</span>
            </div>
            <Slider
              min={-180} max={180} step={1}
              value={[singleRotation]}
              onValueChange={([v]) => { setSingleRotation(v); setPreviewUrl(null); }}
            />
          </div>

          {/* Position X */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Position X</Label>
              <span className="text-xs text-muted-foreground tabular-nums">{singlePosX}%</span>
            </div>
            <Slider
              min={-100} max={100} step={1}
              value={[singlePosX]}
              onValueChange={([v]) => { setSinglePosX(v); setPreviewUrl(null); }}
            />
          </div>

          {/* Position Y */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Position Y</Label>
              <span className="text-xs text-muted-foreground tabular-nums">{singlePosY}%</span>
            </div>
            <Slider
              min={-100} max={100} step={1}
              value={[singlePosY]}
              onValueChange={([v]) => { setSinglePosY(v); setPreviewUrl(null); }}
            />
          </div>

          {/* Reset */}
          <button
            type="button"
            onClick={resetSingleTransform}
            disabled={busy}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <RotateCcw className="h-3 w-3" />
            Reset transform
          </button>
        </div>
      )}

      {/* ── Background colour (both modes) ── */}
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
                borderColor: bgColor === preset.value ? "#111827" : "transparent",
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
          <div className="flex items-center gap-1.5">
            <input
              type="color"
              value={customBgColor}
              onChange={(e) => { setCustomBgColor(e.target.value); setBgColor(e.target.value); setPreviewUrl(null); }}
              className="w-7 h-7 rounded cursor-pointer border border-gray-300"
              title="Custom colour"
            />
            <span className="text-xs text-muted-foreground">Custom</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {mode === "pattern"
            ? "The AI background will be removed and replaced with this colour."
            : "Fill colour behind the artwork on each panel."}
          {bgColor === "" && " Transparent = subject only, no fill."}
        </p>
      </div>

      {/* ── Mirror toggle ── */}
      {hasPairedPanels && (
        <div className="flex items-center justify-between rounded-md border px-3 py-2 bg-background">
          <div className="space-y-0.5">
            <Label htmlFor="mirror-legs-toggle" className="text-xs font-medium cursor-pointer">
              Mirror left &amp; right panels
            </Label>
            <p className="text-xs text-muted-foreground">
              Flips the {mode === "single" ? "image" : "pattern"} on one leg for symmetry
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

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* ── Actions ── */}
      <div className="flex gap-2">
        {mode === "pattern" && (
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
        )}
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
            mode === "single" ? "Apply to Product" : "Apply Pattern"
          )}
        </Button>
      </div>
    </div>
  );
}
