import type { ArtworkPanelAsset, MockupGuide, MockupPanelPlacement, MockupViewCalibration } from "../types/mockupTypes";
import { loadImage } from "../utils/imageLoader";
import { applyPanelTransform } from "./applyPanelTransform";

export type RenderMockupOptions = {
  artworkPanels: ArtworkPanelAsset[];
  showGuides?: boolean;
  showPanelBounds?: boolean;
  selectedPanelId?: string | null;
  selectedGuideId?: string | null;
  referenceOpacity?: number;
  showReferenceOverlay?: boolean;
};

type ImageCache = Map<string, HTMLImageElement>;

async function getCachedImage(src: string | undefined, cache: ImageCache): Promise<HTMLImageElement | undefined> {
  if (!src) return undefined;
  const cached = cache.get(src);
  if (cached) return cached;
  const image = await loadImage(src);
  cache.set(src, image);
  return image;
}

function drawGuide(ctx: CanvasRenderingContext2D, guide: MockupGuide, selected: boolean) {
  if (!guide.points.length) return;
  ctx.save();
  ctx.globalAlpha = guide.opacity;
  ctx.strokeStyle = selected ? "#f97316" : "#22c55e";
  ctx.fillStyle = selected ? "#f97316" : "#22c55e";
  ctx.lineWidth = selected ? 4 : 2;
  ctx.setLineDash(guide.locked ? [4, 6] : [10, 6]);
  ctx.beginPath();
  ctx.moveTo(guide.points[0].x, guide.points[0].y);
  if (guide.type === "point") {
    ctx.arc(guide.points[0].x, guide.points[0].y, selected ? 8 : 6, 0, Math.PI * 2);
    ctx.fill();
  } else if ((guide.type === "curve" || guide.type === "arc") && guide.points.length >= 3) {
    ctx.quadraticCurveTo(guide.points[1].x, guide.points[1].y, guide.points[2].x, guide.points[2].y);
    ctx.stroke();
  } else {
    for (const point of guide.points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const point of guide.points) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, selected ? 7 : 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPanelBounds(ctx: CanvasRenderingContext2D, panel: MockupPanelPlacement, selected: boolean) {
  if (!panel.visible) return;
  ctx.save();
  ctx.strokeStyle = selected ? "#38bdf8" : "rgba(56, 189, 248, 0.65)";
  ctx.fillStyle = selected ? "#38bdf8" : "rgba(56, 189, 248, 0.8)";
  ctx.lineWidth = selected ? 3 : 1.5;
  ctx.setLineDash(panel.locked ? [4, 6] : []);

  if (panel.perspectiveCorners) {
    const { topLeft, topRight, bottomRight, bottomLeft } = panel.perspectiveCorners;
    ctx.beginPath();
    ctx.moveTo(topLeft.x, topLeft.y);
    ctx.lineTo(topRight.x, topRight.y);
    ctx.lineTo(bottomRight.x, bottomRight.y);
    ctx.lineTo(bottomLeft.x, bottomLeft.y);
    ctx.closePath();
    ctx.stroke();
    for (const point of [topLeft, topRight, bottomRight, bottomLeft]) {
      ctx.fillRect(point.x - 5, point.y - 5, 10, 10);
    }
  } else {
    const width = panel.width * panel.scaleX;
    const height = panel.height * panel.scaleY;
    const cx = panel.x + width / 2;
    const cy = panel.y + height / 2;
    ctx.translate(cx, cy);
    ctx.rotate((panel.rotation * Math.PI) / 180);
    ctx.strokeRect(-width / 2, -height / 2, width, height);
    for (const point of [
      { x: -width / 2, y: -height / 2 },
      { x: width / 2, y: -height / 2 },
      { x: width / 2, y: height / 2 },
      { x: -width / 2, y: height / 2 },
    ]) {
      ctx.fillRect(point.x - 5, point.y - 5, 10, 10);
    }
  }

  if (panel.seamAnchor) {
    ctx.setLineDash([]);
    ctx.fillStyle = "#f43f5e";
    ctx.beginPath();
    ctx.arc(panel.seamAnchor.x, panel.seamAnchor.y, 7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export async function renderMockupToCanvas(
  canvas: HTMLCanvasElement,
  view: MockupViewCalibration,
  options: RenderMockupOptions,
  imageCache: ImageCache = new Map(),
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  canvas.width = view.width;
  canvas.height = view.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const baseImage = await getCachedImage(view.baseImageUrl, imageCache);
  if (baseImage) {
    ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = "#e2e8f0";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#64748b";
    ctx.font = "32px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Upload blank/base hoodie mockup", canvas.width / 2, canvas.height / 2);
  }

  const artworkByName = new Map(options.artworkPanels.map((asset) => [asset.name, asset.url]));
  const sortedPanels = [...view.panels].sort((a, b) => a.zIndex - b.zIndex);
  for (const panel of sortedPanels) {
    const artworkUrl = artworkByName.get(panel.artworkPanelName);
    if (!artworkUrl || !panel.visible) continue;
    const [artworkImage, maskImage] = await Promise.all([
      getCachedImage(artworkUrl, imageCache),
      getCachedImage(panel.maskUrl, imageCache),
    ]);
    if (artworkImage) applyPanelTransform(ctx, artworkImage, panel, { maskImage });
  }

  const shadowOverlay = await getCachedImage(view.shadowOverlayUrl, imageCache);
  if (shadowOverlay) {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = 0.55;
    ctx.drawImage(shadowOverlay, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  const highlightOverlay = await getCachedImage(view.highlightOverlayUrl, imageCache);
  if (highlightOverlay) {
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.45;
    ctx.drawImage(highlightOverlay, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  if (options.showReferenceOverlay && view.referenceImageUrl) {
    const referenceImage = await getCachedImage(view.referenceImageUrl, imageCache);
    if (referenceImage) {
      ctx.save();
      ctx.globalAlpha = options.referenceOpacity ?? 0.5;
      ctx.drawImage(referenceImage, 0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
  }

  if (options.showGuides) {
    for (const guide of view.guides) {
      drawGuide(ctx, guide, guide.id === options.selectedGuideId);
    }
  }

  if (options.showPanelBounds) {
    for (const panel of sortedPanels) {
      drawPanelBounds(ctx, panel, panel.id === options.selectedPanelId);
    }
  }
}
