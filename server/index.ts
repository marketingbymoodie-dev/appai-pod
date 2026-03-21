import "dotenv/config";

import express, { type Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";

// ESM-compatible __dirname polyfill
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { registerRoutes } from "./routes";
import { registerAdminBrandingRoutes } from "./routes/admin-branding";
import { serveStatic } from "./static";
import { createServer } from "http";

// ============================================================
// STARTUP BANNER - Identify deployed version
// ============================================================
const BUILD_ID = "2026-02-19-app-proxy-v2";
const GIT_COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "unknown";
console.log("=".repeat(60));
console.log("[SERVER STARTUP] Build ID:", BUILD_ID);
console.log("[SERVER STARTUP] Git Commit:", GIT_COMMIT);
console.log("[SERVER STARTUP] Node Version:", process.version);
console.log("[SERVER STARTUP] NODE_ENV:", process.env.NODE_ENV);
console.log("[SERVER STARTUP] Timestamp:", new Date().toISOString());
console.log("=".repeat(60));

const app = express();

// ============================================================
// APP PROXY URL REWRITER — must be FIRST middleware so all
// subsequent route handlers see the real path.
//
// Shopify App Proxy rewrites:
//   storefront: /apps/appai/<path>
//   → Railway:  /api/proxy/<path>?shop=...&timestamp=...&signature=...
//
// This middleware strips /api/proxy so existing handlers match:
//   /api/proxy/api/storefront/generate → /api/storefront/generate
//   /api/proxy/api/config              → /api/config
//   /api/proxy/s/designer              → /s/designer (handled specially below)
// ============================================================
function verifyShopifyProxyHmac(query: Record<string, string>): boolean {
  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  if (!secret) return false;
  const { signature, ...rest } = query;
  if (!signature) return false;
  const message = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join("");
  const computed = crypto.createHmac("sha256", secret).update(message).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

// Proxy root: /apps/appai/ → redirect to /apps/appai/s/designer
app.get(["/api/proxy", "/api/proxy/"], (req, res) => {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  console.log(`[APP PROXY] Root hit → redirecting to /api/proxy/s/designer${qs}`);
  return res.redirect(302, `/api/proxy/s/designer${qs}`);
});

app.use((req, res, next) => {
  if (!req.url.startsWith("/api/proxy/")) return next();

  const suffix = req.url.slice("/api/proxy".length);
  const shouldRewrite = suffix.startsWith("/api/") || suffix.startsWith("/s/")
    || suffix.startsWith("/assets/") || suffix.startsWith("/favicon");

  if (!shouldRewrite) {
    return next();
  }

  const query = req.query as Record<string, string>;
  const valid = verifyShopifyProxyHmac(query);
  if (!valid) {
    if (process.env.NODE_ENV === "production" && process.env.SHOPIFY_API_SECRET) {
      console.warn(`[APP PROXY] Invalid signature from ${req.ip} for ${req.url}`);
      return res.status(401).json({ error: "Invalid proxy signature" });
    }
    console.warn(`[APP PROXY] Signature check skipped (no secret or dev mode) for ${req.url}`);
  }

  const original = req.url;
  req.url = suffix;
  (req as any).isProxied = true;
  console.log(`[APP PROXY] ${req.method} ${original} → ${req.url} shop=${query.shop ?? "?"}`);
  next();
});

// ============================================================
// GLOBAL API CORS — single authoritative handler for all /api routes.
// Rules:
//   - Echo the request Origin (never wildcard when credentials matter)
//   - Vary: Origin so CDN/proxies cache per-origin
//   - Credentials: false  (storefront is public; admin uses session tokens, not cookies)
//   - X-Req-Id allowed so storefront correlation IDs pass through
// ============================================================
app.use("/api", (req, res, next) => {
  const origin = req.headers.origin;

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  // No origin header = same-origin or non-browser request; no ACAO needed.

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, X-Req-Id");
  res.setHeader("Access-Control-Allow-Credentials", "false");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    console.log(`[CORS] OPTIONS ${req.originalUrl} origin=${origin ?? 'none'}`);
    return res.sendStatus(204);
  }

  next();
});

// ============================================================
// STOREFRONT PROBE + correlation ID — runs after CORS, before routes
// ============================================================
app.use("/api/storefront", (req, res, next) => {
  const reqId = (req.headers["x-req-id"] as string) || `srv-${Date.now().toString(36)}`;
  (req as any).reqId = reqId;
  res.setHeader("X-Req-Id", reqId);
  console.log(`[SF] ${req.method} ${req.originalUrl} reqId=${reqId} origin=${req.headers.origin ?? 'none'}`);
  next();
});

// ============================================================
// STEP 3: SAFE PING ROUTE - Before any auth middleware
// ============================================================
app.get("/api/storefront/ping", (req, res) => {
  console.log("[PING HIT] /api/storefront/ping");
  res.status(200).json({ ok: true, ts: Date.now(), probe: "direct" });
});

/**
 * ✅ Required for Shopify iframe embedding
 */
app.set("trust proxy", 1);
app.use((req, res, next) => {
  // In development, also allow the Manus sandbox tunnel domain so the storefront
  // preview launcher (port 5001) can embed the designer in an iframe.
  const isDev = process.env.NODE_ENV === "development";
  const frameAncestors = isDev
    ? "frame-ancestors https://*.myshopify.com https://admin.shopify.com https://*.manus.computer 'self'"
    : "frame-ancestors https://*.myshopify.com https://admin.shopify.com";
  res.setHeader("Content-Security-Policy", frameAncestors);
  next();
});

// NOTE: CORS is now handled globally at the top of the middleware chain

const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(cookieParser());

// Static assets (non-build scripts)
app.use("/scripts", express.static(path.resolve(process.cwd(), "public/scripts")));

// Body parsing
app.use(
  express.json({
    limit: "50mb",
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: false, limit: "50mb" }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// Request logging (API only)
app.use((req, res, next) => {
  const start = Date.now();
  const reqPath = req.path;
  let capturedJsonResponse: Record<string, any> | undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson as any;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (reqPath.startsWith("/api")) {
      let logLine = `${req.method} ${reqPath} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      log(logLine);
    }
  });

  next();
});

(async () => {
  /**
   * ✅ IMPORTANT:
   * Do NOT apply auth globally here (no `app.use("/api", isAuthenticated)`).
   * Auth must be applied per-route inside routes.ts only.
   */

  // ✅ 0) Run startup migration — ensures missing DB columns exist
  try {
    const { runStartupMigrations } = await import("./migrations/startup");
    await runStartupMigrations();
  } catch (migrationError) {
    console.error("[SERVER STARTUP] Startup migration failed — continuing boot:", migrationError);
  }

  // ✅ 1) Register API + server routes FIRST
  await registerRoutes(httpServer, app);
  
  // ✅ 1b) Register admin branding routes
  registerAdminBrandingRoutes(app);

  // ✅ Route registration sanity check — list all storefront routes
  const storefrontRoutes: string[] = [];
  app._router.stack.forEach((layer: any) => {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).map(m => m.toUpperCase()).join(',');
      const path = layer.route.path;
      if (typeof path === 'string' && path.includes('/api/storefront')) {
        storefrontRoutes.push(`${methods} ${path}`);
      }
    }
  });
  console.log("[ROUTE CHECK] Registered /api/storefront routes:", storefrontRoutes.length);
  storefrontRoutes.forEach(r => console.log("  →", r));
  // Verify critical routes exist
  const criticalRoutes = ['/api/storefront/generate', '/api/storefront/mockup', '/api/storefront/ping'];
  for (const route of criticalRoutes) {
    const found = storefrontRoutes.some(r => r.includes(route));
    if (!found) {
      console.error(`[ROUTE CHECK] CRITICAL: ${route} is NOT registered!`);
    }
  }

  /**
   * ✅ 2) CRITICAL FIX:
   * If an /api route wasn't matched above, return JSON 404 here.
   * This prevents the SPA fallback from returning index.html for /api/* routes.
   */
  app.use("/api", (req, res) => {
    res.status(404).json({
      error: "API route not found",
      path: req.originalUrl,
    });
  });

  // Legacy redirect: /embed/design?storefront=true → /s/designer (preserving params)
  app.get("/embed/design", (req: Request, res: Response, next: NextFunction) => {
    const params = new URLSearchParams(req.query as Record<string, string>);
    if (params.get("storefront") === "true") {
      params.delete("storefront");
      const qs = params.toString();
      const target = `/s/designer${qs ? '?' + qs : ''}`;
      console.log(`[Legacy redirect] /embed/design?storefront=true → ${target}`);
      return res.redirect(302, target);
    }
    next();
  });

  // Global error handler — catches errors forwarded by asyncHandler and other middleware.
  // Must have 4 parameters so Express recognises it as an error handler.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[SERVER ERROR]", err?.stack ?? err);

    if (res.headersSent) return;

    const status = err.status || err.statusCode || 500;
    const payload: Record<string, any> = { error: "Internal server error" };
    if (process.env.NODE_ENV !== "production") {
      payload.details = err.message;
    }
    res.status(status).json(payload);
  });


  // ────────────────────────────────────────────────────────────
  // Proxy-aware static assets + SPA HTML for /s/designer
  //
  // Vite builds with base: "./" so HTML contains relative asset refs:
  //   <script src="./assets/index-xxx.js">
  // Browser at /apps/appai/s/designer resolves these to /apps/appai/s/assets/...
  // Shopify proxies → /api/proxy/s/assets/... → rewriter → /s/assets/...
  // This static middleware serves them from dist/public.
  // ────────────────────────────────────────────────────────────
  {
    const candidateA = path.resolve(__dirname, "public");
    const candidateB = path.resolve(__dirname, "../public");
    const publicDir = fs.existsSync(path.join(candidateA, "index.html")) ? candidateA
                    : fs.existsSync(path.join(candidateB, "index.html")) ? candidateB
                    : candidateA;

    // Serve assets at /s/ so /s/assets/index-xxx.js → publicDir/assets/index-xxx.js
    app.use("/s", express.static(publicDir, { index: false }));
    console.log(`[APP PROXY] Static assets mounted at /s → ${publicDir}`);

    // Proxied designer HTML handler
    app.get("/s/designer", (req: Request, res: Response, next: NextFunction) => {
      if (!(req as any).isProxied) return next();

      const indexPath = path.join(publicDir, "index.html");
      if (!fs.existsSync(indexPath)) {
        console.error("[APP PROXY HTML] index.html not found at", indexPath);
        return res.status(503).send("App is starting up. Please try again in a moment.");
      }

      const P = "/apps/appai";
      let html = fs.readFileSync(indexPath, "utf-8");

      // Rewrite absolute /assets/ refs to proxy path (handles base:"/" builds)
      html = html.replace(/((?:src|href)=")\/assets\//g, `$1${P}/assets/`);
      html = html.replace(/((?:src|href)=")\/favicon/g, `$1${P}/favicon`);

      // Rewrite relative ./assets/ refs to proxy path (handles base:"./" builds)
      html = html.replace(/((?:src|href)=")\.\/assets\//g, `$1${P}/assets/`);

      // Inject globals: API base + router base
      const injection = `<script>window.__APPAI_API_BASE__="${P}";window.__APPAI_ROUTER_BASE__="${P}";</script>`;
      html = html.replace("<head>", `<head>\n  ${injection}`);

      console.log(`[APP PROXY HTML] Serving proxied designer HTML — assets+api via ${P}`);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Frame-Options", "ALLOWALL");
      res.send(html);
    });
  }

  // ✅ 3) Vite in dev, static in prod (LAST)
  if (process.env.NODE_ENV === "production") {
    console.log("[server/index.ts] Production mode detected, initializing static serving...");
    console.log(`  NODE_ENV: ${process.env.NODE_ENV}`);
    console.log(`  app.get("env"): ${app.get("env")}`);
    console.log(`  cwd: ${process.cwd()}`);
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // Port binding
  const port = parseInt(process.env.PORT || "5000", 10);

  // ✅ Windows fix: reusePort is Linux-only
  const listenOptions: any = {
    port,
    host: "0.0.0.0",
    ...(process.platform === "linux" ? { reusePort: true } : {}),
  };

  httpServer.listen(listenOptions, () => {
    log(`serving on port ${port}`);
  });
})();
