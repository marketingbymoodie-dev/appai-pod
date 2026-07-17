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

/**
 * Pullover kangaroo pocket is exported as its own Printify panel (like zip
 * `pocket_left` / `pocket_right`), not baked into `front`. Live bp 450
 * placeholders include a pocket slot — omitting it makes the mockup server
 * fill that slot with solid bgColor (blank pocket overlay).
 */
export function shouldExportPulloverPocketAsPrintifyPanel(
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

/** @deprecated Use shouldExportPulloverPocketAsPrintifyPanel */
export function shouldMergePulloverPocketForPrintify(
  blueprintId: number | null | undefined,
  pocketsEnabled: boolean,
  hoodieType?: string | null,
): boolean {
  return shouldExportPulloverPocketAsPrintifyPanel(
    blueprintId,
    pocketsEnabled,
    hoodieType,
  );
}

/**
 * Printify may name the pullover kangaroo placeholder `front_pocket`, `pocket`,
 * or similar. Match uploaded panel URLs onto discovered placeholder positions.
 */
export function resolvePrintifyPanelImageId(
  position: string,
  panelImageIds: Map<string, string>,
): string | undefined {
  if (panelImageIds.has(position)) return panelImageIds.get(position);
  const aliases = PRINTIFY_PANEL_POSITION_ALIASES[position];
  if (aliases) {
    for (const alias of aliases) {
      if (panelImageIds.has(alias)) return panelImageIds.get(alias);
    }
  }
  // Any pocket-like placeholder ↔ any uploaded pocket-like panel.
  if (isPocketLikePrintifyPosition(position)) {
    for (const [key, id] of panelImageIds) {
      if (isPocketLikePrintifyPosition(key)) return id;
    }
  }
  return undefined;
}

/**
 * When the client omitted the kangaroo panel, reuse the front-body print
 * image instead of solid bgColor — blank white pockets are worse than a
 * slightly mismatched tile scale on the pocket overlay.
 */
export function resolvePocketFallbackImageId(
  panelImageIds: Map<string, string>,
): string | undefined {
  return (
    panelImageIds.get("front") ??
    panelImageIds.get("front_left") ??
    panelImageIds.get("front_right")
  );
}

/** Placeholder position → accepted client panelUrl position names. */
export const PRINTIFY_PANEL_POSITION_ALIASES: Record<string, string[]> = {
  front_pocket: ["front_pocket", "pocket", "kangaroo_pocket", "front_pocket_panel"],
  pocket: ["pocket", "front_pocket", "kangaroo_pocket", "front_pocket_panel"],
  kangaroo_pocket: ["kangaroo_pocket", "front_pocket", "pocket", "front_pocket_panel"],
  front_pocket_panel: ["front_pocket_panel", "front_pocket", "pocket", "kangaroo_pocket"],
};

const POCKET_ALIAS_NAMES = new Set(
  Object.keys(PRINTIFY_PANEL_POSITION_ALIASES).concat(
    ...Object.values(PRINTIFY_PANEL_POSITION_ALIASES),
  ),
);

export function isPocketLikePrintifyPosition(position: string): boolean {
  return /pocket/i.test(position) || POCKET_ALIAS_NAMES.has(position);
}

/**
 * After uploading client panelUrls, register each pocket image under every
 * known alias so live bp 450 placeholder names cannot miss the art.
 */
export function expandPanelImageIdsWithPocketAliases(
  panelImageIds: Map<string, string>,
): void {
  const additions: Array<[string, string]> = [];
  for (const [position, imageId] of panelImageIds) {
    if (!isPocketLikePrintifyPosition(position)) continue;
    const aliases =
      PRINTIFY_PANEL_POSITION_ALIASES[position] ??
      Array.from(POCKET_ALIAS_NAMES);
    for (const alias of aliases) {
      if (!panelImageIds.has(alias)) {
        additions.push([alias, imageId]);
      }
    }
  }
  for (const [alias, imageId] of additions) {
    panelImageIds.set(alias, imageId);
  }
}

/**
 * If one hood half uploaded and the other didn't, reuse the sibling image.
 * Prevents a blank true-left/true-right hood when a single panel is omitted.
 */
export function expandHoodPanelImageIdsWithSiblingFallback(
  panelImageIds: Map<string, string>,
): void {
  const left = panelImageIds.get("left_hood");
  const right = panelImageIds.get("right_hood");
  if (left && !right) panelImageIds.set("right_hood", left);
  if (right && !left) panelImageIds.set("left_hood", right);
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

export function punchOutRectOnCanvas(
  ctx: CanvasRenderingContext2D,
  rect: PulloverPocketOverlayRect,
  fillColor: string,
): void {
  ctx.fillStyle = fillColor;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
}

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
