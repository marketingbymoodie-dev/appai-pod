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

export type SaveTemplateResult = {
  ok: true;
  file: string;
  sizeBytes?: number;
  updatedAt?: string;
  /** Server-side handler version marker — useful to confirm the dev server is running new code. */
  handler?: string;
  bodySource?: "rawBody" | "parsedBody" | "stream";
  elapsedMs?: number;
};

export async function saveTemplate(name: string, template: HoodieTemplate): Promise<SaveTemplateResult> {
  // 20s safety timeout so a hung server can't pin the UI in the busy state.
  // (The server now also enforces its own 10s hard timeout and replies 504,
  // but we keep this as a belt-and-braces fallback for total network hangs.)
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
      if (r.status === 504) {
        throw new Error(
          `Server save handler timed out (504). Restart your dev server ` +
            `('npm run dev') so the latest code loads. (${name})`,
        );
      }
      throw new Error(`Failed to save template "${name}" (${r.status}): ${err.slice(0, 200) || r.status}`);
    }
    return (await r.json()) as SaveTemplateResult;
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(
        `Save timed out after 20s — your dev server is almost certainly running ` +
          `OLD code. Stop it (Ctrl+C in the terminal) and run 'npm run dev' again, ` +
          `then retry. (${name})`,
      );
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

// ---------------------------------------------------------------------------
// Source panel artwork — per-panel Printify production sheets used by the
// mesh-warp tool. The same file can be referenced by both the front-view
// and the back-view masks for a panel; the mesh's sourceRect picks the
// right slice for each view.
// ---------------------------------------------------------------------------

export type SourcePanelEntry = {
  filename: string;
  url: string;
  sizeBytes: number;
  updatedAt: string;
};

export async function listSourcePanels(): Promise<SourcePanelEntry[]> {
  const r = await fetch(`${BASE}/source-panels`);
  if (!r.ok) throw new Error(`Failed to list source panels (${r.status})`);
  const data = (await r.json()) as { panels: SourcePanelEntry[] };
  return data.panels ?? [];
}

/**
 * Upload a source panel artwork for a given (template, panelKey). Filename
 * derived as `<template>-<panelKey>.<ext>` so front-view and back-view
 * masks for the same panel share the file.
 *
 * Returns the public URL the canvas should reference in `productionPanelSrc`.
 */
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
