CREATE TABLE "custom_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"token" text NOT NULL,
	"decimals" integer NOT NULL,
	"feed" text,
	"fee_tier" integer,
	"kind" text DEFAULT 'volatile' NOT NULL,
	"status" text NOT NULL,
	"evidence" jsonb,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_assets" ADD CONSTRAINT "custom_assets_account_id_smart_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."smart_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_assets_account_token" ON "custom_assets" USING btree ("account_id","chain_id","token");--> statement-breakpoint
ALTER TABLE "custom_assets" ENABLE ROW LEVEL SECURITY;
