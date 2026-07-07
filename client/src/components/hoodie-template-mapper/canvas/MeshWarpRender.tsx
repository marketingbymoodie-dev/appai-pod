import { useMemo } from "react";
import { Shape } from "react-konva";
import type { MaskLayer } from "@shared/hoodieTemplate";
import { clipCanvasToMaskSubpaths, svgPathToSubpaths } from "../lib/svgPath";
import { drawMeshWarp } from "../lib/meshWarp";
import { useMapperAssetImage } from "../lib/useMapperAssetImage";
import Konva from "konva";

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

function useSourceImage(src: string | null | undefined): HTMLImageElement | null {
  return useMapperAssetImage(src).img;
}

export default function MeshWarpRender({ layer }: Props) {
  const img = useSourceImage(layer.productionPanelSrc);
  const mesh = layer.mesh;
  const subpaths = useMemo(() => svgPathToSubpaths(layer.maskPath), [layer.maskPath]);

  if (!mesh || !img) return null;
  if (mesh.targetPoints.length !== mesh.cols * mesh.rows) return null;

  const drawWarp = (ctx: Konva.Context) => {
    const c2d = (ctx as unknown as { _context?: CanvasRenderingContext2D })._context;
    if (!c2d) return;
    c2d.save();
    clipCanvasToMaskSubpaths(c2d, subpaths);
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
