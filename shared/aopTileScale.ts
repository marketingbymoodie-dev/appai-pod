/**
 * Shared AOP tile-size math for HoodieAopPlacer pattern mode.
 *
 * Converts a real-world tile size (inches) into flat print-canvas pixels
 * consistently across every panel, regardless of blueprint or garment type.
 * Used by client preview/export and available for server-side validation.
 */

export type AopTileScaleInput = {
  tileSizeInches: number;
  pixelsPerInch: number;
  /** Flat print canvas width in pixels (from mesh.sourceRect or mesh target bbox). */
  flatCanvasW: number;
  /** Mesh targetPoints bbox width in mockup pixels — area the mesh maps onto. */
  meshTargetWidth: number;
  /** Visible panel polygon bbox width in mockup pixels (for preview warp compensation). */
  visiblePolyWidth?: number;
  outputScale?: number;
  /** Preview-only: compensate for mesh compressing overscanned flat sheet onto polygon. */
  meshOverscanCompensation?: boolean;
  /** When set, use this garment-wide scale instead of per-panel flatCanvasW / meshTargetWidth. */
  mockupToFlatScaleOverride?: number;
};

/**
 * Physical tile size on a flat print canvas (what Printify receives).
 * `mockupToFlatScale` converts mockup-calibrated inches into print-resolution px.
 */
export function computeTilePxOnFlatCanvas(input: AopTileScaleInput): number {
  const {
    tileSizeInches,
    pixelsPerInch,
    flatCanvasW,
    meshTargetWidth,
    visiblePolyWidth,
    outputScale = 1,
    meshOverscanCompensation = false,
  } = input;

  const tilePxMockup = Math.max(1, tileSizeInches * pixelsPerInch);
  const mockupToFlatScale =
    input.mockupToFlatScaleOverride ??
    (meshTargetWidth > 0 ? flatCanvasW / meshTargetWidth : 1);
  let tilePxFlat = tilePxMockup * mockupToFlatScale * Math.max(0.01, outputScale);

  if (
    meshOverscanCompensation &&
    input.mockupToFlatScaleOverride == null &&
    visiblePolyWidth &&
    visiblePolyWidth > 0 &&
    meshTargetWidth > 0
  ) {
    const previewStretch = Math.max(meshTargetWidth / visiblePolyWidth, 1);
    tilePxFlat *= previewStretch;
  }

  return tilePxFlat;
}

/** Preview-only stretch when mesh overscans past the visible polygon (mockup space). */
export function computePreviewMeshTileStretch(
  meshTargetWidth: number,
  visiblePolyWidth: number,
): number {
  if (meshTargetWidth <= 0 || visiblePolyWidth <= 0) return 1;
  return Math.max(meshTargetWidth / visiblePolyWidth, 1);
}

/** Body panel keys that benefit from bottom-edge bg bleed on print export. */
export const BODY_PRINT_BLEED_PANEL_KEYS = new Set([
  "front",
  "back",
  "front_left",
  "front_right",
]);

/** Fraction of canvas height to extend solid bg at bottom (covers body→waistband gaps). */
export const PRINT_PANEL_BOTTOM_BLEED_FRACTION = 0.025;

/** Fraction of canvas height to extend solid bg at top (covers shoulder / collar gaps). */
export const PRINT_PANEL_TOP_BLEED_FRACTION = 0.04;

/** Body/sleeve/hood panels used to derive a garment-wide mockup→flat scale for uniform tiles. */
export const TILE_SCALE_REFERENCE_PANEL_KEYS = new Set([
  "back",
  "front",
  "front_left",
  "front_right",
  "left_sleeve",
  "right_sleeve",
  "left_hood",
  "right_hood",
]);

export type MeshScaleSample = {
  panelKey: string | null | undefined;
  flatCanvasW: number;
  meshTargetWidth: number;
};

export function mockupToFlatScale(flatCanvasW: number, meshTargetWidth: number): number {
  if (meshTargetWidth <= 0 || flatCanvasW <= 0) return 1;
  return flatCanvasW / meshTargetWidth;
}

/**
 * Chest/back (+ sleeves) — reference panels for the garment-wide pattern-mode
 * tile scale. Applied as override on those panels only; hood/pocket keep
 * per-panel flat/mesh ratio (see `usesPerPanelPatternTileScale`).
 */
