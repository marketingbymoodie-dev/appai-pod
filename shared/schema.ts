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
  prompt: text("prompt").notNull(),
  stylePreset: text("style_preset"),
  referenceImageUrl: text("reference_image_url"),
  generatedImageUrl: text("generated_image_url"),
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
export const PRINT_SIZES = [
  { id: "11x14", name: '11" x 14"', width: 11, height: 14, aspectRatio: "3:4", genWidth: 768, genHeight: 1024 },
  { id: "12x16", name: '12" x 16"', width: 12, height: 16, aspectRatio: "3:4", genWidth: 768, genHeight: 1024 },
  { id: "16x20", name: '16" x 20"', width: 16, height: 20, aspectRatio: "3:4", genWidth: 768, genHeight: 1024 },
  { id: "16x24", name: '16" x 24"', width: 16, height: 24, aspectRatio: "3:4", genWidth: 768, genHeight: 1024 },
  { id: "20x30", name: '20" x 30"', width: 20, height: 30, aspectRatio: "3:4", genWidth: 768, genHeight: 1024 },
  { id: "16x16", name: '16" x 16"', width: 16, height: 16, aspectRatio: "1:1", genWidth: 1024, genHeight: 1024 },
] as const;

export const FRAME_COLORS = [
  { id: "black", name: "Black", hex: "#1a1a1a" },
  { id: "white", name: "White", hex: "#f5f5f5" },
  { id: "walnut", name: "Walnut", hex: "#5c4033" },
] as const;

export const STYLE_PRESETS = [
  { id: "none", name: "No Style (Custom Prompt)", promptPrefix: "" },
  { id: "royal-pet", name: "Royal Pet Portrait", promptPrefix: "Transform this pet into a regal royal portrait from the 1800s, dressed in elegant period clothing with an ornate aristocratic backdrop. The portrait should look like a classic oil painting of nobility. Do not include any picture frame, border, or drop shadow in the image. The image will be printed and framed separately. Create" },
  { id: "watercolor", name: "Watercolor", promptPrefix: "A beautiful watercolor painting of" },
  { id: "oil-painting", name: "Oil Painting", promptPrefix: "A classic oil painting in the style of impressionism of" },
  { id: "pop-art", name: "Pop Art", promptPrefix: "A vibrant pop art illustration in the style of Andy Warhol of" },
  { id: "minimal-line", name: "Minimal Line Art", promptPrefix: "A minimalist single-line art drawing of" },
  { id: "abstract", name: "Abstract", promptPrefix: "An abstract modern art piece with bold colors representing" },
  { id: "vintage-poster", name: "Vintage Poster", promptPrefix: "A vintage travel poster style illustration of" },
  { id: "photorealistic", name: "Photorealistic", promptPrefix: "A photorealistic high-quality image of" },
] as const;

export type PrintSize = typeof PRINT_SIZES[number];
export type FrameColor = typeof FRAME_COLORS[number];
export type StylePreset = typeof STYLE_PRESETS[number];
