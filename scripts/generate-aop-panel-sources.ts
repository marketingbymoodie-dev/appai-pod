import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/**
 * Local AOP panel-source generator.
 *
 * Ports the production per-panel rasterization (PatternCustomizer.tsx →
 * buildPlaceModePanelUrls / buildPatternAopPanelUrls / applyPanelRenderOverrides /
 * drawArtworkInSlot) into a Node + sharp pipeline so we can produce the same
 * shape of `aopPrintPanelUrls` artifacts the customer flow saves, without
 * relying on stale /apps/appai/objects/uploads/* URLs.
 *
 * Output:
 *   tmp/aop-render-tests/source-panels-generated/{panel}.png
 *   tmp/generated-panel-design-state.json (designState.aopPrintPanelUrls)
 */

const DEFAULT_PRODUCT_TYPE_ID = 20;
const DEFAULT_LONG_EDGE = 1024;
// Approximate PatternCustomizer preview viewport width. Production upscales
// stored dxPx/dyPx by `outW / previewSlotW`. We don't have layout metadata
// here, so we approximate with a single ratio.
const PREVIEW_VIEWPORT_PX = 600;

const CWD = process.cwd();
const TMP_DIR = path.join(CWD, "tmp");
const OUTPUT_DIR = path.join(TMP_DIR, "aop-render-tests", "source-panels-generated");
const DESIGN_STATE_OUT = path.join(TMP_DIR, "generated-panel-design-state.json");

type PlaceholderPosition = { position: string; width: number; height: number };

type PanelTransform = { dxPx: number; dyPx: number; scalePct: number };

type PanelRenderConfig = { enabled: boolean; mode: "artwork" | "solid"; solidColor?: string };

type AopPlacementSettings = {
  perPanelTransforms?: Record<string, PanelTransform>;
  panelRenderConfig?: Record<string, PanelRenderConfig>;
  mirrorMode?: boolean;
  syncSidesMode?: boolean;
  seamBleedPx?: number;
  hoodieSeamBleedPx?: Partial<Record<"front" | "hood", number>>;
  hoodiePatternSpecs?: Record<string, unknown>;
  bgColor?: string;
  [key: string]: unknown;
};

type PlacementInput = {
  placement?: AopPlacementSettings;
  bgColor?: string;
  artworkUrl?: string;
  raw?: unknown;
};

function argValue(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0) return process.argv[idx + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const loose = process.argv.find((a) => a.startsWith(`${name}=`));
  return loose ? loose.slice(name.length + 1) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function printHelp() {
  console.log(`
Generate per-panel AOP source PNGs locally (no /apps/appai/objects/uploads).

Usage:
  npx tsx scripts/generate-aop-panel-sources.ts --artwork ./tmp/test-artwork.png --productTypeId 20 --size L

Options:
  --artwork <path-or-url>     Required artwork image (or supplied via --placement.aopPatternUrl).
  --productTypeId <id>        Product type whose printify-mapping JSON should drive panel sizes. Defaults to 20.
  --size <SIZE>               Variant size (e.g. L). Falls back to storedFields.placeholderPositions when absent.
  --placement <path>          Optional design-state JSON whose aopPlacementSettings/aopPatternUrl drive transforms + bgColor.
  --longEdge <pixels>         Cap each panel's long edge (defaults to ${DEFAULT_LONG_EDGE}).
  --mappingPath <path>        Override path to printify-mapping JSON. Defaults to tmp/printify-mapping-product-{id}.json.

Outputs:
  tmp/aop-render-tests/source-panels-generated/{panel}.png
  tmp/generated-panel-design-state.json
`);
}

function safeFile(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, "_") || "panel";
}

function isHoodieTrimPanel(position: string): boolean {
  const l = position.toLowerCase();
  return (
    l.includes("cuff") ||
    l.includes("sleeve") ||
    l.includes("waistband") ||
    l.includes("placket") ||
    l.includes("collar") ||
    l.includes("yoke")
  );
}

function isHoodieBackPanel(position: string): boolean {
  return position.toLowerCase().startsWith("back") || position.toLowerCase() === "back";
}

/**
 * Mirror PatternCustomizer.getDefaultPanelRenderConfig for hoodie-style panels:
 *   trim/back → solid (disabled)
 *   pocket/front/hood → artwork (enabled)
 */
function defaultRenderConfig(position: string): PanelRenderConfig {
  if (isHoodieTrimPanel(position)) return { enabled: false, mode: "solid" };
  if (isHoodieBackPanel(position)) return { enabled: false, mode: "solid" };
  return { enabled: true, mode: "artwork" };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  if (typeof hex !== "string") return null;
  const m = hex.replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(m)) return null;
  return {
    r: parseInt(m.slice(0, 2), 16),
    g: parseInt(m.slice(2, 4), 16),
    b: parseInt(m.slice(4, 6), 16),
  };
}

