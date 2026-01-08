import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, timestamp, boolean, decimal } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export * from "./models/auth";
export * from "./models/chat";

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
  aspectRatio: text("aspect_ratio").notNull().default("3:4"),
  printShape: text("print_shape").notNull().default("rectangle"),
  printAreaWidth: integer("print_area_width"),
  printAreaHeight: integer("print_area_height"),
  bleedMarginPercent: integer("bleed_margin_percent").notNull().default(5),
  designerType: text("designer_type").notNull().default("generic"),
  sizeType: text("size_type").notNull().default("dimensional"),
  hasPrintifyMockups: boolean("has_printify_mockups").notNull().default(false),
  baseMockupImages: text("base_mockup_images").notNull().default("{}"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
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
  
  // Apparel Artwork - Centered graphics/motifs for t-shirts, hoodies, etc.
  // IMPORTANT: Background must be PURE WHITE (#FFFFFF). Any white elements in the design must be slightly off-white (#FEFEFE or darker)
  { id: "centered-graphic", name: "Centered Graphic", promptPrefix: "Create an ISOLATED graphic design on a PURE WHITE (#FFFFFF) background. CRITICAL: The background must be exactly pure white RGB(255,255,255). Any white elements in the design itself must use slightly off-white (#FEFEFE or darker). The design must be a single centered element with NO scenic background, NO landscapes, NO environments. Just the main subject isolated and centered, suitable for t-shirt printing. Create a clean isolated design of", category: "apparel" },
  { id: "vintage-logo", name: "Vintage Logo", promptPrefix: "Create an ISOLATED vintage-style logo or emblem on a PURE WHITE (#FFFFFF) background. CRITICAL: The background must be exactly pure white RGB(255,255,255). Any white elements in the design itself must use slightly off-white (#FEFEFE or darker). The design must be a single centered badge/emblem with NO scenic background behind it. Just the logo itself, distressed and retro-looking, suitable for t-shirt printing. Create an isolated vintage badge of", category: "apparel" },
  { id: "minimalist-icon", name: "Minimalist Icon", promptPrefix: "Create an ISOLATED minimalist icon on a PURE WHITE (#FFFFFF) background. CRITICAL: The background must be exactly pure white RGB(255,255,255). Any white elements in the design itself must use slightly off-white (#FEFEFE or darker). The design must be a simple, clean symbol with NO scenic background, NO environments. Just the icon itself centered with clean lines, suitable for t-shirt printing. Create a simple isolated icon of", category: "apparel" },
  { id: "typography", name: "Typographic Design", promptPrefix: "Create ISOLATED typography on a PURE WHITE (#FFFFFF) background. CRITICAL: The background must be exactly pure white RGB(255,255,255). Any white elements in the lettering must use slightly off-white (#FEFEFE or darker). The design must be stylized text/lettering only with NO scenic background, NO landscapes behind it. Just the text itself, bold and eye-catching, suitable for t-shirt printing. Create isolated typography of", category: "apparel" },
  { id: "illustration-motif", name: "Illustrated Motif", promptPrefix: "Create an ISOLATED hand-drawn illustration on a PURE WHITE (#FFFFFF) background. CRITICAL: The background must be exactly pure white RGB(255,255,255). Any white elements in the design itself must use slightly off-white (#FEFEFE or darker). The design must be a single centered character or motif with NO scenic background, NO landscapes, NO environments behind it. Just the illustration itself with clean edges, suitable for t-shirt printing. Create an isolated illustrated motif of", category: "apparel" },
  { id: "retro-badge", name: "Retro Badge", promptPrefix: "Create an ISOLATED retro-style badge on a PURE WHITE (#FFFFFF) background. CRITICAL: The background must be exactly pure white RGB(255,255,255). Any white elements in the design itself must use slightly off-white (#FEFEFE or darker). The design must be a single circular or shield-shaped emblem with NO scenic background behind it. Just the badge itself with vintage textures, suitable for t-shirt chest placement. Create an isolated retro badge of", category: "apparel" },
] as const;

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
