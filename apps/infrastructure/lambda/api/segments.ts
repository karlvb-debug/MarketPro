// ============================================
// Segments CRUD Lambda
// GET /segments — list
// POST /segments — create
// POST /segments/{id}/contacts — add contacts to segment
// DELETE /segments/{id}/contacts — remove contacts from segment
// DELETE /segments/{id} — delete
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb, respond, getWorkspaceId, getUserId, requireRole } from '../lib/db';
import { segments, contactSegment } from '../../drizzle/schema';

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

    // POST /segments/{id}/contacts — add contacts to segment
    if (method === 'POST' && pathId && event.path?.endsWith('/contacts')) {
      const writeDenied = requireRole(event, 'editor');
      if (writeDenied) return writeDenied;

      // Verify segment belongs to this workspace
      const [seg] = await db.select().from(segments).where(
        and(eq(segments.segmentId, pathId), eq(segments.workspaceId, workspaceId))
      );
      if (!seg) return respond(404, { message: 'Segment not found' });

      const body = JSON.parse(event.body || '{}');
      const contactIds: string[] = body.contactIds;
      if (!Array.isArray(contactIds) || contactIds.length === 0) {
        return respond(400, { message: 'contactIds array required' });
      }

      // Bulk insert with ON CONFLICT DO NOTHING for idempotency
      const rows = contactIds.map(cid => ({ contactId: cid, segmentId: pathId }));
      await db.insert(contactSegment).values(rows).onConflictDoNothing();

      return respond(200, { added: contactIds.length });
    }

    // POST /segments — create
    if (method === 'POST') {
      const writeDenied = requireRole(event, 'editor');
      if (writeDenied) return writeDenied;
      const body = JSON.parse(event.body || '{}');
      const [row] = await db.insert(segments).values({
        workspaceId,
        name: body.name || 'New Segment',
        description: body.description || null,
        color: body.color || null,
      }).returning();

      return respond(201, row);
    }

    // PUT /segments/{id} — requires editor
    if (method === 'PUT' && pathId) {
      const writeDenied = requireRole(event, 'editor');
      if (writeDenied) return writeDenied;
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

    // DELETE /segments/{id}/contacts — remove contacts from segment
    if (method === 'DELETE' && pathId && event.path?.endsWith('/contacts')) {
      const writeDenied = requireRole(event, 'editor');
      if (writeDenied) return writeDenied;

      // Verify segment belongs to this workspace
      const [seg] = await db.select().from(segments).where(
        and(eq(segments.segmentId, pathId), eq(segments.workspaceId, workspaceId))
      );
      if (!seg) return respond(404, { message: 'Segment not found' });

      const body = JSON.parse(event.body || '{}');
      const contactIds: string[] = body.contactIds;
      if (!Array.isArray(contactIds) || contactIds.length === 0) {
        return respond(400, { message: 'contactIds array required' });
      }

      await db.delete(contactSegment).where(
        and(
          eq(contactSegment.segmentId, pathId),
          inArray(contactSegment.contactId, contactIds)
        )
      );

      return respond(200, { removed: contactIds.length });
    }

    // DELETE /segments/{id} — requires admin
    if (method === 'DELETE' && pathId) {
      const deleteDenied = requireRole(event, 'admin');
      if (deleteDenied) return deleteDenied;
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
