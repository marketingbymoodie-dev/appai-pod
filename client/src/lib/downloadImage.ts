function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${cleaned || "appai-artwork"}.png`;
}

function triggerDownload(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = sanitizeFilename(filename);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export async function downloadImageFromUrl(url: string, filename = "appai-artwork.png") {
  if (!url) throw new Error("No artwork URL available.");

  if (url.startsWith("data:")) {
    triggerDownload(url, filename);
    return;
  }

  try {
    const response = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!response.ok) throw new Error(`Image request failed: ${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      triggerDownload(objectUrl, filename);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch (error) {
    // Cross-origin image hosts can block fetch even when <img> display works.
    // Opening the image directly still gives the user a browser save option.
    window.open(url, "_blank", "noopener,noreferrer");
    throw error;
  }
}
