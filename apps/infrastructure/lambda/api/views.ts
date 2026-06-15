// ============================================
// Saved Views API — replaces the localStorage-only views with per-user,
// workspace-syncable saved filter/column state.
// GET    /views          — own views + shared workspace views
// POST   /views          — create (owned by caller)
// PUT    /views/{id}     — update (owner, or admin for shared views)
// DELETE /views/{id}     — delete (owner, or admin)
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getPool, respond, getWorkspaceId, getUserId, requireRole, hasMinRole } from '../lib/db';

const MAX_DEFINITION_BYTES = 64 * 1024;

function rowToApi(r: Record<string, unknown>) {
  return {
    viewId: r.view_id,
    name: r.name,
    definition: r.definition,
    shared: r.shared,
    userId: r.user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
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

    // GET /views — own views + shared
    if (method === 'GET') {
      const result = await pool.query(
        `SELECT view_id, name, definition, shared, user_id, created_at, updated_at
           FROM views
          WHERE workspace_id = $1 AND (user_id = $2 OR shared = TRUE)
          ORDER BY name`,
        [workspaceId, userId],
      );
      return respond(200, { data: result.rows.map(rowToApi) });
    }

    // Mutations require at least editor
    const writeDenied = requireRole(event, 'editor');
    if (writeDenied) return writeDenied;

    // POST /views
    if (method === 'POST' && !pathId) {
      const body = JSON.parse(event.body || '{}');
      const name = typeof body.name === 'string' ? body.name.trim().substring(0, 255) : '';
      if (!name) return respond(400, { message: 'View name is required' });

      const definition = body.definition ?? {};
      if (JSON.stringify(definition).length > MAX_DEFINITION_BYTES) {
        return respond(400, { message: 'View definition is too large' });
      }
      const shared = Boolean(body.shared);

      const result = await pool.query(
        `INSERT INTO views (workspace_id, user_id, name, definition, shared)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING view_id, name, definition, shared, user_id, created_at, updated_at`,
        [workspaceId, userId, name, JSON.stringify(definition), shared],
      );
      return respond(201, rowToApi(result.rows[0]));
    }

    // PUT /views/{id}
    if (method === 'PUT' && pathId) {
      const existing = await pool.query(
        `SELECT user_id, shared FROM views WHERE view_id = $1 AND workspace_id = $2`,
        [pathId, workspaceId],
      );
      if (existing.rows.length === 0) return respond(404, { message: 'View not found' });
      // Owner can edit; a shared view also editable by admins.
      const isOwner = existing.rows[0].user_id === userId;
      if (!isOwner && !hasMinRole(event, 'admin')) {
        return respond(403, { message: 'Only the owner or an admin can edit this view' });
      }

      const body = JSON.parse(event.body || '{}');
      if (body.definition !== undefined && JSON.stringify(body.definition).length > MAX_DEFINITION_BYTES) {
        return respond(400, { message: 'View definition is too large' });
      }
      const result = await pool.query(
        `UPDATE views SET
           name = COALESCE($3, name),
           definition = COALESCE($4, definition),
           shared = COALESCE($5, shared),
           updated_at = NOW()
         WHERE view_id = $1 AND workspace_id = $2
         RETURNING view_id, name, definition, shared, user_id, created_at, updated_at`,
        [
          pathId,
          workspaceId,
          typeof body.name === 'string' ? body.name.trim().substring(0, 255) || null : null,
          body.definition !== undefined ? JSON.stringify(body.definition) : null,
          typeof body.shared === 'boolean' ? body.shared : null,
        ],
      );
      return respond(200, rowToApi(result.rows[0]));
    }

    // DELETE /views/{id}
    if (method === 'DELETE' && pathId) {
      const existing = await pool.query(
        `SELECT user_id FROM views WHERE view_id = $1 AND workspace_id = $2`,
        [pathId, workspaceId],
      );
      if (existing.rows.length === 0) return respond(404, { message: 'View not found' });
      if (existing.rows[0].user_id !== userId && !hasMinRole(event, 'admin')) {
        return respond(403, { message: 'Only the owner or an admin can delete this view' });
      }
      await pool.query(`DELETE FROM views WHERE view_id = $1 AND workspace_id = $2`, [pathId, workspaceId]);
      return respond(204, null);
    }

    return respond(405, { message: 'Method not allowed' });
  } catch (err) {
    console.error('Views error:', err);
    return respond(500, { message: 'Internal server error' });
  }
};
