import type {
  AopPanelCurvature,
  AopProjectionMapJson,
  AopProjectionMeshCell,
  AopProjectionPanelMap,
  AopProjectionPoint,
  AopProjectionViewMap,
  RenderProjectedMockupParams,
} from "@shared/aopProjectionMap";
import { loadImage } from "../utils/imageLoader";

type ImageCache = Map<string, HTMLImageElement>;

function qualitySettings(quality: RenderProjectedMockupParams["quality"]) {
  switch (quality || "balanced") {
    case "draft":
      return { overlap: 0, feather: 0, shadowAlpha: 0.45, highlightAlpha: 0.35, qualityFactor: 1, seamPad: 0, seamFeather: 0 };
    case "production":
      return { overlap: 1.6, feather: 3, shadowAlpha: 0.62, highlightAlpha: 0.5, qualityFactor: 4, seamPad: 10, seamFeather: 14 };
    case "balanced":
    default:
      return { overlap: 1.0, feather: 1.5, shadowAlpha: 0.55, highlightAlpha: 0.45, qualityFactor: 2, seamPad: 5, seamFeather: 8 };
  }
}

function classifyPanelCurvatureFromKey(panelKey: string): AopPanelCurvature {
  const k = (panelKey || "").toLowerCase();
  if (
    k.includes("hood") ||
    k.includes("sleeve") ||
    k.includes("shoulder") ||
    k.includes("cuff") ||
    k.includes("armhole") ||
    k.includes("underarm")
  ) return "high";
  if (
    k.includes("pocket") ||
    k.includes("zipper") ||
    k.includes("waistband") ||
    k.includes("collar") ||
    k.includes("placket")
  ) return "medium";
  return "low";
}

function curvatureSubdivision(curvature: AopPanelCurvature): number {
  if (curvature === "high") return 3;
  if (curvature === "medium") return 2;
  return 1;
}

function panelSubdivisionFactor(panel: AopProjectionPanelMap, qualityFactor: number): number {
  const stored = typeof panel.subdivision === "number" && panel.subdivision > 0 ? panel.subdivision : null;
  const curvature = panel.curvature || classifyPanelCurvatureFromKey(panel.panelKey);
  const fromCurvature = stored ?? curvatureSubdivision(curvature);
  return Math.max(1, Math.min(6, Math.max(qualityFactor, fromCurvature)));
}

function bilerpPoint(corners: AopProjectionMeshCell["target"], u: number, v: number): AopProjectionPoint {
  const top = {
    x: corners.topLeft.x + (corners.topRight.x - corners.topLeft.x) * u,
    y: corners.topLeft.y + (corners.topRight.y - corners.topLeft.y) * u,
  };
  const bottom = {
    x: corners.bottomLeft.x + (corners.bottomRight.x - corners.bottomLeft.x) * u,
    y: corners.bottomLeft.y + (corners.bottomRight.y - corners.bottomLeft.y) * u,
  };
  return {
    x: top.x + (bottom.x - top.x) * v,
    y: top.y + (bottom.y - top.y) * v,
  };
}

function subdivideCell(cell: AopProjectionMeshCell, factor: number): AopProjectionMeshCell[] {
  if (factor <= 1) return [cell];
  const out: AopProjectionMeshCell[] = [];
  for (let j = 0; j < factor; j += 1) {
    for (let i = 0; i < factor; i += 1) {
      const u0 = i / factor;
      const u1 = (i + 1) / factor;
      const v0 = j / factor;
      const v1 = (j + 1) / factor;
      out.push({
        id: `${cell.id}_s${i}_${j}`,
        source: {
          topLeft: bilerpPoint(cell.source, u0, v0),
          topRight: bilerpPoint(cell.source, u1, v0),
          bottomRight: bilerpPoint(cell.source, u1, v1),
          bottomLeft: bilerpPoint(cell.source, u0, v1),
        },
        target: {
          topLeft: bilerpPoint(cell.target, u0, v0),
          topRight: bilerpPoint(cell.target, u1, v0),
          bottomRight: bilerpPoint(cell.target, u1, v1),
          bottomLeft: bilerpPoint(cell.target, u0, v1),
        },
      });
    }
  }
  return out;
}

function subdivideMesh(mesh: AopProjectionMeshCell[], factor: number): AopProjectionMeshCell[] {
  if (factor <= 1) return mesh;
  return mesh.flatMap((cell) => subdivideCell(cell, factor));
}

async function getImage(src: string | HTMLImageElement | undefined, cache: ImageCache): Promise<HTMLImageElement | undefined> {
  if (!src) return undefined;
  if (typeof src !== "string") return src;
  const cached = cache.get(src);
  if (cached) return cached;
  const image = await loadImage(src);
  cache.set(src, image);
  return image;
}

