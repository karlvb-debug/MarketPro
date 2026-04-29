// ============================================
// DB Migration Lambda — One-shot schema creation
// Invoke manually after deploy to create all tables
// ============================================

import { Pool } from 'pg';

const SCHEMA_SQL = `
-- ENUMS
DO $$ BEGIN
  CREATE TYPE transaction_type AS ENUM ('AUTHORIZATION', 'CAPTURE', 'REFUND', 'DEPOSIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE workspace_role AS ENUM ('owner', 'admin', 'editor', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE contact_status AS ENUM ('active', 'unsubscribed', 'bounced', 'complained');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE channel AS ENUM ('email', 'sms', 'voice');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE campaign_status AS ENUM ('draft', 'scheduled', 'sending', 'completed', 'paused', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE message_status AS ENUM ('queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'failed', 'unsubscribed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE consent_type AS ENUM ('opt_in', 'opt_out');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE suppression_reason AS ENUM ('unsubscribe', 'complaint', 'bounce', 'gdpr_delete', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE consent_source AS ENUM ('collected_by_us', 'partner_with_proof', 'existing_customers', 'purchased_list', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE custom_field_type AS ENUM ('text', 'number', 'date', 'email', 'phone', 'url', 'select');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- TABLES
CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_balances (
    workspace_id UUID PRIMARY KEY REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    available_credits NUMERIC(15, 6) DEFAULT 0.000000,
    hold_credits NUMERIC(15, 6) DEFAULT 0.000000,
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions_ledger (
    transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    type transaction_type NOT NULL,
    amount NUMERIC(15, 6) NOT NULL,
    reference_id VARCHAR(255),
    status VARCHAR(50) DEFAULT 'COMPLETED',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users_workspaces (
    user_id VARCHAR(255) NOT NULL,
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    role workspace_role NOT NULL DEFAULT 'viewer',
    invited_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT users_workspaces_pk UNIQUE (user_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS contacts (
    contact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    email VARCHAR(320),
    phone VARCHAR(20),
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    company VARCHAR(255),
    timezone VARCHAR(50),
    status contact_status NOT NULL DEFAULT 'active',
    source VARCHAR(50),
    consent_source consent_source,
    custom_fields JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS contacts_unique_email ON contacts (workspace_id, email);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_unique_phone ON contacts (workspace_id, phone);
CREATE INDEX IF NOT EXISTS contacts_workspace_idx ON contacts (workspace_id);
CREATE INDEX IF NOT EXISTS contacts_status_idx ON contacts (workspace_id, status);

CREATE TABLE IF NOT EXISTS segments (
    segment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    folder_id UUID,
    sort_order INTEGER DEFAULT 0,
    color VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS segments_workspace_idx ON segments (workspace_id);

CREATE TABLE IF NOT EXISTS contact_segment (
    contact_id UUID NOT NULL REFERENCES contacts(contact_id) ON DELETE CASCADE,
    segment_id UUID NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT contact_segment_pk UNIQUE (contact_id, segment_id)
);

CREATE INDEX IF NOT EXISTS contact_segment_segment_idx ON contact_segment (segment_id);

CREATE TABLE IF NOT EXISTS email_templates (
    template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    subject_line VARCHAR(998),
    from_name VARCHAR(255),
    reply_to VARCHAR(320),
    html_content TEXT,
    editor_json JSONB,
    thumbnail_url VARCHAR(2048),
    folder_id UUID,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS email_templates_workspace_idx ON email_templates (workspace_id);

CREATE TABLE IF NOT EXISTS sms_templates (
    template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    is_unicode BOOLEAN DEFAULT FALSE,
    estimated_segments INTEGER DEFAULT 1,
    folder_id UUID,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS sms_templates_workspace_idx ON sms_templates (workspace_id);

CREATE TABLE IF NOT EXISTS call_scripts (
    script_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    ssml_content TEXT,
    voicemail_ssml TEXT,
    voice_id VARCHAR(50) DEFAULT 'Joanna',
    connect_flow_json JSONB,
    folder_id UUID,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS call_scripts_workspace_idx ON call_scripts (workspace_id);

CREATE TABLE IF NOT EXISTS campaigns (
    campaign_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    channel channel NOT NULL,
    template_id UUID NOT NULL,
    segment_id UUID NOT NULL REFERENCES segments(segment_id),
    status campaign_status NOT NULL DEFAULT 'draft',
    scheduled_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    total_recipients INTEGER,
    estimated_cost NUMERIC(15, 6),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS campaigns_workspace_idx ON campaigns (workspace_id);
CREATE INDEX IF NOT EXISTS campaigns_status_idx ON campaigns (workspace_id, status);

CREATE TABLE IF NOT EXISTS campaign_messages (
    message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(campaign_id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(contact_id) ON DELETE SET NULL,
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
    channel channel NOT NULL,
    status message_status NOT NULL DEFAULT 'queued',
    from_identity VARCHAR(320),
    sent_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    opened_at TIMESTAMP WITH TIME ZONE,
    clicked_at TIMESTAMP WITH TIME ZONE,
    provider_message_id VARCHAR(255),
    error_code VARCHAR(100),
    cost NUMERIC(15, 6)
);

CREATE INDEX IF NOT EXISTS campaign_messages_campaign_idx ON campaign_messages (campaign_id);
CREATE INDEX IF NOT EXISTS campaign_messages_workspace_idx ON campaign_messages (workspace_id);

CREATE TABLE IF NOT EXISTS sms_inbox (
    message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(contact_id),
    from_number VARCHAR(20) NOT NULL,
    to_number VARCHAR(20) NOT NULL,
    body TEXT,
    is_keyword BOOLEAN DEFAULT FALSE,
    keyword_type VARCHAR(20),
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    read_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS sms_inbox_workspace_idx ON sms_inbox (workspace_id);

CREATE TABLE IF NOT EXISTS consent_ledger (
    consent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id UUID REFERENCES contacts(contact_id) ON DELETE SET NULL,
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
    channel channel NOT NULL,
    consent_type consent_type NOT NULL,
    source VARCHAR(100),
    disclosure_text TEXT,
    ip_address VARCHAR(45),
    evidence_url VARCHAR(2048),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS consent_ledger_workspace_idx ON consent_ledger (workspace_id);

CREATE TABLE IF NOT EXISTS suppression_list (
    suppression_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    phone_hash VARCHAR(64),
    email_hash VARCHAR(64),
    reason suppression_reason NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS suppression_phone_hash_idx ON suppression_list (workspace_id, phone_hash);
CREATE INDEX IF NOT EXISTS suppression_email_hash_idx ON suppression_list (workspace_id, email_hash);

CREATE TABLE IF NOT EXISTS workspace_settings (
    workspace_id UUID PRIMARY KEY REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    sms_sender_id VARCHAR(50),
    sms_phone_number VARCHAR(20),
    voice_phone_number VARCHAR(20),
    email_from_name VARCHAR(255),
    email_from_address VARCHAR(320),
    email_reply_to VARCHAR(320),
    timezone VARCHAR(50) DEFAULT 'America/New_York',
    business_name VARCHAR(255),
    business_address TEXT,
    business_city VARCHAR(100),
    business_state VARCHAR(50),
    business_zip VARCHAR(20),
    business_country VARCHAR(10) DEFAULT 'US',
    last_dnc_scrub_date TIMESTAMP WITH TIME ZONE,
    san_number VARCHAR(50),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS segment_folders (
    folder_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS template_folders (
    folder_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS web_forms (
    form_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    fields JSONB DEFAULT '[]',
    submit_label VARCHAR(100) DEFAULT 'Submit',
    success_message TEXT DEFAULT 'Thank you!',
    design JSONB,
    folder_id UUID,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS custom_field_definitions (
    field_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    key VARCHAR(100) NOT NULL,
    type custom_field_type NOT NULL DEFAULT 'text',
    is_unique BOOLEAN DEFAULT FALSE,
    required BOOLEAN DEFAULT FALSE,
    options JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS custom_field_defs_unique_key ON custom_field_definitions (workspace_id, key);

CREATE TABLE IF NOT EXISTS email_inbox (
    message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(contact_id),
    from_address VARCHAR(320) NOT NULL,
    subject VARCHAR(998),
    body TEXT,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    read_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS email_inbox_workspace_idx ON email_inbox (workspace_id);

CREATE TABLE IF NOT EXISTS form_submissions (
    submission_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    form_id UUID NOT NULL REFERENCES web_forms(form_id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(contact_id),
    form_data JSONB NOT NULL,
    ip_address VARCHAR(45),
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    read_at TIMESTAMP WITH TIME ZONE
);

-- Stored procedure
CREATE OR REPLACE FUNCTION authorize_campaign_funds(
    p_workspace_id UUID,
    p_amount NUMERIC(15, 6),
    p_reference_id VARCHAR
) RETURNS BOOLEAN AS $$
BEGIN
    UPDATE account_balances
    SET available_credits = available_credits - p_amount,
        hold_credits = hold_credits + p_amount
    WHERE workspace_id = p_workspace_id;

    INSERT INTO transactions_ledger (workspace_id, type, amount, reference_id)
    VALUES (p_workspace_id, 'AUTHORIZATION', p_amount, p_reference_id);

    RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- ADDITIVE MIGRATIONS — safe to re-run (IF NOT EXISTS)
-- Add new columns here instead of modifying CREATE TABLE above
-- ============================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS state VARCHAR(2);
`;


export const handler = async () => {
  console.log('Starting database migration...');

  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const smClient = new SecretsManagerClient({});
  const secret = await smClient.send(
    new GetSecretValueCommand({ SecretId: process.env.DATABASE_SECRET_ARN })
  );
  const creds = JSON.parse(secret.SecretString || '{}');
  const dbHost = process.env.DATABASE_HOST || creds.host;
  const dbName = process.env.DATABASE_NAME || 'marketingsaas';

  const connectionString = `postgresql://${creds.username}:${encodeURIComponent(creds.password)}@${dbHost}:${creds.port || 5432}/${dbName}`;

  const pool = new Pool({
    connectionString,
    max: 1,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await pool.query(SCHEMA_SQL);
    console.log('Migration completed successfully — all tables created.');
    return { statusCode: 200, body: JSON.stringify({ message: 'Migration successful' }) };
  } catch (err) {
    console.error('Migration failed:', err);
    throw err;
  } finally {
    await pool.end();
  }
};
