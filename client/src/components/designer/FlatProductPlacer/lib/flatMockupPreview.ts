import type { ArtworkPlacement } from "@/components/hoodie-template-mapper/lib/aopPreview";
import type { FlatCalibrationManifest } from "@/pages/embed-design";
import type { FlatProductPlacerState } from "../index";
import { loadFlatImage, loadFlatViewAssets, resolveFlatBlank, type FlatViewName } from "./flatAssets";
import { renderFlatView } from "./flatRender";

/**
 * Client-side flat mockup raster for a single view — no upload. Used when the
 * customer swaps frame colour in preview mode (outside the placement editor).
 */
export async function renderFlatMockupDataUrl(
  manifest: FlatCalibrationManifest,
  colorId: string,
  placerState: FlatProductPlacerState,
  view: FlatViewName,
  artworkUrl: string,
): Promise<string | null> {
  if (!placerState.enabled[view]) return null;

  const assets = await loadFlatViewAssets(manifest, colorId, view);
  const calib = manifest.views[view];
  if (!assets?.blank || !calib) return null;

  const artwork = artworkUrl ? await loadFlatImage(artworkUrl) : null;
  if (!artwork) return null;

  const canvas = document.createElement("canvas");
  renderFlatView({
    target: canvas,
    blank: assets.blank,
    mask: assets.mask,
    shading: assets.shading,
    artwork,
    view: calib,
    placement: placerState.placements[view] as ArtworkPlacement,
    tier: manifest.tier,
  });

  try {
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/** Views that have both calibration + a blank for this colour. */
export function flatViewsForColor(
  manifest: FlatCalibrationManifest,
  colorId: string,
): FlatViewName[] {
  const blank = resolveFlatBlank(manifest, colorId);
  const views: FlatViewName[] = [];
  (["front", "back"] as FlatViewName[]).forEach((v) => {
    if (manifest.views[v] && blank[v]) views.push(v);
  });
  return views;
}
