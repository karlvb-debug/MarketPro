// Migration 0004 — contacts module C3: engagement rollups on contacts.
// Denormalized counters maintained by the dispatch + event pipeline so
// rule-based segments can filter on engagement ("opened in last 30 days")
// without scanning campaign_messages.

export const id = '0004-engagement-rollups';

export const sql = `
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS total_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS total_delivered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS total_opened INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS total_clicked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_engaged_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS contacts_last_engaged_idx ON contacts (workspace_id, last_engaged_at);

-- Backfill from existing campaign_messages so engagement segments are
-- accurate on day one. Counts distinct messages per contact per state;
-- engagement timestamps use the message timestamps.
WITH rollup AS (
  SELECT
    contact_id,
    COUNT(*) FILTER (WHERE sent_at IS NOT NULL OR status IN ('sent','delivered','opened','clicked')) AS sent,
    COUNT(*) FILTER (WHERE delivered_at IS NOT NULL OR status IN ('delivered','opened','clicked')) AS delivered,
    COUNT(*) FILTER (WHERE opened_at IS NOT NULL OR status IN ('opened','clicked')) AS opened,
    COUNT(*) FILTER (WHERE clicked_at IS NOT NULL OR status = 'clicked') AS clicked,
    MAX(sent_at) AS last_sent,
    MAX(GREATEST(opened_at, clicked_at)) AS last_engaged
  FROM campaign_messages
  WHERE contact_id IS NOT NULL
  GROUP BY contact_id
)
UPDATE contacts c SET
  total_sent = r.sent,
  total_delivered = r.delivered,
  total_opened = r.opened,
  total_clicked = r.clicked,
  last_sent_at = r.last_sent,
  last_engaged_at = r.last_engaged
FROM rollup r
WHERE c.contact_id = r.contact_id;
`;
