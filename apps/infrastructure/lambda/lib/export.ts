// ============================================
// Contact export — stream the contacts matching a selection (rule tree or
// explicit ids) to a CSV, keyset-paginated so memory stays flat at any size.
// The S3 upload is injected so the streaming/CSV logic is testable without
// AWS; the worker Lambda supplies a real multipart uploader.
// ============================================

import { Pool } from 'pg';
import { buildSelectionClause, Selection } from './bulk';
import { loadFieldDefinitions } from './custom-fields';

const PAGE = 1000;

// Core exportable columns → SQL expression over `contacts c`.
const CORE_COLUMNS: Record<string, string> = {
  email: 'c.email',
  phone: 'c.phone',
  first_name: 'c.first_name',
  last_name: 'c.last_name',
  company: 'c.company',
  state: 'c.state',
  timezone: 'c.timezone',
  status: 'c.status::text',
  source: 'c.source',
  consent_source: 'c.consent_source::text',
  created_at: 'c.created_at',
  total_sent: 'c.total_sent',
  total_opened: 'c.total_opened',
  total_clicked: 'c.total_clicked',
  last_engaged_at: 'c.last_engaged_at',
};

const DEFAULT_COLUMNS = ['email', 'phone', 'first_name', 'last_name', 'company', 'status', 'created_at'];

/** Escape one CSV field per RFC 4180. */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface ResolvedColumns {
  /** Header labels in order. */
  headers: string[];
  /** SELECT expressions aliased c0..cN in order. */
  selects: string[];
}

/**
 * Resolve a requested column list (or the default) into SQL select
 * expressions: core columns by name and custom fields as `custom.<key>`.
 * Unknown columns are dropped. Always returns at least the default set.
 */
export async function resolveColumns(
  pool: Pool,
  workspaceId: string,
  requested: string[] | null | undefined,
): Promise<ResolvedColumns> {
  const customDefs = (await loadFieldDefinitions(pool, workspaceId)).filter((d) => !d.archived);
  const customKeys = new Set(customDefs.map((d) => d.key));
  const cols = (requested && requested.length > 0 ? requested : DEFAULT_COLUMNS).filter((name) => {
    if (CORE_COLUMNS[name]) return true;
    if (name.startsWith('custom.')) return customKeys.has(name.slice('custom.'.length));
    return false;
  });
  const final = cols.length > 0 ? cols : DEFAULT_COLUMNS;

  const headers = final;
  const selects = final.map((name, i) => {
    if (CORE_COLUMNS[name]) return `${CORE_COLUMNS[name]} AS c${i}`;
    const key = name.slice('custom.'.length).replace(/'/g, "''");
    return `c.custom_fields->>'${key}' AS c${i}`;
  });
  return { headers, selects };
}

export interface ExportResult {
  rowCount: number;
}

/**
 * Run an export: page through matching contacts, write a CSV, and hand each
 * chunk to `upload`. `upload('header', ...)` is called once first, then body
 * chunks; `finish()` is awaited last. Returns the row count.
 */
export async function runExport(
  pool: Pool,
  workspaceId: string,
  selection: Selection,
  columns: string[] | null | undefined,
  sink: { write: (chunk: string) => Promise<void> | void },
): Promise<ExportResult> {
  const sel = await buildSelectionClause(pool, workspaceId, selection);
  const { headers, selects } = await resolveColumns(pool, workspaceId, columns);

  await sink.write(headers.map(csvEscape).join(',') + '\r\n');

  let cursor: string | null = null;
  let rowCount = 0;
  // selection params occupy $2.. (workspace is $1); cursor is appended next.
  const baseParams = [workspaceId, ...sel.params];
  const cursorParamIdx = baseParams.length + 1;

  for (;;) {
    const params: unknown[] = cursor !== null ? [...baseParams, cursor] : baseParams;
    const cursorClause: string = cursor !== null ? `AND c.contact_id > $${cursorParamIdx}` : '';
    const res = await pool.query<Record<string, unknown> & { _id: string }>(
      `SELECT c.contact_id AS _id, ${selects.join(', ')}
         FROM contacts c
        WHERE c.workspace_id = $1 AND ${sel.text} ${cursorClause}
        ORDER BY c.contact_id
        LIMIT ${PAGE}`,
      params,
    );
    if (res.rows.length === 0) break;

    let chunk = '';
    for (const row of res.rows) {
      chunk += headers.map((_, i) => csvEscape(row[`c${i}`])).join(',') + '\r\n';
    }
    await sink.write(chunk);
    rowCount += res.rows.length;
    cursor = res.rows[res.rows.length - 1]._id;

    if (res.rows.length < PAGE) break;
  }

  return { rowCount };
}
