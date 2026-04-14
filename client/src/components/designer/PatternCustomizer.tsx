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
  left_leg:     { x: 276.24, y: 150.15, w: 2547.97, h: 2798.14 },
  right_leg:    { x: 276.24, y: 150.15, w: 2547.97, h: 2798.14 },
};

// ── Panel group helpers ───────────────────────────────────────────────────────

/**
 * Classify a Printify position name into a display group.
 * Returns: "front" | "back" | "hood" | "accent"
 */
function getPanelGroup(position: string): "front" | "back" | "hood" | "accent" {
  const p = position.toLowerCase();
  if (p.includes("front") || p === "left_leg" || p === "right_leg") return "front";
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

  } else if (p === "left_leg") {
    // Left leg panel (left side of composite — inseam on RIGHT edge)
    const waistW = w * 0.85;
    const ankleW = w * 0.45;
    ctx.moveTo(x, y);
    ctx.lineTo(x + waistW, y);
    ctx.lineTo(x + w, y + h * 0.15);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w - ankleW, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + h * 0.15);
    ctx.closePath();

  } else if (p === "right_leg") {
    // Right leg panel (right side of composite — inseam on LEFT edge)
    const waistW = w * 0.85;
    const ankleW = w * 0.45;
    ctx.moveTo(x + w, y);
    ctx.lineTo(x + w - waistW, y);
    ctx.lineTo(x, y + h * 0.15);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x + ankleW, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w, y + h * 0.15);
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
    ctx.bezierCurveTo(x + w, y, x + w * 0.7, y, x + w * 0.5, y);      // arch top-right
    ctx.bezierCurveTo(x + w * 0.3, y, x, y, x, y + h * 0.15);         // arch top-left
    ctx.lineTo(x, y + h * 0.15);                                        // left side up to arch
    ctx.lineTo(x, y + h);                                               // left side down
    ctx.closePath();

  } else {
    // Generic rectangle for unknown panels
    ctx.rect(x, y, w, h);
  }
}

/**
 * Given a list of panel positions, build the composite canvas layout for a view.
 * Returns an array of { position, x, y, w, h } in composite-canvas coordinates.
 * The composite canvas dimensions are also returned.
 *
 * For "front" view: pairs front_left + front_right side-by-side (or left_leg + right_leg).
 * For "back" view: the back panel centred.
 * For "hood" view: pairs right_hood + left_hood side-by-side (right_hood on left, seam in centre).
 */
