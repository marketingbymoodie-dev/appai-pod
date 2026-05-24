/**
 * Mesh warp rendering for the hoodie template mapper.
 *
 * The mesh-warp tool projects a rectangular slice of a panel artwork sheet
 * (the `sourceRect` within an HTMLImageElement) onto an irregular
 * quadrilateral mesh on the mockup. We render this by splitting each
 * quad cell into two triangles and per-triangle calling
 * `ctx.setTransform` with the affine map that takes the source-triangle
 * onto the target-triangle, then drawing the source image clipped to the
 * source triangle.
 *
 * This is a pure-canvas approach (no WebGL) — performance is fine for
 * mesh densities up to ~16×16 which is far above what's useful in
 * practice. Texture seams between adjacent cells are reduced by
 * inflating each triangle slightly along its edge normals before
 * clipping; without that the floating-point boundaries produce visible
 * 1-pixel cracks.
 */

import type { MeshGrid, Pt, SourceRect } from "@shared/hoodieTemplate";

/**
 * Slight expansion (in pixels) of every triangle along its edge normals
 * before clipping. Eliminates 1-pixel seams between adjacent cells.
 */
const SEAM_INFLATE_PX = 0.6;

export type WarpOptions = {
  /**
   * If true, expand every triangle's clip path by `SEAM_INFLATE_PX` pixels
   * along its edge normals before drawing. Eliminates the 1-pixel cracks
   * between adjacent cells. Default: true.
   */
  inflateSeams?: boolean;
  /**
   * Optional global alpha applied around the mesh draw. Restored on exit.
   */
  globalAlpha?: number;
};

/**
 * Render `image`, clipped to `mesh.sourceRect`, warped through `mesh` onto
 * the current canvas (in mockup-pixel coordinate space).
 *
 * Caller is responsible for any outer clip (e.g. clipping to the panel
 * polygon) and for setting the canvas transform that maps mockup pixels
 * to canvas pixels — this function paints in mockup pixel coordinates.
 */
export function drawMeshWarp(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  imageWidth: number,
  imageHeight: number,
  mesh: MeshGrid,
  options: WarpOptions = {},
): void {
  if (mesh.cols < 2 || mesh.rows < 2) return;
  if (mesh.targetPoints.length !== mesh.cols * mesh.rows) return;

  const src: SourceRect = mesh.sourceRect ?? {
    x: 0,
    y: 0,
    width: imageWidth,
    height: imageHeight,
  };
  if (src.width <= 0 || src.height <= 0) return;

  const inflate = options.inflateSeams !== false;

  ctx.save();
  if (typeof options.globalAlpha === "number") {
    ctx.globalAlpha = ctx.globalAlpha * options.globalAlpha;
  }

  // Pre-compute source UV grid in pixels, evenly spaced inside `src`.
  const cols = mesh.cols;
  const rows = mesh.rows;
  const dx = src.width / (cols - 1);
  const dy = src.height / (rows - 1);

  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const sTL: Pt = { x: src.x + c * dx, y: src.y + r * dy };
      const sTR: Pt = { x: src.x + (c + 1) * dx, y: src.y + r * dy };
      const sBL: Pt = { x: src.x + c * dx, y: src.y + (r + 1) * dy };
      const sBR: Pt = { x: src.x + (c + 1) * dx, y: src.y + (r + 1) * dy };

      const tTL = mesh.targetPoints[r * cols + c];
      const tTR = mesh.targetPoints[r * cols + (c + 1)];
      const tBL = mesh.targetPoints[(r + 1) * cols + c];
      const tBR = mesh.targetPoints[(r + 1) * cols + (c + 1)];

      drawAffineTriangle(ctx, image, sTL, sTR, sBL, tTL, tTR, tBL, inflate);
      drawAffineTriangle(ctx, image, sTR, sBR, sBL, tTR, tBR, tBL, inflate);
    }
  }

  ctx.restore();
}

/**
 * Draw `image` such that source-triangle (s0, s1, s2) lands exactly on
 * target-triangle (t0, t1, t2). Uses the affine transform that solves
 * for the unique 2D map taking each source vertex onto its target.
 *
 * If `inflate` is true, inflate the clip triangle slightly along its
 * edge normals to avoid 1-pixel seams between adjacent cells.
 */
