import type {
  CalibrationImport,
  CalibrationMaskImport,
  CalibrationMeshImport,
  CalibrationTriangleImport,
  DetectionImport,
} from "./types";

/**
 * Client-side port of `scripts/lib/aop-panel-calibrate.ts#buildPanelCalibration`.
 *
 * Used by the "Build calibration from detection" action so the mapper can
 * compute the same piecewise-affine mesh + mask that the offline CLI produces,
 * without a server roundtrip. The math must stay in lock-step with the CLI so
 * the in-mapper button and the saved JSON are interchangeable.
 *
 * Input: a `DetectionImport` (output of scripts/detect-aop-triangle-calibration.ts)
 *        plus the panel's render dimensions (taken from the mapper's panel state
 *        because the detection JSON itself does not carry source pixel size).
 * Output: a `CalibrationImport` matching the CLI's JSON schema, ready to feed
 *         into `setMaskPolygon` / `replaceMesh` actions.
 */

const SOLVER_DEFAULT_ITERATIONS = 80;
const SOLVER_DEFAULT_TOLERANCE_PX = 0.5;
const LOW_CONFIDENCE_THRESHOLD = 0.5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function vertexIndex(col: number, row: number, cols: number): number {
  return row * (cols + 1) + col;
}

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

type SolverTriangle = {
  triangleId: number;
  type: "upper" | "lower";
  cell: { row: number; col: number };
  vertexIndices: [number, number, number];
  centroid: { x: number; y: number };
  confidence: number;
};

function gatherSolverTriangles(detection: DetectionImport): SolverTriangle[] {
  const cols = detection.panelGrid.cols;
  const out: SolverTriangle[] = [];
  for (const det of detection.detectedTriangles) {
    if (det.rejected || !det.centroidXY || !det.cell || !det.type) continue;
    const grid = triangleVertexGridPositions(det.type, det.cell.col, det.cell.row);
    const indices = grid.map((g) => vertexIndex(g[0], g[1], cols)) as [number, number, number];
    out.push({
      triangleId: det.id,
      type: det.type,
      cell: det.cell,
      vertexIndices: indices,
      centroid: { x: det.centroidXY.x, y: det.centroidXY.y },
      confidence: clamp(det.confidence, 0, 1),
    });
  }
  return out;
}

function solveMesh(
  detection: DetectionImport,
  iterations: number,
  toleranceCells: number,
): { mesh: CalibrationMeshImport; constraintCounts: number[]; triangles: SolverTriangle[] } {
  const cols = detection.panelGrid.cols;
  const rows = detection.panelGrid.rows;
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

  const triangles = gatherSolverTriangles(detection);
  const vertexTriangles: SolverTriangle[][] = Array.from({ length: vertexCount }, () => []);
  for (const tri of triangles) {
    for (const idx of tri.vertexIndices) vertexTriangles[idx].push(tri);
  }

  for (let iter = 0; iter < iterations; iter++) {
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

  const points: CalibrationMeshImport["points"] = [];
  const constraintCounts: number[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const idx = vertexIndex(c, r, cols);
      const constraintCount = vertexTriangles[idx].length;
      constraintCounts.push(constraintCount);
      const tris = vertexTriangles[idx];
      const meanConf =
        tris.length > 0
          ? tris.reduce((acc, tri) => acc + tri.confidence, 0) / tris.length
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
  return { mesh: { rows, cols, points }, constraintCounts, triangles };
}

function buildCalibrationTriangles(
  detection: DetectionImport,
  mesh: CalibrationMeshImport,
  sourceSize: { width: number; height: number },
): CalibrationTriangleImport[] {
  const cols = detection.panelGrid.cols;
  const rows = detection.panelGrid.rows;
  const sourceWidth = sourceSize.width;
  const sourceHeight = sourceSize.height;
  const out: CalibrationTriangleImport[] = [];
  for (const det of detection.detectedTriangles) {
    if (det.rejected || !det.centroidXY || !det.cell || !det.type) continue;
    const grid = triangleVertexGridPositions(det.type, det.cell.col, det.cell.row);
    const indices = grid.map((g) => vertexIndex(g[0], g[1], cols)) as [number, number, number];
    const src = grid.map(([gc, gr]) => [
      (gc / cols) * sourceWidth,
      (gr / rows) * sourceHeight,
    ]) as CalibrationTriangleImport["srcVertices"];
    const dst = indices.map((idx) => {
      const p = mesh.points[idx];
      return [p.x, p.y] as [number, number];
    }) as CalibrationTriangleImport["dstVertices"];
    out.push({
      triangleId: det.id,
      type: det.type,
      cell: det.cell,
      vertexIndices: indices,
      srcVertices: src,
      dstVertices: dst,
      confidence: clamp(det.confidence, 0, 1),
    });
  }
  return out;
}

function traceMaskBoundary(
  detection: DetectionImport,
  mesh: CalibrationMeshImport,
): CalibrationMaskImport {
  const cols = detection.panelGrid.cols;
  const rows = detection.panelGrid.rows;
  const detectedCell: boolean[][] = Array.from({ length: rows }, () => new Array(cols).fill(false));
  for (const det of detection.detectedTriangles) {
    if (det.rejected || !det.centroidXY || !det.cell) continue;
    const r = det.cell.row;
    const c = det.cell.col;
    if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
    detectedCell[r][c] = true;
  }
  const isDetected = (c: number, r: number) => c >= 0 && c < cols && r >= 0 && r < rows && detectedCell[r][c];

  const edgeMap = new Map<number, number>();
  const encode = (gc: number, gr: number) => gr * (cols + 1) + gc;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!detectedCell[r][c]) continue;
      if (!isDetected(c, r - 1)) edgeMap.set(encode(c, r), encode(c + 1, r));
      if (!isDetected(c + 1, r)) edgeMap.set(encode(c + 1, r), encode(c + 1, r + 1));
      if (!isDetected(c, r + 1)) edgeMap.set(encode(c + 1, r + 1), encode(c, r + 1));
      if (!isDetected(c - 1, r)) edgeMap.set(encode(c, r + 1), encode(c, r));
    }
  }

  if (edgeMap.size === 0) {
    return { polygon: [], polygonUV: [], source: "no-detection" };
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
  return { polygon, polygonUV, source: "outer-boundary-of-detected-triangles" };
}

