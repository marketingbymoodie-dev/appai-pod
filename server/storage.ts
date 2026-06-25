import { 
  customers, type Customer, type InsertCustomer,
  customerAliases, type CustomerAlias, type InsertCustomerAlias,
  creditBalances, type CreditBalance,
  creditLedger, type CreditLedger, type InsertCreditLedger,
  stripeEvents,
  orderDiscountClaims, type OrderDiscountClaim, type InsertOrderDiscountClaim,
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
  sharedDesigns, type SharedDesign, type InsertSharedDesign,
  designSkuMappings, type DesignSkuMapping, type InsertDesignSkuMapping,
  customizerDesigns, type CustomizerDesign, type InsertCustomizerDesign,
  customizerPages, type CustomizerPage, type InsertCustomizerPage,
  publishedProducts, type PublishedProduct, type InsertPublishedProduct,
  generationJobs, type GenerationJob, type InsertGenerationJob,
} from "@shared/schema";
import { db } from "./db";
import { eq, and, gte, lte, desc, sql, isNull } from "drizzle-orm";
import { computeGenerationConsume } from "./customizer-plans";

export interface IStorage {
  // Customers
  getCustomer(id: string): Promise<Customer | undefined>;
  getCustomerByUserId(userId: string): Promise<Customer | undefined>;
  getOrCreateShopifyCustomer(shop: string, shopifyCustomerId: string, email?: string): Promise<Customer>;
  createCustomer(customer: InsertCustomer): Promise<Customer>;
  updateCustomer(id: string, updates: Partial<Customer>): Promise<Customer | undefined>;
  decrementCreditsIfAvailable(customerId: string): Promise<Customer | null>;
  ensureCustomerBalance(customerId: string): Promise<CreditBalance>;
  getCreditBalance(customerId: string): Promise<CreditBalance | undefined>;
  getCustomerAliases(customerId: string): Promise<CustomerAlias[]>;
  resolveOrCreateCustomerAlias(alias: InsertCustomerAlias & { legacyUserId?: string }): Promise<Customer>;
  findCustomerByAlias(aliasType: string, aliasValue: string, shop?: string | null): Promise<Customer | undefined>;
  addCustomerAlias(customerId: string, alias: Omit<InsertCustomerAlias, "customerId">): Promise<CustomerAlias | undefined>;
  applyCreditLedgerEntry(entry: InsertCreditLedger): Promise<{ inserted: boolean; balance: CreditBalance | undefined }>;
  consumePaidCredit(customerId: string, idempotencyKey: string, externalRef?: string): Promise<{ consumed: boolean; balance: CreditBalance | undefined }>;
  consumeFreeGeneration(customerId: string, idempotencyKey: string, externalRef?: string): Promise<{ consumed: boolean; balance: CreditBalance | undefined }>;
  recordStripeEvent(stripeEventId: string, type: string): Promise<boolean>;
  markStripeEventOutcome(stripeEventId: string, outcome: string): Promise<void>;
  // Order discount claim audit row written when an orders/paid webhook reports
  // an AppAI credit discount was applied. Idempotent on shopify_order_id.
  recordOrderDiscountClaim(claim: InsertOrderDiscountClaim): Promise<{ inserted: boolean; claim: OrderDiscountClaim | undefined }>;
  
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
  getAllShopifyInstallations(): Promise<ShopifyInstallation[]>;
  createShopifyInstallation(installation: InsertShopifyInstallation): Promise<ShopifyInstallation>;
  updateShopifyInstallation(id: number, updates: Partial<ShopifyInstallation>): Promise<ShopifyInstallation | undefined>;
  // Per-merchant generation metering (plan quota enforcement). bucketKey is
  // either a "YYYY-MM" calendar-month key (paid plans) or "trial" (cumulative).
  getMerchantGenerationUsage(installationId: number, bucketKey: string): Promise<{ used: number; overageUsed: number }>;
  consumeMerchantGeneration(params: { installationId: number; bucketKey: string; freeQuota: number; overageCap: number }): Promise<{ allowed: boolean; used: number; overageUsed: number; isOverage: boolean }>;
  
