import { isPulloverHoodieBlueprint } from "./hoodieTemplate";

export type PulloverPocketOverlayRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MockupBbox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MockupPoint = { x: number; y: number };

/** Printify bp 450 only accepts front/back/sleeves — pocket art must bake into `front`. */
export function shouldMergePulloverPocketForPrintify(
  blueprintId: number | null | undefined,
  pocketsEnabled: boolean,
  hoodieType?: string | null,
): boolean {
  if (!pocketsEnabled) return false;
  return (
    isPulloverHoodieBlueprint(blueprintId) ||
    hoodieType === "pullover-hoodie-aop"
  );
}

/** Map overlay rect using reference bboxes (mesh target or polygon) in mockup space. */
export function overlayRectOnReferencePanel(
  hostBb: MockupBbox,
  overlayBb: MockupBbox,
  hostCanvasW: number,
  hostCanvasH: number,
): PulloverPocketOverlayRect {
  return pocketOverlayRectOnFrontPanel(hostBb, overlayBb, hostCanvasW, hostCanvasH);
}

/**
 * Map one mockup pixel into the host panel's flat print canvas. The host
 * reference bbox is the front mesh target extent (same frame as preview).
 */
export function mapMockupPointToFrontFlat(
  p: MockupPoint,
  hostBb: MockupBbox,
  flatW: number,
  flatH: number,
): MockupPoint {
  return {
    x: ((p.x - hostBb.x) / Math.max(1, hostBb.width)) * flatW,
    y: ((p.y - hostBb.y) / Math.max(1, hostBb.height)) * flatH,
  };
}

export function mapMockupPointsToFrontFlat(
  points: MockupPoint[],
  hostBb: MockupBbox,
  flatW: number,
  flatH: number,
): MockupPoint[] {
  return points.map((p) => mapMockupPointToFrontFlat(p, hostBb, flatW, flatH));
}

/** Fill a rectangle on a canvas — used to punch out underlying art before overlay. */
export function punchOutRectOnCanvas(
  ctx: CanvasRenderingContext2D,
  rect: PulloverPocketOverlayRect,
  fillColor: string,
): void {
  ctx.fillStyle = fillColor;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
}

/** Map the pocket mask bbox into front-panel canvas pixels (mockup-calibrated). */
export function pocketOverlayRectOnFrontPanel(
  frontBb: MockupBbox,
  pocketBb: MockupBbox,
  frontCanvasW: number,
  frontCanvasH: number,
): PulloverPocketOverlayRect {
  if (frontBb.width <= 0 || frontBb.height <= 0) {
    return { x: 0, y: 0, width: frontCanvasW, height: frontCanvasH };
  }
  const scaleX = frontCanvasW / frontBb.width;
  const scaleY = frontCanvasH / frontBb.height;
  return {
    x: (pocketBb.x - frontBb.x) * scaleX,
    y: (pocketBb.y - frontBb.y) * scaleY,
    width: pocketBb.width * scaleX,
    height: pocketBb.height * scaleY,
  };
}
