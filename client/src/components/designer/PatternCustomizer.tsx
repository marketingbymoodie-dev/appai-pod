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
  { label: "Transparent", value: "transparent" },
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

/**
 * Default seam bleed in print pixels (~1 cm at 150 DPI).
 * Each split panel (front_right, front_left, right_hood, left_hood) gets this many
 * extra pixels of artwork past the seam edge so the artwork remains continuous
 * across the sewn seam even with slight manufacturing misalignment.
 * The user can adjust this via the "Seam offset" slider in Place on Item mode.
 */
const DEFAULT_SEAM_BLEED_PX = 70; // 70 px — tested on zip hoodie, best split across zipper

/**
 * Snap threshold in CSS pixels — if artwork centre is within this distance
 * of a snap point, snap to it.
 */
const SNAP_THRESHOLD_CSS = 8;

// ── SVG content source rects ─────────────────────────────────────────────────
//
// Each Printify sew-pattern SVG has a square viewBox, but the actual panel
// shape is offset within it. These rects define the exact sub-region of each
// SVG that contains the panel artwork, so we can use the 9-argument drawImage
// to crop it precisely and map it to the slot without any distortion or gaps.
//
// Verified by parsing the `color_background` rect from each SVG file.
// The aspect ratios match Printify's print dimensions exactly (within 0.01%).
//
// Special case: left_hood has a rotate(-180) transform in the SVG, meaning
// its content is upside-down. We flip it during canvas rendering.
//
const SVG_SOURCE_RECTS: Record<string, { x: number; y: number; w: number; h: number }> = {
  "left_leg":       { x: 0,     y: 0,     w: 1000, h: 1500 },
  "right_leg":      { x: 0,     y: 0,     w: 1000, h: 1500 },
  "front_left_leg": { x: 0,     y: 0,     w: 1000, h: 1500 },
  "front_right_leg":{ x: 0,     y: 0,     w: 1000, h: 1500 },
  "back_left_leg":  { x: 0,     y: 0,     w: 1000, h: 1500 },
  "back_right_leg": { x: 0,     y: 0,     w: 1000, h: 1500 },
};

/**
 * Map position names to SVG names.
 * Printify uses "left_side" / "right_side" in the API, but SVGs are named "left_leg" / "right_leg".
 */
function mapPositionToSvgName(position: string): string {
  const lower = position.toLowerCase();
  if (lower.includes("left_side") || lower === "left_side") return "left_leg";
  if (lower.includes("right_side") || lower === "right_side") return "right_leg";
  if (lower.includes("front_left")) return "front_left_leg";
  if (lower.includes("front_right")) return "front_right_leg";
  if (lower.includes("back_left")) return "back_left_leg";
  if (lower.includes("back_right")) return "back_right_leg";
  return position;
}

/**
 * Determine which composite view (front/back/hood) a panel belongs to.
 */
function getPanelGroup(position: string): "front" | "back" | "hood" {
  const lower = position.toLowerCase();
  if (lower.includes("hood")) return "hood";
  if (lower.includes("back")) return "back";
  return "front";
}

/**
 * Draw the clipped shape for a panel on the canvas.
 * For leggings, this is a simple rectangle.
 * For hoodies, this includes curved neckline and armholes.
 */
