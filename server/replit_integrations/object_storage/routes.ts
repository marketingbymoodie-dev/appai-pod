import type { Express } from "express";
import { ObjectStorageService, ObjectNotFoundError, getStorageDir } from "./objectStorage";
import path from "path";

function contentTypeToExt(contentType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  const base = contentType.split(";")[0].trim().toLowerCase();
  return map[base] || "bin";
}

/**
 * Register object storage routes.
 *
 * Routes:
 *   POST /api/uploads/upload  — direct file upload (replaces the old presigned-URL flow)
 *   GET  /objects/:path(*)    — serve stored files
 *
 * The old POST /api/uploads/request-url is kept as a compatibility shim that
 * redirects clients to use the new endpoint, returning a 503 with a clear
 * message rather than silently failing.
 */
export function registerObjectStorageRoutes(app: Express): void {
  const objectStorageService = new ObjectStorageService();

  /**
   * Direct file upload endpoint.
   *
   * Accepts two body formats:
   *
   * 1. JSON  { "dataUrl": "data:image/png;base64,...", "name": "file.png" }
   * 2. Raw binary body with the correct Content-Type header (e.g. image/png)
   *
   * Response: { "objectPath": "/objects/uploads/uuid.png" }
   */
  app.post("/api/uploads/upload", async (req, res) => {
    try {
      const bodyContentType = req.headers["content-type"] || "";
      let buffer: Buffer;
      let contentType: string;
      let ext = "bin";

      if (bodyContentType.toLowerCase().includes("application/json")) {
        const { dataUrl, name } = req.body as { dataUrl?: string; name?: string };
        if (!dataUrl) {
          return res.status(400).json({ error: "Missing dataUrl in JSON body" });
        }
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
        if (!match) {
          return res.status(400).json({ error: "Invalid data URL format" });
        }
        contentType = match[1];
        buffer = Buffer.from(match[2], "base64");
        ext = name ? (name.split(".").pop() || contentTypeToExt(contentType)) : contentTypeToExt(contentType);
      } else {
        // Raw binary body
        buffer = req.body as Buffer;
        contentType = bodyContentType.split(";")[0].trim() || "application/octet-stream";
        ext = contentTypeToExt(contentType);
      }

      const objectPath = await objectStorageService.saveUploadedBuffer(buffer, contentType, ext);
      res.json({ objectPath });
    } catch (error) {
      console.error("Error uploading file:", error);
      res.status(500).json({ error: "Failed to upload file" });
    }
  });

  /**
   * Legacy compatibility shim.
   * Old clients that still call /api/uploads/request-url receive a clear 410 Gone
   * instead of a cryptic 500, prompting them to use the new endpoint.
   */
  app.post("/api/uploads/request-url", (_req, res) => {
    res.status(410).json({
      error: "This endpoint has been replaced. Use POST /api/uploads/upload instead.",
    });
  });

  /**
   * Serve stored files.
   * GET /objects/:objectPath(*)
   */
  app.get("/objects/:objectPath(*)", async (req, res) => {
    try {
      // Path traversal protection
      const storageDir = getStorageDir();
      const relativePath = req.params.objectPath;
      const resolved = path.resolve(storageDir, relativePath);
      if (!resolved.startsWith(path.resolve(storageDir))) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const objectFile = await objectStorageService.getObjectEntityFile(req.path);
      await objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        return res.status(404).json({ error: "Object not found" });
      }
      console.error("Error serving object:", error);
      return res.status(500).json({ error: "Failed to serve object" });
    }
  });
}
