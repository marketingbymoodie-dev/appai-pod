/**
 * PatternCustomizer — AOP pattern/placement tool.
 *
 * Rendered as a solid overlay on top of the product canvas (absolute inset-0).
 *
 * Layout: tight 2-column grid
 *   Left  (40%) — motif thumbnail + live pattern preview canvas
 *   Right (60%) — all controls stacked compactly
 *
 * Four modes:
 *   • Pattern      — client-side Canvas tiling (instant, no server call)
 *   • Single Image — client-side Canvas placement with drag support
 *   • Place on Item — drag artwork onto a flat composite view of the garment panels;
 *                     the system crops the correct portion to each panel automatically.
 *                     Accent panels (sleeves, hood, cuffs, pockets, waistband) get a
 *                     user-chosen solid colour.
 *
 * Background removal is an optional separate step (dedicated button).
 * "Apply" is the only server call — generates the final high-res output.
 *
 * Preview model (Pattern mode):
 *   The preview canvas is a fixed 6×6 inch viewport into the final print.
 *   The SCALE slider (1–10) controls how many tiles appear across that 6-inch window.
 *     scale=1  → 1 tile fills the 6-inch window (large motif)
 *     scale=10 → 10 tiles across the 6-inch window (small, dense pattern)
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { API_BASE } from "@/lib/urlBase";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Loader2, LayoutGrid, ImageIcon, RotateCcw, Move } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type PatternType = "grid" | "brick" | "half";
export type EditorMode = "pattern" | "single" | "place";

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

/** Printify DPI for AOP panels */
const PRINT_DPI = 150;

// ── Panel group helpers ───────────────────────────────────────────────────────

/**
 * Classify a Printify position name into a display group.
 * Returns: "front" | "back" | "accent"
 */
function getPanelGroup(position: string): "front" | "back" | "accent" {
  const p = position.toLowerCase();
  if (p.includes("front") || p === "left_leg" || p === "right_leg") return "front";
  if (p.includes("back") || p === "back_side" || p === "backside") return "back";
  return "accent";
}

/**
 * Given a list of panel positions, build the composite canvas layout for a view.
 * Returns an array of { position, x, y, w, h } in composite-canvas coordinates.
 * The composite canvas dimensions are also returned.
 *
 * For "front" view: pairs front_left + front_right side-by-side (or left_leg + right_leg).
 * For "back" view: the back panel centred.
 */
function buildCompositeLayout(
  panels: { position: string; width: number; height: number }[],
  view: "front" | "back"
): {
  compositeW: number;
  compositeH: number;
  slots: { position: string; x: number; y: number; w: number; h: number }[];
} {
  const viewPanels = panels.filter(p => getPanelGroup(p.position) === view);
  if (viewPanels.length === 0) {
    return { compositeW: 1, compositeH: 1, slots: [] };
  }

  // Sort: "left" / "right" pairs — left first
  const sorted = [...viewPanels].sort((a, b) => {
    const aL = a.position.includes("left") || a.position.includes("_l") ? 0 : 1;
    const bL = b.position.includes("left") || b.position.includes("_l") ? 0 : 1;
    return aL - bL;
  });

  // Place panels side-by-side
  let x = 0;
  const maxH = Math.max(...sorted.map(p => p.height));
  const slots = sorted.map(p => {
    const slot = { position: p.position, x, y: 0, w: p.width, h: p.height };
    x += p.width;
    return slot;
  });

  return { compositeW: x, compositeH: maxH, slots };
}

export interface PatternApplyOptions {
  mirrorLegs: boolean;
  mode: EditorMode;
  singleTransform?: { scale: number; rotation: number; posX: number; posY: number };
  /** Per-panel canvases — one per Printify placeholder position */
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

  const [tilesAcross, setTilesAcross] = useState<number>(initialTilesAcross);

  const [singleScale,    setSingleScale]    = useState(1.0);
  const [singleRotation, setSingleRotation] = useState(0);
  const [singlePosX,     setSinglePosX]     = useState(0);
  const [singlePosY,     setSinglePosY]     = useState(0);

