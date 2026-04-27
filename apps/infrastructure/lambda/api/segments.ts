// ============================================
// Segments CRUD Lambda
// GET /segments — list
// POST /segments — create
// DELETE /segments/{id} — delete
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { eq, and } from 'drizzle-orm';
import { getDb, respond, getWorkspaceId, getUserId } from '../lib/db';
import { segments } from '../../drizzle/schema';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const userId = getUserId(event);
  if (!userId) return respond(401, { message: 'Unauthorized' });

  const workspaceId = getWorkspaceId(event);
  if (!workspaceId) return respond(400, { message: 'Missing X-Workspace-Id header' });

  const db = await getDb();
  const pathId = event.pathParameters?.id;

  try {
    // GET /segments
    if (method === 'GET' && !pathId) {
      const rows = await db
        .select()
        .from(segments)
        .where(eq(segments.workspaceId, workspaceId))
        .orderBy(segments.sortOrder);

      return respond(200, { data: rows });
    }

    // POST /segments
    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const [row] = await db.insert(segments).values({
        workspaceId,
        name: body.name || 'New Segment',
        description: body.description || null,
        color: body.color || null,
      }).returning();

      return respond(201, row);
    }

    // PUT /segments/{id}
    if (method === 'PUT' && pathId) {
      const body = JSON.parse(event.body || '{}');
      const updates: Record<string, any> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.color !== undefined) updates.color = body.color;
      if (body.sort_order !== undefined) updates.sortOrder = body.sort_order;

      await db.update(segments).set(updates).where(
        and(eq(segments.segmentId, pathId), eq(segments.workspaceId, workspaceId))
      );
      return respond(200, { message: 'Updated' });
    }

    // DELETE /segments/{id}
    if (method === 'DELETE' && pathId) {
      await db.delete(segments).where(
        and(eq(segments.segmentId, pathId), eq(segments.workspaceId, workspaceId))
      );
      return respond(204, null);
    }

    return respond(405, { message: 'Method not allowed' });
  } catch (err) {
    console.error('Segments error:', err);
    return respond(500, { message: 'Internal server error' });
  }
};
