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
// the content is flipped. We use the same source rect but draw it mirrored.

interface SvgContentRect { x: number; y: number; w: number; h: number; mirror?: boolean }

const SVG_CONTENT_RECTS: Record<string, SvgContentRect> = {
  // Blueprint 451 — Unisex Zip Hoodie AOP (MWW On Demand)
  // ViewBox 3022.87 × 3022.87
  front_right:  { x: 771.89, y:  53.08, w: 1479.08, h: 2916.71 },
  front_left:   { x: 771.89, y:  53.08, w: 1479.08, h: 2916.71 },
  // ViewBox 3211.80 × 3211.80
  back:         { x: 176.21, y: 104.50, w: 2859.37, h: 3002.80 },
  // ViewBox 2645.01 × 2645.01
  right_sleeve: { x: 141.14, y: 166.91, w: 2362.74, h: 2311.20 },
  left_sleeve:  { x: 141.14, y: 166.91, w: 2362.74, h: 2311.20 },
  // ViewBox 1889.29 × 1889.29
  right_hood:   { x: 321.95, y: 135.66, w: 1245.38, h: 1617.96 },
  // left_hood uses rotate(-180) transform — same source rect, drawn mirrored
  left_hood:    { x: 321.95, y: 135.66, w: 1245.38, h: 1617.96, mirror: true },
  // Blueprint 1050 — Women's Cut & Sew Casual Leggings AOP (MWW On Demand)
  // ViewBox 3098.44 × 3098.44
  left_leg:     { x: 276.24, y: 150.15, w: 2547.97, h: 2798.14, mirror: true },
  right_leg:    { x: 276.24, y: 150.15, w: 2547.97, h: 2798.14 },
};

// ── Panel group helpers ───────────────────────────────────────────────────────

/**
 * Classify a Printify position name into a display group.
 * Returns: "front" | "back" | "hood" | "accent"
 */
function getPanelGroup(position: string): "front" | "back" | "hood" | "accent" {
  const p = position.toLowerCase();
  // CHATGPT FIX: Leggings use "left_side" and "right_side" for placeholder positions
  if (p.includes("front") || p === "left_leg" || p === "right_leg" || p === "left_side" || p === "right_side") return "front";
  if (p.includes("back") || p === "back_side" || p === "backside") return "back";
  if (p.includes("hood")) return "hood";
  return "accent";
}

/**
 * Draw a garment-shaped clip path for a panel in the preview canvas.
 * Uses normalised bezier curves to approximate actual Printify panel shapes.
 * After calling this, the ctx clip is set — draw artwork, then ctx.restore().
 *
 * @param position  Printify position name (e.g. "front_right", "back", "right_hood")
 * @param x, y      Top-left of the panel in canvas pixels
 * @param w, h      Panel dimensions in canvas pixels
 */
