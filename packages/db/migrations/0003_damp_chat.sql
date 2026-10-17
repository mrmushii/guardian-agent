ALTER TABLE "policy_compilations" ADD COLUMN "permission_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_compilations" ADD COLUMN "max_usdc_in_raw" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "policy_compilations" ADD COLUMN "usdc_allowance_raw" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "policy_compilations" ADD COLUMN "window_sec" integer;