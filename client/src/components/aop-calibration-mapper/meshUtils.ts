import type { MeshGrid, MeshPoint, PanelTransform, UV } from "./types";

/**
 * Build a default mesh covering a rectangle on the mockup.
 * The rectangle is given by its 4 corners in mockup space.
 */
export function buildMeshFromBounds(
  cols: number,
  rows: number,
  bounds: { topLeft: { x: number; y: number }; topRight: { x: number; y: number }; bottomRight: { x: number; y: number }; bottomLeft: { x: number; y: number } },
): MeshGrid {
  const points: MeshPoint[] = [];
  for (let r = 0; r <= rows; r++) {
    const v = r / rows;
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      const top = {
        x: bounds.topLeft.x + (bounds.topRight.x - bounds.topLeft.x) * u,
        y: bounds.topLeft.y + (bounds.topRight.y - bounds.topLeft.y) * u,
      };
      const bottom = {
        x: bounds.bottomLeft.x + (bounds.bottomRight.x - bounds.bottomLeft.x) * u,
        y: bounds.bottomLeft.y + (bounds.bottomRight.y - bounds.bottomLeft.y) * u,
      };
      const x = top.x + (bottom.x - top.x) * v;
      const y = top.y + (bottom.y - top.y) * v;
      points.push({ u, v, x, y });
    }
  }
  return { cols, rows, points };
}

/**
 * Default rectangular bounds when first dropping a panel onto a mockup.
 * Fits the panel inside a centered region with the same aspect ratio as the source.
 */
export function defaultBoundsForPanel(
  mockupW: number,
  mockupH: number,
  sourceW: number,
  sourceH: number,
  centerOffset: { dx: number; dy: number } = { dx: 0, dy: 0 },
): { topLeft: { x: number; y: number }; topRight: { x: number; y: number }; bottomRight: { x: number; y: number }; bottomLeft: { x: number; y: number } } {
  const aspect = sourceW / Math.max(1, sourceH);
  const maxW = mockupW * 0.35;
  const maxH = mockupH * 0.55;
  let w = maxW;
  let h = w / aspect;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  const cx = mockupW / 2 + centerOffset.dx;
  const cy = mockupH / 2 + centerOffset.dy;
  return {
    topLeft: { x: cx - w / 2, y: cy - h / 2 },
    topRight: { x: cx + w / 2, y: cy - h / 2 },
    bottomRight: { x: cx + w / 2, y: cy + h / 2 },
    bottomLeft: { x: cx - w / 2, y: cy + h / 2 },
  };
}

export function meshIndex(mesh: MeshGrid, c: number, r: number): number {
  return r * (mesh.cols + 1) + c;
}

export function meshGetPoint(mesh: MeshGrid, c: number, r: number): MeshPoint | undefined {
  return mesh.points[meshIndex(mesh, c, r)];
}

/**
 * Resample a mesh to a new (cols, rows) by warping the new grid through the existing mesh.
 * Preserves the current shape on the mockup.
 */
export function resampleMesh(mesh: MeshGrid, newCols: number, newRows: number): MeshGrid {
  const newPoints: MeshPoint[] = [];
  for (let r = 0; r <= newRows; r++) {
    const v = r / newRows;
    for (let c = 0; c <= newCols; c++) {
      const u = c / newCols;
      const target = warpUVThroughMesh(mesh, u, v);
      newPoints.push({ u, v, x: target.x, y: target.y });
    }
  }
  return { cols: newCols, rows: newRows, points: newPoints };
}

/**
 * Find the cell (cx, ry) that contains a (u, v) point and bilinearly interpolate the
 * corresponding mockup-space (x, y).
 */
export function warpUVThroughMesh(mesh: MeshGrid, u: number, v: number): { x: number; y: number } {
  const cu = Math.min(mesh.cols - 1, Math.max(0, Math.floor(u * mesh.cols)));
  const ru = Math.min(mesh.rows - 1, Math.max(0, Math.floor(v * mesh.rows)));
  const localU = u * mesh.cols - cu;
  const localV = v * mesh.rows - ru;
  const tl = meshGetPoint(mesh, cu, ru)!;
  const tr = meshGetPoint(mesh, cu + 1, ru)!;
  const bl = meshGetPoint(mesh, cu, ru + 1)!;
  const br = meshGetPoint(mesh, cu + 1, ru + 1)!;
  const top = { x: tl.x + (tr.x - tl.x) * localU, y: tl.y + (tr.y - tl.y) * localU };
  const bottom = { x: bl.x + (br.x - bl.x) * localU, y: bl.y + (br.y - bl.y) * localU };
  return { x: top.x + (bottom.x - top.x) * localV, y: top.y + (bottom.y - top.y) * localV };
}

/**
 * Apply a transform (translate/scale/rotate around center) to all mesh points.
 */
export function transformMesh(
  mesh: MeshGrid,
  opts: { dx?: number; dy?: number; scale?: number; rotation?: number; pivot?: { x: number; y: number } },
): MeshGrid {
  const { dx = 0, dy = 0, scale = 1, rotation = 0, pivot } = opts;
  const cx = pivot?.x ?? mesh.points.reduce((acc, p) => acc + p.x, 0) / mesh.points.length;
  const cy = pivot?.y ?? mesh.points.reduce((acc, p) => acc + p.y, 0) / mesh.points.length;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    cols: mesh.cols,
    rows: mesh.rows,
    points: mesh.points.map((p) => {
      const lx = (p.x - cx) * scale;
      const ly = (p.y - cy) * scale;
      const rx = lx * cos - ly * sin;
      const ry = lx * sin + ly * cos;
      return { u: p.u, v: p.v, x: cx + rx + dx, y: cy + ry + dy };
    }),
  };
}

