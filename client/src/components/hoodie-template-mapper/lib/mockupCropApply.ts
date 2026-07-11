import type { HoodieView, MockupAsset } from "@shared/hoodieTemplate";
import { uploadMockup } from "../api";
import { loadMapperAssetImage } from "./mapperAssetImage";
import { clampCrop, cropImageToPngBlob, type CropRect } from "./mockupCrop";

export async function applyMockupCropUpload(args: {
  templateName: string;
  view: HoodieView;
  mockup: MockupAsset;
  rect: CropRect;
}): Promise<MockupAsset> {
  const { templateName, view, mockup, rect } = args;
  const img = await loadMapperAssetImage(mockup.src);
  const srcW = img.naturalWidth || mockup.width;
  const srcH = img.naturalHeight || mockup.height;
  const crop = clampCrop(rect, srcW, srcH);
  const blob = await cropImageToPngBlob(img, crop);
  const file = new File([blob], `${templateName}-${view}.png`, { type: "image/png" });
  const { url } = await uploadMockup(templateName, view, file);
  return {
    src: url,
    width: Math.round(crop.width),
    height: Math.round(crop.height),
    x: 0,
    y: 0,
    scale: 1,
    transformLocked: false,
  };
}