async function readArtworkBuffer(input: string): Promise<Buffer> {
  if (input.startsWith("data:")) {
    const m = input.match(/^data:[^,]*;base64,(.+)$/s);
    if (!m) throw new Error("Only base64 data URLs are supported.");
    return Buffer.from(m[1], "base64");
  }
  if (/^https?:\/\//i.test(input)) {
    const r = await fetch(input);
    if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${input}`);
    return Buffer.from(await r.arrayBuffer());
  }
  return fs.readFile(path.resolve(CWD, input));
}

async function loadPlaceholderPositions(productTypeId: number, size: string | undefined, mappingPath?: string): Promise<PlaceholderPosition[]> {
  const filePath = mappingPath
    ? path.resolve(CWD, mappingPath)
    : path.join(TMP_DIR, `printify-mapping-product-${productTypeId}.json`);
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
  if (!Array.isArray(stored) || stored.length === 0) {
    throw new Error(`No placeholderPositions found in ${filePath}.`);
  }
  return stored.map((p: any) => ({
    position: String(p.position),
    width: Number(p.width),
    height: Number(p.height),
  }));
}

async function loadPlacement(filePath?: string): Promise<PlacementInput> {
  if (!filePath) return {};
  const raw = await fs.readFile(path.resolve(CWD, filePath), "utf8");
  const json: any = JSON.parse(raw);
  const designState = json?.designState ?? json;
  const placement = (designState?.aopPlacementSettings ?? designState?.placement) as AopPlacementSettings | undefined;
  return {
    placement,
    bgColor: typeof placement?.bgColor === "string" ? placement.bgColor : undefined,
    artworkUrl: typeof designState?.aopPatternUrl === "string" ? designState.aopPatternUrl : undefined,
    raw: json,
  };
}

/**
 * Server-side equivalent of PatternCustomizer.drawArtworkInSlot:
 *   - contain-fit the artwork to the panel slot
 *   - apply transform.scalePct
 *   - translate by transform.dxPx / dyPx (preview pixels → output pixels)
 *   - optional mirror-X, optional bgColor fill
 *
 * If render config is disabled or "solid", emits a flat bgColor (or transparent)
 * canvas — matching applyPanelRenderOverrides → buildSolidPanelDataUrl.
 */
async function renderPanelPng(
  artwork: Buffer,
  placeholder: PlaceholderPosition,
  transform: PanelTransform,
  config: PanelRenderConfig,
  bgColor: string | undefined,
  longEdge: number,
  mirrorX: boolean,
): Promise<{ buffer: Buffer; width: number; height: number; mode: "artwork" | "solid" }> {
  const ratio = Math.min(1, longEdge / Math.max(placeholder.width, placeholder.height));
  const outW = Math.max(1, Math.round(placeholder.width * ratio));
  const outH = Math.max(1, Math.round(placeholder.height * ratio));

  const fillHex = config.solidColor || bgColor;
  const rgb = fillHex ? hexToRgb(fillHex) : null;
  const baseColor = rgb
    ? { r: rgb.r, g: rgb.g, b: rgb.b, alpha: 1 }
    : { r: 0, g: 0, b: 0, alpha: 0 };

  const baseCanvas = () =>
    sharp({
      create: { width: outW, height: outH, channels: 4, background: baseColor },
    });

  if (!config.enabled || config.mode === "solid") {
    const buffer = await baseCanvas().png().toBuffer();
    return { buffer, width: outW, height: outH, mode: "solid" };
  }

  const meta = await sharp(artwork).metadata();
  const imgW = meta.width || outW;
  const imgH = meta.height || outH;

  const baseScale = Math.min(outW / imgW, outH / imgH);
  const effectiveScale = baseScale * (Math.max(1, transform.scalePct) / 100);
  const drawnW = Math.max(1, Math.round(imgW * effectiveScale));
  const drawnH = Math.max(1, Math.round(imgH * effectiveScale));

  const upscale = outW / PREVIEW_VIEWPORT_PX;
  const dx = transform.dxPx * upscale;
  const dy = transform.dyPx * upscale;

  const cx = outW / 2 + dx;
  const cy = outH / 2 + dy;
  const left = Math.round(cx - drawnW / 2);
  const top = Math.round(cy - drawnH / 2);

  let resized = await sharp(artwork)
    .resize(drawnW, drawnH, { fit: "fill" })
    .ensureAlpha()
    .png()
    .toBuffer();

  if (mirrorX) {
    resized = await sharp(resized).flop().png().toBuffer();
  }

  const leftCrop = Math.max(0, -left);
  const topCrop = Math.max(0, -top);
  const rightOver = Math.max(0, left + drawnW - outW);
  const bottomOver = Math.max(0, top + drawnH - outH);
  const extractW = drawnW - leftCrop - rightOver;
  const extractH = drawnH - topCrop - bottomOver;

  if (extractW <= 0 || extractH <= 0) {
    const buffer = await baseCanvas().png().toBuffer();
    return { buffer, width: outW, height: outH, mode: "artwork" };
  }

  if (leftCrop > 0 || topCrop > 0 || rightOver > 0 || bottomOver > 0) {
    resized = await sharp(resized)
      .extract({ left: leftCrop, top: topCrop, width: extractW, height: extractH })
      .png()
      .toBuffer();
  }

  const buffer = await baseCanvas()
    .composite([
      {
        input: resized,
        left: Math.max(0, left),
        top: Math.max(0, top),
      },
    ])
    .png()
    .toBuffer();

  return { buffer, width: outW, height: outH, mode: "artwork" };
}

/**
 * Should this panel be rendered with mirrored artwork?
 *   - mirrorMode + leggings-style "left_..." panel pairs (matches PatternCustomizer doMirror).
 *   - Hoodie front_left / front_right etc. share a perPanelTransform but PatternCustomizer
 *     bakes the Sync Sides path; we follow the same convention so the left half mirrors
 *     when only the right transform is provided.
 */
function shouldMirrorPanel(position: string, placement: AopPlacementSettings | undefined): boolean {
  if (!placement) return false;
  const lower = position.toLowerCase();
  if (placement.mirrorMode && lower.includes("left") && (lower.includes("leg") || lower.includes("side"))) {
    return true;
  }
  return false;
}

async function main() {
  if (hasFlag("help")) {
    printHelp();
    return;
  }

  const productTypeId = Number(argValue("productTypeId") || DEFAULT_PRODUCT_TYPE_ID);
  const sizeArg = argValue("size") || "L";
  const placementPath = argValue("placement");
  const longEdge = Number(argValue("longEdge") || DEFAULT_LONG_EDGE);
  const mappingPath = argValue("mappingPath");

  const placementInput = await loadPlacement(placementPath);
  const artworkArg = argValue("artwork") || placementInput.artworkUrl;
  if (!artworkArg) {
    throw new Error("--artwork is required (or set aopPatternUrl in --placement file).");
  }

  const placement = placementInput.placement;
  const bgColor = placementInput.bgColor || (typeof placement?.bgColor === "string" ? placement.bgColor : undefined);

  const placeholders = await loadPlaceholderPositions(productTypeId, sizeArg, mappingPath);
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const artworkBuffer = await readArtworkBuffer(artworkArg);

  const aopPrintPanelUrls: { position: string; url: string; width: number; height: number; mode: "artwork" | "solid" }[] = [];

  for (const ph of placeholders) {
    const transform = placement?.perPanelTransforms?.[ph.position] ?? { dxPx: 0, dyPx: 0, scalePct: 100 };
    const config = placement?.panelRenderConfig?.[ph.position] ?? defaultRenderConfig(ph.position);
    const mirrorX = shouldMirrorPanel(ph.position, placement);

    const { buffer, mode } = await renderPanelPng(artworkBuffer, ph, transform, config, bgColor, longEdge, mirrorX);
    const outPath = path.join(OUTPUT_DIR, `${safeFile(ph.position)}.png`);
    await fs.writeFile(outPath, buffer);

    const rel = path.relative(CWD, outPath).split(path.sep).join("/");
    aopPrintPanelUrls.push({
      position: ph.position,
      url: rel,
      width: ph.width,
      height: ph.height,
      mode,
    });
    console.log(
      `[generate-aop-panel-sources] ${ph.position} → ${rel} (${buffer.length} bytes, mode=${mode}${
        config.enabled ? "" : ", disabled"
      }${mirrorX ? ", mirrored" : ""})`,
    );
  }

  const stateOut = {
    productTypeId,
    size: sizeArg,
    sourcedFromPlacement: placementPath ? path.relative(CWD, path.resolve(CWD, placementPath)).split(path.sep).join("/") : null,
    designState: {
      aopPrintPanelUrls,
      aopPlacementSettings:
        placement || {
          perPanelTransforms: {},
          panelRenderConfig: {},
          mirrorMode: false,
          seamBleedPx: 0,
          bgColor,
        },
      aopPatternUrl: artworkArg,
    },
  };

  await fs.mkdir(path.dirname(DESIGN_STATE_OUT), { recursive: true });
  await fs.writeFile(DESIGN_STATE_OUT, JSON.stringify(stateOut, null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        productTypeId,
        size: sizeArg,
        panelCount: aopPrintPanelUrls.length,
        artworkBytes: artworkBuffer.length,
        designStatePath: path.relative(CWD, DESIGN_STATE_OUT).split(path.sep).join("/"),
        sourcePanelsDir: path.relative(CWD, OUTPUT_DIR).split(path.sep).join("/"),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("[generate-aop-panel-sources] Failed:", err);
  process.exit(1);
});
