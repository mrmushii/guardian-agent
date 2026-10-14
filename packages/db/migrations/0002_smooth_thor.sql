ALTER TABLE "user_operations" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "user_operations" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "user_operations" ADD CONSTRAINT "user_operations_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;