export function applyPanelTransformToMesh(mesh: MeshGrid, transform: PanelTransform | null | undefined): MeshGrid {
  if (!transform) return mesh;
  const { x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1 } = transform;
  if (x === 0 && y === 0 && rotation === 0 && scaleX === 1 && scaleY === 1) return mesh;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    cols: mesh.cols,
    rows: mesh.rows,
    points: mesh.points.map((p) => {
      const sx = p.x * scaleX;
      const sy = p.y * scaleY;
      return {
        ...p,
        x: sx * cos - sy * sin + x,
        y: sx * sin + sy * cos + y,
      };
    }),
  };
}

/**
 * Compute affine matrix [a b c d e f] mapping source triangle (in pixel coords) to dest triangle.
 *   x = a*sx + c*sy + e
 *   y = b*sx + d*sy + f
 */
export function affineFromTriangles(
  s0: { x: number; y: number },
  s1: { x: number; y: number },
  s2: { x: number; y: number },
  d0: { x: number; y: number },
  d1: { x: number; y: number },
  d2: { x: number; y: number },
): [number, number, number, number, number, number] | null {
  const u01 = s1.x - s0.x;
  const u02 = s2.x - s0.x;
  const v01 = s1.y - s0.y;
  const v02 = s2.y - s0.y;
  const x01 = d1.x - d0.x;
  const x02 = d2.x - d0.x;
  const y01 = d1.y - d0.y;
  const y02 = d2.y - d0.y;
  const det = u01 * v02 - u02 * v01;
  if (Math.abs(det) < 1e-9) return null;
  const a = (x01 * v02 - x02 * v01) / det;
  const c = (x02 * u01 - x01 * u02) / det;
  const b = (y01 * v02 - y02 * v01) / det;
  const d = (y02 * u01 - y01 * u02) / det;
  const e = d0.x - (a * s0.x + c * s0.y);
  const f = d0.y - (b * s0.x + d * s0.y);
  return [a, b, c, d, e, f];
}

/**
 * Draw an HTMLImageElement (or HTMLCanvasElement) warped through `mesh` onto `ctx`.
 * Each cell is split into two triangles. The mask polygon (UV) is converted to a
 * mockup-space clipping polygon using the mesh, applied before drawing.
 */
export function drawMeshWarp(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource & { width?: number; height?: number },
  sourceSize: { width: number; height: number },
  mesh: MeshGrid,
  options: { opacity: number; mask?: UV[] | null } = { opacity: 1, mask: null },
) {
  const sw = sourceSize.width;
  const sh = sourceSize.height;
  ctx.save();
  ctx.globalAlpha = options.opacity;
  if (options.mask && options.mask.length >= 3) {
    const clipped = options.mask.map((p) => warpUVThroughMesh(mesh, p.u, p.v));
    ctx.beginPath();
    ctx.moveTo(clipped[0].x, clipped[0].y);
    for (let i = 1; i < clipped.length; i++) ctx.lineTo(clipped[i].x, clipped[i].y);
    ctx.closePath();
    ctx.clip();
  }
  for (let r = 0; r < mesh.rows; r++) {
    for (let c = 0; c < mesh.cols; c++) {
      const tl = meshGetPoint(mesh, c, r)!;
      const tr = meshGetPoint(mesh, c + 1, r)!;
      const bl = meshGetPoint(mesh, c, r + 1)!;
      const br = meshGetPoint(mesh, c + 1, r + 1)!;
      drawTriangle(ctx, src, sw, sh, tl, tr, br);
      drawTriangle(ctx, src, sw, sh, tl, br, bl);
    }
  }
  ctx.restore();
}

function drawTriangle(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource & { width?: number; height?: number },
  sw: number,
  sh: number,
  p0: MeshPoint,
  p1: MeshPoint,
  p2: MeshPoint,
) {
  const s0 = { x: p0.u * sw, y: p0.v * sh };
  const s1 = { x: p1.u * sw, y: p1.v * sh };
  const s2 = { x: p2.u * sw, y: p2.v * sh };
  const d0 = { x: p0.x, y: p0.y };
  const d1 = { x: p1.x, y: p1.y };
  const d2 = { x: p2.x, y: p2.y };
  const m = affineFromTriangles(s0, s1, s2, d0, d1, d2);
  if (!m) return;
  // Anti-edge guard: extend the destination triangle slightly to mask hairline gaps.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(src, 0, 0, sw, sh);
  ctx.restore();
}

/**
 * Convert a calibration JSON's panel mesh to a sorted array of "outer ring" points
 * (the panel outline) used by the perspective-handle UI.
 */
export function meshOutline(mesh: MeshGrid): MeshPoint[] {
  const out: MeshPoint[] = [];
  for (let c = 0; c <= mesh.cols; c++) out.push(meshGetPoint(mesh, c, 0)!);
  for (let r = 1; r <= mesh.rows; r++) out.push(meshGetPoint(mesh, mesh.cols, r)!);
  for (let c = mesh.cols - 1; c >= 0; c--) out.push(meshGetPoint(mesh, c, mesh.rows)!);
  for (let r = mesh.rows - 1; r > 0; r--) out.push(meshGetPoint(mesh, 0, r)!);
  return out;
}

/**
 * Default polygon mask = 4 corners of the source image.
 */
export function defaultMaskPolygon(): UV[] {
  return [
    { u: 0, v: 0 },
    { u: 1, v: 0 },
    { u: 1, v: 1 },
    { u: 0, v: 1 },
  ];
}
