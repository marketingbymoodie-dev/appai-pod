/**
 * Persistence for the AOP Panel Mapper admin tool.
 *
 * - Development: prefers local `tmp/hoodie-templates/` for fast iteration.
 * - Production (or when Supabase is configured): reads/writes `drafts/*` in the
 *   hoodie-templates bucket so Railway deploys don't lose authored work.
 */
import fs from "node:fs";
import path from "node:path";
import {
  downloadFromHoodieTemplatesBucket,
  isSupabaseHoodieTemplatesConfigured,
  listHoodieTemplatesBucketFiles,
  uploadToHoodieTemplatesBucket,
} from "./supabaseHoodieTemplates";

const PROJECT_ROOT = process.cwd();
const LOCAL_ROOT = path.resolve(PROJECT_ROOT, "tmp", "hoodie-templates");
export const LOCAL_TEMPLATES_DIR = path.resolve(LOCAL_ROOT, "templates");
export const LOCAL_MOCKUPS_DIR = path.resolve(LOCAL_ROOT, "mockups");
export const LOCAL_SOURCE_PANELS_DIR = path.resolve(LOCAL_ROOT, "source-panels");
export const LOCAL_REFERENCE_OVERLAYS_DIR = path.resolve(LOCAL_ROOT, "reference-overlays");

const SAFE_FILENAME_RE = /^[a-zA-Z0-9_\-]+\.(png|jpg|jpeg|webp)$/i;

type AssetKind = "mockups" | "source-panels" | "reference-overlays";

function localDir(kind: AssetKind | "templates"): string {
  switch (kind) {
    case "templates":
      return LOCAL_TEMPLATES_DIR;
    case "mockups":
      return LOCAL_MOCKUPS_DIR;
    case "source-panels":
      return LOCAL_SOURCE_PANELS_DIR;
    case "reference-overlays":
      return LOCAL_REFERENCE_OVERLAYS_DIR;
  }
}

function draftPath(kind: AssetKind | "templates", name: string): string {
  return `drafts/${kind}/${name}`;
}

function safeJoin(base: string, name: string): string | null {
  const joined = path.resolve(base, name);
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (joined !== base && !joined.startsWith(baseWithSep)) return null;
  return joined;
}

function useSupabasePrimary(): boolean {
  return process.env.NODE_ENV === "production" && isSupabaseHoodieTemplatesConfigured();
}

