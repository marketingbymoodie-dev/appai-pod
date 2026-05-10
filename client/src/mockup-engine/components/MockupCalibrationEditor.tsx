import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { CalibrationJsonEditor } from "./CalibrationJsonEditor";
import { GuideEditor } from "./GuideEditor";
import { MockupPreviewComparison } from "./MockupPreviewComparison";
import { PanelControls } from "./PanelControls";
import { exportCanvasAsPng } from "../renderer/exportCanvas";
import { renderMockupToCanvas } from "../renderer/renderMockup";
import type {
  ArtworkPanelAsset,
  MockupCalibration,
  MockupGuide,
  MockupGuideType,
  MockupPanelPlacement,
  MockupPanelPreset,
  MockupPoint,
  MockupViewCalibration,
} from "../types/mockupTypes";
import { downloadJson, loadArtworkPanelsFromStorage, loadCalibrationFromStorage, saveArtworkPanelsToStorage, saveCalibrationToStorage } from "../utils/calibrationStorage";
import { fileToDataUrl, filesToNamedDataUrls, loadImage } from "../utils/imageLoader";

type DragState =
  | { type: "panel"; panelId: string; start: MockupPoint; original: MockupPanelPlacement }
  | { type: "panel-resize"; panelId: string; start: MockupPoint; original: MockupPanelPlacement }
  | { type: "panel-rotate"; panelId: string; start: MockupPoint; original: MockupPanelPlacement }
  | { type: "guide-point"; guideId: string; pointIndex: number; start: MockupPoint; original: MockupGuide };

function cloneCalibration(calibration: MockupCalibration): MockupCalibration {
  return JSON.parse(JSON.stringify(calibration)) as MockupCalibration;
}

function emptyCalibration(): MockupCalibration {
  return {
    productType: "zip_hoodie_aop",
    provider: "printify",
    version: "0.1.0",
    views: {},
  };
}

function firstViewId(calibration: MockupCalibration) {
  return Object.keys(calibration.views)[0] ?? "";
}

function makeId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function panelBounds(panel: MockupPanelPlacement) {
  if (panel.perspectiveCorners) {
    const points = Object.values(panel.perspectiveCorners);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  }
  return {
    x: panel.x,
    y: panel.y,
    width: panel.width * panel.scaleX,
    height: panel.height * panel.scaleY,
  };
}

