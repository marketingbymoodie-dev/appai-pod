import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/**
 * AOP triangle calibration detector (Milestone 2).
 *
 * Given a Printify mockup PNG that has a triangle-calibration panel printed
 * on it, find each known triangle by its target color and emit a JSON
 * description of the detected pixel clusters, plus a suggested calibration
 * mesh / mask the AOP Calibration Mapper can import as an initial guess.
 *
 * This is a deterministic OpenCV-style pipeline implemented with sharp +
 * raw RGBA buffers + simple Lab-space color matching. It does NOT use any
 * heavy ML model. If a node `opencv4nodejs` install is available we still
 * fall back to this pipeline for v1 (no native build required) — see
 * docs/aop-ai-assisted-calibration.md for upgrading later.
 *
 * Inputs:
 *   --panel <name>           panel key from KNOWN_PANELS (e.g. back, front_right)
 *   --mockup <path|url>      Printify mockup PNG (required)
 *   --source <path>          Optional source calibration panel PNG (used in debug PNG only)
 *   --manifest <path>        Defaults to tmp/aop-triangle-calibration/manifest.json
 *   --output <dir>           Defaults to tmp/aop-triangle-calibration
 *   --analysisLongEdge <px>  Downsample mockup before color search. Default 800.
 *   --labThreshold <num>     Max Lab distance for accepting a pixel match. Default 22.
 *   --minPixels <num>        Min pixels for a triangle to be considered detected. Default 12.
 *
 * Outputs:
 *   <output>/detections/<panel>.json
 *   <output>/debug/<panel>-detected.png
 */

const CWD = process.cwd();
const DEFAULT_OUTPUT_DIR = path.join(CWD, "tmp", "aop-triangle-calibration");
const DEFAULT_MANIFEST = path.join(DEFAULT_OUTPUT_DIR, "manifest.json");
const DEFAULT_ANALYSIS_LONG_EDGE = 800;
const DEFAULT_LAB_THRESHOLD = 22;
const DEFAULT_MIN_PIXELS = 12;

type UV = { u: number; v: number };
type XY = { x: number; y: number };

type ManifestTriangle = {
  id: number;
  panelKey: string;
  cell: { row: number; col: number };
  type: "upper" | "lower";
  uv: [UV, UV, UV];
  centroidUV: UV;
  color: { hex: string; rgb: [number, number, number]; hsl: [number, number, number] };
};

type PanelManifest = {
  panelKey: string;
  sourceSize: { width: number; height: number };
  renderSize: { width: number; height: number };
  cols: number;
  rows: number;
  triangleCount: number;
  cornerColors: { tl: string; tr: string; bl: string; br: string };
  triangles: ManifestTriangle[];
};

type Manifest = {
  version: string;
  generatedAt: string;
  productTypeId: number;
  size: string;
  longEdge: number;
  panels: Record<string, PanelManifest>;
};

type DetectedTriangle = {
  id: number;
  type: "upper" | "lower";
  cell: { row: number; col: number };
  centroidUV: UV;
  expectedColor: string;
  observedColor: string;
  centroidXY: XY | null;
  pixelCount: number;
  bboxXY: { x: number; y: number; width: number; height: number } | null;
  meanLabDistance: number;
  spread: number;
  confidence: number;
  rejected: boolean;
  reason?: string;
};

type Correspondence = {
  triangleId: number;
  source: { u: number; v: number; x: number; y: number };
  target: XY;
  confidence: number;
};

type SuggestedMesh = {
  rows: number;
  cols: number;
  points: Array<{ u: number; v: number; x: number; y: number; confidence: number }>;
};

type DetectionOutput = {
  panelName: string;
  manifestVersion: string;
  detectedAt: string;
  mockupSize: { width: number; height: number };
  analysisSize: { width: number; height: number };
  panelGrid: { cols: number; rows: number };
  detectedTriangles: DetectedTriangle[];
  correspondences: Correspondence[];
  suggestedMesh: SuggestedMesh;
  suggestedMask: UV[];
  stats: {
    totalTriangles: number;
    accepted: number;
    rejected: number;
    averageConfidence: number;
  };
};

function argValue(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0) return process.argv[idx + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function readMockupBuffer(input: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(input)) {
    const r = await fetch(input);
    if (!r.ok) throw new Error(`Mockup fetch failed ${r.status} for ${input}`);
    return Buffer.from(await r.arrayBuffer());
  }
  return fs.readFile(path.resolve(CWD, input));
}

