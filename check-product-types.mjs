import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const result = await pool.query(
  `SELECT id, name, double_sided_print, placeholder_positions, designer_type, is_all_over_print
   FROM product_types
   ORDER BY id`
);

for (const row of result.rows) {
  console.log(`\n--- Product Type ${row.id}: ${row.name} ---`);
  console.log(`  designer_type: ${row.designer_type}`);
  console.log(`  double_sided_print: ${row.double_sided_print}`);
  console.log(`  is_all_over_print: ${row.is_all_over_print}`);
  console.log(`  placeholder_positions: ${row.placeholder_positions}`);
}

await pool.end();
