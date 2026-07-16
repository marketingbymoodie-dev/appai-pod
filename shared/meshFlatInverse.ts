import type { MeshGrid, Pt, SourceRect } from "./hoodieTemplate";

const EPS = 1e-4;

function applySourceUvTransform(
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

function sourceUvToFlatPixel(
  u: number,
  v: number,
  mesh: MeshGrid,
  flatW: number,
  flatH: number,
): Pt {
  const src: SourceRect = mesh.sourceRect ?? {
    x: 0,
    y: 0,
    width: flatW,
    height: flatH,
  };
  const t = applySourceUvTransform(
    u,
    v,
    mesh.sourceRotation ?? 0,
    mesh.sourceFlipX ?? false,
    mesh.sourceFlipY ?? false,
  );
  return {
    x: src.x + t.u * src.width,
    y: src.y + t.v * src.height,
  };
}

/** Barycentric weights for `p` inside triangle `abc` (mockup space). */
function barycentricInTriangle(
  p: Pt,
  a: Pt,
  b: Pt,
  c: Pt,
): { wa: number; wb: number; wc: number } | null {
  const v0x = c.x - a.x;
  const v0y = c.y - a.y;
  const v1x = b.x - a.x;
  const v1y = b.y - a.y;
  const v2x = p.x - a.x;
  const v2y = p.y - a.y;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const denom = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denom) < 1e-12) return null;
  const wc = (dot11 * dot02 - dot01 * dot12) / denom;
  const wb = (dot00 * dot12 - dot01 * dot02) / denom;
  const wa = 1 - wc - wb;
  if (wa < -EPS || wb < -EPS || wc < -EPS) return null;
  return { wa, wb, wc };
}

function uvAtMeshCorner(c: number, r: number, cols: number, rows: number): { u: number; v: number } {
  return { u: c / (cols - 1), v: r / (rows - 1) };
}

/**
 * Inverse of the mesh warp: mockup pixel → flat print-canvas pixel.
 * Used when compositing one panel's flat art onto another (pullover pocket → front).
 */
export function mockupPointToMeshFlatPixel(
  p: Pt,
  mesh: MeshGrid,
  flatW: number,
  flatH: number,
): Pt | null {
  if (mesh.cols < 2 || mesh.rows < 2) return null;
  if (mesh.targetPoints.length !== mesh.cols * mesh.rows) return null;

  const cols = mesh.cols;
  const rows = mesh.rows;

  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const uvTL = uvAtMeshCorner(c, r, cols, rows);
      const uvTR = uvAtMeshCorner(c + 1, r, cols, rows);
      const uvBL = uvAtMeshCorner(c, r + 1, cols, rows);
      const uvBR = uvAtMeshCorner(c + 1, r + 1, cols, rows);

      const tTL = mesh.targetPoints[r * cols + c];
      const tTR = mesh.targetPoints[r * cols + (c + 1)];
      const tBL = mesh.targetPoints[(r + 1) * cols + c];
      const tBR = mesh.targetPoints[(r + 1) * cols + (c + 1)];

      const tri1 = barycentricInTriangle(p, tTL, tTR, tBL);
      if (tri1) {
        const u = tri1.wa * uvTL.u + tri1.wb * uvTR.u + tri1.wc * uvBL.u;
        const v = tri1.wa * uvTL.v + tri1.wb * uvTR.v + tri1.wc * uvBL.v;
        return sourceUvToFlatPixel(u, v, mesh, flatW, flatH);
      }

      const tri2 = barycentricInTriangle(p, tTR, tBR, tBL);
      if (tri2) {
        const u = tri2.wa * uvTR.u + tri2.wb * uvBR.u + tri2.wc * uvBL.u;
        const v = tri2.wa * uvTR.v + tri2.wb * uvBR.v + tri2.wc * uvBL.v;
        return sourceUvToFlatPixel(u, v, mesh, flatW, flatH);
      }
    }
  }

  return null;
}

export function mapMockupPointsViaHostMesh(
  points: Pt[],
  hostMesh: MeshGrid | null | undefined,
  hostBb: { x: number; y: number; width: number; height: number },
  flatW: number,
  flatH: number,
  linearFallback: (p: Pt) => Pt,
): Pt[] {
  return points.map((p) => {
    if (hostMesh) {
      const mapped = mockupPointToMeshFlatPixel(p, hostMesh, flatW, flatH);
      if (mapped) return mapped;
    }
    return linearFallback(p);
  });
}
