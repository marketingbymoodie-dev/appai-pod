import { useEffect, useMemo, useState } from "react";
import { Shape } from "react-konva";
import Konva from "konva";
import type { MaskLayer } from "@shared/hoodieTemplate";
import { svgPathToAnchors } from "../lib/svgPath";
import { drawMeshWarp } from "../lib/meshWarp";

/**
 * Read-only mesh warp renderer for a single layer. Used by
 * `HoodieCanvas` to composite *every* mesh-warped layer at once when
 * the workspace flag `showAllWarps` is on, so the user can review the
 * whole back / front view as one image without leaving the editor.
 *
 * Has no editing handles, no grid lines, no event listeners — those
 * live in the heavier `MeshWarpOverlay` and are only mounted for the
 * currently selected layer.
 *
 * Always clips to the polygon (the editor's "show full artwork"
 * toggle is a single-layer edit affordance and doesn't make sense in
 * the composite view).
 */

type Props = {
  layer: MaskLayer;
};

function isCrossOrigin(src: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const url = new URL(src, window.location.href);
    return url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function useSourceImage(src: string | null | undefined): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) {
      setImg(null);
      return;
    }
    let cancelled = false;
    const next = new Image();
    if (isCrossOrigin(src)) next.crossOrigin = "anonymous";
    next.onload = () => {
      if (!cancelled) setImg(next);
    };
    next.onerror = () => {
      if (!cancelled) setImg(null);
    };
    next.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);
  return img;
}

export default function MeshWarpRender({ layer }: Props) {
  const img = useSourceImage(layer.productionPanelSrc);
  const mesh = layer.mesh;
  const polygon = useMemo(() => svgPathToAnchors(layer.maskPath), [layer.maskPath]);

  if (!mesh || !img) return null;
  if (mesh.targetPoints.length !== mesh.cols * mesh.rows) return null;

  const drawWarp = (ctx: Konva.Context) => {
    const c2d = (ctx as unknown as { _context?: CanvasRenderingContext2D })._context;
    if (!c2d) return;
    c2d.save();
    if (polygon.length >= 3) {
      c2d.beginPath();
      c2d.moveTo(polygon[0].x, polygon[0].y);
      for (let i = 1; i < polygon.length; i += 1) c2d.lineTo(polygon[i].x, polygon[i].y);
      c2d.closePath();
      c2d.clip();
    }
    try {
      drawMeshWarp(c2d, img, img.naturalWidth, img.naturalHeight, mesh, {
        globalAlpha: layer.opacity,
      });
    } finally {
      c2d.restore();
    }
  };

  return (
    <Shape
      sceneFunc={(ctx) => drawWarp(ctx)}
      listening={false}
      perfectDrawEnabled={false}
    />
  );
}
