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
  opts: { pattern: PatternType; scale: number; bgColor: string }
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Checkerboard (shows transparency)
  const sz = 10;
  for (let y = 0; y < H; y += sz)
    for (let x = 0; x < W; x += sz) {
      ctx.fillStyle = ((x / sz + y / sz) % 2 === 0) ? "#e5e7eb" : "#f9fafb";
      ctx.fillRect(x, y, sz, sz);
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

  // Apply (server call for high-res)
  const handleApply = async () => {
    setIsApplying(true); setError(null);
    try {
      // Always convert the motif to a data URL before sending to the server.
      // This avoids proxy-prefixed relative URLs (/apps/appai/objects/...) that
      // the server cannot fetch from Node.js.
      let imageDataUrl: string;
      if (activeMotifUrl.startsWith("data:")) {
        imageDataUrl = activeMotifUrl;
      } else {
        // Fetch via the browser (which handles proxy routing) and convert to data URL
        const imgRes = await fetch(activeMotifUrl, { signal: AbortSignal.timeout(15000) });
        if (!imgRes.ok) throw new Error(`Failed to load motif image (${imgRes.status})`);
        const blob = await imgRes.blob();
        imageDataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error("Failed to read image"));
          reader.readAsDataURL(blob);
        });
      }

      const body: Record<string, unknown> = {
        imageUrl: imageDataUrl,
        mode,
        width:  Math.min(productWidth,  APPLY_CAP),
        height: Math.min(productHeight, APPLY_CAP),
        ...(bgColor ? { bgColor } : {}),
        ...(mode === "pattern"
          ? { pattern, scale }
          : { singleScale, singleRotation, singlePosX, singlePosY }),
      };
      const apiFetch = fetchFn ?? fetch;
      const res = await apiFetch(`${API_BASE}/api/pattern/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || "Failed"); }
      const data = await res.json();
      if (data.patternUrl) {
        await onApply(data.patternUrl, {
          mirrorLegs, mode,
          ...(mode === "single" && { singleTransform: { scale: singleScale, rotation: singleRotation, posX: singlePosX, posY: singlePosY } }),
        });
      }
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
                  <canvas ref={patternCanvasRef} width={200} height={200} className="w-full h-full" style={{ display: "block" }} />
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
            <div className="flex items-center justify-between rounded border px-2 py-1.5 bg-muted/30 shrink-0">
              <div>
                <p className="text-[10px] font-medium leading-tight">Mirror left &amp; right panels</p>
                <p className="text-[10px] text-muted-foreground leading-tight">Flips pattern on one leg for symmetry</p>
              </div>
              <Switch id="mirror-legs" checked={mirrorLegs} onCheckedChange={setMirrorLegs} disabled={busy} />
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