function drawImageTriangle(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement | HTMLCanvasElement,
  source: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
  destination: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
  overlap = 0,
) {
  const [s0, s1, s2] = source;
  const centroid = {
    x: (destination[0].x + destination[1].x + destination[2].x) / 3,
    y: (destination[0].y + destination[1].y + destination[2].y) / 3,
  };
  const [d0, d1, d2] = destination.map((point) => {
    if (!overlap) return point;
    const dx = point.x - centroid.x;
    const dy = point.y - centroid.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: point.x + (dx / len) * overlap, y: point.y + (dy / len) * overlap };
  }) as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  const denom = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(denom) < 0.00001) return;

  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denom;
  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denom;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denom;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denom;
  const e =
    (d0.x * (s1.x * s2.y - s2.x * s1.y) +
      d1.x * (s2.x * s0.y - s0.x * s2.y) +
      d2.x * (s0.x * s1.y - s1.x * s0.y)) /
    denom;
  const f =
    (d0.y * (s1.x * s2.y - s2.x * s1.y) +
      d1.y * (s2.x * s0.y - s0.x * s2.y) +
      d2.y * (s0.x * s1.y - s1.x * s0.y)) /
    denom;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(a, b, c, d, e, f);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

type PanelSourceCanvas = {
  canvas: HTMLCanvasElement;
  offsetX: number;
  offsetY: number;
};

type PanelSourceMap = Map<string, string>;

function normalizePanelKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function buildPanelSourceMap(params: RenderProjectedMockupParams): PanelSourceMap {
  const out: PanelSourceMap = new Map();
  for (const entry of params.panelSources || []) {
    const position = entry.position || entry.panelKey || entry.key || "";
    const source = entry.url || entry.dataUrl || entry.imageUrl || "";
    if (!position || !source) continue;
    out.set(position, source);
    out.set(position.toLowerCase(), source);
    out.set(normalizePanelKey(position), source);
  }
  return out;
}

function resolvePanelSource(panel: AopProjectionPanelMap, sources: PanelSourceMap): string | undefined {
  return sources.get(panel.panelKey) || sources.get(panel.panelKey.toLowerCase()) || sources.get(normalizePanelKey(panel.panelKey));
}

