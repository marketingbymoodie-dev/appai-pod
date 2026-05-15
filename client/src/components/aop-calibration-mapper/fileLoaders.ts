export async function fileToImage(file: File): Promise<{ src: string; width: number; height: number }> {
  const src = await fileToDataUrl(file);
  const meta = await loadImageFromUrl(src);
  if (!meta) throw new Error("Failed to load image");
  return { src, width: meta.width, height: meta.height };
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function fileToObjectUrl(file: File): string {
  return URL.createObjectURL(file);
}

export function loadImageFromUrl(url: string): Promise<{ width: number; height: number; image: HTMLImageElement } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height, image: img });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export async function urlToDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
