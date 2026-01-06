export interface PrintSize {
  id: string;
  name: string;
  width: number;
  height: number;
  aspectRatio: string;
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
