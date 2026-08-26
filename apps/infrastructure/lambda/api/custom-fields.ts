// ============================================
// Custom Field Definitions API
// GET    /custom-fields           — list (viewer+; includes archived)
// POST   /custom-fields           — create (admin+)
// PUT    /custom-fields/{id}      — update name/required/options/sort/archive (admin+)
// DELETE /custom-fields/{id}      — archive (admin+; never destructive —
//                                   contact rows may carry values)
// Key and type are immutable after creation: stored values and segment
// rules depend on them.
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getPool, respond, getWorkspaceId, getUserId, requireRole } from '../lib/db';
import { deriveKey, isValidKey, CustomFieldType } from '@repo/core/custom-fields';

const TYPES: CustomFieldType[] = ['text', 'number', 'date', 'email', 'phone', 'url', 'select'];

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

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const userId = getUserId(event);
  if (!userId) return respond(401, { message: 'Unauthorized' });

  const workspaceId = getWorkspaceId(event);
  if (!workspaceId) return respond(400, { message: 'Missing X-Workspace-Id header' });

  const pool = await getPool();
  const pathId = event.pathParameters?.id;

  try {
    const viewDenied = requireRole(event, 'viewer');
    if (viewDenied) return viewDenied;

    // GET /custom-fields
    if (method === 'GET') {
      const result = await pool.query(
        `SELECT field_id, name, key, type, required, is_unique, options, archived, sort_order, created_at
           FROM custom_field_definitions
          WHERE workspace_id = $1
          ORDER BY sort_order, created_at`,
        [workspaceId],
      );
      return respond(200, { data: result.rows.map(rowToApi) });
    }

    // Schema changes are admin territory
    const writeDenied = requireRole(event, 'admin');
    if (writeDenied) return writeDenied;

    // POST /custom-fields
    if (method === 'POST' && !pathId) {
      const body = JSON.parse(event.body || '{}');
      const name = typeof body.name === 'string' ? body.name.trim().substring(0, 255) : '';
      if (!name) return respond(400, { message: 'Field name is required' });

      const key = typeof body.key === 'string' && body.key ? body.key : deriveKey(name);
      if (!isValidKey(key)) {
        return respond(400, { message: 'Key must be lowercase letters, digits, and underscores, starting with a letter' });
      }

      const type: CustomFieldType = TYPES.includes(body.type) ? body.type : 'text';
      const options = type === 'select' ? sanitizeOptions(body.options) : null;
      if (type === 'select' && !options) {
        return respond(400, { message: 'Select fields require at least one option' });
      }

      const result = await pool.query(
        `INSERT INTO custom_field_definitions
           (workspace_id, name, key, type, required, is_unique, options, sort_order)
         VALUES ($1, $2, $3, $4::custom_field_type, $5, $6, $7, $8)
         ON CONFLICT (workspace_id, key) DO NOTHING
         RETURNING field_id, name, key, type, required, is_unique, options, archived, sort_order, created_at`,
        [
          workspaceId,
          name,
          key,
          type,
          Boolean(body.required),
          Boolean(body.isUnique ?? body.is_unique),
          options ? JSON.stringify(options) : null,
          Number.isInteger(body.sortOrder) ? body.sortOrder : 0,
        ],
      );
      if (result.rows.length === 0) {
        return respond(409, { message: `A field with key '${key}' already exists` });
      }
      return respond(201, rowToApi(result.rows[0]));
    }

    // PUT /custom-fields/{id} — key and type are immutable
    if (method === 'PUT' && pathId) {
      const body = JSON.parse(event.body || '{}');

      const current = await pool.query(
        `SELECT type FROM custom_field_definitions WHERE field_id = $1 AND workspace_id = $2`,
        [pathId, workspaceId],
      );
      if (current.rows.length === 0) return respond(404, { message: 'Field not found' });

      const options =
        current.rows[0].type === 'select' && body.options !== undefined
          ? sanitizeOptions(body.options)
          : undefined;
      if (current.rows[0].type === 'select' && body.options !== undefined && !options) {
        return respond(400, { message: 'Select fields require at least one option' });
      }

      const result = await pool.query(
        `UPDATE custom_field_definitions SET
           name = COALESCE($3, name),
           required = COALESCE($4, required),
           is_unique = COALESCE($5, is_unique),
           options = COALESCE($6, options),
           archived = COALESCE($7, archived),
           sort_order = COALESCE($8, sort_order)
         WHERE field_id = $1 AND workspace_id = $2
         RETURNING field_id, name, key, type, required, is_unique, options, archived, sort_order, created_at`,
        [
          pathId,
          workspaceId,
          typeof body.name === 'string' ? body.name.trim().substring(0, 255) || null : null,
          typeof body.required === 'boolean' ? body.required : null,
          typeof body.isUnique === 'boolean' ? body.isUnique : typeof body.is_unique === 'boolean' ? body.is_unique : null,
          options !== undefined ? JSON.stringify(options) : null,
          typeof body.archived === 'boolean' ? body.archived : null,
          Number.isInteger(body.sortOrder) ? body.sortOrder : null,
        ],
      );
      return respond(200, rowToApi(result.rows[0]));
    }

    // DELETE /custom-fields/{id} — archive, never destroy
    if (method === 'DELETE' && pathId) {
      const result = await pool.query(
        `UPDATE custom_field_definitions SET archived = TRUE
          WHERE field_id = $1 AND workspace_id = $2
          RETURNING field_id`,
        [pathId, workspaceId],
      );
      if (result.rows.length === 0) return respond(404, { message: 'Field not found' });
      return respond(200, { archived: true, fieldId: pathId });
    }

    return respond(405, { message: 'Method not allowed' });
  } catch (err) {
    console.error('Custom fields error:', err);
    return respond(500, { message: 'Internal server error' });
  }
};
