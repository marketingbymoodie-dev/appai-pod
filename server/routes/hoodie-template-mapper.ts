/**
 * Dev-only API for the Hoodie Template Mapper admin UI
 * (client/src/pages/hoodie-template-mapper.tsx).
 *
 * Endpoints (mounted under /api/dev/hoodie-mapper):
 *   GET    /templates                    → list saved hoodie template JSON files
 *   GET    /templates/:name              → load a template
 *   POST   /templates/:name              → save a template (raw JSON body)
 *   DELETE /templates/:name              → delete a template
 *   POST   /mockups/:filename            → upload a mockup PNG (raw image body)
 *   GET    /mockups/:filename            → serve an uploaded mockup PNG
 *   GET    /mockups                      → list uploaded mockup files
 *
 * Filesystem layout (gitignored under tmp/):
 *   tmp/hoodie-templates/templates/<name>.json
 *   tmp/hoodie-templates/mockups/<filename>.png
 *
 * All endpoints are gated by NODE_ENV !== 'production' in server/routes.ts.
 */

import { type Express, type Request, type Response } from "express";
import fs from "fs";
import path from "path";

const PROJECT_ROOT = process.cwd();
const ROOT_DIR = path.resolve(PROJECT_ROOT, "tmp", "hoodie-templates");
const TEMPLATES_DIR = path.resolve(ROOT_DIR, "templates");
const MOCKUPS_DIR = path.resolve(ROOT_DIR, "mockups");

const SAFE_NAME_RE = /^[a-zA-Z0-9_\-]+$/;
const SAFE_FILENAME_RE = /^[a-zA-Z0-9_\-]+\.(png|jpg|jpeg|webp)$/i;
const MAX_TEMPLATE_BYTES = 8 * 1024 * 1024; // 8 MB JSON
const MAX_MOCKUP_BYTES = 30 * 1024 * 1024; // 30 MB PNG/JPG

function isSafeName(name: string): boolean {
  return SAFE_NAME_RE.test(name) && name.length > 0 && name.length <= 64;
}

function isSafeFilename(name: string): boolean {
  return SAFE_FILENAME_RE.test(name) && name.length <= 96;
}