function drawPanelShape(
  ctx: CanvasRenderingContext2D,
  position: string,
  x: number, y: number, w: number, h: number
) {
  const p = position.toLowerCase();
  ctx.beginPath();

  if (p === "front_right") {
    // Front-right panel (left side of composite — zip seam on RIGHT edge)
    const neckDepth = h * 0.18;
    const neckW     = w * 0.55;
    const shoulderH = h * 0.08;
    const armW      = w * 0.18;
    const armH      = h * 0.30;
    const armTop    = h * 0.08;
    ctx.moveTo(x, y + shoulderH);
    ctx.lineTo(x + w - neckW, y);
    ctx.bezierCurveTo(x + w - neckW * 0.3, y, x + w, y + neckDepth * 0.4, x + w, y + neckDepth);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + armTop + armH);
    ctx.bezierCurveTo(x, y + armTop + armH * 0.5, x + armW, y + armTop + armH * 0.3, x + armW, y + armTop + armH * 0.1);
    ctx.bezierCurveTo(x + armW, y + armTop, x, y + armTop, x, y + shoulderH);
    ctx.closePath();

  } else if (p === "front_left") {
    // Front-left panel (right side of composite — zip seam on LEFT edge)
    const neckDepth = h * 0.18;
    const neckW     = w * 0.55;
    const shoulderH = h * 0.08;
    const armW      = w * 0.18;
    const armH      = h * 0.30;
    const armTop    = h * 0.08;
    ctx.moveTo(x + w, y + shoulderH);
    ctx.lineTo(x + neckW, y);
    ctx.bezierCurveTo(x + neckW * 0.3, y, x, y + neckDepth * 0.4, x, y + neckDepth);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w, y + armTop + armH);
    ctx.bezierCurveTo(x + w, y + armTop + armH * 0.5, x + w - armW, y + armTop + armH * 0.3, x + w - armW, y + armTop + armH * 0.1);
    ctx.bezierCurveTo(x + w - armW, y + armTop, x + w, y + armTop, x + w, y + shoulderH);
    ctx.closePath();

  } else if (p === "left_leg" || p === "left_side" || p === "right_leg" || p === "right_side") {
    // Leggings: Use rectangular clipping to ensure perfect SVG alignment
    ctx.rect(x, y, w, h);
    ctx.closePath();

  } else if (p === "back" || p === "back_side" || p === "backside") {
    // Back panel: neckline at top-centre, shoulder slopes, armhole cutouts both sides
    const neckDepth = h * 0.10;
    const neckW     = w * 0.30;  // half-width of neckline
    const shoulderH = h * 0.06;
    const armW      = w * 0.12;
    const armH      = h * 0.28;
    const armTop    = h * 0.06;
    ctx.beginPath();
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

  } else if (p === "right_hood") {
    // Right hood panel: arch shape, flat bottom, curved top, straight right side (seam)
    // The right hood is the LEFT panel in the composite (seam on right edge)
    ctx.moveTo(x, y + h);                                               // bottom-left
    ctx.lineTo(x + w, y + h);                                           // bottom-right (seam)
    ctx.lineTo(x + w, y + h * 0.15);                                    // right side up to arch start
    ctx.bezierCurveTo(x + w, y, x + w * 0.7, y, x + w * 0.5, y);      // arch top-right
    ctx.bezierCurveTo(x + w * 0.3, y, x, y, x, y + h * 0.15);         // arch top-left
    ctx.lineTo(x, y + h);                                               // left side down
    ctx.closePath();

  } else if (p === "left_hood") {
    // Left hood panel: mirror of right_hood (seam on left edge)
    ctx.moveTo(x, y + h);                                               // bottom-left (seam)
    ctx.lineTo(x + w, y + h);                                           // bottom-right
    ctx.lineTo(x + w, y + h * 0.15);                                    // right side up
    ctx.bezierCurveTo(x + w, y, x + w * 0.3, y, x + w * 0.5, y);      // arch top-right
    ctx.bezierCurveTo(x + w * 0.7, y, x, y, x, y + h * 0.15);         // arch top-left
    ctx.lineTo(x, y + h);                                               // left side down
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
      return aIsLeft ? 1 : bIsLeft ? -1 : 0;
    } else {
      // back view: left panel first
      return aIsLeft ? -1 : bIsLeft ? 1 : 0;
    }
  });

  const slots: PanelSlot[] = [];
  let x = 0;
  let compositeW = 0;

  for (const p of sorted) {
    const slot = { position: p.position, x, y: 0, w: p.width, h: p.height };
    slots.push(slot);
    x += p.width;
    compositeW += p.width;
  }

  return { compositeW, compositeH: maxH, slots };
}

// ── Main PatternCustomizer component ─────────────────────────────────────────

interface PatternCustomizerProps {
  motifUrl: string;
  productTypeConfig: any;
  onApply: (result: any) => void;
  onCancel: () => void;
}

