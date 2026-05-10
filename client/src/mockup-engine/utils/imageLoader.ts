export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${src.slice(0, 80)}`));
    image.src = src;
  });
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export async function filesToNamedDataUrls(files: FileList | File[]) {
  const result: { name: string; url: string }[] = [];
  for (const file of Array.from(files)) {
    result.push({
      name: file.name.replace(/\.[^.]+$/, ""),
      url: await fileToDataUrl(file),
    });
  }
  return result;
}
