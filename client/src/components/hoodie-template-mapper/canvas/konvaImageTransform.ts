import type Konva from "konva";

/**
 * Bake Konva.Transformer scale into width/height and persist top-left position
 * in mockup pixel space. Resets offset/scale so React re-renders (e.g. on zoom)
 * stay aligned with the fixed 1024×1024 workspace rect.
 */
export function commitKonvaUniformImageTransform(
  node: Konva.Image,
  naturalWidth: number,
): { x: number; y: number; scale: number } {
  const scaleX = node.scaleX();
  const scaleY = node.scaleY();
  const renderWidth = Math.max(5, node.width() * scaleX);
  const renderHeight = Math.max(5, node.height() * scaleY);

  const parent = node.getParent();
  const box = parent
    ? node.getClientRect({ relativeTo: parent, skipShadow: true })
    : node.getClientRect({ skipShadow: true });

  node.scaleX(1);
  node.scaleY(1);
  node.offsetX(0);
  node.offsetY(0);
  node.width(renderWidth);
  node.height(renderHeight);
  node.x(box.x);
  node.y(box.y);

  return {
    x: box.x,
    y: box.y,
    scale: renderWidth / naturalWidth,
  };
}

/** Ensure drag commits use top-left anchoring (Transformer can leave offset set). */
export function konvaImageTopLeftPosition(node: Konva.Image): { x: number; y: number } {
  const parent = node.getParent();
  if (parent && (node.offsetX() !== 0 || node.offsetY() !== 0)) {
    const box = node.getClientRect({ relativeTo: parent, skipShadow: true });
    node.offsetX(0);
    node.offsetY(0);
    node.x(box.x);
    node.y(box.y);
  }
  return { x: node.x(), y: node.y() };
}
