export interface PrintSize {
  id: string;
  name: string;
  width: number;
  height: number;
  aspectRatio?: string;
}

export interface FrameColor {
  id: string;
  name: string;
  hex: string;
}

export interface StylePresetOption {
  id: string;
  name: string;
  promptFragment: string;
  baseImageUrl?: string;
}

export interface StylePreset {
  id: string;
  name: string;
  promptSuffix: string;
  thumbnailUrl?: string;
  category?: "all" | "decor" | "apparel";
  promptPlaceholder?: string;
  baseImageUrl?: string;
  descriptionOptional?: boolean;
  options?: {
    label: string;
    required: boolean;
    choices: StylePresetOption[];
  };
}

export interface DesignerConfig {
  sizes: PrintSize[];
  frameColors: FrameColor[];
  stylePresets: StylePreset[];
  blueprintId?: number;
}

export interface ImageTransform {
  scale: number;
  x: number;
  y: number;
}

/** Per-panel artwork placement transform (stored in preview-canvas pixel space). */
export interface PanelTransform {
  dxPx: number;     // horizontal drag offset in preview-canvas pixels
  dyPx: number;     // vertical drag offset in preview-canvas pixels
  scalePct: number; // additional scale factor (100 = no change)
}

/** Persistent AOP placement state passed between PatternCustomizer sessions. */
export interface AopPlacementSettings {
  perPanelTransforms: Record<string, PanelTransform>;
  activePanel: string | null;
  mirrorMode: boolean;
  seamBleedPx: number;
  /** When true, dragging either legging leg updates both legs from the same canonical transform (no artwork mirror). */
  syncSidesMode?: boolean;
  /** Last active editor mode — restores the correct tab when re-editing. */
  lastMode?: "pattern" | "single" | "place";
  activeLeg?: string; // legacy compat
  dragOffset?: { x: number; y: number }; // legacy compat
}

export interface LifestyleMockupConfig {
  src: string;
  frameArea: {
    top: number;
    left: number;
    width: number;
    height: number;
  };
}

export type PrintShape = "rectangle" | "square" | "circle";
export type DesignerType = "framed-print" | "pillow" | "mug" | "apparel" | "generic";
export type SizeType = "dimensional" | "label";

export interface CanvasConfig {
  maxDimension: number;
  width: number;
  height: number;
  safeZoneMargin: number;
}

export interface ProductDesignerConfig {
  id: number;
  name: string;
  description: string | null;
  printifyBlueprintId: number | null;
  aspectRatio: string;
  printShape: PrintShape;
  printAreaWidth: number | null;
  printAreaHeight: number | null;
  bleedMarginPercent: number;
  designerType: DesignerType;
  sizeType: SizeType;
  hasPrintifyMockups: boolean;
  sizes: PrintSize[];
  frameColors: FrameColor[];
  canvasConfig: CanvasConfig;
  doubleSidedPrint?: boolean;
  isAllOverPrint?: boolean;
  placeholderPositions?: { position: string; width: number; height: number }[];
  /** Map of panel position name → SVG URL for the sew-pattern flat-lay viewer. */
  panelFlatLayImages?: Record<string, string>;
}

export interface DesignerState {
  prompt: string;
  selectedPreset: string;
  selectedSize: string;
  selectedFrameColor: string;
  referenceImage: File | null;
  referencePreview: string | null;
  generatedImageUrl: string | null;
  generatedDesignId: string | null;
  transform: ImageTransform;
  isGenerating: boolean;
}
