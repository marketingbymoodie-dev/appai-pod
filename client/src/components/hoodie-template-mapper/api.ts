import type { HoodieTemplate, HoodieView } from "@shared/hoodieTemplate";

/**
 * Lightweight client for the dev hoodie-mapper API. Same-origin relative
 * URLs (the dev server is the only consumer of these endpoints).
 */

const BASE = "/api/dev/hoodie-mapper";

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
  const r = await fetch(`${BASE}/templates`);
  if (!r.ok) throw new Error(`Failed to list templates (${r.status})`);
  const data = (await r.json()) as { templates: TemplateListEntry[] };
  return data.templates ?? [];
}

export async function loadTemplate(name: string): Promise<HoodieTemplate> {
  const r = await fetch(`${BASE}/templates/${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`Failed to load template "${name}" (${r.status})`);
  return (await r.json()) as HoodieTemplate;
}

export async function saveTemplate(name: string, template: HoodieTemplate): Promise<{ ok: true; file: string }> {
  // 20s safety timeout so a hung server can't pin the UI in the busy state.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(`${BASE}/templates/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(template),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const err = await r.text().catch(() => "");
      throw new Error(`Failed to save template "${name}": ${err.slice(0, 200) || r.status}`);
    }
    return (await r.json()) as { ok: true; file: string };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`Save timed out after 20s — server may be hung. (${name})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function deleteTemplate(name: string): Promise<void> {
  const r = await fetch(`${BASE}/templates/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!r.ok && r.status !== 404) {
    throw new Error(`Failed to delete template "${name}" (${r.status})`);
  }
}

export async function listMockups(): Promise<MockupListEntry[]> {
  const r = await fetch(`${BASE}/mockups`);
  if (!r.ok) throw new Error(`Failed to list mockups (${r.status})`);
  const data = (await r.json()) as { mockups: MockupListEntry[] };
  return data.mockups ?? [];
}

/**
 * Upload a mockup file. The server stores it under a filename derived from
 * the template name + view, e.g. `<name>-<view>.png`. Returns the URL the
 * canvas will load.
 */
export async function uploadMockup(
  templateName: string,
  view: HoodieView,
  file: File,
): Promise<{ filename: string; url: string }> {
  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || "png").toLowerCase();
  const filename = `${templateName}-${view}.${ext}`;
  const body = await file.arrayBuffer();
  const r = await fetch(`${BASE}/mockups/${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "image/png" },
    body,
  });
  if (!r.ok) {
    const err = await r.text().catch(() => "");
    throw new Error(`Failed to upload mockup: ${err.slice(0, 200) || r.status}`);
  }
  const data = (await r.json()) as { filename: string; url: string };
  return data;
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
