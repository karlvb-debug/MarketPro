// ============================================
// Campaigns CRUD Lambda
// GET /campaigns — list
// POST /campaigns — create
// ============================================

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { eq } from 'drizzle-orm';
import { getDb, respond, getWorkspaceId, getUserId } from '../lib/db';
import { campaigns } from '../../drizzle/schema';

const sqs = new SQSClient({});
const EMAIL_QUEUE_URL = process.env.EMAIL_DISPATCH_QUEUE_URL;
const SMS_QUEUE_URL = process.env.SMS_DISPATCH_QUEUE_URL;
const VOICE_QUEUE_URL = process.env.VOICE_DISPATCH_QUEUE_URL;

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

      // Dispatch to SQS if email channel and it's time to send (or no schedule)
      if (row.channel === 'email' && EMAIL_QUEUE_URL && (!row.scheduledAt || row.scheduledAt <= new Date())) {
        await sqs.send(new SendMessageCommand({
          QueueUrl: EMAIL_QUEUE_URL,
          MessageBody: JSON.stringify({
            campaignId: row.campaignId,
            workspaceId: row.workspaceId,
          }),
        }));
        await db.update(campaigns).set({ status: 'sending' }).where(eq(campaigns.campaignId, row.campaignId));
        row.status = 'sending';
      } else if (row.channel === 'sms' && SMS_QUEUE_URL && (!row.scheduledAt || row.scheduledAt <= new Date())) {
        await sqs.send(new SendMessageCommand({
          QueueUrl: SMS_QUEUE_URL,
          MessageBody: JSON.stringify({
            campaignId: row.campaignId,
            workspaceId: row.workspaceId,
          }),
        }));
        await db.update(campaigns).set({ status: 'sending' }).where(eq(campaigns.campaignId, row.campaignId));
        row.status = 'sending';
      } else if (row.channel === 'voice' && VOICE_QUEUE_URL && (!row.scheduledAt || row.scheduledAt <= new Date())) {
        await sqs.send(new SendMessageCommand({
          QueueUrl: VOICE_QUEUE_URL,
          MessageBody: JSON.stringify({
            campaignId: row.campaignId,
            workspaceId: row.workspaceId,
          }),
        }));
        await db.update(campaigns).set({ status: 'sending' }).where(eq(campaigns.campaignId, row.campaignId));
        row.status = 'sending';
      }

      return respond(201, row);
    }

    return respond(405, { message: 'Method not allowed' });
  } catch (err) {
    console.error('Campaigns error:', err);
    return respond(500, { message: 'Internal server error' });
  }
};
