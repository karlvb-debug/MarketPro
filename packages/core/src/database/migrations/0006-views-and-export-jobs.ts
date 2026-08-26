// Migration 0006 — contacts module C5: server-side saved views + async export jobs.

export const id = '0006-views-and-export-jobs';

export const sql = `
-- Saved views replace the localStorage-only views: per-user, with optional
-- workspace sharing. 'definition' holds the UI state (filters, segmentId,
-- visible columns, sort) as opaque JSON the frontend round-trips.
CREATE TABLE IF NOT EXISTS views (
  view_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL,          -- Cognito sub of the owner
  name VARCHAR(255) NOT NULL,
  definition JSONB NOT NULL DEFAULT '{}',
  shared BOOLEAN NOT NULL DEFAULT FALSE,  -- visible to the whole workspace
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS views_workspace_idx ON views (workspace_id);
CREATE INDEX IF NOT EXISTS views_owner_idx ON views (workspace_id, user_id);

-- Async contact export jobs. The worker streams matching contacts to a CSV
-- in S3 and records progress here; the API hands back a presigned download
-- URL once status = 'complete'.
DO $$ BEGIN
  CREATE TYPE export_status AS ENUM ('pending', 'running', 'complete', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS export_jobs (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  requested_by VARCHAR(255) NOT NULL,
  status export_status NOT NULL DEFAULT 'pending',
  selection JSONB NOT NULL,               -- { rules } | { contactIds }
  columns JSONB,                          -- requested column list (null = default)
  row_count INTEGER,
  s3_key VARCHAR(1024),
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS export_jobs_workspace_idx ON export_jobs (workspace_id, created_at);
`;
