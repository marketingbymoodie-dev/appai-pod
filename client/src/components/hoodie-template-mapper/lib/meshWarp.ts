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
 * Map a (u, v) pair in [0..1]² through a free-form rotation around the
 * centre (0.5, 0.5) and optional horizontal/vertical flip. Used to
 * pre-rotate the source UVs before sampling the artwork rectangle so
 * we never touch the user's tuned `targetPoints` — the rotation lives
 * entirely in source space.
 *
 * Convention: positive `rotationDeg` rotates the rendered artwork
 * clockwise on screen (i.e. the source UV grid is rotated counter-
 * clockwise in screen frame, which appears as CW rotation of the
 * sampled image content).
 *
 * Note that arbitrary rotations push UVs outside [0, 1]² near the
 * corners; that's expected — the sampled pixels there fall outside the
 * source image and render transparent, exactly like rotating a square
 * inside its own bounding box.
 */
function applySourceUvTransform(
  u: number,
  v: number,
  rotationDeg: number,
  flipX: boolean,
  flipY: boolean,
): { u: number; v: number } {
  let nu = u;
  let nv = v;
  if (rotationDeg !== 0) {
    const rad = (rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cu = u - 0.5;
    const cv = v - 0.5;
    nu = cu * cos + cv * sin + 0.5;
    nv = -cu * sin + cv * cos + 0.5;
  }
  if (flipX) nu = 1 - nu;
  if (flipY) nv = 1 - nv;
  return { u: nu, v: nv };
}

/**
 * Slight expansion (in pixels) of every triangle along its edge normals
 * before clipping. Eliminates 1-pixel seams between adjacent cells.
 */
const SEAM_INFLATE_PX = 0.6;
/** Extra inflation when rasterizing SVG first — vector sources show harsher triangle seams. */
const SVG_RASTER_SEAM_INFLATE_PX = 1.25;

function isSvgImageSource(image: CanvasImageSource): boolean {
  if (typeof HTMLImageElement === "undefined" || !(image instanceof HTMLImageElement)) {
    return false;
  }
  const src = (image.currentSrc || image.src || "").toLowerCase();
  return (
    src.includes(".svg") ||
    src.startsWith("data:image/svg") ||
    image.dataset.appaiVectorArt === "1"
  );
}

/** Rasterize SVG once so mesh-warp triangle draws don't resample vector paths per cell. */
function rasterizeArtworkSource(
  image: CanvasImageSource,
  width: number,
  height: number,
): { source: CanvasImageSource; width: number; height: number } {
  if (typeof document === "undefined") {
    return { source: image, width, height };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  if (!ctx) return { source: image, width, height };
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { source: canvas, width: canvas.width, height: canvas.height };
}

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

  const inflate = options.inflateSeams !== false;

  let drawImage: CanvasImageSource = image;
  let drawWidth = imageWidth;
  let drawHeight = imageHeight;
  let seamInflate = inflate ? SEAM_INFLATE_PX : 0;

  if (isSvgImageSource(image)) {
    const raster = rasterizeArtworkSource(image, imageWidth, imageHeight);
    drawImage = raster.source;
    drawWidth = raster.width;
    drawHeight = raster.height;
    if (inflate) seamInflate = SVG_RASTER_SEAM_INFLATE_PX;
  }

  const src: SourceRect = mesh.sourceRect ?? {
    x: 0,
    y: 0,
    width: drawWidth,
    height: drawHeight,
  };
  if (src.width <= 0 || src.height <= 0) return;

  ctx.save();
  if (typeof options.globalAlpha === "number") {
    ctx.globalAlpha = ctx.globalAlpha * options.globalAlpha;
  }

  // Source UV grid (normalised 0..1 inside `src`). Each grid corner runs
  // through `applySourceUvTransform` so a 90°/180°/270° rotation or flip
  // changes WHICH part of `src` each target cell pulls from — the user's
  // `targetPoints` deformation is preserved.
  const cols = mesh.cols;
  const rows = mesh.rows;
  const rotation = mesh.sourceRotation ?? 0;
  const flipX = mesh.sourceFlipX ?? false;
  const flipY = mesh.sourceFlipY ?? false;

  const uvToPx = (u: number, v: number): Pt => {
    const t = applySourceUvTransform(u, v, rotation, flipX, flipY);
    return { x: src.x + t.u * src.width, y: src.y + t.v * src.height };
  };

  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const u0 = c / (cols - 1);
      const u1 = (c + 1) / (cols - 1);
      const v0 = r / (rows - 1);
      const v1 = (r + 1) / (rows - 1);
      const sTL = uvToPx(u0, v0);
      const sTR = uvToPx(u1, v0);
      const sBL = uvToPx(u0, v1);
      const sBR = uvToPx(u1, v1);

      const tTL = mesh.targetPoints[r * cols + c];
      const tTR = mesh.targetPoints[r * cols + (c + 1)];
      const tBL = mesh.targetPoints[(r + 1) * cols + c];
      const tBR = mesh.targetPoints[(r + 1) * cols + (c + 1)];

      drawAffineTriangle(ctx, drawImage, sTL, sTR, sBL, tTL, tTR, tBL, inflate, seamInflate);
      drawAffineTriangle(ctx, drawImage, sTR, sBR, sBL, tTR, tBR, tBL, inflate, seamInflate);
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
  seamInflatePx: number = SEAM_INFLATE_PX,
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
  const clip = inflate ? inflateTriangle([t0, t1, t2], seamInflatePx) : [t0, t1, t2];
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
 * Inverse of `applySourceUvTransform` — maps a source-space UV back into
 * the natural grid UV space, so callers like `meshSampleTarget` can bilin
 * sample using the user's tuned `targetPoints` even when the artwork has
 * been rotated/flipped.
 *
 * Inverse order is: undo flips first (flips are involutions), then
 * rotate by `-rotationDeg` around (0.5, 0.5).
 */
function inverseSourceUvTransform(
  u: number,
  v: number,
  rotationDeg: number,
  flipX: boolean,
  flipY: boolean,
): { u: number; v: number } {
  let nu = flipX ? 1 - u : u;
  let nv = flipY ? 1 - v : v;
  if (rotationDeg !== 0) {
    const rad = (rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cu = nu - 0.5;
    const cv = nv - 0.5;
    nu = cu * cos - cv * sin + 0.5;
    nv = cu * sin + cv * cos + 0.5;
  }
  return { u: nu, v: nv };
}

/**
 * Bilinearly interpolate a target point inside a (cols × rows) mesh given
 * source UV coordinates in [0..1]^2 spanning sourceRect. Used by the AOP
 * preview to map artwork pixels through the deformed grid. Respects any
 * `sourceRotation`/`sourceFlipX`/`sourceFlipY` baked into the mesh.
 *
 * Returns { x, y } in mockup pixel coords.
 */
export function meshSampleTarget(mesh: MeshGrid, u: number, v: number): Pt {
  const cols = mesh.cols;
  const rows = mesh.rows;
  const inverted = inverseSourceUvTransform(
    u,
    v,
    mesh.sourceRotation ?? 0,
    mesh.sourceFlipX ?? false,
    mesh.sourceFlipY ?? false,
  );
  const cu = Math.max(0, Math.min(1, inverted.u));
  const cv = Math.max(0, Math.min(1, inverted.v));
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
