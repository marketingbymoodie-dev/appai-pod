/**
 * PatternCustomizer — AOP pattern/placement tool.
 *
 * Layout: tight 2-column grid
 *   Left  (40%) — motif thumbnail + live pattern preview canvas
 *   Right (60%) — all controls stacked compactly
 *
 * Four modes:
 *   • Pattern      — client-side Canvas tiling (instant, no server call)
 *   • Single Image — client-side Canvas placement with drag support
 *   • Place on Item — drag artwork onto each sew panel independently;
 *                     center-snap guides (dashed), per-panel drag/scale,
 *                     mirror toggle to copy placement across paired panels.
 *
 * Hoodie front panels get seam bleed (artwork overlaps across the zip seam).
 * Hood and back panels are rendered in separate "view" tabs.
 */

import { useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PanelTransform, AopPlacementSettings } from "./types";

// ── Public types ──────────────────────────────────────────────────────────────

export type PatternType = "grid" | "brick" | "half";
export type EditorMode = "pattern" | "single" | "place";

export interface PatternApplyOptions {
  panelUrls?: { position: string; dataUrl: string }[];
  mirrorLegs?: boolean;
  seamOffset?: number;
  mode?: EditorMode;
  patternType?: PatternType;
  tilesAcross?: number;
  bgColor?: string;
  perPanelTransforms?: Record<string, PanelTransform>;
}

export type { AopPlacementSettings };

// ── Constants ─────────────────────────────────────────────────────────────────

