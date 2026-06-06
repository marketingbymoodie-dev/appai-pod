import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;
const originalReplicateToken = process.env.REPLICATE_API_TOKEN;
const originalProvider = process.env.REPLICATE_BG_REMOVER_PROVIDER;
const originalBriaVersion = process.env.REPLICATE_BRIA_BG_REMOVER_VERSION;
const original851LabsVersion = process.env.REPLICATE_851_LABS_BG_REMOVER_VERSION;
const originalLegacyVersion = process.env.REPLICATE_BG_REMOVER_VERSION;

describe("Replicate background removal client", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.REPLICATE_API_TOKEN = "test-token";
    delete process.env.REPLICATE_BG_REMOVER_PROVIDER;
    delete process.env.REPLICATE_BRIA_BG_REMOVER_VERSION;
    delete process.env.REPLICATE_851_LABS_BG_REMOVER_VERSION;
    delete process.env.REPLICATE_BG_REMOVER_VERSION;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    restoreEnv("REPLICATE_API_TOKEN", originalReplicateToken);
    restoreEnv("REPLICATE_BG_REMOVER_PROVIDER", originalProvider);
    restoreEnv("REPLICATE_BRIA_BG_REMOVER_VERSION", originalBriaVersion);
    restoreEnv("REPLICATE_851_LABS_BG_REMOVER_VERSION", original851LabsVersion);
    restoreEnv("REPLICATE_BG_REMOVER_VERSION", originalLegacyVersion);
  });

  it("uses Bria by default and parses URI string output", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/predictions")) {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          version: "4ed060b3587b7c3912353dd7d59000c883a6e1c5c9181ed7415c2624c2e8e392",
          input: {
            image_url: "https://example.com/source.png",
            preserve_alpha: true,
            content_moderation: false,
          },
        });

        return jsonResponse({
          id: "bria-prediction",
          status: "starting",
          urls: { get: "https://api.replicate.com/v1/predictions/bria-prediction" },
        });
      }

      if (String(url).includes("/predictions/bria-prediction")) {
        return jsonResponse({
          id: "bria-prediction",
          status: "succeeded",
          output: "https://replicate.delivery/bria-output.png",
        });
      }

      return new Response(new Uint8Array([1, 2, 3]));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { removeBackground } = await import("./picsart-client");
    const result = await removeBackground({ imageUrl: "https://example.com/source.png" });

    expect(result).toEqual({
      id: "bria-prediction",
      url: "data:image/png;base64,AQID",
    });
  });

  it("falls back to 851-labs when Bria fails", async () => {
    const versions: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/predictions")) {
        const body = JSON.parse(String(init?.body));
        versions.push(body.version);

        if (body.version.startsWith("4ed060b3")) {
          expect(body.input).toMatchObject({
            image: "data:image/png;base64,CQgH",
            preserve_alpha: true,
            content_moderation: false,
          });

          return jsonResponse({
            id: "bria-prediction",
            status: "starting",
            urls: { get: "https://api.replicate.com/v1/predictions/bria-prediction" },
          });
        }

        expect(body).toEqual({
          version: "a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc",
          input: {
            image: "data:image/png;base64,CQgH",
          },
        });

        return jsonResponse({
          id: "851-prediction",
          status: "starting",
          urls: { get: "https://api.replicate.com/v1/predictions/851-prediction" },
        });
      }

      if (String(url).includes("/predictions/bria-prediction")) {
        return jsonResponse({
          id: "bria-prediction",
          status: "failed",
          error: "synthetic Bria failure",
        });
      }

      if (String(url).includes("/predictions/851-prediction")) {
        return jsonResponse({
          id: "851-prediction",
          status: "succeeded",
          output: "https://replicate.delivery/851-output.png",
        });
      }

      return new Response(new Uint8Array([4, 5, 6]));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { removeBackground } = await import("./picsart-client");
    const result = await removeBackground({ imageBuffer: Buffer.from([9, 8, 7]) });

    expect(versions).toEqual([
      "4ed060b3587b7c3912353dd7d59000c883a6e1c5c9181ed7415c2624c2e8e392",
      "a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc",
    ]);
    expect(result).toEqual({
      id: "851-prediction",
      url: "data:image/png;base64,BAUG",
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
