#!/usr/bin/env node
/**
 * import-aop-masks.js — Bulk AOP panel mask importer
 *
 * Converts pre-exported SVG/PNG panel mask files into the correct directory
 * structure for the /api/storefront/aop-mask endpoint.
 *
 * Usage:
 *   node scripts/import-aop-masks.js --blueprintId 256 --src ./my-masks-dir
 *
 *   Where ./my-masks-dir contains files named after panel positions:
 *     left_leg.svg, right_leg.svg, front_waistband.svg, back_waistband.svg
 *
 * Options:
 *   --blueprintId <id>   Printify blueprint ID (required)
 *   --src <dir>          Source directory containing SVG/PNG files (required)
 *   --out <dir>          Output base directory (default: client/public/aop-masks)
 *   --map <json>         JSON object mapping source filenames to position names
 *                        e.g. '{"Right leg.svg":"right_leg","Left leg.svg":"left_leg"}'
 *   --dry-run            Log what would be written without writing
 *
 * After running, rebuild and deploy:
 *   npm run build
 *   git add client/public/aop-masks/
 *   git commit -m "Add panel masks for blueprint <id>"
 *
 * HOW TO CREATE SVG MASKS FROM PRINTIFY TEMPLATES
 * ------------------------------------------------
 * 1. Download the Printify template ZIP from the editor (Design → Download Template).
 * 2. Open the .psd or .ai file in your design tool.
 * 3. For each panel (e.g. "Right leg", "Left leg"):
 *    a. Isolate the panel's outer boundary path (the bleed/print area outline).
 *    b. Fill it solid white (#ffffff) — NO stroke.
 *    c. Set the SVG viewBox to the panel's actual width:height ratio
 *       (e.g. for blueprint 256: 500 × 795, matching template ratio 7970:12666).
 *    d. Export as SVG (no clip-paths, no images — just the filled path).
 *       Name the file after the position: left_leg.svg, right_leg.svg, etc.
 * 4. Run this script with --src pointing to the directory of exported SVGs.
 *
 * POSITION NAMES (common)
 * -----------------------
 *   leg panels:   left_leg, right_leg
 *   waistbands:   front_waistband, back_waistband
 *   torso panels: front, back, left_sleeve, right_sleeve
 *   other:        left_hood, right_hood, waistband, pocket_left, etc.
 *   aliases:      left_side = left_leg, right_side = right_leg
 */

const fs   = require("fs");
const path = require("path");

// ── Argument parsing ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}
const blueprintId = getArg("--blueprintId");
const srcDir      = getArg("--src");
const outBase     = getArg("--out") || path.join(__dirname, "../client/public/aop-masks");
const mapJson     = getArg("--map");
const dryRun      = args.includes("--dry-run");

if (!blueprintId || !/^\d+$/.test(blueprintId)) {
  console.error("Error: --blueprintId is required and must be a number");
  process.exit(1);
}
if (!srcDir || !fs.existsSync(srcDir)) {
  console.error("Error: --src <directory> is required and must exist");
  process.exit(1);
}

/** Map from source filename (without ext) → position name.
 *  E.g. { "Right leg": "right_leg", "Left leg": "left_leg" } */
const filenameMap = mapJson ? JSON.parse(mapJson) : {};

// ── Process ──────────────────────────────────────────────────────────────────
const outDir = path.join(outBase, blueprintId);
if (!dryRun) fs.mkdirSync(outDir, { recursive: true });

const entries = fs.readdirSync(srcDir).filter(f => {
  const ext = path.extname(f).toLowerCase();
  return ext === ".svg" || ext === ".png";
});

if (entries.length === 0) {
  console.error(`No .svg or .png files found in ${srcDir}`);
  process.exit(1);
}

const written = [];
const skipped = [];

for (const filename of entries) {
  const ext  = path.extname(filename).toLowerCase();
  const stem = filename.slice(0, -ext.length);

  // Determine the position name
  const position =
    filenameMap[filename] ||
    filenameMap[stem]     ||
    (/^[a-z0-9_]+$/.test(stem) ? stem : null);

  if (!position) {
    console.warn(`  SKIP  ${filename} — cannot map to a position name (use --map to specify)`);
    skipped.push(filename);
    continue;
  }

  const src  = path.join(srcDir, filename);
  const dest = path.join(outDir, `${position}${ext}`);

  if (dryRun) {
    console.log(`  DRY   ${src} → ${dest}`);
  } else {
    fs.copyFileSync(src, dest);
    console.log(`  OK    ${filename} → ${dest}`);
  }
  written.push(position);
}

console.log(`\nDone. ${written.length} masks written to ${outDir}`);
if (skipped.length > 0) {
  console.log(`${skipped.length} files skipped: ${skipped.join(", ")}`);
}
if (!dryRun && written.length > 0) {
  console.log(`\nNext steps:
  1. npm run build        (bakes masks into dist/public/aop-masks/)
  2. git add client/public/aop-masks/${blueprintId}/
  3. git commit -m "Add AOP panel masks for blueprint ${blueprintId}"
  4. Deploy (npm run deploy or push to production branch)`);
}
