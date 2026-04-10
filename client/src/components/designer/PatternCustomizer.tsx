/**
 * PatternCustomizer — AOP pattern/placement tool.
 *
 * Two modes:
 *   • Pattern      — tiles the motif across all panels using client-side Canvas (instant live preview).
 *   • Single Image — places the full AI artwork on each panel with free-transform.
 *
 * Pipeline (Pattern mode):
 *   1. [Optional] remove.bg — user can trigger background removal as a separate step.
 *   2. Client-side Canvas tiling — instant live preview, no server round-trip.
 *   3. On "Apply Pattern" — server generates high-res version via /api/pattern/preview.
 *
 * Pipeline (Single Image mode):
 *   1. Client-side Canvas live preview with drag/scale/rotate.
 *   2. On "Apply to Product" — server generates high-res composite.
 *
 * Key design principle (from research of Repper, Printify, Canva/PatternedAI):
 *   All top tools do client-side tiling for instant feedback. Background removal
 *   is a separate optional step, never blocking the preview.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Loader2, LayoutGrid, ImageIcon, RotateCcw, Scissors } from "lucide-react";
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

const APPLY_CAP = 2048;

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

// ── Client-side Canvas tiling ────────────────────────────────────────────────

/**
 * Draws a tiled pattern onto a canvas using the given motif image.
 * Supports grid, brick-offset, and half-drop repeat modes.
 * This runs entirely in the browser — no server call needed.
 */
