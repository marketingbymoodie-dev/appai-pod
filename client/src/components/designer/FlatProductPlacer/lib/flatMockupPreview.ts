import type { ArtworkPlacement } from "@/components/hoodie-template-mapper/lib/aopPreview";
import type { FlatCalibrationManifest } from "@/pages/embed-design";
import type { FlatProductPlacerState } from "../index";
import { loadFlatImageRelaxed, loadFlatViewAssets, resolveFlatBlank, resolveFlatViewCalibration, type FlatViewName } from "./flatAssets";
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
  opts?: {
    decorMode?: boolean;
    fabricWeave?: boolean;
    landscapeOrientation?: boolean;
    blankUrlOverride?: string | null;
  },
): Promise<string | null> {
  const assets = await loadFlatViewAssets(manifest, colorId, view, {
    landscapeOrientation: opts?.landscapeOrientation,
    blankUrlOverride: opts?.blankUrlOverride,
  });
  const calib = resolveFlatViewCalibration(manifest, colorId, view, {
    landscapeOrientation: !!opts?.landscapeOrientation,
  });
  if (!assets?.blank || !calib) return null;

  const includeArtwork = !!placerState.enabled[view];
  const artwork =
    includeArtwork && artworkUrl ? await loadFlatImageRelaxed(artworkUrl) : null;
  if (includeArtwork && !artwork) return null;

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
    forceShadingMap: !!manifest.edgeWrap,
    edgeWrapMode: !!manifest.edgeWrap,
    decorMode: opts?.decorMode === true || !!manifest.decorPerSize,
    fabricWeave: opts?.fabricWeave === true,
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
