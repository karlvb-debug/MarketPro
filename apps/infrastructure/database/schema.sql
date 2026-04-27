-- ==========================================
-- Marketing SaaS — Complete Database Schema
-- PostgreSQL
-- ==========================================
-- This file serves as documentation and can be used for direct DB setup.
-- The authoritative schema is the Drizzle ORM file at drizzle/schema.ts.
-- ==========================================


-- ==========================================
-- ENUMS
-- ==========================================

CREATE TYPE transaction_type AS ENUM ('AUTHORIZATION', 'CAPTURE', 'REFUND', 'DEPOSIT');
CREATE TYPE workspace_role AS ENUM ('owner', 'admin', 'editor', 'viewer');
CREATE TYPE contact_status AS ENUM ('active', 'unsubscribed', 'bounced', 'complained');
CREATE TYPE channel AS ENUM ('email', 'sms', 'voice');
CREATE TYPE campaign_status AS ENUM ('draft', 'scheduled', 'sending', 'completed', 'paused', 'cancelled');
CREATE TYPE message_status AS ENUM ('queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'failed', 'unsubscribed');
CREATE TYPE consent_type AS ENUM ('opt_in', 'opt_out');
CREATE TYPE suppression_reason AS ENUM ('unsubscribe', 'complaint', 'bounce', 'gdpr_delete', 'manual');


-- ==========================================
-- 1. WORKSPACES
-- ==========================================

CREATE TABLE workspaces (
    workspace_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);


-- ==========================================
-- 2. ACCOUNT BALANCES — Double-Entry Cache
-- ==========================================

CREATE TABLE account_balances (
    workspace_id UUID PRIMARY KEY REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    available_credits NUMERIC(15, 6) DEFAULT 0.000000,
    hold_credits NUMERIC(15, 6) DEFAULT 0.000000,
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT account_balances_check_positive CHECK (available_credits >= 0),
    CONSTRAINT account_balances_hold_positive CHECK (hold_credits >= 0)
);


-- ==========================================
-- 3. TRANSACTIONS LEDGER — Immutable Log
-- ==========================================

CREATE TABLE transactions_ledger (
    transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    type transaction_type NOT NULL,
    amount NUMERIC(15, 6) NOT NULL,
    reference_id VARCHAR(255),
    status VARCHAR(50) DEFAULT 'COMPLETED',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);


-- ==========================================
-- 4. USERS & WORKSPACES — RBAC
-- ==========================================

CREATE TABLE users_workspaces (
    user_id VARCHAR(255) NOT NULL,           -- Cognito sub ID
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    role workspace_role NOT NULL DEFAULT 'viewer',
    invited_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT users_workspaces_pk UNIQUE (user_id, workspace_id)
);


-- ==========================================
-- 5. CONTACTS
-- ==========================================

CREATE TABLE contacts (
    contact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    email VARCHAR(320),
    phone VARCHAR(20),                       -- E.164 format (+15551234567)
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    company VARCHAR(255),
    timezone VARCHAR(50),                    -- e.g. 'America/New_York'
    status contact_status NOT NULL DEFAULT 'active',
    source VARCHAR(50),                      -- 'csv_import', 'api', 'manual'
    custom_fields JSONB DEFAULT '{}',        -- Flexible key-value for merge tags
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Prevent duplicate contacts within a workspace
CREATE UNIQUE INDEX contacts_unique_email ON contacts (workspace_id, email);
CREATE UNIQUE INDEX contacts_unique_phone ON contacts (workspace_id, phone);
CREATE INDEX contacts_workspace_idx ON contacts (workspace_id);
CREATE INDEX contacts_status_idx ON contacts (workspace_id, status);


-- ==========================================
-- 6. SEGMENTS
-- ==========================================

CREATE TABLE segments (
    segment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX segments_workspace_idx ON segments (workspace_id);


-- ==========================================
-- 7. CONTACT ↔ SEGMENT (Many-to-Many)
-- ==========================================

CREATE TABLE contact_segment (
    contact_id UUID NOT NULL REFERENCES contacts(contact_id) ON DELETE CASCADE,
    segment_id UUID NOT NULL REFERENCES segments(segment_id) ON DELETE CASCADE,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT contact_segment_pk UNIQUE (contact_id, segment_id)
);

CREATE INDEX contact_segment_segment_idx ON contact_segment (segment_id);


-- ==========================================
-- 8. EMAIL TEMPLATES
-- ==========================================

CREATE TABLE email_templates (
    template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    subject_line VARCHAR(998),               -- RFC 2822 max subject length
    from_name VARCHAR(255),                  -- Display name (e.g. "Sarah from AcmeCo")
    reply_to VARCHAR(320),                   -- Reply-to address if different from sender
    html_content TEXT,                       -- Full rendered HTML from GrapesJS
    editor_json JSONB,                       -- GrapesJS component JSON for re-editing
    thumbnail_url VARCHAR(2048),             -- Preview image in S3/CloudFront
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX email_templates_workspace_idx ON email_templates (workspace_id);


-- ==========================================
-- 9. SMS TEMPLATES
-- ==========================================

CREATE TABLE sms_templates (
    template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    is_unicode BOOLEAN DEFAULT FALSE,        -- Affects segment billing calculation
    estimated_segments INTEGER DEFAULT 1,    -- Pre-calculated SMS segment count
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX sms_templates_workspace_idx ON sms_templates (workspace_id);


-- ==========================================
-- 10. CALL SCRIPTS
-- ==========================================

CREATE TABLE call_scripts (
    script_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    ssml_content TEXT,                       -- Amazon Polly SSML script for TTS
    voicemail_ssml TEXT,                     -- Separate script for voicemail drops (AMD)
    voice_id VARCHAR(50) DEFAULT 'Joanna',   -- Polly voice ID
    connect_flow_json JSONB,                 -- Amazon Connect Contact Flow definition
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX call_scripts_workspace_idx ON call_scripts (workspace_id);


-- ==========================================
-- 11. CAMPAIGNS
-- ==========================================

CREATE TABLE campaigns (
    campaign_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    channel channel NOT NULL,
    template_id UUID NOT NULL,               -- Points to email_templates, sms_templates, or call_scripts
    segment_id UUID NOT NULL REFERENCES segments(segment_id),
    status campaign_status NOT NULL DEFAULT 'draft',
    scheduled_at TIMESTAMP WITH TIME ZONE,   -- NULL = send immediately
    completed_at TIMESTAMP WITH TIME ZONE,
    total_recipients INTEGER,
    estimated_cost NUMERIC(15, 6),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX campaigns_workspace_idx ON campaigns (workspace_id);
CREATE INDEX campaigns_status_idx ON campaigns (workspace_id, status);
CREATE INDEX campaigns_scheduled_idx ON campaigns (scheduled_at);


-- ==========================================
-- 12. CAMPAIGN MESSAGES — Send History & Results
-- ==========================================

CREATE TABLE campaign_messages (
    message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(campaign_id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(contact_id) ON DELETE SET NULL, -- Nullable: GDPR deletion anonymizes but preserves stats
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
    channel channel NOT NULL,
    status message_status NOT NULL DEFAULT 'queued',
    from_identity VARCHAR(320),              -- Sending phone/email/queue used (compliance audit)
    sent_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    opened_at TIMESTAMP WITH TIME ZONE,
    clicked_at TIMESTAMP WITH TIME ZONE,
    provider_message_id VARCHAR(255),        -- SES/SMS/Connect reference ID
    error_code VARCHAR(100),
    cost NUMERIC(15, 6)
);

CREATE INDEX campaign_messages_campaign_idx ON campaign_messages (campaign_id);
CREATE INDEX campaign_messages_contact_idx ON campaign_messages (contact_id);
CREATE INDEX campaign_messages_workspace_idx ON campaign_messages (workspace_id);
CREATE INDEX campaign_messages_status_idx ON campaign_messages (campaign_id, status);


-- ==========================================
-- 13. SMS INBOX — Inbound Messages
-- ==========================================

CREATE TABLE sms_inbox (
    message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(contact_id),        -- NULL if unknown sender
    from_number VARCHAR(20) NOT NULL,
    to_number VARCHAR(20) NOT NULL,
    body TEXT,
    is_keyword BOOLEAN DEFAULT FALSE,
    keyword_type VARCHAR(20),                -- 'STOP', 'HELP', 'START', or NULL
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    read_at TIMESTAMP WITH TIME ZONE         -- NULL = unread
);

CREATE INDEX sms_inbox_workspace_idx ON sms_inbox (workspace_id);
CREATE INDEX sms_inbox_contact_idx ON sms_inbox (contact_id);
CREATE INDEX sms_inbox_unread_idx ON sms_inbox (workspace_id, read_at);


-- ==========================================
-- 14. CONSENT LEDGER — Immutable TCPA Compliance
-- This table is APPEND-ONLY. Rows must never be updated or deleted
-- (except via the Right to Be Forgotten process which hashes PII).
-- ==========================================

CREATE TABLE consent_ledger (
    consent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id UUID REFERENCES contacts(contact_id) ON DELETE SET NULL, -- Nullable: RTF Lambda hashes PII before contact deletion
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id),
    channel channel NOT NULL,
    consent_type consent_type NOT NULL,
    source VARCHAR(100),                     -- 'web_form', 'csv_import', 'keyword_reply', 'manual'
    disclosure_text TEXT,                    -- Exact legal text shown at time of consent
    ip_address VARCHAR(45),                  -- IPv4 or IPv6
    evidence_url VARCHAR(2048),              -- Screenshot or recording URL
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX consent_ledger_contact_idx ON consent_ledger (contact_id);
CREATE INDEX consent_ledger_workspace_idx ON consent_ledger (workspace_id);


-- ==========================================
-- 15. SUPPRESSION LIST — Hashed PII
-- Pre-send check: hash the recipient and query this table.
-- If a match exists, do NOT send.
-- ==========================================

CREATE TABLE suppression_list (
    suppression_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    phone_hash VARCHAR(64),                  -- SHA-256 hex digest
    email_hash VARCHAR(64),                  -- SHA-256 hex digest
    reason suppression_reason NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX suppression_phone_hash_idx ON suppression_list (workspace_id, phone_hash);
CREATE INDEX suppression_email_hash_idx ON suppression_list (workspace_id, email_hash);


-- ==========================================
-- STORED PROCEDURES
-- ==========================================

-- Safely process a double-entry authorization (hold funds for a campaign)
CREATE OR REPLACE FUNCTION authorize_campaign_funds(
    p_workspace_id UUID,
    p_amount NUMERIC(15, 6),
    p_reference_id VARCHAR
) RETURNS BOOLEAN AS $$
BEGIN
    -- 1. Deduct from available and add to hold
    UPDATE account_balances
    SET available_credits = available_credits - p_amount,
        hold_credits = hold_credits + p_amount
    WHERE workspace_id = p_workspace_id;

    -- 2. Insert Authorization Record
    INSERT INTO transactions_ledger (workspace_id, type, amount, reference_id)
    VALUES (p_workspace_id, 'AUTHORIZATION', p_amount, p_reference_id);

    RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE; -- Usually triggers if account_balances_check_positive fails
END;
$$ LANGUAGE plpgsql;
