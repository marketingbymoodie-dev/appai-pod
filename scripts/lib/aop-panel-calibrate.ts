import sharp from "sharp";
import {
  type DetectedTriangle,
  type DetectionOutput,
  type ManifestTriangle,
  type PanelManifest,
  clamp,
} from "./aop-triangle-pipeline";

/**
 * AOP per-panel calibration math + reusable warp utilities.
 *
 * Inputs:
 *   - PanelManifest (from generate-aop-triangle-calibration.ts)
 *   - DetectionOutput (from detect-aop-triangle-calibration.ts via the shared pipeline)
 *   - Source panel PNG buffer
 *   - Mockup PNG buffer
 *
 * Produces:
 *   - PanelCalibration JSON: piecewise-affine triangle mapping + solved mesh + mask polygon + quality
 *   - Reconstruction PNG: source panel warped through the saved mappings onto a blank canvas
 *   - Debug PNG: mockup × reconstruction overlay highlighting alignment, mask, low-confidence triangles
 *
 * Solver:
 *   Each detected triangle gives one centroid constraint per axis: (V[a]+V[b]+V[c])/3 = centroid.
 *   We initialise vertex positions from the IDW suggestedMesh and refine with weighted Gauss-Seidel
 *   iterations (weight = triangle confidence), which converges to the least-squares mesh that best
 *   explains every detected triangle centroid simultaneously. Vertices not constrained by any
 *   detected triangle keep their IDW estimate, which is enough for the boundary mesh to stay on the
 *   panel perimeter even with partial detection coverage.
 */

export type SolvedMeshPoint = {
  u: number;
  v: number;
  x: number;
  y: number;
  confidence: number;
  /** how many detected triangles contributed to this vertex */
  constraintCount: number;
};

export type SolvedMesh = {
  rows: number;
  cols: number;
  points: SolvedMeshPoint[];
};

export type CalibrationTriangle = {
  triangleId: number;
  type: "upper" | "lower";
  cell: { row: number; col: number };
  vertexIndices: [number, number, number];
  srcVertices: [[number, number], [number, number], [number, number]];
  dstVertices: [[number, number], [number, number], [number, number]];
  confidence: number;
};

export type CalibrationMask = {
  polygon: Array<[number, number]>;
  polygonUV: Array<[number, number]>;
  source: string;
};

export type CalibrationQuality = {
  detectedTriangleCount: number;
  totalTriangleCount: number;
  coveragePercent: number;
  avgConfidence: number;
  meshUnconstrainedVertexCount: number;
  meanCentroidErrorPx: number;
  maxCentroidErrorPx: number;
  missingTriangleIds: number[];
  lowConfidenceTriangleIds: number[];
};

export type PanelCalibration = {
  version: "aop-panel-calibration/v1";
  panelName: string;
  manifestVersion: string;
  detectedAt: string;
  builtAt: string;
  sourceSize: { width: number; height: number };
  mockupSize: { width: number; height: number };
  panelGrid: { cols: number; rows: number };
  triangles: CalibrationTriangle[];
  mesh: SolvedMesh;
  mask: CalibrationMask;
  quality: CalibrationQuality;
};

export const SOLVER_DEFAULT_ITERATIONS = 80;
export const SOLVER_DEFAULT_TOLERANCE_PX = 0.5;
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

function vertexIndex(col: number, row: number, cols: number): number {
  return row * (cols + 1) + col;
}

/** Triangle vertex grid positions for an upper/lower triangle in cell (col, row). */
function triangleVertexGridPositions(
  type: "upper" | "lower",
  col: number,
  row: number,
): [[number, number], [number, number], [number, number]] {
  if (type === "upper") {
    return [
      [col, row],
      [col + 1, row],
      [col + 1, row + 1],
    ];
  }
  return [
    [col, row],
    [col + 1, row + 1],
    [col, row + 1],
  ];
}

function manifestTriangleByVertexGrid(panel: PanelManifest): Map<number, ManifestTriangle> {
  const map = new Map<number, ManifestTriangle>();
  for (const tri of panel.triangles) map.set(tri.id, tri);
  return map;
}

