import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Railway's public proxy (switchyard.proxy.rlwy.net) requires SSL.
// The internal hostname (postgres.railway.internal) does not.
// We detect which one we're using and set SSL accordingly.
const isRailwayPublicProxy = (process.env.DATABASE_URL || "").includes("rlwy.net");

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  connectionTimeoutMillis: 10000, // fail fast if no free connection in 10s
  idleTimeoutMillis: 20000,       // release idle connections after 20s (before Railway's TCP timeout)
  statement_timeout: 15000,       // kill any query running > 15s
  // Keep connections alive across Railway's TCP idle timeout (typically 60s)
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  // Railway's public proxy requires SSL; internal hostname does not
  ssl: isRailwayPublicProxy ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => {
  console.error("[DB Pool] Unexpected client error:", err.message);
});

// Periodic pool health log — helps diagnose exhaustion
setInterval(() => {
  console.log(
    `[DB Pool] total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`,
  );
}, 30000);

export const db = drizzle(pool, { schema });
