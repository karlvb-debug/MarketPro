// Migration 0003 — contacts module C2: dynamic (rule-based) segments.

export const id = '0003-dynamic-segments';

export const sql = `
-- Segment kind: 'static' = explicit contact_segment membership (today's model),
-- 'dynamic' = membership evaluated just-in-time from a stored rule AST.
DO $$ BEGIN
  CREATE TYPE segment_kind AS ENUM ('static', 'dynamic');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE segments ADD COLUMN IF NOT EXISTS kind segment_kind NOT NULL DEFAULT 'static';
ALTER TABLE segments ADD COLUMN IF NOT EXISTS rules JSONB;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS cached_count INTEGER;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS count_refreshed_at TIMESTAMP WITH TIME ZONE;
`;
