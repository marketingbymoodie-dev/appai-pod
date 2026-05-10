import { useEffect, useMemo, useRef } from "react";
import type { ArtworkPanelAsset, MockupViewCalibration } from "../types/mockupTypes";
import { renderMockupToCanvas } from "../renderer/renderMockup";

type MockupPreviewComparisonProps = {
  view: MockupViewCalibration;
  artworkPanels: ArtworkPanelAsset[];
  referenceOpacity: number;
  showReferenceOverlay: boolean;
};

export function MockupPreviewComparison({
  view,
  artworkPanels,
  referenceOpacity,
  showReferenceOverlay,
}: MockupPreviewComparisonProps) {
  const localCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageCache = useMemo(() => new Map<string, HTMLImageElement>(), []);

  useEffect(() => {
    let cancelled = false;
    async function draw() {
      if (localCanvasRef.current) {
        await renderMockupToCanvas(localCanvasRef.current, view, { artworkPanels }, imageCache);
      }
      if (!cancelled && overlayCanvasRef.current) {
        await renderMockupToCanvas(
          overlayCanvasRef.current,
          view,
          {
            artworkPanels,
            referenceOpacity,
            showReferenceOverlay,
          },
          imageCache,
        );
      }
    }
    void draw();
    return () => {
      cancelled = true;
    };
  }, [artworkPanels, imageCache, referenceOpacity, showReferenceOverlay, view]);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="mb-2 text-sm font-semibold">Local generated preview</div>
          <canvas ref={localCanvasRef} className="h-auto w-full rounded-md border bg-white" />
        </div>
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="mb-2 text-sm font-semibold">Printify reference mockup</div>
          {view.referenceImageUrl ? (
            <img src={view.referenceImageUrl} alt="Printify reference" className="h-auto w-full rounded-md border bg-white" />
          ) : (
            <div className="flex aspect-[4/5] items-center justify-center rounded-md border bg-white text-sm text-muted-foreground">
              Upload a reference mockup
            </div>
          )}
        </div>
      </div>
      <div className="rounded-lg border bg-muted/20 p-3">
        <div className="mb-2 text-sm font-semibold">Overlay comparison</div>
        <canvas ref={overlayCanvasRef} className="h-auto w-full rounded-md border bg-white" />
      </div>
    </div>
  );
}
