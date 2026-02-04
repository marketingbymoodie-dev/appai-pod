import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import path from "path";

export function serveStatic(app: Express) {
  // Vite build output should end up here (dist/public)
  const publicDir = path.resolve(process.cwd(), "dist/public");

  // Serve static assets
  app.use(
    express.static(publicDir, {
      index: false, // important: we'll handle index.html ourselves
    })
  );

  // ✅ SPA fallback: ONLY for GET, and NEVER for /api/*
  app.get("*", (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(publicDir, "index.html"));
  });
}