export function ensureLocalMapperDirs(): void {
  for (const dir of [
    LOCAL_TEMPLATES_DIR,
    LOCAL_MOCKUPS_DIR,
    LOCAL_SOURCE_PANELS_DIR,
    LOCAL_REFERENCE_OVERLAYS_DIR,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export async function listTemplateEntries(): Promise<
  Array<{ name: string; file: string; sizeBytes: number; updatedAt: string }>
> {
  const out = new Map<string, { name: string; file: string; sizeBytes: number; updatedAt: string }>();

  if (!useSupabasePrimary()) {
    ensureLocalMapperDirs();
    try {
      for (const f of await fs.promises.readdir(LOCAL_TEMPLATES_DIR)) {
        if (!f.endsWith(".json")) continue;
        const full = path.join(LOCAL_TEMPLATES_DIR, f);
        const stat = await fs.promises.stat(full);
        const name = f.replace(/\.json$/i, "");
        out.set(name, {
          name,
          file: path.relative(PROJECT_ROOT, full),
          sizeBytes: stat.size,
          updatedAt: stat.mtime.toISOString(),
        });
      }
    } catch {
      /* empty */
    }
  }

  if (isSupabaseHoodieTemplatesConfigured()) {
    const files = await listHoodieTemplatesBucketFiles("drafts/templates/");
    for (const f of files) {
      if (!f.name.endsWith(".json")) continue;
      const name = f.name.replace(/\.json$/i, "");
      out.set(name, {
        name,
        file: `supabase:${draftPath("templates", f.name)}`,
        sizeBytes: f.sizeBytes ?? 0,
        updatedAt: f.updatedAt ?? new Date().toISOString(),
      });
    }
  }

  return Array.from(out.values()).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function readTemplateText(name: string): Promise<string | null> {
  if (!useSupabasePrimary()) {
    const file = safeJoin(LOCAL_TEMPLATES_DIR, `${name}.json`);
    if (file && fs.existsSync(file)) {
      return fs.promises.readFile(file, "utf-8");
    }
  }
  if (isSupabaseHoodieTemplatesConfigured()) {
    const buf = await downloadFromHoodieTemplatesBucket(draftPath("templates", `${name}.json`));
    if (buf) return buf.toString("utf-8");
  }
  if (useSupabasePrimary()) {
    const file = safeJoin(LOCAL_TEMPLATES_DIR, `${name}.json`);
    if (file && fs.existsSync(file)) {
      return fs.promises.readFile(file, "utf-8");
    }
  }
  return null;
}

export async function writeTemplateText(name: string, text: string): Promise<{ localFile?: string }> {
  ensureLocalMapperDirs();
  const localFile = safeJoin(LOCAL_TEMPLATES_DIR, `${name}.json`);
  if (localFile) {
    await fs.promises.writeFile(localFile, text, "utf-8");
  }
  if (isSupabaseHoodieTemplatesConfigured()) {
    await uploadToHoodieTemplatesBucket(
      draftPath("templates", `${name}.json`),
      Buffer.from(text, "utf-8"),
      "application/json",
    );
  }
  return { localFile: localFile ? path.relative(PROJECT_ROOT, localFile) : undefined };
}

export async function deleteTemplate(name: string): Promise<void> {
  const file = safeJoin(LOCAL_TEMPLATES_DIR, `${name}.json`);
  if (file && fs.existsSync(file)) {
    await fs.promises.unlink(file);
  }
  // Supabase draft delete is best-effort — publish script can overwrite.
}

async function listAssetEntries(
  kind: AssetKind,
  urlBase: string,
): Promise<Array<{ filename: string; url: string; sizeBytes: number; updatedAt: string }>> {
  const out = new Map<string, { filename: string; url: string; sizeBytes: number; updatedAt: string }>();

  if (!useSupabasePrimary()) {
    ensureLocalMapperDirs();
    const dir = localDir(kind);
    try {
      for (const f of await fs.promises.readdir(dir)) {
        if (!SAFE_FILENAME_RE.test(f)) continue;
        const full = path.join(dir, f);
        const stat = await fs.promises.stat(full);
        out.set(f, {
          filename: f,
          url: `${urlBase}/${encodeURIComponent(f)}`,
          sizeBytes: stat.size,
          updatedAt: stat.mtime.toISOString(),
        });
      }
    } catch {
      /* empty */
    }
  }

  if (isSupabaseHoodieTemplatesConfigured()) {
    const prefix = `drafts/${kind}/`;
    const files = await listHoodieTemplatesBucketFiles(prefix);
    for (const f of files) {
      if (!SAFE_FILENAME_RE.test(f.name)) continue;
      out.set(f.name, {
        filename: f.name,
        url: `${urlBase}/${encodeURIComponent(f.name)}`,
        sizeBytes: f.sizeBytes ?? 0,
        updatedAt: f.updatedAt ?? new Date().toISOString(),
      });
    }
  }

  return Array.from(out.values()).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function listMockupEntries(urlBase: string) {
  return listAssetEntries("mockups", urlBase);
}

export async function listSourcePanelEntries(urlBase: string) {
  return listAssetEntries("source-panels", urlBase);
}

export async function listReferenceOverlayEntries(urlBase: string) {
  return listAssetEntries("reference-overlays", urlBase);
}

export async function readAssetBuffer(kind: AssetKind, filename: string): Promise<Buffer | null> {
  if (!useSupabasePrimary()) {
    const file = safeJoin(localDir(kind), filename);
    if (file && fs.existsSync(file)) {
      return fs.promises.readFile(file);
    }
  }
  if (isSupabaseHoodieTemplatesConfigured()) {
    const buf = await downloadFromHoodieTemplatesBucket(draftPath(kind, filename));
    if (buf) return buf;
  }
  if (useSupabasePrimary()) {
    const file = safeJoin(localDir(kind), filename);
    if (file && fs.existsSync(file)) {
      return fs.promises.readFile(file);
    }
  }
  return null;
}

export async function writeAssetBuffer(kind: AssetKind, filename: string, buf: Buffer): Promise<void> {
  ensureLocalMapperDirs();
  const file = safeJoin(localDir(kind), filename);
  if (file) await fs.promises.writeFile(file, buf);
  if (isSupabaseHoodieTemplatesConfigured()) {
    const ext = path.extname(filename).toLowerCase();
    const contentType =
      ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
    await uploadToHoodieTemplatesBucket(draftPath(kind, filename), buf, contentType);
  }
}

/** Resolve mockup path for auto-publish (local disk). */
export function resolveLocalMockupPath(adminName: string, publicName: string, view: "front" | "back"): string | null {
  const candidates = [
    path.join(LOCAL_MOCKUPS_DIR, `${adminName}-${view}.png`),
    path.join(LOCAL_MOCKUPS_DIR, `${publicName}-${view}.png`),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export { LOCAL_MOCKUPS_DIR as MOCKUPS_DIR, LOCAL_TEMPLATES_DIR as TEMPLATES_DIR };
