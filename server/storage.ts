import { 
  customers, type Customer, type InsertCustomer,
  merchants, type Merchant, type InsertMerchant,
  designs, type Design, type InsertDesign,
  orders, type Order, type InsertOrder,
  generationLogs, type GenerationLog, type InsertGenerationLog,
  creditTransactions, type CreditTransaction, type InsertCreditTransaction,
  coupons, type Coupon, type InsertCoupon,
  couponRedemptions, type CouponRedemption, type InsertCouponRedemption,
  stylePresets, type StylePresetDB, type InsertStylePreset,
  shopifyInstallations, type ShopifyInstallation, type InsertShopifyInstallation,
  productTypes, type ProductType, type InsertProductType,
} from "@shared/schema";
import { db } from "./db";
import { eq, and, gte, lte, desc, sql, isNull } from "drizzle-orm";

export interface IStorage {
  // Customers
  getCustomer(id: string): Promise<Customer | undefined>;
  getCustomerByUserId(userId: string): Promise<Customer | undefined>;
  getOrCreateShopifyCustomer(shop: string, shopifyCustomerId: string, email?: string): Promise<Customer>;
  createCustomer(customer: InsertCustomer): Promise<Customer>;
  updateCustomer(id: string, updates: Partial<Customer>): Promise<Customer | undefined>;
  decrementCreditsIfAvailable(customerId: string): Promise<Customer | null>;
  
  // Merchants
  getMerchant(id: string): Promise<Merchant | undefined>;
  getMerchantByUserId(userId: string): Promise<Merchant | undefined>;
  createMerchant(merchant: InsertMerchant): Promise<Merchant>;
  updateMerchant(id: string, updates: Partial<Merchant>): Promise<Merchant | undefined>;
  
  // Designs
  getDesign(id: number): Promise<Design | undefined>;
  getDesignsByCustomer(customerId: string): Promise<Design[]>;
  getDesignsByCustomerPaginated(customerId: string, limit: number, offset: number): Promise<{ designs: (Design & { productTypeName: string | null })[]; total: number }>;
  getDesignCountByCustomer(customerId: string): Promise<number>;
  getDesignsNeedingThumbnails(limit?: number): Promise<Design[]>;
  getDesignsNeedingProductType(limit?: number): Promise<Design[]>;
  createDesign(design: InsertDesign): Promise<Design>;
  updateDesign(id: number, updates: Partial<Design>): Promise<Design | undefined>;
  deleteDesign(id: number): Promise<void>;
  
  // Orders
  getOrder(id: number): Promise<Order | undefined>;
  getOrdersByCustomer(customerId: string): Promise<Order[]>;
  getOrdersByMerchant(merchantId: string): Promise<Order[]>;
  createOrder(order: InsertOrder): Promise<Order>;
  updateOrder(id: number, updates: Partial<Order>): Promise<Order | undefined>;
  
  // Generation Logs
  createGenerationLog(log: InsertGenerationLog): Promise<GenerationLog>;
  getGenerationStats(merchantId: string, startDate: Date, endDate: Date): Promise<{
    total: number;
    successful: number;
    failed: number;
  }>;
  
  // Credit Transactions
  createCreditTransaction(transaction: InsertCreditTransaction): Promise<CreditTransaction>;
  getCreditTransactionsByCustomer(customerId: string): Promise<CreditTransaction[]>;
  
  // Coupons
  getCoupon(id: number): Promise<Coupon | undefined>;
  getCouponByCode(code: string): Promise<Coupon | undefined>;
  getCouponsByMerchant(merchantId: string): Promise<Coupon[]>;
  createCoupon(coupon: InsertCoupon): Promise<Coupon>;
  updateCoupon(id: number, updates: Partial<Coupon>): Promise<Coupon | undefined>;
  deleteCoupon(id: number): Promise<void>;
  
  // Coupon Redemptions
  getCouponRedemption(couponId: number, customerId: string): Promise<CouponRedemption | undefined>;
  createCouponRedemption(redemption: InsertCouponRedemption): Promise<CouponRedemption>;
  
  // Style Presets
  getStylePreset(id: number): Promise<StylePresetDB | undefined>;
  getStylePresetsByMerchant(merchantId: string): Promise<StylePresetDB[]>;
  getActiveStylePresetsByMerchant(merchantId: string): Promise<StylePresetDB[]>;
  getAllActiveStylePresets(): Promise<StylePresetDB[]>;
  createStylePreset(preset: InsertStylePreset): Promise<StylePresetDB>;
  updateStylePreset(id: number, updates: Partial<StylePresetDB>): Promise<StylePresetDB | undefined>;
  deleteStylePreset(id: number): Promise<void>;
  
