import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;
const originalReplicateToken = process.env.REPLICATE_API_TOKEN;
const originalVersion = process.env.REPLICATE_RECRAFT_VECTORIZE_VERSION;

describe("Recraft vectorizer client", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.REPLICATE_API_TOKEN = "test-token";
    delete process.env.REPLICATE_RECRAFT_VECTORIZE_VERSION;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    if (originalReplicateToken === undefined) {
      delete process.env.REPLICATE_API_TOKEN;
    } else {
      process.env.REPLICATE_API_TOKEN = originalReplicateToken;
    }
    if (originalVersion === undefined) {
      delete process.env.REPLICATE_RECRAFT_VECTORIZE_VERSION;
    } else {
      process.env.REPLICATE_RECRAFT_VECTORIZE_VERSION = originalVersion;
    }
  });

  it("returns SVG bytes from Recraft prediction output URL", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/predictions")) {
        const body = JSON.parse(String(init?.body));
        expect(body.version).toBe(
          "9f71824b45b71f56b576b97149c314989cfabf90b08f0506ffcdc9fa62beb05d",
        );
        expect(body.input.image).toMatch(/^data:image\/png;base64,/);

        return jsonResponse({
          id: "recraft-prediction",
          status: "starting",
          urls: { get: "https://api.replicate.com/v1/predictions/recraft-prediction" },
        });
      }

      if (String(url).includes("/predictions/recraft-prediction")) {
        return jsonResponse({
          id: "recraft-prediction",
          status: "succeeded",
          output: "https://replicate.delivery/recraft-output.svg",
        });
      }

      if (String(url).includes("recraft-output.svg")) {
        return new Response("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", {
          headers: { "Content-Type": "image/svg+xml" },
        });
      }

      throw new Error(`Unexpected fetch: ${String(url)}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const sharp = (await import("sharp")).default;
    const png = await sharp({
      create: {
        width: 512,
        height: 512,
        channels: 4,
        background: { r: 255, g: 0, b: 255, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    const { vectorizeWithRecraft } = await import("./replicate-vectorizer");
    const svg = await vectorizeWithRecraft({ imageBuffer: png });

    expect(svg.toString("utf8")).toContain("<svg");
  });

  it("sanitizeVectorSvg strips chroma-key pink fills", async () => {
    const { sanitizeVectorSvg } = await import("./replicate-vectorizer");
    const raw = Buffer.from(
      '<svg><path fill="#FF00FF" d="M0 0"/><path fill="#000" d="M1 1"/></svg>',
    );
    const cleaned = sanitizeVectorSvg(raw).toString("utf8");
    expect(cleaned).toContain('fill="none"');
    expect(cleaned).toContain('fill="#000"');
  });

  it("sanitizeVectorSvg strips tracer-quantized plate colors but keeps real purples", async () => {
    const { sanitizeVectorSvg } = await import("./replicate-vectorizer");
    const raw = Buffer.from(
      '<svg>' +
        '<path fill="#FC00FC" d="M0 0"/>' + // Neplex colorPrecision:6 plate (255→252)
        '<path fill="rgb(250, 4, 248)" d="M1 1"/>' + // drifted plate
        '<path stroke="#fc00fc" d="M2 2"/>' +
        '<path style="fill:#FA00FA;stroke:#000" d="M3 3"/>' +
        '<path fill="#800080" d="M4 4"/>' + // legit purple — keep
        '<path fill="#C800FF" d="M5 5"/>' + // legit violet — keep
        '</svg>',
    );
    const cleaned = sanitizeVectorSvg(raw).toString("utf8");
    expect(cleaned).not.toContain("#FC00FC");
    expect(cleaned).not.toContain("rgb(250, 4, 248)");
    expect(cleaned).toContain('stroke="none"');
    expect(cleaned).toContain('style="display:none"');
    expect(cleaned).toContain('fill="#800080"');
    expect(cleaned).toContain('fill="#C800FF"');
  });

  it("countChromaPlateOpaquePixels detects a surviving plate raster", async () => {
    const sharp = (await import("sharp")).default;
    const { countChromaPlateOpaquePixels } = await import("./replicate-vectorizer");

    const platePatch = await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 252, g: 0, b: 252, alpha: 255 } },
    }).png().toBuffer();

    const src = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 4,
        background: { r: 128, g: 0, b: 128, alpha: 255 }, // legit purple — not counted
      },
    })
      .composite([{ input: platePatch, left: 10, top: 10 }])
      .png()
      .toBuffer();

    const count = await countChromaPlateOpaquePixels(src);
    expect(count).toBeGreaterThanOrEqual(100);
    expect(count).toBeLessThan(150);
  });

  it("prepareOpaquePlateForVectorize fills transparent areas with chroma plate", async () => {
    const sharp = (await import("sharp")).default;
    const { prepareOpaquePlateForVectorize } = await import("./replicate-vectorizer");

    const src = await sharp({
      create: {
        width: 40,
        height: 40,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } },
          }).png().toBuffer(),
          left: 15,
          top: 15,
        },
      ])
      .png()
      .toBuffer();

    const plate = await prepareOpaquePlateForVectorize(src);
    const { data, info } = await sharp(plate).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);

    const cornerIdx = 0;
    expect(data[cornerIdx]).toBe(255);
    expect(data[cornerIdx + 1]).toBe(0);
    expect(data[cornerIdx + 2]).toBe(255);

    const centerIdx = ((20 * info.width) + 20) * info.channels;
    expect(data[centerIdx]).toBe(255);
    expect(data[centerIdx + 1]).toBe(255);
    expect(data[centerIdx + 2]).toBe(255);
  });

  it("countNearWhiteOpaquePixels counts interior white fills", async () => {
    const sharp = (await import("sharp")).default;
    const { countNearWhiteOpaquePixels } = await import("./replicate-vectorizer");

    const whitePatch = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } },
    }).png().toBuffer();

    const src = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 4,
        background: { r: 40, g: 80, b: 200, alpha: 255 },
      },
    })
      .composite([{ input: whitePatch, left: 12, top: 12 }])
      .png()
      .toBuffer();

    const count = await countNearWhiteOpaquePixels(src);
    expect(count).toBeGreaterThanOrEqual(64);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
