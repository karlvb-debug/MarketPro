// ============================================
// Consent revocation chain — unsubscribe & SMS keyword opt-out/opt-in
// Every consent change writes BOTH the suppression list (enforcement)
// and the consent_ledger (immutable TCPA evidence chain).
// ============================================

import { Pool, PoolClient } from 'pg';
import * as crypto from 'crypto';

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export const emailHashOf = (email: string) => sha256(email.toLowerCase().trim());
export const phoneHashOf = (phone: string) => sha256(phone.replace(/\D/g, ''));

export interface UnsubscribeResult {
  ok: boolean;
  alreadyUnsubscribed?: boolean;
}

/**
 * One-click unsubscribe (RFC 8058). Token is the campaign_messages UUID —
 * unguessable, and it pins the exact workspace/contact/channel the link
 * was sent for. Idempotent: repeated clicks succeed.
 */
export async function performUnsubscribe(pool: Pool, messageToken: string): Promise<UnsubscribeResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const found = await client.query(
      `SELECT cm.message_id, cm.workspace_id, cm.contact_id, cm.channel, cm.status,
              c.email, c.phone, c.status AS contact_status
         FROM campaign_messages cm
         LEFT JOIN contacts c ON c.contact_id = cm.contact_id
        WHERE cm.message_id = $1`,
      [messageToken],
    );
    if (found.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false };
    }
    const row = found.rows[0];

    // Contact already erased (GDPR) — nothing further to revoke
    if (!row.contact_id) {
      await client.query('ROLLBACK');
      return { ok: true, alreadyUnsubscribed: true };
    }

    if (row.contact_status === 'unsubscribed') {
      await client.query('ROLLBACK');
      return { ok: true, alreadyUnsubscribed: true };
    }

    await revokeConsent(client, {
      workspaceId: row.workspace_id,
      contactId: row.contact_id,
      channel: row.channel,
      email: row.email,
      phone: row.channel === 'email' ? null : row.phone,
      source: 'one_click_unsubscribe',
    });

    await client.query(
      `UPDATE campaign_messages SET status = 'unsubscribed' WHERE message_id = $1`,
      [messageToken],
    );

    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Revoke consent for a contact on a channel: suppression hash + contact
 * status + immutable consent_ledger opt_out entry. Runs inside the
 * caller's transaction.
 */
export async function revokeConsent(
  client: PoolClient,
  opts: {
    workspaceId: string;
    contactId: string | null;
    channel: 'email' | 'sms' | 'voice';
    email: string | null;
    phone: string | null;
    source: string;
  },
): Promise<void> {
  const { workspaceId, contactId, channel, email, phone, source } = opts;

  const emailHash = email ? emailHashOf(email) : null;
  const phoneHash = phone ? phoneHashOf(phone) : null;
  if (emailHash || phoneHash) {
    await client.query(
      `INSERT INTO suppression_list (workspace_id, email_hash, phone_hash, reason)
       VALUES ($1, $2, $3, 'unsubscribe')`,
      [workspaceId, emailHash, phoneHash],
    );
  }

  if (contactId) {
    await client.query(
      `UPDATE contacts SET status = 'unsubscribed', updated_at = NOW()
        WHERE contact_id = $1 AND workspace_id = $2`,
      [contactId, workspaceId],
    );
  }

  await client.query(
    `INSERT INTO consent_ledger (contact_id, workspace_id, channel, consent_type, source)
     VALUES ($1, $2, $3, 'opt_out', $4)`,
    [contactId, workspaceId, channel, source],
  );
}

/**
 * SMS re-opt-in (START keyword): remove phone suppression, reactivate the
 * contact, and record opt_in evidence. Runs inside the caller's transaction.
 */
export async function restoreSmsConsent(
  client: PoolClient,
  opts: { workspaceId: string; contactId: string | null; phone: string; source: string },
): Promise<void> {
  const { workspaceId, contactId, phone, source } = opts;
  const phoneHash = phoneHashOf(phone);

  await client.query(
    `DELETE FROM suppression_list WHERE workspace_id = $1 AND phone_hash = $2`,
    [workspaceId, phoneHash],
  );

  if (contactId) {
    await client.query(
      `UPDATE contacts SET status = 'active', updated_at = NOW()
        WHERE contact_id = $1 AND workspace_id = $2 AND status = 'unsubscribed'`,
      [contactId, workspaceId],
    );
  }

  await client.query(
    `INSERT INTO consent_ledger (contact_id, workspace_id, channel, consent_type, source)
     VALUES ($1, $2, 'sms', 'opt_in', $3)`,
    [contactId, workspaceId, source],
  );
}
