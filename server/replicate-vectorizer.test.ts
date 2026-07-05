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
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
