CREATE TYPE "public"."shipping_zone" AS ENUM('nacional', 'local');--> statement-breakpoint
CREATE TABLE "shipping_rates" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"seller_id" uuid NOT NULL,
	"zone" "shipping_zone" NOT NULL,
	"base_cents" integer NOT NULL,
	"per_kg_cents" integer DEFAULT 0 NOT NULL,
	"free_over_cents" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipping_rates_seller_idx" ON "shipping_rates" USING btree ("seller_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_rates_zone_unique_active" ON "shipping_rates" USING btree ("seller_id","zone") WHERE deleted_at IS NULL;