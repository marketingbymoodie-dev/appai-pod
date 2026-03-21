import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  const { rows } = await pool.query(
    `SELECT id, name, "doubleSidedPrint", "placeholderPositions", "aspectRatio", "printAreaWidth", "printAreaHeight", "designerType", "isAllOverPrint"
     FROM product_types WHERE name ILIKE '%pillow%' OR name ILIKE '%square%' LIMIT 5`
  );
  for (const row of rows) {
    console.log(`\nProduct Type ${row.id}: ${row.name}`);
    console.log(`  doubleSidedPrint: ${row.doubleSidedPrint}`);
    console.log(`  placeholderPositions: ${row.placeholderPositions}`);
    console.log(`  aspectRatio: ${row.aspectRatio}`);
    console.log(`  printAreaWidth: ${row.printAreaWidth}`);
    console.log(`  printAreaHeight: ${row.printAreaHeight}`);
    console.log(`  designerType: ${row.designerType}`);
    console.log(`  isAllOverPrint: ${row.isAllOverPrint}`);
  }
  await pool.end();
}

main().catch(console.error);
