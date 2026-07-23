import { describe, expect, it } from "vitest";
import { stepPostGenGalleryIndex, type PostGenGalleryNavItem } from "./postGenGalleryNav";

const items: PostGenGalleryNavItem[] = [
  { kind: "artwork", label: "Artwork" },
  { kind: "mockup", url: "https://x.example/front.png", label: "Front" },
  { kind: "mockup", url: "https://x.example/ctx.png", label: "Context" },
  { kind: "catalog", url: "https://x.example/blank.png", label: "Primary" },
];

describe("stepPostGenGalleryIndex", () => {
  it("wraps normally when flat placer is closed", () => {
    expect(stepPostGenGalleryIndex(3, 1, items, false)).toBe(0);
    expect(stepPostGenGalleryIndex(0, 1, items, false)).toBe(1);
  });

  it("from Artwork skips Front and lands on Context when placer is open", () => {
    expect(stepPostGenGalleryIndex(0, 1, items, true)).toBe(2);
  });

  it("from last Context wraps back to Artwork (not stuck on Front)", () => {
    expect(stepPostGenGalleryIndex(2, 1, items, true)).toBe(0);
  });

  it("from Artwork going back reaches Context again", () => {
    expect(stepPostGenGalleryIndex(0, -1, items, true)).toBe(2);
  });

  it("reaches Printers Mockup slides while placer is open", () => {
    const withPrinters: PostGenGalleryNavItem[] = [
      { kind: "artwork", label: "Artwork" },
      { kind: "mockup", url: "https://x.example/front.png", label: "front" },
      { kind: "mockup", url: "https://x.example/pfy.png", label: "printers" },
    ];
    expect(stepPostGenGalleryIndex(0, 1, withPrinters, true)).toBe(2);
    expect(
      stepPostGenGalleryIndex(0, 1, [
        { kind: "artwork", label: "Artwork" },
        { kind: "mockup", url: "https://x.example/front.png", label: "front" },
        { kind: "mockup", url: "https://x.example/a.png", label: "Printers Mockup" },
      ], true),
    ).toBe(2);
  });
});