type SolverTriangle = {
  triangleId: number;
  vertexIndices: [number, number, number];
  centroid: { x: number; y: number };
  confidence: number;
};

function gatherSolverTriangles(
  panel: PanelManifest,
  detection: DetectionOutput,
): SolverTriangle[] {
  const out: SolverTriangle[] = [];
  const manifestById = manifestTriangleByVertexGrid(panel);
  for (const det of detection.detectedTriangles) {
    if (det.rejected || !det.centroidXY) continue;
    const manifestTri = manifestById.get(det.id);
    if (!manifestTri) continue;
    const grid = triangleVertexGridPositions(manifestTri.type, manifestTri.cell.col, manifestTri.cell.row);
    const indices = grid.map((g) => vertexIndex(g[0], g[1], panel.cols)) as [number, number, number];
    out.push({
      triangleId: det.id,
      vertexIndices: indices,
      centroid: { x: det.centroidXY.x, y: det.centroidXY.y },
      confidence: clamp(det.confidence, 0, 1),
    });
  }
  return out;
}

/**
 * Iteratively refine vertex positions so that each detected triangle's centroid
 * matches its measured centroid in the mockup. Confidence-weighted Gauss-Seidel
 * relaxation. Initial vertex positions come from the IDW suggested mesh.
 */
function solveMesh(
  panel: PanelManifest,
  detection: DetectionOutput,
  iterations: number = SOLVER_DEFAULT_ITERATIONS,
  toleranceCells: number = SOLVER_DEFAULT_TOLERANCE_PX,
): { mesh: SolvedMesh; constraintCounts: number[]; triangles: SolverTriangle[]; iterationsRun: number } {
  const cols = panel.cols;
  const rows = panel.rows;
  const vertexCount = (cols + 1) * (rows + 1);

  const xs = new Float64Array(vertexCount);
  const ys = new Float64Array(vertexCount);
  const baseConfidence = new Float64Array(vertexCount);
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const idx = vertexIndex(c, r, cols);
      const sm = detection.suggestedMesh.points[idx];
      xs[idx] = sm?.x ?? 0;
      ys[idx] = sm?.y ?? 0;
      baseConfidence[idx] = sm?.confidence ?? 0;
    }
  }

  const triangles = gatherSolverTriangles(panel, detection);
  const vertexTriangles: SolverTriangle[][] = Array.from({ length: vertexCount }, () => []);
  for (const tri of triangles) {
    for (const idx of tri.vertexIndices) vertexTriangles[idx].push(tri);
  }

  const constraintCounts = vertexTriangles.map((list) => list.length);

  let iterationsRun = 0;
  for (let iter = 0; iter < iterations; iter++) {
    iterationsRun = iter + 1;
    let maxDelta = 0;
    for (let v = 0; v < vertexCount; v++) {
      const tris = vertexTriangles[v];
      if (tris.length === 0) continue;
      let sumX = 0;
      let sumY = 0;
      let sumW = 0;
      for (const tri of tris) {
        const others = tri.vertexIndices.filter((idx) => idx !== v);
        if (others.length !== 2) continue;
        const o0 = others[0];
        const o1 = others[1];
        const estX = 3 * tri.centroid.x - xs[o0] - xs[o1];
        const estY = 3 * tri.centroid.y - ys[o0] - ys[o1];
        const w = Math.max(0.05, tri.confidence);
        sumX += w * estX;
        sumY += w * estY;
        sumW += w;
      }
      if (sumW <= 0) continue;
      const newX = sumX / sumW;
      const newY = sumY / sumW;
      const dx = newX - xs[v];
      const dy = newY - ys[v];
      const delta = Math.hypot(dx, dy);
      if (delta > maxDelta) maxDelta = delta;
      xs[v] = newX;
      ys[v] = newY;
    }
    if (maxDelta < toleranceCells) break;
  }

  const points: SolvedMeshPoint[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const idx = vertexIndex(c, r, cols);
      const constraintCount = constraintCounts[idx];
      const constraintTris = vertexTriangles[idx];
      const meanConf =
        constraintTris.length > 0
          ? constraintTris.reduce((acc, tri) => acc + tri.confidence, 0) / constraintTris.length
          : baseConfidence[idx];
      points.push({
        u: c / cols,
        v: r / rows,
        x: xs[idx],
        y: ys[idx],
        confidence: clamp(meanConf, 0, 1),
        constraintCount,
      });
    }
  }

  return { mesh: { rows, cols, points }, constraintCounts, triangles, iterationsRun };
}