function srgbToLinear(component: number): number {
  const c = component / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  // sRGB → XYZ (D65)
  const X = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047;
  const Y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175) / 1.0;
  const Z = (lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labDistance(a: [number, number, number], b: [number, number, number]): number {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "").trim();
  return [
    parseInt(m.slice(0, 2), 16),
    parseInt(m.slice(2, 4), 16),
    parseInt(m.slice(4, 6), 16),
  ];
}

function svgEscape(text: string): string {
  return text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c] as string));
}

async function loadManifest(filePath: string): Promise<Manifest> {
  const raw = await fs.readFile(filePath, "utf8");
  const json = JSON.parse(raw) as Manifest;
  if (!json?.panels) throw new Error(`Manifest missing 'panels' object: ${filePath}`);
  return json;
}

async function downsample(buffer: Buffer, longEdge: number) {
  const meta = await sharp(buffer).metadata();
  const W = meta.width || 1;
  const H = meta.height || 1;
  const longest = Math.max(W, H);
  const scale = Math.min(1, longEdge / longest);
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const { data } = await sharp(buffer)
    .resize(w, h, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: w, height: h, originalWidth: W, originalHeight: H, scale };
}

function buildSuggestedMesh(
  panel: PanelManifest,
  correspondences: Correspondence[],
): SuggestedMesh {
  const cols = panel.cols;
  const rows = panel.rows;
  const points: SuggestedMesh["points"] = [];
  if (correspondences.length === 0) {
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        points.push({ u: c / cols, v: r / rows, x: 0, y: 0, confidence: 0 });
      }
    }
    return { rows, cols, points };
  }

  const power = 2;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      const v = r / rows;
      let weightSum = 0;
      let confSum = 0;
      let xSum = 0;
      let ySum = 0;
      let nearestConfidence = 0;
      let nearestDistance = Infinity;
      for (const corr of correspondences) {
        const du = corr.source.u - u;
        const dv = corr.source.v - v;
        const dist = Math.sqrt(du * du + dv * dv);
        if (dist < nearestDistance) {
          nearestDistance = dist;
          nearestConfidence = corr.confidence;
        }
        const weight = corr.confidence / Math.pow(Math.max(dist, 1e-4), power);
        weightSum += weight;
        confSum += weight * corr.confidence;
        xSum += weight * corr.target.x;
        ySum += weight * corr.target.y;
      }
      const x = weightSum > 0 ? xSum / weightSum : 0;
      const y = weightSum > 0 ? ySum / weightSum : 0;
      const confidence = weightSum > 0
        ? clamp((confSum / weightSum) * (1 - clamp(nearestDistance, 0, 0.5) * 0.6), 0, 1)
        : 0;
      points.push({ u, v, x, y, confidence: nearestConfidence > 0 ? confidence : 0 });
    }
  }
  return { rows, cols, points };
}

function buildSuggestedMask(panel: PanelManifest, detected: DetectedTriangle[]): UV[] {
  const accepted = detected.filter((d) => !d.rejected && d.centroidXY);
  if (accepted.length < 4) {
    return [
      { u: 0, v: 0 },
      { u: 1, v: 0 },
      { u: 1, v: 1 },
      { u: 0, v: 1 },
    ];
  }
  const cols = panel.cols;
  const rows = panel.rows;
  const minCol = Math.max(0, Math.min(...accepted.map((d) => d.cell.col)) - 0.5) / cols;
  const maxCol = Math.min(cols, Math.max(...accepted.map((d) => d.cell.col)) + 1.5) / cols;
  const minRow = Math.max(0, Math.min(...accepted.map((d) => d.cell.row)) - 0.5) / rows;
  const maxRow = Math.min(rows, Math.max(...accepted.map((d) => d.cell.row)) + 1.5) / rows;
  return [
    { u: minCol, v: minRow },
    { u: maxCol, v: minRow },
    { u: maxCol, v: maxRow },
    { u: minCol, v: maxRow },
  ];
}

