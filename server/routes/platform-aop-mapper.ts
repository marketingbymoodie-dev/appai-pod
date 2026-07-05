/**
 * Platform-operator API for the AOP Panel Mapper admin UI.
 * Works in production (Railway) and local dev — gated by platform admin auth.
 *
 * Mounted at /api/platform/aop-mapper/*
 */
import { type Express, type Request, type Response } from "express";
import path from "path";
import { autoPublishHoodieTemplate } from "../hoodieTemplateAutoPublish";
import { fetchPrintifyBlankMockups } from "../aopMapperPrintifyBlanks";
import {
  deleteTemplate,
  ensureLocalMapperDirs,
  listMockupEntries,
  listReferenceOverlayEntries,
  listSourcePanelEntries,
  listTemplateEntries,
  readAssetBuffer,
  readTemplateText,
  writeAssetBuffer,
  writeTemplateText,
} from "../aopMapperStorage";
import { requirePlatformAdmin } from "../platformAdmin";

const HOODIE_MAPPER_HANDLER_VERSION = "2026-07-05-platform+supabase";
const PROJECT_ROOT = process.cwd();

const SAFE_NAME_RE = /^[a-zA-Z0-9_\-]+$/;
const SAFE_FILENAME_RE = /^[a-zA-Z0-9_\-]+\.(png|jpg|jpeg|webp)$/i;
const MAX_TEMPLATE_BYTES = 8 * 1024 * 1024;
const MAX_MOCKUP_BYTES = 30 * 1024 * 1024;
const MAX_SOURCE_PANEL_BYTES = 60 * 1024 * 1024;
const MAX_REFERENCE_OVERLAY_BYTES = 30 * 1024 * 1024;

type StorageLike = {
  getMerchantByUserId(userId: string): Promise<any>;
  getMerchantByShop(shop: string): Promise<any>;
};

function isSafeName(name: string): boolean {
  return SAFE_NAME_RE.test(name) && name.length > 0 && name.length <= 64;
}

function isSafeFilename(name: string): boolean {
  return SAFE_FILENAME_RE.test(name) && name.length <= 96;
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

async function resolvePrintifyCreds(
  storage: StorageLike,
  req: any,
): Promise<{ token: string; shopId: string } | null> {
  const userId = req.user?.claims?.sub;
  let merchant = userId ? await storage.getMerchantByUserId(userId) : null;
  const ownerShop = process.env.OWNER_SHOP_DOMAIN?.trim();
  if (ownerShop) {
    const ownerMerchant = await storage.getMerchantByShop(ownerShop);
    if (ownerMerchant?.printifyApiToken && ownerMerchant?.printifyShopId) {
      merchant = ownerMerchant;
    }
  }
  const token = merchant?.printifyApiToken || process.env.PRINTIFY_API_TOKEN || "";
  const shopId = merchant?.printifyShopId || process.env.PRINTIFY_SHOP_ID || "";
  if (!token || !shopId) return null;
  return { token, shopId };
}

function contentTypeForFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".json") return "application/json";
  return "image/png";
}