  // Product Types
  getProductType(id: number): Promise<ProductType | undefined>;
  getProductTypes(): Promise<ProductType[]>;
  getActiveProductTypes(): Promise<ProductType[]>;
  getProductTypesByMerchant(merchantId: string): Promise<ProductType[]>;
  createProductType(productType: InsertProductType): Promise<ProductType>;
  updateProductType(id: number, updates: Partial<ProductType>): Promise<ProductType | undefined>;
  deleteProductType(id: number): Promise<void>;
  
  // Shared Designs
  getSharedDesign(id: string): Promise<SharedDesign | undefined>;
  getSharedDesignByToken(shareToken: string): Promise<SharedDesign | undefined>;
  createSharedDesign(sharedDesign: InsertSharedDesign): Promise<SharedDesign>;
  incrementSharedDesignViewCount(id: string): Promise<void>;

  // Design SKU Mappings (shadow SKUs for checkout thumbnails)
  getDesignSkuMapping(shopDomain: string, sourceVariantId: string, designId: string): Promise<DesignSkuMapping | undefined>;
  createDesignSkuMapping(mapping: InsertDesignSkuMapping): Promise<DesignSkuMapping>;
  getExpiredDesignSkuMappings(before: Date): Promise<DesignSkuMapping[]>;
  deleteDesignSkuMapping(id: number): Promise<void>;

  // Customizer Designs (standalone design records from the /pages/appai-customize page)
  createCustomizerDesign(design: InsertCustomizerDesign): Promise<CustomizerDesign>;
  getCustomizerDesign(id: string): Promise<CustomizerDesign | undefined>;
  updateCustomizerDesign(id: string, updates: Partial<CustomizerDesign>): Promise<CustomizerDesign | undefined>;

  // Customizer Pages
  listCustomizerPages(shop: string): Promise<CustomizerPage[]>;
  getCustomizerPage(id: string): Promise<CustomizerPage | undefined>;
  getCustomizerPageForShop(id: string, shop: string): Promise<CustomizerPage | undefined>;
  getCustomizerPageByHandle(shop: string, handle: string): Promise<CustomizerPage | undefined>;
  createCustomizerPage(page: InsertCustomizerPage): Promise<CustomizerPage>;
  updateCustomizerPage(id: string, updates: Partial<CustomizerPage>): Promise<CustomizerPage | undefined>;
  deleteCustomizerPage(id: string): Promise<void>;
  countCustomizerPages(shop: string): Promise<number>;
  countActiveCustomizerPages(shop: string): Promise<number>;

  // Published Products (design → native Shopify product)
  getPublishedProduct(shop: string, designId: string): Promise<PublishedProduct | undefined>;
  createPublishedProduct(product: InsertPublishedProduct): Promise<PublishedProduct>;
  updatePublishedProduct(id: string, updates: Partial<PublishedProduct>): Promise<PublishedProduct | undefined>;
  countCustomerPublishedDesigns(shop: string, customerKey: string): Promise<number>;
  getOldestCustomerPublishedDesign(shop: string, customerKey: string): Promise<PublishedProduct | undefined>;

  // Generation Jobs (async storefront artwork generation)
  createGenerationJob(job: InsertGenerationJob): Promise<GenerationJob>;
  getGenerationJob(id: string): Promise<GenerationJob | undefined>;
  updateGenerationJob(id: string, updates: Partial<GenerationJob>): Promise<void>;
  countSessionGenerations(shop: string, sessionId: string): Promise<number>;
  mergeSessionToCustomer(shop: string, sessionId: string, customerId: string): Promise<number>;
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
    await this.ensureCustomerBalance(customer.id);
    await this.addCustomerAlias(customer.id, {
      aliasType: "shopify",
      aliasValue: shopifyCustomerId,
      shop,
    });
    
