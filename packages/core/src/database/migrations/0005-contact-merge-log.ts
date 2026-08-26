// Migration 0005 — contacts module C4: merge audit trail.
// Records every merge (who, when, survivor, which duplicates, and a JSONB
// snapshot of the duplicates' pre-merge state) for compliance/forensics.

export const id = '0005-contact-merge-log';

export const sql = `
-- pgcrypto: digest() lets bulk consent changes hash suppression keys
-- set-based in SQL, matching the JS sha256(lower/trim email | digits phone).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS contact_merge_log (
  merge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  survivor_id UUID,                       -- survivor contact (SET NULL not needed; informational)
  merged_ids UUID[] NOT NULL,             -- duplicate contact ids that were absorbed
  merged_by VARCHAR(255) NOT NULL,        -- Cognito sub of the actor
  snapshot JSONB NOT NULL,                -- pre-merge state of the duplicates
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS contact_merge_log_workspace_idx ON contact_merge_log (workspace_id, created_at);
`;