function buildCompositeLayout(
  panels: { position: string; width: number; height: number }[],
  view: "front" | "back" | "hood"
): {
  compositeW: number;
  compositeH: number;
  slots: { position: string; x: number; y: number; w: number; h: number }[];
} {
  const viewPanels = panels.filter(p => getPanelGroup(p.position) === view);
  if (viewPanels.length === 0) {
    return { compositeW: 1, compositeH: 1, slots: [] };
  }

  // Sort: for front/hood view, "right" panel goes first (left side of composite) because
  // on a zip hoodie, front_right/right_hood is the panel to the RIGHT of the seam as you
  // look at it, which sits on the LEFT half of the composite. This puts the seam in the centre.
  // For back view, "left" panel goes first (standard left-to-right reading order).
  const sorted = [...viewPanels].sort((a, b) => {
    const aIsLeft = a.position.toLowerCase().includes("left");
    const bIsLeft = b.position.toLowerCase().includes("left");
    if (view === "front" || view === "hood") {
      // right panel first (left side of composite = seam in centre)
      return aIsLeft ? 1 : bIsLeft ? -1 : 0;
    } else {
      // left panel first (standard order)
      return aIsLeft ? -1 : bIsLeft ? 1 : 0;
    }
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
  patternTransform?: { offsetX: number; offsetY: number };
  panelUrls?: { position: string; dataUrl: string }[];
}

export interface AopPlacementSettings {
  placeX: number;
  placeY: number;
  placeScale: number;
  placeRotation: number;
  backPlaceX: number;
  backPlaceY: number;
  backPlaceScale: number;
  backPlaceRotation: number;
  hoodPlaceX: number;
  hoodPlaceY: number;
  hoodPlaceScale: number;
  hoodPlaceRotation: number;
  backHasArtwork: boolean;
  backSameAsFront: boolean;
  hoodHasArtwork: boolean;
  seamOffset: number;
  accentColor: string;
  bgColor: string;
}

interface PatternCustomizerProps {
  motifUrl: string;
  productWidth?: number;
  productHeight?: number;
  hasPairedPanels?: boolean;
  /** Full list of panel positions with their exact Printify pixel dimensions */
  panelPositions?: { position: string; width: number; height: number }[];
  /**
   * Optional flat-lay SVG/PNG URLs for each panel position — used as panel backgrounds
   * in the Place on Item viewer. Keyed by Printify position name.
   * e.g. { "front_right": "https://images.printify.com/api/catalog/xxx.svg" }
   */
  panelFlatLayImages?: Record<string, string>;
  onApply: (patternUrl: string, options: PatternApplyOptions) => void | Promise<void>;
  isLoading?: boolean;
  /** Optional fetch override — pass safeFetch from embed-design to bypass Shopify service worker */
  fetchFn?: (url: string, options?: RequestInit) => Promise<Response>;
  /** Persisted settings — passed back in when reopening so state survives close/reopen */
  initialTilesAcross?: number;
  initialPattern?: PatternType;
  initialBgColor?: string;
  onSettingsChange?: (settings: {
    tilesAcross: number;
    pattern: PatternType;
    bgColor: string;
    patternOffsetX: number;
    patternOffsetY: number;
  }) => void;
  /** Persisted Place on Item placement — passed back in when reopening */
  initialPlacement?: AopPlacementSettings;
  onPlacementChange?: (placement: AopPlacementSettings) => void;
}

// ── Client-side Canvas tiling ────────────────────────────────────────────────

function drawTiledPattern(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  opts: {
    pattern: PatternType;
    tileW: number;
    bgColor: string;
    offsetX?: number;
    offsetY?: number;
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
  const cols = Math.ceil(W / tileW) + 3;
  const rows = Math.ceil(H / tileH) + 3;

  const offX = (opts.offsetX || 0) % tileW;
  const offY = (opts.offsetY || 0) % tileH;

  for (let row = -2; row < rows; row++) {
    for (let col = -2; col < cols; col++) {
      let x = col * tileW + offX;
      let y = row * tileH + offY;
      if (opts.pattern === "brick" && row % 2 !== 0) x += tileW / 2;
      if (opts.pattern === "half"  && col % 2 !== 0) y += tileH / 2;
      ctx.drawImage(img, x, y, tileW, tileH);
    }
  }
}

// ── SVG viewBox sizes ───────────────────────────────────────────────────────
// All Printify sew-pattern SVGs have a square viewBox. These are the known side
// lengths for each panel position, used to inject explicit pixel dimensions into
// the SVG markup so the browser can rasterise it at the correct size.
const SVG_VB_SIZES: Record<string, number> = {
  // Blueprint 451 — Unisex Zip Hoodie
  front_right: 3022.87, front_left: 3022.87,
  back: 3211.80,
  right_sleeve: 2645.01, left_sleeve: 2645.01,
  right_hood: 1889.29, left_hood: 1889.29,
  // Leggings (Blueprint 1050)
  left_leg: 3098.44, right_leg: 3098.44,
  // Hawaiian shirt / other single-panel products
  front: 3022.87,
  // Basketball shorts
  front_left_leg: 3022.87, front_right_leg: 3022.87,
  back_left_leg: 3022.87, back_right_leg: 3022.87,
};

// ── Component ────────────────────────────────────────────────────────────────

export function PatternCustomizer({
  motifUrl,
  productWidth = 2000,
  productHeight = 2000,
  hasPairedPanels = false,
  panelPositions = [],
  panelFlatLayImages = {},
  onApply,
  isLoading = false,
  fetchFn,
  initialTilesAcross = 4,
  initialPattern = "grid",
  initialBgColor = "#ffffff",
  onSettingsChange,
  initialPlacement,
  onPlacementChange,
}: PatternCustomizerProps) {
  const [mode, setMode]       = useState<EditorMode>("pattern");
  const [pattern, setPattern] = useState<PatternType>(initialPattern);

  const [tilesAcross, setTilesAcross] = useState<number>(initialTilesAcross);
  const [patternOffsetX, setPatternOffsetX] = useState<number>(0);
  const [patternOffsetY, setPatternOffsetY] = useState<number>(0);

  const [singleScale,    setSingleScale]    = useState(1.0);
  const [singleRotation, setSingleRotation] = useState(0);
  const [singlePosX,     setSinglePosX]     = useState(0);
  const [singlePosY,     setSinglePosY]     = useState(0);

  // Place on Item state
  const [placeView,    setPlaceView]    = useState<"front" | "back" | "hood">("front");
  // Artwork placement on the composite canvas (in composite-canvas pixel coords)
  // Initialised synchronously from panelPositions so Apply works immediately on first render.
  const [placeX,       setPlaceX]       = useState(() => {
    if (initialPlacement?.placeX) return initialPlacement.placeX;
    const fl = buildCompositeLayout(panelPositions, "front");
    return fl.compositeW > 1 ? fl.compositeW / 2 : 0;
  });
  const [placeY,       setPlaceY]       = useState(() => {
    if (initialPlacement?.placeY) return initialPlacement.placeY;
    const fl = buildCompositeLayout(panelPositions, "front");
    return fl.compositeH > 1 ? fl.compositeH * 0.35 : 0;
  });
  const [placeScale,   setPlaceScale]   = useState(initialPlacement?.placeScale ?? 0.4);
  const [placeRotation, setPlaceRotation] = useState(initialPlacement?.placeRotation ?? 0);
  // Accent panel colour (sleeves, hood, cuffs, pockets, waistband)
  const [accentColor,  setAccentColor]  = useState(initialPlacement?.accentColor ?? "#ffffff");
  // Whether back panel uses same placement as front or its own
  const [backPlaceX,   setBackPlaceX]   = useState(() => {
    if (initialPlacement?.backPlaceX) return initialPlacement.backPlaceX;
    const bl = buildCompositeLayout(panelPositions, "back");
    return bl.compositeW > 1 ? bl.compositeW / 2 : 0;
  });
  const [backPlaceY,   setBackPlaceY]   = useState(() => {
    if (initialPlacement?.backPlaceY) return initialPlacement.backPlaceY;
    const bl = buildCompositeLayout(panelPositions, "back");
    return bl.compositeH > 1 ? bl.compositeH * 0.35 : 0;
  });
  const [backPlaceScale, setBackPlaceScale] = useState(initialPlacement?.backPlaceScale ?? 0.4); // 40% of back panel width
  const [backPlaceRotation, setBackPlaceRotation] = useState(initialPlacement?.backPlaceRotation ?? 0);
  // Back panel artwork: defaults to false (no artwork on back — just solid bgColor)
  const [backHasArtwork, setBackHasArtwork] = useState(initialPlacement?.backHasArtwork ?? false);
  const [backSameAsFront, setBackSameAsFront] = useState(initialPlacement?.backSameAsFront ?? false);
  // Hood panel placement state
  const [hoodPlaceX,     setHoodPlaceX]     = useState(() => {
    if (initialPlacement?.hoodPlaceX) return initialPlacement.hoodPlaceX;
    const hl = buildCompositeLayout(panelPositions, "hood");
    return hl.compositeW > 1 ? hl.compositeW / 2 : 0;
  });
  const [hoodPlaceY,     setHoodPlaceY]     = useState(() => {
    if (initialPlacement?.hoodPlaceY) return initialPlacement.hoodPlaceY;
    const hl = buildCompositeLayout(panelPositions, "hood");
    return hl.compositeH > 1 ? hl.compositeH * 0.45 : 0;
  });
  const [hoodPlaceScale, setHoodPlaceScale] = useState(initialPlacement?.hoodPlaceScale ?? 0.7);
  const [hoodPlaceRotation, setHoodPlaceRotation] = useState(initialPlacement?.hoodPlaceRotation ?? 0);
  const [hoodHasArtwork, setHoodHasArtwork] = useState(initialPlacement?.hoodHasArtwork ?? false);
  // Seam offset: how many print-pixels of artwork bleed past the seam edge.
  // Default is ~59px (1cm at 150 DPI). User can adjust via slider.
  const [seamOffset, setSeamOffset] = useState(initialPlacement?.seamOffset ?? DEFAULT_SEAM_BLEED_PX);

  // Snap indicator state — true when artwork is snapped to a guide line
  const [isSnapped, setIsSnapped] = useState(false);

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
  // Refs to hold latest values for use inside memoised drag callbacks (avoids stale closures)
  const placeViewRef = useRef(placeView);
  const backSameAsFrontRef = useRef(backSameAsFront);
  const compositeWRef = useRef(1);
  const compositeHRef = useRef(1);
  const currentLayoutRef = useRef<ReturnType<typeof buildCompositeLayout> | null>(null);
  useEffect(() => { placeViewRef.current = placeView; }, [placeView]);
  useEffect(() => { backSameAsFrontRef.current = backSameAsFront; }, [backSameAsFront]);

  // Flat-lay images loaded state.
  // We store HTMLImageElement objects loaded from Blob URLs with explicit pixel
  // dimensions injected into the SVG markup. We also store the parsed
  // color_background rect and viewBox size so we can correctly scale the SVG
  // to fill each panel slot without distortion.
  const flatLayImgRef  = useRef<Map<string, HTMLImageElement>>(new Map());
  // Metadata parsed from each SVG: { vbSize, cbX, cbY, cbW, cbH }
  // cbX/cbY/cbW/cbH are the color_background rect in SVG viewBox units.
  // Used to scale the SVG so the content rect fills the slot exactly.
  const flatLayMetaRef = useRef<Map<string, { vbSize: number; cbX: number; cbY: number; cbW: number; cbH: number }>>(new Map());
  const [flatLayLoaded, setFlatLayLoaded] = useState(0);

  // Load flat-lay SVGs: fetch text, parse metadata, inject explicit pixel dimensions,
  // create Blob URL, load as HTMLImageElement.
  useEffect(() => {
    const entries = Object.entries(panelFlatLayImages);
    if (entries.length === 0) return;

    // Clear cache when the set of panel positions changes (different product loaded)
    let cacheValid = true;
    for (const [pos] of flatLayImgRef.current) {
      if (!panelFlatLayImages[pos]) { cacheValid = false; break; }
    }
    if (!cacheValid) {
      flatLayImgRef.current.clear();
      flatLayMetaRef.current.clear();
    }

    let loaded = 0;
    const total = entries.length;
    const blobUrls: string[] = []; // track for cleanup

    const done = () => {
      loaded++;
      if (loaded === total) setFlatLayLoaded(n => n + 1);
    };

    for (const [pos, url] of entries) {
      if (flatLayImgRef.current.has(pos)) { done(); continue; }

      (async () => {
        try {
          // Fetch SVG text (use fetchFn if provided to bypass Shopify service worker)
          const doFetch = fetchFn ?? fetch;
          const res = await doFetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          let svgText = await res.text();

          // ── Parse viewBox size ────────────────────────────────────────────────
          // All Printify sew-pattern SVGs have a square viewBox (0 0 N N).
          const vbMatch = svgText.match(/viewBox="[^"]*0 0 ([\d.]+) ([\d.]+)"/);
          const vbSize = vbMatch ? parseFloat(vbMatch[1]) : (SVG_VB_SIZES[pos] ?? 1000);

          // ── Parse color_background rect ───────────────────────────────────────
          // The color_background rect defines the printable area within the square
          // viewBox. We use it to scale the SVG so this rect exactly fills the
          // panel slot in the viewer, with the sew lines visible around the edges.
          let cbX = 0, cbY = 0, cbW = vbSize, cbH = vbSize;
          const cbMatch = svgText.match(/<rect[^>]+id="color_background"[^>]*>|<rect[^>]+id="color_background"[^>]*\/>/s);
          if (cbMatch) {
            const tag = cbMatch[0];
            const xm = tag.match(/\bx="([\d.-]+)"/);
            const ym = tag.match(/\by="([\d.-]+)"/);
            const wm = tag.match(/\bwidth="([\d.]+)"/);
            const hm = tag.match(/\bheight="([\d.]+)"/);
            if (xm && ym && wm && hm) {
              cbX = parseFloat(xm[1]);
              cbY = parseFloat(ym[1]);
              cbW = parseFloat(wm[1]);
              cbH = parseFloat(hm[1]);
            }
          }
          // Fall back to hardcoded rects for known panels if parsing failed
          if (cbW === vbSize) {
            const fallback = SVG_CONTENT_RECTS[pos];
            if (fallback) { cbX = fallback.x; cbY = fallback.y; cbW = fallback.w; cbH = fallback.h; }
          }

          // Store metadata for use during drawing
          flatLayMetaRef.current.set(pos, { vbSize, cbX, cbY, cbW, cbH });

          // ── Inject explicit pixel dimensions ──────────────────────────────────
          // Replace width="100%" height="100%" with fixed pixel values so the
          // browser rasterises the SVG at the correct size.
          svgText = svgText
            .replace(/(<svg[^>]*?)\s+width="[^"]*"/, `$1 width="${vbSize}"`);
          svgText = svgText
            .replace(/(<svg[^>]*?)\s+height="[^"]*"/, `$1 height="${vbSize}"`);

          // Create a Blob URL from the modified SVG
          const blob = new Blob([svgText], { type: "image/svg+xml" });
          const blobUrl = URL.createObjectURL(blob);
          blobUrls.push(blobUrl);

          // Load as HTMLImageElement
          const img = new window.Image();
          img.onload = () => {
            flatLayImgRef.current.set(pos, img);
            done();
          };
          img.onerror = () => { done(); };
          img.src = blobUrl;
        } catch {
          done();
        }
      })();
    }

    // Cleanup Blob URLs when effect re-runs or component unmounts
    return () => {
      blobUrls.forEach(u => URL.revokeObjectURL(u));
    };
  }, [panelFlatLayImages]);

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
    drawTiledPattern(canvas, motifImgRef.current, {
      pattern,
      tileW: previewTileW,
      bgColor,
      offsetX: patternOffsetX,
      offsetY: patternOffsetY
    });
  }, [mode, motifLoaded, pattern, tilesAcross, bgColor, previewTileW, patternOffsetX, patternOffsetY]);

  // Notify parent of settings changes
  useEffect(() => {
    onSettingsChange?.({
      tilesAcross,
      pattern,
      bgColor,
      patternOffsetX,
      patternOffsetY
    });
  }, [tilesAcross, pattern, bgColor, patternOffsetX, patternOffsetY]);

  // Notify parent of placement changes (for persistence across close/reopen)
  useEffect(() => {
    if (mode !== "place") return;
    onPlacementChange?.({
      placeX, placeY, placeScale, placeRotation,
      backPlaceX, backPlaceY, backPlaceScale, backPlaceRotation,
      hoodPlaceX, hoodPlaceY, hoodPlaceScale, hoodPlaceRotation,
      backHasArtwork, backSameAsFront, hoodHasArtwork,
      seamOffset, accentColor, bgColor,
    });
  }, [mode, placeX, placeY, placeScale, placeRotation,
      backPlaceX, backPlaceY, backPlaceScale, backPlaceRotation,
      hoodPlaceX, hoodPlaceY, hoodPlaceScale, hoodPlaceRotation,
      backHasArtwork, backSameAsFront, hoodHasArtwork, seamOffset, accentColor, bgColor]);

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
  const hoodLayout  = buildCompositeLayout(panelPositions, "hood");
  const currentLayout =
    placeView === "front" ? frontLayout :
    placeView === "back"  ? backLayout  :
    hoodLayout;
  const currentPlaceX =
    placeView === "front" ? placeX :
    placeView === "back"  ? (backSameAsFront ? placeX : backPlaceX) :
    hoodPlaceX;
  const currentPlaceY =
    placeView === "front" ? placeY :
    placeView === "back"  ? (backSameAsFront ? placeY : backPlaceY) :
    hoodPlaceY;
  const currentPlaceScale =
    placeView === "front" ? placeScale :
    placeView === "back"  ? (backSameAsFront ? placeScale : backPlaceScale) :
    hoodPlaceScale;
  const currentPlaceRotation =
    placeView === "front" ? placeRotation :
    placeView === "back"  ? (backSameAsFront ? placeRotation : backPlaceRotation) :
    hoodPlaceRotation;
  // Whether the current view has artwork enabled
  const currentViewHasArtwork =
    placeView === "front" ||
    (placeView === "back" && backHasArtwork) ||
    (placeView === "hood" && hoodHasArtwork);

  // Keep refs in sync so drag handler always has the latest value
  compositeWRef.current = currentLayout.compositeW;
  compositeHRef.current = currentLayout.compositeH;
  currentLayoutRef.current = currentLayout;

  const setCurrentPlace = (x: number, y: number) => {
    if (placeView === "front") { setPlaceX(x); setPlaceY(y); }
    else if (placeView === "back" && !backSameAsFront) { setBackPlaceX(x); setBackPlaceY(y); }
    else if (placeView === "hood") { setHoodPlaceX(x); setHoodPlaceY(y); }
  };

  // Initialise placement to centre of composite when layout first becomes available
  // (only set if current value is 0 — i.e. panelPositions was empty at mount time)
  useEffect(() => {
    if (frontLayout.compositeW > 1 && placeX === 0) {
      setPlaceX(frontLayout.compositeW / 2);
      setPlaceY(frontLayout.compositeH * 0.35);
    }
  }, [frontLayout.compositeW]);
  useEffect(() => {
    if (backLayout.compositeW > 1 && backPlaceX === 0) {
      setBackPlaceX(backLayout.compositeW / 2);
      setBackPlaceY(backLayout.compositeH * 0.35);
    }
  }, [backLayout.compositeW]);
  useEffect(() => {
    if (hoodLayout.compositeW > 1 && hoodPlaceX === 0) {
      setHoodPlaceX(hoodLayout.compositeW / 2);
      setHoodPlaceY(hoodLayout.compositeH * 0.45);
    }
  }, [hoodLayout.compositeW]);

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

    // Light grey canvas background (outside panels)
    ctx.fillStyle = "#f1f5f9";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Compute artwork position in preview coords (used for both clipped and unclipped drawing)
    //
    // Scale reference: compositeW (the full composite canvas width).
    // placeScale = 0.4 means the artwork is 40% of the composite width.
    // For front (compositeW=3616): artW = 3616 * 0.4 = 1446px
    // For back  (compositeW=3616): artW = 3616 * 0.4 = 1446px
    // For hood  (compositeW=2490): artW = 2490 * 0.4 = 996px
    // This is consistent across views and matches the apply logic 1:1.
    const img = motifImgRef.current;
    const artW = layout.compositeW * currentPlaceScale * scaleToPreview;
    const artH = artW * (img.height / img.width);
    const artCX = currentPlaceX * scaleToPreview;
    const artCY = currentPlaceY * scaleToPreview;
    const artX = artCX - artW / 2;
    const artY = artCY - artH / 2;
    const rotRad = (currentPlaceRotation * Math.PI) / 180;

    // Draw each panel with garment shape clip (or flat-lay image background)
    for (const slot of layout.slots) {
      const sx = slot.x * scaleToPreview;
      const sy = slot.y * scaleToPreview;
      const sw = slot.w * scaleToPreview;
      const sh = slot.h * scaleToPreview;

      const flatLayImg = flatLayImgRef.current.get(slot.position);

      if (flatLayImg) {
        // ── Flat-lay SVG available ────────────────────────────────────────────
        // The SVG has a square viewBox with the panel shape inside it.
        // We scale the full SVG so the color_background rect (the printable area)
        // exactly fills the slot. This ensures correct proportions and no distortion.
        //
        // Formula:
        //   svgScale = sw / cbW   (scale so content rect width = slot width)
        //   svgDrawSize = vbSize * svgScale
        //   drawX = sx - cbX * svgScale   (offset so content rect left = slot left)
        //   drawY = sy - cbY * svgScale   (offset so content rect top = slot top)
        //
        // The slot rect clip ensures the SVG parts outside the slot are hidden.
        const meta = flatLayMetaRef.current.get(slot.position);
        const svgMeta = meta ?? { vbSize: flatLayImg.naturalWidth || 1000, cbX: 0, cbY: 0, cbW: flatLayImg.naturalWidth || 1000, cbH: flatLayImg.naturalHeight || 1000 };

        // Scale SVG so content rect width fills slot width
        const svgScale = sw / svgMeta.cbW;
        const svgDrawSize = svgMeta.vbSize * svgScale;
        const drawX = sx - svgMeta.cbX * svgScale;
        const drawY = sy - svgMeta.cbY * svgScale;

        ctx.save();
        ctx.beginPath();
        ctx.rect(sx, sy, sw, sh);
        ctx.clip();

        // Use an offscreen canvas so we can composite bgColor onto the garment shape
        // only (not the transparent negative space around it).
        const offW = Math.ceil(sw);
        const offH = Math.ceil(sh);
        const off = document.createElement("canvas");
        off.width = offW; off.height = offH;
        const offCtx = off.getContext("2d")!;

        // 1. Draw SVG into offscreen canvas (garment shape + sewing lines)
        offCtx.drawImage(flatLayImg, drawX - sx, drawY - sy, svgDrawSize, svgDrawSize);

        // 2. Replace garment fill with bgColor using source-in composite:
        //    source-in keeps only pixels where destination (SVG) is opaque.
        offCtx.globalCompositeOperation = "source-in";
        offCtx.fillStyle = bgColor || "#ffffff";
        offCtx.fillRect(0, 0, offW, offH);
        offCtx.globalCompositeOperation = "source-over";

        // 3. Draw artwork into offscreen canvas (clipped to garment shape via source-atop)
        if (currentViewHasArtwork) {
          offCtx.globalCompositeOperation = "source-atop";
          offCtx.globalAlpha = 0.9;
          if (rotRad !== 0) {
            offCtx.save();
            offCtx.translate(artCX - sx, artCY - sy);
            offCtx.rotate(rotRad);
            offCtx.drawImage(img, -artW / 2, -artH / 2, artW, artH);
            offCtx.restore();
          } else {
            offCtx.drawImage(img, artX - sx, artY - sy, artW, artH);
          }
          offCtx.globalAlpha = 1;
          offCtx.globalCompositeOperation = "source-over";
        }

        // 4. Draw sewing lines overlay on top (SVG again with multiply so lines show)
        offCtx.globalCompositeOperation = "multiply";
        offCtx.drawImage(flatLayImg, drawX - sx, drawY - sy, svgDrawSize, svgDrawSize);
        offCtx.globalCompositeOperation = "source-over";

        // 5. Composite offscreen result onto main canvas
        ctx.drawImage(off, sx, sy);

        ctx.restore();
      } else {
        // ── No flat-lay image: use garment shape clip + solid fill ────────────
        ctx.save();
        drawPanelShape(ctx, slot.position, sx, sy, sw, sh);
        ctx.clip();
        ctx.fillStyle = bgColor || "#ffffff";
        ctx.fillRect(sx, sy, sw, sh);
        if (currentViewHasArtwork) {
          ctx.globalAlpha = 0.92;
          if (rotRad !== 0) {
            ctx.save();
            ctx.translate(artCX, artCY);
            ctx.rotate(rotRad);
            ctx.drawImage(img, -artW / 2, -artH / 2, artW, artH);
            ctx.restore();
          } else {
            ctx.drawImage(img, artX, artY, artW, artH);
          }
          ctx.globalAlpha = 1;
        }
        ctx.restore();

        // Draw panel outline (garment shape stroke)
        ctx.save();
        drawPanelShape(ctx, slot.position, sx, sy, sw, sh);
        ctx.strokeStyle = "#94a3b8";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }
    }

    // Draw centre seam line (dashed red, brighter when snapped) between adjacent panels
    const seamXs = new Set(layout.slots.map(s => s.x).filter(x => x > 0));
    seamXs.forEach(seamX => {
      const px = seamX * scaleToPreview;
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = isSnapped ? "rgba(239,68,68,1.0)" : "rgba(239,68,68,0.7)";
      ctx.lineWidth = isSnapped ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(px, 0); ctx.lineTo(px, canvas.height);
      ctx.stroke();
      ctx.restore();
    });

    // Draw panel centre guide lines (faint blue dashed) for snap-to-panel-centre
    for (const slot of layout.slots) {
      const panelCentreX = (slot.x + slot.w / 2) * scaleToPreview;
      const artCentreX = currentPlaceX * scaleToPreview;
      const isSnapToPanelCentre = Math.abs(artCentreX - panelCentreX) < 3;
      if (isSnapToPanelCentre) {
        ctx.save();
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = "rgba(59,130,246,0.8)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(panelCentreX, 0); ctx.lineTo(panelCentreX, canvas.height);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Draw artwork bounding box (blue dashed) if artwork is shown
    if (currentViewHasArtwork) {
      ctx.save();
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      if (rotRad !== 0) {
        ctx.translate(artCX, artCY);
        ctx.rotate(rotRad);
        ctx.strokeRect(-artW / 2, -artH / 2, artW, artH);
      } else {
        ctx.strokeRect(artX, artY, artW, artH);
      }
      ctx.setLineDash([]);
      ctx.restore();
    } else {
      // No artwork: show label
      ctx.fillStyle = "rgba(100,116,139,0.6)";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No artwork (solid colour)", canvas.width / 2, canvas.height / 2);
    }

  }, [mode, motifLoaded, placeView, currentLayout, currentPlaceX, currentPlaceY, currentPlaceScale, currentPlaceRotation, bgColor, backHasArtwork, hoodHasArtwork, currentViewHasArtwork, isSnapped, flatLayLoaded]);

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

  // Touch handlers for single-image mode (mobile drag support)
  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      startX: touch.clientX - rect.left,
      startY: touch.clientY - rect.top,
      origX: singlePosX,
      origY: singlePosY,
    };
  }, [singlePosX, singlePosY]);
  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = (touch.clientX - rect.left - dragRef.current.startX) / rect.width * 100;
    const dy = (touch.clientY - rect.top  - dragRef.current.startY) / rect.height * 100;
    setSinglePosX(Math.max(-100, Math.min(100, dragRef.current.origX + dx)));
    setSinglePosY(Math.max(-100, Math.min(100, dragRef.current.origY + dy)));
  }, []);
  const handleTouchEnd = useCallback(() => { dragRef.current = null; }, []);

  // Drag handlers for Place on Item mode.
  // IMPORTANT: these use refs (placeViewRef, backSameAsFrontRef, compositeWRef) instead of
  // closure values to avoid the stale-closure bug where subsequent drags use outdated state.
  const handlePlaceMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // Read current position directly from the canvas data attribute (set during render).
    const canvas = placeCanvasRef.current;
    const origX = canvas ? parseFloat(canvas.dataset.placeX || "0") : 0;
    const origY = canvas ? parseFloat(canvas.dataset.placeY || "0") : 0;
    placeDragRef.current = {
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      origX,
      origY,
    };
  }, []);

  const handlePlaceMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!placeDragRef.current || !placeCanvasRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // Use refs for fresh values — avoids stale closure
    const compositeW = compositeWRef.current;
    const compositeH = compositeHRef.current;
    const cssToComposite = compositeW / rect.width;
    const rawX = placeDragRef.current.origX + (e.clientX - rect.left - placeDragRef.current.startX) * cssToComposite;
    const rawY = placeDragRef.current.origY + (e.clientY - rect.top  - placeDragRef.current.startY) * cssToComposite;

    // ── Snap-to-centre logic ──────────────────────────────────────────────────
    // Build snap points: seam (compositeW/2) + each panel's horizontal centre
    const layout = currentLayoutRef.current;
    const snapThresholdComposite = SNAP_THRESHOLD_CSS * cssToComposite;
    let snappedX = rawX;
    let didSnap = false;

    if (layout) {
      // Seam snap points (x-coords where adjacent panels meet)
      const snapXs: number[] = [compositeW / 2]; // seam
      for (const slot of layout.slots) {
        snapXs.push(slot.x + slot.w / 2); // panel centre
      }
      for (const snapX of snapXs) {
        if (Math.abs(rawX - snapX) < snapThresholdComposite) {
          snappedX = snapX;
          didSnap = true;
          break;
        }
      }
    }

    setIsSnapped(didSnap);

    if (placeViewRef.current === "front") {
      setPlaceX(snappedX); setPlaceY(rawY);
    } else if (placeViewRef.current === "hood") {
      setHoodPlaceX(snappedX); setHoodPlaceY(rawY);
    } else if (!backSameAsFrontRef.current) {
      setBackPlaceX(snappedX); setBackPlaceY(rawY);
    }
  }, []);

  const handlePlaceMouseUp = useCallback(() => {
    placeDragRef.current = null;
    setIsSnapped(false);
  }, []);

  // Touch handlers for Place on Item mode (mobile drag support)
  const handlePlaceTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const canvas = placeCanvasRef.current;
    const origX = canvas ? parseFloat(canvas.dataset.placeX || "0") : 0;
    const origY = canvas ? parseFloat(canvas.dataset.placeY || "0") : 0;
    placeDragRef.current = {
      startX: touch.clientX - rect.left,
      startY: touch.clientY - rect.top,
      origX,
      origY,
    };
  }, []);

  const handlePlaceTouchMove = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    if (!placeDragRef.current || !placeCanvasRef.current) return;
    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const compositeW = compositeWRef.current;
    const compositeH = compositeHRef.current;
    const cssToComposite = compositeW / rect.width;
    const rawX = placeDragRef.current.origX + (touch.clientX - rect.left - placeDragRef.current.startX) * cssToComposite;
    const rawY = placeDragRef.current.origY + (touch.clientY - rect.top  - placeDragRef.current.startY) * cssToComposite;

    // Snap-to-centre logic (same as mouse handler)
    const layout = currentLayoutRef.current;
    const snapThresholdComposite = SNAP_THRESHOLD_CSS * cssToComposite;
    let snappedX = rawX;
    let didSnap = false;
    if (layout) {
      const snapXs: number[] = [compositeW / 2];
      for (const slot of layout.slots) {
        snapXs.push(slot.x + slot.w / 2);
      }
      for (const snapX of snapXs) {
        if (Math.abs(rawX - snapX) < snapThresholdComposite) {
          snappedX = snapX;
          didSnap = true;
          break;
        }
      }
    }
    setIsSnapped(didSnap);
    if (placeViewRef.current === "front") {
      setPlaceX(snappedX); setPlaceY(rawY);
    } else if (placeViewRef.current === "hood") {
      setHoodPlaceX(snappedX); setHoodPlaceY(rawY);
    } else if (!backSameAsFrontRef.current) {
      setBackPlaceX(snappedX); setBackPlaceY(rawY);
    }
  }, []);

  const handlePlaceTouchEnd = useCallback(() => {
    placeDragRef.current = null;
    setIsSnapped(false);
  }, []);

  // Remove background
  const handleRemoveBg = async () => {
    setIsRemovingBg(true); setBgRemoveError(null);
    try {
      const doFetch = fetchFn ?? fetch;
      const res = await doFetch(`${API_BASE}/api/pattern/remove-bg`, {
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
      //   - Front/back/hood panels: crop the artwork at the panel's position within the composite.
      //     The artwork is placed at (useX, useY) in composite coords with scale useScale.
      //     The panel canvas is exactly W×H pixels (Printify's print dimensions).
      //     The artwork is drawn at the correct offset relative to the panel's position in the
      //     composite, so the seam edge naturally bleeds past the canvas edge.
      //   - Accent panels: fill with accentColor solid colour
      //
      if (mode === "place") {
        const panels: { position: string; width: number; height: number }[] =
          panelPositions.length > 0
            ? panelPositions
            : [{ position: "default", width: productWidth, height: productHeight }];

        // Debug: log panel layout to help verify sort order
        console.log("[Place on Item] Panel layout debug:");
        console.log("  frontLayout slots:", frontLayout.slots.map(s => `${s.position}@x=${s.x},w=${s.w}`).join(", "));
        console.log("  hoodLayout slots:", hoodLayout.slots.map(s => `${s.position}@x=${s.x},w=${s.w}`).join(", "));
        console.log("  placeX:", placeX, "placeY:", placeY, "placeScale:", placeScale);
        console.log("  frontLayout.compositeW:", frontLayout.compositeW, "backLayout.compositeW:", backLayout.compositeW, "hoodLayout.compositeW:", hoodLayout.compositeW);

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
            // Accent panels: use a tiny 4×4px solid colour canvas to minimise payload.
            // Printify will stretch this solid colour to fill the panel — that's correct
            // since accent panels are meant to be a single flat colour.
            canvas.width = 4; canvas.height = 4;
            ctx.fillStyle = accentColor || "#ffffff";
            ctx.fillRect(0, 0, 4, 4);
          } else if (group === "back" && !backHasArtwork) {
            // Back panel with no artwork: solid background colour only
            ctx.fillStyle = bgColor || "#ffffff";
            ctx.fillRect(0, 0, W, H);
          } else if (group === "hood" && !hoodHasArtwork) {
            // Hood panels with no artwork: solid accent colour (hoods are accent-coloured by default)
            ctx.fillStyle = accentColor || bgColor || "#ffffff";
            ctx.fillRect(0, 0, W, H);
          } else {
            // Determine which layout this panel belongs to
            const layout =
              group === "front" ? frontLayout :
              group === "hood"  ? hoodLayout  :
              backLayout;
            const useX =
              group === "front" ? placeX :
              group === "hood"  ? hoodPlaceX :
              (backSameAsFront ? placeX : backPlaceX);
            const useY =
              group === "front" ? placeY :
              group === "hood"  ? hoodPlaceY :
              (backSameAsFront ? placeY : backPlaceY);
            const useScale =
              group === "front" ? placeScale :
              group === "hood"  ? hoodPlaceScale :
              (backSameAsFront ? placeScale : backPlaceScale);
            const useRotation =
              group === "front" ? placeRotation :
              group === "hood"  ? hoodPlaceRotation :
              (backSameAsFront ? placeRotation : backPlaceRotation);

            // Find this panel's slot in the composite
            const slot = layout.slots.find(s => s.position === panel.position);
            if (!slot) {
              // Panel not in layout — fill with bg colour
              ctx.fillStyle = bgColor || "#ffffff";
              ctx.fillRect(0, 0, W, H);
            } else {
              // Fill background
              ctx.fillStyle = bgColor || "#ffffff";
              ctx.fillRect(0, 0, W, H);

              // The artwork is placed at (useX, useY) in composite coords with scale useScale.
              // useScale is a fraction of compositeW — same reference as the viewer.
              // artW = compositeW * useScale (e.g. 0.4 = 40% of composite width)
              const artW = layout.compositeW * useScale;
              const artH = artW * (img.height / img.width);
              // Top-left of artwork in composite coords:
              const artLeft = useX - artW / 2;
              const artTop  = useY - artH / 2;

              // Seam offset: controls how much the two panel images are pushed APART
              // at the seam edge. A positive seamOffset shifts each panel's artwork
              // AWAY from the seam, revealing more of the artwork on each side.
              // Each panel also gets a duplicate bleed strip of the opposing side's
              // artwork at the seam edge for manufacturing overlap.
              //
              // front_right (slot.x=0): seam on RIGHT edge → shift artwork LEFT (-seamOffset)
              //   so more of the right portion of the artwork is visible on this panel.
              // front_left (slot.x>0): seam on LEFT edge → shift artwork RIGHT (+seamOffset)
              //   so more of the left portion of the artwork is visible on this panel.
              // Single-panel views (back): no seam, no offset.
              let bleedShift = 0;
              if (layout.slots.length > 1) {
                if (slot.x === 0) {
                  // Right panel: shift artwork LEFT to push seam apart
                  bleedShift = -seamOffset;
                } else {
                  // Left panel: shift artwork RIGHT to push seam apart
                  bleedShift = seamOffset;
                }
              }

              const relX = artLeft - slot.x + bleedShift;
              const relY = artTop  - slot.y;
              const applyRotRad = (useRotation * Math.PI) / 180;

              console.log(`[Place on Item] Panel "${panel.position}": slot.x=${slot.x}, artLeft=${artLeft.toFixed(0)}, relX=${relX.toFixed(0)}, artW=${artW.toFixed(0)}, canvasW=${W}, bleedShift=${bleedShift}, rotation=${useRotation}`);

              if (applyRotRad !== 0) {
                // Draw artwork rotated around its centre (relative to panel canvas)
                const artCenterX = relX + artW / 2;
                const artCenterY = relY + artH / 2;
                ctx.save();
                ctx.translate(artCenterX, artCenterY);
                ctx.rotate(applyRotRad);
                ctx.drawImage(img, -artW / 2, -artH / 2, artW, artH);
                ctx.restore();
              } else {
                ctx.drawImage(img, relX, relY, artW, artH);
              }
            }
          }

          // Use JPEG quality 92 to keep payload small (PNG is ~5-10MB per panel at print resolution)
          const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
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

      // Scale the preview offsets (PREVIEW_PX) to the export tile size
      // We need to know the tile size in the preview to calculate the relative offset
      const previewTileW = PREVIEW_PX / tilesAcross;

      for (const panel of panels) {
        const W = panel.width;
        const H = panel.height;
        const panelWidthIn = panel.width / PRINT_DPI;
        const totalTilesAcrossPanel = tilesPerInch * panelWidthIn;
        const panelTileW = W / totalTilesAcrossPanel;

        // The offset in the preview is in pixels relative to PREVIEW_PX.
        // We need to scale this to the actual panel's tile size.
        const exportScale = panelTileW / previewTileW;

        const canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        drawTiledPattern(canvas, img, {
          pattern,
          tileW: panelTileW,
          bgColor,
          offsetX: patternOffsetX * exportScale,
          offsetY: patternOffsetY * exportScale,
          forExport: true
        });
        const dataUrl = canvas.toDataURL("image/png");
        panelUrls.push({ position: panel.position, dataUrl });
        if (!primaryDataUrl) primaryDataUrl = dataUrl;
      }

      await onApply(primaryDataUrl, {
        mirrorLegs,
        mode,
        patternTransform: { offsetX: patternOffsetX, offsetY: patternOffsetY },
        panelUrls
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
          <div className="shrink-0">
            <p className="text-[10px] text-muted-foreground text-center mb-0.5">
              {mode === "single" ? "Drag to reposition" : mode === "place" ? "Drag artwork to position" : "6\u2033 \u00d7 6\u2033 preview"}
            </p>
            {/* overflow-visible so tall panels (front) are not clipped at the bottom.
                The canvas uses w-full + auto height so it never stretches vertically. */}
            <div className="w-full rounded border overflow-hidden relative">
              {mode === "pattern" && (
                motifLoaded ? (
                  <canvas
                    ref={patternCanvasRef}
                    width={PREVIEW_PX} height={PREVIEW_PX}
                    className="w-full"
                    style={{ display: "block" }}
                  />
                ) : (
                  <div className="w-full flex items-center justify-center bg-muted/30" style={{ height: PREVIEW_PX }}>
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                )
              )}
              {mode === "single" && (
                <canvas
                  ref={singleCanvasRef} width={PREVIEW_PX} height={PREVIEW_PX}
                  className="w-full" style={{ cursor: "grab", display: "block", touchAction: "none" }}
                  onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}
                  onTouchStart={handleTouchStart} onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
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
                    className="w-full"
                    style={{ cursor: isSnapped ? "crosshair" : "grab", display: "block", touchAction: "none" }}
                    data-place-x={currentPlaceX}
                    data-place-y={currentPlaceY}
                    onMouseDown={handlePlaceMouseDown}
                    onMouseMove={handlePlaceMouseMove}
                    onMouseUp={handlePlaceMouseUp}
                    onMouseLeave={handlePlaceMouseUp}
                    onTouchStart={handlePlaceTouchStart}
                    onTouchMove={handlePlaceTouchMove}
                    onTouchEnd={handlePlaceTouchEnd}
                  />
                ) : (
                  <div className="w-full flex items-center justify-center bg-muted/30" style={{ height: PREVIEW_PX }}>
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
                  <span>Smaller</span>
                  <span>Larger</span>
                </div>
              </div>

              <div className="shrink-0 rounded border px-2 py-2 space-y-1.5 bg-muted/20">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">X Offset</Label>
                  <span className="text-[10px] font-mono text-muted-foreground">{patternOffsetX}px</span>
                </div>
                <Slider
                  min={-200} max={200} step={1}
                  value={[patternOffsetX]}
                  onValueChange={([v]) => setPatternOffsetX(v)}
                  className="py-0 [&_[role=slider]]:bg-black [&_[role=slider]]:border-black [&_[role=slider]]:w-4 [&_[role=slider]]:h-4"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>Left</span>
                  <span>Right</span>
                </div>
              </div>

              <div className="shrink-0 rounded border px-2 py-2 space-y-1.5 bg-muted/20">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Y Offset</Label>
                  <span className="text-[10px] font-mono text-muted-foreground">{patternOffsetY}px</span>
                </div>
                <Slider
                  min={-200} max={200} step={1}
                  value={[patternOffsetY]}
                  onValueChange={([v]) => setPatternOffsetY(v)}
                  className="py-0 [&_[role=slider]]:bg-black [&_[role=slider]]:border-black [&_[role=slider]]:w-4 [&_[role=slider]]:h-4"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>Up</span>
                  <span>Down</span>
                </div>
              </div>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setPatternOffsetX(0); setPatternOffsetY(0); }}
                className="h-6 text-[10px] text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                Reset offsets
              </Button>
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
              {/* Front / Back / Hood view tabs */}
              {(frontLayout.slots.length > 0 || backLayout.slots.length > 0 || hoodLayout.slots.length > 0) && (
                <div className="shrink-0 space-y-0.5">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">View</Label>
                  <div className="flex gap-1 rounded-md border p-0.5 bg-muted">
                    {(["front", "back", "hood"] as const).filter(v =>
                      v === "front" ? frontLayout.slots.length > 0 :
                      v === "back"  ? backLayout.slots.length > 0 :
                      hoodLayout.slots.length > 0
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

              {/* Back panel artwork toggle */}
              {placeView === "back" && backLayout.slots.length > 0 && (
                <div className="flex items-center justify-between rounded border px-2 py-1.5 bg-muted/30 shrink-0">
                  <p className="text-[10px] font-medium leading-tight">Add artwork to back</p>
                  <Switch
                    checked={backHasArtwork}
                    onCheckedChange={setBackHasArtwork}
                    className="data-[state=checked]:bg-black data-[state=unchecked]:bg-gray-400 [&_span]:bg-white"
                  />
                </div>
              )}
              {/* Back same as front toggle — only shown when back has artwork */}
              {placeView === "back" && backLayout.slots.length > 0 && backHasArtwork && (
                <div className="flex items-center justify-between rounded border px-2 py-1.5 bg-muted/30 shrink-0">
                  <p className="text-[10px] font-medium leading-tight">Same placement as front</p>
                  <Switch
                    checked={backSameAsFront}
                    onCheckedChange={setBackSameAsFront}
                    className="data-[state=checked]:bg-black data-[state=unchecked]:bg-gray-400 [&_span]:bg-white"
                  />
                </div>
              )}

              {/* Hood panel artwork toggle */}
              {placeView === "hood" && hoodLayout.slots.length > 0 && (
                <div className="flex items-center justify-between rounded border px-2 py-1.5 bg-muted/30 shrink-0">
                  <p className="text-[10px] font-medium leading-tight">Add artwork to hood</p>
                  <Switch
                    checked={hoodHasArtwork}
                    onCheckedChange={setHoodHasArtwork}
                    className="data-[state=checked]:bg-black data-[state=unchecked]:bg-gray-400 [&_span]:bg-white"
                  />
                </div>
              )}

              {/* Artwork scale slider — hidden when current view has no artwork */}
              {currentViewHasArtwork && (
                <div className="shrink-0 space-y-0.5">
                  <div className="flex justify-between items-center">
                    <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Artwork size</Label>
                    <span className="text-[10px] text-muted-foreground tabular-nums">{Math.round(currentPlaceScale * 100)}%</span>
                  </div>
                  <Slider
                    min={0.05} max={2.0} step={0.01}
                    value={[currentPlaceScale]}
                    onValueChange={([v]) => {
                      if (placeView === "front") setPlaceScale(v);
                      else if (placeView === "hood") setHoodPlaceScale(v);
                      else if (!backSameAsFront) setBackPlaceScale(v);
                    }}
                    className="py-0 [&_[role=slider]]:bg-black [&_[role=slider]]:border-black [&_[role=slider]]:w-4 [&_[role=slider]]:h-4"
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>Smaller</span><span>Larger</span>
                  </div>
                </div>
              )}

              {/* Rotation — single tap-to-cycle icon */}
              {currentViewHasArtwork && (
                <button type="button"
                  title={`Rotate artwork (currently ${currentPlaceRotation}°)`}
                  onClick={() => {
                    const ROTATION_STEPS = [0, 20, 45, 70, 90, 110, 135, 160, 180];
                    const curIdx = ROTATION_STEPS.indexOf(currentPlaceRotation);
                    const nextDeg = ROTATION_STEPS[(curIdx + 1) % ROTATION_STEPS.length];
                    if (placeView === "front") setPlaceRotation(nextDeg);
                    else if (placeView === "hood") setHoodPlaceRotation(nextDeg);
                    else if (!backSameAsFront) setBackPlaceRotation(nextDeg);
                  }}
                  disabled={busy}
                  className="flex items-center gap-1.5 shrink-0 px-2 py-1.5 rounded border bg-muted/30 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                  <RotateCcw className="h-3.5 w-3.5" style={{ transform: "scaleX(-1)" }} />
                  <span className="text-[10px] tabular-nums">{currentPlaceRotation}°</span>
                </button>
              )}

              {currentViewHasArtwork && (
                <p className="text-[10px] text-muted-foreground leading-tight shrink-0">
                  Drag the artwork in the preview to reposition it. Red line = seam. Drag near seam to snap.
                </p>
              )}

              {/* Seam offset slider — controls how much artwork bleeds past the zipper/seam */}
              {currentViewHasArtwork && currentLayout.slots.length > 1 && (
                <div className="shrink-0 space-y-0.5 rounded border px-2 py-2 bg-muted/20">
                  <div className="flex justify-between items-center">
                    <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Seam offset</Label>
                    <span className="text-[10px] text-muted-foreground tabular-nums">{seamOffset}px</span>
                  </div>
                  <Slider
                    min={0} max={300} step={5}
                    value={[seamOffset]}
                    onValueChange={([v]) => setSeamOffset(v)}
                    className="py-0 [&_[role=slider]]:bg-black [&_[role=slider]]:border-black [&_[role=slider]]:w-4 [&_[role=slider]]:h-4"
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>Closer</span><span>Further apart</span>
                  </div>
                  <p className="text-[9px] text-muted-foreground leading-tight mt-0.5">
                    Pushes the two panel images apart at the zipper/seam. Each panel keeps a bleed strip of the opposing side for manufacturing overlap. Default: {DEFAULT_SEAM_BLEED_PX}px (~1cm).
                  </p>
                </div>
              )}

              {/* Accent panel colour */}
              {panelPositions.some(p => getPanelGroup(p.position) === "accent") && (
                <div className="shrink-0 space-y-1 rounded border px-2 py-2 bg-muted/20">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Accent panels colour</Label>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    Sleeves, cuffs, pockets &amp; waistband
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
                    setPlaceY(frontLayout.compositeH * 0.35);
                    setPlaceScale(0.4);
                    setPlaceRotation(0);
                  } else if (placeView === "hood") {
                    setHoodPlaceX(hoodLayout.compositeW / 2);
                    setHoodPlaceY(hoodLayout.compositeH * 0.45);
                    setHoodPlaceScale(0.7);
                    setHoodPlaceRotation(0);
                  } else {
                    setBackPlaceX(backLayout.compositeW / 2);
                    setBackPlaceY(backLayout.compositeH * 0.35);
                    setBackPlaceScale(0.4);
                    setBackPlaceRotation(0);
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