/** Build per-triangle src/dst vertices from the solved mesh. */
function buildCalibrationTriangles(
  panel: PanelManifest,
  detection: DetectionOutput,
  mesh: SolvedMesh,
): CalibrationTriangle[] {
  const cols = panel.cols;
  const sourceWidth = panel.renderSize.width;
  const sourceHeight = panel.renderSize.height;
  const out: CalibrationTriangle[] = [];
  const manifestById = manifestTriangleByVertexGrid(panel);

  for (const det of detection.detectedTriangles) {
    if (det.rejected || !det.centroidXY) continue;
    const manifestTri = manifestById.get(det.id);
    if (!manifestTri) continue;
    const grid = triangleVertexGridPositions(manifestTri.type, manifestTri.cell.col, manifestTri.cell.row);
    const indices = grid.map((g) => vertexIndex(g[0], g[1], cols)) as [number, number, number];
    const src = grid.map(([gc, gr]) => [
      (gc / cols) * sourceWidth,
      (gr / panel.rows) * sourceHeight,
    ]) as CalibrationTriangle["srcVertices"];
    const dst = indices.map((idx) => {
      const p = mesh.points[idx];
      return [p.x, p.y] as [number, number];
    }) as CalibrationTriangle["dstVertices"];
    out.push({
      triangleId: det.id,
      type: manifestTri.type,
      cell: manifestTri.cell,
      vertexIndices: indices,
      srcVertices: src,
      dstVertices: dst,
      confidence: clamp(det.confidence, 0, 1),
    });
  }
  return out;
}

/** Trace the outer boundary of detected cells in grid space. */
function traceMaskBoundary(
  panel: PanelManifest,
  detection: DetectionOutput,
  mesh: SolvedMesh,
): CalibrationMask {
  const cols = panel.cols;
  const rows = panel.rows;
  const detectedCell: boolean[][] = Array.from({ length: rows }, () => new Array(cols).fill(false));
  for (const det of detection.detectedTriangles) {
    if (det.rejected || !det.centroidXY) continue;
    const r = det.cell.row;
    const c = det.cell.col;
    if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
    detectedCell[r][c] = true;
  }

  const isDetected = (c: number, r: number) => c >= 0 && c < cols && r >= 0 && r < rows && detectedCell[r][c];

  /**
   * Each directed edge stores `from` and `to` as grid vertex indices, with the
   * detected region on the LEFT side when walked. We orient them so the
   * traversal goes clockwise in screen space (y-down).
   */
  const edgeMap = new Map<number, number>();
  const encode = (gc: number, gr: number) => gr * (cols + 1) + gc;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!detectedCell[r][c]) continue;
      // Top edge: walk left → right when cell above is undetected
      if (!isDetected(c, r - 1)) {
        edgeMap.set(encode(c, r), encode(c + 1, r));
      }
      // Right edge: walk top → bottom when cell to the right is undetected
      if (!isDetected(c + 1, r)) {
        edgeMap.set(encode(c + 1, r), encode(c + 1, r + 1));
      }
      // Bottom edge: walk right → left when cell below is undetected
      if (!isDetected(c, r + 1)) {
        edgeMap.set(encode(c + 1, r + 1), encode(c, r + 1));
      }
      // Left edge: walk bottom → top when cell to the left is undetected
      if (!isDetected(c - 1, r)) {
        edgeMap.set(encode(c, r + 1), encode(c, r));
      }
    }
  }

  if (edgeMap.size === 0) {
    return {
      polygon: [],
      polygonUV: [],
      source: "no-detection",
    };
  }

  let bestStart = -1;
  for (const [start] of edgeMap) {
    if (bestStart < 0 || start < bestStart) bestStart = start;
  }
  const visited = new Set<number>();
  const sequence: number[] = [];
  let cursor = bestStart;
  while (cursor !== undefined && !visited.has(cursor)) {
    visited.add(cursor);
    sequence.push(cursor);
    const next = edgeMap.get(cursor);
    if (next === undefined) break;
    if (next === bestStart) break;
    cursor = next;
  }

  const polygon: Array<[number, number]> = [];
  const polygonUV: Array<[number, number]> = [];
  for (const code of sequence) {
    const gc = code % (cols + 1);
    const gr = Math.floor(code / (cols + 1));
    const idx = vertexIndex(gc, gr, cols);
    const p = mesh.points[idx];
    polygon.push([p.x, p.y]);
    polygonUV.push([gc / cols, gr / rows]);
  }

  return {
    polygon,
    polygonUV,
    source: "outer-boundary-of-detected-triangles",
  };
}