function splitArtworkForPanel(
  artwork: HTMLImageElement,
  panel: AopProjectionPanelMap,
  padPx = 0,
): PanelSourceCanvas {
  const sw = Math.max(1, Math.round(panel.sourceWidth));
  const sh = Math.max(1, Math.round(panel.sourceHeight));
  const pad = Math.max(0, Math.round(panel.seamPaddingPx ?? padPx));
  const canvas = document.createElement("canvas");
  canvas.width = sw + pad * 2;
  canvas.height = sh + pad * 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { canvas, offsetX: pad, offsetY: pad };
  if (panel.sourceRect) {
    const unit = panel.sourceRect.unit || "pixels";
    const artworkWidth = artwork.naturalWidth || artwork.width;
    const artworkHeight = artwork.naturalHeight || artwork.height;
    const sx = unit === "normalized" ? panel.sourceRect.x * artworkWidth : panel.sourceRect.x;
    const sy = unit === "normalized" ? panel.sourceRect.y * artworkHeight : panel.sourceRect.y;
    const swPx = unit === "normalized" ? panel.sourceRect.width * artworkWidth : panel.sourceRect.width;
    const shPx = unit === "normalized" ? panel.sourceRect.height * artworkHeight : panel.sourceRect.height;
    const xScale = swPx / sw;
    const yScale = shPx / sh;
    const padArtX = pad * xScale;
    const padArtY = pad * yScale;
    ctx.drawImage(
      artwork,
      sx - padArtX,
      sy - padArtY,
      swPx + padArtX * 2,
      shPx + padArtY * 2,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  } else {
    ctx.drawImage(artwork, -pad, -pad, sw + pad * 2, sh + pad * 2);
  }
  return { canvas, offsetX: pad, offsetY: pad };
}

function sourceImageForPanel(image: HTMLImageElement, panel: AopProjectionPanelMap): PanelSourceCanvas {
  const sw = Math.max(1, Math.round(panel.sourceWidth));
  const sh = Math.max(1, Math.round(panel.sourceHeight));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.drawImage(image, 0, 0, sw, sh);
  return { canvas, offsetX: 0, offsetY: 0 };
}

function maskPanelCanvas(
  panelCanvas: HTMLCanvasElement,
  mask?: HTMLImageElement,
  panelInteriorOffset = { x: 0, y: 0 },
  panelInteriorSize?: { width: number; height: number },
): HTMLCanvasElement {
  if (!mask) return panelCanvas;
  const masked = document.createElement("canvas");
  masked.width = panelCanvas.width;
  masked.height = panelCanvas.height;
  const ctx = masked.getContext("2d");
  if (!ctx) return panelCanvas;
  ctx.drawImage(panelCanvas, 0, 0);
  ctx.globalCompositeOperation = "destination-in";
  const drawW = panelInteriorSize ? panelInteriorSize.width : masked.width - panelInteriorOffset.x * 2;
  const drawH = panelInteriorSize ? panelInteriorSize.height : masked.height - panelInteriorOffset.y * 2;
  ctx.drawImage(mask, panelInteriorOffset.x, panelInteriorOffset.y, drawW, drawH);
  return masked;
}

function featherCanvas(canvas: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  if (radius <= 0) return canvas;
  const feathered = document.createElement("canvas");
  feathered.width = canvas.width;
  feathered.height = canvas.height;
  const ctx = feathered.getContext("2d");
  if (!ctx) return canvas;
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(canvas, 0, 0);
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-in";
  ctx.drawImage(canvas, 0, 0);
  return feathered;
}

function shiftPoint(p: AopProjectionPoint, dx: number, dy: number): AopProjectionPoint {
  return dx === 0 && dy === 0 ? p : { x: p.x + dx, y: p.y + dy };
}

function drawMeshPanel(
  ctx: CanvasRenderingContext2D,
  panelCanvas: HTMLCanvasElement,
  mesh: AopProjectionMeshCell[],
  overlap = 0,
  sourceOffsetX = 0,
  sourceOffsetY = 0,
) {
  for (const cell of mesh) {
    const s = cell.source;
    const t = cell.target;
    const sTL = shiftPoint(s.topLeft, sourceOffsetX, sourceOffsetY);
    const sTR = shiftPoint(s.topRight, sourceOffsetX, sourceOffsetY);
    const sBR = shiftPoint(s.bottomRight, sourceOffsetX, sourceOffsetY);
    const sBL = shiftPoint(s.bottomLeft, sourceOffsetX, sourceOffsetY);
    drawImageTriangle(ctx, panelCanvas, [sTL, sTR, sBR], [t.topLeft, t.topRight, t.bottomRight], overlap);
    drawImageTriangle(ctx, panelCanvas, [sTL, sBR, sBL], [t.topLeft, t.bottomRight, t.bottomLeft], overlap);
  }
}

function panelDestinationHull(panel: AopProjectionPanelMap): AopProjectionPoint[] {
  return [panel.bounds.topLeft, panel.bounds.topRight, panel.bounds.bottomRight, panel.bounds.bottomLeft];
}

function buildPanelFeatherMask(
  width: number,
  height: number,
  panel: AopProjectionPanelMap,
  featherPx: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const hull = panelDestinationHull(panel);
  ctx.fillStyle = "white";
  ctx.beginPath();
  ctx.moveTo(hull[0].x, hull[0].y);
  for (let i = 1; i < hull.length; i += 1) ctx.lineTo(hull[i].x, hull[i].y);
  ctx.closePath();
  ctx.fill();
  if (featherPx > 0) {
    const blurred = document.createElement("canvas");
    blurred.width = width;
    blurred.height = height;
    const bctx = blurred.getContext("2d");
    if (bctx) {
      bctx.filter = `blur(${featherPx}px)`;
      bctx.drawImage(canvas, 0, 0);
      return blurred;
    }
  }
  return canvas;
}

function renderPanelLayer(
  width: number,
  height: number,
  panel: AopProjectionPanelMap,
  panelCanvas: HTMLCanvasElement,
  mesh: AopProjectionMeshCell[],
  overlap: number,
  sourceOffsetX: number,
  sourceOffsetY: number,
  featherPx: number,
): HTMLCanvasElement {
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const lctx = layer.getContext("2d");
  if (!lctx) return layer;
  drawMeshPanel(lctx, panelCanvas, mesh, overlap, sourceOffsetX, sourceOffsetY);
  if (featherPx > 0) {
    const mask = buildPanelFeatherMask(width, height, panel, featherPx);
    lctx.globalCompositeOperation = "destination-in";
    lctx.drawImage(mask, 0, 0);
    lctx.globalCompositeOperation = "source-over";
  }
  return layer;
}

function drawDebugOverlay(ctx: CanvasRenderingContext2D, view: AopProjectionViewMap) {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#38bdf8";
  ctx.fillStyle = "#22c55e";
  for (const panel of view.panels) {
    const b = panel.bounds;
    ctx.beginPath();
    ctx.moveTo(b.topLeft.x, b.topLeft.y);
    ctx.lineTo(b.topRight.x, b.topRight.y);
    ctx.lineTo(b.bottomRight.x, b.bottomRight.y);
    ctx.lineTo(b.bottomLeft.x, b.bottomLeft.y);
    ctx.closePath();
    ctx.stroke();
    for (const point of panel.points) {
      ctx.beginPath();
      ctx.arc(point.target.x, point.target.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 0.35;
    for (const cell of panel.mesh) {
      const t = cell.target;
      ctx.beginPath();
      ctx.moveTo(t.topLeft.x, t.topLeft.y);
      ctx.lineTo(t.topRight.x, t.topRight.y);
      ctx.lineTo(t.bottomRight.x, t.bottomRight.y);
      ctx.lineTo(t.bottomLeft.x, t.bottomLeft.y);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

export async function renderProjectedMockupToCanvas(
  canvas: HTMLCanvasElement,
  params: RenderProjectedMockupParams,
  imageCache: ImageCache = new Map(),
) {
  const map = params.map ?? (params.mapUrl ? await fetch(params.mapUrl).then((res) => res.json() as Promise<AopProjectionMapJson>) : null);
  if (!map) throw new Error("Projection map or mapUrl is required.");
  const view = map.views[params.view];
  if (!view) throw new Error(`Projection map has no "${params.view}" view.`);

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get canvas context.");
  const quality = qualitySettings(params.quality);
  canvas.width = view.width;
  canvas.height = view.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const [base, artwork, shadow, highlight, zipper, viewMask, debugOverlay] = await Promise.all([
    getImage(view.baseImageUrl, imageCache),
    getImage(params.artwork, imageCache),
    getImage(view.shadowLayerUrl, imageCache),
    getImage(view.highlightLayerUrl, imageCache),
    getImage(view.zipperLayerUrl, imageCache),
    getImage(view.maskLayerUrl, imageCache),
    params.debug ? getImage(view.debugOverlayUrl, imageCache) : Promise.resolve(undefined),
  ]);

  if (base) ctx.drawImage(base, 0, 0, view.width, view.height);
  if (!artwork) return;
  const panelSources = buildPanelSourceMap(params);

  for (const panel of view.panels) {
    const mask = await getImage(panel.maskUrl, imageCache);
    const panelSourceUrl = resolvePanelSource(panel, panelSources);
    const panelSourceImage = await getImage(panelSourceUrl, imageCache);
    const sourceCanvas = panelSourceImage
      ? sourceImageForPanel(panelSourceImage, panel)
      : splitArtworkForPanel(artwork, panel, quality.seamPad);
    const sw = Math.max(1, Math.round(panel.sourceWidth));
    const sh = Math.max(1, Math.round(panel.sourceHeight));
    const masked = maskPanelCanvas(
      sourceCanvas.canvas,
      mask,
      { x: sourceCanvas.offsetX, y: sourceCanvas.offsetY },
      { width: sw, height: sh },
    );
    const panelCanvas = featherCanvas(masked, quality.feather);
    const factor = panelSubdivisionFactor(panel, quality.qualityFactor);
    const subdividedMesh = subdivideMesh(panel.mesh, factor);
    const featherPx = panel.seamFeatherPx ?? quality.seamFeather;
    if (featherPx > 0) {
      const layer = renderPanelLayer(
        view.width,
        view.height,
        panel,
        panelCanvas,
        subdividedMesh,
        quality.overlap,
        sourceCanvas.offsetX,
        sourceCanvas.offsetY,
        featherPx,
      );
      ctx.drawImage(layer, 0, 0);
    } else {
      drawMeshPanel(ctx, panelCanvas, subdividedMesh, quality.overlap, sourceCanvas.offsetX, sourceCanvas.offsetY);
    }
  }

  if (viewMask) {
    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(viewMask, 0, 0, view.width, view.height);
    ctx.restore();
  }

  if (zipper) ctx.drawImage(zipper, 0, 0, view.width, view.height);
  if (shadow) {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = quality.shadowAlpha;
    ctx.drawImage(shadow, 0, 0, view.width, view.height);
    ctx.restore();
  }
  if (highlight) {
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = quality.highlightAlpha;
    ctx.drawImage(highlight, 0, 0, view.width, view.height);
    ctx.restore();
  }
  if (params.debug) {
    if (debugOverlay) ctx.drawImage(debugOverlay, 0, 0, view.width, view.height);
    drawDebugOverlay(ctx, view);
  }
}

export async function renderProjectedMockup(params: RenderProjectedMockupParams): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  await renderProjectedMockupToCanvas(canvas, params);
  return canvas;
}