  // Place on Item state
  const [placeView,    setPlaceView]    = useState<"front" | "back">("front");
  // Artwork placement on the composite canvas (in composite-canvas pixel coords)
  const [placeX,       setPlaceX]       = useState(0);   // centre X of artwork on composite
  const [placeY,       setPlaceY]       = useState(0);   // centre Y of artwork on composite
  const [placeScale,   setPlaceScale]   = useState(1.0); // scale relative to composite width
  // Accent panel colour (sleeves, hood, cuffs, pockets, waistband)
  const [accentColor,  setAccentColor]  = useState("#ffffff");
  // Whether back panel uses same placement as front or its own
  const [backPlaceX,   setBackPlaceX]   = useState(0);
  const [backPlaceY,   setBackPlaceY]   = useState(0);
  const [backPlaceScale, setBackPlaceScale] = useState(1.0);
  const [backSameAsFront, setBackSameAsFront] = useState(false);

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
  const placeCanvasRef   = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const placeDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
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

  // Live pattern canvas
  useEffect(() => {
    if (mode !== "pattern" || !motifLoaded || !motifImgRef.current) return;
    const canvas = patternCanvasRef.current;
    if (!canvas) return;
    drawTiledPattern(canvas, motifImgRef.current, { pattern, tileW: previewTileW, bgColor });
  }, [mode, motifLoaded, pattern, tilesAcross, bgColor, previewTileW]);

  // Notify parent of settings changes
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

  // ── Place on Item: composite layout ───────────────────────────────────────
  const frontLayout = buildCompositeLayout(panelPositions, "front");
  const backLayout  = buildCompositeLayout(panelPositions, "back");
  const currentLayout = placeView === "front" ? frontLayout : backLayout;
  const currentPlaceX = placeView === "front" ? placeX : (backSameAsFront ? placeX : backPlaceX);
  const currentPlaceY = placeView === "front" ? placeY : (backSameAsFront ? placeY : backPlaceY);
  const currentPlaceScale = placeView === "front" ? placeScale : (backSameAsFront ? placeScale : backPlaceScale);

  const setCurrentPlace = (x: number, y: number) => {
    if (placeView === "front") { setPlaceX(x); setPlaceY(y); }
    else if (!backSameAsFront) { setBackPlaceX(x); setBackPlaceY(y); }
  };

  // Initialise placement to centre of composite when layout changes
  useEffect(() => {
    if (frontLayout.compositeW > 1) {
      setPlaceX(frontLayout.compositeW / 2);
      setPlaceY(frontLayout.compositeH / 2);
    }
  }, [frontLayout.compositeW, frontLayout.compositeH]);
  useEffect(() => {
    if (backLayout.compositeW > 1) {
      setBackPlaceX(backLayout.compositeW / 2);
      setBackPlaceY(backLayout.compositeH / 2);
    }
  }, [backLayout.compositeW, backLayout.compositeH]);

