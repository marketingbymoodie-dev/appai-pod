import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type {
  CalibrationImport,
  CalibrationState,
  DebugFlags,
  DetectionImport,
  RenderPreviewMode,
  ViewId,
} from "./types";
import type { CalibrationActions } from "./useCalibration";

type Props = {
  state: CalibrationState;
  actions: CalibrationActions;
  view: ViewId;
  selectedPanel: string | null;
  debug: DebugFlags;
  setDebug: (next: Partial<DebugFlags>) => void;
  mode: "select" | "mesh" | "mask";
  setMode: (m: "select" | "mesh" | "mask") => void;
  onSave: (label: string) => void;
  onLoad: (label: string) => void;
  onExportJson: () => void;
  onTestRender: () => void;
  savedCalibrations: Array<{ name: string; updatedAt: string }>;
  saveTarget: string;
  setSaveTarget: (label: string) => void;
  panelDetections: Record<string, DetectionImport>;
  onImportDetection: (file: File) => void;
  onClearDetection: () => void;
  panelCalibrations: Record<string, CalibrationImport>;
  onBuildCalibration: () => void;
  onImportCalibration: (file: File) => void;
  onClearCalibration: () => void;
};

export default function PropertiesPanel(props: Props) {
  const {
    state,
    actions,
    view,
    selectedPanel,
    debug,
    setDebug,
    mode,
    setMode,
    onSave,
    onLoad,
    onExportJson,
    onTestRender,
    savedCalibrations,
    saveTarget,
    setSaveTarget,
    panelDetections,
    onImportDetection,
    onClearDetection,
    panelCalibrations,
    onBuildCalibration,
    onImportCalibration,
    onClearCalibration,
  } = props;
  const panel = selectedPanel ? state.views[view].panels[selectedPanel] : null;
  const detection = selectedPanel ? panelDetections[selectedPanel] : null;
  const calibration = selectedPanel ? panelCalibrations[selectedPanel] : null;
  const detectionInputRef = useRef<HTMLInputElement | null>(null);
  const calibrationInputRef = useRef<HTMLInputElement | null>(null);

  function applyReconstructionOnlyPreset() {
    setDebug({
      reconstructionOnlyPreview: true,
      renderPreviewMode: "warped",
      mockupOpacity: 0,
      warpedPanelOpacity: 1,
      showMockupEdges: false,
      showMesh: false,
      showOnionSkin: false,
      blinkCompare: false,
    });
  }
  function exitReconstructionOnly() {
    setDebug({
      reconstructionOnlyPreview: false,
      renderPreviewMode: "clipped",
      mockupOpacity: 1,
      warpedPanelOpacity: 0.75,
      showMesh: true,
    });
  }

  return (
    <div className="flex h-full w-80 flex-col border-l border-slate-800 bg-slate-900 text-slate-200" data-testid="aop-mapper-properties">
      <div className="border-b border-slate-800 px-3 py-2 text-sm font-semibold">Properties</div>

      <div className="flex-1 overflow-y-auto px-3 py-2 text-sm">
        <Section title="Edit mode">
          <div className="grid grid-cols-3 gap-1">
            {(["select", "mesh", "mask"] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={mode === m ? "default" : "outline"}
                onClick={() => setMode(m)}
                data-testid={`aop-mapper-mode-${m}`}
              >
                {m}
              </Button>
            ))}
          </div>
          <div className="mt-2 text-[11px] text-slate-400">
            Select: drag panels, zoom/pan canvas. Mesh: drag mesh handles. Mask: click canvas to add polygon vertex; drag to move; double-click to delete.
          </div>
        </Section>

        <Section title="Render preview">
          <div className="grid grid-cols-4 gap-1">
            {(["source", "warped", "clipped", "difference"] as RenderPreviewMode[]).map((previewMode) => (
              <Button
                key={previewMode}
                size="sm"
                variant={debug.renderPreviewMode === previewMode ? "default" : "outline"}
                onClick={() => setDebug({ renderPreviewMode: previewMode })}
                className="px-1 text-[11px]"
                data-testid={`aop-mapper-preview-${previewMode}`}
              >
                {previewMode}
              </Button>
            ))}
          </div>
          <div className="mt-2 space-y-2">
            <LabelRow label={`Mockup opacity ${Math.round(debug.mockupOpacity * 100)}%`}>
              <Slider value={[debug.mockupOpacity * 100]} min={0} max={100} step={1} onValueChange={([v]) => setDebug({ mockupOpacity: v / 100 })} />
            </LabelRow>
            <LabelRow label={`Warped panel opacity ${Math.round(debug.warpedPanelOpacity * 100)}%`}>
              <Slider value={[debug.warpedPanelOpacity * 100]} min={0} max={100} step={1} onValueChange={([v]) => setDebug({ warpedPanelOpacity: v / 100 })} />
            </LabelRow>
            <DebugToggle label="Blink compare" checked={debug.blinkCompare} onChange={(c) => setDebug({ blinkCompare: c })} />
            <DebugToggle label="Final output preview" checked={debug.showFinalPreview} onChange={(c) => setDebug({ showFinalPreview: c })} />
          </div>
        </Section>

        <Section title="Selected panel">
          {!panel && <div className="text-xs text-slate-400">No panel selected.</div>}
          {panel && (
            <div className="space-y-2">
              <div className="text-xs">
                <div className="font-semibold">{panel.panelKey}</div>
                <div className="text-slate-400">
                  source {panel.sourceSize?.width}×{panel.sourceSize?.height} | mesh {panel.mesh.cols}×{panel.mesh.rows} ({panel.mesh.points.length} pts)
                </div>
              </div>
              <LabelRow label={`Opacity ${(panel.opacity * 100).toFixed(0)}%`}>
                <Slider value={[panel.opacity * 100]} min={0} max={100} step={1} onValueChange={([v]) => actions.patchPanel(view, panel.panelKey, { opacity: v / 100 })} />
              </LabelRow>
              <div className="flex items-center justify-between text-xs">
                <span>Visible</span>
                <Switch checked={panel.visible} onCheckedChange={(c) => actions.patchPanel(view, panel.panelKey, { visible: c })} />
              </div>
              <div className="flex items-center justify-between text-xs">
                <span>Locked</span>
                <Switch checked={panel.locked} onCheckedChange={(c) => actions.patchPanel(view, panel.panelKey, { locked: c })} />
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <LabelRow label="Mesh cols">
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    value={panel.mesh.cols}
                    onChange={(e) => {
                      const cols = Math.max(1, Math.min(20, Number(e.target.value)));
                      actions.setMeshDensity(view, panel.panelKey, cols, panel.mesh.rows);
                    }}
                  />
                </LabelRow>
                <LabelRow label="Mesh rows">
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    value={panel.mesh.rows}
                    onChange={(e) => {
                      const rows = Math.max(1, Math.min(20, Number(e.target.value)));
                      actions.setMeshDensity(view, panel.panelKey, panel.mesh.cols, rows);
                    }}
                  />
                </LabelRow>
              </div>
              <div className="grid grid-cols-3 gap-1 text-xs">
                <Button size="sm" variant="outline" onClick={() => actions.transformMesh(view, panel.panelKey, { dx: -10 })}>← 10px</Button>
                <Button size="sm" variant="outline" onClick={() => actions.transformMesh(view, panel.panelKey, { scale: 1.05 })}>scale +5%</Button>
                <Button size="sm" variant="outline" onClick={() => actions.transformMesh(view, panel.panelKey, { dx: 10 })}>10px →</Button>
                <Button size="sm" variant="outline" onClick={() => actions.transformMesh(view, panel.panelKey, { dy: -10 })}>↑ 10px</Button>
                <Button size="sm" variant="outline" onClick={() => actions.transformMesh(view, panel.panelKey, { scale: 1 / 1.05 })}>scale -5%</Button>
                <Button size="sm" variant="outline" onClick={() => actions.transformMesh(view, panel.panelKey, { dy: 10 })}>↓ 10px</Button>
                <Button size="sm" variant="outline" onClick={() => actions.transformMesh(view, panel.panelKey, { rotation: -Math.PI / 90 })}>rot -2°</Button>
                <Button size="sm" variant="outline" onClick={() => actions.transformMesh(view, panel.panelKey, { rotation: Math.PI / 90 })}>rot +2°</Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (!panel.sourceSize || !state.views[view].mockupSize) return;
                    // Reset to a sensible default rectangle.
                    const w = state.views[view].mockupSize!.width;
                    const h = state.views[view].mockupSize!.height;
                    actions.setMeshDensity(view, panel.panelKey, panel.mesh.cols, panel.mesh.rows);
                  }}
                >
                  reset
                </Button>
              </div>
              <div className="grid grid-cols-3 gap-1 text-xs">
                <Button size="sm" variant="outline" onClick={() => actions.resetPanelMesh(view, panel.panelKey)}>reset mesh</Button>
                <Button size="sm" variant="outline" onClick={() => actions.resetPanelMask(view, panel.panelKey)}>reset mask</Button>
                <Button size="sm" variant="outline" onClick={() => actions.resetPanelTransform(view, panel.panelKey)}>reset transform</Button>
              </div>
            </div>
          )}
        </Section>

        <Section title="AI-assist (triangle CV)">
          {!panel && <div className="text-xs text-slate-400">Select a panel to import a detection.</div>}
          {panel && (
            <div className="space-y-2">
              <div className="text-[11px] text-slate-400">
                Import the JSON emitted by <code className="rounded bg-slate-800 px-1 py-0.5">npm run aop:triangle:detect -- --panel {panel.panelKey} --mockup &lt;path&gt;</code>.
                The mesh + mask suggestion is applied to <span className="font-semibold text-slate-200">{panel.panelKey}</span>.
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="default"
                  className="flex-1"
                  onClick={() => detectionInputRef.current?.click()}
                  data-testid="aop-mapper-import-detection"
                >
                  Auto-suggest mesh
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!detection}
                  onClick={() => onClearDetection()}
                  data-testid="aop-mapper-clear-detection"
                >
                  Clear overlay
                </Button>
              </div>
              <input
                ref={detectionInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  onImportDetection(file);
                  event.target.value = "";
                }}
              />
              {detection && (
                <div className="rounded border border-slate-800 bg-slate-950 p-2 text-[11px] text-slate-300" data-testid="aop-mapper-detection-summary">
                  <div className="font-semibold text-slate-200">{detection.panelName}</div>
                  <div>
                    {detection.stats?.accepted ?? 0} / {detection.stats?.totalTriangles ?? detection.detectedTriangles.length} triangles · avg conf {(((detection.stats?.averageConfidence ?? 0) * 100) | 0)}%
                  </div>
                  <div className="text-slate-400">
                    grid {detection.panelGrid.cols}×{detection.panelGrid.rows} · mockup {detection.mockupSize.width}×{detection.mockupSize.height}
                  </div>
                  {detection.detectedAt && <div className="text-slate-500">detected {detection.detectedAt.replace("T", " ").slice(0, 16)}</div>}
                  <div className="mt-1 grid grid-cols-2 gap-1">
                    <DebugToggle label="Triangles" checked={debug.showDetectionTriangles} onChange={(c) => setDebug({ showDetectionTriangles: c })} />
                    <DebugToggle label="Lines" checked={debug.showDetectionCorrespondences} onChange={(c) => setDebug({ showDetectionCorrespondences: c })} />
                    <DebugToggle label="Heatmap" checked={debug.showDetectionConfidenceHeatmap} onChange={(c) => setDebug({ showDetectionConfidenceHeatmap: c })} />
                    <DebugToggle label="Rejects" checked={debug.showDetectionRejected} onChange={(c) => setDebug({ showDetectionRejected: c })} />
                  </div>
                </div>
              )}
            </div>
          )}
        </Section>

        <Section title="Panel calibration (piecewise affine)">
          {!panel && <div className="text-xs text-slate-400">Select a panel to build or import calibration data.</div>}
          {panel && (
            <div className="space-y-2">
              <div className="text-[11px] text-slate-400">
                Build calibration from the imported detection (Gauss-Seidel solve), or import a JSON
                produced by <code className="rounded bg-slate-800 px-1 py-0.5">npm run aop:panel:calibrate -- --panel {panel.panelKey} --mockup &lt;path&gt;</code>.
                Either action replaces the mesh + mask for <span className="font-semibold text-slate-200">{panel.panelKey}</span>.
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  size="sm"
                  variant="default"
                  disabled={!detection}
                  onClick={() => onBuildCalibration()}
                  data-testid="aop-mapper-build-calibration"
                >
                  Build from detection
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => calibrationInputRef.current?.click()}
                  data-testid="aop-mapper-import-calibration"
                >
                  Import calibration JSON
                </Button>
              </div>
              <input
                ref={calibrationInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  onImportCalibration(file);
                  event.target.value = "";
                }}
              />
              <div className="grid grid-cols-2 gap-2">
                <Button
                  size="sm"
                  variant={debug.reconstructionOnlyPreview ? "default" : "outline"}
                  onClick={() => (debug.reconstructionOnlyPreview ? exitReconstructionOnly() : applyReconstructionOnlyPreset())}
                  data-testid="aop-mapper-reconstruction-only"
                >
                  {debug.reconstructionOnlyPreview ? "Exit reconstruction view" : "Show reconstruction only"}
                </Button>
                <Button
                  size="sm"
                  variant={debug.renderPreviewMode === "difference" ? "default" : "outline"}
                  onClick={() =>
                    setDebug({
                      renderPreviewMode: debug.renderPreviewMode === "difference" ? "clipped" : "difference",
                      mockupOpacity: 1,
                      warpedPanelOpacity: 0.85,
                      reconstructionOnlyPreview: false,
                    })
                  }
                  data-testid="aop-mapper-difference-overlay"
                >
                  {debug.renderPreviewMode === "difference" ? "Exit diff overlay" : "Diff vs mockup"}
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-1">
                <DebugToggle
                  label="Mask boundary"
                  checked={debug.showCalibrationMaskBoundary}
                  onChange={(c) => setDebug({ showCalibrationMaskBoundary: c })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!calibration}
                  onClick={() => onClearCalibration()}
                  data-testid="aop-mapper-clear-calibration"
                >
                  Clear calibration
                </Button>
              </div>
              {calibration && (
                <div className="rounded border border-slate-800 bg-slate-950 p-2 text-[11px] text-slate-300" data-testid="aop-mapper-calibration-summary">
                  <div className="font-semibold text-slate-200">{calibration.panelName}</div>
                  <div>
                    {calibration.quality.detectedTriangleCount}/{calibration.quality.totalTriangleCount ?? "?"} triangles · {calibration.quality.coveragePercent}% coverage · avg conf {(((calibration.quality.avgConfidence ?? 0) * 100) | 0)}%
                  </div>
                  <div className="text-slate-400">
                    mean centroid err {calibration.quality.meanCentroidErrorPx?.toFixed(2) ?? "?"}px · max {calibration.quality.maxCentroidErrorPx?.toFixed(2) ?? "?"}px
                  </div>
                  <div className="text-slate-400">
                    grid {calibration.panelGrid.cols}×{calibration.panelGrid.rows} · mockup {calibration.mockupSize.width}×{calibration.mockupSize.height}
                  </div>
                  <div className="text-slate-400">
                    mask: {calibration.mask.polygon.length} vertices ({calibration.mask.source})
                  </div>
                  {(calibration.quality.missingTriangleIds?.length || 0) > 0 && (
                    <div className="mt-1 truncate text-amber-300" title={(calibration.quality.missingTriangleIds || []).join(", ")}>
                      missing: {calibration.quality.missingTriangleIds?.length}
                    </div>
                  )}
                  {(calibration.quality.lowConfidenceTriangleIds?.length || 0) > 0 && (
                    <div className="truncate text-orange-300" title={(calibration.quality.lowConfidenceTriangleIds || []).join(", ")}>
                      low-confidence: {calibration.quality.lowConfidenceTriangleIds?.length}
                    </div>
                  )}
                  {calibration.builtAt && (
                    <div className="text-slate-500">built {calibration.builtAt.replace("T", " ").slice(0, 16)}</div>
                  )}
                </div>
              )}
            </div>
          )}
        </Section>

        <Section title="Debug overlays">
          <DebugToggle label="Mesh handles" checked={debug.showMesh} onChange={(c) => setDebug({ showMesh: c })} />
          <DebugToggle label="Mask polygon" checked={debug.showMask} onChange={(c) => setDebug({ showMask: c })} />
          <DebugToggle label="Panel bounds" checked={debug.showPanelBounds} onChange={(c) => setDebug({ showPanelBounds: c })} />
          <DebugToggle label="Distortion heatmap" checked={debug.showDistortionHeatmap} onChange={(c) => setDebug({ showDistortionHeatmap: c })} />
          <DebugToggle label="Garment seam guides" checked={debug.showGarmentSeamGuides} onChange={(c) => setDebug({ showGarmentSeamGuides: c })} />
          <DebugToggle label="Mockup contour edges" checked={debug.showMockupEdges} onChange={(c) => setDebug({ showMockupEdges: c })} />
          <DebugToggle label="Grid intersections" checked={debug.showGridIntersections} onChange={(c) => setDebug({ showGridIntersections: c })} />
          <DebugToggle label="High-contrast mockup" checked={debug.highContrast} onChange={(c) => setDebug({ highContrast: c })} />
        </Section>

        <Section title="Save / Load">
          <div className="flex gap-2">
            <Input
              value={saveTarget}
              onChange={(e) => setSaveTarget(e.target.value.replace(/[^a-zA-Z0-9_\-]/g, "_"))}
              placeholder="calibration-name"
              className="text-xs"
            />
            <Button size="sm" onClick={() => onSave(saveTarget)} data-testid="aop-mapper-save">
              Save
            </Button>
          </div>
          <Button size="sm" variant="outline" className="mt-1 w-full" onClick={onExportJson} data-testid="aop-mapper-export-json">
            Download JSON
          </Button>
          <Button size="sm" variant="outline" className="mt-1 w-full" onClick={onTestRender} data-testid="aop-mapper-test-render">
            Test render → PNG
          </Button>
          {savedCalibrations.length > 0 && (
            <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
              {savedCalibrations.map((c) => (
                <Button
                  key={c.name}
                  size="sm"
                  variant="ghost"
                  className="w-full justify-start text-xs"
                  onClick={() => onLoad(c.name)}
                >
                  {c.name} <span className="ml-auto text-[10px] text-slate-400">{c.updatedAt.slice(0, 16).replace("T", " ")}</span>
                </Button>
              ))}
            </div>
          )}
        </Section>

        <Section title="Product info">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <LabelRow label="productTypeId">
              <Input
                type="number"
                value={state.productTypeId ?? 0}
                onChange={(e) => actions.setProductInfo({ productTypeId: Number(e.target.value) || null })}
              />
            </LabelRow>
            <LabelRow label="blueprintId">
              <Input
                type="number"
                value={state.blueprintId ?? 0}
                onChange={(e) => actions.setProductInfo({ blueprintId: Number(e.target.value) || null })}
              />
            </LabelRow>
            <LabelRow label="providerId">
              <Input
                type="number"
                value={state.providerId ?? 0}
                onChange={(e) => actions.setProductInfo({ providerId: Number(e.target.value) || null })}
              />
            </LabelRow>
            <LabelRow label="size">
              <Input
                value={state.size ?? ""}
                onChange={(e) => actions.setProductInfo({ size: e.target.value || null })}
              />
            </LabelRow>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">{title}</div>
      <div>{children}</div>
    </div>
  );
}

function LabelRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-slate-400">{label}</Label>
      <div>{children}</div>
    </div>
  );
}

function DebugToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (c: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
