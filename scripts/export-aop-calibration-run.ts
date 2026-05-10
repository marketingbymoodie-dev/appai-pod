import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

function argValue(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0) return process.argv[idx + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function makePool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const isRailwayPublicProxy = connectionString.includes("rlwy.net");
  return new pg.Pool({
    connectionString,
    ssl: isRailwayPublicProxy ? { rejectUnauthorized: false } : false,
  });
}

async function main() {
  const runId = argValue("runId");
  if (!runId) throw new Error("--runId RUN_ID is required.");

  const pool = makePool();
  try {
    const runResult = await pool.query(`SELECT * FROM aop_calibration_runs WHERE id = $1 LIMIT 1`, [runId]);
    const run = runResult.rows[0];
    if (!run) throw new Error(`No aop_calibration_runs row found for ${runId}.`);

    const productTypeResult = await pool.query(`SELECT * FROM product_types WHERE id = $1 LIMIT 1`, [run.product_type_id]);
    const panelsResult = await pool.query(
      `SELECT * FROM aop_calibration_panels WHERE run_id = $1 ORDER BY panel_key ASC, created_at ASC`,
      [runId],
    );

    const output = {
      run,
      productType: productTypeResult.rows[0] || null,
      panels: panelsResult.rows,
      printAreasPayload: run.print_areas_payload,
      printifyMockupUrls: run.printify_mockup_urls,
    };

    const json = JSON.stringify(output, null, hasFlag("pretty") ? 2 : 0);
    const outPath = argValue("out") || path.join(process.cwd(), "tmp", "aop-calibration", `run-${runId}.json`);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, json, "utf8");
    console.log(json);
    console.error(`\n[export-aop-calibration-run] Wrote ${outPath}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[export-aop-calibration-run] Failed:", error);
  process.exit(1);
});