export function buildPanelCalibration(
  panel: PanelManifest,
  detection: DetectionOutput,
  options?: { iterations?: number; toleranceCells?: number },
): PanelCalibration {
  const { mesh, triangles: solverTriangles, iterationsRun } = solveMesh(
    panel,
    detection,
    options?.iterations ?? SOLVER_DEFAULT_ITERATIONS,
    options?.toleranceCells ?? SOLVER_DEFAULT_TOLERANCE_PX,
  );
  const triangles = buildCalibrationTriangles(panel, detection, mesh);
  const mask = traceMaskBoundary(panel, detection, mesh);

  // quality stats
  const detectedById = new Map<number, DetectedTriangle>();
  for (const det of detection.detectedTriangles) detectedById.set(det.id, det);
  const missingTriangleIds: number[] = [];
  const lowConfidenceTriangleIds: number[] = [];
  for (const manifestTri of panel.triangles) {
    const det = detectedById.get(manifestTri.id);
    if (!det || det.rejected || !det.centroidXY) {
      missingTriangleIds.push(manifestTri.id);
    } else if (det.confidence < LOW_CONFIDENCE_THRESHOLD) {
      lowConfidenceTriangleIds.push(manifestTri.id);
    }
  }

  let centroidErrSum = 0;
  let centroidErrMax = 0;
  for (const tri of solverTriangles) {
    const a = mesh.points[tri.vertexIndices[0]];
    const b = mesh.points[tri.vertexIndices[1]];
    const c = mesh.points[tri.vertexIndices[2]];
    const cx = (a.x + b.x + c.x) / 3;
    const cy = (a.y + b.y + c.y) / 3;
    const err = Math.hypot(cx - tri.centroid.x, cy - tri.centroid.y);
    centroidErrSum += err;
    if (err > centroidErrMax) centroidErrMax = err;
  }
  const meanCentroidErrorPx = solverTriangles.length > 0 ? centroidErrSum / solverTriangles.length : 0;
  const meshUnconstrainedVertexCount = mesh.points.filter((p) => p.constraintCount === 0).length;

  const totalAccepted = solverTriangles.length;
  const avgConfidence =
    totalAccepted > 0
      ? solverTriangles.reduce((acc, tri) => acc + tri.confidence, 0) / totalAccepted
      : 0;
  const coveragePercent = panel.triangles.length > 0
    ? Math.round((totalAccepted / panel.triangles.length) * 1000) / 10
    : 0;

  return {
    version: "aop-panel-calibration/v1",
    panelName: panel.panelKey,
    manifestVersion: detection.manifestVersion,
    detectedAt: detection.detectedAt,
    builtAt: new Date().toISOString(),
    sourceSize: { width: panel.renderSize.width, height: panel.renderSize.height },
    mockupSize: detection.mockupSize,
    panelGrid: { cols: panel.cols, rows: panel.rows },
    triangles,
    mesh,
    mask,
    quality: {
      detectedTriangleCount: totalAccepted,
      totalTriangleCount: panel.triangles.length,
      coveragePercent,
      avgConfidence: clamp(avgConfidence, 0, 1),
      meshUnconstrainedVertexCount,
      meanCentroidErrorPx: Number(meanCentroidErrorPx.toFixed(2)),
      maxCentroidErrorPx: Number(centroidErrMax.toFixed(2)),
      missingTriangleIds,
      lowConfidenceTriangleIds,
    },
  };
}

