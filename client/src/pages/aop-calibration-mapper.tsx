import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Upload } from "lucide-react";
import MockupCanvas from "@/components/aop-calibration-mapper/MockupCanvas";
import PanelSidebar from "@/components/aop-calibration-mapper/PanelSidebar";
import PropertiesPanel from "@/components/aop-calibration-mapper/PropertiesPanel";
import { applyPanelTransformToMesh, drawMeshWarp } from "@/components/aop-calibration-mapper/meshUtils";
import {
  fileToImage,
  loadImageFromUrl,
} from "@/components/aop-calibration-mapper/fileLoaders";
import {
  emptyCalibration,
  useCalibration,
} from "@/components/aop-calibration-mapper/useCalibration";
import type {
  CalibrationImport,
  CalibrationState,
  DebugFlags,
  DetectionImport,
  PanelState,
  ViewId,
} from "@/components/aop-calibration-mapper/types";
import {
  buildCalibrationFromDetection,
  validateCalibrationImport,
} from "@/components/aop-calibration-mapper/calibrationMath";
import { buildAppUrl } from "@/lib/urlBase";

type SourcePanelMeta = {
  panelKey: string;
  source: string;
  url: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
};

type CalibrationListItem = { name: string; updatedAt: string; sizeBytes: number };

const DEFAULT_DEBUG: DebugFlags = {
  renderPreviewMode: "clipped",
  showMesh: true,
  showMask: false,
  showHandles: true,
  showPanelBounds: true,
  showOnionSkin: false,
  onionSkinOpacity: 0.3,
  mockupOpacity: 1,
  warpedPanelOpacity: 0.75,
  blinkCompare: false,
  showDistortionHeatmap: true,
  showGarmentSeamGuides: false,
  showMockupEdges: false,
  showGridIntersections: true,
  showFinalPreview: true,
  showOverlapHeatmap: false,
  highContrast: false,
  showDetectionTriangles: true,
  showDetectionCorrespondences: true,
  showDetectionConfidenceHeatmap: false,
  showDetectionRejected: true,
  showCalibrationMaskBoundary: true,
  showCalibrationDifference: false,
  reconstructionOnlyPreview: false,
};

