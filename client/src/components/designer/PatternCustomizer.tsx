/**
 * PatternCustomizer — AOP pattern/placement tool.
 *
 * Rendered as a solid overlay on top of the product canvas (absolute inset-0).
 * Must fit entirely within the canvas container (~520px tall) with NO scrolling.
 *
 * Layout: tight 2-column grid
 *   Left  (40%) — motif thumbnail + live pattern preview canvas
 *   Right (60%) — all controls stacked compactly
 *
 * Two modes:
 *   • Pattern      — client-side Canvas tiling (instant, no server call)
 *   • Single Image — client-side Canvas placement with drag support
 *
 * Background removal is an optional separate step (dedicated button).
 * "Apply Pattern" is the only server call — generates the final high-res output.
 *
 * Preview model (Pattern mode):
 *   The preview canvas is a fixed 6×6 inch viewport into the final print.
 *   The SCALE slider (1–10) controls how many tiles appear across that 6-inch window.
 *     scale=1  → 1 tile fills the 6-inch window (large motif)
 *     scale=10 → 10 tiles across the 6-inch window (small, dense pattern)
 *
 *   Preview tile width (px) = PREVIEW_PX / scale
 *   Export tile width (px)  = APPLY_CAP / (scale * (printWIn / PREVIEW_INCHES))
 *     i.e. the same number of tiles per inch, scaled to the full print canvas.
 *
 *   Ruler: inches only — bottom edge 0–6", right edge 0–6". Ticks every 1", labels every 2".
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { API_BASE } from "@/lib/urlBase";
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

const PATTERN_OPTIONS = [
  { value: "grid"  as PatternType, label: "Grid",        desc: "Straight repeat" },
  { value: "brick" as PatternType, label: "Brick offset", desc: "Rows offset 50%" },
  { value: "half"  as PatternType, label: "Half-drop",   desc: "Cols offset 50%" },
];

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

/** Logical pixel size of the preview canvas element */
const PREVIEW_PX = 200;

/**
 * Fixed viewport size in inches shown in the preview.
 * The slider value = number of tiles visible across this window.
 */
const PREVIEW_INCHES = 6;

export interface PatternApplyOptions {
  mirrorLegs: boolean;
  mode: EditorMode;
  singleTransform?: { scale: number; rotation: number; posX: number; posY: number };
}

interface PatternCustomizerProps {
  motifUrl: string;
  productWidth?: number;
  productHeight?: number;
  hasPairedPanels?: boolean;
  onApply: (patternUrl: string, options: PatternApplyOptions) => void | Promise<void>;
  isLoading?: boolean;
  /** Optional fetch override — pass safeFetch from embed-design to bypass Shopify service worker */
  fetchFn?: (url: string, options?: RequestInit) => Promise<Response>;
}

// ── Client-side Canvas tiling ────────────────────────────────────────────────

/**
 * Draw tiled pattern onto canvas.
 *
 * tileW is always passed in explicitly:
 *   Preview: PREVIEW_PX / tilesAcross
 *   Export:  exportTileW (derived from tilesAcross scaled to full print width)
 */
