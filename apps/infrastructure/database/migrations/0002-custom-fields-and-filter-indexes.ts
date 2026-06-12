// Migration 0002 — contacts module C1: custom field lifecycle columns and
// filter-performance indexes.

export const id = '0002-custom-fields-and-filter-indexes';

export const sql = `
-- Custom field definition lifecycle (archive instead of destructive delete;
-- contact rows may still carry values for archived keys)
ALTER TABLE custom_field_definitions ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE custom_field_definitions ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- Rule-engine filter performance
CREATE INDEX IF NOT EXISTS contacts_custom_fields_gin ON contacts USING GIN (custom_fields jsonb_path_ops);
CREATE INDEX IF NOT EXISTS contacts_phone_digits_idx ON contacts (workspace_id, regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'));
CREATE INDEX IF NOT EXISTS contacts_created_at_idx ON contacts (workspace_id, created_at);
`;
