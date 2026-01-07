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

export interface StylePreset {
  id: string;
  name: string;
  promptSuffix: string;
  thumbnailUrl?: string;
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
  hasPrintifyMockups: boolean;
  sizes: PrintSize[];
  frameColors: FrameColor[];
  canvasConfig: CanvasConfig;
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
