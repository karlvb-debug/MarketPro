// ============================================
// Segment membership — one resolver for static and dynamic segments.
//
// Static segments: membership is explicit rows in contact_segment.
// Dynamic segments: membership is evaluated just-in-time from a stored rule
// AST (lib/rules.ts) — never synced to contact_segment.
//
// This module produces the membership predicate (a parameterized WHERE
// fragment over `contacts c`) shared by:
//   - campaign dispatch  (fetchContactsPage)
//   - campaign launch    (countEligibleRecipients)
//   - segment preview    (GET /segments/{id}/contacts, count preview)
// so every consumer agrees on exactly who is in a segment.
// ============================================

import { Pool } from 'pg';
import { compileRules, parseRules, RuleGroup, RuleValidationError } from './rules';
import { loadFieldDefinitions } from './custom-fields';

export interface SegmentRow {
  segmentId: string;
  workspaceId: string;
  kind: 'static' | 'dynamic';
  rules: RuleGroup | null;
}

export interface MembershipClause {
  /** WHERE fragment over `contacts c`, with $N placeholders > paramOffset. */
  text: string;
  params: unknown[];
}

export async function loadSegment(
  pool: Pool,
  workspaceId: string,
  segmentId: string,
): Promise<SegmentRow | null> {
  const result = await pool.query(
    `SELECT segment_id, workspace_id, kind, rules FROM segments
      WHERE segment_id = $1 AND workspace_id = $2`,
    [segmentId, workspaceId],
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  return {
    segmentId: r.segment_id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    rules: r.rules ?? null,
  };
}

/**
 * Build the membership predicate for a resolved segment.
 * Static → EXISTS over contact_segment. Dynamic → compiled rules (custom
 * field defs are loaded to resolve custom.<key> references).
 * `paramOffset` = number of $N params the caller has already bound.
 * Throws RuleValidationError if a dynamic segment's stored rules are invalid.
 */
export async function buildMembershipClause(
  pool: Pool,
  segment: SegmentRow,
  paramOffset: number,
): Promise<MembershipClause> {
  if (segment.kind === 'static') {
    return {
      text: `EXISTS (SELECT 1 FROM contact_segment cs WHERE cs.contact_id = c.contact_id AND cs.segment_id = $${paramOffset + 1})`,
      params: [segment.segmentId],
    };
  }

  // Dynamic: an empty/missing rule set matches nobody (fail closed — a
  // misconfigured dynamic segment must not blast the whole contact base).
  if (!segment.rules) {
    return { text: 'FALSE', params: [] };
  }
  const defs = (await loadFieldDefinitions(pool, segment.workspaceId)).filter((d) => !d.archived);
  const compiled = compileRules(parseRules(segment.rules), defs, paramOffset);
  return { text: compiled.text, params: compiled.params };
}

/**
 * Count the members of a segment (membership only — callers add their own
 * status/reachability filters). Returns 0 for unknown segments.
 */
export async function countSegmentMembers(
  pool: Pool,
  workspaceId: string,
  segmentId: string,
): Promise<number> {
  const segment = await loadSegment(pool, workspaceId, segmentId);
  if (!segment) return 0;
  const clause = await buildMembershipClause(pool, segment, 1);
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total FROM contacts c
      WHERE c.workspace_id = $1 AND ${clause.text}`,
    [workspaceId, ...clause.params],
  );
  return result.rows[0].total;
}

/**
 * Count contacts that a hypothetical dynamic segment would contain, from
 * raw (untrusted) rules — used by the live count preview before saving.
 * Throws RuleValidationError on invalid rules.
 */
export async function countRulePreview(
  pool: Pool,
  workspaceId: string,
  rawRules: unknown,
): Promise<number> {
  const defs = (await loadFieldDefinitions(pool, workspaceId)).filter((d) => !d.archived);
  const compiled = compileRules(parseRules(rawRules), defs, 1);
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total FROM contacts c
      WHERE c.workspace_id = $1 AND ${compiled.text}`,
    [workspaceId, ...compiled.params],
  );
  return result.rows[0].total;
}

export { RuleValidationError };
