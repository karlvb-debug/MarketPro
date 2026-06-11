// ============================================
// Right to be Forgotten — Data Retention Matrix execution
//
// | Data                       | Action                                      |
// |----------------------------|---------------------------------------------|
// | Contact profile            | Hard deleted                                |
// | Segment memberships        | Deleted (FK CASCADE)                        |
// | Campaign message history   | Anonymized (FK SET NULL keeps aggregates)   |
// | Inbox messages             | PII redacted, rows kept (FK SET NULL)       |
// | Form submissions           | Hard deleted (form_data holds raw PII)      |
// | Suppression list           | SHA-256 hashes retained 4y (TCPA evidence)  |
// | Consent ledger             | Rows kept, contact link severed (SET NULL)  |
//
// Everything runs in one transaction: a partially-forgotten contact is
// worse than a failed request the caller can retry.
// ============================================

import { Pool } from 'pg';
import * as crypto from 'crypto';

export interface ForgetResult {
  deleted: boolean;
  suppressedEmail: boolean;
  suppressedPhone: boolean;
  redactedSmsInbox: number;
  redactedEmailInbox: number;
  deletedFormSubmissions: number;
}

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

/**
 * Execute the deletion matrix for one contact. Returns null when the
 * contact does not exist in the given workspace (tenant isolation: a
 * contactId from another workspace is indistinguishable from a missing one).
 */
export async function executeRightToBeForgotten(
  pool: Pool,
  workspaceId: string,
  contactId: string,
): Promise<ForgetResult | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const found = await client.query(
      `SELECT email, phone FROM contacts
        WHERE contact_id = $1 AND workspace_id = $2 FOR UPDATE`,
      [contactId, workspaceId],
    );
    if (found.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const { email, phone } = found.rows[0];

    // 1. Permanent suppression hashes — the only PII derivative retained
    const emailHash = email ? sha256(email.toLowerCase().trim()) : null;
    const phoneHash = phone ? sha256(phone.replace(/\D/g, '')) : null;
    if (emailHash || phoneHash) {
      await client.query(
        `INSERT INTO suppression_list (workspace_id, email_hash, phone_hash, reason)
         VALUES ($1, $2, $3, 'gdpr_delete')`,
        [workspaceId, emailHash, phoneHash],
      );
    }

    // 2. Redact inbox PII (rows survive for thread counts; identifiers and
    // message bodies are the contact's personal data and must go)
    const smsRedacted = await client.query(
      `UPDATE sms_inbox SET from_number = 'REDACTED', body = NULL
        WHERE contact_id = $1 AND workspace_id = $2`,
      [contactId, workspaceId],
    );
    const emailRedacted = await client.query(
      `UPDATE email_inbox SET from_address = 'redacted@gdpr.invalid', subject = NULL, body = NULL
        WHERE contact_id = $1 AND workspace_id = $2`,
      [contactId, workspaceId],
    );

    // 3. Form submissions hold raw PII in form_data — hard delete
    const submissionsDeleted = await client.query(
      `DELETE FROM form_submissions WHERE contact_id = $1 AND workspace_id = $2`,
      [contactId, workspaceId],
    );

    // 4. Hard-delete the profile. FKs do the rest:
    //    contact_segment CASCADE; campaign_messages / consent_ledger /
    //    sms_inbox / email_inbox SET NULL (anonymized aggregates remain).
    await client.query(
      `DELETE FROM contacts WHERE contact_id = $1 AND workspace_id = $2`,
      [contactId, workspaceId],
    );

    await client.query('COMMIT');
    return {
      deleted: true,
      suppressedEmail: Boolean(emailHash),
      suppressedPhone: Boolean(phoneHash),
      redactedSmsInbox: smsRedacted.rowCount ?? 0,
      redactedEmailInbox: emailRedacted.rowCount ?? 0,
      deletedFormSubmissions: submissionsDeleted.rowCount ?? 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
