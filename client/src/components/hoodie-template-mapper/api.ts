import type { HoodieTemplate, HoodieView } from "@shared/hoodieTemplate";

/**
 * Platform-operator API for the AOP Panel Mapper. Works in production (embedded
 * Shopify admin on Railway) and local dev (platform admin bypass in non-prod).
 */
const BASE = "/api/platform/aop-mapper";

const fetchOpts: RequestInit = { credentials: "include" };

export type TemplateListEntry = {
  name: string;
  file: string;
  sizeBytes: number;
  updatedAt: string;
};

export type MockupListEntry = {
  filename: string;
  url: string;
  sizeBytes: number;
  updatedAt: string;
};

export async function listTemplates(): Promise<TemplateListEntry[]> {
  const r = await fetch(`${BASE}/templates`, fetchOpts);
  if (!r.ok) throw new Error(`Failed to list templates (${r.status})`);
  const data = (await r.json()) as { templates: TemplateListEntry[] };
  return data.templates ?? [];
}

export async function loadTemplate(name: string): Promise<HoodieTemplate> {
  const r = await fetch(`${BASE}/templates/${encodeURIComponent(name)}`, fetchOpts);
  if (!r.ok) throw new Error(`Failed to load template "${name}" (${r.status})`);
  return (await r.json()) as HoodieTemplate;
}

export type SaveTemplatePublishResult =
  | {
      ok: true;
      publicName: string;
      jsonUrl: string;
      mockups: { front?: string; back?: string };
      uploadedMockups: string[];
      elapsedMs: number;
    }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; error: string; elapsedMs: number };

export type SaveTemplateResult = {
  ok: true;
  file: string;
  sizeBytes?: number;
  updatedAt?: string;
  handler?: string;
  bodySource?: "rawBody" | "parsedBody" | "stream";
  elapsedMs?: number;
  publish?: SaveTemplatePublishResult | null;
};

export async function saveTemplate(name: string, template: HoodieTemplate): Promise<SaveTemplateResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(`${BASE}/templates/${encodeURIComponent(name)}`, {
      ...fetchOpts,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(template),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const err = await r.text().catch(() => "");
      if (r.status === 403) {
        throw new Error("Platform operator access required to save templates.");
      }
      if (r.status === 504) {
        throw new Error(`Server save handler timed out (504). (${name})`);
      }
      throw new Error(`Failed to save template "${name}" (${r.status}): ${err.slice(0, 200) || r.status}`);
    }
    return (await r.json()) as SaveTemplateResult;
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`Save timed out after 20s. (${name})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export type PublishTemplateResult = {
  ok: true;
  publish: SaveTemplatePublishResult;
};

export async function publishTemplateToSupabase(name: string): Promise<PublishTemplateResult> {
  const r = await fetch(`${BASE}/templates/${encodeURIComponent(name)}/publish`, {
    ...fetchOpts,
    method: "POST",
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Failed to publish template "${name}" (${r.status}): ${err.slice(0, 300)}`);
  }
  return (await r.json()) as PublishTemplateResult;
}

export async function deleteTemplate(name: string): Promise<void> {
  const r = await fetch(`${BASE}/templates/${encodeURIComponent(name)}`, {
    ...fetchOpts,
    method: "DELETE",
  });
  if (!r.ok && r.status !== 404) {
    throw new Error(`Failed to delete template "${name}" (${r.status})`);
  }
}

export async function listMockups(): Promise<MockupListEntry[]> {
  const r = await fetch(`${BASE}/mockups`, fetchOpts);
  if (!r.ok) throw new Error(`Failed to list mockups (${r.status})`);
  const data = (await r.json()) as { mockups: MockupListEntry[] };
  return data.mockups ?? [];
}

export async function uploadMockup(
  templateName: string,
  view: HoodieView,
  file: File,
): Promise<{ filename: string; url: string }> {
  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || "png").toLowerCase();
  const filename = `${templateName}-${view}.${ext}`;
  const body = await file.arrayBuffer();
  const r = await fetch(`${BASE}/mockups/${encodeURIComponent(filename)}`, {
    ...fetchOpts,
    method: "POST",
    headers: { "Content-Type": file.type || "image/png" },
    body,
  });
  if (!r.ok) {
    const err = await r.text().catch(() => "");
    throw new Error(`Failed to upload mockup: ${err.slice(0, 200) || r.status}`);
  }
  return (await r.json()) as { filename: string; url: string };
}

export type SourcePanelEntry = {
  filename: string;
  url: string;
  sizeBytes: number;
  updatedAt: string;
};

export async function listSourcePanels(): Promise<SourcePanelEntry[]> {
  const r = await fetch(`${BASE}/source-panels`, fetchOpts);
  if (!r.ok) throw new Error(`Failed to list source panels (${r.status})`);
  const data = (await r.json()) as { panels: SourcePanelEntry[] };
  return data.panels ?? [];
}

export async function uploadSourcePanel(
  templateName: string,
  panelKey: string,
  file: File,
): Promise<{ filename: string; url: string }> {
  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || "png").toLowerCase();
  const safePanelKey = panelKey.replace(/[^a-zA-Z0-9_\-]/g, "_");
  const filename = `${templateName}-${safePanelKey}.${ext}`;
  const body = await file.arrayBuffer();
  const r = await fetch(`${BASE}/source-panels/${encodeURIComponent(filename)}`, {
    ...fetchOpts,
    method: "POST",
    headers: { "Content-Type": file.type || "image/png" },
    body,
  });
  if (!r.ok) {
    const err = await r.text().catch(() => "");
    throw new Error(`Failed to upload source panel: ${err.slice(0, 200) || r.status}`);
  }
  return (await r.json()) as { filename: string; url: string };
}

export async function uploadReferenceOverlay(
  templateName: string,
  view: HoodieView,
  file: File,
): Promise<{ filename: string; url: string }> {
  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || "png").toLowerCase();
  const filename = `${templateName}-${view}-ref.${ext}`;
  const body = await file.arrayBuffer();
  const r = await fetch(`${BASE}/reference-overlays/${encodeURIComponent(filename)}`, {
    ...fetchOpts,
    method: "POST",
    headers: { "Content-Type": file.type || "image/png" },
    body,
  });
  if (!r.ok) {
    const err = await r.text().catch(() => "");
    throw new Error(`Failed to upload reference overlay: ${err.slice(0, 200) || r.status}`);
  }
  return (await r.json()) as { filename: string; url: string };
}

export type FetchPrintifyBlanksResult = {
  ok: true;
  blueprintId: number;
  downloaded: Array<{ view: "front" | "back"; filename: string; url: string; bytes: number; width: number; height: number }>;
};

/** Pull blank garment mockups from Printify into mapper storage (uses multiply shading source photos). */
export async function downloadPrintifyBlankMockups(templateName: string): Promise<FetchPrintifyBlanksResult> {
  const r = await fetch(`${BASE}/printify-blanks/${encodeURIComponent(templateName)}`, {
    ...fetchOpts,
    method: "POST",
  });
  if (!r.ok) {
    const err = await r.text().catch(() => "");
    throw new Error(`Printify blank download failed (${r.status}): ${err.slice(0, 300)}`);
  }
  return (await r.json()) as FetchPrintifyBlanksResult;
}

export function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      URL.revokeObjectURL(url);
      resolve({ width: w, height: h });
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}