export default function AopCalibrationMapperPage() {
  const { state, actions } = useCalibration();
  const { toast } = useToast();

  const [view, setView] = useState<ViewId>("front");
  const [selectedPanel, setSelectedPanel] = useState<string | null>(null);
  const [mode, setMode] = useState<"select" | "mesh" | "mask">("select");
  const [debug, setDebugFlags] = useState<DebugFlags>(DEFAULT_DEBUG);
  const [saveTarget, setSaveTarget] = useState("zip-hoodie-aop-L");

  const [sourcePanels, setSourcePanels] = useState<SourcePanelMeta[]>([]);
  const [calibrationMockups, setCalibrationMockups] = useState<{
    runId: string | null;
    front: string | null;
    back: string | null;
  }>({ runId: null, front: null, back: null });
  const [savedCalibrations, setSavedCalibrations] = useState<CalibrationListItem[]>([]);
  const [calibrationsDir, setCalibrationsDir] = useState<string>("tmp/aop-calibrations");
  const [panelDetections, setPanelDetections] = useState<Record<string, DetectionImport>>({});
  const [panelCalibrations, setPanelCalibrations] = useState<Record<string, CalibrationImport>>({});

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });

  // Resize canvas to fill container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setCanvasSize({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    setCanvasSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  // Initial fetch: source panels, calibration mockups, saved calibrations
  useEffect(() => {
    refreshSourcePanels();
    refreshCalibrationMockups();
    refreshSavedCalibrations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshSourcePanels() {
    try {
      const r = await fetch(buildAppUrl("/api/dev/aop-mapper/source-panels"));
      if (!r.ok) return;
      const data = (await r.json()) as { panels: SourcePanelMeta[] };
      setSourcePanels(data.panels);
    } catch {
      /* ignore */
    }
  }

  async function refreshCalibrationMockups() {
    try {
      const r = await fetch(buildAppUrl("/api/dev/aop-mapper/calibration-mockups"));
      if (!r.ok) return;
      const data = (await r.json()) as {
        runId: string | null;
        views: Array<{ view: "front" | "back"; url: string }>;
      };
      const front = data.views.find((v) => v.view === "front")?.url ?? null;
      const back = data.views.find((v) => v.view === "back")?.url ?? null;
      setCalibrationMockups({ runId: data.runId, front, back });
    } catch {
      /* ignore */
    }
  }

  async function refreshSavedCalibrations() {
    try {
      const r = await fetch(buildAppUrl("/api/dev/aop-mapper/calibrations"));
      if (!r.ok) return;
      const data = (await r.json()) as { directory: string; calibrations: CalibrationListItem[] };
      setSavedCalibrations(data.calibrations);
      setCalibrationsDir(data.directory);
    } catch {
      /* ignore */
    }
  }

  async function loadMockupFromUrl(targetView: ViewId, url: string) {
    const meta = await loadImageFromUrl(url);
    if (!meta) {
      toast({ title: "Failed to load mockup", description: url, variant: "destructive" });
      return;
    }
    actions.setMockup(targetView, url, { width: meta.width, height: meta.height });
  }

  async function uploadMockup(targetView: ViewId, file: File) {
    const { src, width, height } = await fileToImage(file);
    actions.setMockup(targetView, src, { width, height });
  }

  async function loadStarterAssets() {
    // Mockups
    if (calibrationMockups.front) await loadMockupFromUrl("front", calibrationMockups.front);
    if (calibrationMockups.back) await loadMockupFromUrl("back", calibrationMockups.back);
    // Panels: prefer the "source-panels" source (locally rasterized panels)
    for (const meta of sourcePanels) {
      if (meta.source !== "source-panels") continue;
      const dim = await loadImageFromUrl(meta.url);
      if (!dim) continue;
      // Decide which view to add to based on panel name (back panel → back view, all others → front view)
      const targetView: ViewId = meta.panelKey === "back" ? "back" : "front";
      actions.addPanel(targetView, meta.panelKey, { width: dim.width, height: dim.height }, meta.url);
    }
    toast({ title: "Starter assets loaded", description: "Mockups + 12 panels added. Switch front/back to inspect." });
  }

  function buildSerializableState(): CalibrationState {
    return JSON.parse(JSON.stringify(state)) as CalibrationState;
  }

  async function onSave(label: string) {
    const safe = label.replace(/[^a-zA-Z0-9_\-]/g, "_");
    if (!safe) return;
    actions.setMeta({ label: safe, updatedAt: new Date().toISOString() });
    const payload = { ...buildSerializableState(), meta: { ...state.meta, label: safe, updatedAt: new Date().toISOString() } };
    const r = await fetch(buildAppUrl(`/api/dev/aop-mapper/calibrations/${encodeURIComponent(safe)}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => "");
      toast({ title: "Save failed", description: err.slice(0, 200), variant: "destructive" });
      return;
    }
    const data = (await r.json()) as { ok: boolean; file: string };
    toast({ title: "Calibration saved", description: data.file });
    refreshSavedCalibrations();
  }

  async function onLoad(label: string) {
    const r = await fetch(buildAppUrl(`/api/dev/aop-mapper/calibrations/${encodeURIComponent(label)}`));
    if (!r.ok) {
      toast({ title: "Load failed", description: `${r.status}`, variant: "destructive" });
      return;
    }
    const json = (await r.json()) as CalibrationState;
    actions.load(json);
    toast({ title: "Calibration loaded", description: label });
  }

  async function importDetectionFile(panelKey: string | null, file: File) {
    if (!panelKey) {
      toast({
        title: "Select a panel first",
        description: "Pick a target panel before importing a detection JSON.",
        variant: "destructive",
      });
      return;
    }
    const text = await file.text();
    let detection: DetectionImport;
    try {
      detection = JSON.parse(text) as DetectionImport;
    } catch (err) {
      toast({ title: "Invalid detection JSON", description: (err as Error).message, variant: "destructive" });
      return;
    }
    if (!detection?.suggestedMesh?.points?.length) {
      toast({ title: "Detection missing mesh", description: "JSON has no suggestedMesh.points", variant: "destructive" });
      return;
    }
    const targetView: ViewId = state.views.front.panels[panelKey] ? "front" : state.views.back.panels[panelKey] ? "back" : view;
    const panel = state.views[targetView].panels[panelKey];
    if (!panel) {
      toast({ title: "Panel not found", description: `${panelKey} on ${targetView}`, variant: "destructive" });
      return;
    }

    const cols = detection.suggestedMesh.cols;
    const rows = detection.suggestedMesh.rows;
    if (detection.suggestedMesh.points.length !== (cols + 1) * (rows + 1)) {
      toast({
        title: "Mesh size mismatch",
        description: `Expected ${(cols + 1) * (rows + 1)} points, got ${detection.suggestedMesh.points.length}.`,
        variant: "destructive",
      });
      return;
    }

    actions.replaceMesh(targetView, panelKey, {
      cols,
      rows,
      points: detection.suggestedMesh.points.map((p) => ({ u: p.u, v: p.v, x: p.x, y: p.y })),
    }, true);
    if (detection.suggestedMask && detection.suggestedMask.length >= 3) {
      actions.setMaskPolygon(targetView, panelKey, detection.suggestedMask);
    }
    setPanelDetections((prev) => ({ ...prev, [panelKey]: detection }));
    toast({
      title: "Auto-suggest applied",
      description: `${panelKey}: ${detection.stats?.accepted ?? "?"} / ${detection.stats?.totalTriangles ?? "?"} triangles, mesh ${cols}x${rows}.`,
    });
  }

  function clearDetectionFor(panelKey: string) {
    setPanelDetections((prev) => {
      const next = { ...prev };
      delete next[panelKey];
      return next;
    });
  }

  function applyCalibrationToPanel(targetView: ViewId, panelKey: string, calibration: CalibrationImport) {
    const panel = state.views[targetView].panels[panelKey];
    if (!panel) {
      toast({ title: "Panel not found", description: `${panelKey} on ${targetView}`, variant: "destructive" });
      return;
    }
    const cols = calibration.mesh.cols;
    const rows = calibration.mesh.rows;
    if (calibration.mesh.points.length !== (cols + 1) * (rows + 1)) {
      toast({
        title: "Mesh size mismatch",
        description: `Expected ${(cols + 1) * (rows + 1)} mesh points, got ${calibration.mesh.points.length}.`,
        variant: "destructive",
      });
      return;
    }
    actions.replaceMesh(
      targetView,
      panelKey,
      {
        cols,
        rows,
        points: calibration.mesh.points.map((p) => ({ u: p.u, v: p.v, x: p.x, y: p.y })),
      },
      true,
    );

    let maskUV: Array<{ u: number; v: number }> | null = null;
    if (calibration.mask.polygonUV && calibration.mask.polygonUV.length >= 3) {
      maskUV = calibration.mask.polygonUV.map(([u, v]) => ({ u, v }));
    } else if (calibration.mask.polygon && calibration.mask.polygon.length >= 3) {
      // Fallback: derive UV from mockup-XY polygon by walking the mesh perimeter
      // (for backwards compatibility with hand-edited calibration files).
      maskUV = calibration.mask.polygon.map(([x, y]) => {
        const W = calibration.mockupSize.width || 1;
        const H = calibration.mockupSize.height || 1;
        return { u: x / W, v: y / H };
      });
    }
    if (maskUV) actions.setMaskPolygon(targetView, panelKey, maskUV);

    setPanelCalibrations((prev) => ({ ...prev, [panelKey]: calibration }));
    toast({
      title: "Calibration applied",
      description: `${panelKey}: ${calibration.quality.detectedTriangleCount}/${calibration.quality.totalTriangleCount ?? "?"} triangles · ${calibration.quality.coveragePercent}% coverage`,
    });
  }

  function buildCalibrationFromDetectionAction(panelKey: string | null) {
    if (!panelKey) {
      toast({ title: "Select a panel first", variant: "destructive" });
      return;
    }
    const detection = panelDetections[panelKey];
    if (!detection) {
      toast({
        title: "No detection imported",
        description: "Run 'Auto-suggest mesh' to import a detection JSON for this panel first.",
        variant: "destructive",
      });
      return;
    }
    const targetView: ViewId = state.views.front.panels[panelKey] ? "front" : state.views.back.panels[panelKey] ? "back" : view;
    const panel = state.views[targetView].panels[panelKey];
    if (!panel) {
      toast({ title: "Panel not found", description: panelKey, variant: "destructive" });
      return;
    }
    const sourceSize = panel.sourceSize ?? { width: detection.mockupSize.width, height: detection.mockupSize.height };
    const calibration = buildCalibrationFromDetection(detection, sourceSize);
    applyCalibrationToPanel(targetView, panelKey, calibration);
  }

  async function importCalibrationFile(panelKey: string | null, file: File) {
    if (!panelKey) {
      toast({ title: "Select a panel first", variant: "destructive" });
      return;
    }
    let calibration: CalibrationImport;
    try {
      const raw = JSON.parse(await file.text());
      calibration = validateCalibrationImport(raw);
    } catch (err) {
      toast({ title: "Invalid calibration JSON", description: (err as Error).message, variant: "destructive" });
      return;
    }
    const targetView: ViewId = state.views.front.panels[panelKey] ? "front" : state.views.back.panels[panelKey] ? "back" : view;
    applyCalibrationToPanel(targetView, panelKey, calibration);
  }

  function clearCalibrationFor(panelKey: string) {
    setPanelCalibrations((prev) => {
      const next = { ...prev };
      delete next[panelKey];
      return next;
    });
  }

  function onExportJson() {
    const payload = buildSerializableState();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${payload.meta.label || "calibration"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Client-side test render: composite warped panels onto base mockup, download PNG.
  async function onTestRender() {
    const viewState = state.views[view];
    if (!viewState.mockupSrc || !viewState.mockupSize) {
      toast({ title: "Cannot test render", description: "Load a mockup first.", variant: "destructive" });
      return;
    }
    const mockupImg = await loadImageFromUrl(viewState.mockupSrc);
    if (!mockupImg) {
      toast({ title: "Mockup load failed", variant: "destructive" });
      return;
    }
    const { width: W, height: H } = viewState.mockupSize;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: false });
    if (!ctx) return;
    ctx.drawImage(mockupImg.image, 0, 0, W, H);
    const sortedPanels = [...viewState.panelOrder]
      .map((k) => viewState.panels[k])
      .filter((p): p is PanelState => Boolean(p))
      .sort((a, b) => a.zIndex - b.zIndex);
    for (const panel of sortedPanels) {
      if (!panel.visible || !panel.artworkSrc) continue;
      const meta = await loadImageFromUrl(panel.artworkSrc);
      if (!meta) continue;
      drawMeshWarp(ctx, meta.image, panel.sourceSize ?? { width: meta.width, height: meta.height }, applyPanelTransformToMesh(panel.mesh, panel.transform), {
        opacity: panel.opacity,
        mask: panel.mask?.polygon ?? null,
      });
    }
    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${state.meta.label || "calibration"}-${view}-test.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast({ title: "Test render complete", description: `${a.download}` });
  }

  const setDebug = useCallback(
    (next: Partial<DebugFlags>) => setDebugFlags((prev) => ({ ...prev, ...next })),
    [],
  );

  const viewState = state.views[view];

  return (
    <div className="flex h-screen w-full flex-col bg-slate-950 text-slate-100" data-testid="aop-mapper-page">
      <header className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-2">
        <div className="flex items-center gap-3">
          <div className="text-base font-semibold">AOP Calibration Mapper</div>
          <div className="text-xs text-slate-400">manual perspective + mesh + mask</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded border border-slate-700">
            {(["front", "back"] as const).map((v) => (
              <Button
                key={v}
                size="sm"
                variant={view === v ? "default" : "ghost"}
                onClick={() => setView(v)}
                data-testid={`aop-mapper-view-${v}`}
                className="rounded-none border-0"
              >
                {v}
              </Button>
            ))}
          </div>
          <MockupUploadButton viewId={view} onUpload={(file) => uploadMockup(view, file)} hasMockup={Boolean(viewState.mockupSrc)} />
          {calibrationMockups.runId && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (calibrationMockups.front) loadMockupFromUrl("front", calibrationMockups.front);
                if (calibrationMockups.back) loadMockupFromUrl("back", calibrationMockups.back);
              }}
              data-testid="aop-mapper-load-calibration-mockups"
            >
              Load run {calibrationMockups.runId.slice(0, 8)}
            </Button>
          )}
          <Button size="sm" variant="default" onClick={loadStarterAssets} data-testid="aop-mapper-load-starter-top">
            Load starter assets
          </Button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <PanelSidebar
          state={state}
          actions={actions}
          view={view}
          selectedPanel={selectedPanel}
          setSelectedPanel={setSelectedPanel}
          availableSourcePanels={sourcePanels}
          onLoadStarter={loadStarterAssets}
        />

        <div ref={containerRef} className="relative flex-1 min-w-0">
          {!viewState.mockupSrc && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-slate-950/95 text-center text-slate-300">
              <div className="text-sm">No {view} mockup loaded yet.</div>
              <div className="flex gap-2">
                <MockupUploadButton viewId={view} onUpload={(file) => uploadMockup(view, file)} hasMockup={false} />
                {calibrationMockups[view] && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => loadMockupFromUrl(view, calibrationMockups[view]!)}
                  >
                    Use latest calibration {view}
                  </Button>
                )}
                <Button size="sm" variant="default" onClick={loadStarterAssets}>
                  Load starter assets
                </Button>
              </div>
              <div className="text-[11px] text-slate-500">
                Calibration runs load from <code>tmp/aop-calibration/run-summary-*.json</code>; saved calibrations live in <code>{calibrationsDir}</code>
              </div>
            </div>
          )}
          <MockupCanvas
            state={state}
            actions={actions}
            view={view}
            selectedPanel={selectedPanel}
            setSelectedPanel={setSelectedPanel}
            mode={mode}
            debug={debug}
            width={canvasSize.width}
            height={canvasSize.height}
            detections={panelDetections}
            calibrations={panelCalibrations}
          />
        </div>

        <PropertiesPanel
          state={state}
          actions={actions}
          view={view}
          selectedPanel={selectedPanel}
          debug={debug}
          setDebug={setDebug}
          mode={mode}
          setMode={setMode}
          onSave={onSave}
          onLoad={onLoad}
          onExportJson={onExportJson}
          onTestRender={onTestRender}
          savedCalibrations={savedCalibrations}
          saveTarget={saveTarget}
          setSaveTarget={setSaveTarget}
          panelDetections={panelDetections}
          onImportDetection={(file) => importDetectionFile(selectedPanel, file)}
          onClearDetection={() => selectedPanel && clearDetectionFor(selectedPanel)}
          panelCalibrations={panelCalibrations}
          onBuildCalibration={() => buildCalibrationFromDetectionAction(selectedPanel)}
          onImportCalibration={(file) => importCalibrationFile(selectedPanel, file)}
          onClearCalibration={() => selectedPanel && clearCalibrationFor(selectedPanel)}
        />
      </div>
    </div>
  );
}

function MockupUploadButton({
  viewId,
  onUpload,
  hasMockup,
}: {
  viewId: ViewId;
  onUpload: (file: File) => void;
  hasMockup: boolean;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700" data-testid={`aop-mapper-upload-${viewId}`}>
      <Upload className="h-3.5 w-3.5" />
      {hasMockup ? `Replace ${viewId} mockup` : `Upload ${viewId} mockup`}
      <input
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(file);
        }}
      />
    </label>
  );
}