function ensureDirSync(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeJoin(base: string, name: string): string | null {
  const joined = path.resolve(base, name);
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (joined !== base && !joined.startsWith(baseWithSep)) return null;
  return joined;
}

async function readJsonSafe<T>(file: string): Promise<T | null> {
  try {
    const buf = await fs.promises.readFile(file, "utf-8");
    return JSON.parse(buf) as T;
  } catch {
    return null;
  }
}

function readRawBody(req: Request, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        reject(new Error(`Request body too large (>${max} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function registerHoodieTemplateMapperRoutes(app: Express) {
  ensureDirSync(TEMPLATES_DIR);
  ensureDirSync(MOCKUPS_DIR);

  app.get("/api/dev/hoodie-mapper/templates", async (_req: Request, res: Response) => {
    try {
      const entries = await fs.promises.readdir(TEMPLATES_DIR);
      const templates = await Promise.all(
        entries
          .filter((f) => f.endsWith(".json"))
          .map(async (f) => {
            const full = path.join(TEMPLATES_DIR, f);
            const stat = await fs.promises.stat(full);
            return {
              name: f.replace(/\.json$/i, ""),
              file: path.relative(PROJECT_ROOT, full),
              sizeBytes: stat.size,
              updatedAt: stat.mtime.toISOString(),
            };
          }),
      );
      templates.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      res.json({ directory: path.relative(PROJECT_ROOT, TEMPLATES_DIR), templates });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "list failed" });
    }
  });

  app.get("/api/dev/hoodie-mapper/templates/:name", async (req: Request, res: Response) => {
    const name = req.params.name;
    if (!isSafeName(name)) return res.status(400).json({ error: "Invalid template name" });
    const file = safeJoin(TEMPLATES_DIR, `${name}.json`);
    if (!file) return res.status(400).json({ error: "Invalid path" });
    if (!fs.existsSync(file)) return res.status(404).json({ error: "Not found" });
    const json = await readJsonSafe<unknown>(file);
    if (!json) return res.status(500).json({ error: "Failed to read template" });
    res.json(json);
  });

  app.post("/api/dev/hoodie-mapper/templates/:name", async (req: Request, res: Response) => {
    const name = req.params.name;
    if (!isSafeName(name)) return res.status(400).json({ error: "Invalid template name" });
    const file = safeJoin(TEMPLATES_DIR, `${name}.json`);
    if (!file) return res.status(400).json({ error: "Invalid path" });
    try {
      const raw = await readRawBody(req, MAX_TEMPLATE_BYTES);
      const text = raw.toString("utf-8");
      // Validate JSON shape minimally — make sure it parses.
      const parsed = JSON.parse(text) as { name?: string; version?: string };
      if (!parsed?.version || !String(parsed.version).startsWith("hoodie-template/")) {
        return res.status(400).json({ error: "Body missing 'version' = 'hoodie-template/v*'" });
      }
      // Make sure the JSON's `name` matches the route param if present.
      if (parsed.name && parsed.name !== name) {
        return res.status(400).json({ error: `Body 'name' (${parsed.name}) does not match route ${name}` });
      }
      ensureDirSync(TEMPLATES_DIR);
      await fs.promises.writeFile(file, text, "utf-8");
      const stat = await fs.promises.stat(file);
      res.json({
        ok: true,
        file: path.relative(PROJECT_ROOT, file),
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "save failed" });
    }
  });

  app.delete("/api/dev/hoodie-mapper/templates/:name", async (req: Request, res: Response) => {
    const name = req.params.name;
    if (!isSafeName(name)) return res.status(400).json({ error: "Invalid template name" });
    const file = safeJoin(TEMPLATES_DIR, `${name}.json`);
    if (!file) return res.status(400).json({ error: "Invalid path" });
    try {
      await fs.promises.unlink(file);
      res.json({ ok: true });
    } catch (err: any) {
      if (err?.code === "ENOENT") return res.status(404).json({ error: "Not found" });
      res.status(500).json({ error: err?.message || "delete failed" });
    }
  });

  app.get("/api/dev/hoodie-mapper/mockups", async (_req: Request, res: Response) => {
    try {
      const entries = await fs.promises.readdir(MOCKUPS_DIR);
      const mockups = await Promise.all(
        entries
          .filter((f) => SAFE_FILENAME_RE.test(f))
          .map(async (f) => {
            const full = path.join(MOCKUPS_DIR, f);
            const stat = await fs.promises.stat(full);
            return {
              filename: f,
              url: `/api/dev/hoodie-mapper/mockups/${encodeURIComponent(f)}`,
              sizeBytes: stat.size,
              updatedAt: stat.mtime.toISOString(),
            };
          }),
      );
      mockups.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      res.json({ directory: path.relative(PROJECT_ROOT, MOCKUPS_DIR), mockups });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "list failed" });
    }
  });

  app.get("/api/dev/hoodie-mapper/mockups/:filename", async (req: Request, res: Response) => {
    const filename = req.params.filename;
    if (!isSafeFilename(filename)) return res.status(400).send("Invalid filename");
    const file = safeJoin(MOCKUPS_DIR, filename);
    if (!file) return res.status(400).send("Invalid path");
    if (!fs.existsSync(file)) return res.status(404).send("Not found");
    const ext = path.extname(filename).toLowerCase();
    const contentType =
      ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-cache");
    fs.createReadStream(file).pipe(res);
  });

  app.post("/api/dev/hoodie-mapper/mockups/:filename", async (req: Request, res: Response) => {
    const filename = req.params.filename;
    if (!isSafeFilename(filename)) return res.status(400).json({ error: "Invalid filename" });
    const file = safeJoin(MOCKUPS_DIR, filename);
    if (!file) return res.status(400).json({ error: "Invalid path" });
    try {
      const buf = await readRawBody(req, MAX_MOCKUP_BYTES);
      ensureDirSync(MOCKUPS_DIR);
      await fs.promises.writeFile(file, buf);
      const stat = await fs.promises.stat(file);
      res.json({
        ok: true,
        filename,
        url: `/api/dev/hoodie-mapper/mockups/${encodeURIComponent(filename)}`,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "upload failed" });
    }
  });

  // eslint-disable-next-line no-console
  console.log("[hoodie-mapper] dev routes registered at /api/dev/hoodie-mapper/*");
}