function drawPanelShape(
  ctx: CanvasRenderingContext2D,
  position: string,
  x: number,
  y: number,
  w: number,
  h: number
) {
  ctx.beginPath();

  if (position === "front" || position === "back") {
    // Front/back panel: neckline at top-centre, shoulder slopes, armhole cutouts both sides
    const neckDepth = h * 0.10;
    const neckW     = w * 0.30;  // half-width of neckline
    const shoulderH = h * 0.06;
    const armW      = w * 0.12;
    const armH      = h * 0.28;
    const armTop    = h * 0.06;
    ctx.moveTo(x, y + shoulderH);
    ctx.lineTo(x + w / 2 - neckW, y);
    ctx.bezierCurveTo(x + w / 2 - neckW * 0.3, y, x + w / 2, y + neckDepth, x + w / 2, y + neckDepth);
    ctx.bezierCurveTo(x + w / 2, y + neckDepth, x + w / 2 + neckW * 0.3, y, x + w / 2 + neckW, y);
    ctx.lineTo(x + w, y + shoulderH);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    // Left armhole cutout (going back up left side)
    ctx.lineTo(x, y + armTop + armH);
    ctx.bezierCurveTo(x, y + armTop + armH * 0.5, x + armW, y + armTop + armH * 0.3, x + armW, y + armTop + armH * 0.1);
    ctx.bezierCurveTo(x + armW, y + armTop, x, y + armTop, x, y + shoulderH);
    ctx.closePath();

  } else if (position.includes("leg") || position.includes("side")) {
    // Leggings: Use rectangular clipping to ensure perfect SVG alignment
    ctx.rect(x, y, w, h);
    ctx.closePath();

  } else if (position.includes("hood")) {
    // Hood panels: arch shape
    // Simplified for now, will need more precise paths for actual hood shapes
    ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
    ctx.closePath();

  } else {
    // Default: rectangular clip
    ctx.rect(x, y, w, h);
    ctx.closePath();
  }
}

// ── Composite layout builder ─────────────────────────────────────────────────

interface PanelSlot { position: string; x: number; y: number; w: number; h: number }

/**
 * Build the flat composite layout for a given view.
 * Returns: { compositeW, compositeH, slots }
 */
function buildCompositeLayout(
  view: "front" | "back" | "hood",
  panels: Array<{ position: string; width: number; height: number }>
): { compositeW: number; compositeH: number; slots: PanelSlot[] } {
  const viewPanels = panels.filter(p => getPanelGroup(p.position) === view);
  if (viewPanels.length === 0) {
    return { compositeW: 0, compositeH: 0, slots: [] };
  }

  const maxH = Math.max(...viewPanels.map(p => p.height));

  // For back view, "left" panel goes first (standard left-to-right reading order).
  const sorted = [...viewPanels].sort((a, b) => {
    const aIsLeft = a.position.toLowerCase().includes("left");
    const bIsLeft = b.position.toLowerCase().includes("left");
    if (view === "front" || view === "hood") {
      // right panel first (left side of composite = seam in centre)
      return aIsLeft ? 1 : -1;
    } else {
      // back: left panel first
      return aIsLeft ? -1 : 1;
    }
  });

  let x = 0;
  const slots: PanelSlot[] = [];
  for (const p of sorted) {
    slots.push({ position: p.position, x, y: 0, w: p.width, h: p.height });
    x += p.width + 40; // 40px gap
  }

  return {
    compositeW: x - 40,
    compositeH: maxH,
    slots,
  };
}

/**
 * Build a separate layout for leggings with each leg as an independent panel.
 * Returns: { leftLeg, rightLeg, gap }
 */
function buildLeggingsLayout(
  panels: Array<{ position: string; width: number; height: number }>
): { leftLeg: PanelSlot | null; rightLeg: PanelSlot | null; gap: number } {
  const leftPanel = panels.find(p => p.position.toLowerCase().includes("left"));
  const rightPanel = panels.find(p => p.position.toLowerCase().includes("right"));

  const gap = 40; // Gap between legs in pixels

  return {
    leftLeg: leftPanel ? { position: leftPanel.position, x: 0, y: 0, w: leftPanel.width, h: leftPanel.height } : null,
    rightLeg: rightPanel ? { position: rightPanel.position, x: leftPanel ? leftPanel.width + gap : 0, y: 0, w: rightPanel.width, h: rightPanel.height } : null,
    gap,
  };
}

// ── Main PatternCustomizer component ─────────────────────────────────────────

