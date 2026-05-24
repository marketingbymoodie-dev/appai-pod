/**
 * Load `.env` into `process.env` for local development BEFORE any other
 * module reads it. Imported as a side-effect by `server/db.ts` and
 * `server/index.ts` so the load happens deterministically before
 * `new pg.Pool({ connectionString: process.env.DATABASE_URL })` runs —
 * regardless of cwd, import order, or ESM/CJS mode.
 *
 * Production behaviour (Railway, `npm start`, esbuild bundle):
 *   - Env vars are injected by the platform; there is no `.env` to load.
 *   - The `if (NODE_ENV !== "production")` guard is dead-code-eliminated by
 *     esbuild's `define: { "process.env.NODE_ENV": '"production"' }`, so
 *     this module compiles to a no-op in `dist/index.cjs`.
 *
 * Dev behaviour (`npm run dev`, `tsx server/index.ts`):
 *   - Resolves the project's `.env` relative to *this file's location*, so
 *     it is found even if the process was launched from a subdirectory.
 *   - Falls back to `cwd/.env` if URL resolution is unavailable.
 *   - Never overrides existing process.env values (dotenv default), so a
 *     value set manually via `$env:DATABASE_URL=...` always wins.
 */

import fs from "fs";
import path from "path";

declare const __dirname: string | undefined;

function safeResolve(...parts: Array<string | undefined>): string | undefined {
  if (parts.some((part) => typeof part !== "string" || part.length === 0)) return undefined;
  return path.resolve(...(parts as string[]));
}

async function resolveEnvPath(): Promise<string | undefined> {
  const candidates: string[] = [];

  // 1) ESM (dev via tsx): resolve relative to this module's URL.
  try {
    // Lazily access import.meta to avoid esbuild touching it in CJS prod builds.
    const metaUrl = (import.meta as { url?: string } | undefined)?.url;
    if (metaUrl) {
      // Dynamic import keeps this ESM-safe under tsx and only runs in dev.
      const { fileURLToPath } = await import("url");
      const here = path.dirname(fileURLToPath(metaUrl));
      const envPath = safeResolve(here, "..", ".env");
      if (envPath) candidates.push(envPath);
    }
  } catch {
    /* fall through */
  }

  // 2) CJS (esbuild bundle): __dirname is defined.
  try {
    if (typeof __dirname === "string" && __dirname.length > 0) {
      const envPath = safeResolve(__dirname, "..", ".env");
      if (envPath) candidates.push(envPath);
    }
  } catch {
    /* fall through */
  }

  // 3) Last resort: cwd/.env (default dotenv behaviour).
  const cwd = typeof process.cwd === "function" ? process.cwd() : undefined;
  const cwdEnvPath = safeResolve(cwd, ".env");
  if (cwdEnvPath) candidates.push(cwdEnvPath);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

if (process.env.NODE_ENV !== "production") {
  const envPath = await resolveEnvPath();
  if (envPath) {
    const dotenv = await import("dotenv");
    // `quiet: true` suppresses dotenv@17's marketing tip log.
    // `override: false` (the default) preserves vars already set in the shell.
    dotenv.config({ path: envPath, quiet: true });
  }
}
