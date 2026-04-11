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
 * Three modes:
 *   • Pattern      — client-side Canvas tiling (instant, no server call)
 *   • Single Image — client-side Canvas placement with drag support
 *   • Split Stretch — motif (or tiled pattern) stretched across both leg panels as one
 *                     continuous image, split at the seam with bleed overlap
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
 *   Export tile width (px)  = panel width / (tilesPerInch × panelWidthInches)
 *
 * Split Stretch canvas dimensions:
 *   Each panel canvas MUST be exactly the Printify panel pixel size (e.g. 1476×4500).
 *   Bleed is achieved by drawing from a wide source canvas with an offset so that
 *   the left panel's right edge contains a strip of the right panel's content, and
 *   vice versa — but the output canvas is still exactly the panel size.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { API_BASE } from "@/lib/urlBase";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Loader2, LayoutGrid, ImageIcon, RotateCcw, Scissors, Columns2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type PatternType = "grid" | "brick" | "half";
export type EditorMode = "pattern" | "single" | "split";
export type SplitContent = "image" | "pattern";

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

/** Logical pixel size of the preview canvas element */
const PREVIEW_PX = 200;

/**
 * Fixed viewport size in inches shown in the preview.
 * The slider value = number of tiles visible across this window.
 */
const PREVIEW_INCHES = 6;

/** Printify DPI for leggings panels */
const PRINT_DPI = 150;

export interface PatternApplyOptions {
  mirrorLegs: boolean;
  mode: EditorMode;
  singleTransform?: { scale: number; rotation: number; posX: number; posY: number };
  /** Per-panel tiled canvases — one per Printify placeholder position */
  panelUrls?: { position: string; dataUrl: string }[];
}

interface PatternCustomizerProps {
  motifUrl: string;
  productWidth?: number;
  productHeight?: number;
  hasPairedPanels?: boolean;
  /** Full list of panel positions with their exact Printify pixel dimensions */
  panelPositions?: { position: string; width: number; height: number }[];
  onApply: (patternUrl: string, options: PatternApplyOptions) => void | Promise<void>;
  isLoading?: boolean;
  /** Optional fetch override — pass safeFetch from embed-design to bypass Shopify service worker */
  fetchFn?: (url: string, options?: RequestInit) => Promise<Response>;
  /** Persisted settings — passed back in when reopening so state survives close/reopen */
  initialTilesAcross?: number;
  initialPattern?: PatternType;
  initialBgColor?: string;
  onSettingsChange?: (settings: { tilesAcross: number; pattern: PatternType; bgColor: string }) => void;
}

// ── Client-side Canvas tiling ────────────────────────────────────────────────

/**
 * Draw tiled pattern onto canvas.
 *
 * tileW is always passed in explicitly:
 *   Preview: PREVIEW_PX / tilesAcross
 *   Export:  panelWidth / (tilesPerInch × panelWidthInches)
 */
