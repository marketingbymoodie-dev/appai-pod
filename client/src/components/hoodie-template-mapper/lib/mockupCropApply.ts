import type { HoodieView, MockupAsset } from "@shared/hoodieTemplate";
import { uploadMockup } from "../api";
import { loadMapperAssetImage } from "./mapperAssetImage";
import { cropImageToPngBlob, type CropRect } from "./mockupCrop";

export async function applyMockupCropUpload(args: {
  templateName: string;
  view: HoodieView;
  mockup: MockupAsset;
  rect: CropRect;
}): Promise<MockupAsset> {
  const { templateName, view, mockup, rect } = args;
  const img = await loadMapperAssetImage(mockup.src);
  const blob = await cropImageToPngBlob(img, rect);
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  const file = new File([blob], `${templateName}-${view}.png`, { type: "image/png" });
  const { url } = await uploadMockup(templateName, view, file);
  return {
    src: url,
    width,
    height,
    x: 0,
    y: 0,
    scale: 1,
    transformLocked: false,
  };
}