async function buildDebugOverlay(params: {
  mockupBuffer: Buffer;
  detection: DetectionOutput;
  panel: PanelManifest;
  outFile: string;
}) {
  const { mockupBuffer, detection, panel, outFile } = params;
  const W = detection.mockupSize.width;
  const H = detection.mockupSize.height;
  const fontTriangle = Math.max(10, Math.min(W, H) * 0.012);
  const radius = Math.max(6, Math.min(W, H) * 0.008);

  const dots: string[] = [];
  const labels: string[] = [];
  for (const tri of detection.detectedTriangles) {
    if (!tri.centroidXY) continue;
    const fill = tri.rejected
      ? "rgba(220,38,38,0.85)"
      : tri.confidence > 0.7
        ? "rgba(34,197,94,0.92)"
        : tri.confidence > 0.4
          ? "rgba(234,179,8,0.92)"
          : "rgba(249,115,22,0.92)";
    dots.push(
      `<circle cx="${tri.centroidXY.x.toFixed(1)}" cy="${tri.centroidXY.y.toFixed(1)}" r="${radius.toFixed(1)}" fill="${fill}" stroke="#0f172a" stroke-width="${(radius * 0.18).toFixed(2)}"/>`,
    );
    labels.push(
      `<text x="${tri.centroidXY.x.toFixed(1)}" y="${(tri.centroidXY.y - radius * 1.2).toFixed(1)}" text-anchor="middle" font-family="Verdana, Arial, sans-serif" font-size="${fontTriangle.toFixed(1)}" font-weight="700" fill="#f8fafc" stroke="#0f172a" stroke-width="${(fontTriangle * 0.18).toFixed(2)}" paint-order="stroke">${tri.id}</text>`,
    );
  }

  const meshLines: string[] = [];
  const cols = detection.suggestedMesh.cols;
  const rows = detection.suggestedMesh.rows;
  const meshIdx = (c: number, r: number) => r * (cols + 1) + c;
  for (let r = 0; r <= rows; r++) {
    const pts: string[] = [];
    for (let c = 0; c <= cols; c++) {
      const p = detection.suggestedMesh.points[meshIdx(c, r)];
      pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    }
    meshLines.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="rgba(56,189,248,0.6)" stroke-width="${(radius * 0.18).toFixed(2)}"/>`);
  }
  for (let c = 0; c <= cols; c++) {
    const pts: string[] = [];
    for (let r = 0; r <= rows; r++) {
      const p = detection.suggestedMesh.points[meshIdx(c, r)];
      pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    }
    meshLines.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="rgba(56,189,248,0.6)" stroke-width="${(radius * 0.18).toFixed(2)}"/>`);
  }

  const headerFont = Math.max(20, Math.min(W, H) * 0.025);
  const header = `<text x="20" y="${(headerFont * 1.2).toFixed(1)}" font-family="Verdana, Arial, sans-serif" font-size="${headerFont.toFixed(1)}" font-weight="800" fill="#f8fafc" stroke="#0f172a" stroke-width="${headerFont * 0.18}" paint-order="stroke">${svgEscape(panel.panelKey)} · ${detection.stats.accepted}/${detection.stats.totalTriangles} triangles · avg ${(detection.stats.averageConfidence * 100).toFixed(0)}%</text>`;

  const overlay = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${meshLines.join("\n    ")}
    ${dots.join("\n    ")}
    ${labels.join("\n    ")}
    ${header}
  </svg>`;

  const overlayBuffer = await sharp(Buffer.from(overlay, "utf8"), { density: 96 })
    .resize(W, H, { fit: "fill" })
    .png()
    .toBuffer();

  await sharp(mockupBuffer)
    .resize(W, H, { fit: "fill" })
    .composite([{ input: overlayBuffer }])
    .png()
    .toFile(outFile);
}

async function main() {
  if (hasFlag("help")) {
    console.log(`
Detect AOP triangle-calibration triangles in a Printify mockup.

Usage:
  npx tsx scripts/detect-aop-triangle-calibration.ts --panel back --mockup ./tmp/.../front.png

Options:
  --panel <name>             Required panel key (e.g. back, front_right).
  --mockup <path|url>        Required mockup PNG path or URL.
  --source <path>            Optional source calibration panel PNG (debug only).
  --manifest <path>          Default ${path.relative(CWD, DEFAULT_MANIFEST)}.
  --output <dir>             Default ${path.relative(CWD, DEFAULT_OUTPUT_DIR)}.
  --analysisLongEdge <px>    Downsample mockup for color search. Default ${DEFAULT_ANALYSIS_LONG_EDGE}.
  --labThreshold <num>       Lab distance threshold for accepting a pixel. Default ${DEFAULT_LAB_THRESHOLD}.
  --minPixels <num>          Min pixels per triangle to keep. Default ${DEFAULT_MIN_PIXELS}.

