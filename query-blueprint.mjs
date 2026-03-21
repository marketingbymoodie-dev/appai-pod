// Query Printify API for blueprint 220 print area details
const PRINTIFY_API = "https://api.printify.com/v1";

// Get the API token from the database
import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  // Get the merchant's Printify API token
  const { rows } = await pool.query(
    `SELECT "printifyApiToken", "printifyShopId" FROM merchants LIMIT 1`
  );
  const token = rows[0].printifyApiToken;
  const shopId = rows[0].printifyShopId;
  console.log("Shop ID:", shopId);

  // 1. Get blueprint 220 details
  const bpRes = await fetch(`${PRINTIFY_API}/catalog/blueprints/220.json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const bp = await bpRes.json();
  console.log("\n=== BLUEPRINT 220 ===");
  console.log("Title:", bp.title);
  console.log("Description:", bp.description?.substring(0, 200));

  // 2. Get print provider 10 details for this blueprint
  const ppRes = await fetch(
    `${PRINTIFY_API}/catalog/blueprints/220/print_providers/10.json`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const pp = await ppRes.json();
  console.log("\n=== PRINT PROVIDER 10 ===");
  console.log(JSON.stringify(pp, null, 2));

  // 3. Get the printing schema / placeholders
  const schemaRes = await fetch(
    `${PRINTIFY_API}/catalog/blueprints/220/print_providers/10/printing.json`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const schema = await schemaRes.json();
  console.log("\n=== PRINTING SCHEMA ===");
  console.log(JSON.stringify(schema, null, 2));

  // 4. Also check the product we just created to see its print_areas
  // Get the most recent product
  const prodRes = await fetch(
    `${PRINTIFY_API}/shops/${shopId}/products.json?limit=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const prods = await prodRes.json();
  if (prods.data && prods.data.length > 0) {
    const prod = prods.data[0];
    console.log("\n=== LATEST PRODUCT PRINT AREAS ===");
    console.log("Title:", prod.title);
    console.log("Print areas:", JSON.stringify(prod.print_areas, null, 2));
  }

  await pool.end();
}

main().catch(console.error);
