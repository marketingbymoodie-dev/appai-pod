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

// Bump this whenever the save handler logic changes so the banner clearly
// shows in the dev server log when the new code is loaded. If the user
// hits Save and does NOT see a `[hoodie-mapper] save start` line in the
// server log, their dev server is still running the OLD module — restart
// `npm run dev` to pick up the change.
const HOODIE_MAPPER_HANDLER_VERSION = "2026-05-24-save-rawbody+timeout";

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

  // eslint-disable-next-line no-console
  console.log(
    `[hoodie-mapper] routes registered (handler ${HOODIE_MAPPER_HANDLER_VERSION}) ` +
      `templates=${path.relative(PROJECT_ROOT, TEMPLATES_DIR)} mockups=${path.relative(
        PROJECT_ROOT,
        MOCKUPS_DIR,
      )}`,
  );

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
    const t0 = Date.now();
    // eslint-disable-next-line no-console
    console.log(
      `[hoodie-mapper] save start name=${name} content-type=${req.headers["content-type"] ?? "?"} ` +
        `content-length=${req.headers["content-length"] ?? "?"} ` +
        `handler=${HOODIE_MAPPER_HANDLER_VERSION}`,
    );

    if (!isSafeName(name)) {
      // eslint-disable-next-line no-console
      console.warn(`[hoodie-mapper] save reject name=${name} reason=invalid-name`);
      return res.status(400).json({ error: "Invalid template name" });
    }
    const file = safeJoin(TEMPLATES_DIR, `${name}.json`);
    if (!file) return res.status(400).json({ error: "Invalid path" });

    // Hard server-side timeout — even with the rawBody fix in place, we
    // never want this handler to hang the client. If anything below takes
    // longer than this, give the client a clear 504 instead of letting
    // the request sit open for minutes.
    const HARD_TIMEOUT_MS = 10_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // eslint-disable-next-line no-console
      console.error(
        `[hoodie-mapper] save TIMEOUT name=${name} after=${Date.now() - t0}ms ` +
          `handler=${HOODIE_MAPPER_HANDLER_VERSION}`,
      );
      if (!res.headersSent) {
        res.status(504).json({
          error: `Server save handler timed out after ${HARD_TIMEOUT_MS}ms`,
          handler: HOODIE_MAPPER_HANDLER_VERSION,
        });
      }
    }, HARD_TIMEOUT_MS);

    try {
      // The global express.json() middleware parses application/json bodies
      // before this handler runs, draining the request stream. Prefer the
      // raw buffer captured by its `verify` hook (req.rawBody); if that is
      // missing, fall back to the parsed body; only as a last resort drain
      // the stream ourselves (which would hang if it was already consumed).
      const rawBody = (req as any).rawBody as Buffer | undefined;
      let text: string;
      let bodySource: "rawBody" | "parsedBody" | "stream";
      if (rawBody && rawBody.length > 0) {
        text = rawBody.toString("utf-8");
        bodySource = "rawBody";
      } else if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
        text = JSON.stringify(req.body);
        bodySource = "parsedBody";
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[hoodie-mapper] save fallback-stream name=${name} — neither req.rawBody ` +
            `nor parsed req.body had content; this almost always means the dev ` +
            `server is running OLD code (restart 'npm run dev') OR express.json ` +
            `did not match the request content-type.`,
        );
        const raw = await readRawBody(req, MAX_TEMPLATE_BYTES);
        text = raw.toString("utf-8");
        bodySource = "stream";
      }
      if (timedOut) return;
      if (text.length > MAX_TEMPLATE_BYTES) {
        clearTimeout(timer);
        return res.status(413).json({ error: `Body too large (${text.length} > ${MAX_TEMPLATE_BYTES})` });
      }
      const parsed = JSON.parse(text) as { name?: string; version?: string };
      if (!parsed?.version || !String(parsed.version).startsWith("hoodie-template/")) {
        clearTimeout(timer);
        return res.status(400).json({ error: "Body missing 'version' = 'hoodie-template/v*'" });
      }
      if (parsed.name && parsed.name !== name) {
        clearTimeout(timer);
        return res.status(400).json({ error: `Body 'name' (${parsed.name}) does not match route ${name}` });
      }
      ensureDirSync(TEMPLATES_DIR);
      await fs.promises.writeFile(file, text, "utf-8");
      const stat = await fs.promises.stat(file);
      if (timedOut) return;
      clearTimeout(timer);
      // eslint-disable-next-line no-console
      console.log(
        `[hoodie-mapper] save done name=${name} bytes=${stat.size} ` +
          `body-source=${bodySource} elapsed=${Date.now() - t0}ms`,
      );
      res.json({
        ok: true,
        file: path.relative(PROJECT_ROOT, file),
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        handler: HOODIE_MAPPER_HANDLER_VERSION,
        bodySource,
        elapsedMs: Date.now() - t0,
      });
    } catch (err: any) {
      clearTimeout(timer);
      // eslint-disable-next-line no-console
      console.error(
        `[hoodie-mapper] save error name=${name} elapsed=${Date.now() - t0}ms err=${err?.message ?? err}`,
      );
      if (!res.headersSent) {
        res.status(400).json({ error: err?.message || "save failed" });
      }
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
      // Prefer the buffer captured by express.json's verify hook (req.rawBody)
      // when present — Express's middleware drains the stream for any matching
      // type and the rawBody hook captures it. For unmatched content-types the
      // stream is still readable and we fall back to reading it directly.
      const rawBody = (req as any).rawBody as Buffer | undefined;
      const buf =
        rawBody && rawBody.length > 0 ? rawBody : await readRawBody(req, MAX_MOCKUP_BYTES);
      if (buf.length === 0) {
        return res.status(400).json({ error: "Empty body. Did Express middleware consume it?" });
      }
      if (buf.length > MAX_MOCKUP_BYTES) {
        return res.status(413).json({ error: `Body too large (${buf.length} > ${MAX_MOCKUP_BYTES})` });
      }
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