Outputs:
  <output>/detections/<panel>.json
  <output>/debug/<panel>-detected.png
`);
    return;
  }

  const panelName = argValue("panel");
  const mockupArg = argValue("mockup");
  if (!panelName || !mockupArg) {
    throw new Error("Both --panel and --mockup are required. Use --help for details.");
  }

  const manifestPath = argValue("manifest") || DEFAULT_MANIFEST;
  const outputDir = argValue("output") || DEFAULT_OUTPUT_DIR;
  const analysisLongEdge = Math.max(200, Number(argValue("analysisLongEdge") || DEFAULT_ANALYSIS_LONG_EDGE));
  const labThreshold = Math.max(1, Number(argValue("labThreshold") || DEFAULT_LAB_THRESHOLD));
  const minPixels = Math.max(1, Number(argValue("minPixels") || DEFAULT_MIN_PIXELS));

  const manifest = await loadManifest(manifestPath);
  const panel = manifest.panels[panelName];
  if (!panel) {
    throw new Error(`Panel '${panelName}' not in manifest. Known: ${Object.keys(manifest.panels).join(", ")}`);
  }

  const mockupBuffer = await readMockupBuffer(mockupArg);
  const sample = await downsample(mockupBuffer, analysisLongEdge);

  const triangleLabs = panel.triangles.map((tri) => rgbToLab(tri.color.rgb[0], tri.color.rgb[1], tri.color.rgb[2]));
  const buckets: Array<{
    count: number;
    sumX: number;
    sumY: number;
    sumXX: number;
    sumYY: number;
    sumLabDist: number;
    sumR: number;
    sumG: number;
    sumB: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }> = panel.triangles.map(() => ({
    count: 0,
    sumX: 0,
    sumY: 0,
    sumXX: 0,
    sumYY: 0,
    sumLabDist: 0,
    sumR: 0,
    sumG: 0,
    sumB: 0,
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  }));

  const w = sample.width;
  const h = sample.height;
  const data = sample.data;
  let pixelIdx = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = data[pixelIdx];
      const g = data[pixelIdx + 1];
      const b = data[pixelIdx + 2];
      const a = data[pixelIdx + 3];
      pixelIdx += 4;
      if (a < 16) continue;
      const lab = rgbToLab(r, g, b);
      let bestIdx = -1;
      let bestDist = labThreshold;
      for (let t = 0; t < triangleLabs.length; t++) {
        const d = labDistance(lab, triangleLabs[t]);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = t;
        }
      }
      if (bestIdx < 0) continue;
      const bucket = buckets[bestIdx];
      bucket.count += 1;
      bucket.sumX += x;
      bucket.sumY += y;
      bucket.sumXX += x * x;
      bucket.sumYY += y * y;
      bucket.sumLabDist += bestDist;
      bucket.sumR += r;
      bucket.sumG += g;
      bucket.sumB += b;
      if (x < bucket.minX) bucket.minX = x;
      if (y < bucket.minY) bucket.minY = y;
      if (x > bucket.maxX) bucket.maxX = x;
      if (y > bucket.maxY) bucket.maxY = y;
    }
  }

  const acceptedExpectedPixels = (w * h) / panel.triangleCount;
  const detectedTriangles: DetectedTriangle[] = panel.triangles.map((tri, idx) => {
    const bucket = buckets[idx];
    if (bucket.count < minPixels) {
      return {
        id: tri.id,
        type: tri.type,
        cell: tri.cell,
        centroidUV: tri.centroidUV,
        expectedColor: tri.color.hex,
        observedColor: "",
        centroidXY: null,
        pixelCount: bucket.count,
        bboxXY: null,
        meanLabDistance: 0,
        spread: 0,
        confidence: 0,
        rejected: true,
        reason: bucket.count === 0 ? "no_match" : "below_min_pixels",
      };
    }

    const meanX = bucket.sumX / bucket.count;
    const meanY = bucket.sumY / bucket.count;
    const varX = bucket.sumXX / bucket.count - meanX * meanX;
    const varY = bucket.sumYY / bucket.count - meanY * meanY;
    const spread = Math.sqrt(Math.max(0, varX) + Math.max(0, varY));
    const meanLab = bucket.sumLabDist / bucket.count;
    const observedRgb: [number, number, number] = [
      Math.round(bucket.sumR / bucket.count),
      Math.round(bucket.sumG / bucket.count),
      Math.round(bucket.sumB / bucket.count),
    ];
    const observedHex = `#${observedRgb.map((n) => n.toString(16).padStart(2, "0")).join("")}`;

    const targetSpread = Math.sqrt(acceptedExpectedPixels) * 0.6;
    const tightness = clamp(targetSpread / Math.max(targetSpread, spread + 1), 0, 1);
    const labQuality = clamp(1 - meanLab / labThreshold, 0, 1);
    const sizeFactor = clamp(bucket.count / Math.max(minPixels, acceptedExpectedPixels * 0.25), 0, 1);
    const confidence = clamp(0.55 * labQuality + 0.25 * tightness + 0.2 * sizeFactor, 0, 1);

    const upscaleX = sample.originalWidth / sample.width;
    const upscaleY = sample.originalHeight / sample.height;
    const centroidXY: XY = {
      x: meanX * upscaleX,
      y: meanY * upscaleY,
    };
    const bboxXY = {
      x: bucket.minX * upscaleX,
      y: bucket.minY * upscaleY,
      width: Math.max(0, bucket.maxX - bucket.minX) * upscaleX,
      height: Math.max(0, bucket.maxY - bucket.minY) * upscaleY,
    };

    return {
      id: tri.id,
      type: tri.type,
      cell: tri.cell,
      centroidUV: tri.centroidUV,
      expectedColor: tri.color.hex,
      observedColor: observedHex,
      centroidXY,
      pixelCount: bucket.count,
      bboxXY,
      meanLabDistance: meanLab,
      spread,
      confidence,
      rejected: false,
    };
  });

  const accepted = detectedTriangles.filter((t) => !t.rejected && t.centroidXY);
  const correspondences: Correspondence[] = accepted.map((t) => ({
    triangleId: t.id,
    source: {
      u: t.centroidUV.u,
      v: t.centroidUV.v,
      x: t.centroidUV.u * panel.renderSize.width,
      y: t.centroidUV.v * panel.renderSize.height,
    },
    target: t.centroidXY!,
    confidence: t.confidence,
  }));

  const suggestedMesh = buildSuggestedMesh(panel, correspondences);
  const suggestedMask = buildSuggestedMask(panel, detectedTriangles);
  const totalConfidence = accepted.reduce((acc, t) => acc + t.confidence, 0);

  const detection: DetectionOutput = {
    panelName,
    manifestVersion: manifest.version,
    detectedAt: new Date().toISOString(),
    mockupSize: { width: sample.originalWidth, height: sample.originalHeight },
    analysisSize: { width: sample.width, height: sample.height },
    panelGrid: { cols: panel.cols, rows: panel.rows },
    detectedTriangles,
    correspondences,
    suggestedMesh,
    suggestedMask,
    stats: {
      totalTriangles: panel.triangles.length,
      accepted: accepted.length,
      rejected: detectedTriangles.length - accepted.length,
      averageConfidence: accepted.length > 0 ? totalConfidence / accepted.length : 0,
    },
  };

  const detectionsDir = path.join(outputDir, "detections");
  const debugDir = path.join(outputDir, "debug");
  await fs.mkdir(detectionsDir, { recursive: true });
  await fs.mkdir(debugDir, { recursive: true });
  const detectionFile = path.join(detectionsDir, `${panelName}.json`);
  const debugFile = path.join(debugDir, `${panelName}-detected.png`);
  await fs.writeFile(detectionFile, JSON.stringify(detection, null, 2), "utf8");
  await buildDebugOverlay({ mockupBuffer, detection, panel, outFile: debugFile });

  console.log(
    JSON.stringify(
      {
        panelName,
        detectionFile: path.relative(CWD, detectionFile),
        debugFile: path.relative(CWD, debugFile),
        accepted: detection.stats.accepted,
        rejected: detection.stats.rejected,
        averageConfidence: Number(detection.stats.averageConfidence.toFixed(3)),
        analysisSize: detection.analysisSize,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("[detect-aop-triangle-calibration] Failed:", err);
  process.exit(1);
});
