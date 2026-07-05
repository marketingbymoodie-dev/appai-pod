import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import path from "path";
import fs from "fs";

let staticInitialized = false;

// Cross-environment directory resolution.
// In production (esbuild CJS): __dirname is natively available and equals dist/.
// In development (tsx ESM, package.json type:module): __dirname is undefined;
// we fall back to process.cwd() which is the project root.
declare const __dirname: string | undefined;
const _dirname: string = typeof __dirname === "string" && __dirname.length > 0 ? __dirname : process.cwd();

export function serveStatic(app: Express) {
  // Resolve dist/public relative to the built server file location using _dirname
  // Support both build layouts:
  // Case A: dist/index.cjs + dist/public -> publicDir = _dirname/public
  // Case B: dist/server/index.cjs + dist/public -> publicDir = _dirname/../public

  const candidateA = path.resolve(_dirname, "public");
  const candidateB = path.resolve(_dirname, "../public");

  const indexExistsA = fs.existsSync(path.join(candidateA, "index.html"));
  const indexExistsB = fs.existsSync(path.join(candidateB, "index.html"));

  let publicDir: string;
  if (indexExistsA) {
    publicDir = candidateA;
  } else if (indexExistsB) {
    publicDir = candidateB;
  } else {
    // Default to candidateA but log error
    publicDir = candidateA;
  }

  const indexPath = path.join(publicDir, "index.html");
  const indexExists = fs.existsSync(indexPath);

  /** Storefront routes must not load App Bridge — the `shop` query param would trigger admin redirect. */
  let indexHtml = "";
  let storefrontIndexHtml = "";
  if (indexExists) {
    indexHtml = fs.readFileSync(indexPath, "utf-8");
    storefrontIndexHtml = indexHtml
      .replace(/<meta name="shopify-api-key"[^>]*>\s*/g, "")
      .replace(/<script src="https:\/\/cdn\.shopify\.com\/shopifycloud\/app-bridge\.js"><\/script>\s*/g, "");
  }

  function isStorefrontSpaPath(pathname: string): boolean {
    return pathname.startsWith("/s/") || pathname.startsWith("/storefront/");
  }

  // Startup log (only once)
  if (!staticInitialized) {
    staticInitialized = true;
    console.log("[serveStatic] Startup diagnostics:");
    console.log(`  NODE_ENV: ${process.env.NODE_ENV}`);
    console.log(`  cwd: ${process.cwd()}`);
    console.log(`  _dirname: ${_dirname}`);
    console.log(`  candidateA: ${candidateA} (exists: ${indexExistsA})`);
    console.log(`  candidateB: ${candidateB} (exists: ${indexExistsB})`);
    console.log(`  chosen publicDir: ${publicDir}`);
    console.log(`  indexPath: ${indexPath}`);
    console.log(`  indexExists: ${indexExists}`);

    if (!indexExists) {
      console.error("===========================================================");
      console.error("[serveStatic] CRITICAL ERROR: index.html NOT FOUND!");
      console.error(`  Expected at: ${indexPath}`);
      console.error(`  _dirname: ${_dirname}`);
      console.error(`  cwd: ${process.cwd()}`);
      console.error("  SPA routes will fail with 404!");
      console.error("===========================================================");
    }
  }

  // Serve static assets
  app.use(
    express.static(publicDir, {
      index: false, // important: we'll handle index.html ourselves
    })
  );

  // SPA fallback: ONLY for GET, and NEVER for /api/*
  app.get("*", (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api")) {
      return next();
    }

    // Log SPA fallback requests in production
    console.log(`[SPA fallback] ${req.method} ${req.originalUrl}`);

    if (isStorefrontSpaPath(req.path) && storefrontIndexHtml) {
      res.status(200).set({ "Content-Type": "text/html; charset=UTF-8" }).end(storefrontIndexHtml);
      return;
    }

    res.sendFile(indexPath, (err) => {
      if (err) {
        console.error(`[SPA fallback] sendFile error for ${req.originalUrl}:`, err);
        next(err);
      }
    });
  });
}