interface PatternCustomizerProps {
  motifUrl: string;
  productWidth?: number;
  productHeight?: number;
  hasPairedPanels?: boolean;
  panelPositions?: Array<{ position: string; width: number; height: number }>;
  panelFlatLayImages?: Record<string, string>;
  fetchFn?: (url: string, options?: any) => Promise<Response>;
  initialTilesAcross?: number;
  initialPattern?: PatternType;
  initialBgColor?: string;
  onSettingsChange?: (settings: any) => void;
  initialPlacement?: any;
  onPlacementChange?: (placement: any) => void;
  onApply: (result: any, options?: any) => void | Promise<void>;
  onCancel: () => void;
  productTypeConfig?: any; // Legacy prop, kept for backward compatibility
}

export function PatternCustomizer({
  motifUrl,
  productWidth,
  productHeight,
  hasPairedPanels,
  panelPositions,
  panelFlatLayImages,
  fetchFn,
  initialTilesAcross,
  initialPattern,
  initialBgColor,
  onSettingsChange,
  initialPlacement,
  onPlacementChange,
  onApply,
  onCancel,
  productTypeConfig,
}: PatternCustomizerProps) {
  // Use panelPositions as productTypeConfig for backward compatibility
  const config = productTypeConfig || { placeholderPositions: panelPositions || [] };
  const [mode, setMode] = useState<EditorMode>(initialPattern ? "pattern" : "pattern");
  const [patternType, setPatternType] = useState<PatternType>(initialPattern || "grid");
  const [scale, setScale] = useState(initialTilesAcross || 5);
  const [bgColor, setBgColor] = useState(initialBgColor || "");
  const [isLoading, setIsLoading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [motifImage, setMotifImage] = useState<HTMLImageElement | null>(null);
  const [panelSvgImages, setPanelSvgImages] = useState<{ [key: string]: HTMLImageElement }>({});
  const [dragOffset, setDragOffset] = useState(initialPlacement?.dragOffset || { x: 0, y: 0 });
  const [seamOffset, setSeamOffset] = useState(initialPlacement?.seamOffset || DEFAULT_SEAM_BLEED_PX);
  const [mirrorMode, setMirrorMode] = useState(initialPlacement?.mirrorMode || false);
  const [activeLeg, setActiveLeg] = useState<"left" | "right">(initialPlacement?.activeLeg || "right");
  const [showMockups, setShowMockups] = useState(false);

  // Load motif image
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => setMotifImage(img);
    img.onerror = () => console.error("Failed to load motif image");
    img.src = motifUrl;
  }, [motifUrl]);

  // Load SVG panel images from panelFlatLayImages
  useEffect(() => {
    if (!panelFlatLayImages) return;

    const loadSvgImages = async () => {
      const images: { [key: string]: HTMLImageElement } = {};
      for (const [name, url] of Object.entries(panelFlatLayImages)) {
        try {
          const img = new Image();
          img.crossOrigin = "anonymous";
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = url;
          });
          images[name] = img;
          console.log(`[PatternCustomizer] Loaded SVG: ${name}`);
        } catch (err) {
          console.warn(`[PatternCustomizer] Failed to load SVG ${name}:`, err);
        }
      }
      setPanelSvgImages(images);
    };

    loadSvgImages();
  }, [panelFlatLayImages]);

  // Draw the preview on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !motifImage) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = PREVIEW_PX;
    canvas.height = PREVIEW_PX;

    // Clear canvas
    ctx.fillStyle = bgColor || "transparent";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (mode === "pattern") {
      // Draw tiled pattern
      const tileSize = (PREVIEW_INCHES * 96) / scale; // 96 DPI for screen
      for (let row = 0; row < Math.ceil(PREVIEW_PX / tileSize) + 1; row++) {
        for (let col = 0; col < Math.ceil(PREVIEW_PX / tileSize) + 1; col++) {
          const x = col * tileSize;
          const y = row * tileSize;
          ctx.drawImage(motifImage, x, y, tileSize, tileSize);
        }
      }
    } else if (mode === "place" && hasPairedPanels && panelPositions) {
      // Draw leggings preview
      const layout = buildLeggingsLayout(panelPositions);
      const scale = Math.min(PREVIEW_PX / (layout.leftLeg?.w || 100 + layout.gap + layout.rightLeg?.w || 100), 1);
      const offsetX = (PREVIEW_PX - ((layout.leftLeg?.w || 0) + layout.gap + (layout.rightLeg?.w || 0)) * scale) / 2;
      const offsetY = (PREVIEW_PX - ((layout.leftLeg?.h || 0) * scale)) / 2;

      if (layout.leftLeg) drawLegPanel(ctx, layout.leftLeg, offsetX, offsetY, scale, motifImage, "left", panelSvgImages);
      if (layout.rightLeg) drawLegPanel(ctx, layout.rightLeg, offsetX, offsetY, scale, motifImage, "right", panelSvgImages);
    }
  }, [mode, scale, bgColor, motifImage, panelPositions, hasPairedPanels, dragOffset, mirrorMode, activeLeg, panelSvgImages]);

  const drawLegPanel = (
    ctx: CanvasRenderingContext2D,
    slot: PanelSlot,
    offsetX: number,
    offsetY: number,
    scale: number,
    img: HTMLImageElement,
    legSide: "left" | "right",
    svgImages?: { [key: string]: HTMLImageElement }
  ) => {
    const slotX = offsetX + slot.x * scale;
    const slotY = offsetY + slot.y * scale;
    const slotW = slot.w * scale;
    const slotH = slot.h * scale;

    // Draw panel shape
    ctx.save();
    drawPanelShape(ctx, slot.position, slotX, slotY, slotW, slotH);
    ctx.clip();

    // Draw SVG panel image (sew pattern) as background if available
    // Map the position to the SVG name (e.g., "left_side" -> "left_leg")
    const svgName = mapPositionToSvgName(slot.position);
    if (svgImages && svgImages[svgName]) {
      console.log(`[PatternCustomizer] Drawing SVG for ${slot.position} (mapped to ${svgName})`);
      ctx.drawImage(svgImages[svgName], slotX, slotY, slotW, slotH);
    } else {
      console.warn(`[PatternCustomizer] SVG image not available for ${slot.position} (mapped to ${svgName}). Available keys:`, Object.keys(svgImages || {}));
    }

    // Draw red border
    ctx.strokeStyle = "#ff0000";
    ctx.lineWidth = 2;
    ctx.strokeRect(slotX, slotY, slotW, slotH);

    // Determine which drag offset to use
    const currentDragOffset = activeLeg === legSide ? dragOffset : { x: 0, y: 0 };

    // Draw motif image
    const scale2 = Math.min(slotW / img.width, slotH / img.height);
    const w = img.width * scale2;
    const h = img.height * scale2;
    const x = slotX + (slotW - w) / 2 + currentDragOffset.x;
    const y = slotY + (slotH - h) / 2 + currentDragOffset.y;

    // Mirror left leg if needed
    if (legSide === "left" && mirrorMode) {
      ctx.save();
      ctx.translate(slotX + slotW / 2, 0);
      ctx.scale(-1, 1);
      ctx.translate(-(slotX + slotW / 2), 0);
      ctx.drawImage(img, x, y, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(img, x, y, w, h);
    }

    ctx.restore();
  };

  const drawSnapGuides = (
    ctx: CanvasRenderingContext2D,
    layout: any,
    offsetX: number,
    offsetY: number,
    scale: number,
    svgImages?: { [key: string]: HTMLImageElement }
  ) => {
    // Draw vertical centerline (seam)
    ctx.strokeStyle = "#ff0000";
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1;
    const centerX = offsetX + (layout.leftLeg?.w || 0) * scale + layout.gap * scale / 2;
    ctx.beginPath();
    ctx.moveTo(centerX, offsetY);
    ctx.lineTo(centerX, offsetY + (layout.leftLeg?.h || 0) * scale);
    ctx.stroke();

    // Draw horizontal crotch line
    const crotchY = offsetY + (layout.leftLeg?.h || 0) * scale * 0.7;
    ctx.beginPath();
    ctx.moveTo(offsetX, crotchY);
    ctx.lineTo(offsetX + ((layout.leftLeg?.w || 0) + layout.gap + (layout.rightLeg?.w || 0)) * scale, crotchY);
    ctx.stroke();

    ctx.setLineDash([]);
  };

  const handleApply = async () => {
    setIsLoading(true);
    try {
      const result = {
        mode,
        patternType,
        scale,
        bgColor,
        dragOffset,
        seamOffset,
        mirrorMode,
        activeLeg,
      };
      await onApply(result);
    } catch (err) {
      console.error("Apply failed:", err);
    } finally {
      setIsLoading(false);
    }
  };

  // Add mouse and touch drag support
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartOffset = { x: 0, y: 0 };

    // Mouse events
    const handleMouseDown = (e: MouseEvent) => {
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartOffset = { ...dragOffset };
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const deltaX = e.clientX - dragStartX;
      const deltaY = e.clientY - dragStartY;
      setDragOffset({
        x: dragStartOffset.x + deltaX,
        y: dragStartOffset.y + deltaY,
      });
    };

    const handleMouseUp = () => {
      isDragging = false;
    };

    // Touch events
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartOffset = { x: 0, y: 0 };

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchStartOffset = { ...dragOffset };
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      const deltaX = touch.clientX - touchStartX;
      const deltaY = touch.clientY - touchStartY;
      setDragOffset({
        x: touchStartOffset.x + deltaX,
        y: touchStartOffset.y + deltaY,
      });
    };

    canvas.addEventListener("mousedown", handleMouseDown);
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseup", handleMouseUp);
    canvas.addEventListener("mouseleave", handleMouseUp);
    canvas.addEventListener("touchstart", handleTouchStart, { passive: true });
    canvas.addEventListener("touchmove", handleTouchMove, { passive: true });

    return () => {
      canvas.removeEventListener("mousedown", handleMouseDown);
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseup", handleMouseUp);
      canvas.removeEventListener("mouseleave", handleMouseUp);
      canvas.removeEventListener("touchstart", handleTouchStart);
      canvas.removeEventListener("touchmove", handleTouchMove);
    };
  }, [dragOffset]);

  return (
    <div className="w-full">
      {!showMockups ? (
        // 3-column layout: Pattern preview | Controls | Product info
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4">
          {/* Left column: Pattern preview */}
          <div className="flex flex-col">
            <div className="aspect-square border border-gray-300 rounded bg-gray-50 flex items-center justify-center">
              <canvas
                ref={canvasRef}
                className="w-full h-full touch-none cursor-grab active:cursor-grabbing"
                style={{ touchAction: "none", display: "block" }}
              />
            </div>
          </div>

          {/* Middle column: Controls */}
          <div className="flex flex-col space-y-4 overflow-y-auto">
            <div>
              <Label>Mode</Label>
              <div className="flex gap-2">
                {(["pattern", "single", "place"] as EditorMode[]).map(m => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`px-3 py-1 rounded ${mode === m ? "bg-blue-500 text-white" : "bg-gray-200"}`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {mode === "pattern" && (
              <>
                <div>
                  <Label>Pattern Type</Label>
                  <Select value={patternType} onValueChange={v => setPatternType(v as PatternType)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PATTERN_OPTIONS.map(opt => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label>Scale: {scale}</Label>
                  <Slider 
                    value={[scale]} 
                    onValueChange={v => setScale(v[0])} 
                    min={1} 
                    max={10}
                    className="[&_[role=slider]]:bg-black [&_[role=slider]]:border-2 [&_[role=slider]]:border-black"
                  />
                </div>
              </>
            )}

            {mode === "place" && (
              <>
                <div>
                  <Label>Seam Offset: {seamOffset}px</Label>
                  <Slider 
                    value={[seamOffset]} 
                    onValueChange={v => setSeamOffset(v[0])} 
                    min={0} 
                    max={200}
                    className="[&_[role=slider]]:bg-black [&_[role=slider]]:border-2 [&_[role=slider]]:border-black"
                  />
                </div>

                <div className="flex items-center gap-3">
                  <Label>Mirror Mode</Label>
                  <div className="w-12 h-6 rounded-full border-2 border-black" style={{ backgroundColor: mirrorMode ? "#000" : "#f0f0f0" }}>
                    <button
                      onClick={() => {
                        setMirrorMode(!mirrorMode);
                        if (!mirrorMode && activeLeg === "right") {
                          setDragOffset(dragOffset);
                        }
                      }}
                      className="w-full h-full flex items-center justify-center rounded-full"
                    >
                      <div className="w-5 h-5 rounded-full bg-black border-2 border-black" />
                    </button>
                  </div>
                </div>

                {hasPairedPanels && (
                  <div>
                    <Label>Active Leg</Label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setActiveLeg("left")}
                        className={`px-3 py-1 rounded ${activeLeg === "left" ? "bg-blue-500 text-white" : "bg-gray-200"}`}
                      >
                        Left
                      </button>
                      <button
                        onClick={() => setActiveLeg("right")}
                        className={`px-3 py-1 rounded ${activeLeg === "right" ? "bg-blue-500 text-white" : "bg-gray-200"}`}
                      >
                        Right
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            <div>
              <Label>Background</Label>
              <div className="flex gap-2 items-center">
                <Select value={bgColor === "" ? "transparent" : bgColor} onValueChange={v => setBgColor(v === "transparent" ? "" : v)}>
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Select background" />
                  </SelectTrigger>
                  <SelectContent>
                    {BG_PRESETS.map(preset => (
                      <SelectItem key={preset.value} value={preset.value}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <input
                  type="color"
                  value={bgColor === "" ? "#ffffff" : bgColor}
                  onChange={(e) => setBgColor(e.target.value)}
                  className="w-12 h-10 rounded cursor-pointer border border-gray-300"
                  title="Custom color picker"
                />
              </div>
            </div>

            <div className="flex gap-2 flex-col mt-auto">
              <Button onClick={() => { handleApply(); setShowMockups(true); }} disabled={isLoading} className="w-full">
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Apply
              </Button>
              <Button onClick={onCancel} variant="outline" className="w-full">
                Cancel
              </Button>
            </div>
          </div>

          {/* Right column: Product info and buttons */}
          <div className="flex flex-col space-y-4">
            <div className="border border-gray-300 rounded p-4 bg-gray-50">
              <p className="text-sm text-gray-600">Product preview</p>
            </div>
            <div className="flex gap-2 flex-col">
              <Button onClick={() => { handleApply(); setShowMockups(true); }} disabled={isLoading} className="w-full">
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Apply
              </Button>
              <Button onClick={onCancel} variant="outline" className="w-full">
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : (
        // 2-column layout: Processing mockups | Product info
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
          {/* Left column: Processing/Mockups */}
          <div className="flex flex-col space-y-4">
            <div className="border border-gray-300 rounded p-4 bg-gray-50 flex items-center justify-center min-h-96">
              {isLoading ? (
                <div className="text-center">
                  <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2" />
                  <p className="text-sm text-gray-600">Processing mockups...</p>
                </div>
              ) : (
                <p className="text-sm text-gray-600">Mockup preview</p>
              )}
            </div>
          </div>

          {/* Right column: Product info */}
          <div className="flex flex-col space-y-4">
            <div className="border border-gray-300 rounded p-4 bg-gray-50">
              <p className="text-sm text-gray-600">Product details</p>
            </div>
            <Button onClick={() => setShowMockups(false)} variant="outline" className="w-full">
              Back to Editor
            </Button>
          </div>
        </div>
      )}
    </div>
  );