export function PatternCustomizer({
  motifUrl,
  productTypeConfig,
  onApply,
  onCancel,
}: PatternCustomizerProps) {
  const [mode, setMode] = useState<EditorMode>("pattern");
  const [patternType, setPatternType] = useState<PatternType>("grid");
  const [scale, setScale] = useState(5);
  const [bgColor, setBgColor] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [motifImage, setMotifImage] = useState<HTMLImageElement | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [seamOffset, setSeamOffset] = useState(DEFAULT_SEAM_BLEED_PX);

  // Load motif image
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => setMotifImage(img);
    img.onerror = () => console.error("Failed to load motif image");
    img.src = motifUrl;
  }, [motifUrl]);

  // Draw preview canvas
  useEffect(() => {
    if (!canvasRef.current || !motifImage) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = PREVIEW_PX;
    canvas.height = PREVIEW_PX;

    // Fill background
    ctx.fillStyle = bgColor || "transparent";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw pattern based on mode
    if (mode === "pattern") {
      drawPatternPreview(ctx, motifImage, patternType, scale);
    } else if (mode === "single") {
      drawSingleImagePreview(ctx, motifImage);
    } else if (mode === "place") {
      drawPlaceOnItemPreview(ctx, motifImage);
    }
  }, [motifImage, mode, patternType, scale, bgColor]);

  const drawPatternPreview = (
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    type: PatternType,
    scale: number
  ) => {
    const tileW = (PREVIEW_INCHES * 96) / scale; // Convert inches to pixels
    const tileH = tileW;

    let y = 0;
    while (y < ctx.canvas.height) {
      let x = 0;
      const offset = type === "brick" ? (y / tileH) % 2 === 1 ? tileW / 2 : 0 : 0;
      while (x < ctx.canvas.width + tileW) {
        ctx.drawImage(img, x + offset, y, tileW, tileH);
        x += tileW;
      }
      y += tileH;
    }
  };

  const drawSingleImagePreview = (ctx: CanvasRenderingContext2D, img: HTMLImageElement) => {
    const scale = Math.min(ctx.canvas.width / img.width, ctx.canvas.height / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const x = (ctx.canvas.width - w) / 2 + dragOffset.x;
    const y = (ctx.canvas.height - h) / 2 + dragOffset.y;
    ctx.drawImage(img, x, y, w, h);
  };

  const drawPlaceOnItemPreview = (ctx: CanvasRenderingContext2D, img: HTMLImageElement) => {
    const panelFlatLayImages = productTypeConfig?.panelFlatLayImages || {};
    const placeholderPositions = productTypeConfig?.placeholderPositions || [];

    // Build panel list
    const panels = placeholderPositions.map((pos: any) => ({
      position: pos.position,
      width: pos.width || 200,
      height: pos.height || 300,
    }));

    // Build layout
    const layout = buildCompositeLayout("front", panels);
    if (layout.compositeW === 0) return;

    // Scale to fit canvas
    const scale = Math.min(ctx.canvas.width / layout.compositeW, ctx.canvas.height / layout.compositeH);
    const scaledW = layout.compositeW * scale;
    const scaledH = layout.compositeH * scale;
    const offsetX = (ctx.canvas.width - scaledW) / 2;
    const offsetY = (ctx.canvas.height - scaledH) / 2;

    // Draw each slot
    for (const slot of layout.slots) {
      const slotX = offsetX + slot.x * scale;
      const slotY = offsetY + slot.y * scale;
      const slotW = slot.w * scale;
      const slotH = slot.h * scale;

      // Draw panel shape
      ctx.save();
      drawPanelShape(ctx, slot.position, slotX, slotY, slotW, slotH);
      ctx.clip();

      // Draw red border (debug)
      ctx.strokeStyle = "#ff0000";
      ctx.lineWidth = 2;
      ctx.strokeRect(slotX, slotY, slotW, slotH);

      // Draw motif image
      const scale2 = Math.min(slotW / img.width, slotH / img.height);
      const w = img.width * scale2;
      const h = img.height * scale2;
      const x = slotX + (slotW - w) / 2 + dragOffset.x;
      const y = slotY + (slotH - h) / 2 + dragOffset.y;
      ctx.drawImage(img, x, y, w, h);

      ctx.restore();
    }

    // Draw red seam line in center
    ctx.strokeStyle = "#ff0000";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(offsetX + layout.compositeW * scale / 2, offsetY);
    ctx.lineTo(offsetX + layout.compositeW * scale / 2, offsetY + scaledH);
    ctx.stroke();
  };

  const handleApply = async () => {
    setIsLoading(true);
    try {
      // Server call to generate mockups
      const result = await fetch("/api/generate-mockups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          motifUrl,
          mode,
          patternType,
          scale,
          dragOffset,
          seamOffset,
        }),
      }).then(r => r.json());

      onApply(result);
    } catch (err) {
      console.error("Apply failed:", err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex gap-4 p-4">
      <div className="flex-1">
        <canvas
          ref={canvasRef}
          className="border border-gray-300 rounded"
          style={{ width: "100%", height: "auto" }}
        />
      </div>

      <div className="flex-1 space-y-4">
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
              <Slider value={[scale]} onValueChange={v => setScale(v[0])} min={1} max={10} />
            </div>
          </>
        )}

        {mode === "place" && (
          <div>
            <Label>Seam Offset: {seamOffset}px</Label>
            <Slider value={[seamOffset]} onValueChange={v => setSeamOffset(v[0])} min={0} max={200} />
          </div>
        )}

        <div>
          <Label>Background</Label>
          <Select value={bgColor} onValueChange={setBgColor}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BG_PRESETS.map(preset => (
                <SelectItem key={preset.value} value={preset.value}>
                  {preset.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex gap-2">
          <Button onClick={handleApply} disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Apply
          </Button>
          <Button onClick={onCancel} variant="outline">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
