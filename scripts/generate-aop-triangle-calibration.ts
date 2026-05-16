import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/**
 * AOP triangle calibration texture generator (Milestone 1).
 *
 * For each known AOP panel (12 panels for product 20 / zip-hoodie-aop) we
 * emit a high-contrast PNG covered by a triangulated grid where:
 *   - every triangle has a unique high-saturation color
 *   - every triangle is labelled with its ID
 *   - the four corners are tagged with distinctive markers (TL/TR/BL/BR)
 *   - the four edges are labelled TOP / BOTTOM / LEFT / RIGHT
 *   - UV anchors (0,0) / (1,0) / (1,1) / (0,1) are printed near the corners
 *
 * Alongside the PNGs we emit `manifest.json` describing every triangle in
 * source-UV space plus its color so a downstream computer-vision detector
 * can map detected pixel clusters back to a known UV anchor.
 *
 * Outputs:
 *   tmp/aop-triangle-calibration/panels/*.png
 *   tmp/aop-triangle-calibration/manifest.json
 */

const CWD = process.cwd();
const OUTPUT_DIR = path.join(CWD, "tmp", "aop-triangle-calibration");
const PANELS_DIR = path.join(OUTPUT_DIR, "panels");
const MANIFEST_FILE = path.join(OUTPUT_DIR, "manifest.json");
const DEFAULT_PRODUCT_TYPE_ID = 20;
const DEFAULT_SIZE = "L";
const DEFAULT_LONG_EDGE = 1024;
const MAPPING_FILE = path.join(CWD, "tmp", `printify-mapping-product-${DEFAULT_PRODUCT_TYPE_ID}.json`);

type Placeholder = { position: string; width: number; height: number };

type TriangleManifestEntry = {
  id: number;
  panelKey: string;
  cell: { row: number; col: number };
  type: "upper" | "lower";
  uv: [
    { u: number; v: number },
    { u: number; v: number },
    { u: number; v: number },
  ];
  centroidUV: { u: number; v: number };
  color: {
    hex: string;
    rgb: [number, number, number];
    hsl: [number, number, number];
  };
};

type PanelManifest = {
  panelKey: string;
  sourceSize: { width: number; height: number };
  renderSize: { width: number; height: number };
  cols: number;
  rows: number;
  triangleCount: number;
  cornerColors: { tl: string; tr: string; bl: string; br: string };
  triangles: TriangleManifestEntry[];
};

type Manifest = {
  version: "aop-triangle-calibration/v1";
  generatedAt: string;
  productTypeId: number;
  size: string;
  longEdge: number;
  panels: Record<string, PanelManifest>;
};

const KNOWN_PANELS = [
  "front_right",
  "front_left",
  "back",
  "right_sleeve",
  "left_sleeve",
  "right_hood",
  "left_hood",
  "pocket_right",
  "pocket_left",
  "right_cuff_panel",
  "left_cuff_panel",
  "waistband",
];

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

/** Spread cells across an aspect-aware target so triangles stay roughly square. */
function gridForAspect(width: number, height: number): { cols: number; rows: number } {
  const aspect = width / Math.max(1, height);
  const targetCells = 36;
  const cols = clamp(Math.round(Math.sqrt(targetCells * aspect)), 3, 24);
  const rows = clamp(Math.round(targetCells / cols), 3, 24);
  return { cols, rows };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100;
  const lit = l / 100;
  const c = (1 - Math.abs(2 * lit - 1)) * sat;
  const hh = (h % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = lit - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Pick a high-saturation hue for triangle `id` using golden-angle spread. */
function triangleColor(id: number, type: "upper" | "lower"): { hex: string; rgb: [number, number, number]; hsl: [number, number, number] } {
  const hue = (id * 137.508) % 360;
  const sat = 78;
  const lit = type === "upper" ? 56 : 46;
  const rgb = hslToRgb(hue, sat, lit);
  return { hex: rgbToHex(rgb), rgb, hsl: [Math.round(hue), sat, lit] };
}

const CORNER_COLORS = {
  tl: "#ff0000",
  tr: "#00ff00",
  bl: "#ffff00",
  br: "#00aaff",
};

function escXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c] as string));
}

function svgPolygon(p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, fill: string): string {
  return `<polygon points="${p1.x.toFixed(2)},${p1.y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)} ${p3.x.toFixed(2)},${p3.y.toFixed(2)}" fill="${fill}" stroke="#0f172a" stroke-width="0.6" shape-rendering="geometricPrecision"/>`;
}

type SvgBuildResult = {
  svg: string;
  triangles: TriangleManifestEntry[];
  cols: number;
  rows: number;
  width: number;
  height: number;
};