/* ─────────────────────────  warp / rasterizer  ───────────────────────── */

type RawImage = { data: Buffer; width: number; height: number };

async function loadRawRgba(buffer: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function makeBlankRgba(width: number, height: number): Buffer {
  return Buffer.alloc(width * height * 4);
}

/**
 * Rasterise a single source triangle onto the destination buffer using
 * barycentric coordinates and bilinear sampling. Source-over compositing in
 * straight (non-premultiplied) RGBA.
 */
function rasterizeTriangleAffine(
  out: Buffer,
  outW: number,
  outH: number,
  src: RawImage,
  srcVerts: [[number, number], [number, number], [number, number]],
  dstVerts: [[number, number], [number, number], [number, number]],
) {
  const xs = dstVerts.map((v) => v[0]);
  const ys = dstVerts.map((v) => v[1]);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxX = Math.min(outW - 1, Math.ceil(Math.max(...xs)));
  const maxY = Math.min(outH - 1, Math.ceil(Math.max(...ys)));
  if (maxX < minX || maxY < minY) return;

  const [d0, d1, d2] = dstVerts;
  const [s0, s1, s2] = srcVerts;
  const denom = (d1[1] - d2[1]) * (d0[0] - d2[0]) + (d2[0] - d1[0]) * (d0[1] - d2[1]);
  if (Math.abs(denom) < 1e-9) return;

  const sw = src.width;
  const sh = src.height;
  const eps = 1e-3;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((d1[1] - d2[1]) * (px - d2[0]) + (d2[0] - d1[0]) * (py - d2[1])) / denom;
      const w1 = ((d2[1] - d0[1]) * (px - d2[0]) + (d0[0] - d2[0]) * (py - d2[1])) / denom;
      const w2 = 1 - w0 - w1;
      if (w0 < -eps || w1 < -eps || w2 < -eps) continue;

      const sx = w0 * s0[0] + w1 * s1[0] + w2 * s2[0];
      const sy = w0 * s0[1] + w1 * s1[1] + w2 * s2[1];
      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) continue;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;

      const sR = src.data[i00] * w00 + src.data[i10] * w10 + src.data[i01] * w01 + src.data[i11] * w11;
      const sG = src.data[i00 + 1] * w00 + src.data[i10 + 1] * w10 + src.data[i01 + 1] * w01 + src.data[i11 + 1] * w11;
      const sB = src.data[i00 + 2] * w00 + src.data[i10 + 2] * w10 + src.data[i01 + 2] * w01 + src.data[i11 + 2] * w11;
      const sA = src.data[i00 + 3] * w00 + src.data[i10 + 3] * w10 + src.data[i01 + 3] * w01 + src.data[i11 + 3] * w11;

      const outIdx = (y * outW + x) * 4;
      const da = sA / 255;
      if (da <= 0) continue;
      const oaPrev = out[outIdx + 3] / 255;
      const oa = oaPrev + da * (1 - oaPrev);
      if (oa <= 0) continue;
      const blend = (cur: number, srcVal: number) => (cur * oaPrev * (1 - da) + srcVal * da) / oa;
      out[outIdx] = Math.max(0, Math.min(255, Math.round(blend(out[outIdx], sR))));
      out[outIdx + 1] = Math.max(0, Math.min(255, Math.round(blend(out[outIdx + 1], sG))));
      out[outIdx + 2] = Math.max(0, Math.min(255, Math.round(blend(out[outIdx + 2], sB))));
      out[outIdx + 3] = Math.max(0, Math.min(255, Math.round(oa * 255)));
    }
  }
}

