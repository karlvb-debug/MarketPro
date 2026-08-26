// ============================================
// Duplicate detection — clusters of contacts that collide on a normalized
// email or phone. Import-time dedup matches exact stored values; this catches
// pre-existing and formatting-variant duplicates (e.g. casing, punctuation)
// that slipped in before normalization or via different channels.
// ============================================

import { Pool } from 'pg';

export interface DuplicateCluster {
  keyType: 'email' | 'phone';
  key: string;
  contactIds: string[];
}

/**
 * Find duplicate clusters in a workspace, capped for safety. Each cluster is
 * 2+ contacts sharing a normalized email (lower+trim) or phone (digits only).
 * A contact may appear in both an email and a phone cluster.
 */
export async function findDuplicateClusters(
  pool: Pool,
  workspaceId: string,
  limit = 200,
): Promise<DuplicateCluster[]> {
  const capped = Math.max(1, Math.min(1000, Math.floor(limit)));

  const emailDupes = await pool.query(
    `SELECT lower(trim(email)) AS key, array_agg(contact_id ORDER BY created_at) AS ids
       FROM contacts
      WHERE workspace_id = $1 AND email IS NOT NULL AND trim(email) <> ''
      GROUP BY lower(trim(email))
     HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT $2`,
    [workspaceId, capped],
  );

  const phoneDupes = await pool.query(
    `SELECT regexp_replace(phone, '\\D', '', 'g') AS key, array_agg(contact_id ORDER BY created_at) AS ids
       FROM contacts
      WHERE workspace_id = $1 AND phone IS NOT NULL
        AND length(regexp_replace(phone, '\\D', '', 'g')) >= 10
      GROUP BY regexp_replace(phone, '\\D', '', 'g')
     HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT $2`,
    [workspaceId, capped],
  );

  return [
    ...emailDupes.rows.map((r) => ({ keyType: 'email' as const, key: r.key, contactIds: r.ids })),
    ...phoneDupes.rows.map((r) => ({ keyType: 'phone' as const, key: r.key, contactIds: r.ids })),
  ];
}
