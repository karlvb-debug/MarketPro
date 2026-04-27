// ============================================
// Workspaces CRUD Lambda
// GET /workspaces — list user's workspaces
// POST /workspaces — create workspace
// PUT /workspaces/{id} — rename
// DELETE /workspaces/{id} — delete
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { eq, and } from 'drizzle-orm';
import { getDb, respond, getUserId } from '../lib/db';
import { workspaces, usersWorkspaces } from '../../drizzle/schema';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const userId = getUserId(event);
  if (!userId) return respond(401, { message: 'Unauthorized' });

  const db = await getDb();
  const pathId = event.pathParameters?.id;

  try {
    // GET /workspaces — list workspaces for this user
    if (method === 'GET' && !pathId) {
      const rows = await db
        .select({
          workspaceId: workspaces.workspaceId,
          name: workspaces.name,
          createdAt: workspaces.createdAt,
          role: usersWorkspaces.role,
        })
        .from(usersWorkspaces)
        .innerJoin(workspaces, eq(usersWorkspaces.workspaceId, workspaces.workspaceId))
        .where(eq(usersWorkspaces.userId, userId));

      // If user has no workspaces, auto-provision one
      if (rows.length === 0) {
        const [newWs] = await db.insert(workspaces).values({ name: 'My Workspace' }).returning();
        await db.insert(usersWorkspaces).values({
          userId,
          workspaceId: newWs.workspaceId,
          role: 'owner',
        });
        return respond(200, { data: [{ ...newWs, role: 'owner' }] });
      }

      return respond(200, { data: rows });
    }

    // POST /workspaces — create
    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const [newWs] = await db.insert(workspaces).values({ name: body.name || 'New Workspace' }).returning();
      await db.insert(usersWorkspaces).values({
        userId,
        workspaceId: newWs.workspaceId,
        role: 'owner',
      });
      return respond(201, { workspaceId: newWs.workspaceId, name: newWs.name });
    }

    // PUT /workspaces/{id} — rename
    if (method === 'PUT' && pathId) {
      const body = JSON.parse(event.body || '{}');
      await db.update(workspaces).set({ name: body.name }).where(eq(workspaces.workspaceId, pathId));
      return respond(200, { message: 'Updated' });
    }

    // DELETE /workspaces/{id}
    if (method === 'DELETE' && pathId) {
      await db.delete(workspaces).where(eq(workspaces.workspaceId, pathId));
      return respond(204, null);
    }

    return respond(405, { message: 'Method not allowed' });
  } catch (err) {
    console.error('Workspaces error:', err);
    return respond(500, { message: 'Internal server error' });
  }
};
