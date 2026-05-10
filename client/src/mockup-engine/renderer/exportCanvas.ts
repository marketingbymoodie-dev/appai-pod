export function exportCanvasAsPng(canvas: HTMLCanvasElement, filename = "mockup-preview.png") {
  const anchor = document.createElement("a");
  anchor.href = canvas.toDataURL("image/png");
  anchor.download = filename;
  anchor.click();
}
