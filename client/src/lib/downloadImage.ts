function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${cleaned || "appai-artwork"}.png`;
}

function triggerDownload(url: string, filename: string, openInNewTab = false) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = sanitizeFilename(filename);
  if (openInNewTab) {
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
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

  // Most generated images live on Supabase/public object URLs. Fetching them
  // from the storefront can be blocked by CORS, and a delayed fallback popup
  // can then be blocked by the browser. Click the URL synchronously instead:
  // same-origin/proxy URLs can download, cross-origin URLs visibly open.
  triggerDownload(url, filename, true);
}
