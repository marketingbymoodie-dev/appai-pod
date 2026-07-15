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
    meshTargetWidth > 0 ? flatCanvasW / meshTargetWidth : 1;
  let tilePxFlat = tilePxMockup * mockupToFlatScale * Math.max(0.01, outputScale);

  if (meshOverscanCompensation && visiblePolyWidth && visiblePolyWidth > 0 && meshTargetWidth > 0) {
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