export const PATTERN_TILE_BODY_REFERENCE_KEYS = new Set([
  "front",
  "back",
  "front_left",
  "front_right",
  "left_sleeve",
  "right_sleeve",
]);

/**
 * Hood + pocket panels — keep native flat/mesh tile scale. Body median override
 * on these blows up density when `sourceRect` is missing or much larger than
 * the mesh (pullover front hoods/pocket), while zip pockets already match with
 * per-panel scale.
 */
export const PATTERN_TILE_PER_PANEL_KEYS = new Set([
  "left_hood",
  "right_hood",
  "front_pocket",
  "pocket_left",
  "pocket_right",
]);

export function usesPerPanelPatternTileScale(
  panelKey: string | null | undefined,
): boolean {
  return !!panelKey && PATTERN_TILE_PER_PANEL_KEYS.has(panelKey);
}

/**
 * Front + back body (incl. zip split fronts) — lock to the front body's
 * mockup→flat scale so Pattern mode density matches chest↔back.
 */
export const PATTERN_TILE_FRONT_MATCHED_BODY_KEYS = new Set([
  "front",
  "back",
  "front_left",
  "front_right",
]);

export function usesFrontMatchedBodyPatternTileScale(
  panelKey: string | null | undefined,
): boolean {
  return !!panelKey && PATTERN_TILE_FRONT_MATCHED_BODY_KEYS.has(panelKey);
}

/**
 * Prefer the full-front (or median of front halves) mockup→flat scale so the
 * back body tiles at the same physical density as the front. Used when native
 * per-panel ratios diverge (e.g. sweatshirt bp 449 back printing small).
 */
export function patternModeFrontBodyTileScale(samples: MeshScaleSample[]): number | null {
  const valid = samples.filter((s) => s.meshTargetWidth > 0 && s.flatCanvasW > 0);
  const front = valid.find((s) => s.panelKey === "front");
  if (front) return mockupToFlatScale(front.flatCanvasW, front.meshTargetWidth);

  const halves = valid.filter(
    (s) => s.panelKey === "front_left" || s.panelKey === "front_right",
  );
  if (halves.length === 0) return null;
  const ratios = halves
    .map((s) => mockupToFlatScale(s.flatCanvasW, s.meshTargetWidth))
    .sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  if (ratios.length % 2 === 0) {
    return (ratios[mid - 1] + ratios[mid]) / 2;
  }
  return ratios[mid] ?? null;
}

/**
 * One mockup→flat scale for pattern mode: median of chest/back/sleeve panels.
 * Apply as `mockupToFlatScaleOverride` on body/sleeve panels only.
 */
export function patternModeUniformTileScale(samples: MeshScaleSample[]): number | null {
  const body = samples.filter(
    (s) => s.panelKey && PATTERN_TILE_BODY_REFERENCE_KEYS.has(s.panelKey),
  );
  if (body.length > 0) {
    const ratios = body
      .map((s) => mockupToFlatScale(s.flatCanvasW, s.meshTargetWidth))
      .sort((a, b) => a - b);
    const mid = Math.floor(ratios.length / 2);
    if (ratios.length % 2 === 0) {
      return (ratios[mid - 1] + ratios[mid]) / 2;
    }
    return ratios[mid] ?? null;
  }
  return referenceMockupToFlatScale(samples);
}

/**
 * Pick one mockup→flat scale for the whole garment. Prefers the back body
 * panel (usually best calibrated); falls back to median of body/sleeve panels.
 */
export function referenceMockupToFlatScale(samples: MeshScaleSample[]): number | null {
  const valid = samples.filter((s) => s.meshTargetWidth > 0 && s.flatCanvasW > 0);
  const back = valid.find((s) => s.panelKey === "back");
  if (back) return mockupToFlatScale(back.flatCanvasW, back.meshTargetWidth);

  const body = valid.filter(
    (s) => s.panelKey && TILE_SCALE_REFERENCE_PANEL_KEYS.has(s.panelKey),
  );
  if (body.length === 0) return null;

  const ratios = body
    .map((s) => mockupToFlatScale(s.flatCanvasW, s.meshTargetWidth))
    .sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  if (ratios.length % 2 === 0) {
    return (ratios[mid - 1] + ratios[mid]) / 2;
  }
  return ratios[mid] ?? null;
}
