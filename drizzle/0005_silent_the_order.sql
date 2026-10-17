CREATE TYPE "public"."payout_status" AS ENUM('pending', 'paid', 'failed');--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"seller_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"commission_cents" integer NOT NULL,
	"suborder_count" integer NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"transfer_id" text,
	"failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"paid_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "suborders" ADD COLUMN "payout_id" uuid;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payouts_seller_idx" ON "payouts" USING btree ("seller_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_transfer_unique" ON "payouts" USING btree ("transfer_id") WHERE transfer_id IS NOT NULL;