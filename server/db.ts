import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;
console.log("DATABASE_URL =", process.env.DATABASE_URL);
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  connectionTimeoutMillis: 5000,  // fail fast if no free connection in 5s
  idleTimeoutMillis: 30000,       // release idle connections after 30s
  statement_timeout: 10000,       // kill any query running > 10s
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
