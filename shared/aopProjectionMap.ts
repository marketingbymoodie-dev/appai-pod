export type AopProjectionViewName = "front" | "back" | string;

export type AopProjectionPoint = {
  x: number;
  y: number;
};

export type AopRenderQualityMode = "draft" | "balanced" | "production";

export type AopPanelCurvature = "low" | "medium" | "high";

export type AopProjectionGridPoint = {
  id: string;
  source: AopProjectionPoint;
  target: AopProjectionPoint;
  confidence?: number;
  note?: string;
};

export type AopProjectionDebugArtifacts = {
  detectedPointsUrl?: string;
  detectedPointsJsonUrl?: string;
  meshUrl?: string;
  renderDebugUrl?: string;
  overlayUrl?: string;
  shadowLayerUrl?: string;
  highlightLayerUrl?: string;
  maskLayerUrl?: string;
  warpDensityUrl?: string;
  seamContinuityUrl?: string;
  adaptiveMeshUrl?: string;
  uvContinuityUrl?: string;
  seamErrorUrl?: string;
  seamBlendUrl?: string;
};

export type AopProjectionDetectionStats = {
  detectedPointCount: number;
  expectedPointCount?: number;
  meshCellCount: number;
  confidence: number;
  detector: string;
  failed?: boolean;
  fallbackReason?: string;
  notes?: string[];
};

export type AopProjectionSourceRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  unit?: "pixels" | "normalized";
};

export type AopProjectionMeshCell = {
  id: string;
  source: {
    topLeft: AopProjectionPoint;
    topRight: AopProjectionPoint;
    bottomRight: AopProjectionPoint;
    bottomLeft: AopProjectionPoint;
  };
  target: {
    topLeft: AopProjectionPoint;
    topRight: AopProjectionPoint;
    bottomRight: AopProjectionPoint;
    bottomLeft: AopProjectionPoint;
  };
};

export type AopProjectionPanelMap = {
  panelKey: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceRect?: AopProjectionSourceRect;
  calibrationImageUrl?: string;
  maskUrl?: string;
  transformType: "affine" | "perspective" | "mesh";
  confidence: number;
  curvature?: AopPanelCurvature;
  subdivision?: number;
  seamPaddingPx?: number;
  seamFeatherPx?: number;
  detection?: AopProjectionDetectionStats;
  fallbackReason?: string;
  points: AopProjectionGridPoint[];
  mesh: AopProjectionMeshCell[];
  bounds: {
    topLeft: AopProjectionPoint;
    topRight: AopProjectionPoint;
    bottomRight: AopProjectionPoint;
    bottomLeft: AopProjectionPoint;
  };
};

export type AopProjectionViewMap = {
  view: AopProjectionViewName;
  width: number;
  height: number;
  baseImageUrl: string;
  shadowLayerUrl?: string;
  highlightLayerUrl?: string;
  zipperLayerUrl?: string;
  maskLayerUrl?: string;
  debugOverlayUrl?: string;
  debugArtifacts?: AopProjectionDebugArtifacts;
  panels: AopProjectionPanelMap[];
};

export type AopProjectionMapJson = {
  version: "aop-projection-map/v1";
  productTypeId: number | null;
  blueprintId: number;
  providerId: number;
  size: string | null;
  sourceRunId: string;
  generatedAt: string;
  mapUrl?: string;
  extraction: {
    mode: "manual-first" | "calibration-point-v1";
    detector: "sharp-color-heuristic" | "sharp-color-blob-lattice";
    notes: string[];
    debugArtifacts?: Record<string, AopProjectionDebugArtifacts>;
  };
  views: Record<string, AopProjectionViewMap>;
};

export type RenderProjectedMockupParams = {
  artwork: string | HTMLImageElement;
  productTypeId: number;
  view: "front" | "back";
  map?: AopProjectionMapJson;
  mapUrl?: string;
  debug?: boolean;
  quality?: AopRenderQualityMode;
  panelSources?: Array<{
    position?: string;
    panelKey?: string;
    key?: string;
    url?: string;
    dataUrl?: string;
    imageUrl?: string;
  }>;
};
