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

function drawTiledPattern(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  opts: { pattern: PatternType; scale: number; bgColor: string; forExport?: boolean }
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

  // scale=1 → ~6 tiles across; scale=3 → ~2 tiles across
  const tileW = Math.round(W / (opts.scale * 2));
  const tileH = Math.round(tileW * (img.height / img.width));
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
  const [scale, setScale]     = useState<number>(1.5);

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
  const rulerCanvasRef   = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const motifImgRef = useRef<HTMLImageElement | null>(null);
  const [motifLoaded, setMotifLoaded] = useState(false);

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

  // Live pattern canvas
  useEffect(() => {
    if (mode !== "pattern" || !motifLoaded || !motifImgRef.current) return;
    const canvas = patternCanvasRef.current;
    if (!canvas) return;
    drawTiledPattern(canvas, motifImgRef.current, { pattern, scale, bgColor });
  }, [mode, motifLoaded, pattern, scale, bgColor]);

  // Ruler overlay — redraws whenever scale or product dimensions change.
  // Real-world dimensions derived from productWidth/productHeight at 150 DPI:
  //   realWidthCm  = (productWidth  / 150) * 2.54
  //   realHeightCm = (productHeight / 150) * 2.54
  // Preview canvas = 200×200px (logical), representing the full print area.
  useEffect(() => {
    if (mode !== "pattern") return;
    const ruler = rulerCanvasRef.current;
    if (!ruler) return;
    const ctx = ruler.getContext("2d");
    if (!ctx) return;
    const W = ruler.width;   // 200
    const H = ruler.height;  // 200
    const RULER = 14;        // ruler strip width in px

    // Derive real-world print dimensions from product props (150 DPI standard)
    const printW = Math.min(productWidth,  APPLY_CAP); // px used for export
    const printH = Math.min(productHeight, APPLY_CAP);
    const realWidthCm  = (printW / 150) * 2.54;
    const realHeightCm = (printH / 150) * 2.54;
    const realWidthIn  = printW / 150;
    const realHeightIn = printH / 150;

    // Preview px → real-world unit conversion
    const cmPerPx   = realWidthCm  / W;
    const inchPerPx = realWidthIn  / W;
    const cmPerPxH  = realHeightCm / H;

    ctx.clearRect(0, 0, W, H);

    // ── Left ruler (cm, vertical) ────────────────────────────────────────────
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.fillRect(0, 0, RULER, H);

    ctx.strokeStyle = "#6b7280";
    ctx.fillStyle   = "#374151";
    ctx.font        = "5px sans-serif";
    ctx.textAlign   = "right";
    ctx.textBaseline = "middle";
    ctx.lineWidth   = 0.75;

    // Adaptive tick interval: keep ticks readable regardless of product height
    const cmStepH = realHeightCm <= 40 ? (scale >= 3 ? 5 : scale >= 1.8 ? 2 : 1)
                                        : (scale >= 3 ? 10 : scale >= 1.8 ? 5 : 2);
    for (let cm = 0; cm <= realHeightCm; cm += cmStepH) {
      const y = cm / cmPerPxH;
      if (y > H) break;
      const isMajor = cm % (cmStepH * 5) === 0;
      const tickLen = isMajor ? RULER - 2 : Math.round(RULER * 0.55);
      ctx.beginPath();
      ctx.moveTo(RULER, y);
      ctx.lineTo(RULER - tickLen, y);
      ctx.stroke();
      if (isMajor && y > 4 && y < H - 4) {
        ctx.save();
        ctx.translate(RULER - tickLen - 1, y);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(`${cm}`, 0, 0);
        ctx.restore();
      }
    }
    // "cm" label rotated along left edge
    ctx.save();
    ctx.fillStyle = "#6b7280";
    ctx.font = "5px sans-serif";
    ctx.textAlign = "center";
    ctx.translate(RULER / 2, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("cm", 0, 0);
    ctx.restore();

    // ── Bottom ruler (inches, horizontal) ────────────────────────────────────
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.fillRect(0, H - RULER, W, RULER);

    ctx.strokeStyle = "#6b7280";
    ctx.fillStyle   = "#374151";
    ctx.font        = "5px sans-serif";
    ctx.textAlign   = "center";
    ctx.textBaseline = "top";
    ctx.lineWidth   = 0.75;

    // Adaptive tick interval based on product width
    const inStep = realWidthIn <= 20 ? (scale >= 3 ? 2 : 1)
                                      : (scale >= 3 ? 5 : scale >= 1.8 ? 2 : 1);
    for (let inch = 0; inch <= realWidthIn; inch += inStep) {
      const x = inch / inchPerPx;
      if (x > W) break;
      const isMajor = inch % (inStep * 5) === 0;
      const tickLen = isMajor ? RULER - 2 : Math.round(RULER * 0.55);
      ctx.beginPath();
      ctx.moveTo(x, H - RULER);
      ctx.lineTo(x, H - RULER + tickLen);
      ctx.stroke();
      if (isMajor && x > 4 && x < W - 4) {
        ctx.fillText(`${inch}"`, x, H - RULER + tickLen + 1);
      }
    }
    // "in" label along bottom edge
    ctx.fillStyle = "#6b7280";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText('in', W / 2, H - 1);

    // ── Corner square (covers left/bottom intersection) ───────────────────────
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.fillRect(0, H - RULER, RULER, RULER);
  }, [mode, scale, productWidth, productHeight]);

  // Live single-image canvas
  useEffect(() => {
    if (mode !== "single" || !motifLoaded || !motifImgRef.current) return;
    const canvas = singleCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = motifImgRef.current;
    const W = canvas.width; const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const sz = 10;
    for (let y = 0; y < H; y += sz)
      for (let x = 0; x < W; x += sz) {
        ctx.fillStyle = ((x / sz + y / sz) % 2 === 0) ? "#e5e7eb" : "#f9fafb";
        ctx.fillRect(x, y, sz, sz);
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
    ctx.save(); ctx.translate(cx, cy); ctx.rotate((singleRotation * Math.PI) / 180);
    ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih); ctx.restore();
    ctx.save(); ctx.translate(cx, cy); ctx.rotate((singleRotation * Math.PI) / 180);
    ctx.strokeStyle = "rgba(99,102,241,0.8)"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
    ctx.strokeRect(-iw / 2, -ih / 2, iw, ih); ctx.setLineDash([]);
    ctx.fillStyle = "rgba(99,102,241,1)";
    [[-iw/2,-ih/2],[iw/2,-ih/2],[iw/2,ih/2],[-iw/2,ih/2]].forEach(([hx,hy]) => {
      ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI*2); ctx.fill();
    });
    ctx.restore();
  }, [mode, motifLoaded, singleScale, singleRotation, singlePosX, singlePosY, bgColor]);

  // Drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== "single") return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    dragRef.current = { startX: e.clientX - rect.left, startY: e.clientY - rect.top, origX: singlePosX, origY: singlePosY };
  }, [mode, singlePosX, singlePosY]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current || mode !== "single") return;
    const canvas = singleCanvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dx = e.clientX - rect.left - dragRef.current.startX;
    const dy = e.clientY - rect.top  - dragRef.current.startY;
    setSinglePosX(Math.max(-100, Math.min(100, Math.round(dragRef.current.origX + (dx / canvas.width)  * 100))));
    setSinglePosY(Math.max(-100, Math.min(100, Math.round(dragRef.current.origY + (dy / canvas.height) * 100))));
  }, [mode]);

  const handleMouseUp = useCallback(() => { dragRef.current = null; }, []);

  // Background removal
  const handleRemoveBg = async () => {
    setIsRemovingBg(true); setBgRemoveError(null);
    try {
      // Convert to data URL first so the server doesn't need to fetch a proxy-prefixed URL
      let imageDataUrl: string;
      if (motifUrl.startsWith("data:")) {
        imageDataUrl = motifUrl;
      } else {
        const imgRes = await fetch(motifUrl, { signal: AbortSignal.timeout(15000) });
        if (!imgRes.ok) throw new Error(`Failed to load motif image (${imgRes.status})`);
        const blob = await imgRes.blob();
        imageDataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error("Failed to read image"));
          reader.readAsDataURL(blob);
        });
      }
      const apiFetch = fetchFn ?? fetch;
      const res = await apiFetch(`${API_BASE}/api/pattern/remove-bg`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: imageDataUrl }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || "Failed"); }
      const data = await res.json();
      if (data.url) setBgRemovedUrl(data.url);
    } catch (err: any) {
      setBgRemoveError(err.message || "Background removal failed");
    } finally {
      setIsRemovingBg(false);
    }
  };

  // Apply — fully client-side Canvas tiling (no server call needed for mockup generation).
  // Generates the tiled pattern at APPLY_CAP resolution using the same drawTiledPattern
  // function used for the live preview, then exports as a data URL.
  const handleApply = async () => {
    setIsApplying(true); setError(null);
    try {
      // Ensure motif image is loaded
      if (!motifImgRef.current || !motifLoaded) {
        throw new Error("Motif image not loaded yet — please wait a moment and try again");
      }
      const img = motifImgRef.current;

      const W = Math.min(productWidth,  APPLY_CAP);
      const H = Math.min(productHeight, APPLY_CAP);

      // Create an offscreen canvas at the apply resolution
      const canvas = document.createElement("canvas");
      canvas.width  = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context unavailable");

      if (mode === "pattern") {
        // Tile the motif across the full canvas
        drawTiledPattern(canvas, img, { pattern, scale, bgColor, forExport: true });
      } else {
        // Single-image placement
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

      // Export as PNG data URL
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
  // Compact layout: fills the canvas overlay (absolute inset-0, ~520px tall)
  // Two-column: left = previews, right = controls
  return (
    <div className="w-full h-full flex flex-col p-3 gap-2 bg-background select-none">

      {/* ── Header row: title + mode toggle ── */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-sm font-semibold">AOP Settings</span>
        <div className="ml-auto flex gap-0.5 rounded-md border p-0.5 bg-muted">
          {([["pattern", LayoutGrid, "Pattern"], ["single", ImageIcon, "Single Image"]] as const).map(([m, Icon, label]) => (
            <button
              key={m} type="button" onClick={() => setMode(m)} disabled={busy}
              className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold transition-colors ${
                mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-3 w-3" />{label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Main body: 2-column ── */}
      <div className="flex gap-3 flex-1 min-h-0">

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

          {/* Live preview canvas */}
          <div className="flex-1 min-h-0">
            <p className="text-[10px] text-muted-foreground text-center mb-0.5">
              {mode === "single" ? "Drag to reposition" : "Live preview"}
            </p>
            <div className="w-full h-full rounded border overflow-hidden relative" style={{ minHeight: 80 }}>
              {mode === "pattern" && (
                motifLoaded ? (
                  <>
                    <canvas ref={patternCanvasRef} width={200} height={200} className="w-full h-full" style={{ display: "block" }} />
                    {/* Ruler overlay — cm left, inches bottom; pointer-events:none so it doesn't block interaction */}
                    <canvas
                      ref={rulerCanvasRef}
                      width={200} height={200}
                      className="absolute inset-0 w-full h-full"
                      style={{ display: "block", pointerEvents: "none" }}
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
                  ref={singleCanvasRef} width={200} height={200}
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

              <div className="shrink-0 space-y-1">
                <div className="flex justify-between items-center">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Scale</Label>
                  <span className="text-[10px] text-muted-foreground tabular-nums">{scale.toFixed(1)}×</span>
                </div>
                <Slider min={1.0} max={5} step={0.1} value={[scale]} onValueChange={([v]) => setScale(v)} className="py-0" />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>Smaller</span><span>Larger</span>
                </div>
                {/* Real-world tile size readout — derived from productWidth at 150 DPI */}
                {(() => {
                  const printW    = Math.min(productWidth, APPLY_CAP);
                  const realWCm   = (printW / 150) * 2.54;   // full print width in cm
                  const realWIn   = printW / 150;             // full print width in inches
                  // scale=1 → tileW = printW/(1*2), scale=s → tileW = printW/(s*2)
                  const tileCm    = realWCm / (scale * 2);
                  const tileIn    = realWIn / (scale * 2);
                  return (
                    <p className="text-[10px] text-blue-600 dark:text-blue-400 tabular-nums leading-tight">
                      Each tile ≈ {tileCm.toFixed(1)} cm × {tileCm.toFixed(1)} cm
                      &nbsp;({tileIn.toFixed(1)}" × {tileIn.toFixed(1)}")
                    </p>
                  );
                })()}
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
                  <Slider min={min} max={max} step={step} value={[value]} onValueChange={([v]) => set(v)} className="py-0" />
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
            Preview is instant. Apply generates the final high-res version.
          </p>
        </div>
      </div>
    </div>
  );
}
