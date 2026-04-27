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

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Loader2, Pipette } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PanelTransform, AopPlacementSettings, PanelRenderConfig } from "./types";
import { detectProductKind, type AopLayoutKind } from "./aopTemplates/detectLayoutKind";
import { resolveAopLayoutKind } from "./aopTemplates/registry";

// ── Public types ──────────────────────────────────────────────────────────────

export type PatternType = "grid" | "brick" | "half";
export type EditorMode = "pattern" | "single" | "place";

export interface PatternApplyOptions {
  panelUrls?: { position: string; dataUrl: string }[];
  /** High-res per-panel images for fulfillment (saved on job); mockup API uses `panelUrls` only. */
  printPanelUrls?: { position: string; dataUrl: string }[];
  /** Lazily build fulfillment assets after the preview request is already in flight. */
  getPrintPanelUrls?: () => Promise<{ position: string; dataUrl: string }[]>;
  mirrorLegs?: boolean;
  seamOffset?: number;
  mode?: EditorMode;
  patternType?: PatternType;
  tilesAcross?: number;
  tileInches?: number;
  bgColor?: string;
  perPanelTransforms?: Record<string, PanelTransform>;
  panelRenderConfig?: Record<string, PanelRenderConfig>;
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

/** Safe-print margin in inches (Printify standard sew allowance). */
const SAFE_AREA_INCHES = 0.25;

/**
 * Extra vertical offset applied in export only (print pixels), for blueprint tuning.
 * Keep at 0 unless Printify mockups show a consistent systematic Y shift vs editor.
 */
const LEGGINGS_EXPORT_DY_OFFSET_PX = 0;

/** Smallest tile size shown on the slider (smaller values are unusable in preview / print). */
const MIN_TILE_INCHES = 0.5;

/**
 * Default seam bleed in print pixels (~1 cm at 150 DPI).
 * Each split panel (front_right, front_left, right_hood, left_hood) gets this many
 * extra pixels of artwork past the seam edge so the artwork remains continuous
 * across the sewn seam even with slight manufacturing misalignment.
 */
const DEFAULT_SEAM_BLEED_PX = 70;

/** Max long-edge for AOP panels sent to Printify mockup API (fast upload). */
const MAX_PANEL_MOCKUP_PX = 1100;
/** Mobile-friendly preview cap: smaller payloads, still sharp enough for mockups. */
const MOBILE_MOCKUP_PANEL_PX = 900;
/** Max long-edge for persisted print assets (native template up to this cap). */
const MAX_PANEL_PRINT_PX = 9000;
/** Solid-colour panels can be compact; Printify scales the image to the placeholder. */
const SOLID_PANEL_LONG_EDGE_PX = 256;

/** Base row gap for non-special hoodie composite rows (print px). */
export const HOODIE_COMPOSITE_GAP_PX = 0;

/**
 * Front zip seam: small visible center gap (print px). Keep this tight so the
 * two chest halves fill the preview width while meeting close to seam-to-seam.
 */
export const HOODIE_FRONT_CENTER_GAP_PX = 40;

/** Hood center seam: small visible center gap (print px). */
export const HOODIE_HOOD_CENTER_GAP_PX = 40;

/**
 * Gutter (CSS/canvas px) between the preview border and the scaled composite; keep small
 * so panels read large in the box (like the leggings reference), without clipping the dashed guides.
 */
export const HOODIE_PREVIEW_PAD = 2;

/**
 * After preview→print mapping, nudge artwork on split L/R panels slightly away from the centre
 * sew line (print px). Reduces edge placement that sits “on” the dashed seam but trims in production.
 */
const HOODIE_SEAM_SAFETY_NUDGE_PRINT_PX = DEFAULT_SEAM_BLEED_PX;

/** Cuffs / placket / waistband / sleeves: solid in default config, not part of the L/R seam row. */
function isHoodieTrimPanel(position: string): boolean {
  const lower = position.toLowerCase();
  return (
    lower.includes("cuff") ||
    lower.includes("waistband") ||
    lower.includes("placket") ||
    lower.includes("sleeve")
  );
}

function isHoodiePocketPanel(position: string): boolean {
  return position.toLowerCase().includes("pocket");
}

function isPrimaryHoodieArtworkPanel(position: string): boolean {
  return !isHoodieTrimPanel(position) && !isHoodiePocketPanel(position);
}

/**
 * “Supporting” = trim or pocket (excluded from the main 2-up seam row; pocket is placed in a second row).
 * @deprecated Use {@link isHoodieTrimPanel} / {@link isHoodiePocketPanel} for new logic.
 */
function isHoodieSupportingPanel(position: string): boolean {
  return isHoodieTrimPanel(position) || isHoodiePocketPanel(position);
}

/**
 * Map print-space composite → square preview pixels (letterbox: full composite always fits;
 * no clipping at the frame edge — matches reference mocks).
 */
function scaleHoodieCompositeToCanvas(
  pad: number,
  canvasW: number,
  canvasH: number,
  compositeW: number,
  compositeH: number,
): number {
  if (compositeW <= 0 || compositeH <= 0) return 1;
  return Math.min((canvasW - pad) / compositeW, (canvasH - pad) / compositeH);
}

function getHoodieTwoUpCenterGapPx(
  view: HoodiePanelView,
): number {
  if (view === "hood") return HOODIE_HOOD_CENTER_GAP_PX;
  if (view === "front") return HOODIE_FRONT_CENTER_GAP_PX;
  return HOODIE_COMPOSITE_GAP_PX;
}

function nudgeHoodieSeamExportDx(productKind: AopLayoutKind, position: string, dxPrintPx: number): number {
  if (productKind !== "hoodie") return dxPrintPx;
  const l = position.toLowerCase();
  if (l.includes("back") || isHoodieTrimPanel(position) || isHoodiePocketPanel(position)) return dxPrintPx;
  const hasRight = l.includes("right");
  const hasLeft = l.includes("left");
  if (!hasRight && !hasLeft) return dxPrintPx;
  if (hasRight && hasLeft) return dxPrintPx;
  if (hasRight) return dxPrintPx + HOODIE_SEAM_SAFETY_NUDGE_PRINT_PX;
  return dxPrintPx - HOODIE_SEAM_SAFETY_NUDGE_PRINT_PX;
}

function getAdaptiveMockupPanelPx(): number {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return MAX_PANEL_MOCKUP_PX;
  }
  const nav = navigator as Navigator & { deviceMemory?: number };
  const ua = nav.userAgent || "";
  const coarsePointer =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)").matches
      : false;
  const narrowViewport = window.innerWidth <= 1024;
  const lowMemory = typeof nav.deviceMemory === "number" && nav.deviceMemory <= 4;
  const likelyMobile =
    /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (coarsePointer && narrowViewport);
  return likelyMobile || lowMemory ? MOBILE_MOCKUP_PANEL_PX : MAX_PANEL_MOCKUP_PX;
}

/**
 * Encode canvas as PNG for AOP panel export.
 * PNG is required (not JPEG) because JPEG has no alpha channel — a transparent or
 * empty canvas encodes as solid black in JPEG, which Printify then applies as a
 * completely black print. PNG preserves transparency so Printify can fall back
 * to the garment colour rather than flooding it black. Downscale if over max dimension.
 */
function canvasToUploadDataUrl(canvas: HTMLCanvasElement, maxDim = MAX_PANEL_MOCKUP_PX): string {
  let w = canvas.width;
  let h = canvas.height;
  if (w <= 0 || h <= 0) return canvas.toDataURL("image/png");
  if (Math.max(w, h) <= maxDim) {
    return canvas.toDataURL("image/png");
  }
  const scale = maxDim / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = document.createElement("canvas");
  out.width = nw;
  out.height = nh;
  const octx = out.getContext("2d");
  if (!octx) return canvas.toDataURL("image/png");
  octx.drawImage(canvas, 0, 0, nw, nh);
  return out.toDataURL("image/png");
}

/** Snap threshold in CSS pixels — snaps when artwork centre is within this distance. */
const SNAP_THRESHOLD_PX = 10;

// ── Panel geometry helpers ────────────────────────────────────────────────────

interface PanelSlot { position: string; x: number; y: number; w: number; h: number }
type SvgVisibleBounds = { x: number; y: number; w: number; h: number };

const svgVisibleBoundsCache = new WeakMap<HTMLImageElement, SvgVisibleBounds | null>();

type HoodiePanelView = "front" | "back" | "hood";
type HoodiePatternSpec = { tileInches: number; offsetX: number };

function getPanelGroup(position: string): "front" | "back" | "hood" {
  const l = position.toLowerCase();
  if (l.includes("hood")) return "hood";
  if (l.includes("back")) return "back";
  return "front";
}

function getSvgVisibleBounds(img: HTMLImageElement | null): SvgVisibleBounds | null {
  if (!img) return null;
  if (svgVisibleBoundsCache.has(img)) return svgVisibleBoundsCache.get(img) ?? null;

  const natW = img.naturalWidth || img.width;
  const natH = img.naturalHeight || img.height;
  if (natW <= 0 || natH <= 0) {
    svgVisibleBoundsCache.set(img, null);
    return null;
  }

  const maxSample = 512;
  const sampleScale = Math.min(1, maxSample / Math.max(natW, natH));
  const sampleW = Math.max(1, Math.round(natW * sampleScale));
  const sampleH = Math.max(1, Math.round(natH * sampleScale));

  try {
    const canvas = document.createElement("canvas");
    canvas.width = sampleW;
    canvas.height = sampleH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      svgVisibleBoundsCache.set(img, null);
      return null;
    }
    ctx.drawImage(img, 0, 0, sampleW, sampleH);
    const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
    let minX = sampleW;
    let minY = sampleH;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < sampleH; y++) {
      for (let x = 0; x < sampleW; x++) {
        if (data[(y * sampleW + x) * 4 + 3] > 8) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }

    if (maxX < minX || maxY < minY) {
      svgVisibleBoundsCache.set(img, null);
      return null;
    }

    const inv = 1 / sampleScale;
    const pad = Math.max(2, Math.round(Math.min(natW, natH) * 0.006));
    const x = Math.max(0, Math.floor(minX * inv) - pad);
    const y = Math.max(0, Math.floor(minY * inv) - pad);
    const right = Math.min(natW, Math.ceil((maxX + 1) * inv) + pad);
    const bottom = Math.min(natH, Math.ceil((maxY + 1) * inv) + pad);
    const bounds = { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
    svgVisibleBoundsCache.set(img, bounds);
    return bounds;
  } catch {
    svgVisibleBoundsCache.set(img, null);
    return null;
  }
}

