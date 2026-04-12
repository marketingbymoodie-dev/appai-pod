import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, timestamp, boolean, decimal, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export * from "./models/auth";
export * from "./models/chat";
export * from "./colorUtils";

// Customer table extending auth users with credits
export const customers = pgTable("customers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().unique(),
  credits: integer("credits").notNull().default(5),
  freeGenerationsUsed: integer("free_generations_used").notNull().default(0),
  totalGenerations: integer("total_generations").notNull().default(0),
  totalSpent: decimal("total_spent", { precision: 10, scale: 2 }).notNull().default("0.00"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCustomerSchema = createInsertSchema(customers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;

// Merchant settings
export const merchants = pgTable("merchants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().unique(),
  storeName: text("store_name"),
  printifyApiToken: text("printify_api_token"),
  printifyShopId: text("printify_shop_id"),
  useBuiltInNanoBanana: boolean("use_built_in_nano_banana").notNull().default(true),
  customNanoBananaToken: text("custom_nano_banana_token"),
  subscriptionTier: text("subscription_tier").notNull().default("free"),
  monthlyGenerationLimit: integer("monthly_generation_limit").notNull().default(100),
  generationsThisMonth: integer("generations_this_month").notNull().default(0),
  brandingSettings: json("branding_settings"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Shopify app installations - separate from merchants for multi-shop support
export const shopifyInstallations = pgTable("shopify_installations", {
  id: serial("id").primaryKey(),
  merchantId: varchar("merchant_id"),
  shopDomain: text("shop_domain").notNull().unique(),
  accessToken: text("access_token").notNull(),
  scope: text("scope"),
  status: text("status").notNull().default("active"),
  installedAt: timestamp("installed_at").defaultNow().notNull(),
  uninstalledAt: timestamp("uninstalled_at"),
  // Per-shop customizer settings
  customizerHubUrl: text("customizer_hub_url"), // Fallback redirect URL for disabled customizer pages; defaults to "/"
  // Billing / plan state
  // planName: trial | starter | dabbler | pro | pro_plus  (null = no plan selected yet)
  // planStatus: trialing | active | expired | cancelled   (null = no plan)
  planName: text("plan_name"),
  planStatus: text("plan_status"),
  trialStartedAt: timestamp("trial_started_at"),
  billingSubscriptionId: text("billing_subscription_id"), // Shopify AppSubscription GID
  billingCurrentPeriodEnd: timestamp("billing_current_period_end"),
});

export const insertShopifyInstallationSchema = createInsertSchema(shopifyInstallations).omit({
  id: true,
});
export type ShopifyInstallation = typeof shopifyInstallations.$inferSelect;
export type InsertShopifyInstallation = z.infer<typeof insertShopifyInstallationSchema>;

export const insertMerchantSchema = createInsertSchema(merchants).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Merchant = typeof merchants.$inferSelect;
export type InsertMerchant = z.infer<typeof insertMerchantSchema>;

// Design source types
export const DESIGN_SOURCES = ["ai", "upload", "kittl"] as const;
export type DesignSource = typeof DESIGN_SOURCES[number];

// Designs created by customers
export const designs = pgTable("designs", {
  id: serial("id").primaryKey(),
  customerId: varchar("customer_id").notNull(),
  merchantId: varchar("merchant_id"),
  productTypeId: integer("product_type_id"),
  prompt: text("prompt").notNull(),
  stylePreset: text("style_preset"),
  referenceImageUrl: text("reference_image_url"),
  generatedImageUrl: text("generated_image_url"),
  thumbnailImageUrl: text("thumbnail_image_url"),
  size: text("size").notNull(),
  frameColor: text("frame_color").notNull().default("black"),
  aspectRatio: text("aspect_ratio").notNull().default("3:4"),
  transformScale: integer("transform_scale").notNull().default(100),
  transformX: integer("transform_x").notNull().default(50),
  transformY: integer("transform_y").notNull().default(50),
  colorTier: text("color_tier"),
  alternateImageUrl: text("alternate_image_url"),
  designSource: text("design_source").notNull().default("ai"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertDesignSchema = createInsertSchema(designs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Design = typeof designs.$inferSelect;
export type InsertDesign = z.infer<typeof insertDesignSchema>;

// Orders sent to Printify
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  designId: integer("design_id").notNull(),
  customerId: varchar("customer_id").notNull(),
  merchantId: varchar("merchant_id"),
  printifyOrderId: text("printify_order_id"),
  status: text("status").notNull().default("pending"),
  size: text("size").notNull(),
  frameColor: text("frame_color").notNull(),
  quantity: integer("quantity").notNull().default(1),
  priceInCents: integer("price_in_cents").notNull(),
  shippingInCents: integer("shipping_in_cents").notNull().default(0),
  creditRefundInCents: integer("credit_refund_in_cents").notNull().default(0),
  shippingAddress: text("shipping_address"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertOrderSchema = createInsertSchema(orders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Order = typeof orders.$inferSelect;
export type InsertOrder = z.infer<typeof insertOrderSchema>;

// Generation logs for admin stats
export const generationLogs = pgTable("generation_logs", {
  id: serial("id").primaryKey(),
  merchantId: varchar("merchant_id"),
  customerId: varchar("customer_id"),
  designId: integer("design_id"),
  promptLength: integer("prompt_length"),
  hadReferenceImage: boolean("had_reference_image").notNull().default(false),
  stylePreset: text("style_preset"),
  size: text("size"),
  success: boolean("success").notNull().default(true),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertGenerationLogSchema = createInsertSchema(generationLogs).omit({
  id: true,
  createdAt: true,
});
export type GenerationLog = typeof generationLogs.$inferSelect;
export type InsertGenerationLog = z.infer<typeof insertGenerationLogSchema>;

// Coupon codes for credits
export const coupons = pgTable("coupons", {
  id: serial("id").primaryKey(),
  merchantId: varchar("merchant_id").notNull(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  creditAmount: integer("credit_amount").notNull(),
  maxUses: integer("max_uses"),
  usedCount: integer("used_count").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCouponSchema = createInsertSchema(coupons).omit({
  id: true,
  usedCount: true,
  createdAt: true,
});
export type Coupon = typeof coupons.$inferSelect;
export type InsertCoupon = z.infer<typeof insertCouponSchema>;

// Coupon redemptions tracking
export const couponRedemptions = pgTable("coupon_redemptions", {
  id: serial("id").primaryKey(),
  couponId: integer("coupon_id").notNull(),
  customerId: varchar("customer_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCouponRedemptionSchema = createInsertSchema(couponRedemptions).omit({
  id: true,
  createdAt: true,
});
export type CouponRedemption = typeof couponRedemptions.$inferSelect;
export type InsertCouponRedemption = z.infer<typeof insertCouponRedemptionSchema>;

// Merchant style presets (customizable)
export const stylePresets = pgTable("style_presets", {
  id: serial("id").primaryKey(),
  merchantId: varchar("merchant_id").notNull(),
  name: text("name").notNull(),
  promptPrefix: text("prompt_prefix").notNull(),
  category: text("category").notNull().default("all"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  baseImageUrl: text("base_image_url"),
  promptPlaceholder: text("prompt_placeholder"),
  descriptionOptional: boolean("description_optional").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertStylePresetSchema = createInsertSchema(stylePresets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type StylePresetDB = typeof stylePresets.$inferSelect;
export type InsertStylePreset = z.infer<typeof insertStylePresetSchema>;

// Product types for different customizable products (Framed Prints, Pillows, Mugs, etc.)
export const productTypes = pgTable("product_types", {
  id: serial("id").primaryKey(),
  merchantId: varchar("merchant_id"),
  name: text("name").notNull(),
  description: text("description"),
  printifyBlueprintId: integer("printify_blueprint_id"),
  printifyProviderId: integer("printify_provider_id"),
  mockupTemplateUrl: text("mockup_template_url"),
  sizes: text("sizes").notNull().default("[]"),
  frameColors: text("frame_colors").notNull().default("[]"),
  variantMap: text("variant_map").notNull().default("{}"),
  selectedSizeIds: text("selected_size_ids").notNull().default("[]"),
  selectedColorIds: text("selected_color_ids").notNull().default("[]"),
  aspectRatio: text("aspect_ratio").notNull().default("3:4"),
  printShape: text("print_shape").notNull().default("rectangle"),
  printAreaWidth: integer("print_area_width"),
  printAreaHeight: integer("print_area_height"),
  bleedMarginPercent: integer("bleed_margin_percent").notNull().default(5),
  designerType: text("designer_type").notNull().default("generic"),
  sizeType: text("size_type").notNull().default("dimensional"),
  hasPrintifyMockups: boolean("has_printify_mockups").notNull().default(false),
  baseMockupImages: text("base_mockup_images").notNull().default("{}"),
  primaryMockupIndex: integer("primary_mockup_index").notNull().default(0),
  doubleSidedPrint: boolean("double_sided_print").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  shopifyProductId: text("shopify_product_id"),
  shopifyProductHandle: text("shopify_product_handle"),
  shopifyProductUrl: text("shopify_product_url"),
  shopifyShopDomain: text("shopify_shop_domain"), // Which shop this product was published to
  shopifyVariantIds: json("shopify_variant_ids"), // Maps size:color to Shopify variant ID
  lastPushedToShopify: timestamp("last_pushed_to_shopify"),
  printifyCosts: text("printify_costs").default("{}"),
  isAllOverPrint: boolean("is_all_over_print").notNull().default(false),
  placeholderPositions: text("placeholder_positions").default("[]"),
  /**
   * Flat-lay SVG/PNG URLs for each panel position — used as panel backgrounds in the
   * Place on Item viewer. Stored as JSON object: { "front_right": "https://...", ... }
   * Populated at product import time from the Printify blueprint variants `views` field.
   */
  panelFlatLayImages: text("panel_flat_lay_images").default("{}"),
  colorOptionName: text("color_option_name"), // Actual option name from Printify blueprint (e.g. "Material", "Fabric", "Color")
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertProductTypeSchema = createInsertSchema(productTypes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type ProductType = typeof productTypes.$inferSelect;
export type InsertProductType = z.infer<typeof insertProductTypeSchema>;

// Shared designs for public sharing via URLs
export const sharedDesigns = pgTable("shared_designs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  designId: integer("design_id"), // Nullable for unsaved designs
  shopDomain: text("shop_domain"),
  productId: text("product_id"),
  productHandle: text("product_handle"),
  shareToken: text("share_token").notNull(),
  imageUrl: text("image_url").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  prompt: text("prompt").notNull(),
  stylePreset: text("style_preset"),
  size: text("size").notNull(),
  frameColor: text("frame_color").notNull(),
  transformScale: integer("transform_scale").notNull().default(100),
  transformX: integer("transform_x").notNull().default(50),
  transformY: integer("transform_y").notNull().default(50),
  productTypeId: integer("product_type_id"),
  expiresAt: timestamp("expires_at"),
  viewCount: integer("view_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSharedDesignSchema = createInsertSchema(sharedDesigns).omit({
  id: true,
  createdAt: true,
});
export type SharedDesign = typeof sharedDesigns.$inferSelect;
export type InsertSharedDesign = z.infer<typeof insertSharedDesignSchema>;

// Shadow SKU mappings — hidden Shopify products created per design for checkout thumbnail determinism
export const designSkuMappings = pgTable("design_sku_mappings", {
  id: serial("id").primaryKey(),
  shopDomain: text("shop_domain").notNull(),
  sourceVariantId: text("source_variant_id").notNull(),
  designId: text("design_id").notNull(),
  mockupUrl: text("mockup_url").notNull(),
  shadowShopifyProductId: text("shadow_shopify_product_id").notNull(),
  shadowShopifyVariantId: text("shadow_shopify_variant_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const insertDesignSkuMappingSchema = createInsertSchema(designSkuMappings).omit({
  id: true,
  createdAt: true,
});
export type DesignSkuMapping = typeof designSkuMappings.$inferSelect;
export type InsertDesignSkuMapping = z.infer<typeof insertDesignSkuMappingSchema>;

// Customizer Pages — merchant-created pages that auto-mount the customizer via the App Embed.
// Each page is a real Shopify Page with a predetermined base product/variant.
// The App Embed script detects the URL handle and mounts the customizer UI automatically.
export const customizerPages = pgTable("customizer_pages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  shop: text("shop").notNull(),
  shopifyPageId: text("shopify_page_id"),          // Shopify Admin page ID for updates/deletes
  handle: text("handle").notNull(),                // e.g. "customize-tumbler" → /pages/customize-tumbler
  title: text("title").notNull(),
  baseProductId: text("base_product_id"),
  baseVariantId: text("base_variant_id").notNull(),
  baseProductTitle: text("base_product_title"),    // cached display title
  baseVariantTitle: text("base_variant_title"),    // cached variant title (size/color)
  baseProductPrice: text("base_product_price"),    // cached price string
  baseProductHandle: text("base_product_handle"),  // Shopify product handle for embed iframe
  productTypeId: integer("product_type_id"),       // links to our product type for generation
  status: text("status").notNull().default("active"),  // active | disabled
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCustomizerPageSchema = createInsertSchema(customizerPages).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type CustomizerPage = typeof customizerPages.$inferSelect;
export type InsertCustomizerPage = z.infer<typeof insertCustomizerPageSchema>;

// Generation jobs — async job records for storefront artwork generation.
// POST /api/storefront/generate creates a job and returns immediately.
// GET /api/storefront/generate/status polls for completion.
export const generationJobs = pgTable("generation_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  shop: text("shop").notNull(),
  sessionId: text("session_id"),
  customerId: text("customer_id"),
  status: text("status").notNull().default("pending"), // pending | running | complete | failed
  prompt: text("prompt").notNull(),
  userPrompt: text("user_prompt"),               // User's original short prompt (without style prefix/suffix)
  stylePreset: text("style_preset"),
  size: text("size"),
  frameColor: text("frame_color"),
  productTypeId: text("product_type_id"),
  referenceImageUrl: text("reference_image_url"),
  designImageUrl: text("design_image_url"),
  thumbnailUrl: text("thumbnail_url"),
  mockupUrls: json("mockup_urls"),              // Saved Printify mockup URLs (array of strings)
  designState: json("design_state"),             // Full design state snapshot (transform, size, color, preset)
  designId: text("design_id"),
  errorMessage: text("error_message"),
  // Pre-created shadow product for instant Add to Cart
  shadowProductId: text("shadow_product_id"),   // Shopify product GID (pre-created after generation)
  shadowVariantId: text("shadow_variant_id"),   // Shopify variant GID (used directly for cart add)
  shadowExpiresAt: timestamp("shadow_expires_at"), // 1h after creation; extended to 48h on cart add
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type GenerationJob = typeof generationJobs.$inferSelect;
export type InsertGenerationJob = typeof generationJobs.$inferInsert;

// Customizer designs — standalone design records created from the /pages/appai-customize page.
// These are NOT tied to the existing `designs` table (which requires a logged-in customer).
// Status lifecycle: GENERATING → READY | FAILED
export const customizerDesigns = pgTable("customizer_designs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  shop: text("shop").notNull(),
  shopifyCustomerId: text("shopify_customer_id"), // optional — set if customer is logged in
  customerKey: text("customer_key"),              // appai_uid (localStorage) or "shopify:<customerId>"
  baseProductId: text("base_product_id"),         // product type ID (our DB) or Shopify product ID
  baseVariantId: text("base_variant_id").notNull(), // Shopify variant ID for add-to-cart
  baseTitle: text("base_title"),
  prompt: text("prompt").notNull(),
  options: json("options"),                        // { stylePreset, sizeId, colorId, productTypeId }
  artworkUrl: text("artwork_url"),                 // AI-generated print file URL
  mockupUrl: text("mockup_url"),                   // Primary mockup image URL (shown in cart/checkout)
  mockupUrls: json("mockup_urls"),                 // All mockup URLs (array of strings)
  status: text("status").notNull().default("GENERATING"), // GENERATING | READY | FAILED
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCustomizerDesignSchema = createInsertSchema(customizerDesigns).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type CustomizerDesign = typeof customizerDesigns.$inferSelect;
export type InsertCustomizerDesign = z.infer<typeof insertCustomizerDesignSchema>;

// Published Products — maps a customizer design to its dedicated Shopify product.
// One product per design ensures mockup images are native Shopify product images,
// giving correct cart/checkout thumbnails without any hacks.
// The Shopify product is created with status="active", not in any collection, so
// it is purchasable via direct variant ID but hidden from storefront navigation.
export const publishedProducts = pgTable("published_products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  shop: text("shop").notNull(),
  designId: text("design_id").notNull(),           // references customizerDesigns.id
  customerKey: text("customer_key"),               // same key as customizerDesigns.customerKey
  shopifyProductId: text("shopify_product_id").notNull(),
  shopifyVariantId: text("shopify_variant_id").notNull(), // the purchasable variant for /cart/add.js
  shopifyProductHandle: text("shopify_product_handle"),
  baseVariantId: text("base_variant_id").notNull(), // the original base variant
  status: text("status").notNull().default("active"), // active | archived
  expiresAt: timestamp("expires_at"),                 // null = no expiry; set to 6h after creation, extended to 7d if added to cart
  cartAddedAt: timestamp("cart_added_at"),             // set when customer adds to cart (used to extend expiry to 7d)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPublishedProductSchema = createInsertSchema(publishedProducts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type PublishedProduct = typeof publishedProducts.$inferSelect;
export type InsertPublishedProduct = z.infer<typeof insertPublishedProductSchema>;

// Credit transactions
export const creditTransactions = pgTable("credit_transactions", {
  id: serial("id").primaryKey(),
  customerId: varchar("customer_id").notNull(),
  type: text("type").notNull(),
  amount: integer("amount").notNull(),
  priceInCents: integer("price_in_cents"),
  orderId: integer("order_id"),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCreditTransactionSchema = createInsertSchema(creditTransactions).omit({
  id: true,
  createdAt: true,
});
export type CreditTransaction = typeof creditTransactions.$inferSelect;
export type InsertCreditTransaction = z.infer<typeof insertCreditTransactionSchema>;

// Product size configurations for Blueprint 540
// Each size generates at its true aspect ratio for proper framing
export const PRINT_SIZES = [
  { id: "11x14", name: '11" x 14"', width: 11, height: 14, aspectRatio: "11:14", genWidth: 880, genHeight: 1120 },
  { id: "12x16", name: '12" x 16"', width: 12, height: 16, aspectRatio: "3:4", genWidth: 768, genHeight: 1024 },
  { id: "16x20", name: '16" x 20"', width: 16, height: 20, aspectRatio: "4:5", genWidth: 896, genHeight: 1120 },
  { id: "20x30", name: '20" x 30"', width: 20, height: 30, aspectRatio: "2:3", genWidth: 768, genHeight: 1152 },
  { id: "16x16", name: '16" x 16"', width: 16, height: 16, aspectRatio: "1:1", genWidth: 1024, genHeight: 1024 },
] as const;

export const FRAME_COLORS = [
  { id: "black", name: "Black", hex: "#1a1a1a" },
  { id: "white", name: "White", hex: "#f5f5f5" },
] as const;

// IMPORTANT: Style presets are categorized by product type
// Decor styles create full-bleed, edge-to-edge artwork for prints and wall art
// Apparel styles create centered graphics/motifs suitable for t-shirts, etc.
export const STYLE_PRESETS = [
  // Universal - works for all product types
  { id: "none", name: "No Style (Custom Prompt)", promptPrefix: "", category: "all" },
  
  // Decor Artwork - Full-bleed styles for prints, posters, wall art
  { id: "royal-pet", name: "Royal Pet Portrait", promptPrefix: "Transform this pet into a regal royal portrait from the 1800s, dressed in elegant period clothing with an ornate aristocratic backdrop filling the entire canvas. The portrait should look like a classic oil painting of nobility with the background extending to all edges. Create full-bleed artwork of", category: "decor" },
  { id: "watercolor", name: "Watercolor", promptPrefix: "A beautiful full-bleed watercolor painting that fills the entire canvas edge-to-edge, with the colors and brushwork extending to all edges of", category: "decor" },
  { id: "oil-painting", name: "Oil Painting", promptPrefix: "A classic full-bleed oil painting in the style of impressionism that fills the entire canvas with rich brushstrokes extending to all edges of", category: "decor" },
  { id: "pop-art", name: "Pop Art", promptPrefix: "A vibrant full-bleed pop art illustration in the style of Andy Warhol that fills the entire canvas with bold colors reaching all edges of", category: "decor" },
  { id: "minimal-line", name: "Minimal Line Art", promptPrefix: "A minimalist full-bleed single-line art drawing with a complete background that extends to all edges of the canvas of", category: "decor" },
  { id: "abstract", name: "Abstract", promptPrefix: "A full-bleed abstract modern art piece with bold colors filling the entire canvas edge-to-edge representing", category: "decor" },
  { id: "vintage-poster", name: "Vintage Poster", promptPrefix: "A full-bleed vintage travel poster style illustration that fills the entire canvas with the design extending to all edges of", category: "decor" },
  { id: "photorealistic", name: "Photorealistic", promptPrefix: "A photorealistic full-bleed high-quality image that fills the entire canvas with the scene extending to all edges of", category: "decor" },
  
  // Apparel Artwork - Centered vector graphics for t-shirts, hoodies, etc.
  // All apparel styles use #FF00FF hot pink chroma key background for precise removal
  // baseImageUrl: optional style reference image sent to AI alongside customer's own reference
  {
    id: "free-4-all",
    name: "Free 4 All",
    promptPrefix: "",
    category: "apparel",
    promptPlaceholder: "Your prompt will have no base style applied. Describe your design freely...",
  },
  {
    id: "pattern-maker",
    name: "Pattern Maker",
    promptPrefix: "Seamless repeating pattern design, tileable motif, clean vector shapes, flat colors (avoid white, light colors, and hot pink/magenta in the design), high contrast, isolated on a solid hot pink (#FF00FF) background. Create a repeating pattern of",
    category: "apparel",
    promptPlaceholder: "Describe your pattern idea (e.g. tiny tacos and hot sauce bottles)",
  },
  {
    id: "opinionated",
    name: "Opinionated",
    promptPrefix: "T-shirt graphic, bold stacked text typography, strong opinion statement, up to 6 words maximum, flat vibrant colors (avoid white, light colors, and hot pink/magenta in the design), high contrast, centered, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, clean typographic layout. Create a bold text stack design of",
    category: "apparel",
    promptPlaceholder: "State your opinion in up to 6 words, e.g. Dogs Are Better Than People, Pizza Fixes Everything, Mondays Should Be Illegal, Naps Over Small Talk, Cats Run This House",
    options: {
      label: "Choose Layout",
      required: true,
      choices: [
        { id: "retro", name: "Retro", promptFragment: "vintage worn letterpress typography, aged poster feel, distressed texture", baseImageUrl: "" },
        { id: "bold", name: "Bold", promptFragment: "heavy block type, maximum impact, ultra-thick sans-serif, stacked layout", baseImageUrl: "" },
        { id: "street", name: "Street", promptFragment: "graffiti spray paint urban style, drip effects, raw street art typography", baseImageUrl: "" },
        { id: "minimal", name: "Minimal", promptFragment: "clean modern sans-serif, simple layout, balanced whitespace, understated elegance", baseImageUrl: "" },
        { id: "handwritten", name: "Handwritten", promptFragment: "casual hand-lettered script, organic brush strokes, personal handwriting feel", baseImageUrl: "" },
      ],
    },
  },
  {
    id: "quotes",
    name: "Quotes",
    promptPrefix: "T-shirt graphic, stylish quote typography, expressive lettering, flat vibrant colors (avoid white, light colors, and hot pink/magenta in the design), high contrast, centered, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, creative typographic layout. Create a quote design of",
    category: "apparel",
    promptPlaceholder: "Enter your topic (e.g. life, cats, Monday mornings, coffee addiction)",
    options: {
      label: "Quote Style",
      required: true,
      choices: [
        { id: "profound", name: "Profound", promptFragment: "a profound, thoughtful, deep quote on", baseImageUrl: "" },
        { id: "quirky", name: "Quirky", promptFragment: "a quirky, offbeat, unexpected quote on", baseImageUrl: "" },
        { id: "weird", name: "Weird", promptFragment: "a weird, absurd, surreal quote on", baseImageUrl: "" },
        { id: "funny", name: "Funny", promptFragment: "a funny, humorous, comedic quote on", baseImageUrl: "" },
      ],
    },
  },
  {
    id: "pet-portraits",
    name: "Pet Portraits",
    promptPrefix: "T-shirt graphic, illustrated pet portrait, detailed character illustration, flat vibrant colors (avoid white, light colors, and hot pink/magenta in the design), high contrast, centered, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, clean illustrated style. Create a pet portrait of",
    category: "apparel",
    promptPlaceholder: "What's the pet's name?",
    options: {
      label: "Portrait Style",
      required: true,
      choices: [
        { id: "king", name: "King", promptFragment: "dressed as a majestic king with crown and royal robes", baseImageUrl: "" },
        { id: "queen", name: "Queen", promptFragment: "dressed as an elegant queen with tiara and royal gown", baseImageUrl: "" },
        { id: "red-carpet", name: "Red Carpet", promptFragment: "dressed in glamorous red carpet fashion, celebrity style", baseImageUrl: "" },
        { id: "ramen-bowl", name: "Ramen Bowl", promptFragment: "sitting in a ramen bowl, surrounded by noodles and chopsticks", baseImageUrl: "" },
        { id: "mugshot", name: "Mugshot", promptFragment: "in a funny police mugshot lineup, holding a name placard", baseImageUrl: "" },
      ],
    },
  },

  // Decor Pet Portraits - Full-bleed scenic versions (no chroma key needed)
  {
    id: "pet-portraits-decor",
    name: "Pet Portraits",
    promptPrefix: "A beautifully detailed full-bleed pet portrait illustration that fills the entire canvas edge-to-edge, rich artistic style with a complete scenic background, of",
    category: "decor",
    promptPlaceholder: "What's the pet's name?",
    options: {
      label: "Portrait Style",
      required: true,
      choices: [
        { id: "king", name: "King", promptFragment: "dressed as a majestic king with crown and royal robes, seated on an ornate throne in a grand palace hall", baseImageUrl: "" },
        { id: "queen", name: "Queen", promptFragment: "dressed as an elegant queen with tiara and royal gown, in a luxurious palace garden setting", baseImageUrl: "" },
        { id: "red-carpet", name: "Red Carpet", promptFragment: "dressed in glamorous red carpet fashion with paparazzi camera flashes and velvet rope backdrop", baseImageUrl: "" },
        { id: "ramen-bowl", name: "Ramen Bowl", promptFragment: "sitting in a giant ramen bowl surrounded by noodles, chopsticks, and steam in a cozy Japanese ramen shop", baseImageUrl: "" },
        { id: "mugshot", name: "Mugshot", promptFragment: "in a funny police mugshot lineup holding a name placard, against a height chart wall background", baseImageUrl: "" },
      ],
    },
  },
] as const;

// Apparel prompt variants for dark garments (light/vibrant designs)
// Uses same #FF00FF chroma key background — removed after generation regardless of garment color
export const APPAREL_DARK_TIER_PROMPTS: Record<string, string> = {
  "free-4-all": "",
  "pattern-maker": "Seamless repeating pattern design, tileable motif, clean vector shapes, bright vibrant colors including white and light tones (avoid dark, black, and hot pink/magenta colors in the design), high contrast, isolated on a solid hot pink (#FF00FF) background. Create a repeating pattern of",
  "opinionated": "T-shirt graphic, bold stacked text typography, strong opinion statement, up to 6 words maximum, bright vibrant colors including white and light tones (avoid dark, black, and hot pink/magenta colors in the design), high contrast, centered, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, clean typographic layout. Create a bold text stack design of",
  "quotes": "T-shirt graphic, stylish quote typography, expressive lettering, bright vibrant colors including white and light tones (avoid dark, black, and hot pink/magenta colors in the design), high contrast, centered, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, creative typographic layout. Create a quote design of",
  "pet-portraits": "T-shirt graphic, illustrated pet portrait, detailed character illustration, bright vibrant colors including white and light tones (avoid dark, black, and hot pink/magenta colors in the design), high contrast, centered, isolated on a solid hot pink (#FF00FF) background, no shadow, no texture, clean illustrated style. Create a pet portrait of",
  "none": "",
};

export type PrintSize = typeof PRINT_SIZES[number];
export type FrameColor = typeof FRAME_COLORS[number];
export type StylePreset = typeof STYLE_PRESETS[number];

export type PrintShape = "rectangle" | "square" | "circle";
export type DesignerType = "framed-print" | "pillow" | "mug" | "apparel" | "generic";

export interface DesignerConfig {
  id: number;
  name: string;
  description: string | null;
  printifyBlueprintId: number | null;
  aspectRatio: string;
  printShape: PrintShape;
  printAreaWidth: number | null;
  printAreaHeight: number | null;
  bleedMarginPercent: number;
  designerType: DesignerType;
  hasPrintifyMockups: boolean;
  sizes: Array<{
    id: string;
    name: string;
    width: number;
    height: number;
    aspectRatio?: string;
  }>;
  frameColors: Array<{
    id: string;
    name: string;
    hex: string;
  }>;
  canvasConfig: {
    maxDimension: number;
    width: number;
    height: number;
    safeZoneMargin: number;
  };
}
