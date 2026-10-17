CREATE TYPE "public"."order_status" AS ENUM('pending_payment', 'paid', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."suborder_status" AS ENUM('pending_payment', 'pending_shipment', 'shipped', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text,
	"recipient" text NOT NULL,
	"phone" text NOT NULL,
	"street" text NOT NULL,
	"interior" text,
	"neighborhood" text NOT NULL,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"postal_code" text NOT NULL,
	"notes" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"number" text NOT NULL,
	"buyer_id" uuid NOT NULL,
	"address_id" uuid,
	"shipping_snapshot" jsonb NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"shipping_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"platform_fee_cents" integer NOT NULL,
	"status" "order_status" DEFAULT 'pending_payment' NOT NULL,
	"payment_intent_id" text,
	"paid_at" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb,
	"processed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suborder_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"suborder_id" uuid NOT NULL,
	"variant_id" uuid,
	"product_title" text NOT NULL,
	"product_slug" text NOT NULL,
	"variant_name" text NOT NULL,
	"sku" text,
	"image_key" text,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"line_total_cents" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suborders" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"order_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"shipping_cents" integer NOT NULL,
	"commission_bps" integer NOT NULL,
	"commission_cents" integer NOT NULL,
	"payout_cents" integer NOT NULL,
	"status" "suborder_status" DEFAULT 'pending_payment' NOT NULL,
	"tracking_carrier" text,
	"tracking_number" text,
	"shipped_at" timestamp,
	"delivered_at" timestamp,
	"cancelled_at" timestamp,
	"transfer_id" text,
	"transferred_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_address_id_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suborder_items" ADD CONSTRAINT "suborder_items_suborder_id_suborders_id_fk" FOREIGN KEY ("suborder_id") REFERENCES "public"."suborders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suborder_items" ADD CONSTRAINT "suborder_items_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suborders" ADD CONSTRAINT "suborders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suborders" ADD CONSTRAINT "suborders_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addresses_user_idx" ON "addresses" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "addresses_one_default" ON "addresses" USING btree ("user_id") WHERE is_default AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "orders_buyer_idx" ON "orders" USING btree ("buyer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_number_unique" ON "orders" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_payment_intent_unique" ON "orders" USING btree ("payment_intent_id") WHERE payment_intent_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_one_pending_per_buyer" ON "orders" USING btree ("buyer_id") WHERE status = 'pending_payment';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_event_unique" ON "payment_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "suborder_items_suborder_idx" ON "suborder_items" USING btree ("suborder_id");--> statement-breakpoint
CREATE INDEX "suborders_order_idx" ON "suborders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "suborders_seller_idx" ON "suborders" USING btree ("seller_id","created_at");