const PATTERN_OPTIONS = [
  { value: "grid"  as PatternType, label: "Grid",         desc: "Straight repeat" },
  { value: "brick" as PatternType, label: "Brick offset",  desc: "Rows offset 50%" },
  { value: "half"  as PatternType, label: "Half-drop",    desc: "Cols offset 50%" },
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

/** Default preview canvas size; actual size follows container (ResizeObserver). */
const PREVIEW_PX_DEFAULT = 400;

/** Fixed viewport size in inches shown in the preview. */
const PREVIEW_INCHES = 6;

/** Printify DPI for AOP panels */
const PRINT_DPI = 150;

/**
 * Default seam bleed in print pixels (~1 cm at 150 DPI).
 * Each split panel (front_right, front_left, right_hood, left_hood) gets this many
 * extra pixels of artwork past the seam edge so the artwork remains continuous
 * across the sewn seam even with slight manufacturing misalignment.
 */
const DEFAULT_SEAM_BLEED_PX = 70;

/** Max dimension for panel/raster uploads — native print pixels (7–12k) exceed proxy body limits (413). */
const MAX_PANEL_EXPORT_PX = 4000;

/** Encode canvas as JPEG for smaller mockup API payloads; downscale if over max dimension. */
function canvasToUploadDataUrl(canvas: HTMLCanvasElement, maxDim = MAX_PANEL_EXPORT_PX): string {
  let w = canvas.width;
  let h = canvas.height;
  if (w <= 0 || h <= 0) return canvas.toDataURL("image/jpeg", 0.92);
  if (Math.max(w, h) <= maxDim) {
    return canvas.toDataURL("image/jpeg", 0.92);
  }
  const scale = maxDim / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = document.createElement("canvas");
  out.width = nw;
  out.height = nh;
  const octx = out.getContext("2d");
  if (!octx) return canvas.toDataURL("image/jpeg", 0.85);
  octx.drawImage(canvas, 0, 0, nw, nh);
  return out.toDataURL("image/jpeg", 0.92);
}

/** Snap threshold in CSS pixels — snaps when artwork centre is within this distance. */
const SNAP_THRESHOLD_PX = 10;

// ── Panel geometry helpers ────────────────────────────────────────────────────

interface PanelSlot { position: string; x: number; y: number; w: number; h: number }

function detectProductKind(
  panels: Array<{ position: string }>
): "hoodie" | "leggings" | "generic" {
  const p = panels.map(x => x.position.toLowerCase());
  // Leggings first — avoid classifying back_waistband / front_waistband as "hoodie" via generic "back_" / "front_"
  if (p.some(x => x.includes("_leg") || x.includes("_side") || x.includes("waistband"))) return "leggings";
  if (p.some(x => x.includes("hood") || /^front_(left|right)/.test(x) || /^back_(left|right)/.test(x))) return "hoodie";
  return "generic";
}

function getPanelGroup(position: string): "front" | "back" | "hood" {
  const l = position.toLowerCase();
  if (l.includes("hood")) return "hood";
  if (l.includes("back")) return "back";
  return "front";
}

/**
 * Which panels are seam-pairs for hoodie-type products?  Returns [leftPos, rightPos].
 * Only hoodie-style products have composite seam panels (front_left/front_right, etc.).
 * Leggings left_side/right_side are independent and must NOT be paired here.
 */
function getSeamPairs(
  panels: Array<{ position: string }>
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  // Only pair positions that explicitly have a sub-group prefix (e.g., "front_left", "left_hood")
  // Leggings use "left_side" / "right_side" which do NOT have a common group prefix like "front_"
  const SEAM_PREFIXES = ["front_left", "front_right", "left_hood", "right_hood",
                         "back_left", "back_right", "left_back", "right_back"];
  const isSeamCandidate = (pos: string) =>
    SEAM_PREFIXES.some(pfx => pos.toLowerCase().startsWith(pfx));

  const seamPanels = panels.filter(p => isSeamCandidate(p.position));
  const groups = ["front", "hood", "back"] as const;
  for (const g of groups) {
    const left  = seamPanels.find(p => getPanelGroup(p.position) === g && p.position.toLowerCase().includes("left"));
    const right = seamPanels.find(p => getPanelGroup(p.position) === g && p.position.toLowerCase().includes("right"));
    if (left && right) pairs.push([left.position, right.position]);
  }
  return pairs;
}

/**
 * Build the flat composite layout for a given view.
 * Front view: right panel first (seam at centre), left panel second.
 */
function buildCompositeLayout(
  view: "front" | "back" | "hood",
  panels: Array<{ position: string; width: number; height: number }>
): { compositeW: number; compositeH: number; slots: PanelSlot[] } {
  const viewPanels = panels.filter(p => getPanelGroup(p.position) === view);
  if (viewPanels.length === 0) return { compositeW: 0, compositeH: 0, slots: [] };

  const maxH = Math.max(...viewPanels.map(p => p.height));

  const sorted = [...viewPanels].sort((a, b) => {
    const aLeft = a.position.toLowerCase().includes("left");
    const bLeft = b.position.toLowerCase().includes("left");
    // front & hood: right first (seam at centre); back: left first
    if (view === "back") return aLeft ? -1 : 1;
    return aLeft ? 1 : -1;
  });

  const GAP = 40;
  let x = 0;
  const slots: PanelSlot[] = [];
  for (const p of sorted) {
    slots.push({ position: p.position, x, y: 0, w: p.width, h: p.height });
    x += p.width + GAP;
  }
  return { compositeW: x - GAP, compositeH: maxH, slots };
}

/** Build leggings side-by-side layout. */
function buildLeggingsLayout(
  panels: Array<{ position: string; width: number; height: number }>
): { leftLeg: PanelSlot | null; rightLeg: PanelSlot | null; gap: number } {
  const leftPanel  = panels.find(p => p.position.toLowerCase().includes("left"));
  const rightPanel = panels.find(p => p.position.toLowerCase().includes("right"));
  const gap = 40;
  return {
    leftLeg:  leftPanel  ? { position: leftPanel.position,  x: 0,                       y: 0, w: leftPanel.width,  h: leftPanel.height  } : null,
    rightLeg: rightPanel ? { position: rightPanel.position, x: (leftPanel?.width || 0) + gap, y: 0, w: rightPanel.width, h: rightPanel.height } : null,
    gap,
  };
}

const LEGGINGS_GAP = 40;

/** All leggings / multi-panel AOP in one row — legs + waistbands.
 * Leg panels are sorted for front-facing viewer perspective: wearer's right leg
 * appears on the viewer's left side (screen left) and wearer's left leg on the
 * viewer's right side (screen right), matching how you'd look at the garment
 * laid out flat in front of you. */
function buildLinearPanelsLayout(
  panels: Array<{ position: string; width: number; height: number }>,
): { compositeW: number; compositeH: number; slots: PanelSlot[] } {
  if (panels.length === 0) return { compositeW: 0, compositeH: 0, slots: [] };

  const isLegPanel = (pos: string) => {
    const l = pos.toLowerCase();
    return l.includes("_leg") || l.includes("_side");
  };

  // Stable sort: leg panels → right before left; non-leg panels keep original order.
  const sorted = panels
    .map((p, i) => ({ ...p, _idx: i }))
    .sort((a, b) => {
      const al = a.position.toLowerCase();
      const bl = b.position.toLowerCase();
      if (isLegPanel(al) && isLegPanel(bl)) {
        const aRight = al.includes("right");
        const bRight = bl.includes("right");
        if (aRight && !bRight) return -1;
        if (!aRight && bRight) return 1;
      }
      return a._idx - b._idx;
    });

  let x = 0;
  const slots: PanelSlot[] = [];
  let maxH = 0;
  for (const p of sorted) {
    slots.push({ position: p.position, x, y: 0, w: p.width, h: p.height });
    x += p.width + LEGGINGS_GAP;
    maxH = Math.max(maxH, p.height);
  }
  return { compositeW: x - LEGGINGS_GAP, compositeH: maxH, slots };
}

// ── Canvas draw helpers ───────────────────────────────────────────────────────

/**
 * Draw the artwork (motif) into a slot according to a PanelTransform.
 * Also handles mirror-X for mirrored panels.
 */
function drawArtworkInSlot(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  slotX: number,
  slotY: number,
  slotW: number,
  slotH: number,
  transform: PanelTransform,
  mirrorX = false,
) {
  const scaleFactor = (transform.scalePct / 100);
  const baseScale = Math.min(slotW / img.width, slotH / img.height) * scaleFactor;
  const w = img.width  * baseScale;
  const h = img.height * baseScale;
  // Centre of artwork in slot (before user offset)
  const cx = slotX + slotW / 2 + transform.dxPx;
  const cy = slotY + slotH / 2 + transform.dyPx;
  const x = cx - w / 2;
  const y = cy - h / 2;

  ctx.save();
  if (mirrorX) {
    ctx.translate(slotX + slotW / 2, 0);
    ctx.scale(-1, 1);
    ctx.translate(-(slotX + slotW / 2), 0);
  }
  ctx.drawImage(img, x, y, w, h);
  ctx.restore();
}

/** Draw the SVG sew-pattern shape as a background. Returns true if drawn. */
function tryDrawSvgBackground(
  ctx: CanvasRenderingContext2D,
  svgImages: Record<string, HTMLImageElement>,
  position: string,
  slotX: number,
  slotY: number,
  slotW: number,
  slotH: number,
): boolean {
  for (const key of flatLayLookupKeys(position)) {
    const svgImg = svgImages[key];
    if (svgImg) {
      ctx.drawImage(svgImg, slotX, slotY, slotW, slotH);
      return true;
    }
  }
  return false;
}

function getSvgImageForPosition(
  svgImages: Record<string, HTMLImageElement>,
  position: string,
): HTMLImageElement | null {
  for (const key of flatLayLookupKeys(position)) {
    if (svgImages[key]) return svgImages[key]!;
  }
  return null;
}

function isLeftLegPanelPosition(position: string): boolean {
  const l = position.toLowerCase();
  return l.includes("left") && !l.includes("right") && (l.includes("leg") || l.includes("side"));
}

/** Draw center snap guides (dashed cross) for the active panel slot. */
function drawSnapGuides(
  ctx: CanvasRenderingContext2D,
  slotX: number, slotY: number, slotW: number, slotH: number,
) {
  const cx = slotX + slotW / 2;
  const cy = slotY + slotH / 2;
  ctx.save();
  ctx.strokeStyle = "rgba(0,120,255,0.7)";
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  // Vertical centre
  ctx.beginPath(); ctx.moveTo(cx, slotY); ctx.lineTo(cx, slotY + slotH); ctx.stroke();
  // Horizontal centre
  ctx.beginPath(); ctx.moveTo(slotX, cy); ctx.lineTo(slotX + slotW, cy); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/** Highlight active panel with a thin coloured border. */
function drawActiveBorder(
  ctx: CanvasRenderingContext2D,
  slotX: number, slotY: number, slotW: number, slotH: number,
  active: boolean,
) {
  ctx.save();
  ctx.strokeStyle = active ? "rgba(0,120,255,0.85)" : "rgba(0,0,0,0.2)";
  ctx.lineWidth = active ? 2 : 1;
  ctx.setLineDash(active ? [] : [4, 4]);
  ctx.strokeRect(slotX + 1, slotY + 1, slotW - 2, slotH - 2);
  ctx.setLineDash([]);
  ctx.restore();
}

function mapPositionToSvgName(position: string): string {
  const l = position.toLowerCase();
  if (l === "left_side"  || l.includes("left_side"))  return "left_leg";
  if (l === "right_side" || l.includes("right_side")) return "right_leg";
  if (l.includes("front_left"))  return "front_left_leg";
  if (l.includes("front_right")) return "front_right_leg";
  if (l.includes("back_left"))   return "back_left_leg";
  if (l.includes("back_right"))  return "back_right_leg";
  return position;
}

/** Keys to try when resolving a flat-lay URL (Printify naming varies). */
function flatLayLookupKeys(position: string): string[] {
  const l = position.toLowerCase();
  const keys = new Set<string>([position, mapPositionToSvgName(position)]);
  if (l.includes("left_side") || l === "left") keys.add("left_leg");
  if (l.includes("right_side") || l === "right") keys.add("right_leg");
  if (l.includes("left") && !l.includes("right")) keys.add("left_leg");
  if (l.includes("right") && !l.includes("left")) keys.add("right_leg");
  return [...keys];
}

function resolveFlatLayUrl(
  position: string,
  panelFlatLayImages: Record<string, string> | undefined,
): string | undefined {
  if (!panelFlatLayImages) return undefined;
  for (const k of flatLayLookupKeys(position)) {
    if (panelFlatLayImages[k]) return panelFlatLayImages[k];
  }
  const lowerMap = Object.fromEntries(
    Object.entries(panelFlatLayImages).map(([k, v]) => [k.toLowerCase(), v]),
  );
  for (const k of flatLayLookupKeys(position)) {
    if (lowerMap[k.toLowerCase()]) return lowerMap[k.toLowerCase()];
  }
  return undefined;
}

/** Sew-safe dashed inner rect + solid outer (when SVG missing). */
function drawFallbackPanelOutline(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
) {
  ctx.save();
  ctx.strokeStyle = "rgba(30,30,30,0.85)";
  ctx.lineWidth = 2;
  ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
  drawSewSafeDashed(ctx, sx, sy, sw, sh);
  ctx.restore();
}

/**
 * Draw panel content (fill + artwork) masked to the SVG silhouette using
 * offscreen canvas compositing (destination-in).  The SVG's opaque areas
 * define the garment shape; transparent areas outside are clipped away so
 * the preview shows the actual panel silhouette instead of a rectangle.
 * When svgImg is null the function falls back to a rectangular clip.
 *
 * @param drawContent  Callback that draws fill + artwork onto the offscreen
 *                     canvas.  Coords are in offscreen space (origin = 0,0).
 */
function drawMaskedSlot(
  ctx: CanvasRenderingContext2D,
  svgImg: HTMLImageElement | null,
  sx: number, sy: number, sw: number, sh: number,
  drawContent: (offCtx: CanvasRenderingContext2D) => void,
): void {
  const iw = Math.max(1, Math.round(sw));
  const ih = Math.max(1, Math.round(sh));

  if (!svgImg) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(sx, sy, sw, sh);
    ctx.clip();
    drawContent(ctx);
    ctx.restore();
    drawFallbackPanelOutline(ctx, sx, sy, sw, sh);
    return;
  }

  // Render fill + artwork into an offscreen canvas, then mask to SVG alpha.
  const off = document.createElement("canvas");
  off.width = iw;
  off.height = ih;
  const offCtx = off.getContext("2d")!;

  // Content is drawn in offscreen space (slot origin = 0,0).
  offCtx.save();
  offCtx.translate(-sx, -sy);
  drawContent(offCtx);
  offCtx.restore();

  // Clip to garment silhouette via SVG alpha.
  offCtx.globalCompositeOperation = "destination-in";
  offCtx.drawImage(svgImg, 0, 0, iw, ih);
  offCtx.globalCompositeOperation = "source-over";

  // Composite masked result onto main canvas.
  ctx.drawImage(off, sx, sy, sw, sh);

  // Overlay SVG detail lines at low opacity for visible panel edges.
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.drawImage(svgImg, sx, sy, sw, sh);
  ctx.restore();
}

/** Inner dashed “safe / sew” line — drawn on top of SVG or flat fills. */
function drawSewSafeDashed(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
) {
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 1;
  const inset = Math.max(4, Math.min(sw, sh) * 0.04);
  ctx.strokeRect(sx + inset, sy + inset, sw - 2 * inset, sh - 2 * inset);
  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Tile motif in a rectangle with grid / brick / half-drop. `tilesAcross` = tiles across the rect width.
 */
function drawTiledMotifInRect(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  sx: number,
  sy: number,
  rw: number,
  rh: number,
  tilesAcross: number,
  patternType: PatternType,
) {
  const tileW = Math.max(4, rw / Math.max(1, tilesAcross));
  const tileH = tileW * (img.height / img.width);
  const cols = Math.ceil(rw / tileW) + 2;
  const rows = Math.ceil(rh / tileH) + 2;
  for (let row = -1; row < rows; row++) {
    for (let col = -1; col < cols; col++) {
      let x = col * tileW;
      let y = row * tileH;
      if (patternType === "brick" && (row & 1)) x += tileW * 0.5;
      if (patternType === "half" && (col & 1)) y += tileH * 0.5;
      ctx.drawImage(img, sx + x, sy + y, tileW, tileH);
    }
  }
}

// ── Snap helper ───────────────────────────────────────────────────────────────

/**
 * Given raw drag deltas and slot dimensions, apply centre-snap if the artwork
 * centre would land within SNAP_THRESHOLD_PX of the slot centre.
 * Returns the (possibly snapped) dx/dy values.
 */
function applySnap(dxPx: number, dyPx: number): { dxPx: number; dyPx: number } {
  const snappedX = Math.abs(dxPx) < SNAP_THRESHOLD_PX ? 0 : dxPx;
  const snappedY = Math.abs(dyPx) < SNAP_THRESHOLD_PX ? 0 : dyPx;
  return { dxPx: snappedX, dyPx: snappedY };
}

// ── Main component ────────────────────────────────────────────────────────────

interface PatternCustomizerProps {
  motifUrl: string;
  productWidth?: number;
  productHeight?: number;
  hasPairedPanels?: boolean;
  panelPositions?: Array<{ position: string; width: number; height: number }>;
  panelFlatLayImages?: Record<string, string>;
  fetchFn?: (url: string, options?: RequestInit) => Promise<Response>;
  initialTilesAcross?: number;
  initialPattern?: PatternType;
  initialBgColor?: string;
  onSettingsChange?: (settings: PatternApplyOptions) => void;
  initialPlacement?: AopPlacementSettings;
  onPlacementChange?: (placement: AopPlacementSettings) => void;
  onApply: (patternUrl: string, options: PatternApplyOptions) => void | Promise<void>;
  onCancel?: () => void;
  /** Optional row under Apply (e.g. Share + Edit pattern in embed). */
  footerSlot?: ReactNode;
  isLoading?: boolean;
  productTypeConfig?: { placeholderPositions?: Array<{ position: string; width: number; height: number }> };
}

export function PatternCustomizer({
  motifUrl,
  hasPairedPanels,
  panelPositions: panelPositionsProp,
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
  footerSlot,
  isLoading: externalLoading,
  productTypeConfig,
}: PatternCustomizerProps) {
  // Resolve panel positions from either direct prop or productTypeConfig
  const panelPositions = panelPositionsProp || productTypeConfig?.placeholderPositions || [];

  // ── Local state ────────────────────────────────────────────────────────────

  const [mode, setMode] = useState<EditorMode>("pattern");
  const [patternType, setPatternType] = useState<PatternType>(initialPattern || "grid");
  const [scale, setScale] = useState(initialTilesAcross || 5);
  const [bgColor, setBgColor] = useState(initialBgColor || "");
  const [applyLoading, setApplyLoading] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewWrapRef = useRef<HTMLDivElement>(null);
  const [previewPx, setPreviewPx] = useState(PREVIEW_PX_DEFAULT);
  const [motifImage, setMotifImage] = useState<HTMLImageElement | null>(null);
  const [svgImages, setSvgImages]   = useState<Record<string, HTMLImageElement>>({});

  // Per-panel placement transforms
  const [perPanelTransforms, setPerPanelTransforms] = useState<Record<string, PanelTransform>>(
    initialPlacement?.perPanelTransforms || {}
  );
  const [activePanel, setActivePanel] = useState<string | null>(
    initialPlacement?.activePanel || null
  );
  const [mirrorMode, setMirrorMode] = useState(initialPlacement?.mirrorMode ?? false);
  const [seamBleedPx, setSeamBleedPx] = useState(
    initialPlacement?.seamBleedPx ?? DEFAULT_SEAM_BLEED_PX
  );

  // Active view for hoodie (front / back / hood)
  const [activeView, setActiveView] = useState<"front" | "back" | "hood">("front");

  const productKind = panelPositions.length > 0 ? detectProductKind(panelPositions) : "generic";

  // ── Image loading ──────────────────────────────────────────────────────────

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload  = () => setMotifImage(img);
    img.onerror = () => console.error("[PatternCustomizer] Failed to load motif image");
    img.src = motifUrl;
  }, [motifUrl]);

  const [svgLoadErrors, setSvgLoadErrors] = useState<string[]>([]);

  useEffect(() => {
    const el = previewWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const s = Math.floor(Math.min(Math.max(w, 160), Math.max(h, 160), 1100));
      if (s >= 160) setPreviewPx(s);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!panelFlatLayImages || Object.keys(panelFlatLayImages).length === 0) {
      setSvgImages({});
      setSvgLoadErrors([]);
      return;
    }

    (async () => {
      const loaded: Record<string, HTMLImageElement> = {};
      const errors: string[] = [];

      const loadOne = async (name: string, url: string) => {
        if (fetchFn) {
          try {
            const res = await fetchFn(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const objUrl = URL.createObjectURL(blob);
            const img = new Image();
            await new Promise<void>((resolve, reject) => {
              img.onload = () => resolve();
              img.onerror = () => reject(new Error("img"));
              img.src = objUrl;
            });
            loaded[name] = img;
            return;
          } catch (e) {
            console.warn(`[PatternCustomizer] fetch SVG "${name}":`, e);
          }
        }
        const img = new Image();
        img.crossOrigin = "anonymous";
        try {
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("img"));
            img.src = url;
          });
          loaded[name] = img;
        } catch {
          const img2 = new Image();
          try {
            await new Promise<void>((resolve, reject) => {
              img2.onload = () => resolve();
              img2.onerror = () => reject(new Error("img"));
              img2.src = url;
            });
            loaded[name] = img2;
          } catch {
            errors.push(name);
            console.warn(`[PatternCustomizer] SVG load failed: ${name}`);
          }
        }
      };

      await Promise.all(
        Object.entries(panelFlatLayImages).map(([name, url]) => loadOne(name, url)),
      );

      if (cancelled) return;

      for (const p of panelPositions) {
        let ref: HTMLImageElement | undefined;
        for (const k of flatLayLookupKeys(p.position)) {
          if (loaded[k]) {
            ref = loaded[k];
            break;
          }
        }
        if (ref) {
          for (const a of flatLayLookupKeys(p.position)) {
            if (!loaded[a]) loaded[a] = ref;
          }
        }
      }

      setSvgImages(loaded);
      setSvgLoadErrors(errors);
    })();

    return () => {
      cancelled = true;
    };
  }, [panelFlatLayImages, fetchFn, panelPositions]);

  // Initialise panel transforms when positions become available
  useEffect(() => {
    if (panelPositions.length === 0) return;
    setPerPanelTransforms(prev => {
      const next = { ...prev };
      for (const p of panelPositions) {
        if (!next[p.position]) {
          next[p.position] = { dxPx: 0, dyPx: 0, scalePct: 100 };
        }
      }
      return next;
    });
    if (!activePanel) {
      // Leggings default: right leg. Hoodie default: front_right (the primary seam panel).
      const right = panelPositions.find(p => {
        const l = p.position.toLowerCase();
        return l.includes("right") && !l.includes("back");
      });
      setActivePanel(right?.position || panelPositions[0]?.position || null);
    }
  }, [panelPositions]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderPanelPreview = useCallback(
    (ctx: CanvasRenderingContext2D, img: HTMLImageElement, px: number, canvasH = px) => {
      const pad = 20;
      if (productKind === "hoodie") {
        const { compositeW, compositeH, slots } = buildCompositeLayout(activeView, panelPositions);
        if (compositeW === 0) return;
        const scl = Math.min((px - pad) / compositeW, (canvasH - pad) / compositeH, 1);
        const offX = (px - compositeW * scl) / 2;
        const offY = (canvasH - compositeH * scl) / 2;

        for (const slot of slots) {
          const sx = offX + slot.x * scl;
          const sy = offY + slot.y * scl;
          const sw = slot.w * scl;
          const sh = slot.h * scl;
          const hasSvg = !!getSvgImageForPosition(svgImages, slot.position);

          ctx.save();
          ctx.beginPath();
          ctx.rect(sx, sy, sw, sh);
          ctx.clip();
          if (hasSvg) {
            tryDrawSvgBackground(ctx, svgImages, slot.position, sx, sy, sw, sh);
          } else {
            ctx.fillStyle = bgColor && bgColor !== "transparent" ? bgColor : "#f4f4f5";
            ctx.fillRect(sx, sy, sw, sh);
          }

          const t = perPanelTransforms[slot.position] || { dxPx: 0, dyPx: 0, scalePct: 100 };
          const mirrorTarget = mirrorMode && isMirrorTarget(slot.position, slots);
          const sourcePos = mirrorTarget ? getMirrorSource(slot.position, slots) : null;
          const effectiveT = sourcePos ? (perPanelTransforms[sourcePos] || t) : t;

          drawArtworkInSlot(ctx, img, sx, sy, sw, sh, effectiveT, mirrorTarget);
          ctx.restore();

          if (hasSvg) {
            ctx.save();
            ctx.strokeStyle = "rgba(25,25,25,0.88)";
            ctx.lineWidth = 1.5;
            ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
            drawSewSafeDashed(ctx, sx, sy, sw, sh);
            ctx.restore();
          } else {
            drawFallbackPanelOutline(ctx, sx, sy, sw, sh);
          }
          drawActiveBorder(ctx, sx, sy, sw, sh, slot.position === activePanel);
          if (slot.position === activePanel) drawSnapGuides(ctx, sx, sy, sw, sh);
        }

        if (slots.length === 2) {
          const right = slots[0];
          const left = slots[1];
          const seamX = offX + (right.x + right.w) * scl + (left.x - right.x - right.w) * scl / 2;
          ctx.save();
          ctx.strokeStyle = "rgba(255,80,80,0.6)";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(seamX, offY);
          ctx.lineTo(seamX, offY + compositeH * scl);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }
      } else {
        const { compositeW, compositeH, slots } = buildLinearPanelsLayout(panelPositions);
        if (compositeW === 0) return;
        const scl = Math.min((px - pad) / compositeW, (canvasH - pad) / compositeH, 1);
        const offX = (px - compositeW * scl) / 2;
        const offY = (canvasH - compositeH * scl) / 2;

        const rightLegPos = panelPositions.find(p => {
          const l = p.position.toLowerCase();
          return l.includes("right") && (l.includes("leg") || l.includes("side"));
        })?.position;

        for (const slot of slots) {
          const sx = offX + slot.x * scl;
          const sy = offY + slot.y * scl;
          const sw = slot.w * scl;
          const sh = slot.h * scl;
          const svgImg = getSvgImageForPosition(svgImages, slot.position);

          const t = perPanelTransforms[slot.position] || { dxPx: 0, dyPx: 0, scalePct: 100 };
          const doMirror =
            mirrorMode &&
            isLeftLegPanelPosition(slot.position) &&
            !!rightLegPos;
          const effectiveT = doMirror ? (perPanelTransforms[rightLegPos] || t) : t;

          drawMaskedSlot(ctx, svgImg, sx, sy, sw, sh, (offCtx) => {
            const fill = bgColor && bgColor !== "transparent" ? bgColor : "#f4f4f5";
            offCtx.fillStyle = fill;
            offCtx.fillRect(sx, sy, sw, sh);
            drawArtworkInSlot(offCtx, img, sx, sy, sw, sh, effectiveT, doMirror);
          });

          drawActiveBorder(ctx, sx, sy, sw, sh, slot.position === activePanel);
          if (slot.position === activePanel) drawSnapGuides(ctx, sx, sy, sw, sh);
        }
      }
    },
    [productKind, panelPositions, activeView, svgImages, perPanelTransforms, activePanel, mirrorMode, bgColor],
  );

  const renderPatternMaskedPreview = useCallback(
    (ctx: CanvasRenderingContext2D, img: HTMLImageElement, px: number, canvasH = px) => {
      const pad = 20;
      const drawSlots = (slots: PanelSlot[], compositeW: number, compositeH: number) => {
        if (compositeW === 0) return;
        const scl = Math.min((px - pad) / compositeW, (canvasH - pad) / compositeH, 1);
        const offX = (px - compositeW * scl) / 2;
        const offY = (canvasH - compositeH * scl) / 2;

        for (const slot of slots) {
          const sx = offX + slot.x * scl;
          const sy = offY + slot.y * scl;
          const sw = slot.w * scl;
          const sh = slot.h * scl;
          const svgImg = getSvgImageForPosition(svgImages, slot.position);

          drawMaskedSlot(ctx, svgImg, sx, sy, sw, sh, (offCtx) => {
            const fill = bgColor && bgColor !== "transparent" ? bgColor : "#f4f4f5";
            offCtx.fillStyle = fill;
            offCtx.fillRect(sx, sy, sw, sh);
            drawTiledMotifInRect(offCtx, img, sx, sy, sw, sh, scale, patternType);
          });
        }
      };

      if (productKind === "hoodie") {
        const { compositeW, compositeH, slots } = buildCompositeLayout(activeView, panelPositions);
        drawSlots(slots, compositeW, compositeH);
      } else {
        const { compositeW, compositeH, slots } = buildLinearPanelsLayout(panelPositions);
        drawSlots(slots, compositeW, compositeH);
      }
    },
    [productKind, panelPositions, activeView, svgImages, bgColor, scale, patternType],
  );

  // ── Preview canvas render (after paint callbacks exist) ─────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !motifImage) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const px = previewPx;

    // Compute the aspect ratio of the panel composite so the canvas matches, eliminating
    // blank bars when panels are much wider than tall (e.g. leggings + waistbands) or vice versa.
    let canvasH = px;
    if (panelPositions.length > 0 && (mode === "place" || mode === "pattern")) {
      const layout =
        productKind === "hoodie"
          ? buildCompositeLayout(activeView, panelPositions)
          : buildLinearPanelsLayout(panelPositions);
      if (layout.compositeW > 0 && layout.compositeH > 0) {
        const ratio = layout.compositeH / layout.compositeW;
        // Constrain canvas height: never smaller than 30% of width or larger than 200%
        const clampedRatio = Math.min(2.0, Math.max(0.3, ratio));
        canvasH = Math.round(px * clampedRatio);
      }
    }

    canvas.width = px;
    canvas.height = canvasH;

    ctx.clearRect(0, 0, px, canvasH);
    if (bgColor && bgColor !== "transparent") {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, px, canvasH);
    }

    if (mode === "pattern" && panelPositions.length > 0) {
      renderPatternMaskedPreview(ctx, motifImage, px, canvasH);
    } else if (mode === "pattern") {
      const tileSize = (PREVIEW_INCHES * 96) / scale;
      for (let row = -1; row < Math.ceil(canvasH / tileSize) + 1; row++) {
        for (let col = -1; col < Math.ceil(px / tileSize) + 1; col++) {
          ctx.drawImage(motifImage, col * tileSize, row * tileSize, tileSize, tileSize);
        }
      }
    } else if (mode === "place" && panelPositions.length > 0) {
      renderPanelPreview(ctx, motifImage, px, canvasH);
    }
  }, [
    mode,
    scale,
    patternType,
    bgColor,
    motifImage,
    panelPositions,
    perPanelTransforms,
    activePanel,
    mirrorMode,
    svgImages,
    activeView,
    previewPx,
    renderPanelPreview,
    renderPatternMaskedPreview,
  ]);

  // ── Mirror helpers ─────────────────────────────────────────────────────────

  function isMirrorTarget(pos: string, slots: PanelSlot[]): boolean {
    if (!mirrorMode) return false;
    const l = pos.toLowerCase();
    return l.includes("left");
  }

  function getMirrorSource(pos: string, slots: PanelSlot[]): string | null {
    const pl = pos.toLowerCase();
    // Leggings panels often use left/right_side or left/right_leg without front/back grouping.
    if (pl.includes("left") && (pl.includes("side") || pl.includes("leg"))) {
      const rightLeg = slots.find(s => {
        const sl = s.position.toLowerCase();
        return sl.includes("right") && (sl.includes("side") || sl.includes("leg"));
      });
      if (rightLeg) return rightLeg.position;
    }
    const source = slots.find(s => {
      const sl = s.position.toLowerCase();
      // Match same group (front/hood/back) but opposite side
      const sameGroup = (sl.includes("front") && pl.includes("front")) ||
                        (sl.includes("hood")  && pl.includes("hood"))  ||
                        (sl.includes("back")  && pl.includes("back"));
      return sameGroup && sl.includes("right");
    });
    return source?.position || null;
  }

  // ── Drag handling ──────────────────────────────────────────────────────────

  // We track drag in canvas pixel space and translate to preview-canvas offsets.
  const dragRef = useRef<{
    active: boolean;
    startClientX: number;
    startClientY: number;
    startDx: number;
    startDy: number;
    panel: string;
  }>({ active: false, startClientX: 0, startClientY: 0, startDx: 0, startDy: 0, panel: "" });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const getEditablePanelForDrag = (panel: string): string => {
      if (!mirrorMode || !panel) return panel;
      const { slots } =
        productKind === "hoodie"
          ? buildCompositeLayout(activeView, panelPositions)
          : buildLinearPanelsLayout(panelPositions);
      const source = getMirrorSource(panel, slots);
      return source || panel;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (!activePanel || mode !== "place") return;
      const editPanel = getEditablePanelForDrag(activePanel);
      const t = perPanelTransforms[editPanel] || { dxPx: 0, dyPx: 0, scalePct: 100 };
      dragRef.current = {
        active: true,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startDx: t.dxPx,
        startDy: t.dyPx,
        panel: editPanel,
      };
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current.active) return;
      const rawDx = dragRef.current.startDx + (e.clientX - dragRef.current.startClientX);
      const rawDy = dragRef.current.startDy + (e.clientY - dragRef.current.startClientY);
      const { dxPx, dyPx } = applySnap(rawDx, rawDy);
      updatePanelTransform(dragRef.current.panel, { dxPx, dyPx });
    };

    const onMouseUp = () => { dragRef.current.active = false; };

    const onTouchStart = (e: TouchEvent) => {
      if (!activePanel || mode !== "place" || e.touches.length !== 1) return;
      const editPanel = getEditablePanelForDrag(activePanel);
      const t = perPanelTransforms[editPanel] || { dxPx: 0, dyPx: 0, scalePct: 100 };
      const touch = e.touches[0];
      dragRef.current = {
        active: true,
        startClientX: touch.clientX,
        startClientY: touch.clientY,
        startDx: t.dxPx,
        startDy: t.dyPx,
        panel: editPanel,
      };
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!dragRef.current.active || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const rawDx = dragRef.current.startDx + (touch.clientX - dragRef.current.startClientX);
      const rawDy = dragRef.current.startDy + (touch.clientY - dragRef.current.startClientY);
      const { dxPx, dyPx } = applySnap(rawDx, rawDy);
      updatePanelTransform(dragRef.current.panel, { dxPx, dyPx });
    };

    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup",   onMouseUp);
    canvas.addEventListener("touchstart", onTouchStart, { passive: true });
    canvas.addEventListener("touchmove",  onTouchMove,  { passive: false });
    window.addEventListener("touchend",   onMouseUp);

    return () => {
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup",   onMouseUp);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove",  onTouchMove);
      window.removeEventListener("touchend",   onMouseUp);
    };
  }, [activePanel, mode, perPanelTransforms, mirrorMode, productKind, activeView, panelPositions]); // eslint-disable-line react-hooks/exhaustive-deps

  const updatePanelTransform = useCallback(
    (position: string, partial: Partial<PanelTransform>) => {
      setPerPanelTransforms(prev => ({
        ...prev,
        [position]: { ...(prev[position] || { dxPx: 0, dyPx: 0, scalePct: 100 }), ...partial },
      }));
    },
    []
  );

  // Notify parent of placement changes
  useEffect(() => {
    if (!onPlacementChange) return;
    onPlacementChange({ perPanelTransforms, activePanel, mirrorMode, seamBleedPx });
  }, [perPanelTransforms, activePanel, mirrorMode, seamBleedPx]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep embed / parent in sync with pattern controls (tiles, type, background)
  useEffect(() => {
    if (!onSettingsChange) return;
    onSettingsChange({
      patternType,
      tilesAcross: scale,
      bgColor: bgColor || undefined,
    });
  }, [scale, patternType, bgColor, onSettingsChange]);

  // ── Full-res panel export ──────────────────────────────────────────────────

  /**
   * Render a single panel to a full-resolution canvas and return its dataUrl.
   * Used for non-seam panels (back, hood, leggings).
   * dxPx/dyPx are stored in preview-canvas pixel space; upscaled to print-pixel space here.
   */
  async function exportPanelImage(
    pos: { position: string; width: number; height: number },
    img: HTMLImageElement,
  ): Promise<string> {
    const canvas = document.createElement("canvas");
    canvas.width  = pos.width;
    canvas.height = pos.height;
    const ctx = canvas.getContext("2d")!;

    if (bgColor && bgColor !== "transparent") {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, pos.width, pos.height);
    }

    const t = perPanelTransforms[pos.position] || { dxPx: 0, dyPx: 0, scalePct: 100 };

    const px = previewPx;
    let previewSlotW = px;
    if (productKind === "hoodie") {
      const layout = buildCompositeLayout(getPanelGroup(pos.position), panelPositions);
      if (layout.compositeW > 0) {
        const scl = Math.min((px - 20) / layout.compositeW, (px - 20) / layout.compositeH, 1);
        const found = layout.slots.find(s => s.position === pos.position);
        if (found) previewSlotW = found.w * scl;
      }
    } else {
      const { compositeW, compositeH, slots } = buildLinearPanelsLayout(panelPositions);
      if (compositeW > 0) {
        const scl = Math.min((px - 20) / compositeW, (px - 20) / compositeH, 1);
        const found = slots.find(s => s.position === pos.position);
        if (found) previewSlotW = found.w * scl;
      }
    }
    const upscale = pos.width / (previewSlotW || pos.width);

    const printT: PanelTransform = {
      dxPx:     t.dxPx * upscale,
      dyPx:     t.dyPx * upscale,
      scalePct: t.scalePct,
    };

    const svgImg = getSvgImageForPosition(svgImages, pos.position);
    if (svgImg) ctx.drawImage(svgImg, 0, 0, pos.width, pos.height);

    drawArtworkInSlot(ctx, img, 0, 0, pos.width, pos.height, printT, false);

    return canvasToUploadDataUrl(canvas);
  }

  // ── Apply handler ──────────────────────────────────────────────────────────

  const handleApply = useCallback(async () => {
    if (!motifImage) return;
    setApplyLoading(true);
    try {
      if (mode !== "place" || panelPositions.length === 0) {
        const maxDim =
          panelPositions.length > 0
            ? Math.max(1500, ...panelPositions.flatMap(p => [p.width, p.height]))
            : 4096;
        const TILE_OUT = Math.min(4096, Math.max(2048, Math.ceil(maxDim * 1.2)));
        const canvas = document.createElement("canvas");
        canvas.width  = TILE_OUT;
        canvas.height = TILE_OUT;
        const ctx = canvas.getContext("2d")!;
        if (bgColor && bgColor !== "transparent") {
          ctx.fillStyle = bgColor;
          ctx.fillRect(0, 0, TILE_OUT, TILE_OUT);
        }
        drawTiledMotifInRect(ctx, motifImage, 0, 0, TILE_OUT, TILE_OUT, scale, patternType);
        const tiledDataUrl = canvasToUploadDataUrl(canvas, 4096);
        await onApply(tiledDataUrl, {
          mode,
          patternType,
          tilesAcross: scale,
          bgColor,
          perPanelTransforms,
        });
        return;
      }

      // Place on Item mode — generate full-res per-panel images
      const panelUrls: { position: string; dataUrl: string }[] = [];
      const seamPairs = getSeamPairs(panelPositions);

      // Track which positions are handled by composite export
      const compositeCovered = new Set<string>();

      // Seam-pair panels: render as a single composite then crop each side.
      // This guarantees artwork continuity across the seam with no pixel offset.
      for (const [leftPos, rightPos] of seamPairs) {
        const rightDef = panelPositions.find(p => p.position === rightPos);
        const leftDef  = panelPositions.find(p => p.position === leftPos);
        if (!rightDef || !leftDef) continue;

        const compositeW = rightDef.width + leftDef.width;
        const compositeH = Math.max(rightDef.height, leftDef.height);

        // Compute upscale from preview-canvas pixels to print pixels
        const view = getPanelGroup(rightPos);
        const layout = buildCompositeLayout(view, panelPositions);
        const layoutScl = layout.compositeW > 0
          ? Math.min((previewPx - 20) / layout.compositeW, (previewPx - 20) / layout.compositeH, 1)
          : 1;
        const rightPreviewSlotW = rightDef.width * layoutScl;
        const upscale = rightDef.width / (rightPreviewSlotW || rightDef.width);

        // Use the right panel transform scaled to print space
        const tRight = perPanelTransforms[rightPos] || { dxPx: 0, dyPx: 0, scalePct: 100 };
        const printT: PanelTransform = {
          dxPx: tRight.dxPx * upscale,
          dyPx: tRight.dyPx * upscale,
          scalePct: tRight.scalePct,
        };

        // Render composite canvas
        const compositeCanvas = document.createElement("canvas");
        compositeCanvas.width  = compositeW;
        compositeCanvas.height = compositeH;
        const ctx = compositeCanvas.getContext("2d")!;
        if (bgColor && bgColor !== "transparent") {
          ctx.fillStyle = bgColor;
          ctx.fillRect(0, 0, compositeW, compositeH);
        }

        // Draw SVG sew-pattern backgrounds
        const rightSvgImg = svgImages[rightPos] || svgImages[mapPositionToSvgName(rightPos)];
        const leftSvgImg  = svgImages[leftPos]  || svgImages[mapPositionToSvgName(leftPos)];
        if (rightSvgImg) ctx.drawImage(rightSvgImg, 0,              0, rightDef.width, rightDef.height);
        if (leftSvgImg)  ctx.drawImage(leftSvgImg,  rightDef.width, 0, leftDef.width,  leftDef.height);

        // Draw artwork in the full composite (ensures seam-edge continuity)
        drawArtworkInSlot(ctx, motifImage, 0, 0, compositeW, compositeH, printT, false);

        // Crop right panel canvas
        const cropRight = document.createElement("canvas");
        cropRight.width  = rightDef.width;
        cropRight.height = rightDef.height;
        cropRight.getContext("2d")!.drawImage(compositeCanvas,
          0, 0, rightDef.width, rightDef.height,
          0, 0, rightDef.width, rightDef.height
        );
        panelUrls.push({ position: rightPos, dataUrl: canvasToUploadDataUrl(cropRight) });

        // Crop left panel canvas (or mirror-flipped if mirrorMode is on)
        const cropLeft = document.createElement("canvas");
        cropLeft.width  = leftDef.width;
        cropLeft.height = leftDef.height;
        const ctxL = cropLeft.getContext("2d")!;
        if (mirrorMode) {
          // Mirror left from the composite right-panel crop
          ctxL.save();
          ctxL.translate(leftDef.width, 0);
          ctxL.scale(-1, 1);
          ctxL.drawImage(compositeCanvas,
            0, 0, leftDef.width, leftDef.height,
            0, 0, leftDef.width, leftDef.height
          );
          ctxL.restore();
        } else {
          ctxL.drawImage(compositeCanvas,
            rightDef.width, 0, leftDef.width, leftDef.height,
            0,              0, leftDef.width, leftDef.height
          );
        }
        panelUrls.push({ position: leftPos, dataUrl: canvasToUploadDataUrl(cropLeft) });

        compositeCovered.add(rightPos);
        compositeCovered.add(leftPos);
      }

      // Remaining panels: independent per-panel export
      // For leggings mirror mode: left leg mirrors the right leg's artwork
      for (const p of panelPositions) {
        if (compositeCovered.has(p.position)) continue;

        const isLeft = p.position.toLowerCase().includes("left");
        const isLeggings = productKind === "leggings";
        const doMirror = mirrorMode && isLeggings && isLeft;

        if (doMirror) {
          // Find the paired right panel
          const rightPanel = panelPositions.find(q => {
            const ql = q.position.toLowerCase();
            return ql.includes("right") &&
              (ql.includes("side") || ql.includes("leg")) &&
              !compositeCovered.has(q.position);
          });
          if (rightPanel) {
            // Render the right panel normally
            const rightDataUrl = await exportPanelImage(rightPanel, motifImage);
            // Mirror it for the left panel
            const mirrorCanvas = document.createElement("canvas");
            mirrorCanvas.width  = p.width;
            mirrorCanvas.height = p.height;
            const mCtx = mirrorCanvas.getContext("2d")!;
            const srcImg = new Image();
            await new Promise<void>(resolve => {
              srcImg.onload = () => resolve();
              srcImg.src = rightDataUrl;
            });
            mCtx.save();
            mCtx.translate(p.width, 0);
            mCtx.scale(-1, 1);
            mCtx.drawImage(srcImg, 0, 0, p.width, p.height);
            mCtx.restore();
            panelUrls.push({ position: p.position, dataUrl: canvasToUploadDataUrl(mirrorCanvas) });
            continue;
          }
        }

        const dataUrl = await exportPanelImage(p, motifImage);
        panelUrls.push({ position: p.position, dataUrl });
      }

      await onApply(motifUrl, {
        mode,
        panelUrls,
        mirrorLegs: mirrorMode,
        seamOffset: seamBleedPx,
        perPanelTransforms,
      });
    } catch (err) {
      console.error("[PatternCustomizer] Apply failed:", err);
    } finally {
      setApplyLoading(false);
    }
  }, [mode, motifImage, motifUrl, panelPositions, patternType, scale, bgColor,
      perPanelTransforms, mirrorMode, seamBleedPx, svgImages, productKind, onApply, previewPx]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Panel list for controls ────────────────────────────────────────────────

  const panelGroups: Record<string, Array<{ position: string; width: number; height: number }>> = {};
  for (const p of panelPositions) {
    const g = productKind === "hoodie" ? getPanelGroup(p.position) : "all";
    if (!panelGroups[g]) panelGroups[g] = [];
    panelGroups[g].push(p);
  }

  const isLoading = applyLoading || !!externalLoading;
  const activePanelT = activePanel ? (perPanelTransforms[activePanel] || { dxPx: 0, dyPx: 0, scalePct: 100 }) : null;

  // ── Render ─────────────────────────────────────────────────────────────────

  /** Radix Slider: Root > Track (span) > Range; Thumb is sibling span — no data-slot. */
  const sliderTrackClass =
    "mt-1 [&>span:first-child]:rounded-full [&>span:first-child]:ring-2 [&>span:first-child]:ring-foreground/35 [&>span:first-child]:bg-muted-foreground/25 dark:[&>span:first-child]:bg-muted-foreground/40 [&>span:first-child>span]:bg-foreground [&>span:last-child]:border-2 [&>span:last-child]:border-foreground [&>span:last-child]:bg-background";

  return (
    <div className="w-full h-full min-h-0 flex flex-col">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(220px,280px)] gap-4 p-2 sm:p-3 flex-1 min-h-0">
        {/* Preview — matches mockup column height when embedded */}
        <div className="flex flex-col min-h-0 min-w-0">
          <div
            ref={previewWrapRef}
            className="relative w-full flex-1 min-h-[min(480px,78vh)] max-h-[min(920px,88vh)] border-2 border-foreground/20 rounded-md bg-muted/50 flex items-center justify-center overflow-hidden"
          >
            <canvas
              ref={canvasRef}
              className="max-w-full max-h-full w-full h-full object-contain touch-none"
              style={{
                cursor: mode === "place" ? "grab" : "default",
                display: "block",
                touchAction: "none",
              }}
            />
          </div>

          {mode === "place" && productKind === "hoodie" && (() => {
            const availableViews = (["front", "back", "hood"] as const).filter(v =>
              panelPositions.some(p => getPanelGroup(p.position) === v)
            );
            if (availableViews.length < 2) return null;
            return (
              <div className="flex gap-1 mt-2">
                {availableViews.map(v => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setActiveView(v)}
                    className={`flex-1 px-2 py-1 text-xs rounded capitalize border transition-colors ${
                      activeView === v
                        ? "bg-foreground text-background border-foreground"
                        : "bg-background border-border text-muted-foreground"
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            );
          })()}

          {mode === "place" && svgLoadErrors.length > 0 && (
            <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">
              Panel shapes unavailable: {svgLoadErrors.join(", ")} — showing outline only.
            </p>
          )}
        </div>

        {/* Controls */}
        <div className="flex flex-col gap-4 min-w-0 overflow-x-hidden overflow-y-visible">
          <div className="flex gap-2">
            {(["pattern", "place"] as EditorMode[]).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 py-2 text-xs font-medium rounded-md border transition-colors ${
                  mode === m
                    ? "bg-foreground text-background border-foreground"
                    : "bg-background border-border text-muted-foreground hover:border-foreground/50"
                }`}
              >
                {m === "pattern" ? "Pattern" : "Place on Item"}
              </button>
            ))}
          </div>

          {mode === "pattern" && (
            <>
              <div>
                <Label className="text-xs">Pattern type</Label>
                <Select value={patternType} onValueChange={v => setPatternType(v as PatternType)}>
                  <SelectTrigger className="h-9 text-xs mt-1 border-foreground/20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PATTERN_OPTIONS.map(opt => (
                      <SelectItem key={opt.value} value={opt.value} className="text-xs">
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Scale (tiles across): {scale}</Label>
                <Slider
                  value={[scale]}
                  onValueChange={v => setScale(v[0])}
                  min={1}
                  max={10}
                  className={sliderTrackClass}
                />
              </div>
            </>
          )}

          {mode === "place" && (
            <>
              {activePanelT && activePanel && (
                <div>
                  <Label className="text-xs">Artwork scale: {activePanelT.scalePct}%</Label>
                  <Slider
                    value={[activePanelT.scalePct]}
                    onValueChange={v => updatePanelTransform(activePanel, { scalePct: v[0] })}
                    min={20}
                    max={200}
                    step={5}
                    className={sliderTrackClass}
                  />
                </div>
              )}

              {activePanelT && activePanel && (
                <button
                  type="button"
                  onClick={() => updatePanelTransform(activePanel, { dxPx: 0, dyPx: 0, scalePct: 100 })}
                  className="text-xs text-muted-foreground underline text-left"
                >
                  Reset panel
                </button>
              )}

              <div className="flex items-center justify-between gap-2 rounded-md border-2 border-foreground/30 px-2 py-1.5 bg-background">
                <Label htmlFor="aop-mirror" className="text-xs cursor-pointer">
                  Mirror paired panel
                </Label>
                <Switch
                  id="aop-mirror"
                  checked={mirrorMode}
                  onCheckedChange={setMirrorMode}
                  className="shrink-0 border-2 border-foreground/35 data-[state=unchecked]:bg-muted/80"
                />
              </div>

              {getSeamPairs(panelPositions).length > 0 && (
                <div>
                  <Label className="text-xs">Seam bleed: {seamBleedPx}px</Label>
                  <Slider
                    value={[seamBleedPx]}
                    onValueChange={v => setSeamBleedPx(v[0])}
                    min={0}
                    max={200}
                    step={5}
                    className={sliderTrackClass}
                  />
                </div>
              )}
            </>
          )}

          <div>
            <Label className="text-xs">Background</Label>
            <div className="flex gap-2 mt-1 items-stretch">
              <Select
                value={bgColor === "" ? "transparent" : bgColor}
                onValueChange={v => setBgColor(v === "transparent" ? "" : v)}
              >
                <SelectTrigger className="h-9 text-xs flex-1 border-foreground/20">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {BG_PRESETS.map(p => (
                    <SelectItem key={p.value} value={p.value} className="text-xs">
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input
                type="color"
                aria-label="Custom background colour"
                value={bgColor === "" ? "#ffffff" : bgColor}
                onChange={e => setBgColor(e.target.value)}
                className="w-10 h-9 shrink-0 rounded border-2 border-foreground/25 cursor-pointer bg-background"
              />
            </div>
          </div>

          {mode === "place" && panelPositions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {panelPositions.map(p => (
                <button
                  key={p.position}
                  type="button"
                  onClick={() => setActivePanel(p.position)}
                  className={`px-2.5 py-1 text-[11px] rounded-md border transition-colors ${
                    activePanel === p.position
                      ? "border-foreground bg-foreground text-background"
                      : "border-border text-muted-foreground hover:border-foreground/40"
                  }`}
                >
                  {p.position.replace(/_/g, " ")}
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-3 pt-3">
            <Button
              type="button"
              onClick={handleApply}
              disabled={isLoading}
              size="sm"
              className="w-full shrink-0 overflow-hidden"
            >
              {isLoading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Apply
            </Button>
            {onCancel && (
              <Button type="button" onClick={onCancel} variant="outline" size="sm" className="w-full">
                Cancel
              </Button>
            )}
            {footerSlot && (
              <div className="flex flex-wrap gap-2 justify-center w-full min-w-0">{footerSlot}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
