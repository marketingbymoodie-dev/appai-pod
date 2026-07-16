import type { MeshGrid } from "./hoodieTemplate";
import { isPulloverHoodieBlueprint } from "./hoodieTemplate";
import { mockupPointToMeshFlatPixel } from "./meshFlatInverse";

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

/**
 * Map mockup points onto the host panel's flat print canvas using the
 * host mesh inverse (correct for Printify UV space). Falls back to linear
 * bbox stretch when a point lies outside the meshed region.
 */
export function mapMockupPointsToHostFlat(
  points: MockupPoint[],
  hostMesh: MeshGrid | null | undefined,
  hostBb: MockupBbox,
  canvasW: number,
  canvasH: number,
): MockupPoint[] {
  const src = hostMesh?.sourceRect;
  const srcW = src && src.width > 0 ? src.width : canvasW;
  const srcH = src && src.height > 0 ? src.height : canvasH;
  const sx = canvasW / Math.max(1, srcW);
  const sy = canvasH / Math.max(1, srcH);

  return points.map((p) => {
    if (hostMesh) {
      const mapped = mockupPointToMeshFlatPixel(p, hostMesh, srcW, srcH);
      if (mapped) {
        return { x: mapped.x * sx, y: mapped.y * sy };
      }
    }
    return mapMockupPointToFrontFlat(p, hostBb, canvasW, canvasH);
  });
}

export { mockupPointToMeshFlatPixel };

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