/**
 * Warp the source panel through every calibration triangle onto a transparent
 * canvas at mockup size. Returns a PNG buffer.
 */
export async function renderReconstruction(
  sourceBuffer: Buffer,
  calibration: PanelCalibration,
): Promise<Buffer> {
  const src = await loadRawRgba(sourceBuffer);
  const W = calibration.mockupSize.width;
  const H = calibration.mockupSize.height;
  const out = makeBlankRgba(W, H);
  // Source dims in calibration may differ from actual source PNG dims; scale src verts to actual dims
  const scaleX = src.width / calibration.sourceSize.width;
  const scaleY = src.height / calibration.sourceSize.height;
  for (const tri of calibration.triangles) {
    const sv = tri.srcVertices.map((v) => [v[0] * scaleX, v[1] * scaleY]) as CalibrationTriangle["srcVertices"];
    rasterizeTriangleAffine(out, W, H, src, sv, tri.dstVertices);
  }
  return sharp(out, { raw: { width: W, height: H, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/* ─────────────────────────  debug overlay  ───────────────────────── */

function svgEscape(text: string): string {
  return text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c] as string));
}

function confidenceColor(conf: number): string {
  if (conf >= 0.7) return "#22c55e";
  if (conf >= 0.4) return "#eab308";
  return "#f97316";
}

/**
 * Compose `mockup × reconstruction` overlay with mask polygon and
 * triangle markers (colored by confidence). The mockup sits underneath; the
 * reconstruction is drawn on top at 70% opacity so misalignments stand out.
 */
export async function renderCalibrationDebug(params: {
  mockupBuffer: Buffer;
  reconstructionBuffer: Buffer;
  calibration: PanelCalibration;
}): Promise<Buffer> {
  const { mockupBuffer, reconstructionBuffer, calibration } = params;
  const W = calibration.mockupSize.width;
  const H = calibration.mockupSize.height;

  const mockupResized = await sharp(mockupBuffer)
    .resize(W, H, { fit: "fill" })
    .ensureAlpha()
    .toBuffer();
  const reconResized = await sharp(reconstructionBuffer)
    .resize(W, H, { fit: "fill" })
    .ensureAlpha()
    .toBuffer();
  // Multiply reconstruction alpha by ~0.7 by clamping with a fully-opaque-ish single pixel tiled
  // across the whole image (sharp's `dest-in` keeps `dst * src.alpha`).
  const reconAlpha = Math.round(0.7 * 255);
  const reconWithOpacity = await sharp(reconResized)
    .composite([
      {
        input: Buffer.from([255, 255, 255, reconAlpha]),
        raw: { width: 1, height: 1, channels: 4 },
        tile: true,
        blend: "dest-in",
      },
    ])
    .toBuffer();

  const lineWidth = Math.max(2, Math.min(W, H) * 0.0035);
  const dotR = Math.max(4, Math.min(W, H) * 0.005);
  const labelFont = Math.max(11, Math.min(W, H) * 0.014);
  const headerFont = Math.max(20, Math.min(W, H) * 0.025);

  // Mask polygon
  const maskPoly = calibration.mask.polygon
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const maskShape = maskPoly
    ? `<polygon points="${maskPoly}" fill="none" stroke="#38bdf8" stroke-width="${(lineWidth * 1.6).toFixed(2)}" stroke-dasharray="${(lineWidth * 4).toFixed(1)} ${(lineWidth * 2.5).toFixed(1)}"/>`
    : "";

  // Triangle confidence markers
  const dots: string[] = [];
  const labels: string[] = [];
  const polyStrokes: string[] = [];
  for (const tri of calibration.triangles) {
    const cx = (tri.dstVertices[0][0] + tri.dstVertices[1][0] + tri.dstVertices[2][0]) / 3;
    const cy = (tri.dstVertices[0][1] + tri.dstVertices[1][1] + tri.dstVertices[2][1]) / 3;
    const fill = confidenceColor(tri.confidence);
    dots.push(
      `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${dotR.toFixed(1)}" fill="${fill}" stroke="#0f172a" stroke-width="${(dotR * 0.18).toFixed(2)}"/>`,
    );
    labels.push(
      `<text x="${cx.toFixed(1)}" y="${(cy - dotR * 1.4).toFixed(1)}" text-anchor="middle" font-family="Verdana, Arial, sans-serif" font-size="${labelFont.toFixed(1)}" font-weight="700" fill="#f8fafc" stroke="#0f172a" stroke-width="${(labelFont * 0.18).toFixed(2)}" paint-order="stroke">${tri.triangleId}</text>`,
    );
    if (tri.confidence < LOW_CONFIDENCE_THRESHOLD) {
      const points = tri.dstVertices.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
      polyStrokes.push(
        `<polygon points="${points}" fill="none" stroke="#ef4444" stroke-width="${(lineWidth * 1.5).toFixed(2)}" stroke-dasharray="${(lineWidth * 3).toFixed(1)} ${(lineWidth * 1.5).toFixed(1)}"/>`,
      );
    }
  }

  // Solved mesh polylines (semi-transparent for context)
  const meshLines: string[] = [];
  const cols = calibration.mesh.cols;
  const rows = calibration.mesh.rows;
  const meshIdx = (c: number, r: number) => r * (cols + 1) + c;
  for (let r = 0; r <= rows; r++) {
    const pts: string[] = [];
    for (let c = 0; c <= cols; c++) {
      const p = calibration.mesh.points[meshIdx(c, r)];
      pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    }
    meshLines.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="rgba(56,189,248,0.45)" stroke-width="${(lineWidth * 0.6).toFixed(2)}"/>`);
  }
  for (let c = 0; c <= cols; c++) {
    const pts: string[] = [];
    for (let r = 0; r <= rows; r++) {
      const p = calibration.mesh.points[meshIdx(c, r)];
      pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    }
    meshLines.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="rgba(56,189,248,0.45)" stroke-width="${(lineWidth * 0.6).toFixed(2)}"/>`);
  }

  const headerLines: string[] = [
    `${calibration.panelName} · piecewise-affine calibration v1`,
    `triangles ${calibration.quality.detectedTriangleCount}/${calibration.quality.totalTriangleCount} · coverage ${calibration.quality.coveragePercent}% · avg conf ${(calibration.quality.avgConfidence * 100).toFixed(0)}%`,
    `mean centroid err ${calibration.quality.meanCentroidErrorPx.toFixed(2)}px · max ${calibration.quality.maxCentroidErrorPx.toFixed(2)}px · low-conf ${calibration.quality.lowConfidenceTriangleIds.length} · missing ${calibration.quality.missingTriangleIds.length}`,
  ];
  const headerText = headerLines
    .map(
      (line, i) =>
        `<text x="20" y="${(headerFont * (1.2 + i * 1.25)).toFixed(1)}" font-family="Verdana, Arial, sans-serif" font-size="${headerFont.toFixed(1)}" font-weight="800" fill="#f8fafc" stroke="#0f172a" stroke-width="${(headerFont * 0.18).toFixed(2)}" paint-order="stroke">${svgEscape(line)}</text>`,
    )
    .join("\n");

  const overlay = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${meshLines.join("\n    ")}
    ${maskShape}
    ${polyStrokes.join("\n    ")}
    ${dots.join("\n    ")}
    ${labels.join("\n    ")}
    ${headerText}
  </svg>`;

  const overlayBuffer = await sharp(Buffer.from(overlay, "utf8"), { density: 96 })
    .resize(W, H, { fit: "fill" })
    .png()
    .toBuffer();

  return sharp(mockupResized)
    .composite([
      { input: reconWithOpacity },
      { input: overlayBuffer },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}
