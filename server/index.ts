import "dotenv/config";

import express, { type Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";

// ============================================================
// STARTUP BANNER - Identify deployed version
// ============================================================
const BUILD_ID = "2025-02-13-storefront-e2e-v3";
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
// STEP 1: GLOBAL PROBE - MUST BE FIRST MIDDLEWARE
// ============================================================
app.use((req, res, next) => {
  console.log(`[GLOBAL PROBE] ${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ============================================================
// GLOBAL API CORS - Allow all origins for /api routes
// ============================================================
app.use("/api", (req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    console.log(`[GLOBAL API CORS] OPTIONS preflight for ${req.originalUrl} from ${origin}`);
    return res.sendStatus(204);
  }
  next();
});

// ============================================================
// STEP 2: STOREFRONT PROBE - Log all /api/storefront requests
// ============================================================
app.use("/api/storefront", (req, res, next) => {
  console.log(`[STOREFRONT PROBE] ${req.method} ${req.originalUrl}`);
  next();
});

// ============================================================
// STEP 4: EXPLICIT CORS FOR STOREFRONT - Before any other middleware
// ============================================================
app.use("/api/storefront", (req, res, next) => {
  const origin = req.headers.origin;
  console.log(`[STOREFRONT CORS] origin=${origin} method=${req.method} url=${req.originalUrl}`);

  // Always allow - either echo origin or use wildcard
  // This is safe because storefront endpoints are public by design
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    console.log(`[STOREFRONT CORS] Handling OPTIONS preflight for ${req.originalUrl}`);
    return res.sendStatus(204);
  }

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

  // Error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[SERVER ERROR]", err);

  if (res.headersSent) {
    return;
  }

  res.status(err.status || err.statusCode || 500).json({
    message: err.message || "Internal Server Error",
  });
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
