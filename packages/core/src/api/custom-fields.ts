// ============================================
// Custom Field Definitions API
// GET    /custom-fields      — list (viewer+; includes archived)
// POST   /custom-fields      — create (admin+)
// PUT    /custom-fields/{id} — update name/required/options/sort/archive (admin+)
// DELETE /custom-fields/{id} — archive (admin+; never destructive — contact
//                              rows may carry values)
// Key and type are immutable after creation: stored values and segment rules
// depend on them.
// ============================================

import { getPool } from '../db';
import { deriveKey, isValidKey, type CustomFieldType } from '../custom-fields';
import type { RequestContext } from './context';
import {
  type ApiResult,
  badRequest,
  conflict,
  created,
  notFound,
  ok,
  requireRole,
  requireWorkspace,
} from './result';
import { bool, type JsonBody, num, str } from './input';

const TYPES: CustomFieldType[] = ['text', 'number', 'date', 'email', 'phone', 'url', 'select'];

const FIELD_COLUMNS =
  'field_id, name, key, type, required, is_unique, options, archived, sort_order, created_at';

function rowToApi(r: Record<string, unknown>) {
  return {
    fieldId: r.field_id,
    name: r.name,
    key: r.key,
    type: r.type,
    required: r.required,
    isUnique: r.is_unique,
    options: r.options ?? null,
    archived: r.archived,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
  };
}

function sanitizeOptions(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const options = raw
    .filter((o): o is string => typeof o === 'string')
    .map((o) => o.trim().substring(0, 100))
    .filter(Boolean);
  return options.length > 0 ? [...new Set(options)].slice(0, 100) : null;
}

function fieldName(body: JsonBody): string {
  return (str(body, 'name') ?? '').trim().substring(0, 255);
}

function isFieldType(v: string | undefined): v is CustomFieldType {
  return v !== undefined && (TYPES as readonly string[]).includes(v);
}

export async function listCustomFields(ctx: RequestContext): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'viewer');
  if (denied) return denied;

  const pool = await getPool();
  const result = await pool.query(
    `SELECT ${FIELD_COLUMNS}
       FROM custom_field_definitions
      WHERE workspace_id = $1
      ORDER BY sort_order, created_at`,
    [ctx.workspaceId],
  );
  return ok({ data: result.rows.map(rowToApi) });
}

export async function createCustomField(ctx: RequestContext, body: JsonBody): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  // Schema changes are admin territory
  const denied = requireRole(ctx, 'admin');
  if (denied) return denied;

  const name = fieldName(body);
  if (!name) return badRequest('Field name is required');

  const key = str(body, 'key') || deriveKey(name);
  if (!isValidKey(key)) {
    return badRequest('Key must be lowercase letters, digits, and underscores, starting with a letter');
  }

  const typeInput = str(body, 'type');
  const type: CustomFieldType = isFieldType(typeInput) ? typeInput : 'text';
  const options = type === 'select' ? sanitizeOptions(body.options) : null;
  if (type === 'select' && !options) {
    return badRequest('Select fields require at least one option');
  }

  const sortOrder = num(body, 'sortOrder', 'sort_order');

  const pool = await getPool();
  const result = await pool.query(
    `INSERT INTO custom_field_definitions
       (workspace_id, name, key, type, required, is_unique, options, sort_order)
     VALUES ($1, $2, $3, $4::custom_field_type, $5, $6, $7, $8)
     ON CONFLICT (workspace_id, key) DO NOTHING
     RETURNING ${FIELD_COLUMNS}`,
    [
      ctx.workspaceId,
      name,
      key,
      type,
      bool(body, 'required') ?? false,
      bool(body, 'isUnique', 'is_unique') ?? false,
      options ? JSON.stringify(options) : null,
      Number.isInteger(sortOrder) ? sortOrder : 0,
    ],
  );
  if (result.rows.length === 0) {
    return conflict(`A field with key '${key}' already exists`);
  }
  return created(rowToApi(result.rows[0]));
}

export async function updateCustomField(
  ctx: RequestContext,
  fieldId: string,
  body: JsonBody,
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'admin');
  if (denied) return denied;

  const pool = await getPool();
  const current = await pool.query(
    `SELECT type FROM custom_field_definitions WHERE field_id = $1 AND workspace_id = $2`,
    [fieldId, ctx.workspaceId],
  );
  if (current.rows.length === 0) return notFound('Field not found');

  const isSelect = current.rows[0].type === 'select';
  const options = isSelect && body.options !== undefined ? sanitizeOptions(body.options) : undefined;
  if (isSelect && body.options !== undefined && !options) {
    return badRequest('Select fields require at least one option');
  }

  const sortOrder = num(body, 'sortOrder', 'sort_order');

  const result = await pool.query(
    `UPDATE custom_field_definitions SET
       name = COALESCE($3, name),
       required = COALESCE($4, required),
       is_unique = COALESCE($5, is_unique),
       options = COALESCE($6, options),
       archived = COALESCE($7, archived),
       sort_order = COALESCE($8, sort_order)
     WHERE field_id = $1 AND workspace_id = $2
     RETURNING ${FIELD_COLUMNS}`,
    [
      fieldId,
      ctx.workspaceId,
      fieldName(body) || null,
      bool(body, 'required') ?? null,
      bool(body, 'isUnique', 'is_unique') ?? null,
      options !== undefined ? JSON.stringify(options) : null,
      bool(body, 'archived') ?? null,
      Number.isInteger(sortOrder) ? sortOrder : null,
    ],
  );
  return ok(rowToApi(result.rows[0]));
}

/** DELETE archives — definitions are never destroyed. */
export async function archiveCustomField(ctx: RequestContext, fieldId: string): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'admin');
  if (denied) return denied;

  const pool = await getPool();
  const result = await pool.query(
    `UPDATE custom_field_definitions SET archived = TRUE
      WHERE field_id = $1 AND workspace_id = $2
      RETURNING field_id`,
    [fieldId, ctx.workspaceId],
  );
  if (result.rows.length === 0) return notFound('Field not found');
  return ok({ archived: true, fieldId });
}
