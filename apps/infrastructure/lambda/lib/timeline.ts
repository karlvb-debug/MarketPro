// ============================================
// Per-contact activity timeline — a unified, paginated view composed from
// existing tables (no new event store): campaign sends, consent-ledger
// entries, and inbound inbox messages. GDPR-safe: only rows still linked to
// the contact appear; erased contacts' rows are SET NULL and excluded.
// ============================================

import { Pool } from 'pg';
import * as crypto from 'crypto';

export type TimelineEventType = 'message' | 'consent' | 'inbound_sms' | 'inbound_email';

export interface TimelineEvent {
  type: TimelineEventType;
  at: string;
  // message
  channel?: string;
  status?: string;
  campaignName?: string;
  cost?: string | null;
  // consent
  consentType?: string;
  consentChannel?: string;
  source?: string;
  // inbound
  body?: string | null;
  fromAddress?: string | null;
}

export interface TimelinePage {
  events: TimelineEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Build a reverse-chronological timeline for one contact. Cursor is an ISO
 * timestamp; paging fetches events strictly older than it. The contact must
 * belong to the workspace (caller verifies) — every query is workspace-scoped
 * defensively regardless.
 */
export async function buildContactTimeline(
  pool: Pool,
  workspaceId: string,
  contactId: string,
  cursorIso: string | null,
  limit: number,
): Promise<TimelinePage> {
  const pageSize = Math.max(1, Math.min(100, Math.floor(limit)));
  // Pull pageSize+1 from each source older than the cursor, merge, sort, slice.
  const beforeClause = cursorIso ? 'AND {col} < $3::timestamptz' : '';
  const params: unknown[] = cursorIso ? [workspaceId, contactId, cursorIso] : [workspaceId, contactId];

  const messages = await pool.query(
    `SELECT cm.sent_at, cm.delivered_at, cm.opened_at, cm.clicked_at,
            COALESCE(cm.clicked_at, cm.opened_at, cm.delivered_at, cm.sent_at) AS at,
            cm.channel::text AS channel, cm.status::text AS status, cm.cost::text AS cost,
            cmp.name AS campaign_name
       FROM campaign_messages cm
       LEFT JOIN campaigns cmp ON cmp.campaign_id = cm.campaign_id
      WHERE cm.workspace_id = $1 AND cm.contact_id = $2
        AND COALESCE(cm.clicked_at, cm.opened_at, cm.delivered_at, cm.sent_at) IS NOT NULL
        ${beforeClause.replace('{col}', 'COALESCE(cm.clicked_at, cm.opened_at, cm.delivered_at, cm.sent_at)')}
      ORDER BY at DESC LIMIT ${pageSize + 1}`,
    params,
  );

  const consent = await pool.query(
    `SELECT created_at AS at, consent_type::text AS consent_type, channel::text AS channel, source
       FROM consent_ledger
      WHERE workspace_id = $1 AND contact_id = $2
        ${beforeClause.replace('{col}', 'created_at')}
      ORDER BY at DESC LIMIT ${pageSize + 1}`,
    params,
  );

  const sms = await pool.query(
    `SELECT received_at AS at, body, from_number AS from_address
       FROM sms_inbox
      WHERE workspace_id = $1 AND contact_id = $2
        ${beforeClause.replace('{col}', 'received_at')}
      ORDER BY at DESC LIMIT ${pageSize + 1}`,
    params,
  );

  const email = await pool.query(
    `SELECT received_at AS at, body, from_address
       FROM email_inbox
      WHERE workspace_id = $1 AND contact_id = $2
        ${beforeClause.replace('{col}', 'received_at')}
      ORDER BY at DESC LIMIT ${pageSize + 1}`,
    params,
  );

  const merged: TimelineEvent[] = [
    ...messages.rows.map((r) => ({
      type: 'message' as const,
      at: new Date(r.at).toISOString(),
      channel: r.channel,
      status: r.status,
      campaignName: r.campaign_name ?? null,
      cost: r.cost,
    })),
    ...consent.rows.map((r) => ({
      type: 'consent' as const,
      at: new Date(r.at).toISOString(),
      consentType: r.consent_type,
      consentChannel: r.channel,
      source: r.source,
    })),
    ...sms.rows.map((r) => ({
      type: 'inbound_sms' as const,
      at: new Date(r.at).toISOString(),
      body: r.body,
      fromAddress: r.from_address,
    })),
    ...email.rows.map((r) => ({
      type: 'inbound_email' as const,
      at: new Date(r.at).toISOString(),
      body: r.body,
      fromAddress: r.from_address,
    })),
  ];

  merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const hasMore = merged.length > pageSize;
  const events = hasMore ? merged.slice(0, pageSize) : merged;
  const nextCursor = hasMore ? events[events.length - 1]!.at : null;

  return { events, nextCursor, hasMore };
}

export interface ConsentState {
  email: { suppressed: boolean; reason: string | null };
  phone: { suppressed: boolean; reason: string | null };
  ledger: { consentType: string; channel: string; source: string | null; at: string }[];
}

/**
 * Real per-channel consent for a contact, derived from the suppression list
 * (enforcement) and consent_ledger (evidence) — not the frontend-only model.
 */
export async function getConsentState(
  pool: Pool,
  workspaceId: string,
  contactId: string,
): Promise<ConsentState> {
  const contact = await pool.query(
    `SELECT email, phone FROM contacts WHERE workspace_id = $1 AND contact_id = $2`,
    [workspaceId, contactId],
  );
  const row = contact.rows[0] ?? { email: null, phone: null };

  const emailHash = row.email
    ? crypto.createHash('sha256').update(String(row.email).toLowerCase().trim()).digest('hex')
    : null;
  const phoneHash = row.phone
    ? crypto.createHash('sha256').update(String(row.phone).replace(/\D/g, '')).digest('hex')
    : null;

  const sup = await pool.query(
    `SELECT email_hash, phone_hash, reason FROM suppression_list
      WHERE workspace_id = $1 AND (email_hash = $2 OR phone_hash = $3)`,
    [workspaceId, emailHash, phoneHash],
  );

  const emailSup = sup.rows.find((s) => emailHash && s.email_hash === emailHash);
  const phoneSup = sup.rows.find((s) => phoneHash && s.phone_hash === phoneHash);

  const ledger = await pool.query(
    `SELECT consent_type::text AS consent_type, channel::text AS channel, source, created_at
       FROM consent_ledger WHERE workspace_id = $1 AND contact_id = $2
      ORDER BY created_at DESC LIMIT 50`,
    [workspaceId, contactId],
  );

  return {
    email: { suppressed: Boolean(emailSup), reason: emailSup?.reason ?? null },
    phone: { suppressed: Boolean(phoneSup), reason: phoneSup?.reason ?? null },
    ledger: ledger.rows.map((r) => ({
      consentType: r.consent_type,
      channel: r.channel,
      source: r.source,
      at: new Date(r.created_at).toISOString(),
    })),
  };
}