function drawTiledPattern(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  opts: {
    pattern: PatternType;
    tileW: number;
    bgColor: string;
    forExport?: boolean;
  }
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (!opts.forExport) {
    // Checkerboard (shows transparency in preview only)
    const sz = 10;
    for (let y = 0; y < H; y += sz)
      for (let x = 0; x < W; x += sz) {
        ctx.fillStyle = ((x / sz + y / sz) % 2 === 0) ? "#e5e7eb" : "#f9fafb";
        ctx.fillRect(x, y, sz, sz);
      }
  }

  if (opts.bgColor) { ctx.fillStyle = opts.bgColor; ctx.fillRect(0, 0, W, H); }

  const tileW = Math.max(1, Math.round(opts.tileW));
  const tileH = Math.max(1, Math.round(tileW * (img.height / img.width)));
  const cols = Math.ceil(W / tileW) + 2;
  const rows = Math.ceil(H / tileH) + 2;

  for (let row = -1; row < rows; row++) {
    for (let col = -1; col < cols; col++) {
      let x = col * tileW;
      let y = row * tileH;
      if (opts.pattern === "brick" && row % 2 !== 0) x += tileW / 2;
      if (opts.pattern === "half"  && col % 2 !== 0) y += tileH / 2;
      ctx.drawImage(img, x, y, tileW, tileH);
    }
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export function PatternCustomizer({
  motifUrl,
  productWidth = 2000,
  productHeight = 2000,
  hasPairedPanels = false,
  onApply,
  isLoading = false,
  fetchFn,
}: PatternCustomizerProps) {
  const [mode, setMode]       = useState<EditorMode>("pattern");
  const [pattern, setPattern] = useState<PatternType>("grid");

  /**
   * tilesAcross: number of tiles visible across the 6-inch preview window.
   * Range 1–10. Default 2 (a couple of tiles visible — good starting point).
   */
  const [tilesAcross, setTilesAcross] = useState<number>(2);

  const [singleScale,    setSingleScale]    = useState(1.0);
  const [singleRotation, setSingleRotation] = useState(0);
  const [singlePosX,     setSinglePosX]     = useState(0);
  const [singlePosY,     setSinglePosY]     = useState(0);

  const [mirrorLegs, setMirrorLegs] = useState(true);
  const [isApplying, setIsApplying] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [bgColor,    setBgColor]    = useState("#ffffff");
  const [customBg,   setCustomBg]   = useState("#ffffff");

  const [isRemovingBg,  setIsRemovingBg]  = useState(false);
  const [bgRemovedUrl,  setBgRemovedUrl]  = useState<string | null>(null);
  const [bgRemoveError, setBgRemoveError] = useState<string | null>(null);

  const activeMotifUrl = bgRemovedUrl || motifUrl;

  const patternCanvasRef = useRef<HTMLCanvasElement>(null);
  const singleCanvasRef  = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const motifImgRef = useRef<HTMLImageElement | null>(null);
  const [motifLoaded, setMotifLoaded] = useState(false);

  // ── Derived tile sizes ─────────────────────────────────────────────────────
  //
  // Preview tile width: PREVIEW_PX / tilesAcross
  //   → at tilesAcross=1, the tile fills the whole 200px canvas (= 6 inches)
  //   → at tilesAcross=10, each tile is 20px (= 0.6 inches)
  //
  // Export tile width: how many tiles fit across the full print?
  //   Full print = printWIn inches. Preview window = PREVIEW_INCHES inches.
  //   Tiles per inch = tilesAcross / PREVIEW_INCHES
  //   Total tiles across full print = (tilesAcross / PREVIEW_INCHES) * printWIn
  //   Export tileW = APPLY_CAP / totalTilesAcrossFullPrint
  //
  const printW    = Math.min(productWidth,  APPLY_CAP);
  const printWIn  = printW / 150;  // full print width in inches (150 DPI)

  const previewTileW  = PREVIEW_PX / tilesAcross;
  const tilesPerInch  = tilesAcross / PREVIEW_INCHES;
  const totalTilesFullPrint = tilesPerInch * printWIn;
  const exportTileW   = printW / totalTilesFullPrint;

  // Real tile size in inches (for readout)
  const tileRealIn = PREVIEW_INCHES / tilesAcross;
  const tileRealCm = tileRealIn * 2.54;

  // Load motif image
  useEffect(() => {
    setMotifLoaded(false);
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { motifImgRef.current = img; setMotifLoaded(true); };
    img.onerror = () => {
      const img2 = new window.Image();
      img2.onload = () => { motifImgRef.current = img2; setMotifLoaded(true); };
      img2.src = activeMotifUrl;
    };
    img.src = activeMotifUrl;
  }, [activeMotifUrl]);

  // Live pattern canvas — uses previewTileW so canvas = 6×6 inch viewport
  useEffect(() => {
    if (mode !== "pattern" || !motifLoaded || !motifImgRef.current) return;
    const canvas = patternCanvasRef.current;
    if (!canvas) return;
    drawTiledPattern(canvas, motifImgRef.current, { pattern, tileW: previewTileW, bgColor });
  }, [mode, motifLoaded, pattern, tilesAcross, bgColor, previewTileW]);

  // Live single-image canvas
  useEffect(() => {
    if (mode !== "single" || !motifLoaded || !motifImgRef.current) return;
    const canvas = singleCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    // Checkerboard
    const sz = 10;
    for (let y = 0; y < H; y += sz)
      for (let x = 0; x < W; x += sz) {
        ctx.fillStyle = ((x / sz + y / sz) % 2 === 0) ? "#e5e7eb" : "#f9fafb";
        ctx.fillRect(x, y, sz, sz);
      }
    if (bgColor) { ctx.fillStyle = bgColor; ctx.fillRect(0, 0, W, H); }
    const img = motifImgRef.current;
    const imgAR = img.width / img.height;
    const canvasAR = W / H;
    let baseW: number, baseH: number;
    if (imgAR > canvasAR) { baseW = W; baseH = W / imgAR; }
    else { baseH = H; baseW = H * imgAR; }
    const iw = baseW * singleScale;
    const ih = baseH * singleScale;
    const cx = W / 2 + (singlePosX / 100) * W;
    const cy = H / 2 + (singlePosY / 100) * H;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate((singleRotation * Math.PI) / 180);
    ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih); ctx.restore();
  }, [mode, motifLoaded, singleScale, singleRotation, singlePosX, singlePosY, bgColor]);

  // Drag handlers for single-image mode
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      origX: singlePosX,
      origY: singlePosY,
    };
  }, [singlePosX, singlePosY]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = (e.clientX - rect.left - dragRef.current.startX) / rect.width * 100;
    const dy = (e.clientY - rect.top  - dragRef.current.startY) / rect.height * 100;
    setSinglePosX(Math.max(-100, Math.min(100, dragRef.current.origX + dx)));
    setSinglePosY(Math.max(-100, Math.min(100, dragRef.current.origY + dy)));
  }, []);

  const handleMouseUp = useCallback(() => { dragRef.current = null; }, []);

  // Remove background
  const handleRemoveBg = async () => {
    setIsRemovingBg(true); setBgRemoveError(null);
    try {
      const doFetch = fetchFn ?? fetch;
      const res = await doFetch(`${API_BASE}/api/remove-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: motifUrl }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (!data.url) throw new Error("No URL returned");
      setBgRemovedUrl(data.url);
    } catch (err: any) {
      setBgRemoveError(err.message || "Background removal failed");
    } finally {
      setIsRemovingBg(false);
    }
  };

  // Apply — fully client-side Canvas tiling.
  // Uses exportTileW so the density matches exactly what the user sees in the preview.
  const handleApply = async () => {
    setIsApplying(true); setError(null);
    try {
      if (!motifImgRef.current || !motifLoaded) {
        throw new Error("Motif image not loaded yet — please wait a moment and try again");
      }
      const img = motifImgRef.current;

      const W = Math.min(productWidth,  APPLY_CAP);
      const H = Math.min(productHeight, APPLY_CAP);

      const canvas = document.createElement("canvas");
      canvas.width  = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context unavailable");

      if (mode === "pattern") {
        drawTiledPattern(canvas, img, { pattern, tileW: exportTileW, bgColor, forExport: true });
      } else {
        ctx.clearRect(0, 0, W, H);
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
        ctx.save(); ctx.translate(cx, cy); ctx.rotate((singleRotation * Math.PI) / 180);
        ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih); ctx.restore();
      }

      const patternDataUrl = canvas.toDataURL("image/png");

      await onApply(patternDataUrl, {
        mirrorLegs, mode,
        ...(mode === "single" && { singleTransform: { scale: singleScale, rotation: singleRotation, posX: singlePosX, posY: singlePosY } }),
      });
    } catch (err: any) {
      setError(err.message || "Pattern generation failed");
    } finally {
      setIsApplying(false);
    }
  };

  const busy = isApplying || isLoading;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="w-full h-full flex flex-col p-3 gap-2 bg-background select-none">

      {/* ── Header row: title + mode toggle ── */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-sm font-semibold">AOP Settings</span>
        <div className="ml-auto flex gap-0.5 rounded-md border p-0.5 bg-muted">
          {([["pattern", LayoutGrid, "Pattern"], ["single", ImageIcon, "Single Image"]] as const).map(([m, Icon, label]) => (
            <button
              key={m} type="button"
              onClick={() => setMode(m)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors ${
                mode === m ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-3 w-3" />{label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Two-column body ── */}
      <div className="flex gap-3 flex-1 min-h-0 overflow-hidden">

        {/* Left column: motif + live preview */}
        <div className="flex flex-col gap-2 w-[42%] shrink-0">
          {/* Motif thumbnail */}
          <div className="shrink-0">
            <p className="text-[10px] text-muted-foreground text-center mb-0.5">
              {bgRemovedUrl ? "Clean cutout" : "Your motif"}
            </p>
            <div
              className="w-full aspect-square rounded border overflow-hidden"
              style={{
                backgroundImage: "linear-gradient(45deg,#e5e7eb 25%,transparent 25%),linear-gradient(-45deg,#e5e7eb 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e5e7eb 75%),linear-gradient(-45deg,transparent 75%,#e5e7eb 75%)",
                backgroundSize: "10px 10px",
                backgroundPosition: "0 0,0 5px,5px -5px,-5px 0",
              }}
            >
              <img src={activeMotifUrl} alt="Motif" className="w-full h-full object-contain" />
            </div>
          </div>

          {/* Live preview canvas — represents a fixed 6×6 inch viewport */}
          <div className="flex-1 min-h-0">
            <p className="text-[10px] text-muted-foreground text-center mb-0.5">
              {mode === "single" ? "Drag to reposition" : "6\u2033 \u00d7 6\u2033 preview"}
            </p>
            <div className="w-full h-full rounded border overflow-hidden relative" style={{ minHeight: 80 }}>
              {mode === "pattern" && (
                motifLoaded ? (
                  <>
                    <canvas
                      ref={patternCanvasRef}
                      width={PREVIEW_PX} height={PREVIEW_PX}
                      className="w-full h-full"
                      style={{ display: "block" }}
                    />
                  </>
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-muted/30">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                )
              )}
              {mode === "single" && (
                <canvas
                  ref={singleCanvasRef} width={PREVIEW_PX} height={PREVIEW_PX}
                  className="w-full h-full" style={{ cursor: "grab", display: "block" }}
                  onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}
                />
              )}
            </div>
          </div>
        </div>

        {/* Right column: all controls */}
        <div className="flex flex-col gap-2 flex-1 min-w-0 overflow-hidden">

          {/* Remove BG */}
          <div className="flex items-center gap-2 rounded border px-2 py-1.5 bg-muted/30 shrink-0">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-medium leading-tight">
                {bgRemovedUrl ? "✓ Background removed" : "Remove AI background"}
              </p>
              {bgRemoveError && <p className="text-[10px] text-destructive leading-tight">{bgRemoveError}</p>}
            </div>
            {bgRemovedUrl ? (
              <button type="button" onClick={() => { setBgRemovedUrl(null); setBgRemoveError(null); }}
                className="text-[10px] text-muted-foreground hover:text-foreground underline shrink-0">
                Undo
              </button>
            ) : (
              <Button variant="outline" size="sm" onClick={handleRemoveBg} disabled={isRemovingBg || busy}
                className="h-6 px-2 text-[10px] shrink-0">
                {isRemovingBg
                  ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Removing…</>
                  : <><Scissors className="h-3 w-3 mr-1" />Remove BG</>
                }
              </Button>
            )}
          </div>

          {/* Pattern mode controls */}
          {mode === "pattern" && (
            <>
              <div className="shrink-0 space-y-0.5">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Pattern type</Label>
                <Select value={pattern} onValueChange={(v) => setPattern(v as PatternType)}>
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PATTERN_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value} className="text-xs">
                        <span className="font-medium">{opt.label}</span>
                        <span className="ml-1 text-muted-foreground">— {opt.desc}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Scale slider — bordered box, no changing number, 1–10 tiles */}
              <div className="shrink-0 rounded border px-2 py-2 space-y-1.5 bg-muted/20">
                <div className="flex justify-between items-center">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Pattern size</Label>
                  <span className="text-[10px] text-muted-foreground">6″ × 6″ view</span>
                </div>
                <Slider
                  min={1} max={10} step={1}
                  value={[tilesAcross]}
                  onValueChange={([v]) => setTilesAcross(v)}
                  className="py-0 [&_[role=slider]]:bg-black [&_[role=slider]]:border-black [&_[role=slider]]:w-4 [&_[role=slider]]:h-4"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>Fewer, larger</span><span>More, smaller</span>
                </div>

              </div>
            </>
          )}

          {/* Single image mode controls */}
          {mode === "single" && (
            <>
              {[
                { label: "Scale", value: singleScale, min: 0.1, max: 4, step: 0.01, set: setSingleScale, fmt: (v: number) => `${v.toFixed(2)}×` },
                { label: "Rotation", value: singleRotation, min: -180, max: 180, step: 1, set: setSingleRotation, fmt: (v: number) => `${v}°` },
                { label: "Pos X", value: singlePosX, min: -100, max: 100, step: 1, set: setSinglePosX, fmt: (v: number) => `${v}%` },
                { label: "Pos Y", value: singlePosY, min: -100, max: 100, step: 1, set: setSinglePosY, fmt: (v: number) => `${v}%` },
              ].map(({ label, value, min, max, step, set, fmt }) => (
                <div key={label} className="shrink-0 space-y-0.5">
                  <div className="flex justify-between items-center">
                    <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</Label>
                    <span className="text-[10px] text-muted-foreground tabular-nums">{fmt(value)}</span>
                  </div>
                  <Slider
                    min={min} max={max} step={step}
                    value={[value]}
                    onValueChange={([v]) => set(v)}
                    className="py-0 [&_[role=slider]]:bg-black [&_[role=slider]]:border-black"
                  />
                </div>
              ))}
              <button type="button" onClick={() => { setSingleScale(1); setSingleRotation(0); setSinglePosX(0); setSinglePosY(0); }}
                disabled={busy}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground shrink-0">
                <RotateCcw className="h-2.5 w-2.5" />Reset
              </button>
            </>
          )}

          {/* Background colour */}
          <div className="shrink-0 space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Background colour</Label>
            <div className="flex flex-wrap gap-1.5 items-center">
              {BG_PRESETS.map((preset) => (
                <button
                  key={preset.value} type="button" title={preset.label}
                  onClick={() => { setBgColor(preset.value); setCustomBg(preset.value || "#ffffff"); }}
                  className="w-5 h-5 rounded-full border flex-shrink-0 transition-transform hover:scale-110"
                  style={{
                    backgroundColor: preset.value || "transparent",
                    borderColor: bgColor === preset.value ? "#111827" : "#d1d5db",
                    backgroundImage: preset.value === ""
                      ? "linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%)"
                      : undefined,
                    backgroundSize: preset.value === "" ? "5px 5px" : undefined,
                    backgroundPosition: preset.value === "" ? "0 0,0 2.5px,2.5px -2.5px,-2.5px 0" : undefined,
                    outline: bgColor === preset.value ? "2px solid #111827" : "none",
                    outlineOffset: "2px",
                  }}
                />
              ))}
              <input type="color" value={customBg}
                onChange={(e) => { setCustomBg(e.target.value); setBgColor(e.target.value); }}
                className="w-5 h-5 rounded cursor-pointer border border-gray-300"
                title="Custom colour"
              />
            </div>
          </div>

          {/* Mirror toggle */}
          {hasPairedPanels && (
            <div className="flex flex-col gap-1 shrink-0">
              <div className="flex items-center justify-between rounded border px-2 py-1.5 bg-muted/30">
                <div>
                  <p className="text-[10px] font-medium leading-tight">Mirror left &amp; right panels</p>
                  <p className="text-[10px] text-muted-foreground leading-tight">Flips pattern on one leg for symmetry</p>
                </div>
                <Switch id="mirror-legs" checked={mirrorLegs} onCheckedChange={setMirrorLegs} disabled={busy} />
              </div>
              {mirrorLegs && (
                <p className="text-[10px] text-amber-600 dark:text-amber-400 leading-tight px-1">
                  ⚠ If your design contains text or logos, disable mirroring to avoid reversed text on one leg.
                </p>
              )}
            </div>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Error */}
          {error && <p className="text-[10px] text-destructive shrink-0">{error}</p>}

          {/* Apply button */}
          <Button size="sm" onClick={handleApply} disabled={busy} className="w-full h-8 shrink-0">
            {isApplying ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Generating…</>
            ) : isLoading ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Applying…</>
            ) : (
              mode === "single" ? "Apply to Product" : "Apply Pattern"
            )}
          </Button>
          <p className="text-[10px] text-muted-foreground text-center shrink-0 leading-tight">
            Mockup previews are low-res. Your final print file is full high-res.
          </p>
        </div>
      </div>
    </div>
  );
}