function drawTiledPattern(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  opts: {
    pattern: PatternType;
    scale: number;
    bgColor: string;
  }
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  // Checkerboard background (shows transparency)
  const sz = 12;
  for (let y = 0; y < H; y += sz) {
    for (let x = 0; x < W; x += sz) {
      ctx.fillStyle = ((x / sz + y / sz) % 2 === 0) ? "#e5e7eb" : "#f9fafb";
      ctx.fillRect(x, y, sz, sz);
    }
  }

  // Solid background colour fill
  if (opts.bgColor) {
    ctx.fillStyle = opts.bgColor;
    ctx.fillRect(0, 0, W, H);
  }

  // Tile size: scale controls how many tiles fit across the canvas
  // scale=1 → motif fills 1/3 of width; scale=3 → fills full width
  const tileW = Math.round(W / (opts.scale * 2));
  const tileH = Math.round(tileW * (img.height / img.width));

  const cols = Math.ceil(W / tileW) + 2;
  const rows = Math.ceil(H / tileH) + 2;

  for (let row = -1; row < rows; row++) {
    for (let col = -1; col < cols; col++) {
      let x = col * tileW;
      let y = row * tileH;

      // Brick offset: odd rows shifted by half tile width
      if (opts.pattern === "brick" && row % 2 !== 0) {
        x += tileW / 2;
      }
      // Half-drop: odd columns shifted by half tile height
      if (opts.pattern === "half" && col % 2 !== 0) {
        y += tileH / 2;
      }

      ctx.drawImage(img, x, y, tileW, tileH);
    }
  }
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
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bgColor, setBgColor] = useState<string>("#ffffff");
  const [customBgColor, setCustomBgColor] = useState<string>("#ffffff");

  // ── Background removal state ──────────────────────────────────────────────
  const [isRemovingBg, setIsRemovingBg] = useState(false);
  const [bgRemovedUrl, setBgRemovedUrl] = useState<string | null>(null);
  const [bgRemoveError, setBgRemoveError] = useState<string | null>(null);

  // The active motif URL: use bg-removed version if available, else original
  const activeMotifUrl = bgRemovedUrl || motifUrl;

  // ── Canvas refs ───────────────────────────────────────────────────────────
  const patternCanvasRef = useRef<HTMLCanvasElement>(null);
  const singleCanvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // ── Loaded motif image (for client-side canvas) ───────────────────────────
  const motifImgRef = useRef<HTMLImageElement | null>(null);
  const [motifLoaded, setMotifLoaded] = useState(false);

  // Load motif image whenever activeMotifUrl changes
  useEffect(() => {
    setMotifLoaded(false);
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      motifImgRef.current = img;
      setMotifLoaded(true);
    };
    img.onerror = () => {
      // Try without crossOrigin if CORS fails
      const img2 = new window.Image();
      img2.onload = () => { motifImgRef.current = img2; setMotifLoaded(true); };
      img2.src = activeMotifUrl;
    };
    img.src = activeMotifUrl;
  }, [activeMotifUrl]);

  // ── Live pattern canvas (Pattern mode) ───────────────────────────────────
  useEffect(() => {
    if (mode !== "pattern" || !motifLoaded || !motifImgRef.current) return;
    const canvas = patternCanvasRef.current;
    if (!canvas) return;
    drawTiledPattern(canvas, motifImgRef.current, { pattern, scale, bgColor });
  }, [mode, motifLoaded, pattern, scale, bgColor]);

  // ── Live single-image canvas ──────────────────────────────────────────────
  useEffect(() => {
    if (mode !== "single" || !motifLoaded || !motifImgRef.current) return;
    const canvas = singleCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = motifImgRef.current;
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

    if (bgColor) { ctx.fillStyle = bgColor; ctx.fillRect(0, 0, W, H); }

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
  }, [mode, motifLoaded, singleScale, singleRotation, singlePosX, singlePosY, bgColor]);

  // ── Canvas drag handlers (single image mode) ──────────────────────────────
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
    const canvas = singleCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dx = e.clientX - rect.left - dragRef.current.startX;
    const dy = e.clientY - rect.top - dragRef.current.startY;
    const newX = Math.max(-100, Math.min(100, Math.round(dragRef.current.origX + (dx / canvas.width) * 100)));
    const newY = Math.max(-100, Math.min(100, Math.round(dragRef.current.origY + (dy / canvas.height) * 100)));
    setSinglePosX(newX);
    setSinglePosY(newY);
  }, [mode]);

  const handleCanvasMouseUp = useCallback(() => { dragRef.current = null; }, []);

  // ── Background removal ────────────────────────────────────────────────────
  const handleRemoveBg = async () => {
    setIsRemovingBg(true);
    setBgRemoveError(null);
    try {
      const res = await fetch("/api/pattern/remove-bg", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: motifUrl }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Background removal failed" }));
        throw new Error(err.error || "Background removal failed");
      }
      const data = await res.json();
      if (data.url) {
        setBgRemovedUrl(data.url);
      }
    } catch (err: any) {
      setBgRemoveError(err.message || "Background removal failed");
    } finally {
      setIsRemovingBg(false);
    }
  };

  // ── Server call for final high-res Apply ──────────────────────────────────
  const applyWidth = Math.min(productWidth, APPLY_CAP);
  const applyHeight = Math.min(productHeight, APPLY_CAP);

  const callPatternApi = useCallback(async (width: number, height: number): Promise<string | null> => {
    setError(null);
    const body: Record<string, unknown> = {
      imageUrl: activeMotifUrl,
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
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      setError(err.error || "Pattern generation failed");
      return null;
    }
    const data = await res.json();
    return data.patternUrl ?? null;
  }, [activeMotifUrl, mode, pattern, scale, bgColor, singleScale, singleRotation, singlePosX, singlePosY]);

  const handleApply = async () => {
    setIsApplying(true);
    try {
      const url = await callPatternApi(applyWidth, applyHeight);
      if (url) {
        await onApply(url, {
          mirrorLegs,
          mode,
          ...(mode === "single" && {
            singleTransform: { scale: singleScale, rotation: singleRotation, posX: singlePosX, posY: singlePosY },
          }),
        });
      }
    } finally {
      setIsApplying(false);
    }
  };

  const resetSingleTransform = () => {
    setSingleScale(1.0);
    setSingleRotation(0);
    setSinglePosX(0);
    setSinglePosY(0);
  };

  const busy = isApplying || isLoading;

  return (
    <div className="space-y-4 p-4 border rounded-lg bg-muted/30">

      {/* ── Mode selector ── */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">AOP Settings</span>
        <div className="ml-auto flex gap-1 rounded-md border p-0.5 bg-background">
          <button
            type="button"
            onClick={() => setMode("pattern")}
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
            onClick={() => setMode("single")}
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

      {/* ── Background removal ── */}
      <div className="flex items-center gap-3 rounded-md border px-3 py-2 bg-background">
        <div className="flex-1 space-y-0.5">
          <p className="text-xs font-medium">Remove AI background</p>
          <p className="text-xs text-muted-foreground">
            {bgRemovedUrl
              ? "✓ Background removed — using clean cutout"
              : "Strip the white background for a clean subject-only motif"}
          </p>
          {bgRemoveError && <p className="text-xs text-destructive">{bgRemoveError}</p>}
        </div>
        {bgRemovedUrl ? (
          <button
            type="button"
            onClick={() => { setBgRemovedUrl(null); setBgRemoveError(null); }}
            className="text-xs text-muted-foreground hover:text-foreground underline shrink-0"
          >
            Undo
          </button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={handleRemoveBg}
            disabled={isRemovingBg || busy}
            className="shrink-0"
          >
            {isRemovingBg ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Removing…
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <Scissors className="h-3.5 w-3.5" />
                Remove BG
              </span>
            )}
          </Button>
        )}
      </div>

      {/* ── Preview area ── */}
      <div className="grid grid-cols-2 gap-3">
        {/* Motif */}
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground text-center">
            {bgRemovedUrl ? "Clean cutout" : "Your motif"}
          </p>
          <div className="aspect-square rounded overflow-hidden border bg-background flex items-center justify-center"
            style={{
              backgroundImage: "linear-gradient(45deg, #e5e7eb 25%, transparent 25%), linear-gradient(-45deg, #e5e7eb 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e5e7eb 75%), linear-gradient(-45deg, transparent 75%, #e5e7eb 75%)",
              backgroundSize: "12px 12px",
              backgroundPosition: "0 0, 0 6px, 6px -6px, -6px 0px",
            }}
          >
            <img src={activeMotifUrl} alt="Motif" className="w-full h-full object-contain" />
          </div>
        </div>

        {/* Live pattern preview */}
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground text-center">
            {mode === "single" ? "Live preview (drag to reposition)" : "Live pattern preview"}
          </p>
          <div className="aspect-square rounded overflow-hidden border relative">
            {/* Pattern mode: client-side canvas tiling */}
            {mode === "pattern" && (
              <>
                {motifLoaded ? (
                  <canvas
                    ref={patternCanvasRef}
                    width={256}
                    height={256}
                    className="w-full h-full"
                    style={{ display: "block" }}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-muted/30">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                )}
              </>
            )}

            {/* Single image mode: live canvas preview */}
            {mode === "single" && (
              <canvas
                ref={singleCanvasRef}
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
          </div>
        </div>
      </div>

      {/* ── Pattern mode controls ── */}
      {mode === "pattern" && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-xs">Pattern type</Label>
            <Select value={pattern} onValueChange={(v) => setPattern(v as PatternType)}>
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
              onValueChange={([v]) => setScale(v)}
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
            <Slider min={0.1} max={4} step={0.01} value={[singleScale]} onValueChange={([v]) => setSingleScale(v)} />
          </div>

          {/* Rotation */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Rotation</Label>
              <span className="text-xs text-muted-foreground tabular-nums">{singleRotation}°</span>
            </div>
            <Slider min={-180} max={180} step={1} value={[singleRotation]} onValueChange={([v]) => setSingleRotation(v)} />
          </div>

          {/* Position X */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Position X</Label>
              <span className="text-xs text-muted-foreground tabular-nums">{singlePosX}%</span>
            </div>
            <Slider min={-100} max={100} step={1} value={[singlePosX]} onValueChange={([v]) => setSinglePosX(v)} />
          </div>

          {/* Position Y */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Position Y</Label>
              <span className="text-xs text-muted-foreground tabular-nums">{singlePosY}%</span>
            </div>
            <Slider min={-100} max={100} step={1} value={[singlePosY]} onValueChange={([v]) => setSinglePosY(v)} />
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
              onClick={() => { setBgColor(preset.value); setCustomBgColor(preset.value || "#ffffff"); }}
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
              onChange={(e) => { setCustomBgColor(e.target.value); setBgColor(e.target.value); }}
              className="w-7 h-7 rounded cursor-pointer border border-gray-300"
              title="Custom colour"
            />
            <span className="text-xs text-muted-foreground">Custom</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {mode === "pattern"
            ? "Fill colour behind the motif in the tiled pattern."
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

      {/* ── Apply action ── */}
      <div className="space-y-2">
        <Button
          size="sm"
          onClick={handleApply}
          disabled={busy}
          className="w-full"
        >
          {isApplying ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Generating high-res pattern…
            </span>
          ) : isLoading ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Applying to product…
            </span>
          ) : (
            mode === "single" ? "Apply to Product" : "Apply Pattern"
          )}
        </Button>
        <p className="text-xs text-muted-foreground text-center">
          Preview updates instantly. Apply generates the final high-res version.
        </p>
      </div>
    </div>
  );
}
