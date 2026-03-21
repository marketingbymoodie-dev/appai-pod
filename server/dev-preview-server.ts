/**
 * DEV-ONLY: Standalone storefront preview launcher on port 5001.
 *
 * Serves a minimal HTML launcher that:
 *   1. Does NOT load Shopify App Bridge (which causes admin.shopify.com redirects)
 *   2. Lists all product types from the DB
 *   3. Each card links DIRECTLY to the main app's /s/designer on port 5000
 *      (opens in a new tab — no iframe, so relative API calls work correctly)
 *
 * NEVER imported or used in production.
 */

import express from "express";
import pg from "pg";

const PREVIEW_PORT = 5001;
// Public tunnel URL for the main app (port 5000)
const MAIN_APP_URL = process.env.DEV_MAIN_APP_URL || "http://localhost:5000";
const DB_URL = process.env.DATABASE_URL!;

const app = express();

// Launcher page — lists all product types with direct links to the designer
app.get("/", async (_req, res) => {
  const client = new pg.Client({
    connectionString: DB_URL,
    connectionTimeoutMillis: 8000,
    statement_timeout: 8000,
    keepAlive: true,
  });

  let productTypes: { id: number; name: string; designerType: string | null }[] = [];

  try {
    await client.connect();
    const result = await client.query(
      "SELECT id, name, designer_type FROM product_types ORDER BY sort_order, id"
    );
    await client.end();
    productTypes = result.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      designerType: r.designer_type,
    }));
  } catch (err: any) {
    try { await client.end(); } catch (_) { /* ignore */ }
    console.error("[dev-preview] DB error:", err.message);
  }

  // Each card links directly to the main app's storefront designer in a new tab
  const cards = productTypes.map(pt => {
    const designerUrl = `${MAIN_APP_URL}/s/designer?productTypeId=${pt.id}&shop=appai-2.myshopify.com&dev=true`;
    return `
    <a class="card" href="${designerUrl}" target="_blank" rel="noopener noreferrer">
      <div class="badge">${pt.designerType ?? "generic"}</div>
      <div class="name">${pt.name}</div>
      <div class="id">ID: ${pt.id}</div>
      <div class="open-hint">Open designer →</div>
    </a>`;
  }).join("");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AppAI — Storefront Preview Launcher</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f0f0f; color: #f0f0f0; min-height: 100vh; }
    header { background: #1a1a2e; border-bottom: 1px solid #2a2a4a; padding: 20px 32px; }
    header h1 { font-size: 20px; font-weight: 700; color: #a78bfa; margin-bottom: 4px; }
    header p { font-size: 13px; color: #888; }
    .note { font-size: 12px; color: #4ade80; margin-top: 6px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; padding: 32px; }
    .card { display: block; background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 12px; padding: 20px; text-decoration: none; color: inherit; transition: border-color 0.2s, transform 0.1s; cursor: pointer; }
    .card:hover { border-color: #a78bfa; transform: translateY(-2px); }
    .badge { display: inline-block; background: #2a2a4a; color: #a78bfa; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }
    .name { font-size: 15px; font-weight: 600; color: #f0f0f0; margin-bottom: 4px; }
    .id { font-size: 12px; color: #555; margin-bottom: 10px; }
    .open-hint { font-size: 12px; color: #a78bfa; }
    .empty { padding: 32px; color: #666; }
  </style>
</head>
<body>
  <header>
    <h1>AppAI Storefront Preview</h1>
    <p>Click any product type to open the customer-facing designer in a new tab</p>
    <p class="note">Dev Preview Mode — No Shopify session required</p>
  </header>
  <div class="grid">
    ${cards || '<div class="empty">No product types found. Is the main server running on port 5000?</div>'}
  </div>
</body>
</html>`);
});

app.listen(PREVIEW_PORT, "0.0.0.0", () => {
  console.log(`[dev-preview] Storefront preview launcher running on port ${PREVIEW_PORT}`);
  console.log(`[dev-preview] Main app URL: ${MAIN_APP_URL}`);
});
