import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const PRINTIFY_API_BASE = "https://api.printify.com/v1";

type JsonValue = unknown;

function argValue(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0) return process.argv[idx + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

async function printifyGet(pathname: string, token?: string): Promise<JsonValue | null> {
  if (!token) return null;
  const res = await fetch(`${PRINTIFY_API_BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    return { error: `Printify ${res.status}`, body: await res.text().catch(() => "") };
  }
  return res.json();
}

function firstVariantId(variantsData: any): number | null {
  const variants = variantsData?.variants || variantsData || [];
  const first = Array.isArray(variants) ? variants[0] : null;
  return first?.id ?? first?.variant_id ?? null;
}

async function findRawPrintifyProduct(token: string | undefined, shopId: string | null, blueprintId: number, providerId: number, productName: string) {
  if (!token || !shopId) return null;
  const productsData = await printifyGet(`/shops/${shopId}/products.json`, token);
  const products = Array.isArray((productsData as any)?.data)
    ? (productsData as any).data
    : Array.isArray(productsData)
      ? productsData
      : [];
  const needle = productName.toLowerCase();
  const match = products.find((product: any) =>
    Number(product.blueprint_id) === blueprintId &&
    Number(product.print_provider_id) === providerId &&
    String(product.title || "").toLowerCase().includes(needle.split(/\s+/)[0] || "hoodie")
  ) || products.find((product: any) =>
    Number(product.blueprint_id) === blueprintId && Number(product.print_provider_id) === providerId
  );
  if (!match?.id) return null;
  return printifyGet(`/shops/${shopId}/products/${match.id}.json`, token);
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to export stored Printify mapping data.");
  }

  const productTypeId = argValue("productTypeId");
  const blueprintArg = argValue("blueprintId");
  const nameArg = argValue("name") || "zip hoodie";
  const outArg = argValue("out");
  const shouldPrettyPrint = process.argv.includes("--pretty");

  const isRailwayPublicProxy = connectionString.includes("rlwy.net");
  const pool = new pg.Pool({
    connectionString,
    ssl: isRailwayPublicProxy ? { rejectUnauthorized: false } : false,
  });

  try {
    const productQuery = productTypeId
      ? {
          text: `SELECT pt.*, m.printify_api_token, m.printify_shop_id
                 FROM product_types pt
                 LEFT JOIN merchants m ON m.id = pt.merchant_id
                 WHERE pt.id = $1
                 LIMIT 1`,
          values: [Number(productTypeId)],
        }
      : blueprintArg
        ? {
            text: `SELECT pt.*, m.printify_api_token, m.printify_shop_id
                   FROM product_types pt
                   LEFT JOIN merchants m ON m.id = pt.merchant_id
                   WHERE pt.printify_blueprint_id = $1
                   ORDER BY pt.is_all_over_print DESC, pt.updated_at DESC
                   LIMIT 1`,
            values: [Number(blueprintArg)],
          }
        : {
            text: `SELECT pt.*, m.printify_api_token, m.printify_shop_id
                   FROM product_types pt
                   LEFT JOIN merchants m ON m.id = pt.merchant_id
                   WHERE (pt.name ILIKE $1 OR pt.name ILIKE $2 OR pt.printify_blueprint_id = 451)
                   ORDER BY (pt.printify_blueprint_id = 451) DESC, pt.is_all_over_print DESC, pt.updated_at DESC
                   LIMIT 1`,
            values: [`%${nameArg}%`, "%zip%hoodie%"],
          };

    const productResult = await pool.query(productQuery);
    const product = productResult.rows[0];
    if (!product) {
      throw new Error("No matching product_type found. Try --productTypeId <id> or --blueprintId <id>.");
    }

    const blueprintId = Number(product.printify_blueprint_id);
    const printProviderId = Number(product.printify_provider_id);
    const token = product.printify_api_token as string | undefined;
    const printifyShopId = product.printify_shop_id as string | null;

    const [blueprint, provider, variantsData] = await Promise.all([
      printifyGet(`/catalog/blueprints/${blueprintId}.json`, token),
      printifyGet(`/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}.json`, token),
      printifyGet(`/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`, token),
    ]);
    const variantId = firstVariantId(variantsData);
    const placeholderEndpoint = variantId
      ? await printifyGet(`/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants/${variantId}/placeholders.json`, token)
      : null;
    const rawPrintifyProduct = await findRawPrintifyProduct(token, printifyShopId, blueprintId, printProviderId, product.name);

    const placeholderPositions = parseJson<Array<{ position: string; width: number; height: number }>>(product.placeholder_positions, []);
    const panelFlatLayImages = parseJson<Record<string, string>>(product.panel_flat_lay_images, {});
    const baseMockupImages = parseJson<Record<string, unknown>>(product.base_mockup_images, {});
    const variants = (variantsData as any)?.variants || variantsData || [];
    const views = (variantsData as any)?.views || [];
    const placeholderEndpointList = (placeholderEndpoint as any)?.placeholders || placeholderEndpoint || [];
    const rawPrintAreas = (rawPrintifyProduct as any)?.print_areas || [];
    const rawImages = (rawPrintifyProduct as any)?.images || [];

    const recentPlacements = await pool.query(
      `SELECT id, shop, customer_id, product_type_id, design_image_url, mockup_urls, design_state, created_at, updated_at
       FROM generation_jobs
       WHERE product_type_id = $1 OR product_type_id = $2
       ORDER BY updated_at DESC
       LIMIT 20`,
      [String(product.id), product.id],
    );

    const storedPlaceholderRows = placeholderPositions.map((pos) => ({
      source: "product_types.placeholder_positions",
      ...pos,
      flatLayImage: panelFlatLayImages[pos.position] || null,
    }));
    const viewPlaceholderRows = (Array.isArray(views) ? views : []).map((view: any) => ({
      source: "variants.views",
      id: view.id,
      label: view.label,
      position: view.position,
      files: view.files || [],
      variantIds: (view.files || []).flatMap((file: any) => file.variant_ids || []),
    }));
    const variantPlaceholderRows = (Array.isArray(variants) ? variants : []).flatMap((variant: any) =>
      (variant.placeholders || []).map((placeholder: any) => ({
        source: "variants[].placeholders",
        variantId: variant.id ?? variant.variant_id,
        variantTitle: variant.title,
        ...placeholder,
      })),
    );
    const endpointPlaceholderRows = (Array.isArray(placeholderEndpointList) ? placeholderEndpointList : []).map((placeholder: any) => ({
      source: "variant.placeholders endpoint",
      ...placeholder,
    }));

    const printAreas = rawPrintAreas.length > 0
      ? rawPrintAreas
      : [{
          source: "derived_from_stored_placeholder_positions",
          variant_ids: Array.isArray(variants) ? variants.map((variant: any) => variant.id ?? variant.variant_id).filter(Boolean) : [],
          placeholders: placeholderPositions.map((pos) => ({ position: pos.position, width: pos.width, height: pos.height })),
        }];

    const output = {
      productId: String(product.id),
      productType: {
        id: product.id,
        name: product.name,
        merchantId: product.merchant_id,
        isAllOverPrint: product.is_all_over_print,
        aopTemplateId: product.aop_template_id,
        designerType: product.designer_type,
        storedFields: {
          sizes: parseJson(product.sizes, []),
          frameColors: parseJson(product.frame_colors, []),
          variantMap: parseJson(product.variant_map, {}),
          selectedSizeIds: parseJson(product.selected_size_ids, []),
          selectedColorIds: parseJson(product.selected_color_ids, []),
          baseMockupImages,
          panelFlatLayImages,
          placeholderPositions,
          colorOptionName: product.color_option_name,
        },
      },
      blueprintId: String(blueprintId),
      printProviderId: String(printProviderId),
      printifyShopId,
      variants: Array.isArray(variants) ? variants : [],
      printAreas,
      placeholders: uniqueBy(
        [...storedPlaceholderRows, ...viewPlaceholderRows, ...variantPlaceholderRows, ...endpointPlaceholderRows],
        (item: any) => `${item.source}:${item.variantId || ""}:${item.position || item.id || JSON.stringify(item).slice(0, 80)}`,
      ),
      images: {
        baseMockupImages,
        panelFlatLayImages,
        blueprintImages: (blueprint as any)?.images || [],
        variantViews: views,
        rawProductImages: rawImages,
      },
      placements: recentPlacements.rows.map((row) => ({
        id: row.id,
        shop: row.shop,
        customerId: row.customer_id,
        productTypeId: row.product_type_id,
        designImageUrl: row.design_image_url,
        mockupUrls: row.mockup_urls,
        designState: row.design_state,
        extractedAop: {
          aopPlacementSettings: row.design_state?.aopPlacementSettings || null,
          aopPrintPanelUrls: row.design_state?.aopPrintPanelUrls || null,
          aopPatternUrl: row.design_state?.aopPatternUrl || null,
        },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      rawPrintifyProduct: rawPrintifyProduct || {},
      rawPrintifyCatalog: {
        blueprint,
        provider,
        variants: variantsData,
        placeholderEndpoint,
      },
      codePaths: {
        storageModel: "shared/schema.ts productTypes: printifyBlueprintId, printifyProviderId, placeholderPositions, panelFlatLayImages, baseMockupImages, variantMap",
        importRoute: "server/routes.ts POST /api/admin/printify/import",
        panelSendPath: "client/src/pages/embed-design.tsx fetchPrintifyMockups -> server/routes.ts /api/storefront/mockup -> server/printify-mockups.ts createTemporaryProduct",
        printifyPayload: "server/printify-mockups.ts createTemporaryProduct builds print_areas: [{ variant_ids: [variantId], placeholders: [{ position, images: [{ id, x, y, scale, angle }] }] }]",
      },
    };

    const json = JSON.stringify(output, null, shouldPrettyPrint ? 2 : 2);
    const outPath = outArg || path.join(process.cwd(), "tmp", `printify-mapping-product-${product.id}.json`);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, json, "utf8");
    console.log(json);
    console.error(`\n[export-printify-mapping] Wrote ${outPath}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[export-printify-mapping] Failed:", error);
  process.exit(1);
});