export function getDefaultPanelRenderConfig(
  position: string,
  productKind: AopLayoutKind,
  aopTemplateId?: string | null,
): PanelRenderConfig {
  const group = getPanelGroup(position);
  const lower = position.toLowerCase();
  const isHoodieTemplate = productKind === "hoodie" || aopTemplateId === "hoodie_v1";

  if (isHoodieTemplate) {
    if (isHoodieTrimPanel(lower)) {
      return { enabled: false, mode: "solid" };
    }
    if (isHoodiePocketPanel(position)) {
      return { enabled: true, mode: "artwork" };
    }
    if (group === "front" || group === "back" || group === "hood") {
      return { enabled: true, mode: "artwork" };
    }
  }

  return { enabled: true, mode: "artwork" };
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

/** Map pocket → front seam half whose transform should be reused (kangaroo / centre → `right` half). */
function getHoodiePocketTransformSourcePosition(
  pocketPos: string,
  panels: Array<{ position: string }>,
): string | null {
  const l = pocketPos.toLowerCase();
  const frontPair = getSeamPairs(panels).find(
    ([a, b]) => getPanelGroup(a) === "front" && getPanelGroup(b) === "front",
  );
  if (!frontPair) return null;
  const L = frontPair[0];
  const R = frontPair[1];
  if (l.includes("pocket") && l.includes("left") && !l.includes("right")) return L;
  if (l.includes("pocket") && l.includes("right")) return R;
  return R;
}

function getHoodiePocketNudgeKey(pocketOrSeam: string, panels: Array<{ position: string }>): string {
  if (!isHoodiePocketPanel(pocketOrSeam)) return pocketOrSeam;
  return getHoodiePocketTransformSourcePosition(pocketOrSeam, panels) || pocketOrSeam;
}

/** Front/hood views: exactly two L/R half-panels (zip or hood seam). Excludes back multi-panel edge cases. */
function isHoodieTwoUpLrView(
  view: HoodiePanelView,
  sortedViewPanels: Array<{ position: string }>,
): boolean {
  if (view !== "front" && view !== "hood") return false;
  if (sortedViewPanels.length !== 2) return false;
  const a = sortedViewPanels[0].position.toLowerCase();
  const b = sortedViewPanels[1].position.toLowerCase();
  const la = a.includes("left");
  const ra = a.includes("right");
  const lb = b.includes("left");
  const rb = b.includes("right");
  return (la && rb && !ra && !lb) || (ra && lb && !la && !rb);
}

/**
 * Use zip/hood L/R overlap for layout when the strict name heuristics match, or when
 * `getSeamPairs` (Printify-style prefixes) identifies this view's two slots as a left+right row.
 * Covers odd spellings that still map to a seam pair in admin data.
 */
function isHoodieLrOverlapView(
  view: HoodiePanelView,
  sortedViewPanels: Array<{ position: string }>,
  allPanels: Array<{ position: string }>,
): boolean {
  if (view !== "front" && view !== "hood") return false;
  if (sortedViewPanels.length !== 2) return false;
  if (isHoodieTwoUpLrView(view, sortedViewPanels)) return true;
  const active = new Set(sortedViewPanels.map((s) => s.position));
  for (const [leftPos, rightPos] of getSeamPairs(allPanels)) {
    if (getPanelGroup(leftPos) !== view) continue;
    if (active.has(leftPos) && active.has(rightPos)) return true;
  }
  return false;
}

/**
 * Build the flat composite layout for a given view.
 * Front view: L/R **chest** only (dedicated pocket print files are not shown as a second row — same as
 * the Hood view being only L/R hood halves, so the preview scale matches the reference mock).
 *
 * When mask SVGs are loaded, each slot’s **width** is derived from the mask’s aspect × Printify **height**,
 * so the composite is wider and `compositeH / compositeW` is lower — preview box is **shorter** and panels
 * read less “tall and narrow” than with Printify’s strip-like `width` alone.
 */
function buildCompositeLayout(
  view: HoodiePanelView,
  panels: Array<{ position: string; width: number; height: number }>,
  svgImages?: Record<string, HTMLImageElement>,
): { compositeW: number; compositeH: number; slots: PanelSlot[] } {
  const viewPanels = panels.filter(
    p => getPanelGroup(p.position) === view && !isHoodieTrimPanel(p.position) && !isHoodiePocketPanel(p.position),
  );
  if (viewPanels.length === 0) return { compositeW: 0, compositeH: 0, slots: [] };

  const displaySize = (panel: { position: string; width: number; height: number }) => {
    const svgImg = svgImages ? getSvgImageForPosition(svgImages, panel.position) : null;
    const bounds = getSvgVisibleBounds(svgImg);
    if (bounds && bounds.w > 0 && bounds.h > 0) {
      return { w: panel.height * (bounds.w / bounds.h), h: panel.height };
    }
    const nw = svgImg?.naturalWidth || svgImg?.width || 0;
    const nh = svgImg?.naturalHeight || svgImg?.height || 0;
    if (nw > 0 && nh > 0) {
      return { w: panel.height * (nw / nh), h: panel.height };
    }
    return { w: panel.width, h: panel.height };
  };

  const sorted = [...viewPanels].sort((a, b) => {
    const aLeft = a.position.toLowerCase().includes("left");
    const bLeft = b.position.toLowerCase().includes("left");
    // front & hood: right first (seam at centre); back: left first
    if (view === "back") return aLeft ? -1 : 1;
    return aLeft ? 1 : -1;
  });
  const sized = sorted.map((panel) => ({ panel, size: displaySize(panel) }));
  const maxH = Math.max(...sized.map(({ size }) => size.h));
  const betweenGap = isHoodieLrOverlapView(view, sorted, panels)
    ? getHoodieTwoUpCenterGapPx(view)
    : HOODIE_COMPOSITE_GAP_PX;

  let x = 0;
  const slots: PanelSlot[] = [];
  for (let i = 0; i < sized.length; i++) {
    const { panel, size } = sized[i];
    slots.push({ position: panel.position, x, y: 0, w: size.w, h: size.h });
    if (i < sorted.length - 1) {
      x += size.w + betweenGap;
    }
  }
  const last = slots[slots.length - 1];
  const compositeW = last ? last.x + last.w : 0;
  const compositeH = maxH;

  return { compositeW, compositeH, slots };
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
function isLinearLegPanelPosition(pos: string): boolean {
  const l = pos.toLowerCase();
  return l.includes("_leg") || l.includes("_side");
}

/**
 * Linear row layout for leggings-style AOP (and generic multi-panel rows).
 * @param extraLegPairGapPx — added to {@link LEGGINGS_GAP} only between consecutive **leg** slots
 *   (e.g. seam allowance preview); export paths pass `0` so print math stays unchanged.
 */
function buildLinearPanelsLayout(
  panels: Array<{ position: string; width: number; height: number }>,
  extraLegPairGapPx = 0,
): { compositeW: number; compositeH: number; slots: PanelSlot[] } {
  if (panels.length === 0) return { compositeW: 0, compositeH: 0, slots: [] };

  // Stable sort: leg panels → right before left; non-leg panels keep original order.
  const sorted = panels
    .map((p, i) => ({ ...p, _idx: i }))
    .sort((a, b) => {
      const al = a.position.toLowerCase();
      const bl = b.position.toLowerCase();
      if (isLinearLegPanelPosition(a.position) && isLinearLegPanelPosition(b.position)) {
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
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    slots.push({ position: p.position, x, y: 0, w: p.width, h: p.height });
    if (i < sorted.length - 1) {
      const next = sorted[i + 1];
      const gap =
        isLinearLegPanelPosition(p.position) && isLinearLegPanelPosition(next.position)
          ? LEGGINGS_GAP + extraLegPairGapPx
          : LEGGINGS_GAP;
      x += p.width + gap;
    } else {
      x += p.width;
    }
    maxH = Math.max(maxH, p.height);
  }
  return { compositeW: x, compositeH: maxH, slots };
}

function computePanelCanvasHeight(
  px: number,
  layout: { compositeW: number; compositeH: number; slots: PanelSlot[] },
  productKind: AopLayoutKind,
  panelPositions: Array<{ position: string }>,
): number {
  if (layout.compositeW <= 0 || layout.compositeH <= 0) return px;

  if (productKind === "hoodie") {
    // Square (1:1) preview. `scaleHoodieCompositeToCanvas` uses contain so the full 2-up
    // row fits inside; grey may appear in the short dimension when print-space is tall.
    return Math.max(1, Math.round(px));
  }

  const rawRatio = layout.compositeH / layout.compositeW;
  const clampedRatio = Math.min(2.0, Math.max(0.3, rawRatio));
  let canvasH = Math.round(px * clampedRatio);

  const hasLegSlots = panelPositions.some(p => shouldFlipLeggingsLegSlot(productKind, p.position));
  if (hasLegSlots) {
    const sclEst = Math.min((px - 20) / layout.compositeW, (canvasH - 20) / layout.compositeH, 1);
    const legSlot = layout.slots.find(s => isLeggingsLegSlot(s.position));
    const swEst = (legSlot?.w ?? layout.compositeW / 2) * sclEst;
    const fontEst = Math.max(9, Math.min(13, swEst * 0.085));
    const lineHEst = fontEst + 3;
    canvasH += Math.ceil(lineHEst * 4 + 8);
  }

  return canvasH;
}

/** Leg flat shapes (_leg / _side); excludes waistbands. Used for Printify-style horizontal flip. */
function isLeggingsLegSlot(position: string): boolean {
  const l = position.toLowerCase();
  if (l.includes("waistband")) return false;
  return l.includes("_leg") || l.includes("_side");
}

function shouldFlipLeggingsLegSlot(
  productKind: "hoodie" | "leggings" | "generic",
  position: string,
): boolean {
  return productKind === "leggings" && isLeggingsLegSlot(position);
}

/** Opposite `left_*` / `right_*` leg panel for leggings sync UI. */
function pairedLeggingLegPosition(
  panels: Array<{ position: string }>,
  active: string,
): string | null {
  if (!isLeggingsLegSlot(active)) return null;
  const al = active.toLowerCase();
  if (al.includes("left") && !al.includes("right")) {
    const r = panels.find(p => {
      const pl = p.position.toLowerCase();
      return pl.includes("right") && isLeggingsLegSlot(p.position);
    });
    return r?.position ?? null;
  }
  if (al.includes("right")) {
    const left = panels.find(p => {
      const pl = p.position.toLowerCase();
      return pl.includes("left") && !pl.includes("right") && isLeggingsLegSlot(p.position);
    });
    return left?.position ?? null;
  }
  return null;
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
  const imgW = img.naturalWidth || img.width;
  const imgH = img.naturalHeight || img.height;
  if (imgW <= 0 || imgH <= 0) return;
  const scaleFactor = (transform.scalePct / 100);
  const baseScale = Math.min(slotW / imgW, slotH / imgH) * scaleFactor;
  const w = imgW * baseScale;
  const h = imgH * baseScale;
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

/** Which panel stores the canonical transform when Sync Sides is on (right leg holds scale/drag for both). */
function canonicalLeggingsTransformPanelId(
  active: string | null,
  syncSides: boolean,
  panels: Array<{ position: string }>,
): string | null {
  if (!active || !syncSides) return active;
  if (!isLeggingsLegSlot(active)) return active;
  if (isLeftLegPanelPosition(active)) {
    return pairedLeggingLegPosition(panels, active) || active;
  }
  return active;
}

function canonicalHoodieTransformPanelId(
  active: string | null,
  syncSides: boolean,
  panels: Array<{ position: string }>,
): string | null {
  if (!active) return active;
  const a = isHoodiePocketPanel(active) ? (getHoodiePocketTransformSourcePosition(active, panels) || active) : active;
  if (!syncSides) return a;
  const group = getPanelGroup(a);
  if (group === "back" || isHoodieTrimPanel(a)) return a;
  const lower = a.toLowerCase();
  if (!lower.includes("left") && !lower.includes("right")) return a;
  const paired = panels.find((panel) => {
    const panelLower = panel.position.toLowerCase();
    if (getPanelGroup(panel.position) !== group || isHoodieTrimPanel(panel.position) || isHoodiePocketPanel(panel.position)) {
      return false;
    }
    return lower.includes("left")
      ? panelLower.includes("right")
      : panelLower.includes("left");
  });
  if (!paired) return a;
  return lower.includes("left") ? paired.position : a;
}

function canonicalTransformPanelId(
  active: string | null,
  syncSides: boolean,
  panels: Array<{ position: string }>,
  productKind: AopLayoutKind,
): string | null {
  if (productKind === "leggings") {
    return canonicalLeggingsTransformPanelId(active, syncSides, panels);
  }
  if (productKind === "hoodie") {
    return canonicalHoodieTransformPanelId(active, syncSides, panels);
  }
  return active;
}

function hitTestLinearPlacePanel(
  clientX: number,
  clientY: number,
  canvas: HTMLCanvasElement,
  panelPositions: Array<{ position: string; width: number; height: number }>,
  seamBleedExtraPx: number,
): string | null {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / Math.max(rect.width, 1);
  const scaleY = canvas.height / Math.max(rect.height, 1);
  const cx = (clientX - rect.left) * scaleX;
  const cy = (clientY - rect.top) * scaleY;
  const pad = 20;
  const { compositeW, compositeH, slots } = buildLinearPanelsLayout(panelPositions, seamBleedExtraPx);
  if (compositeW === 0) return null;
  const canvasW = canvas.width;
  const canvasH = canvas.height;
  const scl = Math.min((canvasW - pad) / compositeW, (canvasH - pad) / compositeH, 1);
  const offX = (canvasW - compositeW * scl) / 2;
  const offY = (canvasH - compositeH * scl) / 2;
  for (const slot of slots) {
    const sx = offX + slot.x * scl;
    const sy = offY + slot.y * scl;
    const sw = slot.w * scl;
    const sh = slot.h * scl;
    if (cx >= sx && cx <= sx + sw && cy >= sy && cy <= sy + sh) return slot.position;
  }
  return null;
}

function hitTestHoodiePlacePanel(
  clientX: number,
  clientY: number,
  canvas: HTMLCanvasElement,
  activeView: "front" | "back" | "hood",
  panelPositions: Array<{ position: string; width: number; height: number }>,
  svgImages: Record<string, HTMLImageElement>,
): string | null {
  const { compositeW, compositeH, slots } = buildCompositeLayout(activeView, panelPositions, svgImages);
  if (compositeW === 0) return null;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / Math.max(rect.width, 1);
  const scaleY = canvas.height / Math.max(rect.height, 1);
  const cx = (clientX - rect.left) * scaleX;
  const cy = (clientY - rect.top) * scaleY;
  const hPad = HOODIE_PREVIEW_PAD;
  const canvasW = canvas.width;
  const canvasH = canvas.height;
  const scl = scaleHoodieCompositeToCanvas(hPad, canvasW, canvasH, compositeW, compositeH);
  const offX = (canvasW - compositeW * scl) / 2;
  const offY = (canvasH - compositeH * scl) / 2;
  for (const slot of slots) {
    const sx = offX + slot.x * scl;
    const sy = offY + slot.y * scl;
    const sw = slot.w * scl;
    const sh = slot.h * scl;
    if (cx >= sx && cx <= sx + sw && cy >= sy && cy <= sy + sh) return slot.position;
  }
  return null;
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
  return Array.from(keys);
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

/**
 * Draw `img` into [dx,dy,dw×dh] with uniform scale and centering (object-fit: contain)
 * so mask artwork is never anamorphically stretched to the layout slot.
 */
function drawImageUniformInRect(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  sourceBounds?: SvgVisibleBounds | null,
): void {
  const natW = img.naturalWidth || img.width;
  const natH = img.naturalHeight || img.height;
  if (natW <= 0 || natH <= 0) {
    ctx.drawImage(img, dx, dy, dw, dh);
    return;
  }
  const srcX = sourceBounds?.x ?? 0;
  const srcY = sourceBounds?.y ?? 0;
  const srcW = sourceBounds?.w ?? natW;
  const srcH = sourceBounds?.h ?? natH;
  const s = Math.min(dw / srcW, dh / srcH);
  const w = srcW * s;
  const h = srcH * s;
  const x = dx + (dw - w) / 2;
  const y = dy + (dh - h) / 2;
  ctx.drawImage(img, srcX, srcY, srcW, srcH, x, y, w, h);
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
 * @param flipHorizontal  Mirror the slot horizontally so FRONT halves meet at the centre seam (leggings).
 * @param preserveSvgAspect  When true (hoodie AOP), mask draws use natural aspect; no stretch to the slot.
 * @param localContentCoords  When true, `drawContent` draws in slot-local coords (0,0 → sw,sh).
 */
function drawMaskedSlot(
  ctx: CanvasRenderingContext2D,
  svgImg: HTMLImageElement | null,
  sx: number, sy: number, sw: number, sh: number,
  drawContent: (offCtx: CanvasRenderingContext2D) => void,
  flipHorizontal = false,
  preserveSvgAspect = false,
  localContentCoords = false,
): void {
  const iw = Math.max(1, Math.round(sw));
  const ih = Math.max(1, Math.round(sh));

  if (!svgImg) {
    if (!flipHorizontal) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, sy, sw, sh);
      ctx.clip();
      if (localContentCoords) ctx.translate(sx, sy);
      drawContent(ctx);
      ctx.restore();
      drawFallbackPanelOutline(ctx, sx, sy, sw, sh);
    } else {
      const tmp = document.createElement("canvas");
      tmp.width = iw;
      tmp.height = ih;
      const tctx = tmp.getContext("2d")!;
      tctx.save();
      if (!localContentCoords) tctx.translate(-sx, -sy);
      drawContent(tctx);
      tctx.restore();
      ctx.save();
      ctx.translate(sx + sw, sy);
      ctx.scale(-1, 1);
      ctx.drawImage(tmp, 0, 0, sw, sh);
      ctx.restore();
      ctx.save();
      ctx.translate(sx + sw, sy);
      ctx.scale(-1, 1);
      drawFallbackPanelOutline(ctx, 0, 0, sw, sh);
      ctx.restore();
    }
    return;
  }

  // Render fill + artwork into an offscreen canvas, then mask to SVG alpha.
  const off = document.createElement("canvas");
  off.width = iw;
  off.height = ih;
  const offCtx = off.getContext("2d")!;

  // Content is drawn in offscreen space (slot origin = 0,0).
  offCtx.save();
  if (!localContentCoords) offCtx.translate(-sx, -sy);
  drawContent(offCtx);
  offCtx.restore();

  // Clip to garment silhouette via SVG alpha.
  offCtx.globalCompositeOperation = "destination-in";
  if (preserveSvgAspect) {
    drawImageUniformInRect(offCtx, svgImg, 0, 0, iw, ih, getSvgVisibleBounds(svgImg));
  } else {
    offCtx.drawImage(svgImg, 0, 0, iw, ih);
  }
  offCtx.globalCompositeOperation = "source-over";

  // Composite masked result onto main canvas.
  if (!flipHorizontal) {
    ctx.drawImage(off, sx, sy, sw, sh);
  } else {
    ctx.save();
    ctx.translate(sx + sw, sy);
    ctx.scale(-1, 1);
    ctx.drawImage(off, 0, 0, sw, sh);
    ctx.restore();
  }

  // Overlay SVG detail lines at low opacity for visible panel edges.
  if (!flipHorizontal) {
    ctx.save();
    ctx.globalAlpha = 0.4;
    if (preserveSvgAspect) {
      drawImageUniformInRect(ctx, svgImg, sx, sy, sw, sh, getSvgVisibleBounds(svgImg));
    } else {
      ctx.drawImage(svgImg, sx, sy, sw, sh);
    }
    ctx.restore();
  }
  // For flipped leg panels: skip the SVG overlay entirely — the hem SVG contains graphical
  // elements (grey bars, mirrored text) that look wrong when unflipped. Text labels are
  // drawn separately below each panel by the caller.
}

/** Return the _safe variant image for a panel position, or null if none loaded. */
function getSafeAreaImageForPosition(
  svgImages: Record<string, HTMLImageElement>,
  position: string,
): HTMLImageElement | null {
  for (const key of flatLayLookupKeys(position)) {
    const safe = svgImages[`${key}_safe`];
    if (safe) return safe;
  }
  return null;
}

/**
 * Overlay silhouette outline + safe-area dashes + bleed-band stripes on top of a panel slot.
 * Call this AFTER drawMaskedSlot so the guides sit above the artwork.
 *
 *  • Silhouette outline   – thin dark ring tracing the actual garment edge.
 *  • Bleed band           – diagonal hatching between silhouette and safe-area edges,
 *                           indicating the print area that will be cut / sewn.
 *  • Safe-area boundary   – dashed inner ring at safeInsetPx, inside which artwork
 *                           is guaranteed to remain visible after sewing.
 *
 * If safeImg is provided (a dedicated *_safe.svg mask), it is used as-is for the
 * safe boundary; otherwise the silhouette is scaled inward by safeInsetPx.
 */
function drawPanelSilhouetteOverlay(
  ctx: CanvasRenderingContext2D,
  svgImg: HTMLImageElement | null,
  safeImg: HTMLImageElement | null,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  safeInsetPx: number,
  flipHorizontal = false,
  showBleedBand = false,
  skipSafeDash = false,
  /** When true, silhouette/safe rasters are drawn with object-fit: contain (no stretch). */
  uniformSvg = false,
): void {
  if (!svgImg) {
    if (!flipHorizontal) {
      drawFallbackPanelOutline(ctx, sx, sy, sw, sh);
    } else {
      ctx.save();
      ctx.translate(sx + sw, sy);
      ctx.scale(-1, 1);
      drawFallbackPanelOutline(ctx, 0, 0, sw, sh);
      ctx.restore();
    }
    return;
  }

  const iw = Math.max(1, Math.round(sw));
  const ih = Math.max(1, Math.round(sh));
  const inset = Math.max(3, safeInsetPx);

  const blitSlot = (c: HTMLCanvasElement) => {
    if (!flipHorizontal) {
      ctx.drawImage(c, sx, sy, sw, sh);
    } else {
      ctx.save();
      ctx.translate(sx + sw, sy);
      ctx.scale(-1, 1);
      ctx.drawImage(c, 0, 0, sw, sh);
      ctx.restore();
    }
  };

  /** Offscreen canvas with the given img drawn, optionally inset. */
  function makeSilhouette(img: HTMLImageElement, px: number): HTMLCanvasElement {
    const off = document.createElement("canvas");
    off.width = iw; off.height = ih;
    const c = off.getContext("2d")!;
    if (px === 0) {
      if (uniformSvg) {
        drawImageUniformInRect(c, img, 0, 0, iw, ih, getSvgVisibleBounds(img));
      } else {
        c.drawImage(img, 0, 0, iw, ih);
      }
    } else if (uniformSvg) {
      drawImageUniformInRect(c, img, px, px, iw - 2 * px, ih - 2 * px, getSvgVisibleBounds(img));
    } else {
      c.drawImage(img, px, px, iw - 2 * px, ih - 2 * px);
    }
    return off;
  }

  /**
   * Build a thin dark ring from a silhouette canvas: fill its alpha dark, then
   * destination-out an inset copy so only a `ringW`-wide border remains.
   */
  function makeRing(source: HTMLCanvasElement, ringW: number): HTMLCanvasElement {
    const off = document.createElement("canvas");
    off.width = iw; off.height = ih;
    const c = off.getContext("2d")!;
    c.drawImage(source, 0, 0);
    c.globalCompositeOperation = "source-in";
    c.fillStyle = "rgba(15,15,15,1)";
    c.fillRect(0, 0, iw, ih);
    c.globalCompositeOperation = "destination-out";
    c.drawImage(source, ringW, ringW, iw - 2 * ringW, ih - 2 * ringW);
    return off;
  }

  const silCanvas  = makeSilhouette(svgImg, 0);
  const safeCanvas = safeImg ? makeSilhouette(safeImg, 0) : makeSilhouette(svgImg, inset);

  // ── 1. Bleed band (silhouette minus safe area, filled with diagonal hatching) ──
  if (showBleedBand) {
    const bleedOff = document.createElement("canvas");
    bleedOff.width = iw; bleedOff.height = ih;
    const bc = bleedOff.getContext("2d")!;
    bc.drawImage(silCanvas, 0, 0);
    bc.globalCompositeOperation = "destination-out";
    bc.drawImage(safeCanvas, 0, 0);
    // Fill the remaining (bleed ring) pixels with diagonal stripes
    bc.globalCompositeOperation = "source-in";
    const sp = document.createElement("canvas");
    sp.width = 8; sp.height = 8;
    const sc = sp.getContext("2d")!;
    sc.strokeStyle = "rgba(60,60,60,0.9)";
    sc.lineWidth = 1.5;
    sc.beginPath(); sc.moveTo(-2, 10); sc.lineTo(10, -2); sc.stroke();
    sc.beginPath(); sc.moveTo(-2, 2);  sc.lineTo(2,  -2); sc.stroke();
    sc.beginPath(); sc.moveTo(6,  10); sc.lineTo(10,  6); sc.stroke();
    bc.fillStyle = bc.createPattern(sp, "repeat")!;
    bc.fillRect(0, 0, iw, ih);
    ctx.save();
    ctx.globalAlpha = 0.45;
    blitSlot(bleedOff);
    ctx.restore();
  }

  // ── 2. Silhouette outline ────────────────────────────────────────────────
  blitSlot(makeRing(silCanvas, 1.5));

  // ── 3. Safe-area dashed boundary ─────────────────────────────────────────
  if (!skipSafeDash) {
    const ring = makeRing(safeCanvas, 1.5);
    // Apply dashes: destination-in with a horizontal stripe pattern (5px on / 4px off)
    const ringCtx = ring.getContext("2d")!;
    const dashPat = document.createElement("canvas");
    dashPat.width = 9; dashPat.height = 1;
    const dp = dashPat.getContext("2d")!;
    dp.fillStyle = "#fff";
    dp.fillRect(0, 0, 5, 1); // 5px opaque, 4px transparent
    ringCtx.globalCompositeOperation = "destination-in";
    ringCtx.fillStyle = ringCtx.createPattern(dashPat, "repeat")!;
    ringCtx.fillRect(0, 0, iw, ih);
    ctx.save();
    ctx.globalAlpha = 0.85;
    blitSlot(ring);
    ctx.restore();
  }
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
 * Draw BACK / FRONT labels below a leggings leg panel.
 * For a right-leg panel (flipped): left half = BACK, right half = FRONT.
 * For a left-leg panel (flipped): left half = FRONT, right half = BACK.
 * A second line shows "Right Leg" or "Left Leg" centred under the panel.
 */
function drawLeggingLegLabels(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  isRightLeg: boolean,
) {
  const fontSize = Math.max(9, Math.min(13, sw * 0.085));
  const lineH = fontSize + 3;
  const y1 = sy + sh + lineH;
  const y2 = y1 + lineH;
  ctx.save();
  ctx.font = `600 ${fontSize}px sans-serif`;
  ctx.fillStyle = "rgba(40,40,40,0.75)";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const leftLabel  = isRightLeg ? "BACK"  : "FRONT";
  const rightLabel = isRightLeg ? "FRONT" : "BACK";
  ctx.fillText(leftLabel,  sx + sw * 0.27, y1);
  ctx.fillText(rightLabel, sx + sw * 0.73, y1);
  // Leg name
  ctx.font = `400 ${Math.max(8, fontSize - 1)}px sans-serif`;
  ctx.fillStyle = "rgba(80,80,80,0.65)";
  ctx.fillText(isRightLeg ? "Right Leg" : "Left Leg", sx + sw * 0.5, y2);
  ctx.restore();
}

/**
 * `tileInches` = physical size of one tile in inches; `pxPerInch` converts that to canvas/print pixels.
 * Optional `anchorX`/`anchorY` set the grid origin — tiles are placed at `anchor + n * tileSize` so
 * multiple panels sharing the same anchor will have a continuous (phase-matched) pattern.
 */
function drawTiledMotifInRect(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  sx: number,
  sy: number,
  rw: number,
  rh: number,
  tileInches: number,
  patternType: PatternType,
  pxPerInch: number,
  anchorX?: number,
  anchorY?: number,
) {
  const imgW = img.naturalWidth || img.width;
  const imgH = img.naturalHeight || img.height;
  if (imgW <= 0 || imgH <= 0) return;
  const ax = anchorX ?? sx;
  const ay = anchorY ?? sy;
  const ti = Math.max(MIN_TILE_INCHES, Math.min(6, tileInches));
  const tileW = Math.max(4, ti * pxPerInch);
  const tileH = tileW * (imgH / imgW);
  // Compute column/row range that covers [sx, sx+rw] × [sy, sy+rh] from anchor (ax, ay).
  const startCol = Math.floor((sx - ax) / tileW) - 1;
  const endCol   = Math.ceil((sx + rw - ax) / tileW) + 1;
  const startRow = Math.floor((sy - ay) / tileH) - 1;
  const endRow   = Math.ceil((sy + rh - ay) / tileH) + 1;
  for (let row = startRow; row < endRow; row++) {
    for (let col = startCol; col < endCol; col++) {
      let x = ax + col * tileW;
      let y = ay + row * tileH;
      if (patternType === "brick" && (row & 1)) x += tileW * 0.5;
      if (patternType === "half" && (col & 1)) y += tileH * 0.5;
      ctx.drawImage(img, x, y, tileW, tileH);
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
  initialTileInches?: number;
  initialPattern?: PatternType;
  initialBgColor?: string;
  onSettingsChange?: (settings: PatternApplyOptions) => void;
  initialPlacement?: AopPlacementSettings;
  initialMode?: "pattern" | "single" | "place";
  onPlacementChange?: (placement: AopPlacementSettings) => void;
  onApply: (patternUrl: string, options: PatternApplyOptions) => void | Promise<void>;
  onCancel?: () => void;
  /** Optional row under Apply (e.g. Share + Edit pattern in embed). */
  footerSlot?: ReactNode;
  isLoading?: boolean;
  productTypeConfig?: { placeholderPositions?: Array<{ position: string; width: number; height: number }> };
  /** When set, overrides inferred hoodie/leggings/generic layout (see `aopTemplates/registry`). */
  aopTemplateId?: string | null;
}

export function PatternCustomizer({
  motifUrl,
  hasPairedPanels,
  panelPositions: panelPositionsProp,
  panelFlatLayImages,
  fetchFn,
  initialTilesAcross,
  initialTileInches,
  initialPattern,
  initialBgColor,
  onSettingsChange,
  initialPlacement,
  initialMode,
  onPlacementChange,
  onApply,
  onCancel,
  footerSlot,
  isLoading: externalLoading,
  productTypeConfig,
  aopTemplateId,
}: PatternCustomizerProps) {
  // Resolve panel positions from either direct prop or productTypeConfig
  const panelPositions = panelPositionsProp || productTypeConfig?.placeholderPositions || [];

  // ── Local state ────────────────────────────────────────────────────────────

  const [mode, setMode] = useState<EditorMode>(
    initialMode ?? initialPlacement?.lastMode ?? "pattern"
  );
  const [patternType, setPatternType] = useState<PatternType>(initialPattern || "grid");
  // tileInches: real-world size of one tile in inches (replaces abstract tilesAcross).
  // Back-compat: if only initialTilesAcross was stored, convert via a nominal 6" panel width.
  const [tileInches, setTileInches] = useState<number>(() => {
    if (typeof initialTileInches === "number" && initialTileInches > 0) {
      return Math.max(MIN_TILE_INCHES, Math.min(6, initialTileInches));
    }
    if (typeof initialTilesAcross === "number" && initialTilesAcross > 0) {
      return Math.max(MIN_TILE_INCHES, Math.min(6, 6 / initialTilesAcross));
    }
    return 1.5;
  });
  const [bgColor, setBgColor] = useState(initialBgColor || "");
  const [applyLoading, setApplyLoading] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewWrapRef = useRef<HTMLDivElement>(null);
  const [previewPx, setPreviewPx] = useState(PREVIEW_PX_DEFAULT);
  const [canvasDims, setCanvasDims] = useState({ w: PREVIEW_PX_DEFAULT, h: PREVIEW_PX_DEFAULT });
  const [motifImage, setMotifImage] = useState<HTMLImageElement | null>(null);
  const [svgImages, setSvgImages]   = useState<Record<string, HTMLImageElement>>({});

  // Per-panel placement transforms
  const [perPanelTransforms, setPerPanelTransforms] = useState<Record<string, PanelTransform>>(
    initialPlacement?.perPanelTransforms || {}
  );
  const [panelRenderConfig, setPanelRenderConfig] = useState<Record<string, PanelRenderConfig>>(
    initialPlacement?.panelRenderConfig || {}
  );
  const [activePanel, setActivePanel] = useState<string | null>(
    initialPlacement?.activePanel || null
  );
  const [mirrorMode, setMirrorMode] = useState(initialPlacement?.mirrorMode ?? false);
  const [syncSidesMode, setSyncSidesMode] = useState(() => {
    if (initialPlacement?.syncSidesMode !== undefined) return initialPlacement.syncSidesMode;
    // Default sync sides on for leggings to help front-seam pattern alignment
    const kind = panelPositions.length > 0 ? detectProductKind(panelPositions) : "generic";
    return kind === "leggings";
  });
  const [applyAllover, setApplyAllover] = useState(true);
  const [patternOffsetX, setPatternOffsetX] = useState(initialPlacement?.patternOffsetX ?? 0);
  const [hoodiePatternSpecs, setHoodiePatternSpecs] = useState<Partial<Record<HoodiePanelView, HoodiePatternSpec>>>({
    front: { tileInches, offsetX: initialPlacement?.patternOffsetX ?? 0 },
  });
  const [seamBleedPx, setSeamBleedPx] = useState(
    initialPlacement?.seamBleedPx ?? DEFAULT_SEAM_BLEED_PX
  );

  // Active view for hoodie (front / back / hood)
  const [activeView, setActiveView] = useState<HoodiePanelView>("front");

  const inferredLayoutKind = panelPositions.length > 0 ? detectProductKind(panelPositions) : "generic";
  const fromTemplate = resolveAopLayoutKind(aopTemplateId, inferredLayoutKind);
  // DB mistake: `leggings_v1` on a zip AOP; placeholders still infer "hoodie". Use hoodie rules.
  const productKind: AopLayoutKind =
    inferredLayoutKind === "hoodie" && fromTemplate === "leggings" ? "hoodie" : fromTemplate;
  const panelFillColor = bgColor && bgColor !== "transparent" ? bgColor : "#ffffff";

  const getEffectivePanelConfig = useCallback(
    (position: string): PanelRenderConfig =>
      panelRenderConfig[position] || getDefaultPanelRenderConfig(position, productKind, aopTemplateId),
    [panelRenderConfig, productKind, aopTemplateId],
  );

  const shouldRenderPanelArtwork = useCallback(
    (position: string): boolean => {
      const cfg = getEffectivePanelConfig(position);
      return cfg.enabled !== false && cfg.mode !== "solid";
    },
    [getEffectivePanelConfig],
  );

  const shouldRenderPanelArtworkForMode = useCallback(
    (position: string, exportMode: EditorMode): boolean => {
      if (exportMode === "place" && productKind === "hoodie" && isHoodiePocketPanel(position)) {
        return false;
      }
      if (exportMode === "pattern" && productKind === "hoodie") {
        return isPrimaryHoodieArtworkPanel(position) || isHoodiePocketPanel(position);
      }
      return shouldRenderPanelArtwork(position);
    },
    [productKind, shouldRenderPanelArtwork],
  );

  const availableHoodieViews = useMemo(
    () =>
      (["front", "back", "hood"] as const).filter((view) =>
        panelPositions.some((p) => getPanelGroup(p.position) === view && !isHoodieTrimPanel(p.position)),
      ),
    [panelPositions],
  );

  const fallbackPatternSpec = useMemo<HoodiePatternSpec>(
    () => ({ tileInches, offsetX: patternOffsetX }),
    [patternOffsetX, tileInches],
  );

  const getPatternSpecForView = useCallback(
    (view: HoodiePanelView): HoodiePatternSpec =>
      hoodiePatternSpecs[view] || hoodiePatternSpecs.front || fallbackPatternSpec,
    [fallbackPatternSpec, hoodiePatternSpecs],
  );

  const activePatternSpec =
    productKind === "hoodie" ? getPatternSpecForView(activeView) : fallbackPatternSpec;
  const activePatternTileInches = activePatternSpec.tileInches;
  const activePatternOffsetX = activePatternSpec.offsetX;

  const setActivePatternTileInches = useCallback(
    (value: number) => {
      if (productKind === "hoodie") {
        setHoodiePatternSpecs((prev) => {
          const base = prev[activeView] || prev.front || fallbackPatternSpec;
          return { ...prev, [activeView]: { ...base, tileInches: value } };
        });
      } else {
        setTileInches(value);
      }
    },
    [activeView, fallbackPatternSpec, productKind],
  );

  const setActivePatternOffsetX = useCallback(
    (value: number) => {
      if (productKind === "hoodie") {
        setHoodiePatternSpecs((prev) => {
          const base = prev[activeView] || prev.front || fallbackPatternSpec;
          return { ...prev, [activeView]: { ...base, offsetX: value } };
        });
      } else {
        setPatternOffsetX(value);
      }
    },
    [activeView, fallbackPatternSpec, productKind],
  );

  const getPatternSpecForPanel = useCallback(
    (position: string): HoodiePatternSpec =>
      productKind === "hoodie"
        ? isHoodieTrimPanel(position)
          ? getPatternSpecForView("front")
          : getPatternSpecForView(getPanelGroup(position))
        : fallbackPatternSpec,
    [fallbackPatternSpec, getPatternSpecForView, productKind],
  );

  const setActiveHoodieView = useCallback(
    (view: HoodiePanelView) => {
      setActiveView(view);
      const firstPanel = buildCompositeLayout(view, panelPositions, svgImages).slots[0]?.position || null;
      if (firstPanel) setActivePanel(firstPanel);
    },
    [panelPositions, svgImages],
  );

  useEffect(() => {
    if (panelPositions.length === 0) return;
    setPanelRenderConfig((prev) => {
      const next: Record<string, PanelRenderConfig> = { ...prev };
      for (const p of panelPositions) {
        if (!next[p.position]) {
          next[p.position] = getDefaultPanelRenderConfig(p.position, productKind, aopTemplateId);
        } else if (
          productKind === "hoodie" &&
          isPrimaryHoodieArtworkPanel(p.position) &&
          next[p.position].enabled === false &&
          next[p.position].mode === "artwork"
        ) {
          next[p.position] = { ...next[p.position], enabled: true };
        }
      }
      return next;
    });
  }, [panelPositions, productKind, aopTemplateId]);

  useEffect(() => {
    if (productKind !== "hoodie") return;
    const currentViewPanels = buildCompositeLayout(activeView, panelPositions, svgImages).slots;
    if (currentViewPanels.length === 0 && availableHoodieViews[0]) {
      setActiveHoodieView(availableHoodieViews[0]);
      return;
    }
    if (!activePanel || !currentViewPanels.some((slot) => slot.position === activePanel)) {
      const firstPanel = currentViewPanels[0]?.position;
      if (firstPanel) setActivePanel(firstPanel);
    }
  }, [productKind, activeView, activePanel, panelPositions, availableHoodieViews, setActiveHoodieView, svgImages]);

  // ── Image loading ──────────────────────────────────────────────────────────
  // Load motif via fetch → blob URL so the canvas is never tainted by cross-origin
  // restrictions. Direct img.src with crossOrigin="anonymous" fails on iOS Safari when
  // the image was previously cached without CORS headers (e.g. shown in a preview <img>),
  // causing drawImage() to silently draw nothing and toDataURL() to throw SecurityError.
  // A blob URL is always same-origin from the browser's perspective.

  useEffect(() => {
    let cancelled = false;
    let blobUrl: string | null = null;

    const loadViaFetch = async () => {
      try {
        const fetchFn_ = fetchFn || fetch;
        const res = await fetchFn_(motifUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        blobUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          if (!cancelled) setMotifImage(img);
        };
        img.onerror = () => {
          console.error("[PatternCustomizer] Blob img load failed:", motifUrl.substring(0, 80));
        };
        img.src = blobUrl;
      } catch (fetchErr) {
        if (cancelled) return;
        // Fallback: direct load with crossOrigin (works on desktop / non-proxy contexts)
        console.warn("[PatternCustomizer] fetch failed, falling back to direct img load:", fetchErr);
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload  = () => { if (!cancelled) setMotifImage(img); };
        img.onerror = () => console.error("[PatternCustomizer] Failed to load motif image:", motifUrl.substring(0, 80));
        img.src = motifUrl;
      }
    };

    loadViaFetch();

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [motifUrl, fetchFn]);

  const [svgLoadErrors, setSvgLoadErrors] = useState<string[]>([]);

  // useLayoutEffect + re-run when layout inputs change: first paint often has width=0 while embed grid/config loads;
  // a one-shot useEffect[] misses the real column width, so the preview stayed at the default 400px.
  useLayoutEffect(() => {
    const el = previewWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w < 1) return;
      const s = Math.floor(Math.min(Math.max(w, 160), 1100));
      setPreviewPx(s);
    };
    measure();
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(measure);
    });
    ro.observe(el);
    window.addEventListener("resize", measure);
    const t0 = window.setTimeout(measure, 0);
    const t1 = window.setTimeout(measure, 120);
    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [panelPositions.length, activeView, mode]);

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
        const { compositeW, compositeH, slots } = buildCompositeLayout(activeView, panelPositions, svgImages);
        if (compositeW === 0) return;
        const hPad = HOODIE_PREVIEW_PAD;
        const scl = scaleHoodieCompositeToCanvas(hPad, px, canvasH, compositeW, compositeH);
        const offX = (px - compositeW * scl) / 2;
        const offY = (canvasH - compositeH * scl) / 2;
        const safeInset = Math.max(3, SAFE_AREA_INCHES * PRINT_DPI * scl);

        for (const slot of slots) {
          const sx = offX + slot.x * scl;
          const sy = offY + slot.y * scl;
          const sw = slot.w * scl;
          const sh = slot.h * scl;
          const svgImg  = getSvgImageForPosition(svgImages, slot.position);
          const safeImg = getSafeAreaImageForPosition(svgImages, slot.position);

          const placeKey = isHoodiePocketPanel(slot.position)
            ? (getHoodiePocketTransformSourcePosition(slot.position, panelPositions) || slot.position)
            : slot.position;
          const t = perPanelTransforms[placeKey] || { dxPx: 0, dyPx: 0, scalePct: 100 };
          const mirrorTarget = mirrorMode && isMirrorTarget(placeKey, slots);
          const sourcePos = mirrorTarget ? getMirrorSource(placeKey, slots) : null;
          const syncTarget =
            !sourcePos && syncSidesMode
              ? canonicalHoodieTransformPanelId(placeKey, true, panelPositions)
              : null;
          const syncT = syncTarget ? (perPanelTransforms[syncTarget] || t) : t;
          const isSyncedLeftPanel =
            !!syncTarget &&
            syncTarget !== placeKey &&
            placeKey.toLowerCase().includes("left");
          const syncedT = isSyncedLeftPanel ? { ...syncT, dxPx: -syncT.dxPx } : syncT;
          const effectiveT = sourcePos ? (perPanelTransforms[sourcePos] || t) : syncTarget ? syncedT : t;
          const renderArtwork = shouldRenderPanelArtwork(sourcePos || placeKey);

          drawMaskedSlot(ctx, svgImg, sx, sy, sw, sh, (offCtx) => {
            offCtx.fillStyle = panelFillColor;
            offCtx.fillRect(0, 0, sw, sh);
            if (renderArtwork) {
              drawArtworkInSlot(offCtx, img, 0, 0, sw, sh, effectiveT, mirrorTarget);
            }
          }, false, true, true);
          drawPanelSilhouetteOverlay(ctx, svgImg, safeImg, sx, sy, sw, sh, safeInset, false, false, false, true);
          drawActiveBorder(ctx, sx, sy, sw, sh, slot.position === activePanel);
          if (slot.position === activePanel) drawSnapGuides(ctx, sx, sy, sw, sh);
        }

        if (slots.length >= 2) {
          const right = slots[0];
          const left = slots[1];
          if (!isHoodiePocketPanel(right.position) && !isHoodiePocketPanel(left.position)) {
            const row1H = Math.max(right.h, left.h);
            const seamX = offX + 0.5 * (right.x + right.w + left.x) * scl;
            ctx.save();
            ctx.strokeStyle = "rgba(255,80,80,0.6)";
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(seamX, offY);
            ctx.lineTo(seamX, offY + row1H * scl);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
          }
        }
      } else {
        const linearGapExtra = productKind === "leggings" ? seamBleedPx : 0;
        const { compositeW, compositeH, slots } = buildLinearPanelsLayout(panelPositions, linearGapExtra);
        if (compositeW === 0) return;
        const scl = Math.min((px - pad) / compositeW, (canvasH - pad) / compositeH, 1);
        const offX = (px - compositeW * scl) / 2;
        const offY = (canvasH - compositeH * scl) / 2;
        const safeInset = Math.max(3, SAFE_AREA_INCHES * PRINT_DPI * scl);

        const rightLegPos = panelPositions.find(p => {
          const l = p.position.toLowerCase();
          return l.includes("right") && (l.includes("leg") || l.includes("side"));
        })?.position;

        for (const slot of slots) {
          const sx = offX + slot.x * scl;
          const sy = offY + slot.y * scl;
          const sw = slot.w * scl;
          const sh = slot.h * scl;
          const svgImg  = getSvgImageForPosition(svgImages, slot.position);
          const safeImg = getSafeAreaImageForPosition(svgImages, slot.position);

          const t = perPanelTransforms[slot.position] || { dxPx: 0, dyPx: 0, scalePct: 100 };
          const doMirror =
            mirrorMode &&
            isLeftLegPanelPosition(slot.position) &&
            !!rightLegPos;
          const useSyncSides =
            syncSidesMode &&
            isLeftLegPanelPosition(slot.position) &&
            !!rightLegPos;
          const rightT = rightLegPos ? (perPanelTransforms[rightLegPos] || t) : t;
          // Sync sides: left leg mirrors horizontal offset from slot center (no artwork flip)
          const symT = useSyncSides ? { ...rightT, dxPx: -rightT.dxPx } : rightT;
          const effectiveT = doMirror ? rightT : useSyncSides ? symT : t;

          const flipSlot = shouldFlipLeggingsLegSlot(productKind, slot.position);
          const renderArtwork = shouldRenderPanelArtwork(slot.position);

          drawMaskedSlot(ctx, svgImg, sx, sy, sw, sh, (offCtx) => {
            offCtx.fillStyle = panelFillColor;
            offCtx.fillRect(0, 0, sw, sh);
            if (renderArtwork) {
              drawArtworkInSlot(offCtx, img, 0, 0, sw, sh, effectiveT, doMirror);
            }
          }, flipSlot, false, true);
          drawPanelSilhouetteOverlay(ctx, svgImg, safeImg, sx, sy, sw, sh, safeInset, flipSlot, false, flipSlot, false);
          drawActiveBorder(ctx, sx, sy, sw, sh, slot.position === activePanel);
          if (slot.position === activePanel) drawSnapGuides(ctx, sx, sy, sw, sh);
          if (flipSlot) {
            const isRightLeg = !isLeftLegPanelPosition(slot.position);
            drawLeggingLegLabels(ctx, sx, sy, sw, sh, isRightLeg);
          }
        }
      }
    },
    [productKind, panelPositions, activeView, svgImages, perPanelTransforms, activePanel, mirrorMode, syncSidesMode, panelFillColor, seamBleedPx, shouldRenderPanelArtwork],
  );

  const renderPatternMaskedPreview = useCallback(
    (ctx: CanvasRenderingContext2D, img: HTMLImageElement, px: number, canvasH = px) => {
      const pad = 20;
      const drawSlots = (slots: PanelSlot[], compositeW: number, compositeH: number) => {
        if (compositeW === 0) return;
        const hPad = productKind === "hoodie" ? HOODIE_PREVIEW_PAD : pad;
        const scl =
          productKind === "hoodie"
            ? scaleHoodieCompositeToCanvas(hPad, px, canvasH, compositeW, compositeH)
            : Math.min((px - pad) / compositeW, (canvasH - pad) / compositeH, 1);
        const offX = (px - compositeW * scl) / 2;
        const offY = (canvasH - compositeH * scl) / 2;
        const pxPerInch = scl * PRINT_DPI;
        const safeInset = Math.max(3, SAFE_AREA_INCHES * PRINT_DPI * scl);
        const fill = bgColor && bgColor !== "transparent" ? bgColor : "#f4f4f5";
        // Convert patternOffsetX (% of tile width) to screen pixels
        const tileWScreen = Math.max(4, activePatternTileInches * pxPerInch);
        const offsetScreenPx = (activePatternOffsetX / 100) * tileWScreen;

        // Find right leg slot for sync/mirror calculations (leggings only)
        const rightLegSlot = (syncSidesMode || mirrorMode)
          ? slots.find(s => isLeggingsLegSlot(s.position) && !isLeftLegPanelPosition(s.position))
          : undefined;
        const rightSx = rightLegSlot ? offX + rightLegSlot.x * scl : 0;

        // Pre-render right leg tile pattern to an offscreen buffer (mirror mode only).
        // The left leg will draw this buffer flipped horizontally so the preview matches export.
        let rightLegTileBuffer: HTMLCanvasElement | null = null;
        if (mirrorMode && rightLegSlot) {
          const rsx = offX + rightLegSlot.x * scl;
          const rsy = offY + rightLegSlot.y * scl;
          const rsw = rightLegSlot.w * scl;
          const rsh = rightLegSlot.h * scl;
          const riw = Math.max(1, Math.round(rsw));
          const rih = Math.max(1, Math.round(rsh));
          const buf = document.createElement("canvas");
          buf.width = riw;
          buf.height = rih;
          const bCtx = buf.getContext("2d")!;
          bCtx.fillStyle = fill;
          bCtx.fillRect(0, 0, riw, rih);
          bCtx.save();
          bCtx.translate(-rsx, -rsy);
          // Apply horizontal offset so the buffer matches the right leg's shifted anchor
          drawTiledMotifInRect(bCtx, img, rsx, rsy, rsw, rsh, activePatternTileInches, patternType, pxPerInch, rsx + offsetScreenPx, offY);
          bCtx.restore();
          rightLegTileBuffer = buf;
        }

        for (const slot of slots) {
          const sx = offX + slot.x * scl;
          const sy = offY + slot.y * scl;
          const sw = slot.w * scl;
          const sh = slot.h * scl;
          const svgImg  = getSvgImageForPosition(svgImages, slot.position);
          const safeImg = getSafeAreaImageForPosition(svgImages, slot.position);

          const flipSlot  = shouldFlipLeggingsLegSlot(productKind, slot.position);
          const isLeftLeg = isLeftLegPanelPosition(slot.position);
          const isLegSlot = isLeggingsLegSlot(slot.position);

          // Decide whether to use a shared tile anchor (sync) or mirror flip (mirror)
          let tileAnchorX: number | undefined;
          let tileAnchorY: number | undefined;
          const useMirrorLeft = mirrorMode  && isLeftLeg && isLegSlot && !!rightLegTileBuffer;
          const useSyncLeft   = syncSidesMode && isLeftLeg && isLegSlot && !!rightLegSlot;

          if (productKind === "hoodie") {
            // One grid origin in canvas space so the repeat matches across the centre seam and onto pockets.
            tileAnchorX = offX + offsetScreenPx;
            tileAnchorY = offY;
          } else if (!isLeftLeg && isLegSlot && (syncSidesMode || mirrorMode) && rightLegSlot) {
            // Right leg: anchor at its own left edge so phase is deterministic
            tileAnchorX = rightSx + offsetScreenPx;
            tileAnchorY = offY;
          } else if (useSyncLeft && rightLegSlot) {
            // Left leg sync: offset tile anchor by the **layout** gap between right and left leg slots
            // (includes seam allowance when `seamBleedPx` widens the preview-only leg pair gap).
            const leftLegSlot = slots.find(
              s => isLeggingsLegSlot(s.position) && isLeftLegPanelPosition(s.position),
            );
            const seamLayoutGapPx = leftLegSlot
              ? leftLegSlot.x - rightLegSlot.x - rightLegSlot.w
              : LEGGINGS_GAP;
            tileAnchorX = rightSx - seamLayoutGapPx * scl + offsetScreenPx;
            tileAnchorY = offY;
          }

          drawMaskedSlot(ctx, svgImg, sx, sy, sw, sh, (offCtx) => {
            offCtx.fillStyle = fill;
            offCtx.fillRect(0, 0, sw, sh);
            if (useMirrorLeft && rightLegTileBuffer) {
              // Draw rightLegTileBuffer flipped horizontally into this left leg off-canvas.
              offCtx.save();
              offCtx.translate(sw, 0);
              offCtx.scale(-1, 1);
              offCtx.drawImage(rightLegTileBuffer, 0, 0, sw, sh);
              offCtx.restore();
            } else {
              // Apply offset to any panel that didn't get an explicit anchor above
              const effectiveAnchorX = tileAnchorX ?? (sx + offsetScreenPx);
              drawTiledMotifInRect(
                offCtx,
                img,
                0,
                0,
                sw,
                sh,
                activePatternTileInches,
                patternType,
                pxPerInch,
                effectiveAnchorX - sx,
                tileAnchorY !== undefined ? tileAnchorY - sy : undefined,
              );
            }
          }, flipSlot, productKind === "hoodie", true);
          drawPanelSilhouetteOverlay(ctx, svgImg, safeImg, sx, sy, sw, sh, safeInset, flipSlot, false, flipSlot, productKind === "hoodie");
          if (flipSlot) {
            const isRightLeg = !isLeftLegPanelPosition(slot.position);
            drawLeggingLegLabels(ctx, sx, sy, sw, sh, isRightLeg);
          }
        }
      };

      if (productKind === "hoodie") {
        const { compositeW, compositeH, slots } = buildCompositeLayout(activeView, panelPositions, svgImages);
        drawSlots(slots, compositeW, compositeH);
      } else {
        const linearGapExtra = productKind === "leggings" ? seamBleedPx : 0;
        const { compositeW, compositeH, slots } = buildLinearPanelsLayout(panelPositions, linearGapExtra);
        drawSlots(slots, compositeW, compositeH);
      }
    },
    [productKind, panelPositions, activeView, svgImages, bgColor, activePatternTileInches, patternType, mirrorMode, syncSidesMode, activePatternOffsetX, seamBleedPx],
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
          ? buildCompositeLayout(activeView, panelPositions, svgImages)
          : buildLinearPanelsLayout(panelPositions, productKind === "leggings" ? seamBleedPx : 0);
      canvasH = computePanelCanvasHeight(px, layout, productKind, panelPositions);
    }

    canvas.width = px;
    canvas.height = canvasH;
    setCanvasDims({ w: px, h: canvasH });

    ctx.clearRect(0, 0, px, canvasH);
    // Use neutral muted fill for the canvas gutter; bgColor is applied per-panel inside drawMaskedSlot.
    ctx.fillStyle = "#f4f4f5";
    ctx.fillRect(0, 0, px, canvasH);

    if (mode === "pattern" && panelPositions.length > 0) {
      renderPatternMaskedPreview(ctx, motifImage, px, canvasH);
    } else if (mode === "pattern") {
      // No panel data: tile across the full canvas at the real-inch scale.
      // Use 96 CSS px/inch as the screen reference DPI for a no-panel preview.
      const screenPxPerInch = 96;
      drawTiledMotifInRect(ctx, motifImage, 0, 0, px, canvasH, tileInches, patternType, screenPxPerInch);
    } else if (mode === "place" && panelPositions.length > 0) {
      renderPanelPreview(ctx, motifImage, px, canvasH);
    }
  }, [
    mode,
    tileInches,
    patternType,
    bgColor,
    motifImage,
    panelPositions,
    perPanelTransforms,
    activePanel,
    mirrorMode,
    syncSidesMode,
    activePatternOffsetX,
    activePatternTileInches,
    svgImages,
    activeView,
    previewPx,
    renderPanelPreview,
    renderPatternMaskedPreview,
    seamBleedPx,
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
      if (!panel) return panel;
      if (syncSidesMode) {
        return canonicalTransformPanelId(panel, true, panelPositions, productKind) || panel;
      }
      const p0 =
        productKind === "hoodie" && isHoodiePocketPanel(panel)
          ? (getHoodiePocketTransformSourcePosition(panel, panelPositions) || panel)
          : panel;
      if (mirrorMode) {
        const { slots } =
          productKind === "hoodie"
            ? buildCompositeLayout(activeView, panelPositions, svgImages)
            : buildLinearPanelsLayout(panelPositions, 0);
        const source = getMirrorSource(p0, slots);
        return source || p0;
      }
      return p0;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (mode !== "place") return;
      const hit =
        productKind === "hoodie"
          ? hitTestHoodiePlacePanel(e.clientX, e.clientY, canvas, activeView, panelPositions, svgImages)
          : hitTestLinearPlacePanel(
              e.clientX,
              e.clientY,
              canvas,
              panelPositions,
              productKind === "leggings" ? seamBleedPx : 0,
            );
      if (!hit) return;
      setActivePanel(hit);
      const editPanel = getEditablePanelForDrag(hit);
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
      const invertX = shouldFlipLeggingsLegSlot(productKind, dragRef.current.panel);
      const clientDx = e.clientX - dragRef.current.startClientX;
      const rawDx = dragRef.current.startDx + (invertX ? -clientDx : clientDx);
      const rawDy = dragRef.current.startDy + (e.clientY - dragRef.current.startClientY);
      const { dxPx, dyPx } = applySnap(rawDx, rawDy);
      updatePanelTransform(dragRef.current.panel, { dxPx, dyPx });
    };

    const onMouseUp = () => { dragRef.current.active = false; };

    const onTouchStart = (e: TouchEvent) => {
      if (mode !== "place" || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const hit =
        productKind === "hoodie"
          ? hitTestHoodiePlacePanel(touch.clientX, touch.clientY, canvas, activeView, panelPositions, svgImages)
          : hitTestLinearPlacePanel(
              touch.clientX,
              touch.clientY,
              canvas,
              panelPositions,
              productKind === "leggings" ? seamBleedPx : 0,
            );
      if (!hit) return;
      setActivePanel(hit);
      const editPanel = getEditablePanelForDrag(hit);
      const t = perPanelTransforms[editPanel] || { dxPx: 0, dyPx: 0, scalePct: 100 };
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
      const invertX = shouldFlipLeggingsLegSlot(productKind, dragRef.current.panel);
      const clientDx = touch.clientX - dragRef.current.startClientX;
      const rawDx = dragRef.current.startDx + (invertX ? -clientDx : clientDx);
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
  }, [activePanel, mode, perPanelTransforms, mirrorMode, syncSidesMode, productKind, activeView, panelPositions, svgImages, seamBleedPx]); // eslint-disable-line react-hooks/exhaustive-deps

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
    onPlacementChange({
      perPanelTransforms,
      panelRenderConfig,
      activePanel,
      mirrorMode,
      seamBleedPx,
      syncSidesMode,
      patternOffsetX: activePatternOffsetX,
      lastMode: mode,
    });
  }, [perPanelTransforms, panelRenderConfig, activePanel, mirrorMode, seamBleedPx, syncSidesMode, activePatternOffsetX, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep embed / parent in sync with pattern controls (tiles, type, background)
  useEffect(() => {
    if (!onSettingsChange) return;
    onSettingsChange({
      patternType,
      tilesAcross: 0,
      tileInches: activePatternTileInches,
      bgColor: bgColor || undefined,
    });
  }, [activePatternTileInches, patternType, bgColor, onSettingsChange]);

  // ── Full-res panel export ──────────────────────────────────────────────────

  /**
   * Render a single panel to a full-resolution canvas and return its dataUrl.
   * Used for non-seam panels (back, hood, leggings).
   * dxPx/dyPx are stored in preview-canvas pixel space; upscaled to print-pixel space here.
   * @param transformOverride - optional transform to use instead of perPanelTransforms[pos.position]
   */
  async function exportPanelImage(
    pos: { position: string; width: number; height: number },
    img: HTMLImageElement,
    transformOverride?: PanelTransform,
    pixelCap = MAX_PANEL_MOCKUP_PX,
  ): Promise<string> {
    // Render directly at pixelCap-capped dimensions to avoid silent iOS Safari canvas
    // memory failures.  Full-print-resolution intermediates (e.g. 3600×4800 = 17 MP)
    // silently exceed the ~16.7 MP iOS canvas area limit and produce blank white exports,
    // whereas pattern mode already creates capped canvases and works fine.
    const scaleRatio = Math.min(1, pixelCap / Math.max(pos.width, pos.height));
    const outW = Math.max(1, Math.round(pos.width  * scaleRatio));
    const outH = Math.max(1, Math.round(pos.height * scaleRatio));

    const canvas = document.createElement("canvas");
    canvas.width  = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d")!;

    let t = transformOverride ?? perPanelTransforms[pos.position] ?? { dxPx: 0, dyPx: 0, scalePct: 100 };
    if (productKind === "hoodie" && isHoodiePocketPanel(pos.position) && !transformOverride) {
      const src = getHoodiePocketTransformSourcePosition(pos.position, panelPositions);
      if (src) t = perPanelTransforms[src] || t;
    }

    // Derive upscale: preview slot px → output canvas px (= print px × scaleRatio).
    const px = previewPx;
    let previewSlotW = px;
    let previewSlotH = px;
    if (productKind === "hoodie") {
      const layout = buildCompositeLayout(getPanelGroup(pos.position), panelPositions, svgImages);
      if (layout.compositeW > 0) {
        const previewCanvasH = computePanelCanvasHeight(px, layout, productKind, panelPositions);
        const scl = scaleHoodieCompositeToCanvas(
          HOODIE_PREVIEW_PAD,
          px,
          previewCanvasH,
          layout.compositeW,
          layout.compositeH,
        );
        const found = layout.slots.find(s => s.position === pos.position);
        if (found) {
          previewSlotW = found.w * scl;
          previewSlotH = found.h * scl;
        } else if (isHoodiePocketPanel(pos.position)) {
          // Preview composite omits pocket row; map print placeholder w/h with the same scale as the chest 2-up.
          previewSlotW = pos.width * scl;
          previewSlotH = pos.height * scl;
        }
      }
    } else {
      const { compositeW, compositeH, slots } = buildLinearPanelsLayout(panelPositions, 0);
      if (compositeW > 0) {
        const layout = { compositeW, compositeH, slots };
        const previewCanvasH = computePanelCanvasHeight(px, layout, productKind, panelPositions);
        const scl = Math.min((px - 20) / compositeW, (previewCanvasH - 20) / compositeH, 1);
        const found = slots.find(s => s.position === pos.position);
        if (found) {
          previewSlotW = found.w * scl;
          previewSlotH = found.h * scl;
        }
      }
    }
    // upscaleX/Y: preview → output canvas (scaleRatio is already baked into outW/H).
    const upscaleX = outW / (previewSlotW || outW);
    const upscaleY = outH / (previewSlotH || outH);
    const imgW = img.naturalWidth || img.width;
    const imgH = img.naturalHeight || img.height;
    const previewBaseScale =
      imgW > 0 && imgH > 0 ? Math.min(previewSlotW / imgW, previewSlotH / imgH) : 0;
    const exportBaseScale =
      imgW > 0 && imgH > 0 ? Math.min(outW / imgW, outH / imgH) : 0;
    const previewLimiterUpscale =
      imgW > 0 &&
      imgH > 0 &&
      previewSlotW / imgW <= previewSlotH / imgH
        ? upscaleX
        : upscaleY;
    const scalePct =
      previewBaseScale > 0 && exportBaseScale > 0
        ? t.scalePct * ((previewBaseScale * previewLimiterUpscale) / exportBaseScale)
        : t.scalePct;
    const yExportNudge =
      productKind === "leggings" && isLeggingsLegSlot(pos.position)
        ? LEGGINGS_EXPORT_DY_OFFSET_PX * scaleRatio
        : 0;

    const printT: PanelTransform = {
      dxPx:     nudgeHoodieSeamExportDx(
        productKind,
        getHoodiePocketNudgeKey(pos.position, panelPositions),
        t.dxPx * upscaleX,
      ),
      dyPx:     t.dyPx * upscaleY + yExportNudge,
      scalePct,
    };

    if (bgColor && bgColor !== "transparent") {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, outW, outH);
    }
    drawArtworkInSlot(ctx, img, 0, 0, outW, outH, printT, false);

    if (shouldFlipLeggingsLegSlot(productKind, pos.position)) {
      const flipped = document.createElement("canvas");
      flipped.width = outW;
      flipped.height = outH;
      const fx = flipped.getContext("2d")!;
      fx.translate(outW, 0);
      fx.scale(-1, 1);
      fx.drawImage(canvas, 0, 0);
      return canvasToUploadDataUrl(flipped, pixelCap);
    }

    return canvasToUploadDataUrl(canvas, pixelCap);
  }

  function buildSolidPanelDataUrl(color: string): string {
    const outW = SOLID_PANEL_LONG_EDGE_PX;
    const outH = SOLID_PANEL_LONG_EDGE_PX;
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas.toDataURL("image/png");
    ctx.fillStyle = color || "#ffffff";
    ctx.fillRect(0, 0, outW, outH);
    return canvas.toDataURL("image/png");
  }

  function applyPanelRenderOverrides(
    urls: { position: string; dataUrl: string }[],
    exportMode: EditorMode,
  ): { position: string; dataUrl: string }[] {
    return urls.map((entry) => {
      if (shouldRenderPanelArtworkForMode(entry.position, exportMode)) return entry;
      return {
        position: entry.position,
        dataUrl: buildSolidPanelDataUrl(panelFillColor),
      };
    });
  }

  // ── Apply handler ──────────────────────────────────────────────────────────

  const handleApply = useCallback(async () => {
    if (!motifImage) return;
    setApplyLoading(true);
    try {
      const mockupPixelCap = getAdaptiveMockupPanelPx();

      if (mode !== "place" || panelPositions.length === 0) {
        if (mode === "pattern" && panelPositions.length > 0) {
          // Pattern mode WITH AOP panels: render twice — smaller rasters for Printify mockup API,
          // higher cap for persisted print files (designState) used on fulfillment.
          const buildPatternAopPanelUrls = async (pixelCap: number): Promise<{ position: string; dataUrl: string }[]> => {
            const urls: { position: string; dataUrl: string }[] = [];
            const patternCompositeCovered = new Set<string>();

            if (productKind === "leggings" && (syncSidesMode || mirrorMode)) {
              const rightDef = panelPositions.find(p =>
                isLeggingsLegSlot(p.position) && p.position.toLowerCase().includes("right")
              );
              const leftDef = panelPositions.find(p => {
                const l = p.position.toLowerCase();
                return isLeggingsLegSlot(p.position) && l.includes("left") && !l.includes("right");
              });

              if (rightDef && leftDef) {
                const rightPos = rightDef.position;
                const leftPos  = leftDef.position;
                const scaleRatio = Math.min(1, pixelCap /
                  Math.max(rightDef.width, rightDef.height, leftDef.width, leftDef.height));
                const outWR = Math.max(1, Math.round(rightDef.width  * scaleRatio));
                const outHR = Math.max(1, Math.round(rightDef.height * scaleRatio));
                const outWL = Math.max(1, Math.round(leftDef.width   * scaleRatio));
                const outHL = Math.max(1, Math.round(leftDef.height  * scaleRatio));

                const renderPanel = (outW: number, outH: number, flipH: boolean) => {
                  const c = document.createElement("canvas");
                  c.width = outW; c.height = outH;
                  const cx = c.getContext("2d")!;
                  if (bgColor && bgColor !== "transparent") {
                    cx.fillStyle = bgColor; cx.fillRect(0, 0, outW, outH);
                  }
                  const tileWPrint = Math.max(4, tileInches * PRINT_DPI * scaleRatio);
                  const offsetPrintPx = (patternOffsetX / 100) * tileWPrint;
                  drawTiledMotifInRect(cx, motifImage, 0, 0, outW, outH, tileInches, patternType, PRINT_DPI * scaleRatio, offsetPrintPx, 0);
                  if (!flipH) return c;
                  const f = document.createElement("canvas");
                  f.width = outW; f.height = outH;
                  const fx = f.getContext("2d")!;
                  fx.translate(outW, 0); fx.scale(-1, 1); fx.drawImage(c, 0, 0);
                  return f;
                };

                const flipCanvas = (src: HTMLCanvasElement, w: number, h: number) => {
                  const f = document.createElement("canvas");
                  f.width = w; f.height = h;
                  const fx = f.getContext("2d")!;
                  fx.translate(w, 0); fx.scale(-1, 1); fx.drawImage(src, 0, 0, w, h);
                  return f;
                };

                if (syncSidesMode) {
                  const compositeW = outWR + outWL;
                  const compositeH = Math.max(outHR, outHL);
                  const comp = document.createElement("canvas");
                  comp.width = compositeW; comp.height = compositeH;
                  const cCtx = comp.getContext("2d")!;
                  if (bgColor && bgColor !== "transparent") {
                    cCtx.fillStyle = bgColor; cCtx.fillRect(0, 0, compositeW, compositeH);
                  }
                  const tileWPrint = Math.max(4, tileInches * PRINT_DPI * scaleRatio);
                  const offsetPrintPx = (patternOffsetX / 100) * tileWPrint;
                  drawTiledMotifInRect(cCtx, motifImage, 0, 0, compositeW, compositeH, tileInches, patternType, PRINT_DPI * scaleRatio, offsetPrintPx, 0);

                  const cropR = document.createElement("canvas");
                  cropR.width = outWR; cropR.height = outHR;
                  cropR.getContext("2d")!.drawImage(comp, 0, 0, outWR, outHR, 0, 0, outWR, outHR);
                  urls.push({ position: rightPos, dataUrl: canvasToUploadDataUrl(flipCanvas(cropR, outWR, outHR), pixelCap) });

                  const cropL = document.createElement("canvas");
                  cropL.width = outWL; cropL.height = outHL;
                  cropL.getContext("2d")!.drawImage(comp, outWR, 0, outWL, outHL, 0, 0, outWL, outHL);
                  urls.push({ position: leftPos, dataUrl: canvasToUploadDataUrl(flipCanvas(cropL, outWL, outHL), pixelCap) });
                } else {
                  const rightExport = renderPanel(outWR, outHR, true);
                  urls.push({ position: rightPos, dataUrl: canvasToUploadDataUrl(rightExport, pixelCap) });
                  urls.push({ position: leftPos,  dataUrl: canvasToUploadDataUrl(flipCanvas(rightExport, outWL, outHL), pixelCap) });
                }

                patternCompositeCovered.add(rightPos);
                patternCompositeCovered.add(leftPos);
              }
            }

            for (const p of panelPositions) {
              if (patternCompositeCovered.has(p.position)) continue;
              if (!shouldRenderPanelArtworkForMode(p.position, "pattern")) {
                urls.push({ position: p.position, dataUrl: buildSolidPanelDataUrl(panelFillColor) });
                continue;
              }
              const scaleRatio = Math.min(1, pixelCap / Math.max(p.width, p.height));
              const outW = Math.max(1, Math.round(p.width  * scaleRatio));
              const outH = Math.max(1, Math.round(p.height * scaleRatio));
              const renderScale = scaleRatio;
              const canvas = document.createElement("canvas");
              canvas.width = outW;
              canvas.height = outH;
              const ctx = canvas.getContext("2d")!;
              if (bgColor && bgColor !== "transparent") {
                ctx.fillStyle = bgColor;
                ctx.fillRect(0, 0, outW, outH);
              }
              const panelPatternSpec = getPatternSpecForPanel(p.position);
              drawTiledMotifInRect(ctx, motifImage, 0, 0, outW, outH, panelPatternSpec.tileInches, patternType, PRINT_DPI * renderScale,
                (panelPatternSpec.offsetX / 100) * Math.max(4, panelPatternSpec.tileInches * PRINT_DPI * renderScale), 0);
              let outForUpload: HTMLCanvasElement = canvas;
              if (shouldFlipLeggingsLegSlot(productKind, p.position)) {
                const flipped = document.createElement("canvas");
                flipped.width = outW;
                flipped.height = outH;
                const fx = flipped.getContext("2d")!;
                fx.translate(outW, 0);
                fx.scale(-1, 1);
                fx.drawImage(canvas, 0, 0);
                outForUpload = flipped;
              }
              urls.push({ position: p.position, dataUrl: canvasToUploadDataUrl(outForUpload, pixelCap) });
            }
            return urls;
          };

          const panelUrls = applyPanelRenderOverrides(await buildPatternAopPanelUrls(mockupPixelCap), "pattern");
          await onApply(motifUrl, {
            mode,
            patternType,
            tileInches: productKind === "hoodie" ? getPatternSpecForView("front").tileInches : tileInches,
            bgColor,
            panelUrls,
            getPrintPanelUrls: async () =>
              applyPanelRenderOverrides(await buildPatternAopPanelUrls(MAX_PANEL_PRINT_PX), "pattern"),
            perPanelTransforms,
            panelRenderConfig,
          });
          return;
        }

        // Single mode or no panel data: one large tiled canvas (legacy / non-AOP path).
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
        drawTiledMotifInRect(ctx, motifImage, 0, 0, TILE_OUT, TILE_OUT, tileInches, patternType, PRINT_DPI);
        const tiledDataUrl = canvasToUploadDataUrl(canvas, 4096);
        await onApply(tiledDataUrl, {
          mode,
          patternType,
          tileInches,
          bgColor,
          perPanelTransforms,
          panelRenderConfig,
        });
        return;
      }

      const buildPlaceModePanelUrls = async (pixelCap: number): Promise<{ position: string; dataUrl: string }[]> => {
        const panelUrls: { position: string; dataUrl: string }[] = [];
        const seamPairs = getSeamPairs(panelPositions);

        // Track which positions are handled by composite export
        const compositeCovered = new Set<string>();

        // Legging seam-pair panels: render as a single composite then crop each side.
        // Hoodie split panels export independently below so the mockup uses the same
        // per-panel transform math as the visible customizer preview.
        // This guarantees artwork continuity across the seam with no pixel offset.
        for (const [leftPos, rightPos] of seamPairs) {
          if (productKind === "hoodie" || !syncSidesMode) {
            continue;
          }
          if (!shouldRenderPanelArtworkForMode(leftPos, "place") || !shouldRenderPanelArtworkForMode(rightPos, "place")) {
            panelUrls.push({ position: rightPos, dataUrl: buildSolidPanelDataUrl(panelFillColor) });
            panelUrls.push({ position: leftPos, dataUrl: buildSolidPanelDataUrl(panelFillColor) });
            compositeCovered.add(rightPos);
            compositeCovered.add(leftPos);
            continue;
          }
          const rightDef = panelPositions.find(p => p.position === rightPos);
          const leftDef  = panelPositions.find(p => p.position === leftPos);
          if (!rightDef || !leftDef) continue;

          // Cap to pixelCap per-panel to avoid iOS canvas memory limits.
          const cScaleRatio = Math.min(1, pixelCap / Math.max(rightDef.width, rightDef.height));
          const cRW = Math.max(1, Math.round(rightDef.width  * cScaleRatio));
          const cLW = Math.max(1, Math.round(leftDef.width   * cScaleRatio));
          const cH  = Math.max(1, Math.round(Math.max(rightDef.height, leftDef.height) * cScaleRatio));
          const cTotalW = cRW + cLW;

          // Compute upscale: preview → output canvas px (= print px × cScaleRatio).
          const view = getPanelGroup(rightPos);
          const layout = buildCompositeLayout(view, panelPositions, svgImages);
          const previewCanvasH = computePanelCanvasHeight(previewPx, layout, productKind, panelPositions);
          const layoutScl = layout.compositeW > 0
            ? Math.min((previewPx - 20) / layout.compositeW, (previewCanvasH - 20) / layout.compositeH, 1)
            : 1;
          const rightPreviewSlotW = rightDef.width * layoutScl;
          const rightPreviewSlotH = rightDef.height * layoutScl;
          const upscale = cRW / (rightPreviewSlotW || cRW);
          const upscaleY = cH / (rightPreviewSlotH || cH);

          const tRight = perPanelTransforms[rightPos] || { dxPx: 0, dyPx: 0, scalePct: 100 };
          const printT: PanelTransform = {
            dxPx: tRight.dxPx * upscale,
            dyPx: tRight.dyPx * upscaleY,
            scalePct: tRight.scalePct,
          };

          // Render composite canvas at capped dimensions
          const compositeCanvas = document.createElement("canvas");
          compositeCanvas.width  = cTotalW;
          compositeCanvas.height = cH;
          const ctx = compositeCanvas.getContext("2d")!;
          if (bgColor && bgColor !== "transparent") {
            ctx.fillStyle = bgColor;
            ctx.fillRect(0, 0, cTotalW, cH);
          }

          // Draw SVG sew-pattern backgrounds
          const rightSvgImg = svgImages[rightPos] || svgImages[mapPositionToSvgName(rightPos)];
          const leftSvgImg  = svgImages[leftPos]  || svgImages[mapPositionToSvgName(leftPos)];
          if (rightSvgImg) ctx.drawImage(rightSvgImg, 0,    0, cRW, cH);
          if (leftSvgImg)  ctx.drawImage(leftSvgImg,  cRW,  0, cLW, cH);

          // Draw artwork across the full composite (seam continuity).
          drawArtworkInSlot(ctx, motifImage, 0, 0, cTotalW, cH, printT, false);

          // Crop right panel
          const cropRight = document.createElement("canvas");
          cropRight.width  = cRW;
          cropRight.height = cH;
          cropRight.getContext("2d")!.drawImage(compositeCanvas, 0, 0, cRW, cH, 0, 0, cRW, cH);
          panelUrls.push({ position: rightPos, dataUrl: canvasToUploadDataUrl(cropRight, pixelCap) });

          // Crop left panel (or mirror-flip if mirrorMode)
          const cropLeft = document.createElement("canvas");
          cropLeft.width  = cLW;
          cropLeft.height = cH;
          const ctxL = cropLeft.getContext("2d")!;
          if (mirrorMode) {
            ctxL.save();
            ctxL.translate(cLW, 0);
            ctxL.scale(-1, 1);
            ctxL.drawImage(compositeCanvas, 0, 0, cLW, cH, 0, 0, cLW, cH);
            ctxL.restore();
          } else {
            ctxL.drawImage(compositeCanvas, cRW, 0, cLW, cH, 0, 0, cLW, cH);
          }
          panelUrls.push({ position: leftPos, dataUrl: canvasToUploadDataUrl(cropLeft, pixelCap) });

          compositeCovered.add(rightPos);
          compositeCovered.add(leftPos);
        }

      // ── Leggings leg composite export (seam crossing when seamBleedPx > 0) ────
      // Draws both leg panels from a single composite canvas so artwork naturally
      // crosses the front seam. The right panel export matches the individual path
      // exactly; the left panel gets the continuation (or symT for syncSidesMode).
      if (productKind === "leggings" && seamBleedPx > 0) {
        const rightDef = panelPositions.find(p =>
          isLeggingsLegSlot(p.position) && p.position.toLowerCase().includes("right")
        );
        const leftDef = panelPositions.find(p => {
          const l = p.position.toLowerCase();
          return isLeggingsLegSlot(p.position) && l.includes("left") && !l.includes("right");
        });

        if (rightDef && leftDef) {
          const rightPos = rightDef.position;
          const leftPos  = leftDef.position;

          // Cap to pixelCap per-panel to avoid iOS canvas memory limits.
          const cScaleRatio = Math.min(1, pixelCap / Math.max(rightDef.width, rightDef.height));
          const cRW = Math.max(1, Math.round(rightDef.width  * cScaleRatio));
          const cLW = Math.max(1, Math.round(leftDef.width   * cScaleRatio));
          const cH  = Math.max(1, Math.round(Math.max(rightDef.height, leftDef.height) * cScaleRatio));
          const cTotalW = cRW + cLW;

          // Upscale: preview slot px → output canvas px (= print px × cScaleRatio).
          const layout = buildLinearPanelsLayout(panelPositions, 0);
          const layoutScl = layout.compositeW > 0
            ? Math.min((previewPx - 20) / layout.compositeW, (previewPx - 20) / layout.compositeH, 1)
            : 1;
          const rightSlot = layout.slots.find(s => s.position === rightPos);
          const previewSlotW = rightSlot ? rightSlot.w * layoutScl : previewPx;
          const previewSlotH = rightSlot ? rightSlot.h * layoutScl : previewPx;
          const upscaleX = cRW / (previewSlotW || cRW);
          const upscaleY = cH  / (previewSlotH || cH);

          const tRight = perPanelTransforms[rightPos] || { dxPx: 0, dyPx: 0, scalePct: 100 };

          // Drawing with slotW = cRW (not cTotalW) gives identical baseScale to exportPanelImage.
          // The canvas is composite-wide so art that overflows cRW bleeds into the left region.
          const rightPrintT: PanelTransform = {
            dxPx:     tRight.dxPx * upscaleX,
            dyPx:     tRight.dyPx * upscaleY,
            scalePct: tRight.scalePct,
          };

          const compositeCanvas = document.createElement("canvas");
          compositeCanvas.width  = cTotalW;
          compositeCanvas.height = cH;
          const cCtx = compositeCanvas.getContext("2d")!;
          if (bgColor && bgColor !== "transparent") {
            cCtx.fillStyle = bgColor;
            cCtx.fillRect(0, 0, cTotalW, cH);
          }
          drawArtworkInSlot(cCtx, motifImage, 0, 0, cRW, cH, rightPrintT, false);

          // Crop right panel then flip (same as shouldFlipLeggingsLegSlot)
          const cropR = document.createElement("canvas");
          cropR.width = cRW; cropR.height = cH;
          cropR.getContext("2d")!.drawImage(compositeCanvas, 0, 0, cRW, cH, 0, 0, cRW, cH);
          const flipR = document.createElement("canvas");
          flipR.width = cRW; flipR.height = cH;
          const frCtx = flipR.getContext("2d")!;
          frCtx.translate(cRW, 0); frCtx.scale(-1, 1);
          frCtx.drawImage(cropR, 0, 0);
          panelUrls.push({ position: rightPos, dataUrl: canvasToUploadDataUrl(flipR, pixelCap) });

          // Left panel: handle all three modes explicitly.
          if (mirrorMode) {
            // Mirror: render right panel artwork directly without the Printify leg-flip.
            // Equivalent to the previous double-flip (right export → flip again) without
            // the WebKit new Image(dataUrl) round-trip that silently fails on iOS.
            const mirrorCanvas = document.createElement("canvas");
            mirrorCanvas.width  = cLW;
            mirrorCanvas.height = cH;
            const mCtx = mirrorCanvas.getContext("2d")!;
            if (bgColor && bgColor !== "transparent") {
              mCtx.fillStyle = bgColor;
              mCtx.fillRect(0, 0, cLW, cH);
            }
            // Draw from motifImage at the right panel transform (unflipped) — this produces
            // the same visual result as (right flipped) flipped again = unflipped.
            mCtx.drawImage(flipR, 0, 0, cLW, cH);
            panelUrls.push({ position: leftPos, dataUrl: canvasToUploadDataUrl(mirrorCanvas, pixelCap) });
          } else if (syncSidesMode) {
            const symT: PanelTransform = { ...tRight, dxPx: -tRight.dxPx };
            const dataUrl = await exportPanelImage(leftDef, motifImage, symT, pixelCap);
            panelUrls.push({ position: leftPos, dataUrl });
          } else {
            const dataUrl = await exportPanelImage(leftDef, motifImage, undefined, pixelCap);
            panelUrls.push({ position: leftPos, dataUrl });
          }

          compositeCovered.add(rightPos);
          compositeCovered.add(leftPos);
        }
      }

      // Remaining panels: independent per-panel export
      // For leggings mirror mode: left leg mirrors the right leg's artwork
        for (const p of panelPositions) {
        if (compositeCovered.has(p.position)) continue;
        if (!shouldRenderPanelArtworkForMode(p.position, "place")) {
          panelUrls.push({ position: p.position, dataUrl: buildSolidPanelDataUrl(panelFillColor) });
          continue;
        }

        const panelLower = p.position.toLowerCase();
        const isLeft = panelLower.includes("left");
        const isLeggings = productKind === "leggings";
        const isHoodieSyncedPanel =
          productKind === "hoodie" &&
          isLeft &&
          getPanelGroup(p.position) !== "back" &&
          !isHoodieTrimPanel(p.position) &&
          !isHoodiePocketPanel(p.position);
        const doMirror = mirrorMode && isLeggings && isLeft;
        const doSyncSides = syncSidesMode && ((isLeggings && isLeft) || isHoodieSyncedPanel);

        if (doMirror) {
          // Find the paired right panel
          const rightPanel = panelPositions.find(q => {
            const ql = q.position.toLowerCase();
            return ql.includes("right") &&
              (ql.includes("side") || ql.includes("leg")) &&
              !compositeCovered.has(q.position);
          });
          if (rightPanel) {
            // Render the right panel's artwork directly on the left panel canvas without
            // the Printify leg-slot flip.  This matches the old behaviour of
            // (right panel export → flip again) = double-flip = unflipped, but eliminates
            // the WebKit new Image(dataUrl) round-trip that stalls / fails silently on iOS.
            const scaleRatio = Math.min(1, pixelCap / Math.max(p.width, p.height));
            const outW = Math.max(1, Math.round(p.width  * scaleRatio));
            const outH = Math.max(1, Math.round(p.height * scaleRatio));

            const { compositeW: lW, compositeH: lH, slots: lSlots } = buildLinearPanelsLayout(panelPositions, 0);
            const lScl = lW > 0 ? Math.min((previewPx - 20) / lW, (previewPx - 20) / lH, 1) : 1;
            const rSlot = lSlots.find(s => s.position === rightPanel.position);
            const rPreviewW = rSlot ? rSlot.w * lScl : previewPx;
            const rPreviewH = rSlot ? rSlot.h * lScl : previewPx;
            const upX = outW / (rPreviewW || outW);
            const upY = outH / (rPreviewH || outH);

            const rightT = perPanelTransforms[rightPanel.position] || { dxPx: 0, dyPx: 0, scalePct: 100 };
            const mirrorDrawT: PanelTransform = {
              dxPx:     rightT.dxPx * upX,
              dyPx:     rightT.dyPx * upY + LEGGINGS_EXPORT_DY_OFFSET_PX * scaleRatio,
              scalePct: rightT.scalePct,
            };

            const mirrorCanvas = document.createElement("canvas");
            mirrorCanvas.width  = outW;
            mirrorCanvas.height = outH;
            const mCtx = mirrorCanvas.getContext("2d")!;
            if (bgColor && bgColor !== "transparent") {
              mCtx.fillStyle = bgColor;
              mCtx.fillRect(0, 0, outW, outH);
            }
            drawArtworkInSlot(mCtx, motifImage, 0, 0, outW, outH, mirrorDrawT, false);
            panelUrls.push({ position: p.position, dataUrl: canvasToUploadDataUrl(mirrorCanvas, pixelCap) });
            continue;
          }
        }

        if (doSyncSides) {
          // Sync sides: left panel uses symmetric horizontal offset of the right/canonical panel (no artwork flip).
          const rightPanel = panelPositions.find(q => {
            const ql = q.position.toLowerCase();
            if (!ql.includes("right") || compositeCovered.has(q.position)) return false;
            if (isLeggings) return ql.includes("side") || ql.includes("leg");
            return (
              getPanelGroup(q.position) === getPanelGroup(p.position) &&
              !isHoodieTrimPanel(q.position) &&
              !isHoodiePocketPanel(q.position)
            );
          });
          if (rightPanel) {
            const rightT = perPanelTransforms[rightPanel.position] || { dxPx: 0, dyPx: 0, scalePct: 100 };
            const symT = { ...rightT, dxPx: -rightT.dxPx };
            const dataUrl = await exportPanelImage(p, motifImage, symT, pixelCap);
            panelUrls.push({ position: p.position, dataUrl });
            continue;
          }
        }

        const dataUrl = await exportPanelImage(p, motifImage, undefined, pixelCap);
        panelUrls.push({ position: p.position, dataUrl });
      }

        return panelUrls;
      };

      // Place mode now follows the same split pipeline as pattern mode:
      // low-res preview assets first, high-res fulfillment assets only when needed.
      const panelUrls = applyPanelRenderOverrides(await buildPlaceModePanelUrls(mockupPixelCap), "place");
      await onApply(motifUrl, {
        mode,
        panelUrls,
        getPrintPanelUrls: async () =>
          applyPanelRenderOverrides(await buildPlaceModePanelUrls(MAX_PANEL_PRINT_PX), "place"),
        mirrorLegs: mirrorMode,
        seamOffset: seamBleedPx,
        perPanelTransforms,
        panelRenderConfig,
      });
    } catch (err) {
      console.error("[PatternCustomizer] Apply failed:", err);
    } finally {
      setApplyLoading(false);
    }
  }, [mode, motifImage, motifUrl, panelPositions, patternType, tileInches, bgColor,
      perPanelTransforms, panelRenderConfig, mirrorMode, syncSidesMode, seamBleedPx, patternOffsetX, getPatternSpecForPanel, getPatternSpecForView, svgImages, productKind, aopTemplateId, onApply, previewPx, panelFillColor, shouldRenderPanelArtwork, shouldRenderPanelArtworkForMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Panel list for controls ────────────────────────────────────────────────

  const panelGroups: Record<string, Array<{ position: string; width: number; height: number }>> = {};
  for (const p of panelPositions) {
    const g = productKind === "hoodie" ? getPanelGroup(p.position) : "all";
    if (!panelGroups[g]) panelGroups[g] = [];
    panelGroups[g].push(p);
  }

  const isLoading = applyLoading || !!externalLoading;
  /** Under Sync Sides, scale/reset edit the canonical right-side transform so sliders work from either side. */
  const transformEditPanelId = useMemo(
    () => canonicalTransformPanelId(activePanel, syncSidesMode, panelPositions, productKind),
    [activePanel, syncSidesMode, panelPositions, productKind],
  );
  const activePanelT = transformEditPanelId
    ? (perPanelTransforms[transformEditPanelId] || { dxPx: 0, dyPx: 0, scalePct: 100 })
    : null;

  // ── Render ─────────────────────────────────────────────────────────────────

  /** Radix Slider: Root > Track (span) > Range; Thumb is sibling span — no data-slot. */
  const sliderTrackClass =
    "mt-1 [&>span:first-child]:rounded-full [&>span:first-child]:ring-2 [&>span:first-child]:ring-foreground/35 [&>span:first-child]:bg-muted-foreground/25 dark:[&>span:first-child]:bg-muted-foreground/40 [&>span:first-child>span]:bg-foreground [&>span:last-child]:border-2 [&>span:last-child]:border-foreground [&>span:last-child]:bg-background";

  return (
    <div className="w-full h-full min-h-0 flex flex-col">
      {/* Slightly slimmer control column so the preview (ResizeObserver width) is wider on lg+ */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.25fr)_minmax(180px,220px)] gap-3 sm:gap-4 p-2 sm:p-3 flex-1 min-h-0 items-start">
        {/* Preview — cap height on tall hood/front composites so the step stays above the fold in embeds */}
        <div className="flex flex-col min-h-0 min-w-0 w-full max-w-full max-h-[min(88vh,960px)]">
          <div
            ref={previewWrapRef}
            className="relative w-full border-2 border-foreground/20 rounded-md bg-muted/50 overflow-hidden"
            style={{ aspectRatio: `${canvasDims.w} / ${canvasDims.h}` }}
            data-appai-pc="2026.04.27.3"
            data-aop-kind={productKind}
            data-hoodie-pad={productKind === "hoodie" ? HOODIE_PREVIEW_PAD : undefined}
            data-hoodie-front-gap-print-px={productKind === "hoodie" ? HOODIE_FRONT_CENTER_GAP_PX : undefined}
            data-hoodie-hood-gap-print-px={productKind === "hoodie" ? HOODIE_HOOD_CENTER_GAP_PX : undefined}
          >
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full touch-none"
              style={{
                cursor: mode === "place" ? "grab" : "default",
                display: "block",
                touchAction: "none",
              }}
            />
          </div>

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

          <Button
            type="button"
            onClick={handleApply}
            disabled={isLoading}
            size="sm"
            className="w-full shrink-0 overflow-hidden"
          >
            {isLoading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Apply to Mockups
          </Button>

          {mode === "pattern" && (
            <>
              {productKind === "hoodie" && availableHoodieViews.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-xs">View</Label>
                  <div className="flex gap-1">
                    {availableHoodieViews.map((view) => (
                      <button
                        key={view}
                        type="button"
                        onClick={() => setActiveHoodieView(view)}
                        className={`flex-1 px-2 py-1.5 text-xs rounded-md capitalize border transition-colors ${
                          activeView === view
                            ? "bg-foreground text-background border-foreground"
                            : "bg-background border-border text-muted-foreground hover:border-foreground/40"
                        }`}
                      >
                        {view}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-snug">
                    Front, Back and Hood can use their own pattern size/alignment. Unedited views inherit Front.
                  </p>
                </div>
              )}

              <div>
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
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
                  {productKind === "hoodie" && (
                    <button
                      type="button"
                      onClick={() => setApplyAllover((v) => !v)}
                      className={`mt-5 h-9 shrink-0 rounded-md border px-3 text-xs font-medium transition-colors ${
                        applyAllover
                          ? "bg-foreground text-background border-foreground"
                          : "bg-background text-muted-foreground border-border hover:border-foreground/40"
                      }`}
                    >
                      Apply Allover
                    </button>
                  )}
                </div>
                {productKind === "hoodie" && (
                  <p className="mt-1 text-[10px] text-muted-foreground leading-snug">
                    {applyAllover
                      ? "Accent panels use the Front pattern specs."
                      : "Accent panels use the selected background colour."}
                  </p>
                )}
              </div>
              <div>
                <Label className="text-xs">Tile size: {activePatternTileInches.toFixed(2)}"</Label>
                <Slider
                  value={[activePatternTileInches]}
                  onValueChange={v => setActivePatternTileInches(Math.max(MIN_TILE_INCHES, Math.min(6, v[0])))}
                  min={MIN_TILE_INCHES}
                  max={6}
                  step={0.25}
                  className={sliderTrackClass}
                />
              </div>

              {panelPositions.length > 0 && (
                <div>
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Pattern alignment</Label>
                    {activePatternOffsetX !== 0 && (
                      <button
                        type="button"
                        onClick={() => setActivePatternOffsetX(0)}
                        className="text-[10px] text-muted-foreground underline"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  <Slider
                    value={[activePatternOffsetX]}
                    onValueChange={v => setActivePatternOffsetX(v[0])}
                    min={-50}
                    max={50}
                    step={1}
                    className={sliderTrackClass}
                  />
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {activePatternOffsetX === 0 ? "Centred" : activePatternOffsetX > 0 ? `+${activePatternOffsetX}% right` : `${activePatternOffsetX}% left`}
                  </p>
                </div>
              )}

              {/* Mirror / Sync Sides for leggings pattern mode */}
              {productKind === "leggings" && panelPositions.some(p => isLeggingsLegSlot(p.position)) && (
                <>
                  <div className="flex items-center justify-between gap-2 rounded-md border-2 border-foreground/30 px-2 py-1.5 bg-background">
                    <Label htmlFor="pat-mirror" className="text-xs cursor-pointer">
                      Mirror paired panel
                    </Label>
                    <Switch
                      id="pat-mirror"
                      checked={mirrorMode}
                      onCheckedChange={v => { setMirrorMode(v); if (v) setSyncSidesMode(false); }}
                      className="shrink-0 border-2 border-foreground/35 data-[state=checked]:bg-foreground data-[state=unchecked]:bg-muted-foreground/30"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-md border-2 border-foreground/30 px-2 py-1.5 bg-background">
                    <Label htmlFor="pat-sync-sides" className="text-xs cursor-pointer">
                      Sync sides
                    </Label>
                    <Switch
                      id="pat-sync-sides"
                      checked={syncSidesMode}
                      onCheckedChange={v => { setSyncSidesMode(v); if (v) setMirrorMode(false); }}
                      className="shrink-0 border-2 border-foreground/35 data-[state=checked]:bg-foreground data-[state=unchecked]:bg-muted-foreground/30"
                    />
                  </div>
                </>
              )}
            </>
          )}

          {mode === "place" && (
            <>
              {productKind === "hoodie" && availableHoodieViews.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-xs">View</Label>
                  <div className="flex gap-1">
                    {availableHoodieViews.map((view) => (
                      <button
                        key={view}
                        type="button"
                        onClick={() => setActiveHoodieView(view)}
                        className={`flex-1 px-2 py-1.5 text-xs rounded-md capitalize border transition-colors ${
                          activeView === view
                            ? "bg-foreground text-background border-foreground"
                            : "bg-background border-border text-muted-foreground hover:border-foreground/40"
                        }`}
                      >
                        {view}
                      </button>
                    ))}
                  </div>
                  {activePanel && (
                    <div className="flex items-center justify-between gap-2 rounded-md border-2 border-foreground/30 px-2 py-1.5 bg-background">
                      <Label htmlFor="panel-artwork-enabled" className="text-xs cursor-pointer">
                        Artwork enabled
                      </Label>
                      <Switch
                        id="panel-artwork-enabled"
                        checked={buildCompositeLayout(activeView, panelPositions, svgImages).slots.some((slot) =>
                          shouldRenderPanelArtwork(slot.position),
                        )}
                        onCheckedChange={(v) => {
                          const slots = buildCompositeLayout(activeView, panelPositions, svgImages).slots;
                          setPanelRenderConfig((prev) => {
                            const next = { ...prev };
                            for (const slot of slots) {
                              next[slot.position] = {
                                ...(prev[slot.position] || getDefaultPanelRenderConfig(slot.position, productKind, aopTemplateId)),
                                enabled: v,
                                mode: v ? "artwork" : "solid",
                              };
                            }
                            return next;
                          });
                        }}
                        className="shrink-0 border-2 border-foreground/35 data-[state=checked]:bg-foreground data-[state=unchecked]:bg-muted-foreground/30"
                      />
                    </div>
                  )}
                </div>
              )}

              {productKind === "hoodie" &&
                (activeView === "front" || activeView === "hood") &&
                buildCompositeLayout(activeView, panelPositions, svgImages).slots.length === 2 && (
                  <div className="flex items-center justify-between gap-2 rounded-md border-2 border-foreground/30 px-2 py-1.5 bg-background">
                    <Label htmlFor="hoodie-sync-sides" className="text-xs cursor-pointer">
                      Sync sides
                    </Label>
                    <Switch
                      id="hoodie-sync-sides"
                      checked={syncSidesMode}
                      onCheckedChange={v => {
                        setSyncSidesMode(v);
                        if (v) setMirrorMode(false);
                      }}
                      className="shrink-0 border-2 border-foreground/35 data-[state=checked]:bg-foreground data-[state=unchecked]:bg-muted-foreground/30"
                    />
                  </div>
                )}

              {activePanelT && transformEditPanelId && activePanel && shouldRenderPanelArtwork(activePanel) && (
                <div>
                  <Label className="text-xs">Artwork scale: {activePanelT.scalePct}%</Label>
                  <Slider
                    value={[activePanelT.scalePct]}
                    onValueChange={v => updatePanelTransform(transformEditPanelId, { scalePct: v[0] })}
                    min={20}
                    max={200}
                    step={5}
                    className={sliderTrackClass}
                  />
                </div>
              )}

              {activePanelT && transformEditPanelId && activePanel && shouldRenderPanelArtwork(activePanel) && (
                <button
                  type="button"
                  onClick={() => updatePanelTransform(transformEditPanelId, { dxPx: 0, dyPx: 0, scalePct: 100 })}
                  className="text-xs text-muted-foreground underline text-left"
                >
                  Reset panel
                </button>
              )}

              {productKind !== "hoodie" && activePanel && (
                <div className="flex items-center justify-between gap-2 rounded-md border-2 border-foreground/30 px-2 py-1.5 bg-background">
                  <Label htmlFor="panel-artwork-enabled" className="text-xs cursor-pointer">
                    Artwork enabled
                  </Label>
                  <Switch
                    id="panel-artwork-enabled"
                    checked={shouldRenderPanelArtwork(activePanel)}
                    onCheckedChange={(v) =>
                      setPanelRenderConfig((prev) => ({
                        ...prev,
                        [activePanel]: {
                          ...(prev[activePanel] || getDefaultPanelRenderConfig(activePanel, productKind, aopTemplateId)),
                          enabled: v,
                          mode: v ? "artwork" : "solid",
                        },
                      }))
                    }
                    className="shrink-0 border-2 border-foreground/35 data-[state=checked]:bg-foreground data-[state=unchecked]:bg-muted-foreground/30"
                  />
                </div>
              )}

              {productKind !== "hoodie" && (
                <div className="flex items-center justify-between gap-2 rounded-md border-2 border-foreground/30 px-2 py-1.5 bg-background">
                  <Label htmlFor="aop-mirror" className="text-xs cursor-pointer">
                    Mirror paired panel
                  </Label>
                  <Switch
                    id="aop-mirror"
                    checked={mirrorMode}
                    onCheckedChange={v => {
                      setMirrorMode(v);
                      if (v) setSyncSidesMode(false);
                    }}
                    className="shrink-0 border-2 border-foreground/35 data-[state=checked]:bg-foreground data-[state=unchecked]:bg-muted-foreground/30"
                  />
                </div>
              )}

              {productKind === "leggings" &&
                panelPositions.some(p => isLeggingsLegSlot(p.position)) && (
                  <div className="flex items-center justify-between gap-2 rounded-md border-2 border-foreground/30 px-2 py-1.5 bg-background">
                    <Label htmlFor="aop-sync-sides" className="text-xs cursor-pointer">
                      Sync sides
                    </Label>
                    <Switch
                      id="aop-sync-sides"
                      checked={syncSidesMode}
                      onCheckedChange={v => {
                        setSyncSidesMode(v);
                        if (v) setMirrorMode(false);
                      }}
                      className="shrink-0 border-2 border-foreground/35 data-[state=checked]:bg-foreground data-[state=unchecked]:bg-muted-foreground/30"
                    />
                  </div>
                )}


              <p className="text-[10px] text-muted-foreground leading-snug px-0.5">
                Dashed inner line is a <strong className="font-medium">guide</strong> only. Mockups use the full panel image; art placed near the edge can still show on the product. 3D previews may not match the flat template pixel-for-pixel.
              </p>

              {productKind === "leggings" && panelPositions.some(p => isLeggingsLegSlot(p.position)) && (
                <div>
                  <Label className="text-xs">
                    Front seam allowance: {seamBleedPx}px
                  </Label>
                  <Slider
                    value={[seamBleedPx]}
                    onValueChange={v => setSeamBleedPx(v[0])}
                    min={0}
                    max={100}
                    step={5}
                    className={sliderTrackClass}
                  />
                </div>
              )}
            </>
          )}

          <div>
            <Label className="text-xs">Background</Label>
            <div className="flex gap-1.5 mt-1 items-stretch">
              <Select
                value={bgColor === "" ? "transparent" : bgColor}
                onValueChange={v => setBgColor(v === "transparent" ? "" : v)}
              >
                <SelectTrigger className="h-9 text-xs min-w-0 flex-1 border-foreground/20">
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
              <button
                type="button"
                title="Pick colour from screen"
                aria-label="Pick colour from screen"
                onClick={async () => {
                  if (!("EyeDropper" in window)) return;
                  try {
                    // @ts-expect-error EyeDropper is not yet in TS lib
                    const result = await new window.EyeDropper().open();
                    setBgColor(result.sRGBHex);
                  } catch {
                    // cancelled or unsupported
                  }
                }}
                className="h-9 w-9 shrink-0 flex items-center justify-center rounded border-2 border-foreground/25 bg-background hover:border-foreground/50 transition-colors"
              >
                <Pipette className="w-4 h-4 text-muted-foreground" />
              </button>
              <input
                type="color"
                aria-label="Custom background colour"
                value={bgColor === "" ? "#ffffff" : bgColor}
                onChange={e => setBgColor(e.target.value)}
                className="w-9 h-9 shrink-0 rounded border-2 border-foreground/25 cursor-pointer bg-background"
              />
            </div>
          </div>

          {mode === "place" && productKind !== "hoodie" && panelPositions.length > 0 && (
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
