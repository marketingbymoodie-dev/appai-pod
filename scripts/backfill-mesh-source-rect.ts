/**
 * One-shot data fix: populate `mesh.sourceRect` on every hoodie-template
 * layer that has a calibrated `productionPanelSrc` sheet but no explicit
 * `sourceRect` yet.
 *
 * ROOT CAUSE this fixes (see docs / chat history "AOP print panel sizing
 * mismatch"): when `mesh.sourceRect` is null, the flat print-file exporter
 * (`renderFlatPrintPanels` → `flatPanelBaseDims` in
 * `client/src/components/hoodie-template-mapper/lib/aopPreview.ts`) falls
 * back to the mesh's on-screen *target-point bounding box* as the exported
 * panel's pixel dimensions. That bbox is just a side-effect of how far an
 * admin dragged the warp handles for fabric curvature/overscan — it has no
 * reason to match the panel's real calibrated aspect ratio, and the
 * mismatch is invisible in the on-screen mockup preview (which always
 * clips to the mask polygon) but shows up as oversized/distorted artwork
 * once printed via Printify.
 *
 * This script sets `mesh.sourceRect = { x: 0, y: 0, width, height }` using
 * the REAL pixel dimensions of each layer's `productionPanelSrc` image
 * (read from local `tmp/hoodie-templates/source-panels/`), for every layer
 * where it's currently unset. It does NOT touch `mesh.targetPoints` (the
 * fabric-curvature handles) or `maskPath` (the traced boundary) — the
 * on-screen preview is unaffected because `renderAopPreview` always
 * overrides sourceRect with a synthesised slice; only the print-file
 * export's canvas size/aspect changes (to the correct one).
 *
 * Layers with NO `productionPanelSrc` (no calibration reference uploaded)
 * are left untouched and reported — they need a reference sheet uploaded
 * in the mapper before this fix can apply to them.
 *
 * USAGE
 *   npx tsx scripts/backfill-mesh-source-rect.ts
 *   npx tsx scripts/backfill-mesh-source-rect.ts --dry-run
 */
import fs from "node:fs";
import path from "node:path";
import { LOCAL_TEMPLATES_DIR, LOCAL_SOURCE_PANELS_DIR } from "../server/aopMapperStorage";

type Pt = { x: number; y: number };
type SourceRect = { x: number; y: number; width: number; height: number };
type MeshGrid = {
  cols: number;
  rows: number;
  targetPoints: Pt[];
  sourceRect?: SourceRect | null;
  [key: string]: unknown;
};
type MaskLayer = {
  id: string;
  panelKey?: string | null;
  productionPanelSrc?: string | null;
  mesh?: MeshGrid | null;
  [key: string]: unknown;
};
type HoodieTemplate = {
  name: string;
  views: Record<string, { layers: MaskLayer[] } | undefined>;
  [key: string]: unknown;
};

function pngSize(filePath: string): { width: number; height: number } | null {
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  // PNG IHDR: width @ byte 16, height @ byte 20 (big-endian), after the
  // 8-byte signature + 4-byte length + 4-byte "IHDR" tag.
  if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function resolveSourcePanelDims(productionPanelSrc: string): { width: number; height: number } | null {
  const filename = productionPanelSrc.split("/").pop();
  if (!filename) return null;
  return pngSize(path.join(LOCAL_SOURCE_PANELS_DIR, filename));
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (!fs.existsSync(LOCAL_TEMPLATES_DIR)) {
    throw new Error(`Templates directory not found: ${LOCAL_TEMPLATES_DIR}`);
  }
  const files = fs
    .readdirSync(LOCAL_TEMPLATES_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."));

  let totalFixed = 0;
  let totalSkippedNoSrc = 0;
  let totalAlreadySet = 0;

  for (const file of files) {
    const full = path.join(LOCAL_TEMPLATES_DIR, file);
    const template: HoodieTemplate = JSON.parse(fs.readFileSync(full, "utf-8"));
    let changed = false;
    const fixedHere: string[] = [];
    const skippedHere: string[] = [];

    for (const [view, viewState] of Object.entries(template.views)) {
      for (const layer of viewState?.layers ?? []) {
        if (!layer.mesh) continue;
        if (layer.mesh.sourceRect && layer.mesh.sourceRect.width > 0 && layer.mesh.sourceRect.height > 0) {
          totalAlreadySet += 1;
          continue;
        }
        if (!layer.productionPanelSrc) {
          totalSkippedNoSrc += 1;
          skippedHere.push(`${view}/${layer.panelKey ?? layer.id}`);
          continue;
        }
        const dims = resolveSourcePanelDims(layer.productionPanelSrc);
        if (!dims) {
          totalSkippedNoSrc += 1;
          skippedHere.push(`${view}/${layer.panelKey ?? layer.id} (couldn't read ${layer.productionPanelSrc})`);
          continue;
        }
        layer.mesh.sourceRect = { x: 0, y: 0, width: dims.width, height: dims.height };
        changed = true;
        totalFixed += 1;
        fixedHere.push(`${view}/${layer.panelKey ?? layer.id} → ${dims.width}x${dims.height}`);
      }
    }

    if (fixedHere.length > 0 || skippedHere.length > 0) {
      console.log(`\n[backfill] ${file}`);
      for (const line of fixedHere) console.log(`  fixed:   ${line}`);
      for (const line of skippedHere) console.log(`  no-ref:  ${line}`);
    }

    if (changed && !dryRun) {
      fs.writeFileSync(full, JSON.stringify(template, null, 2) + "\n", "utf-8");
    }
  }

  console.log(
    `\n[backfill] ${dryRun ? "DRY RUN — " : ""}fixed ${totalFixed} layer(s), ${totalAlreadySet} already had sourceRect, ${totalSkippedNoSrc} have no calibration reference to fix from.`,
  );
  if (!dryRun) {
    console.log("[backfill] Run `npm run import:hoodie-drafts` next to push the fix to Supabase + republish.");
  }
}

main();
