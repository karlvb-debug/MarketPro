// ============================================
// Saved Views API — per-user, workspace-syncable saved filter/column state.
// GET    /views      — own views + shared workspace views
// POST   /views      — create (owned by caller)
// PUT    /views/{id} — update (owner, or admin for shared views)
// DELETE /views/{id} — delete (owner, or admin)
// ============================================

import { getPool, roleMeetsMin } from '../db';
import type { RequestContext } from './context';
import {
  type ApiResult,
  badRequest,
  created,
  forbidden,
  noContent,
  notFound,
  ok,
  requireRole,
  requireWorkspace,
} from './result';
import { bool, type JsonBody, str } from './input';

const MAX_DEFINITION_BYTES = 64 * 1024;

const VIEW_COLUMNS = 'view_id, name, definition, shared, user_id, created_at, updated_at';

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

/** Trim to the column limit; empty means "not provided". */
function viewName(body: JsonBody): string {
  return (str(body, 'name') ?? '').trim().substring(0, 255);
}

function tooLarge(definition: unknown): boolean {
  return JSON.stringify(definition).length > MAX_DEFINITION_BYTES;
}

export async function listViews(ctx: RequestContext): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'viewer');
  if (denied) return denied;

  const pool = await getPool();
  const result = await pool.query(
    `SELECT ${VIEW_COLUMNS}
       FROM views
      WHERE workspace_id = $1 AND (user_id = $2 OR shared = TRUE)
      ORDER BY name`,
    [ctx.workspaceId, ctx.userId],
  );
  return ok({ data: result.rows.map(rowToApi) });
}

export async function createView(ctx: RequestContext, body: JsonBody): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'editor');
  if (denied) return denied;

  const name = viewName(body);
  if (!name) return badRequest('View name is required');

  const definition = body.definition ?? {};
  if (tooLarge(definition)) return badRequest('View definition is too large');

  const pool = await getPool();
  const result = await pool.query(
    `INSERT INTO views (workspace_id, user_id, name, definition, shared)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${VIEW_COLUMNS}`,
    [ctx.workspaceId, ctx.userId, name, JSON.stringify(definition), bool(body, 'shared') ?? false],
  );
  return created(rowToApi(result.rows[0]));
}

export async function updateView(
  ctx: RequestContext,
  viewId: string,
  body: JsonBody,
): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'editor');
  if (denied) return denied;

  const pool = await getPool();
  const existing = await pool.query(
    `SELECT user_id, shared FROM views WHERE view_id = $1 AND workspace_id = $2`,
    [viewId, ctx.workspaceId],
  );
  if (existing.rows.length === 0) return notFound('View not found');

  // Owner can edit; a shared view is also editable by admins.
  const isOwner = existing.rows[0].user_id === ctx.userId;
  if (!isOwner && !roleMeetsMin(ctx.role, 'admin')) {
    return forbidden('Only the owner or an admin can edit this view');
  }

  if (body.definition !== undefined && tooLarge(body.definition)) {
    return badRequest('View definition is too large');
  }

  const result = await pool.query(
    `UPDATE views SET
       name = COALESCE($3, name),
       definition = COALESCE($4, definition),
       shared = COALESCE($5, shared),
       updated_at = NOW()
     WHERE view_id = $1 AND workspace_id = $2
     RETURNING ${VIEW_COLUMNS}`,
    [
      viewId,
      ctx.workspaceId,
      viewName(body) || null,
      body.definition !== undefined ? JSON.stringify(body.definition) : null,
      bool(body, 'shared') ?? null,
    ],
  );
  return ok(rowToApi(result.rows[0]));
}

export async function deleteView(ctx: RequestContext, viewId: string): Promise<ApiResult> {
  const missing = requireWorkspace(ctx);
  if (missing) return missing;
  const denied = requireRole(ctx, 'editor');
  if (denied) return denied;

  const pool = await getPool();
  const existing = await pool.query(
    `SELECT user_id FROM views WHERE view_id = $1 AND workspace_id = $2`,
    [viewId, ctx.workspaceId],
  );
  if (existing.rows.length === 0) return notFound('View not found');
  if (existing.rows[0].user_id !== ctx.userId && !roleMeetsMin(ctx.role, 'admin')) {
    return forbidden('Only the owner or an admin can delete this view');
  }

  await pool.query(`DELETE FROM views WHERE view_id = $1 AND workspace_id = $2`, [viewId, ctx.workspaceId]);
  return noContent();
}