function buildPanelSvg(panelKey: string, width: number, height: number): SvgBuildResult {
  const { cols, rows } = gridForAspect(width, height);
  const cellW = width / cols;
  const cellH = height / rows;
  const triangles: TriangleManifestEntry[] = [];
  const polygons: string[] = [];
  const labels: string[] = [];

  let id = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u0 = c / cols;
      const u1 = (c + 1) / cols;
      const v0 = r / rows;
      const v1 = (r + 1) / rows;
      const tlPx = { x: c * cellW, y: r * cellH };
      const trPx = { x: (c + 1) * cellW, y: r * cellH };
      const blPx = { x: c * cellW, y: (r + 1) * cellH };
      const brPx = { x: (c + 1) * cellW, y: (r + 1) * cellH };

      const upperColor = triangleColor(id, "upper");
      const upperEntry: TriangleManifestEntry = {
        id,
        panelKey,
        cell: { row: r, col: c },
        type: "upper",
        uv: [
          { u: u0, v: v0 },
          { u: u1, v: v0 },
          { u: u1, v: v1 },
        ],
        centroidUV: { u: (u0 + u1 + u1) / 3, v: (v0 + v0 + v1) / 3 },
        color: upperColor,
      };
      triangles.push(upperEntry);
      polygons.push(svgPolygon(tlPx, trPx, brPx, upperColor.hex));
      const upperCx = (tlPx.x + trPx.x + brPx.x) / 3;
      const upperCy = (tlPx.y + trPx.y + brPx.y) / 3;
      const fontSize = Math.max(8, Math.min(cellW, cellH) * 0.18);
      labels.push(
        `<text x="${upperCx.toFixed(1)}" y="${(upperCy + fontSize * 0.35).toFixed(1)}" text-anchor="middle" font-family="Verdana, Arial, sans-serif" font-size="${fontSize.toFixed(1)}" font-weight="700" fill="#0f172a" stroke="#ffffff" stroke-width="${(fontSize * 0.08).toFixed(2)}" paint-order="stroke" pointer-events="none">${id}</text>`,
      );
      id += 1;

      const lowerColor = triangleColor(id, "lower");
      const lowerEntry: TriangleManifestEntry = {
        id,
        panelKey,
        cell: { row: r, col: c },
        type: "lower",
        uv: [
          { u: u0, v: v0 },
          { u: u1, v: v1 },
          { u: u0, v: v1 },
        ],
        centroidUV: { u: (u0 + u1 + u0) / 3, v: (v0 + v1 + v1) / 3 },
        color: lowerColor,
      };
      triangles.push(lowerEntry);
      polygons.push(svgPolygon(tlPx, brPx, blPx, lowerColor.hex));
      const lowerCx = (tlPx.x + brPx.x + blPx.x) / 3;
      const lowerCy = (tlPx.y + brPx.y + blPx.y) / 3;
      labels.push(
        `<text x="${lowerCx.toFixed(1)}" y="${(lowerCy + fontSize * 0.35).toFixed(1)}" text-anchor="middle" font-family="Verdana, Arial, sans-serif" font-size="${fontSize.toFixed(1)}" font-weight="700" fill="#0f172a" stroke="#ffffff" stroke-width="${(fontSize * 0.08).toFixed(2)}" paint-order="stroke" pointer-events="none">${id}</text>`,
      );
      id += 1;
    }
  }

  const cornerR = Math.max(8, Math.min(width, height) * 0.025);
  const corners = `
    <circle cx="${cornerR.toFixed(1)}" cy="${cornerR.toFixed(1)}" r="${cornerR.toFixed(1)}" fill="${CORNER_COLORS.tl}" stroke="#0f172a" stroke-width="2"/>
    <circle cx="${(width - cornerR).toFixed(1)}" cy="${cornerR.toFixed(1)}" r="${cornerR.toFixed(1)}" fill="${CORNER_COLORS.tr}" stroke="#0f172a" stroke-width="2"/>
    <circle cx="${cornerR.toFixed(1)}" cy="${(height - cornerR).toFixed(1)}" r="${cornerR.toFixed(1)}" fill="${CORNER_COLORS.bl}" stroke="#0f172a" stroke-width="2"/>
    <circle cx="${(width - cornerR).toFixed(1)}" cy="${(height - cornerR).toFixed(1)}" r="${cornerR.toFixed(1)}" fill="${CORNER_COLORS.br}" stroke="#0f172a" stroke-width="2"/>
  `;

  const labelFont = Math.max(14, Math.min(width, height) * 0.04);
  const edgeLabels = `
    <text x="${(width / 2).toFixed(1)}" y="${(labelFont * 1.2).toFixed(1)}" text-anchor="middle" font-family="Verdana, Arial, sans-serif" font-size="${labelFont}" font-weight="800" fill="#0f172a" stroke="#ffffff" stroke-width="${labelFont * 0.18}" paint-order="stroke">TOP</text>
    <text x="${(width / 2).toFixed(1)}" y="${(height - labelFont * 0.3).toFixed(1)}" text-anchor="middle" font-family="Verdana, Arial, sans-serif" font-size="${labelFont}" font-weight="800" fill="#0f172a" stroke="#ffffff" stroke-width="${labelFont * 0.18}" paint-order="stroke">BOTTOM</text>
    <g transform="translate(${(labelFont * 0.5).toFixed(1)} ${(height / 2).toFixed(1)}) rotate(-90)">
      <text text-anchor="middle" font-family="Verdana, Arial, sans-serif" font-size="${labelFont}" font-weight="800" fill="#0f172a" stroke="#ffffff" stroke-width="${labelFont * 0.18}" paint-order="stroke">LEFT</text>
    </g>
    <g transform="translate(${(width - labelFont * 0.5).toFixed(1)} ${(height / 2).toFixed(1)}) rotate(90)">
      <text text-anchor="middle" font-family="Verdana, Arial, sans-serif" font-size="${labelFont}" font-weight="800" fill="#0f172a" stroke="#ffffff" stroke-width="${labelFont * 0.18}" paint-order="stroke">RIGHT</text>
    </g>
  `;

  const uvFont = Math.max(11, Math.min(width, height) * 0.022);
  const uvAnchorOffset = cornerR * 2.4;
  const uvAnchors = `
    <text x="${uvAnchorOffset.toFixed(1)}" y="${(uvAnchorOffset + uvFont).toFixed(1)}" font-family="Verdana, Arial, sans-serif" font-size="${uvFont}" font-weight="700" fill="#0f172a" stroke="#ffffff" stroke-width="${uvFont * 0.18}" paint-order="stroke">u=0,v=0</text>
    <text x="${(width - uvAnchorOffset).toFixed(1)}" y="${(uvAnchorOffset + uvFont).toFixed(1)}" text-anchor="end" font-family="Verdana, Arial, sans-serif" font-size="${uvFont}" font-weight="700" fill="#0f172a" stroke="#ffffff" stroke-width="${uvFont * 0.18}" paint-order="stroke">u=1,v=0</text>
    <text x="${uvAnchorOffset.toFixed(1)}" y="${(height - uvAnchorOffset).toFixed(1)}" font-family="Verdana, Arial, sans-serif" font-size="${uvFont}" font-weight="700" fill="#0f172a" stroke="#ffffff" stroke-width="${uvFont * 0.18}" paint-order="stroke">u=0,v=1</text>
    <text x="${(width - uvAnchorOffset).toFixed(1)}" y="${(height - uvAnchorOffset).toFixed(1)}" text-anchor="end" font-family="Verdana, Arial, sans-serif" font-size="${uvFont}" font-weight="700" fill="#0f172a" stroke="#ffffff" stroke-width="${uvFont * 0.18}" paint-order="stroke">u=1,v=1</text>
  `;

  const titleFont = Math.max(16, Math.min(width, height) * 0.045);
  const titleY = uvAnchorOffset * 1.1 + titleFont * 1.4;
  const title = `<text x="${(width / 2).toFixed(1)}" y="${titleY.toFixed(1)}" text-anchor="middle" font-family="Verdana, Arial, sans-serif" font-size="${titleFont}" font-weight="800" fill="#0f172a" stroke="#ffffff" stroke-width="${titleFont * 0.16}" paint-order="stroke">${escXml(panelKey)} · ${cols}×${rows}</text>`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n  <rect width="${width}" height="${height}" fill="#ffffff"/>\n  ${polygons.join("\n  ")}\n  ${labels.join("\n  ")}\n  ${corners}\n  ${edgeLabels}\n  ${uvAnchors}\n  ${title}\n</svg>`;

  return { svg, triangles, cols, rows, width, height };
}

async function loadPlaceholders(filePath: string, size: string): Promise<Placeholder[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const json: any = JSON.parse(raw);
  const target = (size || "").toUpperCase();
  if (target && Array.isArray(json?.variants)) {
    const variant = json.variants.find((v: any) => String(v?.title || v?.options?.size || "").toUpperCase() === target);
    if (variant && Array.isArray(variant.placeholders) && variant.placeholders.length > 0) {
      return variant.placeholders.map((p: any) => ({
        position: String(p.position),
        width: Number(p.width),
        height: Number(p.height),
      }));
    }
  }
  const stored = json?.productType?.storedFields?.placeholderPositions;
  if (Array.isArray(stored) && stored.length > 0) {
    return stored.map((p: any) => ({
      position: String(p.position),
      width: Number(p.width),
      height: Number(p.height),
    }));
  }
  throw new Error(`No placeholder positions found in ${filePath}.`);
}

function fallbackPlaceholders(): Placeholder[] {
  return [
    { position: "front_right", width: 2064, height: 4071 },
    { position: "front_left", width: 2064, height: 4071 },
    { position: "back", width: 4005, height: 4205 },
    { position: "right_sleeve", width: 3539, height: 3462 },
    { position: "left_sleeve", width: 3539, height: 3462 },
    { position: "right_hood", width: 1884, height: 2448 },
    { position: "left_hood", width: 1884, height: 2448 },
    { position: "pocket_right", width: 1375, height: 1430 },
    { position: "pocket_left", width: 1375, height: 1430 },
    { position: "right_cuff_panel", width: 1575, height: 900 },
    { position: "left_cuff_panel", width: 1575, height: 900 },
    { position: "waistband", width: 7050, height: 900 },
  ];
}

function scaleToLongEdge(width: number, height: number, longEdge: number): { width: number; height: number; scale: number } {
  const longest = Math.max(width, height);
  const scale = Math.min(1, longEdge / longest);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

function printHelp() {
  console.log(`