  // Live Place on Item canvas
  useEffect(() => {
    if (mode !== "place" || !motifLoaded || !motifImgRef.current) return;
    const canvas = placeCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const layout = currentLayout;
    if (layout.compositeW <= 1) return;

    // Scale layout to preview canvas size
    const scaleToPreview = PREVIEW_PX / layout.compositeW;
    const previewH = Math.round(layout.compositeH * scaleToPreview);

    canvas.width  = PREVIEW_PX;
    canvas.height = Math.max(previewH, 40);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Checkerboard background
    const sz = 8;
    for (let y = 0; y < canvas.height; y += sz)
      for (let x = 0; x < canvas.width; x += sz) {
        ctx.fillStyle = ((x / sz + y / sz) % 2 === 0) ? "#e5e7eb" : "#f9fafb";
        ctx.fillRect(x, y, sz, sz);
      }

    // Draw panel outlines with background fill
    for (const slot of layout.slots) {
      const sx = slot.x * scaleToPreview;
      const sy = slot.y * scaleToPreview;
      const sw = slot.w * scaleToPreview;
      const sh = slot.h * scaleToPreview;
      if (bgColor) { ctx.fillStyle = bgColor; ctx.fillRect(sx, sy, sw, sh); }
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
      // Panel label
      ctx.fillStyle = "rgba(100,116,139,0.7)";
      ctx.font = "8px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(slot.position.replace(/_/g, " "), sx + sw / 2, sy + 12);
    }

    // Draw seam lines between adjacent panels
    const xs = new Set(layout.slots.map(s => s.x).filter(x => x > 0));
    xs.forEach(x => {
      const px = x * scaleToPreview;
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(239,68,68,0.6)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0); ctx.lineTo(px, canvas.height);
      ctx.stroke();
      ctx.restore();
    });

    // Draw artwork
    const img = motifImgRef.current;
    const artW = img.width * currentPlaceScale * scaleToPreview;
    const artH = img.height * currentPlaceScale * scaleToPreview;
    const artX = currentPlaceX * scaleToPreview - artW / 2;
    const artY = currentPlaceY * scaleToPreview - artH / 2;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(img, artX, artY, artW, artH);
    ctx.globalAlpha = 1;

    // Artwork bounding box
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.strokeRect(artX, artY, artW, artH);
    ctx.setLineDash([]);

  }, [mode, motifLoaded, placeView, currentLayout, currentPlaceX, currentPlaceY, currentPlaceScale, bgColor]);

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

  // Drag handlers for Place on Item mode
  const handlePlaceMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    placeDragRef.current = {
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      origX: currentPlaceX,
      origY: currentPlaceY,
    };
  }, [currentPlaceX, currentPlaceY]);

  const handlePlaceMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!placeDragRef.current || !placeCanvasRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const layout = currentLayout;
    const scaleToPreview = PREVIEW_PX / layout.compositeW;
    const dx = (e.clientX - rect.left - placeDragRef.current.startX) / scaleToPreview;
    const dy = (e.clientY - rect.top  - placeDragRef.current.startY) / scaleToPreview;
    setCurrentPlace(
      placeDragRef.current.origX + dx,
      placeDragRef.current.origY + dy,
    );
  }, [currentLayout, placeView, backSameAsFront, currentPlaceX, currentPlaceY]);

  const handlePlaceMouseUp = useCallback(() => { placeDragRef.current = null; }, []);

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

  // ── Apply ──────────────────────────────────────────────────────────────────
  const handleApply = async () => {
    setIsApplying(true); setError(null);
    try {
      if (!motifImgRef.current || !motifLoaded) {
        throw new Error("Motif image not loaded yet — please wait a moment and try again");
      }
      const img = motifImgRef.current;

      // ── Single image mode ──────────────────────────────────────────────────
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

      // ── Place on Item mode ─────────────────────────────────────────────────
      //
      // For each panel:
      //   - Front/back panels: crop the artwork at the panel's position within the composite
      //   - Accent panels: fill with accentColor solid colour
      //
      if (mode === "place") {
        const panels: { position: string; width: number; height: number }[] =
          panelPositions.length > 0
            ? panelPositions
            : [{ position: "default", width: productWidth, height: productHeight }];

        const panelUrls: { position: string; dataUrl: string }[] = [];
        let primaryDataUrl = "";

        for (const panel of panels) {
          const group = getPanelGroup(panel.position);
          const W = panel.width;
          const H = panel.height;
          const canvas = document.createElement("canvas");
          canvas.width = W; canvas.height = H;
          const ctx = canvas.getContext("2d")!;

          if (group === "accent") {
            // Solid accent colour
            ctx.fillStyle = accentColor || "#ffffff";
            ctx.fillRect(0, 0, W, H);
          } else {
            // Determine which layout this panel belongs to
            const layout = group === "front" ? frontLayout : backLayout;
            const useX = group === "front" ? placeX : (backSameAsFront ? placeX : backPlaceX);
            const useY = group === "front" ? placeY : (backSameAsFront ? placeY : backPlaceY);
            const useScale = group === "front" ? placeScale : (backSameAsFront ? placeScale : backPlaceScale);

            // Find this panel's slot in the composite
            const slot = layout.slots.find(s => s.position === panel.position);
            if (!slot) {
              // Panel not in layout — fill with bg colour
              if (bgColor) { ctx.fillStyle = bgColor; ctx.fillRect(0, 0, W, H); }
            } else {
              // Fill background
              if (bgColor) { ctx.fillStyle = bgColor; ctx.fillRect(0, 0, W, H); }

              // The artwork is placed at (useX, useY) in composite coords with scale useScale.
              // The artwork's pixel size in composite coords:
              const artW = img.width * useScale;
              const artH = img.height * useScale;
              // Top-left of artwork in composite coords:
              const artLeft = useX - artW / 2;
              const artTop  = useY - artH / 2;

              // This panel occupies [slot.x .. slot.x + slot.w] × [slot.y .. slot.y + slot.h]
              // in composite coords. We need to draw the portion of the artwork that falls
              // within this panel's area, offset by the panel's position in the composite.
              //
              // Artwork position relative to this panel's top-left:
              const relX = artLeft - slot.x;
              const relY = artTop  - slot.y;

              ctx.drawImage(img, relX, relY, artW, artH);
            }
          }

          const dataUrl = canvas.toDataURL("image/png");
          panelUrls.push({ position: panel.position, dataUrl });
          if (!primaryDataUrl) primaryDataUrl = dataUrl;
        }

        await onApply(primaryDataUrl, { mirrorLegs, mode, panelUrls });
        return;
      }

      // ── Pattern mode: per-panel canvases ────────────────────────────────────
      const panels: { position: string; width: number; height: number }[] =
        panelPositions.length > 0
          ? panelPositions
          : [{ position: "default", width: productWidth, height: productHeight }];

      const panelUrls: { position: string; dataUrl: string }[] = [];
      let primaryDataUrl = "";

      for (const panel of panels) {
        const W = panel.width;
        const H = panel.height;
        const panelWidthIn = panel.width / PRINT_DPI;
        const totalTilesAcrossPanel = tilesPerInch * panelWidthIn;
        const panelTileW = W / totalTilesAcrossPanel;

        const canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        drawTiledPattern(canvas, img, { pattern, tileW: panelTileW, bgColor, forExport: true });
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
          {([["pattern", LayoutGrid, "Pattern"], ["single", ImageIcon, "Single Image"], ["place", Move, "Place on Item"]] as const).map(([m, Icon, label]) => (
            <button
              key={m} type="button"
              onClick={() => setMode(m as EditorMode)}
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

          {/* Live preview canvas */}
          <div className="flex-1 min-h-0">
            <p className="text-[10px] text-muted-foreground text-center mb-0.5">
              {mode === "single" ? "Drag to reposition" : mode === "place" ? "Drag artwork to position" : "6\u2033 \u00d7 6\u2033 preview"}
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
              {mode === "place" && (
                motifLoaded ? (
                  <canvas
                    ref={placeCanvasRef}
                    width={PREVIEW_PX}
                    height={currentLayout.compositeH > 1
                      ? Math.round(currentLayout.compositeH * (PREVIEW_PX / currentLayout.compositeW))
                      : PREVIEW_PX}
                    className="w-full h-full"
                    style={{ cursor: "grab", display: "block" }}
                    onMouseDown={handlePlaceMouseDown}
                    onMouseMove={handlePlaceMouseMove}
                    onMouseUp={handlePlaceMouseUp}
                    onMouseLeave={handlePlaceMouseUp}
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
        <div className="flex flex-col gap-2 flex-1 min-w-0 overflow-y-auto">

          {/* Remove BG */}
          <div className="flex items-center gap-2 rounded border px-2 py-1.5 bg-muted/30 shrink-0">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-medium leading-tight">
                {bgRemovedUrl ? "✓ Background removed" : "Remove AI background"}
              </p>
              {bgRemoveError && <p className="text-[10px] text-destructive leading-tight">{bgRemoveError}</p>}
            </div>
            {bgRemovedUrl ? (
              <button type="button" onClick={() => setBgRemovedUrl(null)}
                className="text-[10px] text-muted-foreground hover:text-foreground underline shrink-0">
                Undo
              </button>
            ) : (
              <Button size="sm" variant="outline"
                onClick={handleRemoveBg} disabled={isRemovingBg || busy}
                className="h-6 text-[10px] px-2 shrink-0">
                {isRemovingBg ? <Loader2 className="h-3 w-3 animate-spin" /> : <><ImageIcon className="h-3 w-3 mr-1" />Remove BG</>}
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

          {/* Place on Item mode controls */}
          {mode === "place" && (
            <>
              {/* Front / Back view tabs */}
              {(frontLayout.slots.length > 0 || backLayout.slots.length > 0) && (
                <div className="shrink-0 space-y-0.5">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">View</Label>
                  <div className="flex gap-1 rounded-md border p-0.5 bg-muted">
                    {(["front", "back"] as const).filter(v =>
                      v === "front" ? frontLayout.slots.length > 0 : backLayout.slots.length > 0
                    ).map(v => (
                      <button
                        key={v} type="button"
                        onClick={() => setPlaceView(v)}
                        className={`flex-1 py-1 rounded text-xs transition-colors capitalize ${
                          placeView === v ? "bg-background shadow text-foreground font-medium" : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Back same as front toggle */}
              {placeView === "back" && backLayout.slots.length > 0 && (
                <div className="flex items-center justify-between rounded border px-2 py-1.5 bg-muted/30 shrink-0">
                  <p className="text-[10px] font-medium leading-tight">Same placement as front</p>
                  <Switch
                    checked={backSameAsFront}
                    onCheckedChange={setBackSameAsFront}
                    className="data-[state=checked]:bg-black data-[state=unchecked]:bg-gray-400 [&_span]:bg-white"
                  />
                </div>
              )}

              {/* Artwork scale slider */}
              <div className="shrink-0 space-y-0.5">
                <div className="flex justify-between items-center">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Artwork size</Label>
                  <span className="text-[10px] text-muted-foreground tabular-nums">{currentPlaceScale.toFixed(2)}×</span>
                </div>
                <Slider
                  min={0.05} max={3} step={0.01}
                  value={[currentPlaceScale]}
                  onValueChange={([v]) => {
                    if (placeView === "front") setPlaceScale(v);
                    else if (!backSameAsFront) setBackPlaceScale(v);
                  }}
                  className="py-0 [&_[role=slider]]:bg-black [&_[role=slider]]:border-black [&_[role=slider]]:w-4 [&_[role=slider]]:h-4"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>Smaller</span><span>Larger</span>
                </div>
              </div>

              <p className="text-[10px] text-muted-foreground leading-tight shrink-0">
                Drag the artwork in the preview to reposition it across the panels. Red dashed lines show seams.
              </p>

              {/* Accent panel colour */}
              {panelPositions.some(p => getPanelGroup(p.position) === "accent") && (
                <div className="shrink-0 space-y-1 rounded border px-2 py-2 bg-muted/20">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Accent panels colour</Label>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    Sleeves, hood, cuffs, pockets &amp; waistband
                  </p>
                  <div className="flex flex-wrap gap-1.5 items-center mt-1">
                    {BG_PRESETS.filter(p => p.value !== "").map((preset) => (
                      <button
                        key={preset.value} type="button" title={preset.label}
                        onClick={() => setAccentColor(preset.value)}
                        className="w-5 h-5 rounded-full border flex-shrink-0 transition-transform hover:scale-110"
                        style={{
                          backgroundColor: preset.value,
                          borderColor: accentColor === preset.value ? "#111827" : "#d1d5db",
                          outline: accentColor === preset.value ? "2px solid #111827" : "none",
                          outlineOffset: "2px",
                        }}
                      />
                    ))}
                    <input type="color" value={accentColor}
                      onChange={(e) => setAccentColor(e.target.value)}
                      className="w-5 h-5 rounded cursor-pointer border border-gray-300"
                      title="Custom accent colour"
                    />
                  </div>
                </div>
              )}

              <button type="button"
                onClick={() => {
                  if (placeView === "front") {
                    setPlaceX(frontLayout.compositeW / 2);
                    setPlaceY(frontLayout.compositeH / 2);
                    setPlaceScale(1);
                  } else {
                    setBackPlaceX(backLayout.compositeW / 2);
                    setBackPlaceY(backLayout.compositeH / 2);
                    setBackPlaceScale(1);
                  }
                }}
                disabled={busy}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground shrink-0">
                <RotateCcw className="h-2.5 w-2.5" />Reset placement
              </button>
            </>
          )}

          {/* Background colour (Pattern + Single Image modes) */}
          {mode !== "place" && (
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
          )}

          {/* Background colour for Place on Item mode (panel background) */}
          {mode === "place" && (
            <div className="shrink-0 space-y-1">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Panel background</Label>
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
          )}

          {/* Mirror toggle (Pattern + Single Image modes only, paired panels only) */}
          {hasPairedPanels && mode !== "place" && (
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

          {/* Error */}
          {error && <p className="text-[10px] text-destructive shrink-0">{error}</p>}

          {/* Apply button */}
          <Button size="sm" onClick={handleApply} disabled={busy} className="w-full h-8 shrink-0">
            {isApplying ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Generating…</>
            ) : isLoading ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Applying…</>
            ) : (
              mode === "single" ? "Apply to Product" : mode === "place" ? "Apply Placement" : "Apply Pattern"
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