  // Shopify Installations
  getShopifyInstallation(id: number): Promise<ShopifyInstallation | undefined>;
  getShopifyInstallationByShop(shopDomain: string): Promise<ShopifyInstallation | undefined>;
  getShopifyInstallationsByMerchant(merchantId: string): Promise<ShopifyInstallation[]>;
  createShopifyInstallation(installation: InsertShopifyInstallation): Promise<ShopifyInstallation>;
  updateShopifyInstallation(id: number, updates: Partial<ShopifyInstallation>): Promise<ShopifyInstallation | undefined>;
  
  // Product Types
  getProductType(id: number): Promise<ProductType | undefined>;
  getProductTypes(): Promise<ProductType[]>;
  getActiveProductTypes(): Promise<ProductType[]>;
  getProductTypesByMerchant(merchantId: string): Promise<ProductType[]>;
  createProductType(productType: InsertProductType): Promise<ProductType>;
  updateProductType(id: number, updates: Partial<ProductType>): Promise<ProductType | undefined>;
  deleteProductType(id: number): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  // Customers
  async getCustomer(id: string): Promise<Customer | undefined> {
    const [customer] = await db.select().from(customers).where(eq(customers.id, id));
    return customer;
  }

  async getCustomerByUserId(userId: string): Promise<Customer | undefined> {
    const [customer] = await db.select().from(customers).where(eq(customers.userId, userId));
    return customer;
  }

  async createCustomer(customer: InsertCustomer): Promise<Customer> {
    const [newCustomer] = await db.insert(customers).values(customer).returning();
    return newCustomer;
  }