export function buildCalibrationFromDetection(
  detection: DetectionImport,
  sourceSize: { width: number; height: number },
  options?: { iterations?: number; toleranceCells?: number },
): CalibrationImport {
  const { mesh, constraintCounts, triangles: solverTriangles } = solveMesh(
    detection,
    options?.iterations ?? SOLVER_DEFAULT_ITERATIONS,
    options?.toleranceCells ?? SOLVER_DEFAULT_TOLERANCE_PX,
  );
  const triangles = buildCalibrationTriangles(detection, mesh, sourceSize);
  const mask = traceMaskBoundary(detection, mesh);

  const detectedById = new Map<number, DetectionImport["detectedTriangles"][number]>();
  for (const det of detection.detectedTriangles) detectedById.set(det.id, det);
  const totalTriangleCount = detection.stats?.totalTriangles ?? detection.detectedTriangles.length;
  const missingTriangleIds: number[] = [];
  const lowConfidenceTriangleIds: number[] = [];
  for (const det of detection.detectedTriangles) {
    if (det.rejected || !det.centroidXY) {
      missingTriangleIds.push(det.id);
    } else if (det.confidence < LOW_CONFIDENCE_THRESHOLD) {
      lowConfidenceTriangleIds.push(det.id);
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
  const meshUnconstrainedVertexCount = constraintCounts.filter((n) => n === 0).length;
  const totalAccepted = solverTriangles.length;
  const avgConfidence =
    totalAccepted > 0
      ? solverTriangles.reduce((acc, tri) => acc + tri.confidence, 0) / totalAccepted
      : 0;
  const coveragePercent = totalTriangleCount > 0
    ? Math.round((totalAccepted / totalTriangleCount) * 1000) / 10
    : 0;

  return {
    version: "aop-panel-calibration/v1",
    panelName: detection.panelName,
    manifestVersion: detection.manifestVersion,
    detectedAt: detection.detectedAt,
    builtAt: new Date().toISOString(),
    sourceSize,
    mockupSize: detection.mockupSize,
    panelGrid: { cols: detection.panelGrid.cols, rows: detection.panelGrid.rows },
    triangles,
    mesh,
    mask,
    quality: {
      detectedTriangleCount: totalAccepted,
      totalTriangleCount,
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

/** Validate / normalise a calibration JSON loaded from disk. Throws on invalid input. */
export function validateCalibrationImport(raw: unknown): CalibrationImport {
  if (!raw || typeof raw !== "object") {
    throw new Error("Calibration JSON is not an object.");
  }
  const candidate = raw as Partial<CalibrationImport>;
  if (!candidate.panelName) throw new Error("Calibration JSON missing 'panelName'.");
  if (!candidate.mesh?.points?.length) throw new Error("Calibration JSON missing 'mesh.points'.");
  if (!candidate.mockupSize || !candidate.sourceSize) {
    throw new Error("Calibration JSON missing 'mockupSize' or 'sourceSize'.");
  }
  if (!candidate.panelGrid) throw new Error("Calibration JSON missing 'panelGrid'.");
  if (!candidate.mask) throw new Error("Calibration JSON missing 'mask'.");
  if (!Array.isArray(candidate.triangles)) {
    throw new Error("Calibration JSON missing 'triangles'.");
  }
  return candidate as CalibrationImport;
}