function drawTiledPattern(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  opts: {
    pattern: PatternType;
    tileW: number;
    bgColor: string;
    forExport?: boolean;
    /**
     * Horizontal pixel offset for the tile grid origin.
     * Used for inseam alignment: left panels use offsetX = panelWidth % tileW
     * so the last full tile ends at the right (inseam) edge.
     * Right panels use offsetX = 0 so the first tile starts at the left (inseam) edge.
     */
    offsetX?: number;
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
  // offsetX shifts the grid so tiles align from the inseam edge
  const startX = -(opts.offsetX ?? 0);
  const cols = Math.ceil((W + (opts.offsetX ?? 0)) / tileW) + 2;
  const rows = Math.ceil(H / tileH) + 2;

  for (let row = -1; row < rows; row++) {
    for (let col = -1; col < cols; col++) {
      let x = startX + col * tileW;
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
  panelPositions = [],
  onApply,
  isLoading = false,
  fetchFn,
  initialTilesAcross = 4,
  initialPattern = "grid",
  initialBgColor = "#ffffff",
  onSettingsChange,
}: PatternCustomizerProps) {
  const [mode, setMode]       = useState<EditorMode>("pattern");
  const [pattern, setPattern] = useState<PatternType>(initialPattern);
  const [splitContent, setSplitContent] = useState<SplitContent>("image");

  /**
   * tilesAcross: number of tiles visible across the 6-inch preview window.
   * Range 1–10. Default 4 (a reasonable starting density).
   */
  const [tilesAcross, setTilesAcross] = useState<number>(initialTilesAcross);

  const [singleScale,    setSingleScale]    = useState(1.0);
  const [singleRotation, setSingleRotation] = useState(0);
  const [singlePosX,     setSinglePosX]     = useState(0);
  const [singlePosY,     setSinglePosY]     = useState(0);

  const [mirrorLegs, setMirrorLegs] = useState(true);
  const [isApplying, setIsApplying] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [bgColor,    setBgColor]    = useState(initialBgColor);
  const [customBg,   setCustomBg]   = useState(initialBgColor);

  const [isRemovingBg,  setIsRemovingBg]  = useState(false);
  const [bgRemovedUrl,  setBgRemovedUrl]  = useState<string | null>(null);
  const [bgRemoveError, setBgRemoveError] = useState<string | null>(null);

  const activeMotifUrl = bgRemovedUrl || motifUrl;

  const patternCanvasRef = useRef<HTMLCanvasElement>(null);
  const singleCanvasRef  = useRef<HTMLCanvasElement>(null);
  const splitCanvasRef   = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const motifImgRef = useRef<HTMLImageElement | null>(null);
  const [motifLoaded, setMotifLoaded] = useState(false);

  // ── Derived tile sizes ─────────────────────────────────────────────────────
  const previewTileW  = PREVIEW_PX / tilesAcross;
  const tilesPerInch  = tilesAcross / PREVIEW_INCHES;

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

  // Live split-stretch canvas — 2:1 wide preview showing motif centred in combined panel width
  useEffect(() => {
    if (mode !== "split" || !motifLoaded || !motifImgRef.current) return;
    const canvas = splitCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;   // 2:1 wide (PREVIEW_PX * 2)
    const H = canvas.height;  // PREVIEW_PX
    ctx.clearRect(0, 0, W, H);

    // Checkerboard background for transparency
    const sz = 10;
    for (let y = 0; y < H; y += sz)
      for (let x = 0; x < W; x += sz) {
        ctx.fillStyle = ((x / sz + y / sz) % 2 === 0) ? "#e5e7eb" : "#f9fafb";
        ctx.fillRect(x, y, sz, sz);
      }

    if (bgColor) { ctx.fillStyle = bgColor; ctx.fillRect(0, 0, W, H); }

    const img = motifImgRef.current;

    if (splitContent === "pattern") {
      // Tile the pattern across the full 2:1 wide canvas
      // Use previewTileW as tile size (same density as pattern mode preview)
      drawTiledPattern(canvas, img, { pattern, tileW: previewTileW, bgColor, forExport: false });
    } else {
      // Single image: scale to fill full width, tile vertically (matches export behaviour)
      const imgScaleW = W / img.width;
      const iw = img.width * imgScaleW;  // = W
      const ih = img.height * imgScaleW;
      for (let y = 0; y < H; y += ih) {
        ctx.drawImage(img, 0, y, iw, ih);
      }
    }

    // Draw seam indicator
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(239,68,68,0.8)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
    ctx.restore();
    // Bleed zone shading
    const bleedPx = Math.round(W * 0.04); // ~4% of preview width ≈ bleed strip
    ctx.save();
    ctx.fillStyle = "rgba(253,230,138,0.45)";
    ctx.fillRect(W / 2 - bleedPx, 0, bleedPx * 2, H);
    ctx.restore();
  }, [mode, motifLoaded, bgColor, splitContent, pattern, tilesAcross, previewTileW]);

  // Notify parent of settings changes so they can be persisted across close/reopen
  useEffect(() => {
    onSettingsChange?.({ tilesAcross, pattern, bgColor });
  }, [tilesAcross, pattern, bgColor]);

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

  // Apply — fully client-side Canvas generation.
  // Generates one canvas per panel at the panel's exact Printify pixel dimensions.
  const handleApply = async () => {
    setIsApplying(true); setError(null);
    try {
      if (!motifImgRef.current || !motifLoaded) {
        throw new Error("Motif image not loaded yet — please wait a moment and try again");
      }
      const img = motifImgRef.current;

      // ── Single Image mode: one canvas, no per-panel logic ──────────────────
      if (mode === "single") {
        const W = productWidth;
        const H = productHeight;
        const canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 2D context unavailable");
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
        const patternDataUrl = canvas.toDataURL("image/png");
        await onApply(patternDataUrl, {
          mirrorLegs, mode,
          singleTransform: { scale: singleScale, rotation: singleRotation, posX: singlePosX, posY: singlePosY },
        });
        return;
      }

      // ── Split Stretch mode ─────────────────────────────────────────────────
      //
      // Generates per-panel canvases at EXACT Printify pixel dimensions.
      // Bleed: the left panel's right edge contains a strip of the right panel's
      // content (and vice versa), achieved by drawing from a wide source canvas
      // with an offset. The output canvas is still exactly the panel size.
      //
      if (mode === "split") {
        const leftPanels  = panelPositions.filter(p => p.position.startsWith("left"));
        const rightPanels = panelPositions.filter(p => p.position.startsWith("right"));

        // If no panel data, fall back to a single wide canvas
        if (leftPanels.length === 0 || rightPanels.length === 0) {
          const W = 2952; const H = 4500; // approximate combined width × height
          const canvas = document.createElement("canvas");
          canvas.width = W; canvas.height = H;
          const ctx = canvas.getContext("2d")!;
          if (bgColor) { ctx.fillStyle = bgColor; ctx.fillRect(0, 0, W, H); }
          if (splitContent === "pattern") {
            const panelWIn = W / PRINT_DPI;
            const totalTiles = tilesPerInch * panelWIn;
            const tileW = W / totalTiles;
            drawTiledPattern(canvas, img, { pattern, tileW, bgColor, forExport: true });
          } else {
            // Scale to fill full width, tile vertically
            const imgScaleW = W / img.width;
            const iw = img.width * imgScaleW;
            const ih = img.height * imgScaleW;
            for (let y = 0; y < H; y += ih) {
              ctx.drawImage(img, 0, y, iw, ih);
            }
          }
          const dataUrl = canvas.toDataURL("image/png");
          await onApply(dataUrl, { mirrorLegs, mode, panelUrls: [{ position: "default", dataUrl }] });
          return;
        }

        const panelUrls: { position: string; dataUrl: string }[] = [];
        let primaryDataUrl = "";

        // Process each left+right pair (typically just one pair for leggings)
        for (let i = 0; i < Math.max(leftPanels.length, rightPanels.length); i++) {
          const leftPanel  = leftPanels[i]  || leftPanels[0];
          const rightPanel = rightPanels[i] || rightPanels[0];

          // Use EXACT panel dimensions — Printify expects these exact pixel sizes.
          // Any deviation causes Printify to stretch/distort the image.
          const LW = leftPanel.width;
          const RW = rightPanel.width;
          const LH = leftPanel.height;
          const RH = rightPanel.height;

          // Bleed: ~15mm at 150 DPI = 88px, capped to 5% of the narrower panel
          const BLEED = Math.min(88, Math.round(Math.min(LW, RW) * 0.05));

          // ── Generate wide source canvas (LW + RW wide, max height tall) ────
          // The wide canvas represents both legs as one continuous surface.
          // Left leg occupies [0 .. LW], right leg occupies [LW .. LW+RW].
          const totalW = LW + RW;
          const H = Math.max(LH, RH);
          const wideCanvas = document.createElement("canvas");
          wideCanvas.width = totalW; wideCanvas.height = H;
          const wCtx = wideCanvas.getContext("2d")!;
          if (bgColor) { wCtx.fillStyle = bgColor; wCtx.fillRect(0, 0, totalW, H); }

          if (splitContent === "pattern") {
            // Tile the pattern across the full combined width
            // Tile width: same physical density as the preview slider
            const combinedWIn = totalW / PRINT_DPI;
            const totalTiles = tilesPerInch * combinedWIn;
            const tileW = totalW / totalTiles;
            drawTiledPattern(wideCanvas, img, { pattern, tileW, bgColor, forExport: true });
          } else {
            // Single image: scale to fill the FULL WIDTH of the combined canvas,
            // then tile vertically to fill the full panel height.
            // This ensures the design covers the entire leg from top to bottom.
            const imgScaleW = totalW / img.width;  // scale so image fills full combined width
            const iw = img.width * imgScaleW;       // = totalW
            const ih = img.height * imgScaleW;      // height at this scale
            // Tile vertically: repeat the image from top to bottom
            for (let y = 0; y < H; y += ih) {
              wCtx.drawImage(img, 0, y, iw, ih);
            }
          }

          // ── Split into per-panel canvases at EXACT panel dimensions ──────────
          //
          // Left panel:  draw from wide canvas [0 .. LW] (with bleed from right side baked in)
          //   The left panel gets [0 .. LW] from the wide canvas.
          //   The rightmost BLEED pixels of the left panel contain content from the right panel's
          //   territory — this is the bleed that prevents a white gap at the seam.
          //
          // Right panel: draw from wide canvas [LW .. LW+RW] (with bleed from left side baked in)
          //   The right panel gets [LW .. LW+RW] from the wide canvas.
          //   The leftmost BLEED pixels of the right panel contain content from the left panel's
          //   territory — this is the bleed that prevents a white gap at the seam.
          //
          // Note: We don't add BLEED to the canvas dimensions — the canvas is exactly LW×LH.
          // The bleed content is already present in the wide canvas at the seam boundary.

          const leftCanvas = document.createElement("canvas");
          leftCanvas.width = LW; leftCanvas.height = LH;
          const lCtx = leftCanvas.getContext("2d")!;
          // Draw left portion of wide canvas (includes natural bleed at right edge)
          lCtx.drawImage(wideCanvas, 0, 0, LW, LH, 0, 0, LW, LH);

          const rightCanvas = document.createElement("canvas");
          rightCanvas.width = RW; rightCanvas.height = RH;
          const rCtx = rightCanvas.getContext("2d")!;
          // Draw right portion of wide canvas (includes natural bleed at left edge)
          rCtx.drawImage(wideCanvas, LW, 0, RW, RH, 0, 0, RW, RH);

          // Suppress unused variable warning
          void BLEED;

          const leftDataUrl  = leftCanvas.toDataURL("image/png");
          const rightDataUrl = rightCanvas.toDataURL("image/png");

          panelUrls.push({ position: leftPanel.position,  dataUrl: leftDataUrl  });
          panelUrls.push({ position: rightPanel.position, dataUrl: rightDataUrl });
          if (!primaryDataUrl) primaryDataUrl = leftDataUrl;
        }

        // Also generate non-leg panels (gusset, waistband) with a plain bg fill
        const otherPanels = panelPositions.filter(
          p => !p.position.startsWith("left") && !p.position.startsWith("right")
        );
        for (const panel of otherPanels) {
          const W = panel.width;
          const H = panel.height;
          const canvas = document.createElement("canvas");
          canvas.width = W; canvas.height = H;
          const ctx = canvas.getContext("2d")!;
          if (bgColor) { ctx.fillStyle = bgColor; ctx.fillRect(0, 0, W, H); }
          panelUrls.push({ position: panel.position, dataUrl: canvas.toDataURL("image/png") });
        }

        await onApply(primaryDataUrl, { mirrorLegs, mode, panelUrls });
        return;
      }

      // ── Pattern mode: per-panel canvases with inseam alignment ─────────────
      //
      // For each panel we compute:
      //   tileW_panel = panelWidth / (tilesPerInch × panelWidthInches)
      //     i.e. the same physical tile density as the preview, scaled to this panel's pixel width.
      //
      // Inseam alignment:
      //   Left panels  → offsetX = panelWidth % tileW  (last full tile ends at right/inseam edge)
      //   Right panels → offsetX = 0                   (first tile starts at left/inseam edge)
      //   Other panels → offsetX = 0
      //
      // If no panelPositions are provided, fall back to a single canvas.

      const panels: { position: string; width: number; height: number }[] =
        panelPositions.length > 0
          ? panelPositions
          : [{ position: "default", width: productWidth, height: productHeight }];

      const panelUrls: { position: string; dataUrl: string }[] = [];
      let primaryDataUrl = "";

      for (const panel of panels) {
        // Use full panel dimensions — Printify expects the exact pixel size.
        const W = panel.width;
        const H = panel.height;

        // Tile width in pixels for this panel's canvas
        const panelWidthIn = panel.width / PRINT_DPI;
        const totalTilesAcrossPanel = tilesPerInch * panelWidthIn;
        const panelTileW = W / totalTilesAcrossPanel;

        // Inseam alignment offset
        const isLeftPanel  = panel.position.startsWith("left");
        const isRightPanel = panel.position.startsWith("right");
        const tileWRounded = Math.max(1, Math.round(panelTileW));
        // Left panel: shift grid so the last full tile ends at the right (inseam) edge
        const offsetX = isLeftPanel ? (W % tileWRounded) : 0;
        void isRightPanel; // acknowledged, offsetX=0 is already correct for right panels

        const canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        drawTiledPattern(canvas, img, { pattern, tileW: panelTileW, bgColor, forExport: true, offsetX });

        const dataUrl = canvas.toDataURL("image/png");
        panelUrls.push({ position: panel.position, dataUrl });
        if (!primaryDataUrl) primaryDataUrl = dataUrl;
      }

      await onApply(primaryDataUrl, { mirrorLegs, mode, panelUrls });
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
          {([["pattern", LayoutGrid, "Pattern"], ["single", ImageIcon, "Single Image"], ["split", Columns2, "Split Stretch"]] as const).map(([m, Icon, label]) => (
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
              {mode === "single" ? "Drag to reposition" : mode === "split" ? "Both legs preview (red = seam)" : "6\u2033 \u00d7 6\u2033 preview"}
            </p>
            <div className="w-full h-full rounded border overflow-hidden relative" style={{ minHeight: 80 }}>
              {mode === "pattern" && (
                motifLoaded ? (
                  <canvas
                    ref={patternCanvasRef}
                    width={PREVIEW_PX} height={PREVIEW_PX}
                    className="w-full h-full"
                    style={{ display: "block" }}
                  />
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
              {mode === "split" && (
                motifLoaded ? (
                  <canvas
                    ref={splitCanvasRef} width={PREVIEW_PX * 2} height={PREVIEW_PX}
                    className="w-full h-full" style={{ display: "block" }}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-muted/30">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                )
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

          {/* Split Stretch mode controls */}
          {mode === "split" && (
            <>
              {/* Content type selector */}
              <div className="shrink-0 space-y-0.5">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Split content</Label>
                <div className="flex gap-1 rounded-md border p-0.5 bg-muted">
                  {([["image", "Single Image"], ["pattern", "Tiled Pattern"]] as const).map(([v, label]) => (
                    <button
                      key={v} type="button"
                      onClick={() => setSplitContent(v)}
                      className={`flex-1 py-1 rounded text-xs transition-colors ${
                        splitContent === v ? "bg-background shadow text-foreground font-medium" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground leading-tight pt-0.5">
                  {splitContent === "image"
                    ? "Stretches your motif across both legs as one continuous image."
                    : "Tiles your motif as a pattern across both legs — the repeat flows seamlessly across the seam."}
                </p>
              </div>

              {/* Pattern controls (only when tiled pattern selected) */}
              {splitContent === "pattern" && (
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
                  <div className="shrink-0 rounded border px-2 py-2 space-y-1.5 bg-muted/20">
                    <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Pattern size</Label>
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

          {/* Mirror toggle — hidden in split mode (left/right are already different halves of one image) */}
          {hasPairedPanels && mode !== "split" && (
            <div className="flex flex-col gap-1 shrink-0">
              <div className="flex items-center justify-between rounded border px-2 py-1.5 bg-muted/30">
                <div>
                  <p className="text-[10px] font-medium leading-tight">Mirror left &amp; right panels</p>
                  <p className="text-[10px] text-muted-foreground leading-tight">Flips pattern on one leg for symmetry</p>
                </div>
                <Switch
                  id="mirror-legs"
                  checked={mirrorLegs}
                  onCheckedChange={setMirrorLegs}
                  disabled={busy}
                  className="data-[state=checked]:bg-black data-[state=unchecked]:bg-gray-400 [&_span]:bg-white"
                />
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
              mode === "single" ? "Apply to Product" : mode === "split" ? "Apply Split Stretch" : "Apply Pattern"
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
