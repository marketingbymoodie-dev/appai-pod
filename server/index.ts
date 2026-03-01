import "dotenv/config";

import express, { type Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";

// ============================================================
// STARTUP BANNER - Identify deployed version
// ============================================================
const BUILD_ID = "2026-02-19-app-proxy-v1";
const RAILWAY_URL = "https://appai-pod-production.up.railway.app";
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
// EDGE TEST - Absolute first route, no middleware
// ============================================================
app.get("/edge-test", (req, res) => {
  console.log("[EDGE TEST] HIT - origin:", req.headers.origin, "host:", req.headers.host);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.json({ ok: true, edge: "reached", ts: Date.now() });
});

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

app.use((req, res, next) => {
  if (!req.url.startsWith("/api/proxy/")) return next();

  // Verify Shopify HMAC — reject in production if invalid
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
  // Strip /api/proxy prefix, keeping query string intact
  req.url = req.url.replace(/^\/api\/proxy/, "");
  (req as any).isProxied = true;
  console.log(`[APP PROXY] ${req.method} ${original} → ${req.url} shop=${query.shop ?? "?"}`);
  next();
});

// ============================================================
// STEP 1: GLOBAL PROBE - MUST BE FIRST MIDDLEWARE
// ============================================================
app.use((req, res, next) => {
  console.log(`[GLOBAL PROBE] ${new Date().toISOString()} ${req.method} ${req.url}`);
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

// ============================================================
// API TEST ROUTE - Direct test before registerRoutes
// ============================================================
app.get("/api/test", (req, res) => {
  console.log("[API TEST] HIT - origin:", req.headers.origin);
  res.json({ ok: true, api: "test", ts: Date.now() });
});

// ============================================================
// DIRECT DESIGNER ROUTE - Bypass registerRoutes to test
// ============================================================
app.get("/api/storefront/product-types/:id/designer-direct", (req, res) => {
  console.log("[DESIGNER-DIRECT] HIT - id:", req.params.id, "shop:", req.query.shop);
  res.json({
    ok: true,
    route: "designer-direct",
    id: req.params.id,
    shop: req.query.shop,
    ts: Date.now()
  });
});

/**
 * ✅ Required for Shopify iframe embedding
 */
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors https://*.myshopify.com https://admin.shopify.com"
  );
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

// Early request logging for debugging
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    console.log(`[INCOMING] ${req.method} ${req.path}`);
  }
  next();
});

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
  // Proxy-aware SPA HTML route
  //
  // When a request arrives via the App Proxy (req.isProxied=true)
  // for /s/designer, we serve index.html with:
  //   1. Absolute Railway URLs for all JS/CSS assets
  //      (browser is on Shopify origin; relative /assets/ would 404)
  //   2. An injected script that sets window.__APPAI_API_BASE__="/apps/appai"
  //      so all API calls go through the proxy (same Shopify origin)
  // Non-proxied requests fall through to Vite (dev) or serveStatic (prod).
  // ────────────────────────────────────────────────────────────
  app.get("/s/designer", (req: Request, res: Response, next: NextFunction) => {
    if (!(req as any).isProxied) return next(); // normal request — let Vite/static handle it

    // Find the built index.html
    const candidateA = path.resolve(__dirname, "public", "index.html");
    const candidateB = path.resolve(__dirname, "../public", "index.html");
    const indexPath = fs.existsSync(candidateA) ? candidateA
                    : fs.existsSync(candidateB) ? candidateB
                    : null;

    if (!indexPath) {
      console.error("[APP PROXY HTML] index.html not found — checked:", candidateA, candidateB);
      return res.status(503).send("App is starting up. Please try again in a moment.");
    }

    let html = fs.readFileSync(indexPath, "utf-8");

    // Rewrite relative asset paths to absolute Railway URLs so the browser
    // (on Shopify origin) can load them without going through the proxy.
    html = html.replace(/(src|href)="\/assets\//g, `$1="${RAILWAY_URL}/assets/`);
    html = html.replace(/(src|href)="\/favicon/g, `$1="${RAILWAY_URL}/favicon`);

    // Inject API_BASE override BEFORE the first <script> so it's available
    // when the React bundle initialises.
    const injection = `<script>window.__APPAI_API_BASE__="/apps/appai";</script>`;
    html = html.replace("<head>", `<head>\n  ${injection}`);

    console.log(`[APP PROXY HTML] Serving index.html with Railway asset URLs + API_BASE=/apps/appai`);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "ALLOWALL"); // Shopify sets framing; clear ours
    res.send(html);
  });

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
