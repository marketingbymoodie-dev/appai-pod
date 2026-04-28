import crypto from "crypto";
import { generatePrintifyMockup, type MockupImage, type MockupRequest, type MockupResult } from "./printify-mockups";
import { uploadMockupToSupabase } from "./supabaseMockups";

export type MockupJobStatus = "queued" | "pending" | "done" | "failed";

export interface MockupJobState {
  id: string;
  status: MockupJobStatus;
  correlationId: string;
  createdAt: number;
  doneAt?: number;
  mockupUrls?: string[];
  mockupImages?: MockupImage[];
  error?: string;
  source?: MockupResult["source"];
}

interface CachedMockupResult {
  result: MockupResult;
  ts: number;
}

interface EnqueueContext {
  correlationId: string;
  cacheParts?: Record<string, unknown>;
}

const JOB_DONE_TTL_MS = 5 * 60 * 1000;
const JOB_PENDING_TTL_MS = 5 * 60 * 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 100;

const jobs = new Map<string, MockupJobState>();
const mockupCache = new Map<string, CachedMockupResult>();
const inFlightByHash = new Map<string, string>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

function hashString(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildRequestCacheKey(request: MockupRequest, cacheParts?: Record<string, unknown>): string {
  const panelHashes = (request.panelUrls || [])
    .map((panel) => ({
      position: panel.position,
      hash: hashString(panel.dataUrl || ""),
    }))
    .sort((a, b) => a.position.localeCompare(b.position));

  const keyMaterial = {
    blueprintId: request.blueprintId,
    providerId: request.providerId,
    variantId: request.variantId,
    imageUrlHash: request.panelUrls?.length ? undefined : hashString(request.imageUrl || ""),
    scale: request.scale,
    x: request.x,
    y: request.y,
    doubleSided: request.doubleSided,
    wrapAround: request.wrapAround,
    wrapDirection: request.wrapDirection,
    mirrorLegs: request.mirrorLegs,
    aopPositions: request.aopPositions,
    panelHashes,
    cacheParts,
  };

  return hashString(stableStringify(keyMaterial));
}

function pruneCache() {
  const now = Date.now();

  for (const [jobId, job] of jobs) {
    const expiredDone = job.doneAt && now - job.doneAt > JOB_DONE_TTL_MS;
    const expiredPending = !job.doneAt && now - job.createdAt > JOB_PENDING_TTL_MS;
    if (expiredDone || expiredPending) jobs.delete(jobId);
  }

  for (const [key, cached] of mockupCache) {
    if (now - cached.ts > CACHE_TTL_MS) mockupCache.delete(key);
  }

  while (mockupCache.size > CACHE_LIMIT) {
    const oldestKey = mockupCache.keys().next().value;
    if (!oldestKey) break;
    mockupCache.delete(oldestKey);
  }
}

async function cacheMockupImages(result: MockupResult, correlationId: string): Promise<MockupResult> {
  if (!result.success || !result.mockupImages?.length) return result;

  console.log(`[Mockup Job] [${correlationId}] Caching ${result.mockupImages.length} mockup image(s) to Supabase...`);
  const cachedImages = await Promise.all(
    result.mockupImages.map(async (img, idx) => {
      try {
        const viewName = img.label || `view-${idx}`;
        const cachedUrl = await uploadMockupToSupabase({
          sourceUrl: img.url,
          designId: correlationId,
          viewName,
        });
        if (cachedUrl) {
          console.log(`[Mockup Job] [${correlationId}] Cached ${viewName} -> ${cachedUrl.substring(0, 80)}`);
          return { url: cachedUrl, label: img.label };
        }
      } catch (error: any) {
        console.warn(`[Mockup Job] [${correlationId}] Cache failed for ${img.label}:`, error?.message || error);
      }
      return img;
    }),
  );

  return {
    ...result,
    mockupImages: cachedImages,
    mockupUrls: cachedImages.map((img) => img.url),
  };
}

async function runMockupJob(jobId: string, cacheKey: string, request: MockupRequest) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = "pending";
  try {
    console.log(`[Mockup Job] [${job.correlationId}] Starting background Printify mockup job ${jobId}`);
    const result = await generatePrintifyMockup(request);
    const durableResult = await cacheMockupImages(result, job.correlationId);

    job.status = durableResult.success ? "done" : "failed";
    job.doneAt = Date.now();
    job.mockupUrls = durableResult.mockupUrls;
    job.mockupImages = durableResult.mockupImages;
    job.error = durableResult.error;
    job.source = durableResult.source;

    if (durableResult.success) {
      mockupCache.set(cacheKey, { result: durableResult, ts: Date.now() });
    }

    console.log(`[Mockup Job] [${job.correlationId}] Finished job ${jobId}:`, {
      status: job.status,
      mockupCount: job.mockupUrls?.length || 0,
      error: job.error || null,
    });
  } catch (error: any) {
    job.status = "failed";
    job.doneAt = Date.now();
    job.error = error?.message || "Failed to generate mockup";
    console.error(`[Mockup Job] [${job.correlationId}] Job ${jobId} failed:`, error);
  } finally {
    inFlightByHash.delete(cacheKey);
    pruneCache();
  }
}

export async function enqueueMockupJob(
  request: MockupRequest,
  ctx: EnqueueContext,
): Promise<{ jobId: string; cached?: MockupResult }> {
  pruneCache();

  const cacheKey = buildRequestCacheKey(request, ctx.cacheParts);
  const cached = mockupCache.get(cacheKey);
  if (cached && Date.now() - cached.ts <= CACHE_TTL_MS) {
    const jobId = crypto.randomUUID();
    jobs.set(jobId, {
      id: jobId,
      status: "done",
      correlationId: ctx.correlationId,
      createdAt: Date.now(),
      doneAt: Date.now(),
      mockupUrls: cached.result.mockupUrls,
      mockupImages: cached.result.mockupImages,
      source: cached.result.source,
      error: cached.result.error,
    });
    console.log(`[Mockup Job] [${ctx.correlationId}] Cache hit for job ${jobId}`);
    return { jobId, cached: cached.result };
  }

  const existingJobId = inFlightByHash.get(cacheKey);
  if (existingJobId && jobs.has(existingJobId)) {
    console.log(`[Mockup Job] [${ctx.correlationId}] Reusing in-flight job ${existingJobId}`);
    return { jobId: existingJobId };
  }

  const jobId = crypto.randomUUID();
  jobs.set(jobId, {
    id: jobId,
    status: "queued",
    correlationId: ctx.correlationId,
    createdAt: Date.now(),
  });
  inFlightByHash.set(cacheKey, jobId);

  setTimeout(() => {
    void runMockupJob(jobId, cacheKey, request);
  }, 0);

  return { jobId };
}

export function getMockupJob(jobId: string): MockupJobState | null {
  pruneCache();
  return jobs.get(jobId) || null;
}
