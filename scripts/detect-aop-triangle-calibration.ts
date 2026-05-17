import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  DEFAULT_ANALYSIS_LONG_EDGE,
  DEFAULT_LAB_THRESHOLD,
  DEFAULT_MIN_PIXELS,
  type DetectionOutput,
  type PanelManifest,
  loadManifest,
  readImageBuffer,
  runTriangleDetection,
} from "./lib/aop-triangle-pipeline";

/**
 * AOP triangle calibration detector (CLI wrapper around the shared pipeline).
 *
 * Given a Printify mockup PNG that has a triangle-calibration panel printed
 * on it, find each known triangle by its target color and emit a JSON
 * description of the detected pixel clusters, plus a suggested calibration
 * mesh / mask the AOP Calibration Mapper can import as an initial guess.
 *
 * Inputs:
 *   --panel <name>           panel key from the manifest (e.g. back, front_right)
 *   --mockup <path|url>      Printify mockup PNG (required)
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

function svgEscape(text: string): string {
  return text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c] as string));
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

  const mockupBuffer = await readImageBuffer(mockupArg);
  const detection = await runTriangleDetection(panelName, panel, manifest.version, mockupBuffer, {
    analysisLongEdge,
    labThreshold,
    minPixels,
  });

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
