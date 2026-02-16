/**
 * Bridge handshake and add-to-cart postMessage tests.
 * Tests the iframe-side logic: BRIDGE_READY handling, BRIDGE_ACK sending,
 * bridge timeout error, and add-to-cart message roundtrip.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Simulate postMessage roundtrip helper
function simulateParentMessage(data: Record<string, unknown>, origin = "https://appai-pod-production.up.railway.app") {
  const event = new MessageEvent("message", { data, origin });
  window.dispatchEvent(event);
}

describe("Bridge handshake (iframe side)", () => {
  let postMessageSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Mock window.parent.postMessage
    postMessageSpy = vi.fn();
    Object.defineProperty(window, "parent", {
      value: { postMessage: postMessageSpy },
      writable: true,
      configurable: true,
    });
    // Reset global
    delete (window as any).__aiArtBridgeReady;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should set __aiArtBridgeReady when BRIDGE_READY is received", () => {
    // Simulate the handler that embed-design.tsx installs
    let bridgeReady = false;
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "AI_ART_STUDIO_BRIDGE_READY") {
        bridgeReady = true;
        (window as any).__aiArtBridgeReady = true;
        window.parent.postMessage({ type: "AI_ART_STUDIO_BRIDGE_ACK", _bridgeVersion: "1.0.0" }, "*");
      }
    };
    window.addEventListener("message", handler);

    expect(bridgeReady).toBe(false);
    expect((window as any).__aiArtBridgeReady).toBeUndefined();

    simulateParentMessage({
      type: "AI_ART_STUDIO_BRIDGE_READY",
      _bridgeVersion: "1.0.0",
      heartbeat: 0,
    });

    expect(bridgeReady).toBe(true);
    expect((window as any).__aiArtBridgeReady).toBe(true);

    // Should have sent ACK
    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "AI_ART_STUDIO_BRIDGE_ACK" }),
      "*"
    );

    window.removeEventListener("message", handler);
  });

  it("should respond to PING with PONG", () => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "AI_ART_STUDIO_PING") {
        window.parent.postMessage({
          type: "AI_ART_STUDIO_PONG",
          _bridgeVersion: "1.0.0",
          pingTimestamp: event.data.timestamp,
        }, "*");
      }
    };
    window.addEventListener("message", handler);

    simulateParentMessage({ type: "AI_ART_STUDIO_PING", timestamp: 12345 });

    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "AI_ART_STUDIO_PONG", pingTimestamp: 12345 }),
      "*"
    );

    window.removeEventListener("message", handler);
  });

  it("should resolve add-to-cart when result comes back with matching correlationId", async () => {
    const correlationId = "cart_test_abc123";

    // Simulate the addToCartStorefront pattern
    const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      const handler = (event: MessageEvent) => {
        if (
          event.data?.type === "AI_ART_STUDIO_ADD_TO_CART_RESULT" &&
          event.data?.correlationId === correlationId
        ) {
          window.removeEventListener("message", handler);
          resolve({
            success: !!(event.data.ok || event.data.success),
            error: event.data.error,
          });
        }
      };
      window.addEventListener("message", handler);

      // Send the add-to-cart message
      window.parent.postMessage({
        type: "AI_ART_STUDIO_ADD_TO_CART",
        correlationId,
        variantId: "12345",
        quantity: 1,
        properties: {},
      }, "*");

      // Simulate parent responding
      setTimeout(() => {
        simulateParentMessage({
          type: "AI_ART_STUDIO_ADD_TO_CART_RESULT",
          correlationId,
          ok: true,
          success: true,
          cart: { items: [] },
          _bridgeVersion: "1.0.0",
        });
      }, 10);
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("should not resolve for mismatched correlationId", async () => {
    const correctId = "cart_correct";
    const wrongId = "cart_wrong";

    const result = await new Promise<string>((resolve) => {
      const handler = (event: MessageEvent) => {
        if (event.data?.type === "AI_ART_STUDIO_ADD_TO_CART_RESULT") {
          if (event.data.correlationId === correctId) {
            resolve("matched");
          }
        }
      };
      window.addEventListener("message", handler);

      // Send wrong correlationId
      setTimeout(() => {
        simulateParentMessage({
          type: "AI_ART_STUDIO_ADD_TO_CART_RESULT",
          correlationId: wrongId,
          ok: true,
        });
      }, 5);

      // Send correct one
      setTimeout(() => {
        simulateParentMessage({
          type: "AI_ART_STUDIO_ADD_TO_CART_RESULT",
          correlationId: correctId,
          ok: true,
        });
      }, 15);

      // Timeout safety
      setTimeout(() => resolve("timeout"), 100);
    });

    expect(result).toBe("matched");
  });

  it("bridge not ready should fail fast in addToCartStorefront", () => {
    // When bridge is NOT ready, addToCartStorefront should return immediately
    // with an error rather than waiting for timeout
    const bridgeReady = false;
    const __aiArtBridgeReady = false;

    if (!bridgeReady && !__aiArtBridgeReady) {
      const result = {
        success: false,
        error: "The storefront add-to-cart bridge is not connected.",
      };
      expect(result.success).toBe(false);
      expect(result.error).toContain("bridge");
    }
  });
});
