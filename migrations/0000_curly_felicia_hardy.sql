CREATE TABLE "coupon_redemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"coupon_id" integer NOT NULL,
	"customer_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" varchar NOT NULL,
	"code" varchar(50) NOT NULL,
	"credit_amount" integer NOT NULL,
	"max_uses" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" varchar NOT NULL,
	"type" text NOT NULL,
	"amount" integer NOT NULL,
	"price_in_cents" integer,
	"order_id" integer,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"credits" integer DEFAULT 5 NOT NULL,
	"free_generations_used" integer DEFAULT 0 NOT NULL,
	"total_generations" integer DEFAULT 0 NOT NULL,
	"total_spent" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "customers_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "customizer_designs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop" text NOT NULL,
	"shopify_customer_id" text,
	"customer_key" text,
	"base_product_id" text,
	"base_variant_id" text NOT NULL,
	"base_title" text,
	"prompt" text NOT NULL,
	"options" json,
	"artwork_url" text,
	"mockup_url" text,
	"mockup_urls" json,
	"status" text DEFAULT 'GENERATING' NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customizer_pages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop" text NOT NULL,
	"shopify_page_id" text,
	"handle" text NOT NULL,
	"title" text NOT NULL,
	"base_product_id" text,
	"base_variant_id" text NOT NULL,
	"base_product_title" text,
	"base_variant_title" text,
	"base_product_price" text,
	"base_product_handle" text,
	"product_type_id" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_sku_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_domain" text NOT NULL,
	"source_variant_id" text NOT NULL,
	"design_id" text NOT NULL,
	"mockup_url" text NOT NULL,
	"shadow_shopify_product_id" text NOT NULL,
	"shadow_shopify_variant_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "designs" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" varchar NOT NULL,
	"merchant_id" varchar,
	"product_type_id" integer,
	"prompt" text NOT NULL,
	"style_preset" text,
	"reference_image_url" text,
	"generated_image_url" text,
	"thumbnail_image_url" text,
	"size" text NOT NULL,
	"frame_color" text DEFAULT 'black' NOT NULL,
	"aspect_ratio" text DEFAULT '3:4' NOT NULL,
	"transform_scale" integer DEFAULT 100 NOT NULL,
	"transform_x" integer DEFAULT 50 NOT NULL,
	"transform_y" integer DEFAULT 50 NOT NULL,
	"color_tier" text,
	"alternate_image_url" text,
	"design_source" text DEFAULT 'ai' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop" text NOT NULL,
	"session_id" text,
	"customer_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"prompt" text NOT NULL,
	"style_preset" text,
	"size" text,
	"frame_color" text,
	"product_type_id" text,
	"reference_image_url" text,
	"design_image_url" text,
	"thumbnail_url" text,
	"design_id" text,
	"error_message" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" varchar,
	"customer_id" varchar,
	"design_id" integer,
	"prompt_length" integer,
	"had_reference_image" boolean DEFAULT false NOT NULL,
	"style_preset" text,
	"size" text,
	"success" boolean DEFAULT true NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"store_name" text,
	"printify_api_token" text,
	"printify_shop_id" text,
	"use_built_in_nano_banana" boolean DEFAULT true NOT NULL,
	"custom_nano_banana_token" text,
	"subscription_tier" text DEFAULT 'free' NOT NULL,
	"monthly_generation_limit" integer DEFAULT 100 NOT NULL,
	"generations_this_month" integer DEFAULT 0 NOT NULL,
	"branding_settings" json,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"design_id" integer NOT NULL,
	"customer_id" varchar NOT NULL,
	"merchant_id" varchar,
	"printify_order_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"size" text NOT NULL,
	"frame_color" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"price_in_cents" integer NOT NULL,
	"shipping_in_cents" integer DEFAULT 0 NOT NULL,
	"credit_refund_in_cents" integer DEFAULT 0 NOT NULL,
	"shipping_address" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" varchar,
	"name" text NOT NULL,
	"description" text,
	"printify_blueprint_id" integer,
	"printify_provider_id" integer,
	"mockup_template_url" text,
	"sizes" text DEFAULT '[]' NOT NULL,
	"frame_colors" text DEFAULT '[]' NOT NULL,
	"variant_map" text DEFAULT '{}' NOT NULL,
	"selected_size_ids" text DEFAULT '[]' NOT NULL,
	"selected_color_ids" text DEFAULT '[]' NOT NULL,
	"aspect_ratio" text DEFAULT '3:4' NOT NULL,
	"print_shape" text DEFAULT 'rectangle' NOT NULL,
	"print_area_width" integer,
	"print_area_height" integer,
	"bleed_margin_percent" integer DEFAULT 5 NOT NULL,
	"designer_type" text DEFAULT 'generic' NOT NULL,
	"size_type" text DEFAULT 'dimensional' NOT NULL,
	"has_printify_mockups" boolean DEFAULT false NOT NULL,
	"base_mockup_images" text DEFAULT '{}' NOT NULL,
	"primary_mockup_index" integer DEFAULT 0 NOT NULL,
	"double_sided_print" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"shopify_product_id" text,
	"shopify_product_handle" text,
	"shopify_product_url" text,
	"shopify_shop_domain" text,
	"shopify_variant_ids" json,
	"last_pushed_to_shopify" timestamp,
	"printify_costs" text DEFAULT '{}',
	"is_all_over_print" boolean DEFAULT false NOT NULL,
	"placeholder_positions" text DEFAULT '[]',
	"color_option_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_products" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop" text NOT NULL,
	"design_id" text NOT NULL,
	"customer_key" text,
	"shopify_product_id" text NOT NULL,
	"shopify_variant_id" text NOT NULL,
	"shopify_product_handle" text,
	"base_variant_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_designs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"design_id" integer,
	"shop_domain" text,
	"product_id" text,
	"product_handle" text,
	"share_token" text NOT NULL,
	"image_url" text NOT NULL,
	"thumbnail_url" text,
	"prompt" text NOT NULL,
	"style_preset" text,
	"size" text NOT NULL,
	"frame_color" text NOT NULL,
	"transform_scale" integer DEFAULT 100 NOT NULL,
	"transform_x" integer DEFAULT 50 NOT NULL,
	"transform_y" integer DEFAULT 50 NOT NULL,
	"product_type_id" integer,
	"expires_at" timestamp,
	"view_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_installations" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" varchar,
	"shop_domain" text NOT NULL,
	"access_token" text NOT NULL,
	"scope" text,
	"status" text DEFAULT 'active' NOT NULL,
	"installed_at" timestamp DEFAULT now() NOT NULL,
	"uninstalled_at" timestamp,
	"customizer_hub_url" text,
	"plan_name" text,
	"plan_status" text,
	"trial_started_at" timestamp,
	"billing_subscription_id" text,
	"billing_current_period_end" timestamp,
	CONSTRAINT "shopify_installations_shop_domain_unique" UNIQUE("shop_domain")
);
--> statement-breakpoint
CREATE TABLE "style_presets" (
	"id" serial PRIMARY KEY NOT NULL,
	"merchant_id" varchar NOT NULL,
	"name" text NOT NULL,
	"prompt_prefix" text NOT NULL,
	"category" text DEFAULT 'all' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"base_image_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar,
	"first_name" varchar,
	"last_name" varchar,
	"profile_image_url" varchar,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "sessions" USING btree ("expire");