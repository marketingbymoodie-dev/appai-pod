import { describe, expect, it, vi } from "vitest";
import { clipFlatArtToPrintArea } from "./flatRender";

function mockCtx() {
  const calls: Array<{ op?: string; fillRect?: number[] }> = [];
  const actx = {
    globalCompositeOperation: "source-over" as GlobalCompositeOperation,
    fillStyle: "#000",
    fillRect: vi.fn((x: number, y: number, w: number, h: number) => {
      calls.push({ fillRect: [x, y, w, h] });
    }),
    drawImage: vi.fn(),
  };
  return { actx: actx as unknown as CanvasRenderingContext2D, calls, raw: actx };
}

describe("clipFlatArtToPrintArea", () => {
  it("hard-clips to placement rect when mask is null (wall-decal catalog blanks)", () => {
    const { actx, calls, raw } = mockCtx();
    const rect = { x: 100, y: 50, width: 200, height: 400 };
    const mode = clipFlatArtToPrintArea(actx, {
      mask: null,
      rect,
      canvasW: 1024,
      canvasH: 1024,
    });
    expect(mode).toBe("rect");
    expect(raw.fillRect).toHaveBeenCalledWith(100, 50, 200, 400);
    expect(calls.some((c) => c.fillRect)).toBe(true);
    expect(raw.globalCompositeOperation).toBe("source-over");
  });

  it("uses pixel mask when present", () => {
    const { actx, raw } = mockCtx();
    const mask = { naturalWidth: 1024, naturalHeight: 1024 } as HTMLImageElement;
    const mode = clipFlatArtToPrintArea(actx, {
      mask,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      canvasW: 1024,
      canvasH: 1024,
    });
    expect(mode).toBe("mask");
    expect(raw.drawImage).toHaveBeenCalled();
    expect(raw.fillRect).not.toHaveBeenCalled();
  });
});