function distance(a: MockupPoint, b: MockupPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function panelCenter(panel: MockupPanelPlacement): MockupPoint {
  const bounds = panelBounds(panel);
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function angleBetween(center: MockupPoint, point: MockupPoint) {
  return (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI;
}

function movePanel(panel: MockupPanelPlacement, dx: number, dy: number): MockupPanelPlacement {
  const moved: MockupPanelPlacement = {
    ...panel,
    x: panel.x + dx,
    y: panel.y + dy,
    seamAnchor: panel.seamAnchor ? { ...panel.seamAnchor, x: panel.seamAnchor.x + dx, y: panel.seamAnchor.y + dy } : undefined,
    snapAnchors: panel.snapAnchors?.map((anchor) => ({ ...anchor, x: anchor.x + dx, y: anchor.y + dy })),
  };
  if (panel.perspectiveCorners) {
    moved.perspectiveCorners = {
      topLeft: { x: panel.perspectiveCorners.topLeft.x + dx, y: panel.perspectiveCorners.topLeft.y + dy },
      topRight: { x: panel.perspectiveCorners.topRight.x + dx, y: panel.perspectiveCorners.topRight.y + dy },
      bottomRight: { x: panel.perspectiveCorners.bottomRight.x + dx, y: panel.perspectiveCorners.bottomRight.y + dy },
      bottomLeft: { x: panel.perspectiveCorners.bottomLeft.x + dx, y: panel.perspectiveCorners.bottomLeft.y + dy },
    };
  }
  return moved;
}

export function MockupCalibrationEditor() {
  const [calibration, setCalibration] = useState<MockupCalibration>(() => loadCalibrationFromStorage() ?? emptyCalibration());
  const [activeViewId, setActiveViewId] = useState(() => firstViewId(calibration));
  const [artworkPanels, setArtworkPanels] = useState<ArtworkPanelAsset[]>(() => loadArtworkPanelsFromStorage());
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [selectedGuideId, setSelectedGuideId] = useState<string | null>(null);
  const [assistMode, setAssistMode] = useState(true);
  const [showReferenceOverlay, setShowReferenceOverlay] = useState(true);
  const [referenceOpacity, setReferenceOpacity] = useState(0.5);
  const [showPanelBounds, setShowPanelBounds] = useState(true);
  const [showGuides, setShowGuides] = useState(true);
  const [status, setStatus] = useState<string>("Loading default calibration...");
  const [dragState, setDragState] = useState<DragState | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageCache = useMemo(() => new Map<string, HTMLImageElement>(), []);

  const activeView = activeViewId ? calibration.views[activeViewId] : undefined;

  useEffect(() => {
    if (Object.keys(calibration.views).length > 0) return;
    fetch(new URL("../calibration/zip-hoodie-aop.default.json", import.meta.url))
      .then((response) => response.json())
      .then((json: MockupCalibration) => {
        setCalibration(json);
        setActiveViewId(firstViewId(json));
        setStatus("Default calibration loaded.");
      })
      .catch(() => setStatus("Could not load default calibration JSON."));
  }, [calibration.views]);

  const updateActiveView = useCallback(
    (updater: (view: MockupViewCalibration) => MockupViewCalibration) => {
      if (!activeViewId) return;
      setCalibration((current) => ({
        ...current,
        views: {
          ...current.views,
          [activeViewId]: updater(current.views[activeViewId]),
        },
      }));
    },
    [activeViewId],
  );

  const updatePanel = useCallback(
    (panelId: string, patch: Partial<MockupPanelPlacement>) => {
      updateActiveView((view) => ({
        ...view,
        panels: view.panels.map((panel) => (panel.id === panelId ? { ...panel, ...patch } : panel)),
      }));
    },
    [updateActiveView],
  );

  const updateGuide = useCallback(
    (guideId: string, patch: Partial<MockupGuide>) => {
      updateActiveView((view) => ({
        ...view,
        guides: view.guides.map((guide) => (guide.id === guideId ? { ...guide, ...patch } : guide)),
      }));
    },
    [updateActiveView],
  );

  const updateReferenceTransform = useCallback(
    (patch: Partial<NonNullable<MockupViewCalibration["referenceTransform"]>>) => {
      updateActiveView((view) => ({
        ...view,
        referenceTransform: {
          fitMode: "contain",
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
          opacity: referenceOpacity,
          ...(view.referenceTransform ?? {}),
          ...patch,
        },
      }));
    },
    [referenceOpacity, updateActiveView],
  );

  const redraw = useCallback(async () => {
    if (!canvasRef.current || !activeView) return;
    await renderMockupToCanvas(
      canvasRef.current,
      activeView,
      {
        artworkPanels,
        showGuides: assistMode && showGuides,
        showPanelBounds,
        selectedPanelId,
        selectedGuideId,
        referenceOpacity,
        showReferenceOverlay: assistMode && showReferenceOverlay,
      },
      imageCache,
    );
  }, [activeView, artworkPanels, assistMode, imageCache, referenceOpacity, selectedGuideId, selectedPanelId, showGuides, showPanelBounds, showReferenceOverlay]);

  useEffect(() => {
    void redraw();
  }, [redraw]);

  function canvasPoint(event: React.PointerEvent<HTMLCanvasElement>): MockupPoint {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function hitGuidePoint(point: MockupPoint) {
    if (!activeView || !showGuides) return null;
    for (const guide of activeView.guides) {
      if (guide.locked) continue;
      for (let index = 0; index < guide.points.length; index += 1) {
        if (distance(point, guide.points[index]) < 18) return { guide, pointIndex: index };
      }
    }
    return null;
  }

  function hitPanel(point: MockupPoint) {
    if (!activeView) return null;
    return [...activeView.panels]
      .sort((a, b) => b.zIndex - a.zIndex)
      .find((panel) => {
        if (panel.locked || !panel.visible) return false;
        const bounds = panelBounds(panel);
        return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
      });
  }

  function hitSelectedPanelHandle(point: MockupPoint) {
    if (!activeView || !selectedPanelId || !showPanelBounds) return null;
    const panel = activeView.panels.find((item) => item.id === selectedPanelId);
    if (!panel || panel.locked || !panel.visible) return null;
    const bounds = panelBounds(panel);
    const resizePoint = { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
    const rotatePoint = { x: bounds.x + bounds.width / 2, y: bounds.y - 28 };
    if (distance(point, resizePoint) < 22) return { type: "panel-resize" as const, panel };
    if (distance(point, rotatePoint) < 22) return { type: "panel-rotate" as const, panel };
    return null;
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const point = canvasPoint(event);
    const handleHit = hitSelectedPanelHandle(point);
    if (handleHit) {
      setSelectedPanelId(handleHit.panel.id);
      setSelectedGuideId(null);
      setDragState({ type: handleHit.type, panelId: handleHit.panel.id, start: point, original: { ...handleHit.panel } });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const guideHit = hitGuidePoint(point);
    if (guideHit) {
      setSelectedGuideId(guideHit.guide.id);
      setSelectedPanelId(null);
      setDragState({ type: "guide-point", guideId: guideHit.guide.id, pointIndex: guideHit.pointIndex, start: point, original: cloneCalibration({ ...calibration, views: { temp: { ...activeView!, guides: [guideHit.guide], panels: [] } } }).views.temp.guides[0] });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const panel = hitPanel(point);
    if (panel) {
      setSelectedPanelId(panel.id);
      setSelectedGuideId(null);
      setDragState({ type: "panel", panelId: panel.id, start: point, original: { ...panel } });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    setSelectedPanelId(null);
    setSelectedGuideId(null);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragState || !activeView) return;
    const point = canvasPoint(event);
    const dx = point.x - dragState.start.x;
    const dy = point.y - dragState.start.y;
    if (dragState.type === "panel") {
      const next = movePanel(dragState.original, dx, dy);
      updatePanel(dragState.panelId, next);
      return;
    }
    if (dragState.type === "panel-resize") {
      updatePanel(dragState.panelId, {
        width: Math.max(20, dragState.original.width + dx / Math.max(0.1, dragState.original.scaleX)),
        height: Math.max(20, dragState.original.height + dy / Math.max(0.1, dragState.original.scaleY)),
      });
      return;
    }
    if (dragState.type === "panel-rotate") {
      const center = panelCenter(dragState.original);
      const startAngle = angleBetween(center, dragState.start);
      const currentAngle = angleBetween(center, point);
      updatePanel(dragState.panelId, {
        rotation: dragState.original.rotation + currentAngle - startAngle,
      });
      return;
    }
    const nextPoints = dragState.original.points.map((guidePoint, index) =>
      index === dragState.pointIndex ? { x: guidePoint.x + dx, y: guidePoint.y + dy } : guidePoint,
    );
    updateGuide(dragState.guideId, { points: nextPoints });
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    if (dragState) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragState(null);
  }

  async function uploadViewImage(field: "baseImageUrl" | "referenceImageUrl" | "shadowOverlayUrl" | "highlightOverlayUrl", file?: File) {
    if (!file) return;
    const url = await fileToDataUrl(file);
    let naturalSize: { width: number; height: number } | null = null;
    if (field === "baseImageUrl" || (field === "referenceImageUrl" && !activeView?.baseImageUrl)) {
      try {
        const image = await loadImage(url);
        naturalSize = {
          width: image.naturalWidth || image.width,
          height: image.naturalHeight || image.height,
        };
      } catch {
        naturalSize = null;
      }
    }
    updateActiveView((view) => ({
      ...view,
      [field]: url,
      ...(naturalSize && naturalSize.width > 0 && naturalSize.height > 0 ? naturalSize : {}),
    }));
    setStatus(
      naturalSize
        ? `${field} loaded. Canvas resized to ${naturalSize.width} × ${naturalSize.height}.`
        : `${field} loaded.`,
    );
  }

  async function uploadArtwork(files: FileList | null) {
    if (!files?.length) return;
    const nextAssets = await filesToNamedDataUrls(files);
    setArtworkPanels((current) => {
      const merged = [...current.filter((asset) => !nextAssets.some((next) => next.name === asset.name)), ...nextAssets];
      saveArtworkPanelsToStorage(merged);
      return merged;
    });
    setStatus(`${nextAssets.length} artwork panel(s) loaded.`);
    if (selectedPanelId && nextAssets[0]?.name) {
      updatePanel(selectedPanelId, { artworkPanelName: nextAssets[0].name });
      setStatus(`${nextAssets.length} artwork panel(s) loaded and assigned to selected panel.`);
    }
  }

  async function uploadPanelMask(panelId: string, file?: File) {
    if (!file) return;
    const maskUrl = await fileToDataUrl(file);
    updatePanel(panelId, { maskUrl });
    setStatus("Panel mask loaded.");
  }

  function addPanel(preset: MockupPanelPreset, artworkPanelName: string) {
    const id = makeId(preset);
    const panel: MockupPanelPlacement = {
      id,
      name: preset.replace(/_/g, " "),
      artworkPanelName,
      preset,
      x: 420,
      y: 420,
      width: 260,
      height: 340,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      zIndex: Math.max(0, ...(activeView?.panels.map((p) => p.zIndex) ?? [0])) + 1,
      locked: false,
      visible: true,
    };
    updateActiveView((view) => ({ ...view, panels: [...view.panels, panel] }));
    setSelectedPanelId(id);
  }

  function assignArtworkToSelected(artworkPanelName: string) {
    if (!selectedPanelId || !artworkPanelName) return;
    updatePanel(selectedPanelId, { artworkPanelName });
    setStatus(`Assigned ${artworkPanelName} to selected panel.`);
  }

  function assignArtworkToVisible(artworkPanelName: string) {
    if (!artworkPanelName) return;
    updateActiveView((view) => ({
      ...view,
      panels: view.panels.map((panel) => panel.visible && !panel.locked ? { ...panel, artworkPanelName } : panel),
    }));
    setStatus(`Assigned ${artworkPanelName} to all visible unlocked panels.`);
  }

  function duplicatePanel(panelId: string) {
    const panel = activeView?.panels.find((item) => item.id === panelId);
    if (!panel) return;
    const copy = movePanel({ ...panel, id: makeId(`${panel.preset}_copy`), name: `${panel.name} copy`, zIndex: panel.zIndex + 1 }, 24, 24);
    updateActiveView((view) => ({ ...view, panels: [...view.panels, copy] }));
    setSelectedPanelId(copy.id);
  }

  function deletePanel(panelId: string) {
    updateActiveView((view) => ({ ...view, panels: view.panels.filter((panel) => panel.id !== panelId) }));
    setSelectedPanelId(null);
  }

  function addGuide(type: MockupGuideType) {
    const id = makeId(`${type}_guide`);
    const guide: MockupGuide = {
      id,
      type,
      name: `${type} guide`,
      locked: false,
      opacity: 0.8,
      points:
        type === "point"
          ? [{ x: 600, y: 500 }]
          : type === "line"
            ? [{ x: 360, y: 500 }, { x: 840, y: 500 }]
            : [{ x: 360, y: 560 }, { x: 600, y: 430 }, { x: 840, y: 560 }],
    };
    updateActiveView((view) => ({ ...view, guides: [...view.guides, guide] }));
    setSelectedGuideId(id);
  }

  function deleteGuide(guideId: string) {
    updateActiveView((view) => ({ ...view, guides: view.guides.filter((guide) => guide.id !== guideId) }));
    setSelectedGuideId(null);
  }

  function snapSelectedPanelToGuide() {
    if (!activeView || !selectedPanelId) return;
    const panel = activeView.panels.find((item) => item.id === selectedPanelId);
    if (!panel || panel.locked) return;
    const anchors = panel.snapAnchors?.length ? panel.snapAnchors : panel.seamAnchor ? [{ ...panel.seamAnchor, id: "seam" }] : [];
    const guidePoints = activeView.guides.flatMap((guide) => guide.points.map((point) => ({ point, guideId: guide.id })));
    if (!anchors.length || !guidePoints.length) return;
    let best: { dx: number; dy: number; score: number } | null = null;
    for (const anchor of anchors) {
      for (const candidate of guidePoints) {
        if ("guideId" in anchor && anchor.guideId && anchor.guideId !== candidate.guideId) continue;
        const score = distance(anchor, candidate.point);
        if (!best || score < best.score) best = { dx: candidate.point.x - anchor.x, dy: candidate.point.y - anchor.y, score };
      }
    }
    if (!best) return;
    updateActiveView((view) => ({
      ...view,
      panels: view.panels.map((item) => (item.id === selectedPanelId ? movePanel(item, best!.dx, best!.dy) : item)),
    }));
    setStatus(`Snapped ${panel.name} to nearest guide anchor.`);
  }

  function exportPreview() {
    if (!canvasRef.current) return;
    void renderMockupToCanvas(canvasRef.current, activeView!, { artworkPanels }, imageCache).then(() => {
      exportCanvasAsPng(canvasRef.current!, `${activeViewId || "mockup"}-preview.png`);
      void redraw();
    });
  }

  async function loadCalibrationFile(file?: File) {
    if (!file) return;
    const text = await file.text();
    const parsed = JSON.parse(text) as MockupCalibration;
    setCalibration(parsed);
    setActiveViewId(firstViewId(parsed));
    setStatus("Calibration JSON loaded.");
  }

  if (!activeView) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <div className="rounded-lg border bg-background p-6">{status}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/30 p-4 md:p-6">
      <div className="mx-auto max-w-[1800px] space-y-4">
        <div className="rounded-xl border bg-background p-4 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Prototype</p>
              <h1 className="text-2xl font-bold">Instant Mockup Calibration Engine</h1>
              <p className="max-w-3xl text-sm text-muted-foreground">
                Calibrate local 2D hoodie previews against Printify references. This page does not call Printify or publish products.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => saveCalibrationToStorage(calibration)}>
                Save Local
              </Button>
              <Button variant="outline" onClick={() => downloadJson("zip-hoodie-aop.calibration.json", calibration)}>
                Download JSON
              </Button>
              <Button variant="outline" onClick={snapSelectedPanelToGuide} disabled={!selectedPanelId}>
                Snap Panel
              </Button>
              <Button onClick={exportPreview}>Export PNG</Button>
            </div>
          </div>
          <div className="mt-3 text-xs text-muted-foreground">{status}</div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)_380px]">
          <aside className="space-y-4">
            <div className="space-y-3 rounded-lg border bg-background p-4">
              <h3 className="text-sm font-semibold">Files and View</h3>
              <Label className="space-y-1 text-xs">
                <span>View</span>
                <select
                  className="h-10 w-full rounded-md border bg-background px-2 text-sm"
                  value={activeViewId}
                  onChange={(event) => {
                    setActiveViewId(event.target.value);
                    setSelectedPanelId(null);
                    setSelectedGuideId(null);
                  }}
                >
                  {Object.values(calibration.views).map((view) => (
                    <option key={view.id} value={view.id}>
                      {view.name}
                    </option>
                  ))}
                </select>
              </Label>
              <Label className="space-y-1 text-xs">
                <span>Base mockup image</span>
                <Input type="file" accept="image/*" onChange={(event) => void uploadViewImage("baseImageUrl", event.target.files?.[0])} />
              </Label>
              <Label className="space-y-1 text-xs">
                <span>Printify reference image</span>
                <Input type="file" accept="image/*" onChange={(event) => void uploadViewImage("referenceImageUrl", event.target.files?.[0])} />
              </Label>
              <Label className="space-y-1 text-xs">
                <span>Artwork panel images</span>
                <Input type="file" accept="image/*" multiple onChange={(event) => void uploadArtwork(event.target.files)} />
              </Label>
              <Label className="space-y-1 text-xs">
                <span>Shadow overlay image</span>
                <Input type="file" accept="image/*" onChange={(event) => void uploadViewImage("shadowOverlayUrl", event.target.files?.[0])} />
              </Label>
              <Label className="space-y-1 text-xs">
                <span>Highlight overlay image</span>
                <Input type="file" accept="image/*" onChange={(event) => void uploadViewImage("highlightOverlayUrl", event.target.files?.[0])} />
              </Label>
              <Label className="space-y-1 text-xs">
                <span>Load calibration JSON</span>
                <Input type="file" accept="application/json,.json" onChange={(event) => void loadCalibrationFile(event.target.files?.[0])} />
              </Label>
            </div>

            <div className="space-y-3 rounded-lg border bg-background p-4">
              <h3 className="text-sm font-semibold">Assist Calibration</h3>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="assist-mode" className="text-xs">Assist mode</Label>
                <Switch id="assist-mode" checked={assistMode} onCheckedChange={setAssistMode} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="reference-overlay" className="text-xs">Reference overlay</Label>
                <Switch id="reference-overlay" checked={showReferenceOverlay} onCheckedChange={setShowReferenceOverlay} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="panel-bounds" className="text-xs">Panel boxes and handles</Label>
                <Switch id="panel-bounds" checked={showPanelBounds} onCheckedChange={setShowPanelBounds} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="guide-toggle" className="text-xs">Guides</Label>
                <Switch id="guide-toggle" checked={showGuides} onCheckedChange={setShowGuides} />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Reference opacity: {Math.round(referenceOpacity * 100)}%</Label>
                <Slider
                  value={[activeView.referenceTransform?.opacity ?? referenceOpacity]}
                  min={0}
                  max={1}
                  step={0.05}
                  onValueChange={([value]) => {
                    const opacity = value ?? 0.5;
                    setReferenceOpacity(opacity);
                    updateReferenceTransform({ opacity });
                  }}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Label className="space-y-1 text-xs">
                  <span>Reference fit</span>
                  <select
                    className="h-9 w-full rounded-md border bg-background px-2"
                    value={activeView.referenceTransform?.fitMode ?? "contain"}
                    onChange={(event) => updateReferenceTransform({ fitMode: event.target.value as any })}
                  >
                    <option value="contain">Contain</option>
                    <option value="cover">Cover</option>
                    <option value="stretch">Stretch</option>
                    <option value="manual">Manual</option>
                  </select>
                </Label>
                <Label className="space-y-1 text-xs">
                  <span>Ref rotation</span>
                  <Input
                    type="number"
                    value={activeView.referenceTransform?.rotation ?? 0}
                    onChange={(event) => updateReferenceTransform({ rotation: Number(event.target.value) || 0 })}
                  />
                </Label>
                <Label className="space-y-1 text-xs">
                  <span>Ref X offset</span>
                  <Input
                    type="number"
                    value={activeView.referenceTransform?.x ?? 0}
                    onChange={(event) => updateReferenceTransform({ x: Number(event.target.value) || 0 })}
                  />
                </Label>
                <Label className="space-y-1 text-xs">
                  <span>Ref Y offset</span>
                  <Input
                    type="number"
                    value={activeView.referenceTransform?.y ?? 0}
                    onChange={(event) => updateReferenceTransform({ y: Number(event.target.value) || 0 })}
                  />
                </Label>
                <Label className="space-y-1 text-xs">
                  <span>Ref scale X</span>
                  <Input
                    type="number"
                    step="0.05"
                    value={activeView.referenceTransform?.scaleX ?? 1}
                    onChange={(event) => updateReferenceTransform({ scaleX: Number(event.target.value) || 1 })}
                  />
                </Label>
                <Label className="space-y-1 text-xs">
                  <span>Ref scale Y</span>
                  <Input
                    type="number"
                    step="0.05"
                    value={activeView.referenceTransform?.scaleY ?? 1}
                    onChange={(event) => updateReferenceTransform({ scaleY: Number(event.target.value) || 1 })}
                  />
                </Label>
              </div>
            </div>

            <div className="rounded-lg border bg-background p-4">
              <h3 className="mb-2 text-sm font-semibold">Loaded Artwork Panels</h3>
              <div className="space-y-2">
                {artworkPanels.length ? (
                  artworkPanels.map((asset) => (
                    <div key={asset.name} className="flex items-center gap-2 rounded-md border p-2">
                      <img src={asset.url} alt={asset.name} className="h-10 w-10 rounded object-cover" />
                      <span className="min-w-0 flex-1 truncate text-xs">{asset.name}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">Upload panel images such as hood_left_opening and hood_right_opening.</p>
                )}
              </div>
            </div>
          </aside>

          <main className="space-y-4">
            <div className="rounded-lg border bg-background p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">{activeView.name}</h2>
                  <p className="text-xs text-muted-foreground">
                    Drag panels or guide points. Hood-up calibration starts with left/right hood opening panels and neckline collar.
                  </p>
                </div>
                <div className="text-xs text-muted-foreground">
                  {activeView.width} × {activeView.height}
                </div>
              </div>
              <canvas
                ref={canvasRef}
                className="h-auto w-full touch-none rounded-md border bg-white"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
              />
            </div>
            <MockupPreviewComparison
              view={activeView}
              artworkPanels={artworkPanels}
              referenceOpacity={referenceOpacity}
              showReferenceOverlay={showReferenceOverlay}
            />
          </main>

          <aside className="space-y-4">
            <PanelControls
              panels={activeView.panels}
              selectedPanelId={selectedPanelId}
              artworkPanels={artworkPanels}
              onSelectPanel={(panelId) => {
                setSelectedPanelId(panelId);
                setSelectedGuideId(null);
              }}
              onUpdatePanel={updatePanel}
              onAddPanel={addPanel}
              onDuplicatePanel={duplicatePanel}
              onDeletePanel={deletePanel}
              onNudgeZIndex={(panelId, direction) => {
                const panel = activeView.panels.find((item) => item.id === panelId);
                if (!panel) return;
                updatePanel(panelId, { zIndex: panel.zIndex + (direction === "up" ? 1 : -1) });
              }}
              onAssignArtworkToSelected={assignArtworkToSelected}
              onAssignArtworkToVisible={assignArtworkToVisible}
              onUploadMask={(panelId, file) => void uploadPanelMask(panelId, file)}
            />
            <GuideEditor
              guides={activeView.guides}
              selectedGuideId={selectedGuideId}
              onSelectGuide={(guideId) => {
                setSelectedGuideId(guideId);
                setSelectedPanelId(null);
              }}
              onUpdateGuide={updateGuide}
              onAddGuide={addGuide}
              onDeleteGuide={deleteGuide}
            />
            <CalibrationJsonEditor
              calibration={calibration}
              onApply={(next) => {
                setCalibration(next);
                setActiveViewId(firstViewId(next));
              }}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}
