/**
 * Shared types for the AOP Calibration Mapper.
 *
 * Convention:
 *   (u, v) = normalized [0..1] coordinates in the source panel image.
 *   (x, y) = pixel coordinates in the mockup image space (NOT screen space).
 */

export type ViewId = "front" | "back";
export type RenderPreviewMode = "source" | "warped" | "clipped" | "difference";

export type UV = { u: number; v: number };
export type Pt = { x: number; y: number };

export type MeshPoint = {
  u: number;
  v: number;
  x: number;
  y: number;
};

export type MeshGrid = {
  cols: number;
  rows: number;
  points: MeshPoint[];
};

export type MaskState = {
  polygon: UV[];
  feather: number;
} | null;

export type PanelTransform = {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
};

export type PanelState = {
  panelKey: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  zIndex: number;
  transform: PanelTransform;
  artworkSrc: string | null;
  sourceSize: { width: number; height: number } | null;
  mesh: MeshGrid;
  mask: MaskState;
};

export type ViewState = {
  mockupSrc: string | null;
  mockupSize: { width: number; height: number } | null;
  panels: Record<string, PanelState>;
  panelOrder: string[];
};

export type CalibrationState = {
  version: "aop-mapper/v1";
  productTypeId: number | null;
  blueprintId: number | null;
  providerId: number | null;
  size: string | null;
  productType: string;
  views: Record<ViewId, ViewState>;
  meta: {
    createdAt: string;
    updatedAt: string;
    label: string;
  };
};

export type DebugFlags = {
  renderPreviewMode: RenderPreviewMode;
  showMesh: boolean;
  showMask: boolean;
  showHandles: boolean;
  showPanelBounds: boolean;
  showOnionSkin: boolean;
  onionSkinOpacity: number;
  mockupOpacity: number;
  warpedPanelOpacity: number;
  blinkCompare: boolean;
  showDistortionHeatmap: boolean;
  showGarmentSeamGuides: boolean;
  showMockupEdges: boolean;
  showGridIntersections: boolean;
  showFinalPreview: boolean;
  showOverlapHeatmap: boolean;
  highContrast: boolean;
  showDetectionTriangles: boolean;
  showDetectionCorrespondences: boolean;
  showDetectionConfidenceHeatmap: boolean;
  showDetectionRejected: boolean;
};

/**
 * AI-assisted calibration detection import (matches the JSON emitted by
 * scripts/detect-aop-triangle-calibration.ts).
 */
export type DetectedTriangle = {
  id: number;
  type?: "upper" | "lower";
  cell?: { row: number; col: number };
  centroidUV: UV;
  expectedColor: string;
  observedColor?: string;
  centroidXY: { x: number; y: number } | null;
  pixelCount: number;
  bboxXY?: { x: number; y: number; width: number; height: number } | null;
  meanLabDistance?: number;
  spread?: number;
  confidence: number;
  rejected: boolean;
  reason?: string;
};

export type DetectionCorrespondence = {
  triangleId: number;
  source: { u: number; v: number; x: number; y: number };
  target: { x: number; y: number };
  confidence: number;
};

export type SuggestedMeshPoint = {
  u: number;
  v: number;
  x: number;
  y: number;
  confidence?: number;
};

export type DetectionImport = {
  panelName: string;
  manifestVersion?: string;
  detectedAt?: string;
  mockupSize: { width: number; height: number };
  analysisSize?: { width: number; height: number };
  panelGrid: { cols: number; rows: number };
  detectedTriangles: DetectedTriangle[];
  correspondences: DetectionCorrespondence[];
  suggestedMesh: { rows: number; cols: number; points: SuggestedMeshPoint[] };
  suggestedMask?: UV[];
  stats?: {
    totalTriangles: number;
    accepted: number;
    rejected: number;
    averageConfidence: number;
  };
};

export const DEFAULT_PANEL_KEYS: string[] = [
  "front_right",
  "front_left",
  "back",
  "right_sleeve",
  "left_sleeve",
  "right_hood",
  "left_hood",
  "pocket_right",
  "pocket_left",
  "right_cuff_panel",
  "left_cuff_panel",
  "waistband",
];

export const PANEL_DEFAULT_VIEW: Record<string, ViewId> = {
  front_right: "front",
  front_left: "front",
  back: "back",
  right_sleeve: "front",
  left_sleeve: "front",
  right_hood: "front",
  left_hood: "front",
  pocket_right: "front",
  pocket_left: "front",
  right_cuff_panel: "front",
  left_cuff_panel: "front",
  waistband: "front",
};
