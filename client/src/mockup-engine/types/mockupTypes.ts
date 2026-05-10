export type MockupProductType = "zip_hoodie_aop";
export type MockupProvider = "printify";

export type MockupPoint = {
  x: number;
  y: number;
};

export type MockupGuideType = "line" | "curve" | "arc" | "point";

export type MockupGuide = {
  id: string;
  type: MockupGuideType;
  name: string;
  locked: boolean;
  opacity: number;
  points: MockupPoint[];
  notes?: string;
};

export type MockupPanelPreset =
  | "hood_left_opening"
  | "hood_right_opening"
  | "front_neckline_collar"
  | "front_body_left"
  | "front_body_right"
  | "back_main"
  | "back_hood_left_visible"
  | "back_hood_right_visible"
  | "sleeve_left_back"
  | "sleeve_right_back"
  | "zipper_mask_area"
  | "custom";

export type MockupPanelPlacement = {
  id: string;
  name: string;
  artworkPanelName: string;
  preset: MockupPanelPreset;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
  zIndex: number;
  locked: boolean;
  visible: boolean;
  maskUrl?: string;
  perspectiveCorners?: {
    topLeft: MockupPoint;
    topRight: MockupPoint;
    bottomRight: MockupPoint;
    bottomLeft: MockupPoint;
  };
  seamAnchor?: {
    x: number;
    y: number;
    description: string;
  };
  snapAnchors?: {
    id: string;
    x: number;
    y: number;
    guideId?: string;
    description?: string;
  }[];
  notes?: string;
};

export type MockupViewCalibration = {
  id: string;
  name: string;
  width: number;
  height: number;
  baseImageUrl?: string;
  referenceImageUrl?: string;
  shadowOverlayUrl?: string;
  highlightOverlayUrl?: string;
  guides: MockupGuide[];
  panels: MockupPanelPlacement[];
};

export type MockupCalibration = {
  productType: MockupProductType;
  provider: MockupProvider;
  blueprintId?: string;
  printProviderId?: string;
  version: string;
  views: Record<string, MockupViewCalibration>;
};

export type ArtworkPanelAsset = {
  name: string;
  url: string;
};

export type ComparisonMode = "overlay" | "side-by-side";
