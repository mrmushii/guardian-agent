CREATE TABLE "paper_positions" (
	"account_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"symbol" text NOT NULL,
	"qty_raw" numeric(78, 0) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "asset" text DEFAULT 'WETH' NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_account_id_smart_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."smart_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paper_positions_key" ON "paper_positions" USING btree ("account_id","chain_id","symbol");--> statement-breakpoint
ALTER TABLE "paper_positions" ENABLE ROW LEVEL SECURITY;
