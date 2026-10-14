CREATE TABLE "agent_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"session_id" uuid,
	"trigger_key" text NOT NULL,
	"trigger" jsonb NOT NULL,
	"trigger_block" bigint,
	"state" text NOT NULL,
	"decision" jsonb,
	"tier" text,
	"reasons" jsonb,
	"plan" jsonb,
	"requested_usd_cents" bigint,
	"reserved_usd_cents" bigint DEFAULT 0 NOT NULL,
	"budget_day" date,
	"cooldown_until" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"permission_id" text NOT NULL,
	"signer_address" text NOT NULL,
	"encrypted_key" text NOT NULL,
	"key_version" integer NOT NULL,
	"valid_after" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"authorize_user_op_hash" text,
	"revoke_user_op_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"action_id" uuid,
	"type" text NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"policy" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_compilations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"auth_price_answer" numeric(78, 0) NOT NULL,
	"auth_price_decimals" integer NOT NULL,
	"auth_price_source" text NOT NULL,
	"auth_price_timestamp" timestamp with time zone NOT NULL,
	"buffer_bps" integer NOT NULL,
	"max_amount_in_wei" numeric(78, 0) NOT NULL,
	"max_ops" integer NOT NULL,
	"allowance_wei" numeric(78, 0) NOT NULL,
	"gas_allowance_wei" numeric(78, 0) NOT NULL,
	"restrictions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_compilations_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smart_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"owner_address" text NOT NULL,
	"kernel_version" text NOT NULL,
	"entry_point" text NOT NULL,
	"monitoring_enabled" boolean DEFAULT true NOT NULL,
	"paused_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_operation_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"transaction_hash" text NOT NULL,
	"block_number" bigint NOT NULL,
	"bundler" text,
	"outer_success" boolean NOT NULL,
	"user_op_success" boolean NOT NULL,
	"effects" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_user_operation_id_unique" UNIQUE("user_operation_id")
);
--> statement-breakpoint
CREATE TABLE "user_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid,
	"account_id" uuid NOT NULL,
	"authority" text NOT NULL,
	"purpose" text NOT NULL,
	"nonce" numeric(78, 0),
	"user_op_hash" text,
	"state" text NOT NULL,
	"bundler_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_operations_user_op_hash_unique" UNIQUE("user_op_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE TABLE "watcher_checkpoints" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"last_block" bigint NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_account_id_smart_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."smart_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_account_id_smart_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."smart_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_account_id_smart_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."smart_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_id_agent_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."agent_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_account_id_smart_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."smart_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_compilations" ADD CONSTRAINT "policy_compilations_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_compilations" ADD CONSTRAINT "policy_compilations_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_account_id_smart_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."smart_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_accounts" ADD CONSTRAINT "smart_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_operation_id_user_operations_id_fk" FOREIGN KEY ("user_operation_id") REFERENCES "public"."user_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_operations" ADD CONSTRAINT "user_operations_action_id_agent_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."agent_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_operations" ADD CONSTRAINT "user_operations_account_id_smart_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."smart_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watcher_checkpoints" ADD CONSTRAINT "watcher_checkpoints_account_id_smart_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."smart_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_actions_trigger" ON "agent_actions" USING btree ("account_id","trigger_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_actions_one_active" ON "agent_actions" USING btree ("account_id") WHERE "agent_actions"."state" in ('TRIGGERED','PLANNING','SIMULATING','PENDING_APPROVAL','REVALIDATING','MASTER_SIGNING','SUBMITTING','PENDING');--> statement-breakpoint
CREATE INDEX "agent_actions_budget" ON "agent_actions" USING btree ("account_id","budget_day");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_one_active" ON "agent_sessions" USING btree ("account_id") WHERE "agent_sessions"."status" in ('PENDING_AUTHORIZATION','ACTIVE','REAUTH_REQUIRED');--> statement-breakpoint
CREATE INDEX "audit_events_account" ON "audit_events" USING btree ("account_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_account_version" ON "policies" USING btree ("account_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_one_active" ON "policies" USING btree ("account_id") WHERE "policies"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "smart_accounts_chain_address" ON "smart_accounts" USING btree ("chain_id","address");