    return customer;
  }

  async decrementCreditsIfAvailable(customerId: string): Promise<Customer | null> {
    const result = await this.consumePaidCredit(
      customerId,
      `legacy-decrement:${customerId}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      "legacy-decrementCreditsIfAvailable",
    );
    if (!result.consumed) return null;
    return this.getCustomer(customerId).then((customer) => customer || null);
  }

  async ensureCustomerBalance(customerId: string): Promise<CreditBalance> {
    const [existing] = await db.select().from(creditBalances).where(eq(creditBalances.customerId, customerId));
    if (existing) return existing;

    const customer = await this.getCustomer(customerId);
    const [created] = await db
      .insert(creditBalances)
      .values({
        customerId,
        credits: customer?.credits ?? 0,
        freeGenerationsUsed: customer?.freeGenerationsUsed ?? 0,
        discountEntitlementCents: 0,
        version: 0,
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    const [afterConflict] = await db.select().from(creditBalances).where(eq(creditBalances.customerId, customerId));
    if (!afterConflict) throw new Error(`Could not create credit balance for ${customerId}`);
    return afterConflict;
  }

  async getCreditBalance(customerId: string): Promise<CreditBalance | undefined> {
    const [row] = await db.select().from(creditBalances).where(eq(creditBalances.customerId, customerId));
    return row;
  }

  async getCustomerAliases(customerId: string): Promise<CustomerAlias[]> {
    return db.select().from(customerAliases).where(eq(customerAliases.customerId, customerId));
  }

  async findCustomerByAlias(aliasType: string, aliasValue: string, shop?: string | null): Promise<Customer | undefined> {
    const [existingAlias] = await db
      .select()
      .from(customerAliases)
      .where(and(
        eq(customerAliases.aliasType, aliasType),
        eq(customerAliases.aliasValue, aliasValue),
        shop === null || shop === undefined
          ? isNull(customerAliases.shop)
          : eq(customerAliases.shop, shop),
      ));
    if (!existingAlias) return undefined;
    return this.getCustomer(existingAlias.customerId);
  }

  async resolveOrCreateCustomerAlias(alias: InsertCustomerAlias & { legacyUserId?: string }): Promise<Customer> {
    const [existingAlias] = await db
      .select()
      .from(customerAliases)
      .where(and(
        eq(customerAliases.aliasType, alias.aliasType),
        eq(customerAliases.aliasValue, alias.aliasValue),
        alias.shop === null || alias.shop === undefined
          ? isNull(customerAliases.shop)
          : eq(customerAliases.shop, alias.shop),
      ));
    if (existingAlias) {
      const customer = await this.getCustomer(existingAlias.customerId);
      if (customer) {
        await this.ensureCustomerBalance(customer.id);
        return customer;
      }
    }

    let customer = alias.legacyUserId ? await this.getCustomerByUserId(alias.legacyUserId) : undefined;
    if (!customer) {
      const userId = alias.legacyUserId || `${alias.aliasType}:${alias.shop || "global"}:${alias.aliasValue}`;
      customer = await this.createCustomer({
        userId,
        credits: 0,
        freeGenerationsUsed: 0,
        totalGenerations: 0,
        totalSpent: "0.00",
      });
    }

    await this.ensureCustomerBalance(customer.id);
    await this.addCustomerAlias(customer.id, {
      aliasType: alias.aliasType,
      aliasValue: alias.aliasValue,
      shop: alias.shop ?? null,
    });
    return customer;
  }

  async addCustomerAlias(customerId: string, alias: Omit<InsertCustomerAlias, "customerId">): Promise<CustomerAlias | undefined> {
    const [row] = await db
      .insert(customerAliases)
      .values({
        customerId,
        aliasType: alias.aliasType,
        aliasValue: alias.aliasValue,
        shop: alias.shop ?? null,
      })
      .onConflictDoNothing()
      .returning();
    return row;
  }

  async applyCreditLedgerEntry(entry: InsertCreditLedger): Promise<{ inserted: boolean; balance: CreditBalance | undefined }> {
    return db.transaction(async (tx) => {
      await tx
        .insert(creditBalances)
        .values({
          customerId: entry.customerId,
          credits: 0,
          freeGenerationsUsed: 0,
          discountEntitlementCents: 0,
          version: 0,
          updatedAt: new Date(),
        })
        .onConflictDoNothing();

      const [ledgerRow] = await tx
        .insert(creditLedger)
        .values(entry)
        .onConflictDoNothing()
        .returning();

      if (!ledgerRow) {
        const [balance] = await tx.select().from(creditBalances).where(eq(creditBalances.customerId, entry.customerId));
        return { inserted: false, balance };
      }

      const [balance] = await tx
        .update(creditBalances)
        .set({
          credits: sql`GREATEST(0, ${creditBalances.credits} + ${entry.deltaCredits})`,
          discountEntitlementCents: sql`LEAST(100, GREATEST(0, ${creditBalances.discountEntitlementCents} + ${entry.deltaEntitlementCents}))`,
          version: sql`${creditBalances.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(creditBalances.customerId, entry.customerId))
        .returning();

      // Dual-write legacy columns while migrating existing readers.
      await tx
        .update(customers)
        .set({
          credits: balance?.credits ?? 0,
          totalGenerations: sql`${customers.totalGenerations} + ${entry.deltaCredits < 0 ? 1 : 0}`,
          updatedAt: new Date(),
        })
        .where(eq(customers.id, entry.customerId));

      return { inserted: true, balance };
    });
  }

  async consumePaidCredit(customerId: string, idempotencyKey: string, externalRef?: string): Promise<{ consumed: boolean; balance: CreditBalance | undefined }> {
    return db.transaction(async (tx) => {
      await tx
        .insert(creditBalances)
        .values({ customerId, credits: 0, freeGenerationsUsed: 0, discountEntitlementCents: 0, version: 0, updatedAt: new Date() })
        .onConflictDoNothing();

      const [existingLedger] = await tx.select().from(creditLedger).where(eq(creditLedger.idempotencyKey, idempotencyKey));
      if (existingLedger) {
        const [balance] = await tx.select().from(creditBalances).where(eq(creditBalances.customerId, customerId));
        return { consumed: true, balance };
      }

      const [balance] = await tx
        .update(creditBalances)
        .set({
          credits: sql`${creditBalances.credits} - 1`,
          version: sql`${creditBalances.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(creditBalances.customerId, customerId), sql`${creditBalances.credits} > 0`))
        .returning();

      if (!balance) return { consumed: false, balance: undefined };

      await tx.insert(creditLedger).values({
        customerId,
        deltaCredits: -1,
        deltaEntitlementCents: 0,
        reason: "generation",
        idempotencyKey,
        externalRef,
        metadata: null,
      });

      await tx
        .update(customers)
        .set({ credits: balance.credits, totalGenerations: sql`${customers.totalGenerations} + 1`, updatedAt: new Date() })
        .where(eq(customers.id, customerId));

      return { consumed: true, balance };
    });
  }

  async consumeFreeGeneration(customerId: string, idempotencyKey: string, externalRef?: string): Promise<{ consumed: boolean; balance: CreditBalance | undefined }> {
    const FREE_GENERATION_LIMIT = 10;
    return db.transaction(async (tx) => {
      await tx
        .insert(creditBalances)
        .values({ customerId, credits: 0, freeGenerationsUsed: 0, discountEntitlementCents: 0, version: 0, updatedAt: new Date() })
        .onConflictDoNothing();

      const [existingLedger] = await tx.select().from(creditLedger).where(eq(creditLedger.idempotencyKey, idempotencyKey));
      if (existingLedger) {
        const [balance] = await tx.select().from(creditBalances).where(eq(creditBalances.customerId, customerId));
        return { consumed: true, balance };
      }

      const [balance] = await tx
        .update(creditBalances)
        .set({
          freeGenerationsUsed: sql`${creditBalances.freeGenerationsUsed} + 1`,
          version: sql`${creditBalances.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(creditBalances.customerId, customerId), sql`${creditBalances.freeGenerationsUsed} < ${FREE_GENERATION_LIMIT}`))
        .returning();

      if (!balance) return { consumed: false, balance: undefined };

      await tx.insert(creditLedger).values({
        customerId,
        deltaCredits: 0,
        deltaEntitlementCents: 0,
        reason: "free_generation",
        idempotencyKey,
        externalRef,
        metadata: null,
      });

      await tx
        .update(customers)
        .set({ freeGenerationsUsed: balance.freeGenerationsUsed, totalGenerations: sql`${customers.totalGenerations} + 1`, updatedAt: new Date() })
        .where(eq(customers.id, customerId));

      return { consumed: true, balance };
    });
  }

  async recordStripeEvent(stripeEventId: string, type: string): Promise<boolean> {
    const [row] = await db
      .insert(stripeEvents)
      .values({ stripeEventId, type, outcome: "received" })
      .onConflictDoNothing()
      .returning();
    return !!row;
  }

  async markStripeEventOutcome(stripeEventId: string, outcome: string): Promise<void> {
    await db.update(stripeEvents).set({ outcome }).where(eq(stripeEvents.stripeEventId, stripeEventId));
  }

  async recordOrderDiscountClaim(
    claim: InsertOrderDiscountClaim,
  ): Promise<{ inserted: boolean; claim: OrderDiscountClaim | undefined }> {
    const [row] = await db
      .insert(orderDiscountClaims)
      .values(claim)
      .onConflictDoNothing()
      .returning();
    if (row) return { inserted: true, claim: row };

    if (claim.shopifyOrderId) {
      const [existing] = await db
        .select()
        .from(orderDiscountClaims)
        .where(eq(orderDiscountClaims.shopifyOrderId, claim.shopifyOrderId));
      return { inserted: false, claim: existing };
    }
    return { inserted: false, claim: undefined };
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

  // Shopify helpers
  async getMerchantByShop(shop: string): Promise<Merchant | undefined> {
    const userId = `shopify:merchant:${shop}`;
    return this.getMerchantByUserId(userId);
  }

  async getOrCreateShopifyMerchant(shop: string): Promise<Merchant> {
    const userId = `shopify:merchant:${shop}`;

    let merchant = await this.getMerchantByUserId(userId);

    if (!merchant) {
      merchant = await this.createMerchant({ userId } as InsertMerchant);
    }

    return merchant;
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
        colorTier: designs.colorTier,
        alternateImageUrl: designs.alternateImageUrl,
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
    const designsWithTypesWithSource = designsWithTypes.map((d) => ({
  ...d,
  designSource: (d as any).designSource ?? "app",
}));
return { designs: designsWithTypesWithSource, total: countResult[0]?.count || 0 };

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

  async getAllShopifyInstallations(): Promise<ShopifyInstallation[]> {
    return db.select().from(shopifyInstallations);
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

  async getMerchantGenerationUsage(installationId: number, bucketKey: string): Promise<{ used: number; overageUsed: number }> {
    const [inst] = await db
      .select({
        generationMonth: shopifyInstallations.generationMonth,
        monthlyGenerationsUsed: shopifyInstallations.monthlyGenerationsUsed,
        monthlyOverageUsed: shopifyInstallations.monthlyOverageUsed,
      })
      .from(shopifyInstallations)
      .where(eq(shopifyInstallations.id, installationId));
    // A different bucket key means the counters belong to a past month/state,
    // so effective usage in the requested bucket is zero.
    if (!inst || inst.generationMonth !== bucketKey) return { used: 0, overageUsed: 0 };
    return { used: inst.monthlyGenerationsUsed ?? 0, overageUsed: inst.monthlyOverageUsed ?? 0 };
  }

  /**
   * Atomically consume one generation against the merchant's plan quota.
   *
   * Runs in a transaction with a row-level lock (SELECT … FOR UPDATE) so
   * concurrent generations for the same shop can't exceed the cap. Handles
   * bucket rollover: when the stored generation_month differs from bucketKey the
   * counters effectively reset to 0 (past month / trial→paid transition). The
   * cap/overage decision uses the shared computeGenerationConsume() helper.
   * Returns allowed=false (no mutation) when the bucket is at the hard cap.
   */
  async consumeMerchantGeneration(params: { installationId: number; bucketKey: string; freeQuota: number; overageCap: number }): Promise<{ allowed: boolean; used: number; overageUsed: number; isOverage: boolean }> {
    const { installationId, bucketKey, freeQuota, overageCap } = params;

    return db.transaction(async (tx) => {
      const [inst] = await tx
        .select({
          generationMonth: shopifyInstallations.generationMonth,
          monthlyGenerationsUsed: shopifyInstallations.monthlyGenerationsUsed,
          monthlyOverageUsed: shopifyInstallations.monthlyOverageUsed,
        })
        .from(shopifyInstallations)
        .where(eq(shopifyInstallations.id, installationId))
        .for("update");

      if (!inst) return { allowed: false, used: 0, overageUsed: 0, isOverage: false };

      const sameBucket = inst.generationMonth === bucketKey;
      const currentUsed = sameBucket ? inst.monthlyGenerationsUsed ?? 0 : 0;
      const currentOverage = sameBucket ? inst.monthlyOverageUsed ?? 0 : 0;

      const outcome = computeGenerationConsume(currentUsed, freeQuota, overageCap);
      if (!outcome.allowed) {
        return { allowed: false, used: currentUsed, overageUsed: currentOverage, isOverage: false };
      }

      const newUsed = currentUsed + 1;
      const newOverage = currentOverage + (outcome.isOverage ? 1 : 0);
      await tx
        .update(shopifyInstallations)
        .set({
          generationMonth: bucketKey,
          monthlyGenerationsUsed: newUsed,
          monthlyOverageUsed: newOverage,
        })
        .where(eq(shopifyInstallations.id, installationId));

      return { allowed: true, used: newUsed, overageUsed: newOverage, isOverage: outcome.isOverage };
    });
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

  // Shared Designs
  async getSharedDesign(id: string): Promise<SharedDesign | undefined> {
    const [shared] = await db.select().from(sharedDesigns).where(eq(sharedDesigns.id, id));
    return shared;
  }

  async getSharedDesignByToken(shareToken: string): Promise<SharedDesign | undefined> {
    const [shared] = await db.select().from(sharedDesigns).where(eq(sharedDesigns.shareToken, shareToken));
    return shared;
  }

  async createSharedDesign(sharedDesign: InsertSharedDesign): Promise<SharedDesign> {
    const [newShared] = await db.insert(sharedDesigns).values(sharedDesign).returning();
    return newShared;
  }

  async incrementSharedDesignViewCount(id: string): Promise<void> {
    await db
      .update(sharedDesigns)
      .set({ viewCount: sql`${sharedDesigns.viewCount} + 1` })
      .where(eq(sharedDesigns.id, id));
  }

  // Design SKU Mappings
  async getDesignSkuMapping(shopDomain: string, sourceVariantId: string, designId: string): Promise<DesignSkuMapping | undefined> {
    const [row] = await db
      .select()
      .from(designSkuMappings)
      .where(
        and(
          eq(designSkuMappings.shopDomain, shopDomain),
          eq(designSkuMappings.sourceVariantId, sourceVariantId),
          eq(designSkuMappings.designId, designId)
        )
      );
    return row;
  }

  async createDesignSkuMapping(mapping: InsertDesignSkuMapping): Promise<DesignSkuMapping> {
    const [row] = await db.insert(designSkuMappings).values(mapping).returning();
    return row;
  }

  async getExpiredDesignSkuMappings(before: Date): Promise<DesignSkuMapping[]> {
    return db
      .select()
      .from(designSkuMappings)
      .where(lte(designSkuMappings.expiresAt, before));
  }

  async deleteDesignSkuMapping(id: number): Promise<void> {
    await db.delete(designSkuMappings).where(eq(designSkuMappings.id, id));
  }

  // Customizer Designs
  async createCustomizerDesign(design: InsertCustomizerDesign): Promise<CustomizerDesign> {
    const [row] = await db.insert(customizerDesigns).values(design).returning();
    return row;
  }

  async getCustomizerDesign(id: string): Promise<CustomizerDesign | undefined> {
    const [row] = await db.select().from(customizerDesigns).where(eq(customizerDesigns.id, id));
    return row;
  }

  async updateCustomizerDesign(id: string, updates: Partial<CustomizerDesign>): Promise<CustomizerDesign | undefined> {
    const [row] = await db
      .update(customizerDesigns)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(customizerDesigns.id, id))
      .returning();
    return row;
  }

  // Customizer Pages
  async listCustomizerPages(shop: string): Promise<CustomizerPage[]> {
    return db
      .select()
      .from(customizerPages)
      .where(eq(customizerPages.shop, shop))
      .orderBy(customizerPages.createdAt);
  }

  async getCustomizerPage(id: string): Promise<CustomizerPage | undefined> {
    const [row] = await db.select().from(customizerPages).where(eq(customizerPages.id, id));
    return row;
  }

  async getCustomizerPageForShop(id: string, shop: string): Promise<CustomizerPage | undefined> {
    const [row] = await db
      .select()
      .from(customizerPages)
      .where(and(eq(customizerPages.id, id), eq(customizerPages.shop, shop)));
    return row;
  }

  async getCustomizerPageByHandle(shop: string, handle: string): Promise<CustomizerPage | undefined> {
    const [row] = await db
      .select()
      .from(customizerPages)
      .where(and(eq(customizerPages.shop, shop), eq(customizerPages.handle, handle)));
    return row;
  }

  async createCustomizerPage(page: InsertCustomizerPage): Promise<CustomizerPage> {
    const [row] = await db.insert(customizerPages).values(page).returning();
    return row;
  }

  async updateCustomizerPage(id: string, updates: Partial<CustomizerPage>): Promise<CustomizerPage | undefined> {
    const [row] = await db
      .update(customizerPages)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(customizerPages.id, id))
      .returning();
    return row;
  }

  async deleteCustomizerPage(id: string): Promise<void> {
    await db.delete(customizerPages).where(eq(customizerPages.id, id));
  }

  async countCustomizerPages(shop: string): Promise<number> {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(customizerPages)
      .where(eq(customizerPages.shop, shop));
    return result?.count ?? 0;
  }

  async countActiveCustomizerPages(shop: string): Promise<number> {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(customizerPages)
      .where(and(eq(customizerPages.shop, shop), eq(customizerPages.status, "active")));
    return result?.count ?? 0;
  }

  // Published Products
  async getPublishedProduct(shop: string, designId: string): Promise<PublishedProduct | undefined> {
    const [row] = await db
      .select()
      .from(publishedProducts)
      .where(and(eq(publishedProducts.shop, shop), eq(publishedProducts.designId, designId)));
    return row;
  }

  async createPublishedProduct(product: InsertPublishedProduct): Promise<PublishedProduct> {
    const [row] = await db.insert(publishedProducts).values(product).returning();
    return row;
  }

  async updatePublishedProduct(id: string, updates: Partial<PublishedProduct>): Promise<PublishedProduct | undefined> {
    const [row] = await db
      .update(publishedProducts)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(publishedProducts.id, id))
      .returning();
    return row;
  }

  async countCustomerPublishedDesigns(shop: string, customerKey: string): Promise<number> {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(publishedProducts)
      .where(
        and(
          eq(publishedProducts.shop, shop),
          eq(publishedProducts.customerKey, customerKey),
          eq(publishedProducts.status, "active")
        )
      );
    return result?.count ?? 0;
  }

  async getOldestCustomerPublishedDesign(shop: string, customerKey: string): Promise<PublishedProduct | undefined> {
    const [row] = await db
      .select()
      .from(publishedProducts)
      .where(
        and(
          eq(publishedProducts.shop, shop),
          eq(publishedProducts.customerKey, customerKey),
          eq(publishedProducts.status, "active")
        )
      )
      .orderBy(publishedProducts.createdAt)
      .limit(1);
    return row;
  }

  /** Return all shadow products whose expiresAt has passed and are still active */
  async getExpiredShadowProducts(): Promise<PublishedProduct[]> {
    return db
      .select()
      .from(publishedProducts)
      .where(
        and(
          eq(publishedProducts.status, "active"),
          lte(publishedProducts.expiresAt, new Date())
        )
      );
  }

  /** Mark a shadow product as added-to-cart and extend its expiry to 7 days from now */
  async markShadowProductCartAdded(id: string): Promise<void> {
    const sevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db
      .update(publishedProducts)
      .set({ cartAddedAt: new Date(), expiresAt: sevenDays, updatedAt: new Date() })
      .where(eq(publishedProducts.id, id));
  }

  // Generation Jobs
  async createGenerationJob(job: InsertGenerationJob): Promise<GenerationJob> {
    const [row] = await db.insert(generationJobs).values(job).returning();
    return row;
  }

  async getGenerationJob(id: string): Promise<GenerationJob | undefined> {
    const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, id));
    return row;
  }

  async updateGenerationJob(id: string, updates: Partial<GenerationJob>): Promise<void> {
    await db
      .update(generationJobs)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(generationJobs.id, id));
  }

  async countSessionGenerations(shop: string, sessionId: string): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(generationJobs)
      .where(
        and(
          eq(generationJobs.shop, shop),
          eq(generationJobs.sessionId, sessionId),
        )
      );
    return row?.count ?? 0;
  }

  async mergeSessionToCustomer(shop: string, sessionId: string, customerId: string): Promise<number> {
    const result = await db
      .update(generationJobs)
      .set({ customerId, sessionId: null, updatedAt: new Date() })
      .where(
        and(
          eq(generationJobs.shop, shop),
          eq(generationJobs.sessionId, sessionId),
        )
      );
    return result.rowCount ?? 0;
  }
}

export const storage = new DatabaseStorage();
