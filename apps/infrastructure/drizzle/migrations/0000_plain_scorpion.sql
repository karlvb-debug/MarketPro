CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'scheduled', 'sending', 'completed', 'paused', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('email', 'sms', 'voice');--> statement-breakpoint
CREATE TYPE "public"."consent_type" AS ENUM('opt_in', 'opt_out');--> statement-breakpoint
CREATE TYPE "public"."contact_status" AS ENUM('active', 'unsubscribed', 'bounced', 'complained');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'failed', 'unsubscribed');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('unsubscribe', 'complaint', 'bounce', 'gdpr_delete', 'manual');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('AUTHORIZATION', 'CAPTURE', 'REFUND', 'DEPOSIT');--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('owner', 'admin', 'editor', 'viewer');--> statement-breakpoint
CREATE TABLE "account_balances" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"available_credits" numeric(15, 6) DEFAULT '0.000000',
	"hold_credits" numeric(15, 6) DEFAULT '0.000000',
	"last_updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "account_balances_check_positive" CHECK ("account_balances"."available_credits" >= 0),
	CONSTRAINT "account_balances_hold_positive" CHECK ("account_balances"."hold_credits" >= 0)
);
--> statement-breakpoint
CREATE TABLE "call_scripts" (
	"script_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"ssml_content" text,
	"voicemail_ssml" text,
	"voice_id" varchar(50) DEFAULT 'Joanna',
	"connect_flow_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "campaign_messages" (
	"message_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"contact_id" uuid,
	"workspace_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"status" "message_status" DEFAULT 'queued' NOT NULL,
	"from_identity" varchar(320),
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"provider_message_id" varchar(255),
	"error_code" varchar(100),
	"cost" numeric(15, 6)
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"campaign_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"channel" "channel" NOT NULL,
	"template_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"total_recipients" integer,
	"estimated_cost" numeric(15, 6),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "consent_ledger" (
	"consent_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid,
	"workspace_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"consent_type" "consent_type" NOT NULL,
	"source" varchar(100),
	"disclosure_text" text,
	"ip_address" varchar(45),
	"evidence_url" varchar(2048),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "contact_segment" (
	"contact_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"contact_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" varchar(320),
	"phone" varchar(20),
	"first_name" varchar(100),
	"last_name" varchar(100),
	"company" varchar(255),
	"timezone" varchar(50),
	"status" "contact_status" DEFAULT 'active' NOT NULL,
	"source" varchar(50),
	"custom_fields" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"template_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"subject_line" varchar(998),
	"from_name" varchar(255),
	"reply_to" varchar(320),
	"html_content" text,
	"editor_json" jsonb,
	"thumbnail_url" varchar(2048),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"segment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sms_inbox" (
	"message_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid,
	"from_number" varchar(20) NOT NULL,
	"to_number" varchar(20) NOT NULL,
	"body" text,
	"is_keyword" boolean DEFAULT false,
	"keyword_type" varchar(20),
	"received_at" timestamp with time zone DEFAULT now(),
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sms_templates" (
	"template_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"is_unicode" boolean DEFAULT false,
	"estimated_segments" integer DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "suppression_list" (
	"suppression_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"phone_hash" varchar(64),
	"email_hash" varchar(64),
	"reason" "suppression_reason" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "transactions_ledger" (
	"transaction_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"type" "transaction_type" NOT NULL,
	"amount" numeric(15, 6) NOT NULL,
	"reference_id" varchar(255),
	"status" varchar(50) DEFAULT 'COMPLETED',
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users_workspaces" (
	"user_id" varchar(255) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role" "workspace_role" DEFAULT 'viewer' NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"workspace_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "account_balances" ADD CONSTRAINT "account_balances_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_scripts" ADD CONSTRAINT "call_scripts_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_messages" ADD CONSTRAINT "campaign_messages_campaign_id_campaigns_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("campaign_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_messages" ADD CONSTRAINT "campaign_messages_contact_id_contacts_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("contact_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_messages" ADD CONSTRAINT "campaign_messages_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_segment_id_segments_segment_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("segment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_ledger" ADD CONSTRAINT "consent_ledger_contact_id_contacts_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("contact_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_ledger" ADD CONSTRAINT "consent_ledger_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segment" ADD CONSTRAINT "contact_segment_contact_id_contacts_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("contact_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segment" ADD CONSTRAINT "contact_segment_segment_id_segments_segment_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("segment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_inbox" ADD CONSTRAINT "sms_inbox_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_inbox" ADD CONSTRAINT "sms_inbox_contact_id_contacts_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("contact_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_templates" ADD CONSTRAINT "sms_templates_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_list_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions_ledger" ADD CONSTRAINT "transactions_ledger_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users_workspaces" ADD CONSTRAINT "users_workspaces_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_scripts_workspace_idx" ON "call_scripts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "campaign_messages_campaign_idx" ON "campaign_messages" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaign_messages_contact_idx" ON "campaign_messages" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "campaign_messages_workspace_idx" ON "campaign_messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "campaign_messages_status_idx" ON "campaign_messages" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "campaigns_workspace_idx" ON "campaigns" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "campaigns_scheduled_idx" ON "campaigns" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "consent_ledger_contact_idx" ON "consent_ledger" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "consent_ledger_workspace_idx" ON "consent_ledger" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_segment_pk" ON "contact_segment" USING btree ("contact_id","segment_id");--> statement-breakpoint
CREATE INDEX "contact_segment_segment_idx" ON "contact_segment" USING btree ("segment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_unique_email" ON "contacts" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_unique_phone" ON "contacts" USING btree ("workspace_id","phone");--> statement-breakpoint
CREATE INDEX "contacts_workspace_idx" ON "contacts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "contacts_status_idx" ON "contacts" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "email_templates_workspace_idx" ON "email_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "segments_workspace_idx" ON "segments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sms_inbox_workspace_idx" ON "sms_inbox" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sms_inbox_contact_idx" ON "sms_inbox" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "sms_inbox_unread_idx" ON "sms_inbox" USING btree ("workspace_id","read_at");--> statement-breakpoint
CREATE INDEX "sms_templates_workspace_idx" ON "sms_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "suppression_phone_hash_idx" ON "suppression_list" USING btree ("workspace_id","phone_hash");--> statement-breakpoint
CREATE INDEX "suppression_email_hash_idx" ON "suppression_list" USING btree ("workspace_id","email_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "users_workspaces_pk" ON "users_workspaces" USING btree ("user_id","workspace_id");