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

import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Loader2 } from "lucide-react";
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

/** Logical pixel size of the preview canvas element */
const PREVIEW_PX = 280;

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

/** Snap threshold in CSS pixels — snaps when artwork centre is within this distance. */
const SNAP_THRESHOLD_PX = 10;

// ── Panel geometry helpers ────────────────────────────────────────────────────

interface PanelSlot { position: string; x: number; y: number; w: number; h: number }

function detectProductKind(
  panels: Array<{ position: string }>
): "hoodie" | "leggings" | "generic" {
  const p = panels.map(x => x.position.toLowerCase());
  if (p.some(x => x.includes("hood") || x.includes("front_") || x.includes("back_"))) return "hoodie";
  if (p.some(x => x.includes("_side") || x.includes("_leg"))) return "leggings";
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

/** Draw the SVG sew-pattern shape as a background (or clip mask). */
function drawSvgBackground(
  ctx: CanvasRenderingContext2D,
  svgImages: Record<string, HTMLImageElement>,
  position: string,
  slotX: number, slotY: number, slotW: number, slotH: number,
) {
  const svgName = mapPositionToSvgName(position);
  const svgImg  = svgImages[svgName] || svgImages[position];
  if (svgImg) {
    ctx.drawImage(svgImg, slotX, slotY, slotW, slotH);
  }
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
    if (!panelFlatLayImages || Object.keys(panelFlatLayImages).length === 0) return;
    const loaded: Record<string, HTMLImageElement> = {};
    const errors: string[] = [];
    let pending = Object.keys(panelFlatLayImages).length;
    for (const [name, url] of Object.entries(panelFlatLayImages)) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        loaded[name] = img;
        pending--;
        if (pending === 0) {
          setSvgImages({ ...loaded });
          if (errors.length > 0) setSvgLoadErrors(errors);
        }
      };
      img.onerror = () => {
        console.warn(`[PatternCustomizer] SVG load failed for position "${name}": ${url.substring(0, 80)}`);
        errors.push(name);
        pending--;
        if (pending === 0) {
          setSvgImages({ ...loaded });
          setSvgLoadErrors(errors);
        }
      };
      img.src = url;
    }
  }, [panelFlatLayImages]);

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

  // ── Preview canvas render ──────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !motifImage) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width  = PREVIEW_PX;
    canvas.height = PREVIEW_PX;

    ctx.clearRect(0, 0, PREVIEW_PX, PREVIEW_PX);
    if (bgColor && bgColor !== "transparent") {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, PREVIEW_PX, PREVIEW_PX);
    }

    if (mode === "pattern") {
      const tileSize = (PREVIEW_INCHES * 96) / scale;
      for (let row = -1; row < Math.ceil(PREVIEW_PX / tileSize) + 1; row++) {
        for (let col = -1; col < Math.ceil(PREVIEW_PX / tileSize) + 1; col++) {
          ctx.drawImage(motifImage, col * tileSize, row * tileSize, tileSize, tileSize);
        }
      }
    } else if (mode === "place" && panelPositions.length > 0) {
      renderPanelPreview(ctx, motifImage);
    }
  }, [mode, scale, bgColor, motifImage, panelPositions, perPanelTransforms, activePanel, mirrorMode, svgImages, activeView]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderPanelPreview = useCallback(
    (ctx: CanvasRenderingContext2D, img: HTMLImageElement) => {
      if (productKind === "hoodie") {
        const { compositeW, compositeH, slots } = buildCompositeLayout(activeView, panelPositions);
        if (compositeW === 0) return;
        const scl = Math.min((PREVIEW_PX - 20) / compositeW, (PREVIEW_PX - 20) / compositeH, 1);
        const offX = (PREVIEW_PX - compositeW * scl) / 2;
        const offY = (PREVIEW_PX - compositeH * scl) / 2;

        for (const slot of slots) {
          const sx = offX + slot.x * scl;
          const sy = offY + slot.y * scl;
          const sw = slot.w * scl;
          const sh = slot.h * scl;

          // Background (SVG sew pattern)
          ctx.save();
          ctx.beginPath(); ctx.rect(sx, sy, sw, sh); ctx.clip();
          drawSvgBackground(ctx, svgImages, slot.position, sx, sy, sw, sh);

          // Artwork: determine if this panel is the mirror target
          const t = perPanelTransforms[slot.position] || { dxPx: 0, dyPx: 0, scalePct: 100 };
          const mirrorTarget = mirrorMode && isMirrorTarget(slot.position, slots);
          const sourcePos    = mirrorTarget ? getMirrorSource(slot.position, slots) : null;
          const effectiveT   = sourcePos ? (perPanelTransforms[sourcePos] || t) : t;

          drawArtworkInSlot(ctx, img, sx, sy, sw, sh, effectiveT, mirrorTarget);
          ctx.restore();

          drawActiveBorder(ctx, sx, sy, sw, sh, slot.position === activePanel);
          if (slot.position === activePanel) drawSnapGuides(ctx, sx, sy, sw, sh);
        }

        // Seam centre indicator between paired panels
        if (slots.length === 2) {
          const right = slots[0]; const left = slots[1];
          const seamX = offX + (right.x + right.w) * scl + (left.x - right.x - right.w) * scl / 2;
          ctx.save();
          ctx.strokeStyle = "rgba(255,80,80,0.6)";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(seamX, offY); ctx.lineTo(seamX, offY + compositeH * scl); ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }
      } else {
        // Leggings (or generic paired panels)
        const { leftLeg, rightLeg, gap } = buildLeggingsLayout(panelPositions);
        const totalW = (leftLeg?.w || 0) + gap + (rightLeg?.w || 0);
        const totalH = Math.max(leftLeg?.h || 0, rightLeg?.h || 0);
        if (totalW === 0) return;
        const scl  = Math.min((PREVIEW_PX - 20) / totalW, (PREVIEW_PX - 20) / totalH, 1);
        const offX = (PREVIEW_PX - totalW * scl) / 2;
        const offY = (PREVIEW_PX - totalH * scl) / 2;

        for (const leg of [rightLeg, leftLeg]) {
          if (!leg) continue;
          const sx = offX + leg.x * scl;
          const sy = offY + leg.y * scl;
          const sw = leg.w * scl;
          const sh = leg.h * scl;

          ctx.save();
          ctx.beginPath(); ctx.rect(sx, sy, sw, sh); ctx.clip();
          drawSvgBackground(ctx, svgImages, leg.position, sx, sy, sw, sh);

          const t = perPanelTransforms[leg.position] || { dxPx: 0, dyPx: 0, scalePct: 100 };
          const isLeft = leg.position.toLowerCase().includes("left");
          const doMirror = mirrorMode && isLeft;
          const effectiveT = doMirror
            ? (perPanelTransforms[rightLeg?.position || ""] || t)
            : t;

          drawArtworkInSlot(ctx, img, sx, sy, sw, sh, effectiveT, doMirror);
          ctx.restore();

          drawActiveBorder(ctx, sx, sy, sw, sh, leg.position === activePanel);
          if (leg.position === activePanel) drawSnapGuides(ctx, sx, sy, sw, sh);
        }
      }
    },
    [productKind, panelPositions, activeView, svgImages, perPanelTransforms, activePanel, mirrorMode]
  );

  // ── Mirror helpers ─────────────────────────────────────────────────────────

  function isMirrorTarget(pos: string, slots: PanelSlot[]): boolean {
    if (!mirrorMode) return false;
    const l = pos.toLowerCase();
    return l.includes("left");
  }

  function getMirrorSource(pos: string, slots: PanelSlot[]): string | null {
    const source = slots.find(s => {
      const sl = s.position.toLowerCase();
      const pl = pos.toLowerCase();
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

    const onMouseDown = (e: MouseEvent) => {
      if (!activePanel || mode !== "place") return;
      const t = perPanelTransforms[activePanel] || { dxPx: 0, dyPx: 0, scalePct: 100 };
      dragRef.current = {
        active: true,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startDx: t.dxPx,
        startDy: t.dyPx,
        panel: activePanel,
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
      const t = perPanelTransforms[activePanel] || { dxPx: 0, dyPx: 0, scalePct: 100 };
      const touch = e.touches[0];
      dragRef.current = {
        active: true,
        startClientX: touch.clientX,
        startClientY: touch.clientY,
        startDx: t.dxPx,
        startDy: t.dyPx,
        panel: activePanel,
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
  }, [activePanel, mode, perPanelTransforms]); // eslint-disable-line react-hooks/exhaustive-deps

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

    // Compute upscale factor: preview slot width → print width
    let previewSlotW = PREVIEW_PX;
    if (productKind === "hoodie") {
      const layout = buildCompositeLayout(getPanelGroup(pos.position), panelPositions);
      if (layout.compositeW > 0) {
        const scl = Math.min((PREVIEW_PX - 20) / layout.compositeW, (PREVIEW_PX - 20) / layout.compositeH, 1);
        const found = layout.slots.find(s => s.position === pos.position);
        if (found) previewSlotW = found.w * scl;
      }
    } else {
      const { leftLeg, rightLeg, gap } = buildLeggingsLayout(panelPositions);
      const totalW = (leftLeg?.w || 0) + gap + (rightLeg?.w || 0);
      const totalH = Math.max(leftLeg?.h || 0, rightLeg?.h || 0);
      if (totalW > 0) {
        const scl = Math.min((PREVIEW_PX - 20) / totalW, (PREVIEW_PX - 20) / totalH, 1);
        previewSlotW = pos.width * scl;
      }
    }
    const upscale = pos.width / (previewSlotW || pos.width);

    const printT: PanelTransform = {
      dxPx:     t.dxPx * upscale,
      dyPx:     t.dyPx * upscale,
      scalePct: t.scalePct,
    };

    // Draw SVG background if available
    const svgName = mapPositionToSvgName(pos.position);
    const svgImg  = svgImages[svgName] || svgImages[pos.position];
    if (svgImg) ctx.drawImage(svgImg, 0, 0, pos.width, pos.height);

    drawArtworkInSlot(ctx, img, 0, 0, pos.width, pos.height, printT, false);

    return canvas.toDataURL("image/png");
  }

  // ── Apply handler ──────────────────────────────────────────────────────────

  const handleApply = useCallback(async () => {
    if (!motifImage) return;
    setApplyLoading(true);
    try {
      if (mode !== "place" || panelPositions.length === 0) {
        // Pattern mode — generate a tiled raster image at reasonable resolution
        // and pass it as the patternUrl so all AOP panels use the tiled version.
        const TILE_OUT = 1200;
        const canvas = document.createElement("canvas");
        canvas.width  = TILE_OUT;
        canvas.height = TILE_OUT;
        const ctx = canvas.getContext("2d")!;
        if (bgColor && bgColor !== "transparent") {
          ctx.fillStyle = bgColor;
          ctx.fillRect(0, 0, TILE_OUT, TILE_OUT);
        }
        const tileSize = Math.round(TILE_OUT / scale);
        for (let row = -1; row < Math.ceil(TILE_OUT / tileSize) + 1; row++) {
          for (let col = -1; col < Math.ceil(TILE_OUT / tileSize) + 1; col++) {
            ctx.drawImage(motifImage, col * tileSize, row * tileSize, tileSize, tileSize);
          }
        }
        const tiledDataUrl = canvas.toDataURL("image/png");
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
          ? Math.min((PREVIEW_PX - 20) / layout.compositeW, (PREVIEW_PX - 20) / layout.compositeH, 1)
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
        const rightSvgImg = svgImages[mapPositionToSvgName(rightPos)] || svgImages[rightPos];
        const leftSvgImg  = svgImages[mapPositionToSvgName(leftPos)]  || svgImages[leftPos];
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
        panelUrls.push({ position: rightPos, dataUrl: cropRight.toDataURL("image/png") });

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
        panelUrls.push({ position: leftPos, dataUrl: cropLeft.toDataURL("image/png") });

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
            panelUrls.push({ position: p.position, dataUrl: mirrorCanvas.toDataURL("image/png") });
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
      perPanelTransforms, mirrorMode, seamBleedPx, svgImages, productKind, onApply]); // eslint-disable-line react-hooks/exhaustive-deps

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

  return (
    <div className="w-full h-full flex flex-col">
      {/* Mode tabs */}
      <div className="flex gap-1 px-4 pt-3 pb-1 border-b">
        {(["pattern", "place"] as EditorMode[]).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
              mode === m
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {m === "pattern" ? "Pattern" : "Place on Item"}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[1fr_200px] gap-4 p-4 flex-1 min-h-0">
        {/* Left: preview canvas */}
        <div className="flex flex-col gap-2">
          <div
            className="relative border border-border rounded bg-muted flex items-center justify-center overflow-hidden"
            style={{ aspectRatio: "1/1", width: "100%" }}
          >
            <canvas
              ref={canvasRef}
              className="max-w-full max-h-full touch-none"
              style={{
                cursor: mode === "place" ? "grab" : "default",
                display: "block",
                touchAction: "none",
              }}
            />
          </div>

          {/* Hoodie view tabs */}
          {mode === "place" && productKind === "hoodie" && (() => {
            const availableViews = (["front", "back", "hood"] as const).filter(v =>
              panelPositions.some(p => getPanelGroup(p.position) === v)
            );
            if (availableViews.length < 2) return null;
            return (
              <div className="flex gap-1">
                {availableViews.map(v => (
                  <button
                    key={v}
                    onClick={() => setActiveView(v)}
                    className={`px-2 py-0.5 text-xs rounded capitalize transition-colors ${
                      activeView === v
                        ? "bg-foreground text-background"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            );
          })()}

          {/* Panel selector for place mode */}
          {/* SVG load diagnostic warning */}
          {mode === "place" && svgLoadErrors.length > 0 && (
            <p className="text-[10px] text-amber-600 dark:text-amber-400 px-1">
              Panel shapes unavailable: {svgLoadErrors.join(", ")}
            </p>
          )}

          {mode === "place" && panelPositions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {panelPositions.map(p => (
                <button
                  key={p.position}
                  onClick={() => setActivePanel(p.position)}
                  className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                    activePanel === p.position
                      ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                      : "border-border text-muted-foreground hover:border-foreground"
                  }`}
                >
                  {p.position.replace(/_/g, " ")}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right: controls */}
        <div className="flex flex-col gap-3 overflow-y-auto">

          {mode === "pattern" && (
            <>
              <div>
                <Label className="text-xs">Pattern</Label>
                <Select value={patternType} onValueChange={v => setPatternType(v as PatternType)}>
                  <SelectTrigger className="h-8 text-xs">
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
                <Label className="text-xs">Scale: {scale}</Label>
                <Slider value={[scale]} onValueChange={v => setScale(v[0])} min={1} max={10} className="mt-1" />
              </div>
            </>
          )}

          {mode === "place" && (
            <>
              {activePanelT && activePanel && (
                <div>
                  <Label className="text-xs">Scale: {activePanelT.scalePct}%</Label>
                  <Slider
                    value={[activePanelT.scalePct]}
                    onValueChange={v => updatePanelTransform(activePanel, { scalePct: v[0] })}
                    min={20} max={200} step={5}
                    className="mt-1"
                  />
                </div>
              )}

              {activePanelT && activePanel && (
                <button
                  onClick={() => updatePanelTransform(activePanel, { dxPx: 0, dyPx: 0, scalePct: 100 })}
                  className="text-xs underline text-muted-foreground text-left"
                >
                  Reset panel
                </button>
              )}

              <div className="flex items-center gap-2">
                <Label className="text-xs flex-1">Mirror panels</Label>
                <button
                  onClick={() => setMirrorMode(m => !m)}
                  className={`relative w-9 h-5 rounded-full transition-colors ${mirrorMode ? "bg-foreground" : "bg-muted border border-border"}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full transition-transform ${mirrorMode ? "bg-background translate-x-4" : "bg-muted-foreground translate-x-0.5"}`} />
                </button>
              </div>

              {getSeamPairs(panelPositions).length > 0 && (
                <div>
                  <Label className="text-xs">Seam bleed: {seamBleedPx}px</Label>
                  <Slider
                    value={[seamBleedPx]}
                    onValueChange={v => setSeamBleedPx(v[0])}
                    min={0} max={200} step={5}
                    className="mt-1"
                  />
                </div>
              )}
            </>
          )}

          {/* Background */}
          <div>
            <Label className="text-xs">Background</Label>
            <div className="flex gap-1 mt-1">
              <Select
                value={bgColor === "" ? "transparent" : bgColor}
                onValueChange={v => setBgColor(v === "transparent" ? "" : v)}
              >
                <SelectTrigger className="h-8 text-xs flex-1">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {BG_PRESETS.map(p => (
                    <SelectItem key={p.value} value={p.value} className="text-xs">{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input
                type="color"
                value={bgColor === "" ? "#ffffff" : bgColor}
                onChange={e => setBgColor(e.target.value)}
                className="w-8 h-8 rounded border border-border cursor-pointer"
                title="Custom colour"
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2 mt-auto pt-2">
            <Button onClick={handleApply} disabled={isLoading} size="sm" className="w-full">
              {isLoading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Apply
            </Button>
            {onCancel && (
              <Button onClick={onCancel} variant="outline" size="sm" className="w-full">
                Cancel
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