function drawAffineTriangle(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  s0: Pt,
  s1: Pt,
  s2: Pt,
  t0: Pt,
  t1: Pt,
  t2: Pt,
  inflate: boolean,
): void {
  // Solve affine M such that M * s = t for each pair.
  // Using barycentric form, M maps:
  //   s0 -> t0
  //   s1 -> t1
  //   s2 -> t2
  // We need the affine matrix [a c e; b d f] such that:
  //   a*sx + c*sy + e = tx
  //   b*sx + d*sy + f = ty
  const sx0 = s0.x, sy0 = s0.y;
  const sx1 = s1.x, sy1 = s1.y;
  const sx2 = s2.x, sy2 = s2.y;
  const tx0 = t0.x, ty0 = t0.y;
  const tx1 = t1.x, ty1 = t1.y;
  const tx2 = t2.x, ty2 = t2.y;

  const denom = (sx0 - sx2) * (sy1 - sy2) - (sx1 - sx2) * (sy0 - sy2);
  if (denom === 0) return; // Degenerate source triangle — nothing to draw.

  const a = ((tx0 - tx2) * (sy1 - sy2) - (tx1 - tx2) * (sy0 - sy2)) / denom;
  const c = ((tx1 - tx2) * (sx0 - sx2) - (tx0 - tx2) * (sx1 - sx2)) / denom;
  const e = tx2 - a * sx2 - c * sy2;
  const b = ((ty0 - ty2) * (sy1 - sy2) - (ty1 - ty2) * (sy0 - sy2)) / denom;
  const d = ((ty1 - ty2) * (sx0 - sx2) - (ty0 - ty2) * (sx1 - sx2)) / denom;
  const f = ty2 - b * sx2 - d * sy2;

  ctx.save();

  // Clip to (optionally inflated) target triangle.
  const clip = inflate ? inflateTriangle([t0, t1, t2], SEAM_INFLATE_PX) : [t0, t1, t2];
  ctx.beginPath();
  ctx.moveTo(clip[0].x, clip[0].y);
  ctx.lineTo(clip[1].x, clip[1].y);
  ctx.lineTo(clip[2].x, clip[2].y);
  ctx.closePath();
  ctx.clip();

  // Apply affine that takes source pixels into target pixels.
  ctx.transform(a, b, c, d, e, f);

  // Now (in source pixel coords) draw the whole image. The clip from above
  // ensures only the target triangle worth of pixels actually shows.
  ctx.drawImage(image, 0, 0);

  ctx.restore();
}

/**
 * Inflate triangle vertices outward from the centroid by `amount` pixels.
 * Crude but effective for hiding seams between adjacent quad cells.
 */
function inflateTriangle(tri: Pt[], amount: number): Pt[] {
  const cx = (tri[0].x + tri[1].x + tri[2].x) / 3;
  const cy = (tri[0].y + tri[1].y + tri[2].y) / 3;
  return tri.map((p) => {
    const vx = p.x - cx;
    const vy = p.y - cy;
    const len = Math.hypot(vx, vy);
    if (len === 0) return { x: p.x, y: p.y };
    const k = (len + amount) / len;
    return { x: cx + vx * k, y: cy + vy * k };
  });
}

/**
 * Bilinearly interpolate a target point inside a (cols × rows) mesh given
 * source UV coordinates in [0..1]^2 spanning sourceRect. Used by the AOP
 * preview to map artwork pixels through the deformed grid.
 *
 * Returns { x, y } in mockup pixel coords.
 */
export function meshSampleTarget(mesh: MeshGrid, u: number, v: number): Pt {
  const cols = mesh.cols;
  const rows = mesh.rows;
  const cu = Math.max(0, Math.min(1, u));
  const cv = Math.max(0, Math.min(1, v));
  const fx = cu * (cols - 1);
  const fy = cv * (rows - 1);
  const x0 = Math.floor(fx);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y0 = Math.floor(fy);
  const y1 = Math.min(rows - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const tl = mesh.targetPoints[y0 * cols + x0];
  const tr = mesh.targetPoints[y0 * cols + x1];
  const bl = mesh.targetPoints[y1 * cols + x0];
  const br = mesh.targetPoints[y1 * cols + x1];
  const top = { x: tl.x + (tr.x - tl.x) * tx, y: tl.y + (tr.y - tl.y) * tx };
  const bot = { x: bl.x + (br.x - bl.x) * tx, y: bl.y + (br.y - bl.y) * tx };
  return {
    x: top.x + (bot.x - top.x) * ty,
    y: top.y + (bot.y - top.y) * ty,
  };
}
