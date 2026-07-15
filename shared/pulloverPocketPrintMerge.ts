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

/** Printify bp 450 only accepts front/back/sleeves — pocket art must bake into `front`. */
export function shouldMergePulloverPocketForPrintify(
  blueprintId: number | null | undefined,
  pocketsEnabled: boolean,
): boolean {
  return pocketsEnabled && isPulloverHoodieBlueprint(blueprintId);
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
