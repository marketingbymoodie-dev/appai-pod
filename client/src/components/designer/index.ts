export { MockupPreview } from "./MockupPreview";
export { ProductMockup } from "./ProductMockup";
export { ZoomControls } from "./ZoomControls";
export { FrameColorSelector } from "./FrameColorSelector";
export { SizeSelector } from "./SizeSelector";
export { StyleSelector } from "./StyleSelector";
export { SafeZoneMask, generateSafeZonePrompt, generateSafeZoneMaskDataUrl } from "./SafeZoneMask";
export { useDesignerState } from "./useDesignerState";
export { BaseDesigner } from "./BaseDesigner";
export type { ProductAdapter, ControlsProps, MockupProps } from "./BaseDesigner";
export { FramedPrintAdapter, PillowAdapter } from "./adapters";
export { PatternCustomizer } from "./PatternCustomizer";
export type { PatternType, PatternApplyOptions, EditorMode, AopPlacementSettings } from "./PatternCustomizer";
export { resolveAopLayoutKind, AOP_TEMPLATE_ADMIN_OPTIONS, AOP_TEMPLATE_SELECT_AUTO } from "./aopTemplates/registry";
export type { AopTemplateId } from "./aopTemplates/registry";
export type { AopLayoutKind } from "./aopTemplates/detectLayoutKind";
export { detectProductKind } from "./aopTemplates/detectLayoutKind";
export type {
  PrintSize,
  FrameColor,
  StylePreset,
  DesignerConfig,
  ImageTransform,
  PanelTransform,
  AopPlacementSettings as AopPlacementSettingsBase,
  LifestyleMockupConfig,
  PrintShape,
  DesignerType,
  CanvasConfig,
  ProductDesignerConfig,
  DesignerState,
} from "./types";