  async updateCustomer(id: string, updates: Partial<Customer>): Promise<Customer | undefined> {
    const [updated] = await db
      .update(customers)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(customers.id, id))
      .returning();
    return updated;
  }

  async getOrCreateShopifyCustomer(shop: string, shopifyCustomerId: string, email?: string): Promise<Customer> {
    const userId = `shopify:${shop}:${shopifyCustomerId}`;
    
    let customer = await this.getCustomerByUserId(userId);
    
    if (!customer) {
      customer = await this.createCustomer({
        userId,
        credits: 5,
        freeGenerationsUsed: 0,
        totalGenerations: 0,
        totalSpent: "0.00",
      });
    }
    
    return customer;
  }

  async decrementCreditsIfAvailable(customerId: string): Promise<Customer | null> {
    const [updated] = await db
      .update(customers)
      .set({ 
        credits: sql`${customers.credits} - 1`,
        totalGenerations: sql`${customers.totalGenerations} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(customers.id, customerId), sql`${customers.credits} > 0`))
      .returning();
    return updated || null;
  }

  // Merchants
  async getMerchant(id: string): Promise<Merchant | undefined> {
    const [merchant] = await db.select().from(merchants).where(eq(merchants.id, id));
    return merchant;
  }

  async getMerchantByUserId(userId: string): Promise<Merchant | undefined> {
    const [merchant] = await db.select().from(merchants).where(eq(merchants.userId, userId));
    return merchant;
  }

  async createMerchant(merchant: InsertMerchant): Promise<Merchant> {
    const [newMerchant] = await db.insert(merchants).values(merchant).returning();
    return newMerchant;
  }

  async updateMerchant(id: string, updates: Partial<Merchant>): Promise<Merchant | undefined> {
    const [updated] = await db
      .update(merchants)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(merchants.id, id))
      .returning();
    return updated;
  }

  // Designs
  async getDesign(id: number): Promise<Design | undefined> {
    const [design] = await db.select().from(designs).where(eq(designs.id, id));
    return design;
  }

  async getDesignsByCustomer(customerId: string): Promise<Design[]> {
    return db.select().from(designs).where(eq(designs.customerId, customerId)).orderBy(desc(designs.createdAt));
  }

  async getDesignsByCustomerPaginated(customerId: string, limit: number, offset: number): Promise<{ designs: (Design & { productTypeName: string | null })[]; total: number }> {
    const [designsWithTypes, countResult] = await Promise.all([
      db.select({
        id: designs.id,
        customerId: designs.customerId,
        merchantId: designs.merchantId,
        productTypeId: designs.productTypeId,
        prompt: designs.prompt,
        stylePreset: designs.stylePreset,
        referenceImageUrl: designs.referenceImageUrl,
        generatedImageUrl: designs.generatedImageUrl,
        thumbnailImageUrl: designs.thumbnailImageUrl,
        size: designs.size,
        frameColor: designs.frameColor,
        aspectRatio: designs.aspectRatio,
        transformScale: designs.transformScale,
        transformX: designs.transformX,
        transformY: designs.transformY,
        status: designs.status,
        createdAt: designs.createdAt,
        updatedAt: designs.updatedAt,
        productTypeName: productTypes.name,
      }).from(designs)
        .leftJoin(productTypes, eq(designs.productTypeId, productTypes.id))
        .where(eq(designs.customerId, customerId))
        .orderBy(desc(designs.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(designs)
        .where(eq(designs.customerId, customerId))
    ]);
    return { designs: designsWithTypes, total: countResult[0]?.count || 0 };
  }

  async getDesignCountByCustomer(customerId: string): Promise<number> {
    const [result] = await db.select({ count: sql<number>`count(*)::int` }).from(designs)
      .where(eq(designs.customerId, customerId));
    return result?.count || 0;
  }

  async getDesignsNeedingThumbnails(limit: number = 50): Promise<Design[]> {
    // Get designs that have base64 images (no thumbnail) or stored images without thumbnails
    return db.select().from(designs)
      .where(sql`${designs.thumbnailImageUrl} IS NULL`)
      .orderBy(desc(designs.createdAt))
      .limit(limit);
  }

  async getDesignsNeedingProductType(limit: number = 50): Promise<Design[]> {
    return db.select().from(designs)
      .where(isNull(designs.productTypeId))
      .orderBy(desc(designs.createdAt))
      .limit(limit);
  }

  async createDesign(design: InsertDesign): Promise<Design> {
    const [newDesign] = await db.insert(designs).values(design).returning();
    return newDesign;
  }

  async updateDesign(id: number, updates: Partial<Design>): Promise<Design | undefined> {
    const [updated] = await db
      .update(designs)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(designs.id, id))
      .returning();
    return updated;
  }

  async deleteDesign(id: number): Promise<void> {
    await db.delete(designs).where(eq(designs.id, id));
  }

  // Orders
  async getOrder(id: number): Promise<Order | undefined> {
    const [order] = await db.select().from(orders).where(eq(orders.id, id));
    return order;
  }

  async getOrdersByCustomer(customerId: string): Promise<Order[]> {
    return db.select().from(orders).where(eq(orders.customerId, customerId)).orderBy(desc(orders.createdAt));
  }

  async getOrdersByMerchant(merchantId: string): Promise<Order[]> {
    return db.select().from(orders).where(eq(orders.merchantId, merchantId)).orderBy(desc(orders.createdAt));
  }

  async createOrder(order: InsertOrder): Promise<Order> {
    const [newOrder] = await db.insert(orders).values(order).returning();
    return newOrder;
  }

  async updateOrder(id: number, updates: Partial<Order>): Promise<Order | undefined> {
    const [updated] = await db
      .update(orders)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(orders.id, id))
      .returning();
    return updated;
  }

  // Generation Logs
  async createGenerationLog(log: InsertGenerationLog): Promise<GenerationLog> {
    const [newLog] = await db.insert(generationLogs).values(log).returning();
    return newLog;
  }

  async getGenerationStats(merchantId: string, startDate: Date, endDate: Date): Promise<{
    total: number;
    successful: number;
    failed: number;
  }> {
    const logs = await db
      .select()
      .from(generationLogs)
      .where(
        and(
          eq(generationLogs.merchantId, merchantId),
          gte(generationLogs.createdAt, startDate),
          lte(generationLogs.createdAt, endDate)
        )
      );

    return {
      total: logs.length,
      successful: logs.filter(l => l.success).length,
      failed: logs.filter(l => !l.success).length,
    };
  }

  // Credit Transactions
  async createCreditTransaction(transaction: InsertCreditTransaction): Promise<CreditTransaction> {
    const [newTransaction] = await db.insert(creditTransactions).values(transaction).returning();
    return newTransaction;
  }

  async getCreditTransactionsByCustomer(customerId: string): Promise<CreditTransaction[]> {
    return db.select().from(creditTransactions).where(eq(creditTransactions.customerId, customerId)).orderBy(desc(creditTransactions.createdAt));
  }

  // Coupons
  async getCoupon(id: number): Promise<Coupon | undefined> {
    const [coupon] = await db.select().from(coupons).where(eq(coupons.id, id));
    return coupon;
  }

  async getCouponByCode(code: string): Promise<Coupon | undefined> {
    const [coupon] = await db.select().from(coupons).where(eq(coupons.code, code.toUpperCase()));
    return coupon;
  }

  async getCouponsByMerchant(merchantId: string): Promise<Coupon[]> {
    return db.select().from(coupons).where(eq(coupons.merchantId, merchantId)).orderBy(desc(coupons.createdAt));
  }

  async createCoupon(coupon: InsertCoupon): Promise<Coupon> {
    const [newCoupon] = await db.insert(coupons).values({
      ...coupon,
      code: coupon.code.toUpperCase(),
    }).returning();
    return newCoupon;
  }

  async updateCoupon(id: number, updates: Partial<Coupon>): Promise<Coupon | undefined> {
    const updateData = updates.code ? { ...updates, code: updates.code.toUpperCase() } : updates;
    const [updated] = await db
      .update(coupons)
      .set(updateData)
      .where(eq(coupons.id, id))
      .returning();
    return updated;
  }

  async deleteCoupon(id: number): Promise<void> {
    await db.delete(coupons).where(eq(coupons.id, id));
  }

  // Coupon Redemptions
  async getCouponRedemption(couponId: number, customerId: string): Promise<CouponRedemption | undefined> {
    const [redemption] = await db.select().from(couponRedemptions).where(
      and(eq(couponRedemptions.couponId, couponId), eq(couponRedemptions.customerId, customerId))
    );
    return redemption;
  }

  async createCouponRedemption(redemption: InsertCouponRedemption): Promise<CouponRedemption> {
    const [newRedemption] = await db.insert(couponRedemptions).values(redemption).returning();
    return newRedemption;
  }

  // Style Presets
  async getStylePreset(id: number): Promise<StylePresetDB | undefined> {
    const [preset] = await db.select().from(stylePresets).where(eq(stylePresets.id, id));
    return preset;
  }

  async getStylePresetsByMerchant(merchantId: string): Promise<StylePresetDB[]> {
    return db.select().from(stylePresets).where(eq(stylePresets.merchantId, merchantId)).orderBy(stylePresets.sortOrder);
  }

  async getActiveStylePresetsByMerchant(merchantId: string): Promise<StylePresetDB[]> {
    return db.select().from(stylePresets).where(
      and(eq(stylePresets.merchantId, merchantId), eq(stylePresets.isActive, true))
    ).orderBy(stylePresets.sortOrder);
  }

  async getAllActiveStylePresets(): Promise<StylePresetDB[]> {
    return db.select().from(stylePresets).where(eq(stylePresets.isActive, true)).orderBy(stylePresets.sortOrder);
  }

  async createStylePreset(preset: InsertStylePreset): Promise<StylePresetDB> {
    const [newPreset] = await db.insert(stylePresets).values(preset).returning();
    return newPreset;
  }

  async updateStylePreset(id: number, updates: Partial<StylePresetDB>): Promise<StylePresetDB | undefined> {
    const [updated] = await db
      .update(stylePresets)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(stylePresets.id, id))
      .returning();
    return updated;
  }

  async deleteStylePreset(id: number): Promise<void> {
    await db.delete(stylePresets).where(eq(stylePresets.id, id));
  }

  // Shopify Installations
  async getShopifyInstallation(id: number): Promise<ShopifyInstallation | undefined> {
    const [installation] = await db.select().from(shopifyInstallations).where(eq(shopifyInstallations.id, id));
    return installation;
  }

  async getShopifyInstallationByShop(shopDomain: string): Promise<ShopifyInstallation | undefined> {
    const [installation] = await db.select().from(shopifyInstallations).where(eq(shopifyInstallations.shopDomain, shopDomain));
    return installation;
  }

  async getShopifyInstallationsByMerchant(merchantId: string): Promise<ShopifyInstallation[]> {
    return db.select().from(shopifyInstallations).where(eq(shopifyInstallations.merchantId, merchantId));
  }

  async createShopifyInstallation(installation: InsertShopifyInstallation): Promise<ShopifyInstallation> {
    const [newInstallation] = await db.insert(shopifyInstallations).values(installation).returning();
    return newInstallation;
  }

  async updateShopifyInstallation(id: number, updates: Partial<ShopifyInstallation>): Promise<ShopifyInstallation | undefined> {
    const [updated] = await db
      .update(shopifyInstallations)
      .set(updates)
      .where(eq(shopifyInstallations.id, id))
      .returning();
    return updated;
  }

  // Product Types
  async getProductType(id: number): Promise<ProductType | undefined> {
    const [productType] = await db.select().from(productTypes).where(eq(productTypes.id, id));
    return productType;
  }

  async getProductTypes(): Promise<ProductType[]> {
    return db.select().from(productTypes).orderBy(productTypes.sortOrder);
  }

  async getActiveProductTypes(): Promise<ProductType[]> {
    return db.select().from(productTypes).where(eq(productTypes.isActive, true)).orderBy(productTypes.sortOrder);
  }

  async getProductTypesByMerchant(merchantId: string): Promise<ProductType[]> {
    return db.select().from(productTypes).where(eq(productTypes.merchantId, merchantId)).orderBy(productTypes.sortOrder);
  }

  async createProductType(productType: InsertProductType): Promise<ProductType> {
    const [newProductType] = await db.insert(productTypes).values(productType).returning();
    return newProductType;
  }

  async updateProductType(id: number, updates: Partial<ProductType>): Promise<ProductType | undefined> {
    const [updated] = await db
      .update(productTypes)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(productTypes.id, id))
      .returning();
    return updated;
  }

  async deleteProductType(id: number): Promise<void> {
    await db.delete(productTypes).where(eq(productTypes.id, id));
  }
}

export const storage = new DatabaseStorage();