export function registerPlatformAopMapperRoutes(
  app: Express,
  deps: { storage: StorageLike; isAuthenticated: any },
) {
  const { storage, isAuthenticated } = deps;
  const BASE = "/api/platform/aop-mapper";
  const mockupUrlBase = `${BASE}/mockups`;

  ensureLocalMapperDirs();

  // eslint-disable-next-line no-console
  console.log(`[aop-mapper] platform routes registered at ${BASE}/* (handler ${HOODIE_MAPPER_HANDLER_VERSION})`);

  const adminOnly = (handler: (req: Request, res: Response) => Promise<void> | void) => {
    return async (req: any, res: Response) => {
      if (!requirePlatformAdmin(req, res)) return;
      return handler(req, res);
    };
  };

  app.get(`${BASE}/templates`, isAuthenticated, adminOnly(async (_req, res) => {
    try {
      const templates = await listTemplateEntries();
      res.json({ directory: "drafts/templates", templates });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "list failed" });
    }
  }));

  app.get(`${BASE}/templates/:name`, isAuthenticated, adminOnly(async (req, res) => {
    const name = req.params.name;
    if (!isSafeName(name)) return res.status(400).json({ error: "Invalid template name" });
    const text = await readTemplateText(name);
    if (!text) return res.status(404).json({ error: "Not found" });
    res.type("application/json").send(text);
  }));

  app.post(`${BASE}/templates/:name`, isAuthenticated, adminOnly(async (req, res) => {
    const name = req.params.name;
    const t0 = Date.now();
    if (!isSafeName(name)) return res.status(400).json({ error: "Invalid template name" });

    const HARD_TIMEOUT_MS = 10_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!res.headersSent) {
        res.status(504).json({
          error: `Server save handler timed out after ${HARD_TIMEOUT_MS}ms`,
          handler: HOODIE_MAPPER_HANDLER_VERSION,
        });
      }
    }, HARD_TIMEOUT_MS);

    try {
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

      const { localFile } = await writeTemplateText(name, text);
      if (timedOut) return;
      clearTimeout(timer);

      let publishResult: Awaited<ReturnType<typeof autoPublishHoodieTemplate>> | null = null;
      try {
        publishResult = await Promise.race([
          autoPublishHoodieTemplate(name),
          new Promise<Awaited<ReturnType<typeof autoPublishHoodieTemplate>>>(
            (resolve) =>
              setTimeout(
                () =>
                  resolve({
                    ok: false,
                    skipped: false,
                    error: "auto-publish timed out (8s)",
                    elapsedMs: 8000,
                  }),
                8000,
              ),
          ),
        ]);
      } catch (publishErr: any) {
        publishResult = {
          ok: false,
          skipped: false,
          error: publishErr?.message ?? String(publishErr),
          elapsedMs: 0,
        };
      }

      res.json({
        ok: true,
        file: localFile ?? `drafts/templates/${name}.json`,
        handler: HOODIE_MAPPER_HANDLER_VERSION,
        bodySource,
        elapsedMs: Date.now() - t0,
        publish: publishResult,
      });
    } catch (err: any) {
      clearTimeout(timer);
      if (!res.headersSent) {
        res.status(400).json({ error: err?.message || "save failed" });
      }
    }
  }));

  app.post(`${BASE}/templates/:name/publish`, isAuthenticated, adminOnly(async (req, res) => {
    const name = req.params.name;
    if (!isSafeName(name)) return res.status(400).json({ error: "Invalid template name" });
    if (!(await readTemplateText(name))) {
      return res.status(404).json({ error: `Template not found — Save "${name}" first.` });
    }
    try {
      const publishResult = await autoPublishHoodieTemplate(name);
      res.json({ ok: true, publish: publishResult });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "publish failed" });
    }
  }));

  app.delete(`${BASE}/templates/:name`, isAuthenticated, adminOnly(async (req, res) => {
    const name = req.params.name;
    if (!isSafeName(name)) return res.status(400).json({ error: "Invalid template name" });
    try {
      await deleteTemplate(name);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "delete failed" });
    }
  }));

  app.get(`${BASE}/mockups`, isAuthenticated, adminOnly(async (_req, res) => {
    try {
      const mockups = await listMockupEntries(mockupUrlBase);
      res.json({ directory: "drafts/mockups", mockups });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "list failed" });
    }
  }));

  app.get(`${BASE}/mockups/:filename`, isAuthenticated, adminOnly(async (req, res) => {
    const filename = req.params.filename;
    if (!isSafeFilename(filename)) return res.status(400).send("Invalid filename");
    const buf = await readAssetBuffer("mockups", filename);
    if (!buf) return res.status(404).send("Not found");
    res.setHeader("Content-Type", contentTypeForFilename(filename));
    res.setHeader("Cache-Control", "no-cache");
    res.send(buf);
  }));

  app.post(`${BASE}/mockups/:filename`, isAuthenticated, adminOnly(async (req, res) => {
    const filename = req.params.filename;
    if (!isSafeFilename(filename)) return res.status(400).json({ error: "Invalid filename" });
    try {
      const rawBody = (req as any).rawBody as Buffer | undefined;
      const buf =
        rawBody && rawBody.length > 0 ? rawBody : await readRawBody(req, MAX_MOCKUP_BYTES);
      if (buf.length === 0) return res.status(400).json({ error: "Empty body" });
      if (buf.length > MAX_MOCKUP_BYTES) {
        return res.status(413).json({ error: `Body too large (${buf.length} > ${MAX_MOCKUP_BYTES})` });
      }
      await writeAssetBuffer("mockups", filename, buf);
      res.json({
        ok: true,
        filename,
        url: `${mockupUrlBase}/${encodeURIComponent(filename)}`,
        sizeBytes: buf.length,
        updatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "upload failed" });
    }
  }));

  app.get(`${BASE}/source-panels`, isAuthenticated, adminOnly(async (_req, res) => {
    try {
      const panels = await listSourcePanelEntries(`${BASE}/source-panels`);
      res.json({ directory: "drafts/source-panels", panels });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "list failed" });
    }
  }));

  app.get(`${BASE}/source-panels/:filename`, isAuthenticated, adminOnly(async (req, res) => {
    const filename = req.params.filename;
    if (!isSafeFilename(filename)) return res.status(400).send("Invalid filename");
    const buf = await readAssetBuffer("source-panels", filename);
    if (!buf) return res.status(404).send("Not found");
    res.setHeader("Content-Type", contentTypeForFilename(filename));
    res.setHeader("Cache-Control", "no-cache");
    res.send(buf);
  }));

  app.post(`${BASE}/source-panels/:filename`, isAuthenticated, adminOnly(async (req, res) => {
    const filename = req.params.filename;
    if (!isSafeFilename(filename)) return res.status(400).json({ error: "Invalid filename" });
    try {
      const rawBody = (req as any).rawBody as Buffer | undefined;
      const buf =
        rawBody && rawBody.length > 0 ? rawBody : await readRawBody(req, MAX_SOURCE_PANEL_BYTES);
      if (buf.length === 0) return res.status(400).json({ error: "Empty body" });
      if (buf.length > MAX_SOURCE_PANEL_BYTES) {
        return res.status(413).json({ error: `Body too large (${buf.length} > ${MAX_SOURCE_PANEL_BYTES})` });
      }
      await writeAssetBuffer("source-panels", filename, buf);
      res.json({
        ok: true,
        filename,
        url: `${BASE}/source-panels/${encodeURIComponent(filename)}`,
        sizeBytes: buf.length,
        updatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "upload failed" });
    }
  }));

  app.get(`${BASE}/reference-overlays`, isAuthenticated, adminOnly(async (_req, res) => {
    try {
      const overlays = await listReferenceOverlayEntries(`${BASE}/reference-overlays`);
      res.json({ directory: "drafts/reference-overlays", overlays });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "list failed" });
    }
  }));

  app.get(`${BASE}/reference-overlays/:filename`, isAuthenticated, adminOnly(async (req, res) => {
    const filename = req.params.filename;
    if (!isSafeFilename(filename)) return res.status(400).send("Invalid filename");
    const buf = await readAssetBuffer("reference-overlays", filename);
    if (!buf) return res.status(404).send("Not found");
    res.setHeader("Content-Type", contentTypeForFilename(filename));
    res.setHeader("Cache-Control", "no-cache");
    res.send(buf);
  }));

  app.post(`${BASE}/reference-overlays/:filename`, isAuthenticated, adminOnly(async (req, res) => {
    const filename = req.params.filename;
    if (!isSafeFilename(filename)) return res.status(400).json({ error: "Invalid filename" });
    try {
      const rawBody = (req as any).rawBody as Buffer | undefined;
      const buf =
        rawBody && rawBody.length > 0 ? rawBody : await readRawBody(req, MAX_REFERENCE_OVERLAY_BYTES);
      if (buf.length === 0) return res.status(400).json({ error: "Empty body" });
      if (buf.length > MAX_REFERENCE_OVERLAY_BYTES) {
        return res
          .status(413)
          .json({ error: `Body too large (${buf.length} > ${MAX_REFERENCE_OVERLAY_BYTES})` });
      }
      await writeAssetBuffer("reference-overlays", filename, buf);
      res.json({
        ok: true,
        filename,
        url: `${BASE}/reference-overlays/${encodeURIComponent(filename)}`,
        sizeBytes: buf.length,
        updatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "upload failed" });
    }
  }));

  /** Download blank garment mockups from Printify (transparent print) into mapper storage. */
  app.post(
    `${BASE}/printify-blanks/:templateName`,
    isAuthenticated,
    adminOnly(async (req: any, res) => {
      const templateName = req.params.templateName;
      if (!isSafeName(templateName)) return res.status(400).json({ error: "Invalid template name" });
      const creds = await resolvePrintifyCreds(storage, req);
      if (!creds) {
        return res.status(400).json({
          error: "Printify credentials not configured. Connect Printify on the owner shop or set PRINTIFY_API_TOKEN + PRINTIFY_SHOP_ID.",
        });
      }
      try {
        const result = await fetchPrintifyBlankMockups({
          templateName,
          token: creds.token,
          shopId: creds.shopId,
          mockupUrlBase,
        });
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err?.message || "Printify blank download failed" });
      }
    }),
  );
}
