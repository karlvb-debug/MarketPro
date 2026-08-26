// ============================================
// Bulk contact operations — selection-aware ("everything matching this
// filter", not just checked rows). A selection is either explicit contactIds
// or a rule tree (compiled by the rule engine); both reduce to a WHERE
// fragment over `contacts c`, and every action runs set-based and
// workspace-scoped.
// ============================================

import { Pool } from 'pg';
import { compileRules, parseRules, RuleValidationError } from './rules';
import { loadFieldDefinitions, validateCustomFields } from './custom-fields';

// { all: true } is an explicit "every contact in the workspace" — opt-in so
// it can't happen by accident (e.g. an empty rule group).
export type Selection = { contactIds: string[] } | { rules: unknown } | { all: true };

export interface SelectionClause {
  text: string;
  params: unknown[];
}

/** Build a WHERE fragment over `contacts c`, scoped to workspace ($1). */
export async function buildSelectionClause(
  pool: Pool,
  workspaceId: string,
  selection: Selection,
): Promise<SelectionClause> {
  if ('all' in selection && selection.all === true) {
    return { text: 'TRUE', params: [] };
  }
  if ('contactIds' in selection) {
    const ids = Array.isArray(selection.contactIds) ? selection.contactIds : [];
    if (ids.length === 0) throw new RuleValidationError('contactIds must be a non-empty array');
    if (ids.length > 10000) throw new RuleValidationError('contactIds exceeds the 10,000 limit');
    return { text: 'c.contact_id = ANY($2::uuid[])', params: [ids] };
  }
  if ('rules' in selection) {
    const defs = (await loadFieldDefinitions(pool, workspaceId)).filter((d) => !d.archived);
    const compiled = compileRules(parseRules(selection.rules), defs, 1);
    return { text: compiled.text, params: compiled.params };
  }
  throw new RuleValidationError('selection must specify contactIds, rules, or all');
}

export type BulkAction =
  | { type: 'add_segment'; segmentId: string }
  | { type: 'remove_segment'; segmentId: string }
  | { type: 'set_custom_field'; key: string; value: unknown }
  | { type: 'unsubscribe' }
  | { type: 'delete' };

export interface BulkResult {
  affected: number;
}

/**
 * Apply a bulk action to the selected contacts. Returns the number of rows
 * affected. Throws RuleValidationError for bad input; the caller maps to 400.
 */
export async function applyBulkAction(
  pool: Pool,
  workspaceId: string,
  selection: Selection,
  action: BulkAction,
  actorId: string,
): Promise<BulkResult> {
  const sel = await buildSelectionClause(pool, workspaceId, selection);
  // selectionSql matches contacts c in this workspace.
  const where = `c.workspace_id = $1 AND ${sel.text}`;
  const params = [workspaceId, ...sel.params];

  switch (action.type) {
    case 'add_segment': {
      // Static segments only (dynamic membership is rule-derived).
      const seg = await pool.query(
        `SELECT kind FROM segments WHERE segment_id = $1 AND workspace_id = $2`,
        [action.segmentId, workspaceId],
      );
      if (seg.rows.length === 0) throw new RuleValidationError('Segment not found');
      if (seg.rows[0].kind === 'dynamic') throw new RuleValidationError('Cannot add to a dynamic segment');
      const res = await pool.query(
        `INSERT INTO contact_segment (contact_id, segment_id)
         SELECT c.contact_id, $${params.length + 1}::uuid FROM contacts c WHERE ${where}
         ON CONFLICT (contact_id, segment_id) DO NOTHING`,
        [...params, action.segmentId],
      );
      return { affected: res.rowCount ?? 0 };
    }
    case 'remove_segment': {
      const res = await pool.query(
        `DELETE FROM contact_segment cs
          WHERE cs.segment_id = $${params.length + 1}::uuid
            AND cs.contact_id IN (SELECT c.contact_id FROM contacts c WHERE ${where})`,
        [...params, action.segmentId],
      );
      return { affected: res.rowCount ?? 0 };
    }
    case 'set_custom_field': {
      const defs = await loadFieldDefinitions(pool, workspaceId);
      const def = defs.find((d) => d.key === action.key && !d.archived);
      if (!def) throw new RuleValidationError(`Unknown custom field '${action.key}'`);
      const validation = validateCustomFields(defs, { [action.key]: action.value }, { forCreate: false });
      if (validation.errors[action.key]) {
        throw new RuleValidationError(`Invalid value for '${action.key}': ${validation.errors[action.key]}`);
      }
      const coerced = validation.values[action.key];
      const res = await pool.query(
        `UPDATE contacts c
            SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || jsonb_build_object($${params.length + 1}::text, $${params.length + 2}::jsonb),
                updated_at = NOW()
          WHERE ${where}`,
        [...params, action.key, JSON.stringify(coerced ?? null)],
      );
      return { affected: res.rowCount ?? 0 };
    }
    case 'unsubscribe': {
      // Status + per-contact consent evidence + hash-based suppression, all
      // set-based. Mirrors the single-contact revoke path (consent.ts).
      const affected = await pool.query(
        `UPDATE contacts c SET status = 'unsubscribed', updated_at = NOW() WHERE ${where} RETURNING c.contact_id`,
        params,
      );
      const ids = affected.rows.map((r) => r.contact_id);
      if (ids.length > 0) {
        await pool.query(
          `INSERT INTO consent_ledger (contact_id, workspace_id, channel, consent_type, source)
           SELECT contact_id, $1, 'email', 'opt_out', $2 FROM contacts WHERE contact_id = ANY($3::uuid[])`,
          [workspaceId, `bulk_unsubscribe:${actorId}`, ids],
        );
        // Suppress email + phone hashes (sha256 hex matching the JS path).
        await pool.query(
          `INSERT INTO suppression_list (workspace_id, email_hash, reason)
           SELECT $1, encode(digest(lower(trim(email)), 'sha256'), 'hex'), 'unsubscribe'
             FROM contacts WHERE contact_id = ANY($2::uuid[]) AND email IS NOT NULL AND trim(email) <> ''
           ON CONFLICT DO NOTHING`,
          [workspaceId, ids],
        );
        await pool.query(
          `INSERT INTO suppression_list (workspace_id, phone_hash, reason)
           SELECT $1, encode(digest(regexp_replace(phone, '\\D', '', 'g'), 'sha256'), 'hex'), 'unsubscribe'
             FROM contacts WHERE contact_id = ANY($2::uuid[])
               AND phone IS NOT NULL AND length(regexp_replace(phone, '\\D', '', 'g')) >= 10
           ON CONFLICT DO NOTHING`,
          [workspaceId, ids],
        );
      }
      return { affected: ids.length };
    }
    case 'delete': {
      // Plain hard delete (FK SET NULL/CASCADE handle children). NOT GDPR
      // erasure — use /contacts/{id}/forget for the retention matrix.
      const res = await pool.query(
        `DELETE FROM contacts c WHERE ${where}`,
        params,
      );
      return { affected: res.rowCount ?? 0 };
    }
    default: {
      const exhaustive: never = action;
      throw new RuleValidationError(`Unsupported action ${JSON.stringify(exhaustive)}`);
    }
  }
}
