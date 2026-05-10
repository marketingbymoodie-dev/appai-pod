import type { ArtworkPanelAsset, MockupCalibration } from "../types/mockupTypes";

const CALIBRATION_KEY = "appai.mockupCalibration.zipHoodieAop";
const ARTWORK_KEY = "appai.mockupCalibration.zipHoodieAop.artworkPanels";

export function saveCalibrationToStorage(calibration: MockupCalibration) {
  localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibration));
}

export function loadCalibrationFromStorage(): MockupCalibration | null {
  const raw = localStorage.getItem(CALIBRATION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MockupCalibration;
  } catch {
    return null;
  }
}

export function saveArtworkPanelsToStorage(assets: ArtworkPanelAsset[]) {
  localStorage.setItem(ARTWORK_KEY, JSON.stringify(assets));
}

export function loadArtworkPanelsFromStorage(): ArtworkPanelAsset[] {
  const raw = localStorage.getItem(ARTWORK_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ArtworkPanelAsset[];
  } catch {
    return [];
  }
}

export function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
