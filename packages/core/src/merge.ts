// ============================================
// Contact merge — fold duplicate contacts into a survivor, transactionally.
//
// Precedence: the survivor's own non-empty fields win; empty survivor fields
// are filled from duplicates (in the given order). Custom fields deep-merge
// (survivor keys win). The survivor inherits the most-restrictive consent
// status across the set. All contact-linked rows (segment memberships,
// campaign messages, consent ledger, both inboxes, form submissions) are
// repointed to the survivor — respecting the campaign_messages
// (campaign_id, contact_id) uniqueness — then engagement rollups are
// recomputed from the repointed rows. Duplicates are hard-deleted and the
// whole operation is recorded in contact_merge_log.
// ============================================

import { Pool } from 'pg';
import { recomputeRollups } from './engagement';

export interface MergeResult {
  survivorId: string;
  mergedCount: number;
}

export type MergeError =
  | { ok: false; reason: 'survivor_not_found' }
  | { ok: false; reason: 'duplicates_not_found'; missing: string[] }
  | { ok: false; reason: 'survivor_in_duplicates' };

// Most-restrictive wins: any opt-out state on a duplicate sticks to survivor.
const STATUS_RANK: Record<string, number> = {
  active: 0,
  complained: 1,
  bounced: 2,
  unsubscribed: 3,
};

interface ContactRow {
  contact_id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  timezone: string | null;
  state: string | null;
  source: string | null;
  consent_source: string | null;
  status: string;
  custom_fields: Record<string, unknown> | null;
}

const FILLABLE: (keyof ContactRow)[] = [
  'email', 'phone', 'first_name', 'last_name', 'company', 'timezone', 'state', 'consent_source',
];

/**
 * Merge duplicateIds into survivorId within a workspace. Returns the result
 * or a typed error (caller maps to HTTP status). Transactional and
 * tenant-scoped: a contact outside the workspace is treated as not found.
 */
export async function mergeContacts(
  pool: Pool,
  workspaceId: string,
  survivorId: string,
  duplicateIds: string[],
  mergedBy: string,
): Promise<MergeResult | MergeError> {
  const dedupedDuplicates = [...new Set(duplicateIds)].filter((id) => id !== survivorId);
  if (duplicateIds.includes(survivorId)) {
    return { ok: false, reason: 'survivor_in_duplicates' };
  }
  if (dedupedDuplicates.length === 0) {
    return { survivorId, mergedCount: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock survivor + duplicates together, ordered, to avoid deadlocks.
    const allIds = [survivorId, ...dedupedDuplicates];
    const locked = await client.query<ContactRow>(
      `SELECT contact_id, email, phone, first_name, last_name, company, timezone, state,
              source, consent_source, status::text AS status, custom_fields
         FROM contacts
        WHERE workspace_id = $1 AND contact_id = ANY($2::uuid[])
        ORDER BY contact_id
        FOR UPDATE`,
      [workspaceId, allIds],
    );

    const survivor = locked.rows.find((r) => r.contact_id === survivorId);
    if (!survivor) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'survivor_not_found' };
    }
    const dupRows = dedupedDuplicates.map((id) => locked.rows.find((r) => r.contact_id === id));
    const missing = dedupedDuplicates.filter((id, i) => !dupRows[i]);
    if (missing.length > 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'duplicates_not_found', missing };
    }
    const duplicates = dupRows as ContactRow[];

    // 1. Field precedence — survivor wins; fill its blanks from duplicates in order.
    const merged: Record<string, string | null> = {};
    const isEmpty = (v: unknown) => v === null || v === undefined || String(v).trim() === '';
    for (const field of FILLABLE) {
      let value = survivor[field] as string | null;
      if (isEmpty(value)) {
        for (const dup of duplicates) {
          if (!isEmpty(dup[field])) { value = dup[field] as string; break; }
        }
      }
      merged[field] = value ?? null;
    }

    // Custom fields: survivor keys win over duplicates (earlier duplicates win over later).
    let mergedCustom: Record<string, unknown> = {};
    for (let i = duplicates.length - 1; i >= 0; i--) {
      mergedCustom = { ...mergedCustom, ...(duplicates[i]!.custom_fields ?? {}) };
    }
    mergedCustom = { ...mergedCustom, ...(survivor.custom_fields ?? {}) };

    // Most-restrictive consent status across the whole set.
    const mostRestrictive = [survivor, ...duplicates].reduce((worst, r) => {
      return (STATUS_RANK[r.status] ?? 0) > (STATUS_RANK[worst] ?? 0) ? r.status : worst;
    }, survivor.status);

    // 2. Repoint segment memberships (union; drop dup rows that would collide).
    await client.query(
      `INSERT INTO contact_segment (contact_id, segment_id)
       SELECT $1, segment_id FROM contact_segment WHERE contact_id = ANY($2::uuid[])
       ON CONFLICT (contact_id, segment_id) DO NOTHING`,
      [survivorId, dedupedDuplicates],
    );

    // 3. Repoint campaign_messages, honoring the (campaign_id, contact_id) unique
    // index: move only rows whose campaign the survivor isn't already in; delete
    // the colliding remainder so they don't linger as anonymized NULLs.
    await client.query(
      `UPDATE campaign_messages m SET contact_id = $1
        WHERE m.contact_id = ANY($2::uuid[])
          AND NOT EXISTS (
            SELECT 1 FROM campaign_messages s
             WHERE s.campaign_id = m.campaign_id AND s.contact_id = $1
          )`,
      [survivorId, dedupedDuplicates],
    );
    await client.query(
      `DELETE FROM campaign_messages WHERE contact_id = ANY($1::uuid[])`,
      [dedupedDuplicates],
    );

    // 4. Repoint the remaining contact-linked history to the survivor.
    for (const table of ['consent_ledger', 'sms_inbox', 'email_inbox', 'form_submissions']) {
      await client.query(
        `UPDATE ${table} SET contact_id = $1 WHERE contact_id = ANY($2::uuid[])`,
        [survivorId, dedupedDuplicates],
      );
    }

    // 5. Delete the duplicates FIRST (FK rows are already repointed) so the
    // survivor can adopt a duplicate's email/phone without tripping the
    // (workspace_id, email|phone) unique indexes.
    const snapshot = duplicates.map((d) => ({ ...d }));
    await client.query(
      `DELETE FROM contacts WHERE workspace_id = $1 AND contact_id = ANY($2::uuid[])`,
      [workspaceId, dedupedDuplicates],
    );

    // 6. Apply the merged fields to the survivor.
    await client.query(
      `UPDATE contacts SET
         email = $2, phone = $3, first_name = $4, last_name = $5, company = $6,
         timezone = $7, state = $8, consent_source = $9::consent_source,
         status = $10::contact_status, custom_fields = $11, updated_at = NOW()
       WHERE contact_id = $1`,
      [
        survivorId,
        merged.email, merged.phone, merged.first_name, merged.last_name, merged.company,
        merged.timezone, merged.state, merged.consent_source,
        mostRestrictive, JSON.stringify(mergedCustom),
      ],
    );

    // 7. Recompute survivor rollups from the now-repointed messages.
    await recomputeRollups(client, survivorId);

    // 8. Audit.
    await client.query(
      `INSERT INTO contact_merge_log (workspace_id, survivor_id, merged_ids, merged_by, snapshot)
       VALUES ($1, $2, $3::uuid[], $4, $5)`,
      [workspaceId, survivorId, dedupedDuplicates, mergedBy, JSON.stringify(snapshot)],
    );

    await client.query('COMMIT');
    return { survivorId, mergedCount: dedupedDuplicates.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
