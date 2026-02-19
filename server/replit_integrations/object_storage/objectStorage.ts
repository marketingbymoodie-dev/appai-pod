import fs from "fs";
import path from "path";
import { Response } from "express";
import { randomUUID } from "crypto";
import {
  ObjectAclPolicy,
  ObjectPermission,
  getObjectAclPolicy,
  setObjectAclPolicy,
  canAccessObject,
} from "./objectAcl";

/**
 * Get the base storage directory.
 *
 * Priority order:
 *   1. STORAGE_DIR env var  (recommended for Railway — set to your Volume mount path, e.g. /data)
 *   2. ./local-storage      (automatic fallback for local development)
 *
 * If you previously used PRIVATE_OBJECT_DIR / GCS buckets, set STORAGE_DIR to a
 * plain directory path (no bucket prefix needed).
 */
export function getStorageDir(): string {
  return process.env.STORAGE_DIR || path.join(process.cwd(), "local-storage");
}

// ─── LocalFile ────────────────────────────────────────────────────────────────

/**
 * A thin wrapper around a filesystem path that exposes the same interface used
 * throughout the codebase (exists, save, getMetadata, createReadStream,
 * setMetadata).  Replaces the GCS File object.
 */
export class LocalFile {
  constructor(
    /** Absolute path on disk */
    public readonly localPath: string,
    /** Logical name, e.g. "designs/uuid.png" */
    public readonly name: string,
  ) {}

  async exists(): Promise<[boolean]> {
    try {
      await fs.promises.access(this.localPath);
      return [true];
    } catch {
      return [false];
    }
  }

  async save(
    data: Buffer | string,
    options?: { contentType?: string; metadata?: any },
  ): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.localPath), { recursive: true });
    await fs.promises.writeFile(this.localPath, data);
    const meta: Record<string, any> = {
      contentType: options?.contentType || "application/octet-stream",
    };
    if (options?.metadata?.metadata) {
      meta.customMetadata = options.metadata.metadata;
    }
    await fs.promises.writeFile(
      this.localPath + ".meta.json",
      JSON.stringify(meta),
    );
  }

  async getMetadata(): Promise<
    [{ contentType: string; size: string; metadata?: Record<string, string> }]
  > {
    let contentType = "application/octet-stream";
    let customMetadata: Record<string, string> | undefined;
    try {
      const raw = await fs.promises.readFile(
        this.localPath + ".meta.json",
        "utf8",
      );
      const parsed = JSON.parse(raw);
      contentType = parsed.contentType || contentType;
      customMetadata = parsed.customMetadata;
    } catch {
      const ext = path.extname(this.localPath).toLowerCase();
      const extMap: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
      };
      contentType = extMap[ext] || contentType;
    }
    try {
      const stat = await fs.promises.stat(this.localPath);
      return [{ contentType, size: String(stat.size), metadata: customMetadata }];
    } catch {
      return [{ contentType, size: "0", metadata: customMetadata }];
    }
  }

  async setMetadata(update: { metadata: Record<string, string> }): Promise<void> {
    let existing: Record<string, any> = {};
    try {
      existing = JSON.parse(
        await fs.promises.readFile(this.localPath + ".meta.json", "utf8"),
      );
    } catch {}
    existing.customMetadata = {
      ...(existing.customMetadata || {}),
      ...update.metadata,
    };
    await fs.promises.writeFile(
      this.localPath + ".meta.json",
      JSON.stringify(existing),
    );
  }

  createReadStream(): fs.ReadStream {
    return fs.createReadStream(this.localPath);
  }
}

// ─── LocalBucket / LocalStorageClient ────────────────────────────────────────

/**
 * Mimics the GCS Bucket interface (just the `file()` method).
 * All files live under STORAGE_DIR regardless of the "bucket name" passed in.
 */
class LocalBucket {
  constructor(private readonly base: string) {}

  file(objectName: string): LocalFile {
    const localPath = path.join(this.base, objectName);
    return new LocalFile(localPath, objectName);
  }
}

/**
 * Drop-in replacement for the GCS Storage client (`bucket()` method only).
 * Used by saveImageToStorage and cacheMockupToStorage in server code.
 *
 * The bucket name is ignored — all storage goes into STORAGE_DIR.
 */
class LocalStorageClient {
  bucket(_bucketName: string): LocalBucket {
    return new LocalBucket(getStorageDir());
  }
}

export const objectStorageClient = new LocalStorageClient();

// ─── Errors ───────────────────────────────────────────────────────────────────

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

// ─── ObjectStorageService ─────────────────────────────────────────────────────

export class ObjectStorageService {
  constructor() {}

  /** Returns STORAGE_DIR */
  getStorageDir(): string {
    return getStorageDir();
  }

  /**
   * Legacy accessor — kept so existing callers that do
   * `objectStorage.getPrivateObjectDir()` continue to work.
   * Returns STORAGE_DIR (PRIVATE_OBJECT_DIR is no longer used).
   */
  getPrivateObjectDir(): string {
    return getStorageDir();
  }

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    if (!pathsStr) return [getStorageDir()];
    return pathsStr
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  }

  async searchPublicObject(filePath: string): Promise<LocalFile | null> {
    const localPath = path.join(getStorageDir(), filePath);
    const file = new LocalFile(localPath, filePath);
    const [exists] = await file.exists();
    return exists ? file : null;
  }

  async downloadObject(
    file: LocalFile,
    res: Response,
    cacheTtlSec: number = 3600,
  ): Promise<void> {
    try {
      const [metadata] = await file.getMetadata();
      const aclPolicy = await getObjectAclPolicy(file);
      const isPublic = aclPolicy?.visibility !== "private";
      res.set({
        "Content-Type": metadata.contentType || "application/octet-stream",
        "Content-Length": metadata.size,
        "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
      });
      const stream = file.createReadStream();
      stream.on("error", (err) => {
        console.error("Stream error:", err);
        if (!res.headersSent) res.status(500).json({ error: "Error streaming file" });
      });
      stream.pipe(res);
    } catch (error) {
      console.error("Error downloading file:", error);
      if (!res.headersSent) res.status(500).json({ error: "Error downloading file" });
    }
  }

  /**
   * Save an uploaded buffer and return the public /objects/ path.
   * Used by the POST /api/uploads/upload route.
   */
  async saveUploadedBuffer(
    buffer: Buffer,
    contentType: string,
    ext: string = "bin",
  ): Promise<string> {
    const uploadsDir = path.join(getStorageDir(), "uploads");
    await fs.promises.mkdir(uploadsDir, { recursive: true });
    const filename = `${randomUUID()}.${ext}`;
    const file = new LocalFile(path.join(uploadsDir, filename), `uploads/${filename}`);
    await file.save(buffer, { contentType });
    return `/objects/uploads/${filename}`;
  }

  async getObjectEntityFile(objectPath: string): Promise<LocalFile> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }
    const relativePath = objectPath.slice("/objects/".length);
    const localPath = path.join(getStorageDir(), relativePath);
    const file = new LocalFile(localPath, relativePath);
    const [exists] = await file.exists();
    if (!exists) throw new ObjectNotFoundError();
    return file;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (rawPath.startsWith("/objects/")) return rawPath;
    try {
      const url = new URL(rawPath);
      if (url.pathname.startsWith("/objects/")) return url.pathname;
    } catch {}
    return rawPath;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/objects/")) return normalizedPath;
    try {
      const file = await this.getObjectEntityFile(normalizedPath);
      await setObjectAclPolicy(file, aclPolicy);
    } catch {}
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: LocalFile;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}