Generate AOP triangle-calibration textures and manifest for milestones 1-2.

Usage:
  npx tsx scripts/generate-aop-triangle-calibration.ts [--longEdge 1024] [--size L] [--mappingPath path]

Options:
  --longEdge <px>          Cap each panel's long edge before rasterizing. Default ${DEFAULT_LONG_EDGE}.
  --size <variantSize>     Variant size key for placeholder lookup. Default ${DEFAULT_SIZE}.
  --mappingPath <path>     Override the printify-mapping JSON. Default ${path.relative(CWD, MAPPING_FILE)}.
  --productTypeId <id>     Override the product type id (used only for tagging). Default ${DEFAULT_PRODUCT_TYPE_ID}.
  --help                   Show this help.

Outputs:
  ${path.relative(CWD, PANELS_DIR)}/<panel>.png
  ${path.relative(CWD, MANIFEST_FILE)}
`);
}

async function main() {
  if (hasFlag("help")) {
    printHelp();
    return;
  }

  const longEdge = Number(argValue("longEdge") || DEFAULT_LONG_EDGE);
  const size = argValue("size") || DEFAULT_SIZE;
  const productTypeId = Number(argValue("productTypeId") || DEFAULT_PRODUCT_TYPE_ID);
  const mappingPath = argValue("mappingPath") || MAPPING_FILE;

  let placeholders: Placeholder[];
  try {
    placeholders = await loadPlaceholders(mappingPath, size);
  } catch (err) {
    console.warn(`[generate-aop-triangle-calibration] mapping load failed (${(err as Error).message}). Falling back to default zip-hoodie L sizes.`);
    placeholders = fallbackPlaceholders();
  }

  const wantedSet = new Set(KNOWN_PANELS);
  const filtered = placeholders.filter((ph) => wantedSet.has(ph.position));
  if (filtered.length === 0) {
    throw new Error(`No known AOP panels matched in ${mappingPath}.`);
  }

  await fs.mkdir(PANELS_DIR, { recursive: true });

  const manifest: Manifest = {
    version: "aop-triangle-calibration/v1",
    generatedAt: new Date().toISOString(),
    productTypeId,
    size,
    longEdge,
    panels: {},
  };

  for (const ph of filtered) {
    const sourceSize = { width: ph.width, height: ph.height };
    const renderSize = scaleToLongEdge(ph.width, ph.height, longEdge);
    const { svg, triangles, cols, rows } = buildPanelSvg(ph.position, renderSize.width, renderSize.height);

    const buffer = await sharp(Buffer.from(svg, "utf8"), { density: 96 })
      .resize(renderSize.width, renderSize.height, { fit: "fill" })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const outFile = path.join(PANELS_DIR, `${ph.position}.png`);
    await fs.writeFile(outFile, buffer);

    manifest.panels[ph.position] = {
      panelKey: ph.position,
      sourceSize,
      renderSize: { width: renderSize.width, height: renderSize.height },
      cols,
      rows,
      triangleCount: triangles.length,
      cornerColors: { ...CORNER_COLORS },
      triangles,
    };

    console.log(
      `[generate-aop-triangle-calibration] ${ph.position} → ${path.relative(CWD, outFile)} (${renderSize.width}×${renderSize.height}, ${cols}×${rows} cells, ${triangles.length} triangles)`,
    );
  }

  await fs.writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        manifest: path.relative(CWD, MANIFEST_FILE),
        panelsDir: path.relative(CWD, PANELS_DIR),
        panelCount: Object.keys(manifest.panels).length,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("[generate-aop-triangle-calibration] Failed:", err);
  process.exit(1);
});
