// ============================================
// GET    /workspaces      — the caller's workspaces (auto-provisions the first)
// POST   /workspaces      — create
// PUT    /workspaces/{id} — rename (admin)
// DELETE /workspaces/{id} — delete (owner)
//
// These run in global context: the caller may have no active workspace yet,
// so they key off ctx.userId rather than ctx.workspaceId. The mutations still
// guard against IDOR by requiring the URL target to match the workspace the
// caller authenticated against.
// ============================================

import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { workspaces, usersWorkspaces } from '../schema';
import type { RequestContext } from './context';
import { type ApiResult, created, forbidden, noContent, ok, requireRole } from './result';
import { type JsonBody, str } from './input';

export async function listWorkspaces(ctx: RequestContext): Promise<ApiResult> {
  const db = await getDb();

  const rows = await db
    .select({
      workspaceId: workspaces.workspaceId,
      name: workspaces.name,
      createdAt: workspaces.createdAt,
      role: usersWorkspaces.role,
    })
    .from(usersWorkspaces)
    .innerJoin(workspaces, eq(usersWorkspaces.workspaceId, workspaces.workspaceId))
    .where(eq(usersWorkspaces.userId, ctx.userId));

  // If user has no workspaces, auto-provision one
  if (rows.length === 0) {
    const [newWs] = await db.insert(workspaces).values({ name: 'My Workspace' }).returning();
    await db.insert(usersWorkspaces).values({
      userId: ctx.userId,
      workspaceId: newWs!.workspaceId,
      role: 'owner',
    });
    return ok({ data: [{ ...newWs, role: 'owner' }] });
  }

  return ok({ data: rows });
}

export async function createWorkspace(ctx: RequestContext, body: JsonBody): Promise<ApiResult> {
  const db = await getDb();
  const [newWs] = await db
    .insert(workspaces)
    .values({ name: str(body, 'name') || 'New Workspace' })
    .returning();
  await db.insert(usersWorkspaces).values({
    userId: ctx.userId,
    workspaceId: newWs!.workspaceId,
    role: 'owner',
  });
  return created({ workspaceId: newWs!.workspaceId, name: newWs!.name });
}

export async function renameWorkspace(
  ctx: RequestContext,
  targetId: string,
  body: JsonBody,
): Promise<ApiResult> {
  // IDOR guard: the URL target must match the authenticated workspace
  if (targetId !== ctx.workspaceId) {
    return forbidden('Forbidden: workspace mismatch');
  }
  const denied = requireRole(ctx, 'admin');
  if (denied) return denied;

  const db = await getDb();
  await db.update(workspaces).set({ name: str(body, 'name') }).where(eq(workspaces.workspaceId, targetId));
  return ok({ message: 'Updated' });
}

export async function deleteWorkspace(ctx: RequestContext, targetId: string): Promise<ApiResult> {
  // IDOR guard: the URL target must match the authenticated workspace
  if (targetId !== ctx.workspaceId) {
    return forbidden('Forbidden: workspace mismatch');
  }
  const denied = requireRole(ctx, 'owner');
  if (denied) return denied;

  const db = await getDb();
  await db.delete(workspaces).where(eq(workspaces.workspaceId, targetId));
  return noContent();
}
