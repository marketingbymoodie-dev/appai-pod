import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ANALYSIS_LONG_EDGE,
  DEFAULT_LAB_THRESHOLD,
  DEFAULT_MIN_PIXELS,
  type DetectionOutput,
  loadManifest,
  readImageBuffer,
  runTriangleDetection,
} from "./lib/aop-triangle-pipeline";
import {
  buildPanelCalibration,
  renderCalibrationDebug,
  renderReconstruction,
} from "./lib/aop-panel-calibrate";

/**
 * AOP per-panel calibration ingestion CLI.
 *
 * Given an original flat triangle calibration panel PNG and a Printify mockup
 * built from it, produce the reusable calibration data needed to warp any
 * future customer artwork into the same mockup shape:
 *
 *   tmp/aop-triangle-calibration/calibrations/<panel>.json
 *   tmp/aop-triangle-calibration/reconstructions/<panel>.png
 *   tmp/aop-triangle-calibration/debug/<panel>-calibration-debug.png
 *
 * Workflow:
 *   1. Run (or import) the triangle detector against the Printify mockup.
 *   2. Match every detected triangle id against the manifest.
 *   3. Solve a piecewise-affine mesh by confidence-weighted Gauss-Seidel:
 *      every detected triangle's centroid pins the average of its 3 vertices
 *      to the measured XY in the mockup.
 *   4. Trace the outer boundary of detected cells for the mask polygon.
 *   5. Warp the source panel through the saved triangle mappings to produce
 *      a reconstruction preview, then composite a debug PNG that overlays the
 *      reconstruction onto the Printify mockup with diagnostics.
 *
 * Example:
 *   npm run aop:panel:calibrate -- --panel back --mockup tmp/.../back.png
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

function printHelp() {
  console.log(`
Build AOP per-panel calibration JSON + reconstruction + debug overlay.

Usage:
  npm run aop:panel:calibrate -- --panel back --mockup tmp/aop-triangle-calibration/mockups/back.png

Options:
  --panel <name>             Required panel key from the manifest (e.g. back, front_right).
  --mockup <path|url>        Required Printify mockup PNG path or URL.
  --source <path>            Source flat panel PNG. Default tmp/.../panels/<panel>.png.
  --manifest <path>          Default ${path.relative(CWD, DEFAULT_MANIFEST)}.
  --output <dir>             Default ${path.relative(CWD, DEFAULT_OUTPUT_DIR)}.
  --detection <path>         Reuse an existing detection JSON instead of running detection.
  --analysisLongEdge <px>    Downsample mockup for color search. Default ${DEFAULT_ANALYSIS_LONG_EDGE}.
  --labThreshold <num>       Lab distance threshold for accepting a pixel. Default ${DEFAULT_LAB_THRESHOLD}.
  --minPixels <num>          Min pixels per triangle to keep. Default ${DEFAULT_MIN_PIXELS}.
  --skipDetectionWrite       Skip writing detections/<panel>.json.
  --skipReconstruction       Skip writing reconstructions/<panel>.png.
  --skipDebug                Skip writing debug/<panel>-calibration-debug.png.
  --help                     Print this help.

Outputs:
  <output>/calibrations/<panel>.json
  <output>/reconstructions/<panel>.png
  <output>/debug/<panel>-calibration-debug.png
  <output>/detections/<panel>.json (if detection ran)
`);
}

async function main() {
  if (hasFlag("help")) {
    printHelp();
    return;
  }

  const panelName = argValue("panel");
  const mockupArg = argValue("mockup");
  if (!panelName || !mockupArg) {
    throw new Error("Both --panel and --mockup are required. Use --help for details.");
  }

  const manifestPath = argValue("manifest") || DEFAULT_MANIFEST;
  const outputDir = argValue("output") || DEFAULT_OUTPUT_DIR;
  const sourceArg = argValue("source") || path.join(outputDir, "panels", `${panelName}.png`);
  const detectionArg = argValue("detection");
  const analysisLongEdge = Math.max(200, Number(argValue("analysisLongEdge") || DEFAULT_ANALYSIS_LONG_EDGE));
  const labThreshold = Math.max(1, Number(argValue("labThreshold") || DEFAULT_LAB_THRESHOLD));
  const minPixels = Math.max(1, Number(argValue("minPixels") || DEFAULT_MIN_PIXELS));
  const skipDetectionWrite = hasFlag("skipDetectionWrite");
  const skipReconstruction = hasFlag("skipReconstruction");
  const skipDebug = hasFlag("skipDebug");

  const manifest = await loadManifest(manifestPath);
  const panel = manifest.panels[panelName];
  if (!panel) {
    throw new Error(`Panel '${panelName}' not in manifest. Known: ${Object.keys(manifest.panels).join(", ")}`);
  }

  const mockupBuffer = await readImageBuffer(mockupArg);

  let detection: DetectionOutput;
  let detectionWritten = false;
  if (detectionArg) {
    const raw = await fs.readFile(path.resolve(CWD, detectionArg), "utf8");
    detection = JSON.parse(raw) as DetectionOutput;
    if (detection.panelName !== panelName) {
      throw new Error(
        `Detection file ${detectionArg} is for panel '${detection.panelName}' (expected '${panelName}').`,
      );
    }
  } else {
    detection = await runTriangleDetection(panelName, panel, manifest.version, mockupBuffer, {
      analysisLongEdge,
      labThreshold,
      minPixels,
    });
    if (!skipDetectionWrite) {
      const detectionsDir = path.join(outputDir, "detections");
      await fs.mkdir(detectionsDir, { recursive: true });
      const detectionFile = path.join(detectionsDir, `${panelName}.json`);
      await fs.writeFile(detectionFile, JSON.stringify(detection, null, 2), "utf8");
      detectionWritten = true;
    }
  }

  const sourcePath = path.resolve(CWD, sourceArg);
  let sourceBuffer: Buffer;
  try {
    sourceBuffer = await fs.readFile(sourcePath);
  } catch (err) {
    throw new Error(
      `Source panel PNG not found at ${sourcePath}. Pass --source <path> or run aop:triangle:generate first. (${(err as Error).message})`,
    );
  }

  const calibration = buildPanelCalibration(panel, detection);

  const calibrationsDir = path.join(outputDir, "calibrations");
  const reconstructionsDir = path.join(outputDir, "reconstructions");
  const debugDir = path.join(outputDir, "debug");
  await fs.mkdir(calibrationsDir, { recursive: true });
  await fs.mkdir(reconstructionsDir, { recursive: true });
  await fs.mkdir(debugDir, { recursive: true });

  const calibrationFile = path.join(calibrationsDir, `${panelName}.json`);
  const reconstructionFile = path.join(reconstructionsDir, `${panelName}.png`);
  const debugFile = path.join(debugDir, `${panelName}-calibration-debug.png`);

  await fs.writeFile(calibrationFile, JSON.stringify(calibration, null, 2), "utf8");

  let reconstructionBuffer: Buffer | null = null;
  if (!skipReconstruction || !skipDebug) {
    reconstructionBuffer = await renderReconstruction(sourceBuffer, calibration);
    if (!skipReconstruction) {
      await fs.writeFile(reconstructionFile, reconstructionBuffer);
    }
  }

  if (!skipDebug && reconstructionBuffer) {
    const debugBuffer = await renderCalibrationDebug({
      mockupBuffer,
      reconstructionBuffer,
      calibration,
    });
    await fs.writeFile(debugFile, debugBuffer);
  }

  const summary: Record<string, unknown> = {
    panelName,
    calibrationFile: path.relative(CWD, calibrationFile),
    triangles: calibration.triangles.length,
    coveragePercent: calibration.quality.coveragePercent,
    avgConfidence: Number(calibration.quality.avgConfidence.toFixed(3)),
    meanCentroidErrorPx: calibration.quality.meanCentroidErrorPx,
    maxCentroidErrorPx: calibration.quality.maxCentroidErrorPx,
    missingTriangleIds: calibration.quality.missingTriangleIds.length,
    lowConfidenceTriangleIds: calibration.quality.lowConfidenceTriangleIds.length,
    meshUnconstrainedVertexCount: calibration.quality.meshUnconstrainedVertexCount,
    maskVertices: calibration.mask.polygon.length,
  };
  if (!skipReconstruction) summary.reconstructionFile = path.relative(CWD, reconstructionFile);
  if (!skipDebug) summary.debugFile = path.relative(CWD, debugFile);
  if (detectionWritten) summary.detectionFile = path.relative(CWD, path.join(outputDir, "detections", `${panelName}.json`));

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("[build-aop-panel-calibration] Failed:", err);
  process.exit(1);
});
