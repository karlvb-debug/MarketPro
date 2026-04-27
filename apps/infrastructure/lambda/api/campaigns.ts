// ============================================
// Campaigns CRUD Lambda
// GET /campaigns — list
// POST /campaigns — create
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { eq } from 'drizzle-orm';
import { getDb, respond, getWorkspaceId, getUserId } from '../lib/db';
import { campaigns } from '../../drizzle/schema';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const userId = getUserId(event);
  if (!userId) return respond(401, { message: 'Unauthorized' });

  const workspaceId = getWorkspaceId(event);
  if (!workspaceId) return respond(400, { message: 'Missing X-Workspace-Id header' });

  const db = await getDb();
  const pathId = event.pathParameters?.id;

  try {
    // GET /campaigns
    if (method === 'GET' && !pathId) {
      const rows = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.workspaceId, workspaceId))
        .orderBy(campaigns.createdAt);

      return respond(200, { data: rows });
    }

    // POST /campaigns
    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const [row] = await db.insert(campaigns).values({
        workspaceId,
        name: body.name || 'New Campaign',
        channel: body.channel || 'email',
        templateId: body.template_id || body.templateId,
        segmentId: body.segment_id || body.segmentId,
        status: body.status || 'draft',
        scheduledAt: body.scheduled_at ? new Date(body.scheduled_at) : null,
      }).returning();

      return respond(201, row);
    }

    return respond(405, { message: 'Method not allowed' });
  } catch (err) {
    console.error('Campaigns error:', err);
    return respond(500, { message: 'Internal server error' });
  }
};
