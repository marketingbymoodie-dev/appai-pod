import type { MockupPanelPlacement, MockupPoint } from "../types/mockupTypes";

type DrawPanelOptions = {
  maskImage?: HTMLImageElement;
};

function centerOfPanel(panel: MockupPanelPlacement): MockupPoint {
  return {
    x: panel.x + (panel.width * panel.scaleX) / 2,
    y: panel.y + (panel.height * panel.scaleY) / 2,
  };
}

function drawRegularPanel(
  ctx: CanvasRenderingContext2D,
  panel: MockupPanelPlacement,
  drawContent: (target: CanvasRenderingContext2D, width: number, height: number, masked: boolean) => void,
  maskImage?: HTMLImageElement,
) {
  const width = panel.width * panel.scaleX;
  const height = panel.height * panel.scaleY;
  const center = centerOfPanel(panel);

  ctx.save();
  ctx.globalAlpha = panel.opacity;
  ctx.translate(center.x, center.y);
  ctx.rotate((panel.rotation * Math.PI) / 180);

  if (maskImage) {
    const offscreen = document.createElement("canvas");
    offscreen.width = Math.max(1, Math.round(width));
    offscreen.height = Math.max(1, Math.round(height));
    const offCtx = offscreen.getContext("2d");
    if (offCtx) {
      drawContent(offCtx, offscreen.width, offscreen.height, true);
      offCtx.globalCompositeOperation = "destination-in";
      offCtx.drawImage(maskImage, 0, 0, offscreen.width, offscreen.height);
      ctx.drawImage(offscreen, -width / 2, -height / 2, width, height);
    }
  } else {
    drawContent(ctx, width, height, false);
  }

  ctx.restore();
}

function lerp(a: MockupPoint, b: MockupPoint, t: number): MockupPoint {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

function bilerp(
  topLeft: MockupPoint,
  topRight: MockupPoint,
  bottomRight: MockupPoint,
  bottomLeft: MockupPoint,
  u: number,
  v: number,
): MockupPoint {
  const top = lerp(topLeft, topRight, u);
  const bottom = lerp(bottomLeft, bottomRight, u);
  return lerp(top, bottom, v);
}

function drawImageTriangle(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  source: [MockupPoint, MockupPoint, MockupPoint],
  destination: [MockupPoint, MockupPoint, MockupPoint],
) {
  const [s0, s1, s2] = source;
  const [d0, d1, d2] = destination;
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

function drawPerspectivePanel(ctx: CanvasRenderingContext2D, image: HTMLImageElement, panel: MockupPanelPlacement) {
  const corners = panel.perspectiveCorners;
  if (!corners) return;

  const steps = 12;
  ctx.save();
  ctx.globalAlpha = panel.opacity;
  for (let y = 0; y < steps; y += 1) {
    for (let x = 0; x < steps; x += 1) {
      const u0 = x / steps;
      const u1 = (x + 1) / steps;
      const v0 = y / steps;
      const v1 = (y + 1) / steps;
      const sx0 = u0 * image.width;
      const sx1 = u1 * image.width;
      const sy0 = v0 * image.height;
      const sy1 = v1 * image.height;
      const p00 = bilerp(corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft, u0, v0);
      const p10 = bilerp(corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft, u1, v0);
      const p11 = bilerp(corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft, u1, v1);
      const p01 = bilerp(corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft, u0, v1);

      drawImageTriangle(ctx, image, [{ x: sx0, y: sy0 }, { x: sx1, y: sy0 }, { x: sx1, y: sy1 }], [p00, p10, p11]);
      drawImageTriangle(ctx, image, [{ x: sx0, y: sy0 }, { x: sx1, y: sy1 }, { x: sx0, y: sy1 }], [p00, p11, p01]);
    }
  }
  ctx.restore();
}

export function applyPanelTransform(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  panel: MockupPanelPlacement,
  options: DrawPanelOptions = {},
) {
  if (!panel.visible || panel.opacity <= 0) return;
  if (panel.perspectiveCorners) {
    drawPerspectivePanel(ctx, image, panel);
    return;
  }
  drawRegularPanel(ctx, panel, (target, width, height, masked) => {
    target.drawImage(image, masked ? 0 : -width / 2, masked ? 0 : -height / 2, width, height);
  }, options.maskImage);
}

export function applyPanelFill(
  ctx: CanvasRenderingContext2D,
  panel: MockupPanelPlacement,
  color: string,
  options: DrawPanelOptions = {},
) {
  if (!panel.visible || !color || color === "transparent") return;
  if (panel.perspectiveCorners) {
    const { topLeft, topRight, bottomRight, bottomLeft } = panel.perspectiveCorners;
    ctx.save();
    ctx.globalAlpha = panel.bgOpacity ?? panel.opacity;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(topLeft.x, topLeft.y);
    ctx.lineTo(topRight.x, topRight.y);
    ctx.lineTo(bottomRight.x, bottomRight.y);
    ctx.lineTo(bottomLeft.x, bottomLeft.y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    return;
  }
  const opacity = panel.bgOpacity ?? panel.opacity;
  drawRegularPanel(ctx, { ...panel, opacity }, (target, width, height, masked) => {
    target.fillStyle = color;
    target.fillRect(masked ? 0 : -width / 2, masked ? 0 : -height / 2, width, height);
  }, options.maskImage);
}
